#!/usr/bin/env node
// Stage the host-built SEA binary as a named release asset + sha256 sidecar.
//
// build-binary.mjs emits bin/<platform>-<arch>/yaw-mcp(.exe) (host-native --
// Node SEA cannot cross-compile, so each CI matrix leg builds its own). This
// renames that to the public asset name the Scoop/Homebrew manifests point at
// (yaw-mcp-<platform>-<arch>[.exe]) and writes a `<asset>.sha256` sidecar in
// sha256sum format (`<hex>  <asset>`) that Scoop's autoupdate `hash.url` reads.
//
// Pure stdlib; writes only to dist-release/. Run after build-binary.mjs:
//   node scripts/stage-release-asset.mjs

import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const ext = isWin ? '.exe' : '';

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
// Binary name = first `bin` command -- keeps this generic across servers.
const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split('/').pop();
const platformArch = `${process.platform}-${process.arch}`;
const builtExe = join(repoRoot, 'bin', platformArch, `${binName}${ext}`);
const assetName = `${binName}-${platformArch}${ext}`;

const outDir = join(repoRoot, 'dist-release');
const outAsset = join(outDir, assetName);
const outSha = `${outAsset}.sha256`;

mkdirSync(outDir, { recursive: true });
rmSync(outAsset, { force: true });
copyFileSync(builtExe, outAsset);
// Preserve the executable bit on Unix (copyFileSync drops it) so the staged
// asset is runnable for the CI smoke test and after download.
if (!isWin) chmodSync(outAsset, 0o755);

const hex = createHash('sha256').update(readFileSync(outAsset)).digest('hex');
// sha256sum format so `sha256sum -c` and Scoop's hash.url sidecar both parse it.
writeFileSync(outSha, `${hex}  ${assetName}\n`);

console.log(`asset:  ${outAsset}`);
console.log(`sha256: ${hex}`);
// Surfaced as a step output in CI (GITHUB_OUTPUT) for downstream jobs.
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `asset=${assetName}\nsha256=${hex}\n`, { flag: 'a' });
}
