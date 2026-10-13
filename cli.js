#!/usr/bin/env node
'use strict';

// WeightWatch CI runner — self-contained, dependency-free (Node 18+, no npm install).
// This file is yours forever: it does not require the VS Code extension to keep working.
// It only needs a valid Pro license key, checked OFFLINE (no network call, no account,
// no phone-home) from ~/.weightwatch/license or the WEIGHTWATCH_KEY env var — put the
// latter in your CI secrets.
//
// Usage:
//   node weightwatch-ci.js check [--dir <path>] [--json]
//   Reads .weightwatch.json in <path> (default: cwd): { "budgets": { "path/prefix": kb } }
//
// Exit codes:
//   0 - every budgeted path is within its cap
//   1 - one or more budgeted paths are over cap
//   2 - configuration error (no .weightwatch.json budgets defined)
//   3 - license key missing or invalid
//
// Ledger logic is a hand-maintained mirror of the VS Code extension's own first-payer
// dedup algorithm, kept in parity by test/run.js running this file's own exports against
// a real fixture, not a reimplementation.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');

// ---------------------------------------------------------------------------------------
// License (BP-001 offline ECDSA-P256 verify) — identical logic + identical public key to
// the VS Code extension's src/license.js, including the canonical-base64url round-trip
// check: Buffer.from(x, 'base64') silently drops trailing bytes that don't complete a
// group of 4, so a tampered key can decode to the same bytes as the original by luck of
// byte alignment. That exact bug was found and fixed in all 6 D-lane extensions on
// 2026-09-07, then re-introduced in the FIRST standalone CLI product (localbolt-ci,
// shipped 2026-10-09) because its license block was hand-copied from an older,
// pre-fix shape. Ported with the fix already in place this time.
// ---------------------------------------------------------------------------------------
const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEctjbIEtIR3dTv09VszjUjLvLkhKDmIK3g/rpHIJ0eNm4N44cGwFrp5oJoUOL8t1k6iCftJHmFJCZ7/08AaZcYg==\n-----END PUBLIC KEY-----';
const LICENSE_PRODUCT = 'weightwatch-pro';

function b64urlToBuf(s) {
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const canonical = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (canonical !== s) throw new Error('non-canonical base64url');
  return buf;
}

function verifyLicenseWith(key, pubPem) {
  try {
    if (typeof key !== 'string') return false;
    const parts = key.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'WW1') return false;
    const signedData = `WW1.${parts[1]}`;
    const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
    if (payload.product !== LICENSE_PRODUCT) return false;
    if (payload.exp && Date.now() > payload.exp) return false;
    const v = crypto.createVerify('SHA256');
    v.update(signedData); v.end();
    return v.verify(pubPem, b64urlToBuf(parts[2]));
  } catch (e) { return false; }
}

function verifyLicense(key) {
  if (PUBLIC_KEY_PEM.includes('PLACEHOLDER')) return false;
  return verifyLicenseWith(key, PUBLIC_KEY_PEM);
}

function readLicenseKey() {
  if (process.env.WEIGHTWATCH_KEY) return process.env.WEIGHTWATCH_KEY.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.weightwatch', 'license'), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Ledger (identical algorithm to the extension's cli/weightwatch-ci.mjs): price every
