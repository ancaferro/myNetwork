'use strict';
const { execFile } = require('child_process');
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

// ---- Reverse DNS / hostname -------------------------------------------------
async function resolveHostname(ip) {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1200)),
    ]);
    if (Array.isArray(names) && names.length) return names[0];
  } catch {
    /* ignore */
  }
  return null;
}

module.exports = { ping, readArpTable, resolveHostname, defaultRoute, PLATFORM };
