'use strict';
const { execFile } = require('child_process');
const dgram = require('dgram');
const os = require('os');
const dns = require('dns').promises;

const PLATFORM = os.platform(); // 'linux' | 'darwin' | 'win32'

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

// ---- ICMP ping (uses the OS `ping` binary — no root needed) -----------------
function ping(ip, timeoutMs = 1000) {
  let args;
  if (PLATFORM === 'win32') {
    args = ['-n', '1', '-w', String(timeoutMs), ip];
  } else if (PLATFORM === 'darwin') {
    args = ['-c', '1', '-t', String(Math.max(1, Math.round(timeoutMs / 1000))), ip];
  } else {
    args = ['-c', '1', '-W', String(Math.max(1, Math.round(timeoutMs / 1000))), ip];
  }
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: timeoutMs + 1500, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ alive: false, rtt: null });
      const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(stdout || '');
      resolve({ alive: true, rtt: m ? parseFloat(m[1]) : null });
    });
  });
}

// Ping with a few quick retries — a single dropped ICMP packet (common on
// Wi-Fi, power-saving devices, or ICMP rate-limiting) shouldn't read as "down".
async function pingAlive(ip, timeoutMs = 1000, attempts = 2) {
  let last = { alive: false, rtt: null };
  for (let i = 0; i < attempts; i++) {
    last = await ping(ip, timeoutMs);
    if (last.alive) return last;
  }
  return last;
}

// ---- ARP / neighbour table --------------------------------------------------
// Returns Map<ip, mac>. Reads the kernel cache — cheap and privilege-free.
async function readArpTable() {
  const map = new Map();
  let out = '';
  if (PLATFORM === 'linux') {
    out = await run('ip', ['neigh', 'show']);
    // 10.0.0.1 dev wlp2s0 lladdr aa:bb:cc:dd:ee:ff REACHABLE
    for (const line of out.split('\n')) {
      const m = /^(\d+\.\d+\.\d+\.\d+)\b.*?lladdr\s+([0-9a-f:]{17})/i.exec(line.trim());
      if (m) map.set(m[1], m[2].toLowerCase());
    }
    if (map.size === 0) out = await run('arp', ['-n']);
  }
  if (map.size === 0) {
    out = out || (await run('arp', PLATFORM === 'win32' ? ['-a'] : ['-a']));
    // Matches both "? (10.0.0.1) at aa:bb:.." and win "10.0.0.1  aa-bb-.."
    const re = /(\d+\.\d+\.\d+\.\d+)[^\da-f]+([0-9a-f]{2}[:-][0-9a-f]{2}[:-][0-9a-f]{2}[:-][0-9a-f]{2}[:-][0-9a-f]{2}[:-][0-9a-f]{2})/gi;
    let m;
    while ((m = re.exec(out))) {
      map.set(m[1], m[2].replace(/-/g, ':').toLowerCase());
    }
  }
  return map;
}

// ---- Default route interface ------------------------------------------------
// Returns { iface, gateway } for the interface carrying the default route,
// or { iface: null, gateway: null } if none can be determined.
async function defaultRoute() {
  let out = '';
  if (PLATFORM === 'win32') {
    out = await run('powershell', [
      '-NoProfile',
      '-Command',
      "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1 | ForEach-Object { $_.InterfaceAlias + ' ' + $_.NextHop })",
    ]);
    const parts = out.trim().split(/\s+/);
    if (parts.length >= 1 && parts[0]) return { iface: parts[0], gateway: parts[1] || null };
    return { iface: null, gateway: null };
  }
  if (PLATFORM === 'darwin') {
    out = await run('route', ['-n', 'get', 'default']);
    const iface = /interface:\s*(\S+)/.exec(out);
    const gw = /gateway:\s*(\S+)/.exec(out);
    return { iface: iface ? iface[1] : null, gateway: gw ? gw[1] : null };
  }
  // linux
  out = await run('ip', ['route', 'show', 'default']);
  // e.g. "default via 192.0.2.1 dev eth0 proto dhcp src 192.0.2.10 metric 600"
  const m = /default\s+via\s+(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)/.exec(out);
  if (m) return { iface: m[2], gateway: m[1] };
  const m2 = /default\b.*?\bdev\s+(\S+)/.exec(out);
  return { iface: m2 ? m2[1] : null, gateway: null };
}

// ---- Name resolution --------------------------------------------------------
// Hostnames come from three fallbacks, best-effort, in order of coverage:
//   1. reverse DNS (PTR) — only names an actual DNS server knows about;
//   2. mDNS (.local)     — Apple/printers/Linux/IoT, over UDP multicast 5353;
//   3. NetBIOS (NBSTAT)  — Windows/Samba machine names, over UDP 137.
// All use plain dgram sockets — no native modules, no root.

// Clean a resolved name: drop the trailing dot, reject empties/wildcards.
function cleanName(name) {
  if (!name) return null;
  const n = String(name).replace(/\.$/, '').trim();
  return n && n !== '*' ? n : null;
}

