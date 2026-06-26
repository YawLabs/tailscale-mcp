#!/usr/bin/env node
// Build a self-contained single-file binary of the @yawlabs/mcp sidecar.
//
// Strategy: esbuild bundles src/index.ts + ALL its dependencies (including
// the externals tsup leaves out -- @modelcontextprotocol/sdk and undici)
// into ONE CommonJS file with zero remaining node_modules resolution, then
// Node's Single Executable Application (SEA) feature embeds that bundle as a
// resource inside a copy of the node binary. The result runs with no Node,
// no node_modules, and no PATH dependency.
//
// Why not `deno compile`? Deno was not installed on the build host at authoring
// time (`deno --version` -> command not found). The project itself is fully
// Deno-compatible in principle (clean ESM, no native addons), but the node:
// builtin imports in the bundle are bare (`fs`, not `node:fs`), which Deno
// rejects without a compat shim. Node SEA needs no such rewrite and ships with
// the Node already on the box, so it is the zero-friction path here. See
// BINARY_DISTRIBUTION.md for the deno/bun fallbacks.
//
// This script ONLY reads node_modules (via esbuild's resolver) and writes to
// build-tmp/ and bin/<platform>-<arch>/. It does NOT mutate package.json,
// package-lock.json, src/, or node_modules, and it never runs `npm install`.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { inject } from 'postject';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
const { version } = pkg;
// Binary name = the package's first `bin` command, so this script is
// copy-paste generic across @yawlabs/* servers -- no per-repo rename.
const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split('/').pop();
// Bundle the SOURCE behind the bin's dist entry (src/index.ts, src/server.ts,
// src/runner.ts, ...) so this works regardless of the server's entry filename.
const binEntry = Object.values(pkg.bin ?? {})[0] ?? pkg.main ?? 'dist/index.js';
const srcEntry = binEntry.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.[cm]?js$/, '.ts');

const platformDir = `${process.platform}-${process.arch}`;
const binDir = join(repoRoot, 'bin', platformDir);
const tmpDir = join(repoRoot, 'build-tmp');
const bundlePath = join(tmpDir, 'sea-bundle.cjs');
const blobPath = join(tmpDir, 'sea-bundle.blob');
const exeName = isWin ? `${binName}.exe` : binName;
const outExe = join(binDir, exeName);

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
}

function fmtSize(p) {
  const bytes = statSync(p).size;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes} bytes)`;
}

mkdirSync(tmpDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

// 1. Bundle everything into one CJS file (externals included) via esbuild's
// JS API. NOT the CLI bin: on Linux/macOS esbuild swaps node_modules/esbuild/
// bin/esbuild for the NATIVE binary (only Windows keeps it a JS shim), so
// `node bin/esbuild` would feed a binary to the JS parser and die. The API
// also takes the __VERSION__ define as data -- no shell-quoting games.
await esbuild.build({
  entryPoints: [join(repoRoot, srcEntry)],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // esbuild leaves import.meta.url EMPTY in cjs output, so a server that reads
  // it (e.g. createRequire(import.meta.url) to find package.json) crashes at
  // load with createRequire(undefined). Polyfill it to the carrier's own path
  // (__filename is the executable in a SEA). Version reads should still prefer
  // the __VERSION__ define; this is the safety net for everything else.
  banner: { js: "const __seaImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { __VERSION__: JSON.stringify(version), 'import.meta.url': '__seaImportMetaUrl' },
  // Optional native addons some servers pull transitively (ssh2 -> cpu-features)
  // are require()'d inside try/catch; mark them external so esbuild doesn't
  // choke on the .node binary -- they degrade gracefully when absent.
  external: ['cpu-features'],
  outfile: bundlePath,
});
console.log(`bundle: ${fmtSize(bundlePath)}`);

// 2. Generate the SEA blob from sea-config.json.
run(process.execPath, ['--experimental-sea-config', 'sea-config.json']);
console.log(`blob:   ${fmtSize(blobPath)}`);

// 3. Copy the running node binary as the carrier.
rmSync(outExe, { force: true });
copyFileSync(process.execPath, outExe);
// copyFileSync does not reliably carry the executable bit on Unix; the macOS
// exec-check below and the CI smoke test both need to run this file.
if (!isWin) chmodSync(outExe, 0o755);

// macOS: strip the carrier node binary's existing signature BEFORE injecting,
// so postject doesn't leave a CORRUPT signature (which is worse than none --
// arm64 SIGKILLs a bad-sig binary at exec). We ad-hoc re-sign after step 4.
// Best-effort: an already-unsigned carrier makes `--remove-signature` exit
// non-zero, which must NOT abort the build -- the --force re-sign is what
// actually matters.
if (process.platform === 'darwin') {
  try {
    run('codesign', ['--remove-signature', outExe]);
  } catch {
    console.log('(carrier had no signature to remove -- continuing)');
  }
}

// 4. Inject the SEA blob via postject's JS API (pinned devDep). NOT the npx
//    CLI: locating npx-cli.js off the node binary is Windows-only (Unix keeps
//    npm under ../lib/node_modules, not ./node_modules), and npx-on-demand
//    adds a network dependency to every CI build. The API is cross-platform.
await inject(outExe, 'NODE_SEA_BLOB', readFileSync(blobPath), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
});
console.log('injection done');

// 5. macOS: ad-hoc re-sign AFTER injection. Apple Silicon refuses to exec a
//    Mach-O with no/invalid signature ("killed: 9"); `--sign -` is the free
//    ad-hoc identity (no cert, no notarization). Distribution is via the
//    Homebrew TAP (a formula), whose curl fetch sets no com.apple.quarantine,
//    so Gatekeeper never blocks it -- ad-hoc is sufficient. `--force` replaces
//    any residual signature; `--timestamp=none` keeps it offline/reproducible.
if (process.platform === 'darwin') {
  run('codesign', ['--sign', '-', '--force', '--timestamp=none', outExe]);
  run('codesign', ['--verify', '--verbose', outExe]);
  // --verify proves the signature is intact, NOT that the binary launches.
  // arm64 SIGKILLs a bad-sig Mach-O only at exec, so actually run it -- this
  // is the real check the whole remove/re-sign dance defends. (CI also smoke-
  // tests, but a standalone `node scripts/build-binary.mjs` on a Mac should
  // catch a non-launching binary too.)
  run(outExe, ['--version']);
}

console.log('');
console.log(`OK  ${outExe}`);
console.log(`    ${fmtSize(outExe)}`);
console.log('');
console.log('Verify with:');
console.log(`    "${outExe}" --version`);
console.log(`    "${outExe}" doctor --json`);
