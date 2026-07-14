'use strict';

// A small curated OUI -> vendor map covering the most common consumer/enterprise
// gear you meet on a LAN. Not exhaustive; unknown prefixes return null.
const OUI = {
  '00:1a:11': 'Google',
  '3c:5a:b4': 'Google',
  'f4:f5:d8': 'Google',
  'd8:6c:63': 'Google',
  '00:0c:29': 'VMware',
  '00:50:56': 'VMware',
  '00:1c:14': 'VMware',
  '08:00:27': 'VirtualBox',
  '52:54:00': 'QEMU/KVM',
  '00:15:5d': 'Microsoft (Hyper-V)',
  '00:03:ff': 'Microsoft',
  'b8:27:eb': 'Raspberry Pi',
  'dc:a6:32': 'Raspberry Pi',
  'e4:5f:01': 'Raspberry Pi',
  '28:cd:c1': 'Raspberry Pi',
  '2c:cf:67': 'Raspberry Pi',
  '00:1b:63': 'Apple',
  '00:1e:c2': 'Apple',
  '3c:07:54': 'Apple',
  'a4:83:e7': 'Apple',
  'f0:18:98': 'Apple',
  '88:66:5a': 'Apple',
  'ac:bc:32': 'Apple',
  '00:23:12': 'Apple',
  'd0:e1:40': 'Apple',
  '00:1d:d8': 'Microsoft',
  '00:12:5a': 'Microsoft',
  'fc:fb:fb': 'Cisco',
  '00:1a:a1': 'Cisco',
  '00:0a:41': 'Cisco',
  '00:1b:0c': 'Cisco',
  '00:26:99': 'Cisco',
  '00:18:0a': 'Meraki',
  'e0:cb:bc': 'ASUS',
  '2c:56:dc': 'ASUS',
  '04:d4:c4': 'ASUS',
  'd8:50:e6': 'ASUS',
  '00:1d:7e': 'Linksys',
  '00:25:9c': 'Linksys',
  'c0:56:27': 'Belkin',
  '00:14:bf': 'Linksys',
  '00:18:e7': 'Netgear',
  '00:26:f2': 'Netgear',
  '20:e5:2a': 'Netgear',
  'a0:40:a0': 'Netgear',
  '00:1f:33': 'Netgear',
  '90:9a:4a': 'TP-Link',
  '50:c7:bf': 'TP-Link',
  'ac:84:c6': 'TP-Link',
  '14:cc:20': 'TP-Link',
  'c4:e9:84': 'TP-Link',
  '00:0e:8f': 'D-Link',
  '1c:bd:b9': 'D-Link',
  '00:1c:f0': 'D-Link',
  'fc:ec:da': 'Ubiquiti',
  '24:a4:3c': 'Ubiquiti',
  '78:8a:20': 'Ubiquiti',
  '68:d7:9a': 'Ubiquiti',
  '04:18:d6': 'Ubiquiti',
  'b4:fb:e4': 'Ubiquiti',
  '00:04:20': 'Slim Devices',
  '00:11:32': 'Synology',
  '00:1b:a9': 'Brother',
  '00:80:77': 'Brother',
  '30:05:5c': 'Samsung',
  '5c:0a:5b': 'Samsung',
  '8c:77:12': 'Samsung',
  'c8:d0:83': 'Samsung',
  '00:16:32': 'Samsung',
  '00:24:e4': 'Withings',
  '18:b4:30': 'Nest',
  '64:16:66': 'Nest',
  '00:17:88': 'Philips Hue',
  'ec:b5:fa': 'Philips',
  '00:04:4b': 'NVIDIA',
  '48:b0:2d': 'NVIDIA',
  'e0:d5:5e': 'Giga-Byte',
  '1c:1b:0d': 'Giga-Byte',
  'b4:2e:99': 'Giga-Byte',
  '00:e0:4c': 'Realtek',
  '52:54:ab': 'Realtek',
  'd8:bb:c1': 'Micro-Star (MSI)',
  '00:d8:61': 'Micro-Star (MSI)',
  '70:85:c2': 'ASRock',
  'bc:24:11': 'Proxmox',
  'a2:aa:aa': 'Locally administered',
};

function normalizeMac(mac) {
  return String(mac || '').toLowerCase().replace(/-/g, ':');
}

// Full IEEE OUI database (prefix<TAB>vendor), loaded lazily and cached.
const fs = require('fs');
const path = require('path');
let fullDb = null;

function loadFullDb() {
  if (fullDb) return fullDb;
  fullDb = new Map();
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'oui-db.txt'), 'utf8');
    let i = 0;
    while (i < raw.length) {
      let nl = raw.indexOf('\n', i);
      if (nl === -1) nl = raw.length;
      const tab = raw.indexOf('\t', i);
      if (tab !== -1 && tab < nl) {
        fullDb.set(raw.slice(i, tab), raw.slice(tab + 1, nl));
      }
      i = nl + 1;
    }
  } catch {
    /* DB missing — fall back to the curated map only */
  }
  return fullDb;
}

function vendorForMac(mac) {
  if (!mac) return null;
  const norm = normalizeMac(mac);
  const parts = norm.split(':');
  const colonPrefix = parts.slice(0, 3).join(':'); // e.g. aa:bb:cc
  const flatPrefix = parts.slice(0, 3).join(''); // e.g. aabbcc

  // Curated map wins (nicer, friendlier names for common gear)...
  if (OUI[colonPrefix]) return OUI[colonPrefix];
  // ...then the full IEEE database.
  const db = loadFullDb();
  if (db.has(flatPrefix)) return db.get(flatPrefix);

  // Locally-administered bit (2nd-least-significant of first octet) => random MAC.
  const first = parseInt(parts[0], 16);
  if (!Number.isNaN(first) && first & 0x02) return 'Randomized MAC';
  return null;
}

module.exports = { vendorForMac };
