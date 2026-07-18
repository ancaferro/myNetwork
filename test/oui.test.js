'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { vendorForMac } = require('../src/scanner/oui');

test('curated map wins for common gear', () => {
  assert.equal(vendorForMac('00:0c:29:aa:bb:cc'), 'VMware');
  assert.equal(vendorForMac('b8:27:eb:12:34:56'), 'Raspberry Pi');
  assert.equal(vendorForMac('78:8a:20:00:00:01'), 'Ubiquiti');
});

test('MAC normalization: dashes and uppercase', () => {
  assert.equal(vendorForMac('B8-27-EB-12-34-56'), 'Raspberry Pi');
  assert.equal(vendorForMac('00:0C:29:00:00:00'), 'VMware');
});

test('falls back to the full IEEE OUI database', () => {
  // 00:00:00 is the first entry in oui-db.txt (XEROX CORPORATION).
  assert.equal(vendorForMac('00:00:00:11:22:33'), 'XEROX CORPORATION');
});

test('locally-administered address without a match => Randomized MAC', () => {
  assert.equal(vendorForMac('02:aa:bb:cc:dd:ee'), 'Randomized MAC');
});

test('empty / null MAC => null', () => {
  assert.equal(vendorForMac(null), null);
  assert.equal(vendorForMac(''), null);
  assert.equal(vendorForMac(undefined), null);
});
