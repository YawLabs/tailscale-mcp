#!/usr/bin/env node
// Stage a built standalone binary as a named release asset + sha256 sidecar.
//
// build-binary-oam.mjs emits bin/<target>/<cmd>[.exe], where <target> is
// TAILSCALE_MCP_BINARY_TARGET (default: the host). This renames that binary to
// the public asset name the Scoop/Homebrew manifests point at
// (<cmd>-<platform>-<arch>[.exe]) and writes a `<asset>.sha256` sidecar in
// sha256sum format (`<hex>  <asset>`) that Scoop's autoupdate `hash.url` reads.
//
// Pure stdlib; writes only to dist-release/. Run after the build script, with
// the same TAILSCALE_MCP_BINARY_TARGET for a cross-build:
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
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");

/** Public asset name for the binary built for `target` (bin/<target>/). */
export function assetNameFor({ binName, target }) {
  const ext = target.startsWith("win32-") ? ".exe" : "";
  return `${binName}-${target}${ext}`;
}

/** The binary build-binary-oam.mjs wrote for `target`, or null when absent. */
export function findBuiltBinary({ root, binName, target, exists = existsSync }) {
  const ext = target.startsWith("win32-") ? ".exe" : "";
  const path = join(root, "bin", target, `${binName}${ext}`);
  return exists(path) ? { dir: target, path } : null;
}

function main() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  // Binary name = first `bin` command -- keeps this generic across servers.
  const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split("/").pop();
  const hostTarget = `${process.platform}-${process.arch}`;
  // An empty value counts as unset, as it does in build-binary-oam.mjs.
  const target = (process.env.TAILSCALE_MCP_BINARY_TARGET || hostTarget).toLowerCase();
  const built = findBuiltBinary({ root: repoRoot, binName, target });
  if (!built) {
    console.error(
      `stage-release-asset: no built binary for ${target}. Looked in bin/${target}/.\n` +
        "Run scripts/build-binary-oam.mjs first (same TAILSCALE_MCP_BINARY_TARGET).",
    );
    process.exit(1);
  }
  const assetName = assetNameFor({ binName, target });

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