// imported package ONCE across the workspace, attribute it to the first file that
// imports it, size it from the real installed node_modules copy via gzip.
// ---------------------------------------------------------------------------------------
function parseImports(src) {
  const specs = [];
  const res = [
    /\bimport\b[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of res) { let m; while ((m = re.exec(src))) specs.push(m[1]); }
  return specs;
}
function packageOf(s) {
  if (!s || s.startsWith('.') || s.startsWith('/')) return null;
  if (s.startsWith('@')) { const p = s.split('/'); return p.length >= 2 ? p[0] + '/' + p[1] : null; }
  return s.split('/')[0];
}
function walk(dir, out) {
  out = out || [];
  for (const e of fs.readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = path.join(dir, e);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (['.js', '.ts', '.jsx', '.tsx', '.mjs'].includes(path.extname(p))) out.push(p);
  }
  return out;
}
function sizePkg(fromDir, pkg) {
  let d = fromDir;
  for (;;) {
    const c = path.join(d, 'node_modules', pkg);
    if (fs.existsSync(c)) {
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(c, 'package.json')));
        const entry = path.join(c, pj.module || pj.main || 'index.js');
        return zlib.gzipSync(fs.readFileSync(fs.existsSync(entry) ? entry : path.join(c, 'index.js'))).length;
      } catch (e) { return 0; }
    }
    const parent = path.join(d, '..');
    if (parent === d) return 0;
    d = parent;
  }
}

class ConfigError extends Error {}

function buildReport(rootDir, opts) {
  opts = opts || {};
  const cfgPath = path.join(rootDir, '.weightwatch.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : { budgets: {} };
  if (!cfg.budgets || !Object.keys(cfg.budgets).length) {
    throw new ConfigError(`no .weightwatch.json budgets defined under ${rootDir}`);
  }
  const files = walk(rootDir);
  const firstPayer = new Map();
  const byPath = {};
  for (const f of files.sort()) {
    const src = fs.readFileSync(f, 'utf8');
    for (const spec of parseImports(src)) {
      const pkg = packageOf(spec);
      if (!pkg) continue;
      if (!firstPayer.has(pkg)) {
        firstPayer.set(pkg, f);
        const kb = sizePkg(rootDir, pkg) / 1024;
        const rel = f.replace(rootDir + path.sep, '').split(path.sep).join('/');
        for (const prefix of Object.keys(cfg.budgets)) {
          if (rel.startsWith(prefix)) byPath[prefix] = (byPath[prefix] || 0) + kb;
        }
      }
    }
  }
  let breach = false;
  const report = {};
  for (const [prefix, budgetKb] of Object.entries(cfg.budgets)) {
    const used = +(byPath[prefix] || 0).toFixed(1);
    report[prefix] = { usedKb: used, budgetKb, ok: used <= budgetKb };
    if (used > budgetKb) breach = true;
  }
  return { breach, report };
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') { args.dir = argv[++i]; }
    else if (a === '--json') { args.json = true; }
    else if (a === '--help' || a === '-h') { args.help = true; }
    else args._.push(a);
  }
  return args;
}

function printHumanReport(result) {
  console.log('WeightWatch CI — first-paid package weight per budget path:');
  for (const [p, r] of Object.entries(result.report)) {
    console.log(`  ${r.ok ? 'OK  ' : 'OVER'}  ${p}: ${r.usedKb}KB / ${r.budgetKb}KB`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (args.help || !command) {
    console.log('Usage: node weightwatch-ci.js check [--dir <path>] [--json]');
    process.exit(command ? 0 : 2);
    return;
  }
  if (command !== 'check') {
    console.error(`Unknown command "${command}". Only "check" is supported.`);
    process.exit(2);
    return;
  }

  const key = readLicenseKey();
  if (!key || !verifyLicense(key)) {
    console.error('WeightWatch: no valid Pro license found. Set WEIGHTWATCH_KEY (CI secret) or run "WeightWatch: Enter Pro License Key" in VS Code to write ~/.weightwatch/license.');
    process.exit(3);
    return;
  }

  const dir = args.dir ? path.resolve(process.cwd(), args.dir) : process.cwd();
  let result;
  try {
    result = buildReport(dir, {});
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`WeightWatch config error: ${e.message}`);
      process.exit(2);
      return;
    }
    throw e;
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanReport(result);
  }
  process.exit(result.breach ? 1 : 0);
}

if (require.main === module) main();

module.exports = { buildReport, verifyLicense, verifyLicenseWith, parseImports, packageOf };
