'use strict';
// Standalone-package test suite for weightwatch-ci. Exercises the exact exported functions
// the shipped cli.js ships (buildReport, verifyLicenseWith) — not a reimplementation.
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const { buildReport, verifyLicenseWith, parseImports, packageOf } = require('../cli.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

const fixtureRoot = path.join(__dirname, 'fixtures', 'sample-repo');

test('buildReport finds a real OK path and a real OVER-budget path from the fixture', () => {
  const result = buildReport(fixtureRoot, {});
  assert.strictEqual(result.breach, true);
  assert.strictEqual(result.report['src/feature-a'].ok, false);
  assert.strictEqual(result.report['src/feature-b'].ok, true);
});

test('first-payer dedup: pkgfoo is paid once by feature-a, not charged again to feature-b', () => {
  const result = buildReport(fixtureRoot, {});
  // feature-b imports both pkgfoo (already paid) and pkgbar (new) — only pkgbar's weight
  // should land on feature-b's budget path.
  assert.ok(result.report['src/feature-b'].usedKb < result.report['src/feature-a'].usedKb + 0.2);
});

test('parseImports catches import/require/dynamic-import forms', () => {
  const specs = parseImports("import a from 'pkg-a';\nconst b = require('pkg-b');\nimport('pkg-c');");
  assert.deepStrictEqual(specs.sort(), ['pkg-a', 'pkg-b', 'pkg-c']);
});

test('packageOf handles scoped and subpath specifiers, ignores relative imports', () => {
  assert.strictEqual(packageOf('@scope/pkg/sub'), '@scope/pkg');
  assert.strictEqual(packageOf('pkg/sub/path'), 'pkg');
  assert.strictEqual(packageOf('./local'), null);
  assert.strictEqual(packageOf('../local'), null);
});

test('license: a key signed by the real private key verifies true against the matching public key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const payload = Buffer.from(JSON.stringify({ product: 'weightwatch-pro', iat: Date.now() })).toString('base64url');
  const sig = crypto.createSign('SHA256').update(`WW1.${payload}`).end().sign(privateKey).toString('base64url');
  const key = `WW1.${payload}.${sig}`;
  assert.strictEqual(verifyLicenseWith(key, pubPem), true);
});

test('license: a tampered key is rejected', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const payload = Buffer.from(JSON.stringify({ product: 'weightwatch-pro', iat: Date.now() })).toString('base64url');
  const sig = crypto.createSign('SHA256').update(`WW1.${payload}`).end().sign(privateKey).toString('base64url');
  const tamperedPayload = Buffer.from(JSON.stringify({ product: 'weightwatch-pro', iat: 0 })).toString('base64url');
  const key = `WW1.${tamperedPayload}.${sig}`;
  assert.strictEqual(verifyLicenseWith(key, pubPem), false);
});

test('license: non-canonical base64url (coin-flip tamper-bypass shape) is rejected, not accepted by luck', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const payload = Buffer.from(JSON.stringify({ product: 'weightwatch-pro', iat: Date.now() })).toString('base64url');
  const sig = crypto.createSign('SHA256').update(`WW1.${payload}`).end().sign(privateKey).toString('base64url');
  // append raw bytes that don't complete a base64 4-char group — the exact shape that
  // silently decoded to the same bytes under the pre-fix b64urlToBuf.
  const key = `WW1.${payload}.${sig}AB`;
  assert.strictEqual(verifyLicenseWith(key, pubPem), false);
});

test('license: a key signed by a DIFFERENT private key is rejected by this public key', () => {
  const { publicKey: pubA } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { privateKey: privB } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubPemA = pubA.export({ type: 'spki', format: 'pem' });
  const payload = Buffer.from(JSON.stringify({ product: 'weightwatch-pro', iat: Date.now() })).toString('base64url');
  const sig = crypto.createSign('SHA256').update(`WW1.${payload}`).end().sign(privB).toString('base64url');
  const key = `WW1.${payload}.${sig}`;
  assert.strictEqual(verifyLicenseWith(key, pubPemA), false);
});

console.log(`\n${passed} passed, ${process.exitCode ? 'some failed' : '0 failed'}`);
if (!process.exitCode) console.log('All weightwatch-ci standalone test groups passed.');
