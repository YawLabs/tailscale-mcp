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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import {
  DEFAULT_KEYS_DIR,
  findSshKeygen,
  normalizeTag,
  parseRanges,
  predatesSigning,
  verifyManifest,
  verifyPresigningSums,
} from "./lib/oam-release-verify.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
const { version } = pkg;
// Derived from package.json so this stays copy-paste generic across @yawlabs/*
// servers, matching build-binary.mjs.
const binName = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.split("/").pop();
// Resolve the TypeScript entry directly rather than deriving it from `bin`.
// `bin` points at the oam runtime LAUNCHER (bin/<name>.mjs), so the old
// derivation produced `bin/<name>.ts` -- a path that has never existed -- and
// esbuild failed with "Could not resolve". Prefer the conventional source
// entry, falling back to the dist path for a repo that does not use it.
const distEntry = pkg.main ?? "dist/index.js";
const srcEntry = existsSync(join(repoRoot, "src/index.ts"))
  ? "src/index.ts"
  : distEntry
      .replace(/^\.\//, "")
      .replace(/^dist\//, "src/")
      .replace(/\.[cm]?js$/, ".ts");

// The target being built for. Everything downstream -- the bin/<platform-arch>/
// directory, the .exe suffix, the carrier -- keys off THIS, not the build host,
// because `oam compile --carrier` (oam 0.8.3+) can produce a binary for a
// platform we are not running on. Deriving the output path from the host
// instead would file a cross-built ELF as bin/win32-arm64/<name>.exe and ship
// it as the Windows asset.
const HOST_TARGET = `${process.platform}-${process.arch}`;
const TARGET = (process.env.TAILSCALE_MCP_BINARY_TARGET ?? HOST_TARGET).toLowerCase();
const isCross = TARGET !== HOST_TARGET;
const targetIsWin = TARGET.startsWith("win32-");

const platformDir = TARGET;
const binDir = join(repoRoot, "bin", platformDir);
const tmpDir = join(repoRoot, "build-tmp");
// .cjs extension is load-bearing -- see the CJS note on the bundle step below.
const bundlePath = join(tmpDir, "oam-bundle.cjs");
const outExe = join(binDir, targetIsWin ? `${binName}.exe` : binName);

const oamBin = process.env.OAM_BIN || "oam";

function fmtSize(p) {
  const bytes = statSync(p).size;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes} bytes)`;
}

// Fail fast with an actionable message rather than a raw ENOENT spawn error.
try {
  const v = execFileSync(oamBin, ["--version"], { encoding: "utf-8" }).trim();
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
  platform: "node",
  format: "cjs",
  target: "node20",
  banner: { js: "const __seaImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { __VERSION__: JSON.stringify(version), "import.meta.url": "__seaImportMetaUrl" },
  external: ["cpu-features"],
  outfile: bundlePath,
});
console.log(`bundle: ${fmtSize(bundlePath)}`);

// 2. Embed it. oam compile handles the carrier + bytecode itself, so there is no
//    equivalent of the Node SEA copy/postject/codesign dance here.
rmSync(outExe, { force: true });
// ---------------------------------------------------------------- cross-build
//
// `oam compile` embeds the RUNNING oam as its carrier, so without help it can
// only ever produce a binary for the build host. oam 0.8.3 added `--carrier`:
// the embedded payload is platform-independent (appending to an executable's
// tail is tolerated identically by PE, ELF and Mach-O), so only the carrier is
// target-specific. Point `--carrier` at another target's oam release binary and
// one machine can ship every target.
//
//   TAILSCALE_MCP_BINARY_TARGET=linux-x64 node scripts/build-binary-oam.mjs
//
// The carrier is fetched from the published oam release and verified against
// that release's SIGNED manifest. That check is not optional: the carrier becomes
// the bulk of a binary we then ship, so an unverified download would be a supply
// chain hole opened by our own build script. From v0.18.0 every oam release
// carries RELEASE-MANIFEST (its tag plus SHA256SUMS) and RELEASE-MANIFEST.sig,
// verified here with `ssh-keygen -Y verify` against oam's release keys, vendored
// in scripts/oam-release-keys/ (see scripts/lib/oam-release-verify.mjs). The
// carrier's sha256 is taken from the manifest; a SHA256SUMS fetched from the
// same place as the binary proves only that the two were uploaded together, so
// it is consulted only for an OAM_VERSION older than v0.18.0, released before
// signing existed, and then only when it hashes to the digest pinned for that
// tag in scripts/oam-release-keys/presigning-sums. A bad signature, a missing manifest, a missing or mismatched
// entry, or no ssh-keygen able to verify aborts rather than warning.
const OAM_ASSETS = {
  "win32-x64": "oam-x86_64-pc-windows-msvc.exe",
  "win32-arm64": "oam-aarch64-pc-windows-msvc.exe",
  "darwin-arm64": "oam-aarch64-apple-darwin",
  "darwin-x64": "oam-x86_64-apple-darwin",
  "linux-x64": "oam-x86_64-unknown-linux-gnu",
};

const RELEASES = "https://github.com/YawLabs/oam/releases";

function die(message) {
  console.error(`build-binary-oam: ${message}`);
  process.exit(1);
}

async function fetchBytes(url, what) {
  const res = await fetch(url);
  if (!res.ok) die(`downloading ${what} failed (HTTP ${res.status}); refusing to use an unverified carrier`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The expected sha256 of `asset`, and the tag it belongs to, from a verified
 * source: the signed manifest, or -- only for a tag that predates signing --
 * that release's SHA256SUMS.
 */
async function expectedSha256(asset, requested) {
  const ranges = parseRanges(readFileSync(join(DEFAULT_KEYS_DIR, "ranges"), "utf-8"));
  if (requested !== "latest" && predatesSigning(ranges, requested)) {
    // No manifest to verify: the SHA256SUMS is trusted only when it hashes to
    // the digest pinned for this tag in the vendored presigning-sums.
    const bytes = await fetchBytes(`${RELEASES}/download/${requested}/SHA256SUMS`, "SHA256SUMS");
    let sums;
    try {
      sums = verifyPresigningSums({ sums: bytes, tag: requested });
    } catch (err) {
      die(`${err instanceof Error ? err.message : String(err)}; refusing to use an unverified carrier`);
    }
    console.log(`  SHA256SUMS ok (${requested} predates signing; matches its pinned digest)`);
    return { tag: requested, want: sums.get(asset), source: "the pinned pre-signing SHA256SUMS" };
  }
  // `latest` is resolved through the manifest itself: it says which tag it is,
  // and the binary is then fetched from that tag's own download path, so a
  // release published between the two downloads cannot mix them.
  const base = requested === "latest" ? `${RELEASES}/latest/download` : `${RELEASES}/download/${requested}`;
  console.log(`> fetch ${base}/RELEASE-MANIFEST(.sig)`);
  const manifest = await fetchBytes(`${base}/RELEASE-MANIFEST`, "RELEASE-MANIFEST");
  const sig = await fetchBytes(`${base}/RELEASE-MANIFEST.sig`, "RELEASE-MANIFEST.sig");
  let verified;
  try {
    verified = verifyManifest({
      manifest,
      sig,
      expectedTag: requested === "latest" ? null : requested,
      sshKeygen: findSshKeygen(),
    });
  } catch (err) {
    die(`${err instanceof Error ? err.message : String(err)}; refusing to use an unverified carrier`);
  }
  console.log(`  RELEASE-MANIFEST ok (${verified.tag}, signed by ${verified.principal})`);
  return { tag: verified.tag, want: verified.sums.get(asset), source: "the signed RELEASE-MANIFEST" };
}

/** Fetch the published oam release binary for `target`, verified as above. */
async function fetchOamCarrier(target) {
  const asset = OAM_ASSETS[target];
  if (!asset) {
    die(`no oam release asset known for target '${target}'.\nKnown targets: ${Object.keys(OAM_ASSETS).join(", ")}`);
  }
  // OAM_VERSION pins the release (v0.18.0 or 0.18.0); default tracks latest.
  // Pin it in CI so a rebuild of an old tag does not silently acquire a newer
  // runtime.
  const raw = process.env.OAM_VERSION ?? "latest";
  const requested = raw === "latest" ? raw : normalizeTag(raw);
  if (!requested) die(`OAM_VERSION=${raw} is not a vX.Y.Z tag`);

  const { tag, want, source } = await expectedSha256(asset, requested);
  if (!want) die(`${asset} has no entry in ${source}; refusing to use an unverified carrier`);

  const url = `${RELEASES}/download/${tag}/${asset}`;
  console.log(`> fetch ${url}`);
  const bytes = await fetchBytes(url, asset);
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) die(`SHA256 mismatch for ${asset} (${source})\n  expected ${want}\n  got      ${got}`);
  const dest = join(tmpDir, asset);
  writeFileSync(dest, bytes);
  console.log(`  sha256 ok against ${source} (${got.slice(0, 16)}...)`);
  // The downloaded asset is not marked executable on POSIX, and oam has to be
  // able to read it as a carrier regardless -- chmod keeps it usable if someone
  // reaches for it directly.
  try {
    chmodSync(dest, 0o755);
  } catch {}
  return dest;
}

const carrierArgs = isCross ? ["--carrier", await fetchOamCarrier(TARGET)] : [];
execFileSync(oamBin, ["compile", bundlePath, "--output", outExe, ...carrierArgs], {
  stdio: "inherit",
  cwd: repoRoot,
});
if (isCross) {
  // Building it is proven for every target; RUNNING it is only proven where we
  // can execute it. Say which one happened rather than implying both.
  console.log(`NOTE: cross-built for ${TARGET} -- not executed here. Smoke it on that target.`);
}

console.log("");
console.log(`OK  ${outExe}`);
console.log(`    ${fmtSize(outExe)}`);
console.log("");
// oam compile prints this itself, but it is a redistribution obligation and is
// easy to scroll past in CI logs -- restate it at the end where it is read.
console.log("NOTE: this binary embeds oam's runtime (V8, ICU and others).");
console.log("      If you redistribute it, ship oam's LICENSE, NOTICE and");
console.log("      THIRD_PARTY_LICENSES.md alongside it.");
console.log("");
console.log("Verify with:");
console.log(`    "${outExe}" --version`);
console.log(`    "${outExe}" validate-acl <path-to-acl.json>`);
