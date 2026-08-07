#!/usr/bin/env node
// Build a self-contained single-file binary using oam.js (`oam compile`).
//
// This is an ALTERNATIVE to scripts/build-binary.mjs (Node SEA), not a
// replacement. Both write to the same bin/<platform>-<arch>/<cmd>[.exe] path so
// scripts/stage-release-asset.mjs consumes either one unchanged -- run one or
// the other, never both expecting both outputs to survive.
//
// Why offer it, measured on this repo rather than assumed:
//   * oam compile output : ~57.7 MB, working, with bytecode embedded
//   * Node SEA carrier   : ~73.6 MB BEFORE the blob is injected
// so the oam binary is roughly 22% smaller for the same functionality. Node SEA
// remains the default because it needs no toolchain beyond the Node already on
// the build host; oam compile needs oam installed.
//
// What this does NOT change: the npm package. `dist/index.js` keeps its node
// shebang and stays runtime-agnostic, because that is the channel ~every user
// actually installs through. See the README's oam section for the cold-start
// measurement behind that decision.
//
// Prerequisite: oam on PATH (https://oamjs.org). Override with OAM_BIN.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
const { version } = pkg;
// Derived from package.json so this stays copy-paste generic across @yawlabs/*
// servers, matching build-binary.mjs.
const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split('/').pop();
const binEntry = Object.values(pkg.bin ?? {})[0] ?? pkg.main ?? 'dist/index.js';
const srcEntry = binEntry.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.[cm]?js$/, '.ts');

const platformDir = `${process.platform}-${process.arch}`;
const binDir = join(repoRoot, 'bin', platformDir);
const tmpDir = join(repoRoot, 'build-tmp');
// .cjs extension is load-bearing -- see the CJS note on the bundle step below.
const bundlePath = join(tmpDir, 'oam-bundle.cjs');
const outExe = join(binDir, isWin ? `${binName}.exe` : binName);

const oamBin = process.env.OAM_BIN || 'oam';

function fmtSize(p) {
  const bytes = statSync(p).size;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes} bytes)`;
}

// Fail fast with an actionable message rather than a raw ENOENT spawn error.
try {
  const v = execFileSync(oamBin, ['--version'], { encoding: 'utf-8' }).trim();
  console.log(`using ${v}`);
} catch {
  console.error(
    `Could not run "${oamBin} --version".\n` +
      `Install oam from https://oamjs.org, or set OAM_BIN to its absolute path.\n` +
      `To build without oam, use the Node SEA path instead: node scripts/build-binary.mjs`,
  );
  process.exit(1);
}

mkdirSync(tmpDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

// 1. Bundle to CJS. `oam compile` documents a "pre-bundled JS/CJS entry file",
//    and an ESM bundle genuinely fails: compiling dist/index.js (ESM) produces a
//    binary that dies at run time on `import { createRequire } from "node:module"`.
//    It also only embeds bytecode for the CJS input -- the ESM attempt reported
//    "no bytecode embedded". Same banner/define shape as build-binary.mjs so the
//    two binaries are built from identical source semantics.
await esbuild.build({
  entryPoints: [join(repoRoot, srcEntry)],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  banner: { js: "const __seaImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { __VERSION__: JSON.stringify(version), 'import.meta.url': '__seaImportMetaUrl' },
  external: ['cpu-features'],
  outfile: bundlePath,
});
console.log(`bundle: ${fmtSize(bundlePath)}`);

// 2. Embed it. oam compile handles the carrier + bytecode itself, so there is no
//    equivalent of the Node SEA copy/postject/codesign dance here.
rmSync(outExe, { force: true });
execFileSync(oamBin, ['compile', bundlePath, '--output', outExe], { stdio: 'inherit', cwd: repoRoot });

console.log('');
console.log(`OK  ${outExe}`);
console.log(`    ${fmtSize(outExe)}`);
console.log('');
// oam compile prints this itself, but it is a redistribution obligation and is
// easy to scroll past in CI logs -- restate it at the end where it is read.
console.log('NOTE: this binary embeds oam\'s runtime (V8, ICU and others).');
console.log('      If you redistribute it, ship oam\'s LICENSE, NOTICE and');
console.log('      THIRD_PARTY_LICENSES.md alongside it.');
console.log('');
console.log('Verify with:');
console.log(`    "${outExe}" --version`);
console.log(`    "${outExe}" validate-acl <path-to-acl.json>`);
