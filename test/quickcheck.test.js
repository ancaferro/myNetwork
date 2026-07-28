'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { quickCheck, resolveHost } = require('../src/scanner/quickcheck');

test('resolveHost resolves an IP literal without a network round-trip', async () => {
  const r = await resolveHost('127.0.0.1');
  assert.equal(r.ip, '127.0.0.1');
  assert.equal(r.error, null);
});

test('quickCheck against an explicit port checks only that port', async () => {
  const server = net.createServer((sock) => sock.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await quickCheck(`127.0.0.1:${port}`, { pingTimeout: 500, portTimeout: 800 });
    assert.equal(res.resolved, true);
    assert.equal(res.ip, '127.0.0.1');
    assert.equal(res.ports.length, 1);
    assert.equal(res.ports[0].port, port);
    assert.equal(res.ports[0].state, 'open');
  } finally {
    server.close();
  }
});

test('quickCheck with no port checks both 80 and 443', async () => {
  const res = await quickCheck('127.0.0.1', { pingTimeout: 500, portTimeout: 800 });
  assert.equal(res.resolved, true);
  const checkedPorts = res.ports.map((p) => p.port).sort((a, b) => a - b);
  assert.deepEqual(checkedPorts, [80, 443]);
});

test('quickCheck reports resolved:false and stops without probing ports or ICMP', async () => {
  // A syntactically invalid hostname (space is not a valid DNS/host character)
  // fails getaddrinfo locally, without needing a real network lookup.
  const res = await quickCheck('not a valid host');
  assert.equal(res.resolved, false);
  assert.equal(res.ip, null);
  assert.ok(res.dnsError);
  assert.equal(res.icmp, null);
  assert.deepEqual(res.ports, []);
});
