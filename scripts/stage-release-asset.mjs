#!/usr/bin/env node
// Stage a built standalone binary as a named release asset + sha256 sidecar.
//
// build-binary.mjs (Node SEA) emits bin/<platform>-<arch>[-<libc>]/<cmd>[.exe]
// for the build host -- SEA cannot cross-compile, so each target has to be
// built on a matching host. build-binary-oam.mjs emits bin/<target>/<cmd>[.exe]
// where <target> is TAILSCALE_MCP_BINARY_TARGET (default: the host). This
// renames that binary to the public asset name the Scoop/Homebrew manifests
// point at (<cmd>-<platform>-<arch>[.exe]) and writes a `<asset>.sha256`
// sidecar in sha256sum format (`<hex>  <asset>`) that Scoop's autoupdate
// `hash.url` reads.
//
// Linux: the SEA build's `-glibc` directory stages as the plain linux-<arch>
// asset, which is the name update-manifests.mjs points Homebrew at; a `-musl`
// build keeps its suffix so it can never be shipped as the glibc asset.
//
// Pure stdlib; writes only to dist-release/. Run after either build script,
// with the same TAILSCALE_MCP_BINARY_TARGET for a cross-build:
//   node scripts/stage-release-asset.mjs

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");

/**
 * The bin/ subdirectories a build for `target` may have written, in the order
 * to try them. `libc` is the HOST's ("glibc" | "musl" | null): the SEA builder
 * only ever builds for the host, so the libc-suffixed directory is a candidate
 * only when the target is the host.
 */
export function candidateDirs({ target, hostTarget, libc }) {
  if (target === hostTarget && libc) return [`${target}-${libc}`, target];
  return [target];
}

/** Public asset name for a binary found in bin/<dir>/. */
export function assetNameFor({ binName, dir }) {
  const platformArch = dir.replace(/-glibc$/, "");
  const ext = platformArch.startsWith("win32-") ? ".exe" : "";
  return `${binName}-${platformArch}${ext}`;
}

/**
 * Pick the built binary to stage. When more than one candidate exists (an SEA
 * build and an oam build of the same target), the newest wins: it is the one
 * just built, and the other is a leftover.
 */
export function findBuiltBinary({ root, binName, dirs, exists = existsSync, mtimeMs = (p) => statSync(p).mtimeMs }) {
  const found = dirs
    .map((dir) => {
      const ext = dir.startsWith("win32-") ? ".exe" : "";
      return { dir, path: join(root, "bin", dir, `${binName}${ext}`) };
    })
    .filter((c) => exists(c.path));
  if (found.length === 0) return null;
  return found.reduce((a, b) => (mtimeMs(b.path) > mtimeMs(a.path) ? b : a));
}

function hostLibc() {
  if (process.platform !== "linux") return null;
  // Same detection as build-binary.mjs: glibcVersionRuntime is present on glibc
  // and absent on musl.
  return process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl";
}

function main() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  // Binary name = first `bin` command -- keeps this generic across servers.
  const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split("/").pop();
  const hostTarget = `${process.platform}-${process.arch}`;
  // An empty value counts as unset, as it does in build-binary-oam.mjs.
  const target = (process.env.TAILSCALE_MCP_BINARY_TARGET || hostTarget).toLowerCase();
  const dirs = candidateDirs({ target, hostTarget, libc: hostLibc() });
  const built = findBuiltBinary({ root: repoRoot, binName, dirs });
  if (!built) {
    console.error(
      `stage-release-asset: no built binary for ${target}. Looked in:\n` +
        dirs.map((d) => `  bin/${d}/\n`).join("") +
        "Run scripts/build-binary.mjs or scripts/build-binary-oam.mjs first (same TAILSCALE_MCP_BINARY_TARGET).",
    );
    process.exit(1);
  }
  const assetName = assetNameFor({ binName, dir: built.dir });

  const outDir = join(repoRoot, "dist-release");
  const outAsset = join(outDir, assetName);
  const outSha = `${outAsset}.sha256`;

  mkdirSync(outDir, { recursive: true });
  rmSync(outAsset, { force: true });
  copyFileSync(built.path, outAsset);
  // Preserve the executable bit on Unix (copyFileSync drops it) so the staged
  // asset is runnable for a smoke test and after download.
  if (process.platform !== "win32") chmodSync(outAsset, 0o755);

  const hex = createHash("sha256").update(readFileSync(outAsset)).digest("hex");
  // sha256sum format so `sha256sum -c` and Scoop's hash.url sidecar both parse it.
  writeFileSync(outSha, `${hex}  ${assetName}\n`);

  console.log(`binary: ${built.path}`);
  console.log(`asset:  ${outAsset}`);
  console.log(`sha256: ${hex}`);
  // Surfaced as a step output when run under GitHub Actions (GITHUB_OUTPUT).
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `asset=${assetName}\nsha256=${hex}\n`, { flag: "a" });
  }
}

// Run only when executed directly, so a test can import the helpers above.
// Compare REAL paths: reached through a junction or symlink, argv[1] and
// import.meta.url name the same file by different paths.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
}
if (invokedDirectly()) main();
