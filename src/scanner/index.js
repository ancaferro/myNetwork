'use strict';
const { EventEmitter } = require('events');
const { expandTargets } = require('./net-utils');
const { ping, readArpTable, resolveHostname } = require('./discovery');
const {
  DEFAULT_PORTS,
  COMMON_PORTS,
  UDP_PORTS,
  serviceName,
  probePort,
  probeUdp,
  allTcpPorts,
} = require('./ports');
const { vendorForMac } = require('./oui');

// Run an async worker over items with bounded concurrency.
async function pool(items, concurrency, worker, onTick) {
  const queue = items.slice();
  let active = 0;
  let done = 0;
  return new Promise((resolve) => {
    if (queue.length === 0) return resolve();
    const next = () => {
      while (active < concurrency && queue.length) {
        const item = queue.shift();
        active++;
        Promise.resolve(worker(item))
          .catch(() => {})
          .finally(() => {
            active--;
            done++;
            if (onTick) onTick(done);
            if (queue.length || active) next();
            else resolve();
          });
      }
    };
    next();
  });
}

// Layered scan. Emits: 'phase', 'progress' {overall,label}, 'host', 'error', 'done'.
class Scan extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  async start() {
    const {
      target,
      mode = 'full', // 'full' | 'fast' | 'custom'
      customTcp = null,
      customUdp = null,
      pingTimeout = 1000,
      portTimeout = 700,
      udpTimeout = 1200,
      hostConcurrency = 80,
      portConcurrency = 200,
    } = this.opts;

    let expanded;
    try {
      expanded = expandTargets(target);
    } catch (e) {
      return this.emit('error', e.message);
    }
    const cidrLabel = expanded.label;

    const cTcp = customTcp && customTcp.length ? customTcp : null;
    const cUdp = customUdp && customUdp.length ? customUdp : null;
    const isCustom = mode === 'custom';
    const ips = expanded.ips;
    const ipSet = new Set(ips);
    const started = Date.now();

    // Progress weights per layer (sum = 1).
    let W;
    if (isCustom) {
      const tcpW = cTcp && cUdp ? 0.6 : cTcp ? 0.8 : 0;
      const udpW = cTcp && cUdp ? 0.2 : cUdp ? 0.8 : 0;
      W = { discover: 0.2, ptcp: tcpW, pudp: udpW };
    } else if (mode === 'fast') {
      W = { discover: 0.35, common: 0.65 };
    } else {
      W = { discover: 0.1, common: 0.14, all: 0.66, udp: 0.1 };
    }

    let base = 0; // completed weight so far
    const progress = (overall, label) => this.emit('progress', { overall: Math.min(1, overall), label });

