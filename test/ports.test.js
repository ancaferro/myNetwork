'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const dgram = require('dgram');
const {
  DEFAULT_PORTS,
  COMMON_PORTS,
  UDP_PORTS,
  serviceName,
  probePort,
  probeUdp,
  allTcpPorts,
} = require('../src/scanner/ports');

test('serviceName: TCP lookups', () => {
  assert.equal(serviceName(22, 'tcp'), 'SSH');
  assert.equal(serviceName(80, 'tcp'), 'HTTP');
  assert.equal(serviceName(443, 'tcp'), 'HTTPS');
  assert.equal(serviceName(9999, 'tcp'), null);
});

test('serviceName: UDP lookups fall back to the TCP name table', () => {
  assert.equal(serviceName(53, 'udp'), 'DNS');
  assert.equal(serviceName(137, 'udp'), 'NetBIOS');
  assert.equal(serviceName(443, 'udp'), 'HTTPS'); // not in UDP table -> TCP fallback
  assert.equal(serviceName(12345, 'udp'), null);
});

test('port lists are well-formed', () => {
  const all = allTcpPorts();
  assert.equal(all.length, 65535);
  assert.equal(all[0], 1);
  assert.equal(all[all.length - 1], 65535);

  // COMMON_PORTS is sorted ascending and unique.
  const sorted = [...COMMON_PORTS].sort((a, b) => a - b);
  assert.deepEqual(COMMON_PORTS, sorted);
  assert.equal(new Set(COMMON_PORTS).size, COMMON_PORTS.length);

  // No duplicates in the default / UDP lists either.
  assert.equal(new Set(DEFAULT_PORTS).size, DEFAULT_PORTS.length);
  assert.equal(new Set(UDP_PORTS).size, UDP_PORTS.length);
});

test('probePort reports an open TCP port', async () => {
  const server = net.createServer((sock) => sock.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await probePort('127.0.0.1', port, 1000);
    assert.equal(res.open, true);
    assert.equal(res.port, port);
  } finally {
    server.close();
  }
});

test('probePort reports a closed TCP port', async () => {
  // Grab a port, then immediately release it so the connect is refused.
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));

  const res = await probePort('127.0.0.1', port, 1000);
  assert.equal(res.open, false);
});

test('probePort captures a banner when the server speaks first', async () => {
  const server = net.createServer((sock) => sock.write('SSH-2.0-Test\r\n'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await probePort('127.0.0.1', port, 1000);
    assert.equal(res.open, true);
    assert.equal(res.banner, 'SSH-2.0-Test');
  } finally {
    server.close();
  }
});

test('probeUdp reports open when the service replies', async () => {
  const server = dgram.createSocket('udp4');
  server.on('message', (msg, rinfo) => server.send(Buffer.from('pong'), rinfo.port, rinfo.address));
  await new Promise((r) => server.bind(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await probeUdp('127.0.0.1', port, 1000);
    assert.equal(res.state, 'open');
    assert.equal(res.proto, 'udp');
  } finally {
    server.close();
  }
});
