'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ipToInt,
  intToIp,
  parseTargets,
  iterateHosts,
  expandTargets,
  detectInterfaces,
} = require('../src/scanner/net-utils');

test('ipToInt / intToIp round-trip', () => {
  for (const ip of ['0.0.0.0', '10.16.69.1', '192.168.1.255', '255.255.255.255']) {
    assert.equal(intToIp(ipToInt(ip)), ip);
  }
  assert.equal(ipToInt('0.0.0.1'), 1);
  assert.equal(ipToInt('255.255.255.255'), 0xffffffff);
});

test('ipToInt rejects malformed addresses', () => {
  for (const bad of ['256.0.0.1', '1.2.3', '1.2.3.4.5', 'x.y.z.w', '-1.0.0.0']) {
    assert.throws(() => ipToInt(bad), /Invalid IPv4/);
  }
});

test('parseTargets: /24 skips network + broadcast', () => {
  const t = parseTargets('10.0.0.0/24');
  assert.equal(t.cidr, '10.0.0.0/24');
  assert.equal(intToIp(t.first), '10.0.0.1');
  assert.equal(intToIp(t.last), '10.0.0.254');
  assert.equal(t.count, 254);
});

test('parseTargets: host bits are normalized to the network address', () => {
  assert.equal(parseTargets('10.0.0.37/24').cidr, '10.0.0.0/24');
  assert.equal(parseTargets('192.168.1.200/28').cidr, '192.168.1.192/28');
});

test('parseTargets: a bare IP is a single host (/32)', () => {
  const t = parseTargets('10.0.0.5');
  assert.equal(t.cidr, '10.0.0.5/32');
  assert.equal(t.count, 1);
  assert.equal(intToIp(t.first), '10.0.0.5');
  assert.equal(intToIp(t.last), '10.0.0.5');
});

test('parseTargets: rejects targets over the host cap', () => {
  assert.throws(() => parseTargets('10.0.0.0/8'), /too large/i);
  assert.throws(() => parseTargets('10.0.0.1-10.255.255.254'), /too large/i);
  // A /16 (65534 hosts) sits just under the cap and is allowed.
  assert.equal(parseTargets('10.1.0.0/16').count, 65534);
});

test('parseTargets: /31 and /32 use the whole span', () => {
  const t31 = parseTargets('10.0.0.4/31');
  assert.equal(t31.count, 2);
  assert.deepEqual([intToIp(t31.first), intToIp(t31.last)], ['10.0.0.4', '10.0.0.5']);

  const t32 = parseTargets('10.0.0.9/32');
  assert.equal(t32.count, 1);
  assert.equal(intToIp(t32.first), '10.0.0.9');
  assert.equal(intToIp(t32.last), '10.0.0.9');
});

test('parseTargets: explicit range', () => {
  const t = parseTargets('192.168.1.10-192.168.1.12');
  assert.equal(t.count, 3);
  assert.equal(intToIp(t.first), '192.168.1.10');
  assert.equal(intToIp(t.last), '192.168.1.12');
});

test('parseTargets: invalid input throws', () => {
  assert.throws(() => parseTargets(''), /Empty target/);
  assert.throws(() => parseTargets('10.0.0.5-10.0.0.1'), /before start/);
  assert.throws(() => parseTargets('10.0.0.0/33'), /Invalid prefix/);
});

test('iterateHosts yields every host in order', () => {
  const hosts = [...iterateHosts(parseTargets('10.0.0.0/30'))];
  assert.deepEqual(hosts, ['10.0.0.1', '10.0.0.2']);
});

test('expandTargets de-duplicates across comma-separated specs', () => {
  const r = expandTargets('10.0.0.1-10.0.0.3, 10.0.0.3-10.0.0.4');
  assert.deepEqual(r.ips, ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']);
  assert.equal(r.label, '10.0.0.1-10.0.0.3, 10.0.0.3-10.0.0.4');
});

test('expandTargets: empty spec list throws', () => {
  assert.throws(() => expandTargets('   ,  , '), /Empty target/);
});

test('detectInterfaces returns well-shaped, sorted interface records', () => {
  const ifaces = detectInterfaces();
  assert.ok(Array.isArray(ifaces));
  for (const i of ifaces) {
    assert.equal(typeof i.name, 'string');
    assert.ok(Array.isArray(i.addresses) && i.addresses.length > 0);
    assert.ok(i.primary && typeof i.primary.bits === 'number');
    assert.deepEqual(i.cidrs, i.addresses.map((a) => a.cidr));
    for (const a of i.addresses) {
      assert.match(a.address, /^\d+\.\d+\.\d+\.\d+$/);
      assert.ok(a.bits >= 0 && a.bits <= 32);
    }
  }
  // Sorted by most-specific network first.
  for (let k = 1; k < ifaces.length; k++) {
    assert.ok(ifaces[k - 1].primary.bits >= ifaces[k].primary.bits);
  }
});