// --- DNS wire-format name codec (shared by the mDNS path) ---
function encodeDnsName(name) {
  const bufs = [];
  for (const label of name.split('.').filter(Boolean)) {
    const b = Buffer.from(label, 'utf8');
    bufs.push(Buffer.from([b.length]), b);
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

// Decode a (possibly compressed) name; returns { name, next } where `next` is
// the offset just past the name in the record stream (not inside a pointer).
function decodeDnsName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = offset;
  let jumped = false;
  for (let guard = 0; guard < 128; guard++) {
    if (pos >= buf.length) break;
    const len = buf[pos];
    if (len === 0) {
      pos++;
      if (!jumped) next = pos;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) break;
      if (!jumped) next = pos + 2;
      jumped = true;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    pos++;
    if (pos + len > buf.length) break;
    labels.push(buf.toString('utf8', pos, pos + len));
    pos += len;
  }
  return { name: labels.join('.'), next };
}

// Fire one UDP query and resolve with the first parseable answer (or null).
function udpQuery({ host, port, packet, timeout, parse, multicast }) {
  return new Promise((resolve) => {
    let done = false;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeout);
    sock.on('error', () => finish(null));
    sock.on('message', (msg) => {
      let r = null;
      try { r = parse(msg); } catch { r = null; }
      if (r) finish(r); // else keep listening for a better responder until timeout
    });
    sock.bind(0, () => {
      try {
        if (multicast) sock.setMulticastTTL(1);
        sock.send(packet, port, host, (err) => { if (err) finish(null); });
      } catch {
        finish(null);
      }
    });
  });
}

// --- mDNS reverse lookup (PTR for <reversed-ip>.in-addr.arpa) ---
function buildMdnsQuery(ip) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // QDCOUNT = 1
  const qname = encodeDnsName(ip.split('.').reverse().join('.') + '.in-addr.arpa');
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0);     // QTYPE  = PTR
  tail.writeUInt16BE(0x8001, 2); // QCLASS = IN, with the unicast-response (QU) bit
  return Buffer.concat([header, qname, tail]);
}

function parseMdnsPtr(buf) {
  if (buf.length < 12) return null;
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  if (an === 0) return null;
  let off = 12;
  for (let i = 0; i < qd; i++) off = decodeDnsName(buf, off).next + 4; // skip questions
  for (let i = 0; i < an; i++) {
    const p = decodeDnsName(buf, off).next;
    if (p + 10 > buf.length) return null;
    const type = buf.readUInt16BE(p);
    const rdlen = buf.readUInt16BE(p + 8);
    const rdStart = p + 10;
    if (rdStart + rdlen > buf.length) return null;
    if (type === 12) return cleanName(decodeDnsName(buf, rdStart).name); // PTR
    off = rdStart + rdlen;
  }
  return null;
}

async function mdnsReverse(ip, timeout = 800) {
  return udpQuery({ host: '224.0.0.251', port: 5353, packet: buildMdnsQuery(ip), timeout, parse: parseMdnsPtr, multicast: true });
}

// --- NetBIOS node-status (NBSTAT) query on UDP 137 ---
function buildNbstatQuery() {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x4d4e, 0); // arbitrary transaction id
  header.writeUInt16BE(1, 4);      // QDCOUNT = 1
  // Wildcard NetBIOS name "*" (0x2a + 15 nulls), level-2 encoded to 32 bytes.
  const raw = Buffer.alloc(16);
  raw[0] = 0x2a;
  const enc = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) {
    enc[i * 2] = 0x41 + (raw[i] >> 4);
    enc[i * 2 + 1] = 0x41 + (raw[i] & 0x0f);
  }
  const qname = Buffer.concat([Buffer.from([0x20]), enc, Buffer.from([0x00])]);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(0x0021, 0); // QTYPE  = NBSTAT
  tail.writeUInt16BE(0x0001, 2); // QCLASS = IN
  return Buffer.concat([header, qname, tail]);
}

function parseNbstat(buf) {
  if (buf.length < 12) return null;
  if (buf.readUInt16BE(6) === 0) return null; // ANCOUNT
  let off = 12;
  // Answer NAME: a compression pointer (2 bytes) or a length-prefixed label.
  off += (buf[off] & 0xc0) === 0xc0 ? 2 : 1 + buf[off] + 1;
  if (off + 11 > buf.length) return null;
  let p = off + 10; // skip TYPE(2) CLASS(2) TTL(4) RDLENGTH(2)
  const numNames = buf[p++];
  for (let i = 0; i < numNames; i++) {
    if (p + 18 > buf.length) break;
    const name = buf.toString('latin1', p, p + 15).replace(/[\x00-\x1f]+$/, '').trimEnd();
    const suffix = buf[p + 15];
    const isGroup = (buf.readUInt16BE(p + 16) & 0x8000) !== 0;
    p += 18;
    // Suffix 0x00 + unique = the workstation/computer name.
    if (suffix === 0x00 && !isGroup) {
      const n = cleanName(name);
      if (n) return n;
    }
  }
  return null;
}

async function netbiosName(ip, timeout = 700) {
  return udpQuery({ host: ip, port: 137, packet: buildNbstatQuery(), timeout, parse: parseNbstat });
}

// --- Reverse DNS (PTR via configured DNS servers only) ---
async function reverseDns(ip) {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1200)),
    ]);
    if (Array.isArray(names) && names.length) return cleanName(names[0]);
  } catch {
    /* no PTR record (the common case) or lookup failed */
  }
  return null;
}

// Public: try each source in turn, first hit wins.
async function resolveHostname(ip) {
  return (
    (await reverseDns(ip)) ||
    (await mdnsReverse(ip).catch(() => null)) ||
    (await netbiosName(ip).catch(() => null)) ||
    null
  );
}

module.exports = {
  ping,
  pingAlive,
  readArpTable,
  resolveHostname,
  reverseDns,
  mdnsReverse,
  netbiosName,
  defaultRoute,
  PLATFORM,
};
