'use strict';
const os = require('os');

// ---- IPv4 <-> integer -------------------------------------------------------
function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// ---- CIDR parsing -----------------------------------------------------------
// Accepts "10.0.0.0/24", "10.0.0.5/24", a plain "10.0.0.0" (assumes /24),
// or a range "10.0.0.1-10.0.0.50".
function parseTargets(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Empty target');

  if (raw.includes('-') && !raw.includes('/')) {
    const [a, b] = raw.split('-').map((s) => s.trim());
    const start = ipToInt(a);
    const end = ipToInt(b);
    if (end < start) throw new Error('Range end is before start');
    return { cidr: raw, first: start, last: end, count: end - start + 1 };
  }

  let [ip, bitsStr] = raw.split('/');
  const bits = bitsStr === undefined ? 24 : parseInt(bitsStr, 10);
  if (Number.isNaN(bits) || bits < 0 || bits > 32) throw new Error(`Invalid prefix /${bitsStr}`);

  const ipInt = ipToInt(ip);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  // For /31 and /32, use the whole span; otherwise skip network + broadcast.
  let first = network;
  let last = broadcast;
  if (bits <= 30) {
    first = (network + 1) >>> 0;
    last = (broadcast - 1) >>> 0;
  }
  return { cidr: `${intToIp(network)}/${bits}`, first, last, count: last - first + 1 };
}

function* iterateHosts(targets) {
  for (let n = targets.first; n <= targets.last; n++) yield intToIp(n >>> 0);
}

// Expand a comma-separated list of targets (CIDR / IP / range) into a single
// de-duplicated, ordered list of host IPs. Supports interfaces with several
// addresses: "10.0.0.0/24, 192.168.1.0/24".
function expandTargets(input) {
  const specs = String(input || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!specs.length) throw new Error('Empty target');

  const seen = new Set();
  const ips = [];
  for (const spec of specs) {
    const t = parseTargets(spec); // throws on invalid — surfaces to caller
    for (const ip of iterateHosts(t)) {
      if (!seen.has(ip)) {
        seen.add(ip);
        ips.push(ip);
      }
    }
  }
  return { label: specs.join(', '), ips };
}

// ---- Local interface detection ---------------------------------------------
// Grouped by interface name — an interface may carry several IPv4 addresses.
function detectInterfaces() {
  const ifaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    const addresses = [];
    let mac = null;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      mac = a.mac;
      const bits = cidrBitsFromNetmask(a.netmask);
      let cidr;
      try {
        cidr = parseTargets(`${a.address}/${bits}`).cidr;
      } catch {
        cidr = `${a.address}/${bits}`;
      }
      addresses.push({ address: a.address, netmask: a.netmask, bits, cidr, hosts: Math.max(0, Math.pow(2, 32 - bits) - 2) });
    }
    if (addresses.length) {
      result.push({
        name,
        mac,
        addresses,
        // convenience: the primary (smallest network / most specific) address
        primary: addresses.slice().sort((a, b) => b.bits - a.bits)[0],
        cidrs: addresses.map((a) => a.cidr),
      });
    }
  }
  result.sort((a, b) => (b.primary.bits - a.primary.bits) || a.name.localeCompare(b.name));
  return result;
}

function cidrBitsFromNetmask(mask) {
  try {
    return mask
      .split('.')
      .map((o) => parseInt(o, 10).toString(2).padStart(8, '0'))
      .join('')
      .split('')
      .reduce((acc, bit) => acc + (bit === '1' ? 1 : 0), 0);
  } catch {
    return 24;
  }
}

module.exports = {
  ipToInt,
  intToIp,
  parseTargets,
  iterateHosts,
  expandTargets,
  detectInterfaces,
};
