'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanName,
  encodeDnsName,
  decodeDnsName,
  buildMdnsQuery,
  parseMdnsPtr,
  buildNbstatQuery,
  parseNbstat,
  netbiosName,
} = require('../src/scanner/discovery');

test('cleanName trims dots/spaces and rejects junk', () => {
  assert.equal(cleanName('host.local.'), 'host.local');
  assert.equal(cleanName('  host  '), 'host');
  assert.equal(cleanName('*'), null);
  assert.equal(cleanName(''), null);
  assert.equal(cleanName(null), null);
});

test('encodeDnsName / decodeDnsName round-trip', () => {
  const buf = encodeDnsName('MacBook-Pro.local');
  const { name, next } = decodeDnsName(buf, 0);
  assert.equal(name, 'MacBook-Pro.local');
  assert.equal(next, buf.length);
});

test('decodeDnsName follows compression pointers', () => {
  // "arpa" at offset 0, then a name "1.in-addr" that points back to it.
  const arpa = encodeDnsName('arpa'); // [4]arpa[0]  -> "arpa" starts at offset 0
  const head = Buffer.concat([
    Buffer.from([1]), Buffer.from('1'),
    Buffer.from([7]), Buffer.from('in-addr'),
    Buffer.from([0xc0, 0x00]), // pointer -> offset 0 ("arpa")
  ]);
  const buf = Buffer.concat([arpa, head]);
  const { name } = decodeDnsName(buf, arpa.length);
  assert.equal(name, '1.in-addr.arpa');
});

test('buildMdnsQuery encodes a reverse PTR question with the QU bit', () => {
  const q = buildMdnsQuery('10.16.69.9');
  assert.equal(q.readUInt16BE(4), 1); // QDCOUNT
  const { name, next } = decodeDnsName(q, 12);
  assert.equal(name, '9.69.16.10.in-addr.arpa');
  assert.equal(q.readUInt16BE(next), 12); // QTYPE = PTR
  assert.equal(q.readUInt16BE(next + 2), 0x8001); // QCLASS = IN | unicast-response
});

test('parseMdnsPtr extracts the PTR target from a response', () => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2); // response flags
  header.writeUInt16BE(1, 6); // ANCOUNT = 1
  const ansName = encodeDnsName('9.69.16.10.in-addr.arpa');
  const rr = Buffer.alloc(10);
  rr.writeUInt16BE(12, 0); // TYPE = PTR
  rr.writeUInt16BE(1, 2); // CLASS = IN
  rr.writeUInt32BE(120, 4); // TTL
  const rdata = encodeDnsName('hermes.local');
  rr.writeUInt16BE(rdata.length, 8); // RDLENGTH
  const resp = Buffer.concat([header, ansName, rr, rdata]);

  assert.equal(parseMdnsPtr(resp), 'hermes.local');
});

test('parseMdnsPtr returns null when there are no answers', () => {
  const header = Buffer.alloc(12); // ANCOUNT = 0
  assert.equal(parseMdnsPtr(header), null);
  assert.equal(parseMdnsPtr(Buffer.alloc(4)), null); // too short
});

// Helper: assemble a minimal NBSTAT node-status response.
function nbstatResponse(entries) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 6); // ANCOUNT = 1
  const ansName = Buffer.concat([Buffer.from([0x20]), Buffer.alloc(32, 0x41), Buffer.from([0x00])]);
  const rr = Buffer.alloc(10);
  rr.writeUInt16BE(0x21, 0); // TYPE = NBSTAT
  rr.writeUInt16BE(1, 2); // CLASS = IN
  const body = [Buffer.from([entries.length])];
  for (const e of entries) {
    const entry = Buffer.alloc(18);
    entry.write(e.name.padEnd(15, ' ').slice(0, 15), 0, 'latin1');
    entry[15] = e.suffix;
    entry.writeUInt16BE(e.group ? 0x8000 : 0x0400, 16);
    body.push(entry);
  }
  body.push(Buffer.alloc(46)); // MAC + statistics block (zeros)
  const rdata = Buffer.concat(body);
  rr.writeUInt16BE(rdata.length, 8); // RDLENGTH
  return Buffer.concat([header, ansName, rr, rdata]);
}

test('buildNbstatQuery is a wildcard NBSTAT question', () => {
  const q = buildNbstatQuery();
  assert.equal(q.readUInt16BE(4), 1); // QDCOUNT
  assert.equal(q[12], 0x20); // encoded-name length
  // QTYPE / QCLASS live right after the 34-byte encoded name.
  assert.equal(q.readUInt16BE(12 + 34), 0x21);
  assert.equal(q.readUInt16BE(12 + 34 + 2), 0x0001);
});

test('parseNbstat picks the unique workstation (suffix 0x00) name', () => {
  const resp = nbstatResponse([
    { name: 'WORKGROUP', suffix: 0x00, group: true }, // group -> ignored
    { name: 'GAMESTATION', suffix: 0x20, group: false }, // wrong suffix -> ignored
    { name: 'GAMESTATION', suffix: 0x00, group: false }, // the machine name
  ]);
  assert.equal(parseNbstat(resp), 'GAMESTATION');
});

test('parseNbstat returns null without a matching name', () => {
  const resp = nbstatResponse([{ name: 'WORKGROUP', suffix: 0x00, group: true }]);
  assert.equal(parseNbstat(resp), null);
  assert.equal(parseNbstat(Buffer.alloc(4)), null); // too short
});

test('netbiosName resolves to null when nothing answers (timeout path)', async () => {
  // 192.0.2.1 is TEST-NET-1 (RFC 5737) — guaranteed not to respond.
  const r = await netbiosName('192.0.2.1', 250);
  assert.equal(r, null);
});
