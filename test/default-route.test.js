'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLinuxDefaultRoutes } = require('../src/scanner/discovery');

test('single default route', () => {
  const out = 'default via 192.0.2.1 dev eth0 proto dhcp src 192.0.2.10 metric 100\n';
  const r = parseLinuxDefaultRoutes(out);
  assert.equal(r.length, 1);
  assert.equal(r[0].iface, 'eth0');
  assert.equal(r[0].gateway, '192.0.2.1');
  assert.equal(r[0].metric, 100);
});

test('two default routes: lowest metric wins', () => {
  const out = [
    'default via 192.168.1.1 dev wlp2s0 proto dhcp metric 600',
    'default via 192.168.1.1 dev enp3s0 proto dhcp metric 100',
  ].join('\n');
  const r = parseLinuxDefaultRoutes(out);
  assert.equal(r.length, 2);
  assert.equal(r[0].iface, 'enp3s0');
  assert.equal(r[1].iface, 'wlp2s0');
});

test('metric-less route sorts first (kernel treats it as 0)', () => {
  const out = [
    'default via 10.0.0.1 dev eth1 proto dhcp metric 100',
    'default via 10.0.0.254 dev ppp0',
  ].join('\n');
  const r = parseLinuxDefaultRoutes(out);
  assert.equal(r[0].iface, 'ppp0');
  assert.equal(r[0].metric, 0);
});

test('route without via (point-to-point) still yields the device', () => {
  const r = parseLinuxDefaultRoutes('default dev tun0 scope link\n');
  assert.equal(r.length, 1);
  assert.equal(r[0].iface, 'tun0');
  assert.equal(r[0].gateway, null);
});

test('garbage and empty input parse to empty list', () => {
  assert.deepEqual(parseLinuxDefaultRoutes(''), []);
  assert.deepEqual(parseLinuxDefaultRoutes(undefined), []);
  assert.deepEqual(parseLinuxDefaultRoutes('192.168.1.0/24 dev eth0 scope link\n'), []);
});