    const hostState = new Map(); // ip -> { ip, hostname, mac, vendor, rtt, ports:Map, scanning }
    const emitHost = (ip) => {
      const s = hostState.get(ip);
      if (!s) return;
      const ports = [...s.ports.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
      this.emit('host', {
        ip: s.ip,
        hostname: s.hostname,
        mac: s.mac,
        vendor: s.vendor,
        rtt: s.rtt,
        ports,
        openCount: ports.length,
        scanning: s.scanning,
      });
    };

    // ===== Layer 1: ICMP + ARP discovery =====
    this.emit('phase', { phase: 'discover', cidr: cidrLabel, total: ips.length, label: 'ICMP discovery' });
    const arp = await readArpTable().catch(() => new Map());
    const live = new Map();
    for (const [ip, mac] of arp) if (ipSet.has(ip)) live.set(ip, { rtt: null, mac });

    await pool(
      ips,
      hostConcurrency,
      async (ip) => {
        if (this.cancelled) return;
        const r = await ping(ip, pingTimeout);
        if (r.alive) {
          if (!live.has(ip)) live.set(ip, { rtt: r.rtt });
          else live.get(ip).rtt = r.rtt;
        }
      },
      (d) => progress(base + W.discover * (d / ips.length), `ICMP discovery — ${d}/${ips.length} (${live.size} up)`)
    );
    if (this.cancelled) return this.emit('done', { cancelled: true });

    const arp2 = await readArpTable().catch(() => new Map());
    const liveIps = [...live.keys()].sort(
      (a, b) => parseInt(a.split('.')[3]) - parseInt(b.split('.')[3])
    );

    // Resolve hostname + vendor, emit initial rows (ports fill in later layers).
    await pool(liveIps, 24, async (ip) => {
      if (this.cancelled) return;
      const meta = live.get(ip) || {};
      const mac = meta.mac || arp2.get(ip) || null;
      const hostname = await resolveHostname(ip);
      hostState.set(ip, {
        ip,
        hostname,
        mac,
        vendor: vendorForMac(mac),
        rtt: meta.rtt ?? null,
        ports: new Map(),
        scanning: true,
      });
      emitHost(ip);
    });
    base += W.discover;
    progress(base, `${liveIps.length} hosts up`);
    if (this.cancelled) return this.emit('done', { cancelled: true });

    // Bound total simultaneous sockets so large port sets never exhaust FDs.
    const SOCKET_CAP = 800;
    const hostWorkers = Math.max(1, Math.min(24, hostConcurrency, liveIps.length || 1));
    const effPortConc = Math.max(20, Math.min(portConcurrency, Math.floor(SOCKET_CAP / hostWorkers)));

    // ===== Generic TCP layer =====
    const runTcpLayer = async (portsList, key, label) => {
      const total = (liveIps.length * portsList.length) || 1;
      let doneProbes = 0;
      const startBase = base;
      await pool(liveIps, hostWorkers, async (ip) => {
        if (this.cancelled) return;
        const s = hostState.get(ip);
        await pool(portsList, effPortConc, async (port) => {
          if (this.cancelled) return;
          const r = await probePort(ip, port, portTimeout);
          doneProbes++;
          if (r.open) {
            s.ports.set('t' + port, { port, proto: 'tcp', service: serviceName(port, 'tcp'), banner: r.banner });
            emitHost(ip);
          }
          if (doneProbes % 400 === 0) {
            progress(startBase + W[key] * (doneProbes / total), `${label} — ${Math.round((doneProbes / total) * 100)}%`);
          }
        });
        emitHost(ip);
      });
      base = startBase + W[key];
      progress(base, `${label} — done`);
    };

    // ===== Generic UDP layer =====
    const runUdpLayer = async (portsList, key, label) => {
      const total = (liveIps.length * portsList.length) || 1;
      let doneProbes = 0;
      const startBase = base;
      await pool(liveIps, hostWorkers, async (ip) => {
        if (this.cancelled) return;
        const s = hostState.get(ip);
        await pool(portsList, effPortConc, async (port) => {
          if (this.cancelled) return;
          const r = await probeUdp(ip, port, udpTimeout);
          doneProbes++;
          if (r.state === 'open') {
            s.ports.set('u' + port, { port, proto: 'udp', service: serviceName(port, 'udp'), banner: r.banner });
            emitHost(ip);
          }
          if (doneProbes % 20 === 0) {
            progress(startBase + W[key] * (doneProbes / total), `${label} — ${Math.round((doneProbes / total) * 100)}%`);
          }
        });
      });
      base = startBase + W[key];
      progress(base, `${label} — done`);
    };

    // ===== Layered execution =====
    if (isCustom) {
      if (cTcp) {
        this.emit('phase', { phase: 'ptcp', label: 'Custom TCP', total: liveIps.length });
        await runTcpLayer(cTcp, 'ptcp', 'Custom TCP ports');
      }
      if (cUdp && !this.cancelled) {
        this.emit('phase', { phase: 'pudp', label: 'Custom UDP', total: liveIps.length });
        await runUdpLayer(cUdp, 'pudp', 'Custom UDP ports');
      }
    } else {
      // Layer 2: popular ports first (fast feedback).
      const popular = mode === 'fast' ? DEFAULT_PORTS : COMMON_PORTS;
      this.emit('phase', { phase: 'common', label: 'Popular ports', total: liveIps.length });
      await runTcpLayer(popular, 'common', 'Popular ports');

      if (mode === 'full' && !this.cancelled) {
        // Layer 3: every remaining TCP port.
        const popSet = new Set(popular);
        const rest = allTcpPorts().filter((p) => !popSet.has(p));
        this.emit('phase', { phase: 'all', label: 'All TCP ports', total: liveIps.length });
        await runTcpLayer(rest, 'all', 'All TCP ports (1–65535)');

        // Layer 4: common UDP.
        if (!this.cancelled) {
          this.emit('phase', { phase: 'udp', label: 'UDP ports', total: liveIps.length });
          await runUdpLayer(UDP_PORTS, 'udp', 'UDP ports');
        }
      }
    }

    // Mark all hosts finished.
    for (const ip of liveIps) {
      const s = hostState.get(ip);
      if (s) {
        s.scanning = false;
        emitHost(ip);
      }
    }
    progress(1, 'Done');

    const openTotal = [...hostState.values()].reduce((n, s) => n + s.ports.size, 0);
    this.emit('done', {
      cancelled: this.cancelled,
      elapsedMs: Date.now() - started,
      scanned: ips.length,
      liveCount: liveIps.length,
      openTotal,
      cidr: cidrLabel,
    });
  }
}

module.exports = { Scan };
