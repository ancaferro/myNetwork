'use strict';
// Fails CI on the shapes of code this project has decided it will never ship.
//
// myNetwork runs on plain Node with no runtime dependencies, no native
// modules, no root, and no network access of its own — the scanner talks to the
// LAN, the app itself never phones home. Those properties are what make it
// auditable, and any of them can be removed by a single plausible-looking
// commit, so they are enforced here rather than trusted to review.
//
// These are tripwires, not proofs: they catch the standard shapes cheaply and
// make the expensive cases stand out. A change that legitimately needs to cross
// one of these lines should relax the rule in this file in the same commit, so
// the decision shows up in the diff instead of slipping past.
//
// Run: node scripts/audit-supply-chain.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'scripts', 'test'];
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.html']);
const SELF = path.relative(ROOT, __filename);
// The auditor and its test necessarily spell out the patterns they look for.
// Neither is shipped: `build.files` in package.json packages src/ only.
const EXEMPT = new Set([SELF, path.join('test', 'supply-chain-audit.test.js')]);

// npm runs these on `npm install`, before anyone has read the code.
const LIFECYCLE_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'preuninstall',
  'uninstall',
  'postuninstall',
];

const PATTERNS = [
  {
    rule: 'remote-fetch',
    re: /require\(\s*['"](?:node:)?https?['"]\s*\)|\bfetch\s*\(|\bXMLHttpRequest\b/g,
    why: 'the app must not download anything at runtime',
  },
  {
    rule: 'remote-window',
    re: /\.loadURL\s*\(/g,
    why: 'windows load local files only; remote content must not be rendered',
  },
  {
    rule: 'unsafe-webpreferences',
    re: /nodeIntegration\s*:\s*true|contextIsolation\s*:\s*false/g,
    why: 'page content must never reach Node',
  },
  {
    rule: 'encoded-blob',
    re: /['"][0-9a-fA-F]{32,}['"]/g,
    why: 'long hex literal that is not decoded as a Buffer — the usual shape of a hidden URL or payload',
    // Wire-format probe constants are written inline as Buffer.from(<hex>, 'hex')
    // and are fine; a bare hex constant parked in a variable is not.
    allow: (text, end) => /^[^;]{0,80}['"]hex['"]/.test(text.slice(end, end + 120)),
  },
];

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// Returns [{ rule, line, why }] for one file's contents.
function scanText(text) {
  const found = [];
  for (const { rule, re, why, allow } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const end = m.index + m[0].length;
      if (allow && allow(text, end)) continue;
      found.push({ rule, line: lineOf(text, m.index), why });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

// Returns [{ rule, why }] for a parsed package.json.
function scanManifest(manifest) {
  const found = [];
  for (const hook of LIFECYCLE_HOOKS) {
    if (manifest.scripts && manifest.scripts[hook]) {
      found.push({ rule: 'lifecycle-script', why: `"${hook}" runs code on npm install` });
    }
  }
  const runtimeDeps = Object.keys(manifest.dependencies || {});
  if (runtimeDeps.length) {
    found.push({ rule: 'runtime-dependency', why: `ships ${runtimeDeps.join(', ')} to users` });
  }
  return found;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // the directory is optional
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function main() {
  const findings = [];

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const f of scanManifest(manifest)) findings.push({ file: 'package.json', ...f });

  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file);
      if (EXEMPT.has(rel)) continue;
      for (const f of scanText(fs.readFileSync(file, 'utf8'))) findings.push({ file: rel, ...f });
    }
  }

  if (findings.length) {
    console.error('Supply-chain audit failed:\n');
    for (const f of findings) {
      console.error(`  ${f.file}${f.line ? ':' + f.line : ''}  [${f.rule}]  ${f.why}`);
    }
    console.error(`\nIf a change genuinely needs one of these, relax the rule in ${SELF} in the same commit.`);
    process.exit(1);
  }
  console.log('Supply-chain audit passed: no install hooks, runtime deps, remote fetches or encoded blobs.');
}

if (require.main === module) main();

module.exports = { scanText, scanManifest, LIFECYCLE_HOOKS };
