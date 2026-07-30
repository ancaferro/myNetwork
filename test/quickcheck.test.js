'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { quickCheck, resolveTargets } = require('../src/scanner');

test('quickCheck: empty input throws', async () => {
  await assert.rejects(() => quickCheck(''), /host/i);
});

test('quickCheck: IP input with an open port reports open', async () => {
  const server = net.createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await quickCheck(`127.0.0.1:${port}`, { pingTimeout: 800 });
    assert.equal(res.resolved, true);
    assert.equal(res.ip, '127.0.0.1');
    assert.equal(res.port, port);
    assert.equal(res.tcp.length, 1);
    assert.equal(res.tcp[0].state, 'open');
    assert.equal(typeof res.alive, 'boolean');
  } finally {
    server.close();
  }
});

test('quickCheck: no port given falls back to 443 + 80', async () => {
  const res = await quickCheck('127.0.0.1', { pingTimeout: 800 });
  assert.equal(res.resolved, true);
  assert.deepEqual(res.tcp.map((t) => t.port), [443, 80]);
  // Nothing is listening locally, so both are refused (host up) — never 'open'.
  for (const t of res.tcp) assert.ok(['refused', 'filtered'].includes(t.state));
});

test('quickCheck: unresolvable host reports resolved:false', async () => {
  const res = await quickCheck('nonexistent.invalid', { pingTimeout: 500 });
  assert.equal(res.resolved, false);
  assert.ok(res.resolveError);
});

test('resolveTargets: IP / CIDR / range specs pass through untouched', async () => {
  const r = await resolveTargets('10.0.0.0/24, 192.168.1.5, 10.0.0.1-10.0.0.9');
  assert.equal(r.target, '10.0.0.0/24, 192.168.1.5, 10.0.0.1-10.0.0.9');
  assert.equal(r.label, r.target);
});

test('resolveTargets: a hostname is resolved and labelled', async () => {
  const r = await resolveTargets('localhost');
  assert.equal(r.target, '127.0.0.1');
  assert.equal(r.label, 'localhost (127.0.0.1)');
});

test('resolveTargets: mixed hostname + CIDR', async () => {
  const r = await resolveTargets('localhost, 10.0.0.0/30');
  assert.equal(r.target, '127.0.0.1, 10.0.0.0/30');
  assert.equal(r.label, 'localhost (127.0.0.1), 10.0.0.0/30');
});

test('resolveTargets: empty throws, unresolvable throws', async () => {
  await assert.rejects(() => resolveTargets('   '), /empty/i);
  await assert.rejects(() => resolveTargets('nonexistent.invalid'), /resolve/i);
});
