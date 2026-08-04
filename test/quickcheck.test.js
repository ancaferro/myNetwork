'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { quickCheck, resolveHost } = require('../src/scanner/quickcheck');
const { resolveTargets } = require('../src/scanner');
const { withOpenServer } = require('./test-utils');

// ---- quickCheck (issue #6) --------------------------------------------------
test('resolveHost resolves an IP literal without a network round-trip', async () => {
  const r = await resolveHost('127.0.0.1');
  assert.equal(r.ip, '127.0.0.1');
  assert.equal(r.error, null);
});

test('quickCheck against an explicit port checks only that port', async () => {
  await withOpenServer(
    (sock) => sock.end(),
    async (port) => {
      const res = await quickCheck(`127.0.0.1:${port}`, { pingTimeout: 500, portTimeout: 800 });
      assert.equal(res.resolved, true);
      assert.equal(res.ip, '127.0.0.1');
      assert.equal(res.ports.length, 1);
      assert.equal(res.ports[0].port, port);
      assert.equal(res.ports[0].state, 'open');
    }
  );
});

test('quickCheck with no port checks both 80 and 443', async () => {
  const res = await quickCheck('127.0.0.1', { pingTimeout: 500, portTimeout: 800 });
  assert.equal(res.resolved, true);
  const checkedPorts = res.ports.map((p) => p.port).sort((a, b) => a - b);
  assert.deepEqual(checkedPorts, [80, 443]);
  // Nothing is listening locally, so neither may be reported open.
  for (const p of res.ports) assert.ok(['closed', 'filtered'].includes(p.state));
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

test('quickCheck rejects an out-of-range port instead of reaching the socket', async () => {
  // Regression: the bracketed-IPv6 branch used to skip range validation, so
  // this surfaced as a RangeError from socket.connect() rather than a clean
  // parse error.
  await assert.rejects(() => quickCheck('[::1]:99999'), /Invalid host:port/);
  await assert.rejects(() => quickCheck('[::1]:0'), /Invalid host:port/);
});

// ---- resolveTargets (hostname as a scan target, issue #7) -------------------
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
