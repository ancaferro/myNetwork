'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLinuxDefaultRoutes } = require('../src/scanner/discovery');

test('single default route yields its device and gateway', () => {
  const routes = parseLinuxDefaultRoutes(
    'default via 192.0.2.1 dev eth0 proto dhcp src 192.0.2.10 metric 100\n'
  );
  assert.deepEqual(routes, [{ iface: 'eth0', gateway: '192.0.2.1', metric: 100 }]);
});

test('wired + wifi both up: the lower metric wins regardless of print order', () => {
  const routes = parseLinuxDefaultRoutes(
    [
      'default via 192.168.1.1 dev wlp2s0 proto dhcp metric 600',
      'default via 192.168.1.1 dev enp3s0 proto dhcp metric 100',
    ].join('\n')
  );
  assert.equal(routes[0].iface, 'enp3s0');
  assert.equal(routes[1].iface, 'wlp2s0');
});

test('a route without an explicit metric outranks one with metric 100', () => {
  const routes = parseLinuxDefaultRoutes(
    ['default via 10.0.0.1 dev eth1 proto dhcp metric 100', 'default via 10.0.0.254 dev ppp0'].join('\n')
  );
  assert.equal(routes[0].iface, 'ppp0');
  assert.equal(routes[0].metric, 0);
});

test('equal metrics keep the order the kernel printed', () => {
  const routes = parseLinuxDefaultRoutes(
    ['default via 10.0.0.1 dev eth0 metric 100', 'default via 10.0.0.2 dev eth1 metric 100'].join('\n')
  );
  assert.deepEqual(
    routes.map((r) => r.iface),
    ['eth0', 'eth1']
  );
});

test('point-to-point route without via still yields the device', () => {
  const routes = parseLinuxDefaultRoutes('default dev tun0 scope link\n');
  assert.deepEqual(routes, [{ iface: 'tun0', gateway: null, metric: 0 }]);
});

test('wireguard + docker bridge: the VPN device is preferred', () => {
  const routes = parseLinuxDefaultRoutes(
    [
      'default via 172.17.0.1 dev docker0 proto static metric 400',
      'default dev wg0 scope link metric 50',
      'default via 192.168.0.1 dev wlan0 proto dhcp metric 600',
    ].join('\n')
  );
  assert.deepEqual(
    routes.map((r) => r.iface),
    ['wg0', 'docker0', 'wlan0']
  );
});

test('multipath default expands its nexthop devices', () => {
  const routes = parseLinuxDefaultRoutes(
    [
      'default proto static metric 200',
      '\tnexthop via 192.0.2.1 dev eth0 weight 1',
      '\tnexthop via 198.51.100.1 dev eth1 weight 1',
    ].join('\n')
  );
  assert.deepEqual(routes, [{ iface: 'eth0', gateway: '192.0.2.1', metric: 200 }]);
});

test('non-default lines, empty and missing input parse to nothing', () => {
  assert.deepEqual(parseLinuxDefaultRoutes('192.168.1.0/24 dev eth0 scope link\n'), []);
  assert.deepEqual(parseLinuxDefaultRoutes(''), []);
  assert.deepEqual(parseLinuxDefaultRoutes(undefined), []);
  assert.deepEqual(parseLinuxDefaultRoutes(null), []);
});
