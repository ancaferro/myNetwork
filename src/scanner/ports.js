'use strict';
const net = require('net');

// Common/interesting TCP ports with human-readable service names.
const SERVICES = {
  21: 'FTP',
  22: 'SSH',
  23: 'Telnet',
  25: 'SMTP',
  53: 'DNS',
  80: 'HTTP',
  110: 'POP3',
  111: 'RPC',
  135: 'MSRPC',
  139: 'NetBIOS',
  143: 'IMAP',
  161: 'SNMP',
  389: 'LDAP',
  443: 'HTTPS',
  445: 'SMB',
  515: 'LPD',
  548: 'AFP',
  554: 'RTSP',
  587: 'SMTP',
  631: 'IPP',
  993: 'IMAPS',
  995: 'POP3S',
  1080: 'SOCKS',
  1433: 'MSSQL',
  1723: 'PPTP',
  1883: 'MQTT',
  1900: 'SSDP',
  2049: 'NFS',
  2375: 'Docker',
  3000: 'Dev/HTTP',
  3306: 'MySQL',
  3389: 'RDP',
  5000: 'UPnP/HTTP',
  5060: 'SIP',
  5353: 'mDNS',
  5432: 'Postgres',
  5555: 'ADB',
  5900: 'VNC',
  6379: 'Redis',
  7000: 'HTTP',
  8006: 'Proxmox',
  8080: 'HTTP-alt',
  8081: 'HTTP-alt',
  8443: 'HTTPS-alt',
  8883: 'MQTTS',
  9000: 'HTTP/PHP-FPM',
  9100: 'Printer',
  9200: 'Elasticsearch',
  27017: 'MongoDB',
  32400: 'Plex',
  62078: 'iOS-sync',
};

// A sensible default fast list; the rest are available as "full".
const DEFAULT_PORTS = [
  21, 22, 23, 25, 53, 80, 110, 139, 143, 161, 443, 445, 515, 548, 554, 631,
  993, 1883, 3000, 3306, 3389, 5000, 5432, 5900, 6379, 8006, 8080, 8443, 9100, 32400,
];

// "Common" TCP layer = every named service port.
const COMMON_PORTS = Object.keys(SERVICES).map(Number).sort((a, b) => a - b);
const FULL_PORTS = COMMON_PORTS; // kept for backward compatibility

// Common UDP ports worth probing (all 65535 UDP is impractical & noisy).
const UDP_PORTS = [
  53, 67, 68, 69, 123, 137, 138, 161, 162, 500, 514, 520, 631, 1194, 1900, 4500, 5060, 5353, 11211,
];

const UDP_SERVICES = {
  53: 'DNS', 67: 'DHCP', 68: 'DHCP', 69: 'TFTP', 123: 'NTP', 137: 'NetBIOS', 138: 'NetBIOS',
  161: 'SNMP', 162: 'SNMP-trap', 500: 'IKE', 514: 'Syslog', 520: 'RIP', 631: 'IPP',
  1194: 'OpenVPN', 1900: 'SSDP', 4500: 'IPsec-NAT', 5060: 'SIP', 5353: 'mDNS', 11211: 'Memcached',
};

function serviceName(port, proto) {
  if (proto === 'udp') return UDP_SERVICES[port] || SERVICES[port] || null;
  return SERVICES[port] || null;
}

// Service-specific UDP probes that elicit a reply from live services.
const DEFAULT_UDP_PROBE = Buffer.from([0x00]);
const UDP_PROBES = {
  53: Buffer.from('0000010000010000000000000377777706676f6f676c6503636f6d0000010001', 'hex'), // DNS A www.google.com
  123: Buffer.concat([Buffer.from([0x1b]), Buffer.alloc(47)]), // NTP client request
  161: Buffer.from('302602010004067075626c6963a01902010102010002010030' + '0e300c06082b060102010101000500', 'hex'), // SNMP get sysDescr
  1900: Buffer.from(
    'M-SEARCH * HTTP/1.1\r\nHOST:239.255.255.250:1900\r\nMAN:"ssdp:discover"\r\nMX:1\r\nST:ssdp:all\r\n\r\n'
  ),
  // mDNS PTR query for _services._dns-sd._udp.local
  5353: Buffer.from(
    '000000000001000000000000095f7365727669636573075f646e732d7364045f756470056c6f63616c00000c0001',
    'hex'
  ),
};

// Attempt a TCP connect. Resolves { open, banner }.
// A successful connect === open, regardless of whether the service sends a
// banner. Most services stay silent until spoken to, so we must NOT require
// data to consider the port open.
function probePort(ip, port, timeout = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let opened = false;
    let banner = '';

    const done = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, open: opened, banner: banner.trim() || null });
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => {
      opened = true; // port is open the moment the handshake completes
      // Give the server a short grace period to offer a banner, then finish.
      socket.setTimeout(300);
    });
    socket.once('data', (buf) => {
      banner = buf.toString('latin1').split('\n')[0].slice(0, 80);
      done();
    });
    // Pre-connect timeout/error => closed (opened=false).
    // Post-connect timeout (banner grace elapsed) => open (opened=true).
    socket.once('timeout', done);
    socket.once('error', done);
    socket.connect(port, ip);
  });
}

// UDP probe: connect (so ICMP port-unreachable surfaces as ECONNREFUSED),
// send a service payload, and classify by the reply.
//   reply           -> open
//   ICMP unreachable -> closed
//   nothing          -> open|filtered (not reported to avoid false positives)
const dgram = require('dgram');
function probeUdp(ip, port, timeout = 1200) {
  return new Promise((resolve) => {
    let sock;
    let done = false;
    let timer;
    const finish = (state, banner) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (sock) sock.close(); } catch { /* ignore */ }
      resolve({ port, proto: 'udp', state, banner: banner || null });
    };
    try {
      sock = dgram.createSocket('udp4');
    } catch {
      return resolve({ port, proto: 'udp', state: 'error', banner: null });
    }
    sock.on('error', () => finish('closed'));
    sock.on('message', (msg) => finish('open', msg.length ? `${msg.length}B reply` : null));
    const payload = UDP_PROBES[port] || DEFAULT_UDP_PROBE;
    try {
      sock.connect(port, ip, () => sock.send(payload, () => {}));
    } catch {
      return finish('closed');
    }
    timer = setTimeout(() => finish('openfiltered'), timeout);
  });
}

function allTcpPorts() {
  return Array.from({ length: 65535 }, (_, i) => i + 1);
}

module.exports = {
  SERVICES,
  DEFAULT_PORTS,
  COMMON_PORTS,
  FULL_PORTS,
  UDP_PORTS,
  serviceName,
  probePort,
  probeUdp,
  allTcpPorts,
};
