#!/usr/bin/env node
/**
 * Run biome against a binary that actually works on this host.
 *
 * Everywhere except Windows ARM64 this is a thin passthrough to the platform
 * binary npm installed. It exists for the one host where that binary can be
 * unusable: on Windows ARM64 SOME `@biomejs/cli-win32-arm64` builds crash
 * instead of running. Measured on that host by invoking the arm64 executable
 * directly, with no npm anywhere in the picture: 2.5.4 -- the version this
 * repo installs -- dies with exit 139, while 2.4.16 and 2.5.13 check a source
 * tree normally and return a real pass/fail. The defect is per-version, not
 * permanent; nothing here should be read as "arm64 biome is broken".
 *
 * That still leaves a coin flip on every biome bump, resolved by a binary
 * whose bad outcome is a crash in the middle of a release script. Rather than
 * gamble per version, this host runs the x64 build OF THE SAME VERSION, which
 * works fine under Windows' x64 emulation: same version, same rules, same
 * config, only a different instruction set. Set YAWLABS_BIOME_NATIVE=1 to use
 * the arm64 build anyway.
 *
 * Not a reason this script exists: "the arm64 binary silently skips files".
 * That was asserted here before and it is false -- measured on the same host,
 * `npx biome` and `node_modules/.bin/biome` both exit 0 on a working version
 * and report the full file count. A bad build crashes loudly; it does not
 * quietly check nothing.
 *
 * Why this is a script and not a devDependency: npm refuses to install
 * `@biomejs/cli-win32-x64` on an arm64 host (EBADPLATFORM), which is precisely
 * the situation we are working around, so it cannot be declared normally. The
 * install below passes `--force` for that reason and `--no-save` so the
 * workaround never leaks into package.json.
 *
 * Why it matters here specifically: this repo has no .github/workflows and
 * GitHub Actions is disabled on it, so there is no runner to arbitrate
 * formatting later. `release.sh` says as much -- its CI mode is dormant,
 * because no workflow calls it. Whatever this script reports is the ONLY lint
 * signal that exists before `release.sh` publishes to npm.
 *
 * Escape hatches, in case the platform assumption ages badly:
 *   YAWLABS_BIOME_BIN=<path>   use exactly this binary, skip all detection
 *   YAWLABS_BIOME_NATIVE=1     force the normal platform binary on any host
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const exe = isWindows ? ".exe" : "";

/**
 * Every spawn below is bounded, because `npm run lint` runs UNATTENDED as
 * release.sh step 1 -- an unbounded child there turns a WEDGED release rather
 * than a failed one, with no output to say why. This repo already made that
 * call for its test suite: `npm test` runs `node --test` with
 * `--test-timeout=300000` on exactly this reasoning.
 *
 * Deliberately generous -- these convert an infinite hang into a reported
 * failure, they are not performance budgets. For scale, biome checks this repo
 * in well under a second.
 */
const PROBE_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LINT_TIMEOUT_MS = 10 * 60_000;

/**
 * The biome version to provision: the one this repo actually INSTALLS, read
 * from package-lock.json and falling back to the installed package.
 *
 * This used to read the version out of biome.json's `$schema` URL, and that was
 * a bug. `$schema` pins the schema the CONFIG is validated against; it says
 * nothing about which binary npm put in node_modules, and the two drift apart
 * the moment a biome bump lands without a matching hand-edit to biome.json.
 *
 * This repo is where that gap did real damage. $schema says 2.4.12 while the
 * lockfile installs 2.5.4, so the gate provisioned x64 2.4.12 and reported a
 * clean pass over three genuine correctness/noUnsafeOptionalChaining errors in
 * src/integration.test.ts that 2.5.4 rejects -- and because arm64 2.5.4 is one
 * of the builds that crashes, the alternative reading of the same tree was a
 * release-blocking exit 139. A false pass and a crash, from one stale version
 * string. (Those three errors are fixed; this is why the version source moved.)
 *
 * The lockfile comes first because it is the version npm WILL install, so this
 * resolves correctly even on a tree nobody has installed yet; the installed
 * package.json is the fallback for a checkout without a lockfile.
 */
function installedBiomeVersion() {
  const readJson = (path) => {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };

  const locked = readJson(join(repoRoot, "package-lock.json"))?.packages?.["node_modules/@biomejs/biome"]?.version;
  if (typeof locked === "string" && locked !== "") return locked;

  const installed = readJson(join(repoRoot, "node_modules", "@biomejs", "biome", "package.json"))?.version;
  if (typeof installed === "string" && installed !== "") return installed;

  throw new Error(
    "Could not determine which biome version this repo installs, so the emulated binary\n" +
      'cannot be matched to it. Looked for packages["node_modules/@biomejs/biome"].version in\n' +
      "package-lock.json, then node_modules/@biomejs/biome/package.json -- neither was readable.\n" +
      "Run `npm install` (or `npm ci`) so one of them exists, or set YAWLABS_BIOME_BIN=<path to a\n" +
      "working biome> to bypass version resolution entirely.",
  );
}

/** The platform binary npm installed for THIS host, or null when absent. */
function nativeBinary() {
  const pkg = `@biomejs/cli-${process.platform}-${process.arch}`;
  const direct = join(repoRoot, "node_modules", ...pkg.split("/"), `biome${exe}`);
  if (existsSync(direct)) return direct;
  // musl and other suffixed variants (cli-linux-x64-musl) don't match the plain
  // name above; fall back to the shim npm links, which is correct everywhere the
  // native binary is not itself broken.
  const shim = join(repoRoot, "node_modules", ".bin", isWindows ? "biome.cmd" : "biome");
  return existsSync(shim) ? shim : null;
}

/**
 * Resolve npm's own CLI entry point so the install below can be spawned through
 * `node` with NO shell.
 *
 * Both halves of that matter on Windows. `npm` on PATH is `npm.cmd`, and
 * spawning a `.cmd` with `shell: false` throws EINVAL on Node 22 -- but turning
 * the shell ON makes cmd.exe re-split the argv on whitespace, so a repo path
 * containing a space arrives as two arguments and the second is read as a
 * package name. (Measured: `--prefix "C:\a b\c"` becomes
 * `["--prefix","C:a","bc"]`.) Spawning node with npm-cli.js sidesteps both.
 */
function npmCliPath() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Provision (once per version) and return the emulated x64 binary. Installs
 * into node_modules/.cache, which is already gitignored via node_modules/ and
 * is wiped by `npm ci` -- the next run simply re-installs it.
 *
 * The version is part of the DIRECTORY NAME, not just the install argument.
 * Keying the cache on presence alone would silently reuse a stale binary after
 * a biome bump -- defeating the whole point of sourcing the version from the
 * lockfile, since the repo would install one version while the checking was
 * done by another. A version-stamped path also means an install interrupted
 * midway leaves a directory that the NEXT bump abandons rather than trusts; the
 * explicit re-verify below covers the same-version case.
 */
function emulatedX64Binary(version) {
  const prefix = join(repoRoot, "node_modules", ".cache", `biome-x64-${version}`);
  const bin = join(prefix, "node_modules", "@biomejs", "cli-win32-x64", "biome.exe");

  // Presence is not validity: an install killed partway through leaves a
  // truncated .exe that would otherwise be cached forever. Confirm the binary
  // actually runs and reports the version we asked for before trusting it.
  if (existsSync(bin)) {
    // Bounded: a corrupt-but-executable binary, or one stalled inside the x64
    // emulation layer, would otherwise hang every lint invocation forever. A
    // timeout leaves `status` null, which fails the check below and routes into
    // the discard path -- the right answer for a binary that cannot answer
    // `--version` in 30 seconds.
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
    if (probe.status === 0 && String(probe.stdout).includes(version)) return bin;
    // DISCARD the tree rather than reinstalling over it. `npm i` treats an
    // already-present package as satisfied -- even with --force -- so installing
    // on top of a truncated binary is a silent no-op that leaves the corruption
    // in place and re-runs npm on every subsequent invocation. Measured: a
    // 7-byte biome.exe survived the reinstall and lint kept failing.
    //
    // Bounded on purpose: `prefix` is a version-stamped directory this script
    // created under the repo's own node_modules/.cache, never a user-supplied
    // or shared path.
    console.error(`[lint] cached biome at ${bin} is unusable or not ${version}; discarding and re-provisioning`);
    rmSync(prefix, { recursive: true, force: true });
  }

  const npmCli = npmCliPath();
  if (!npmCli) {
    throw new Error(
      "Could not locate npm-cli.js next to this node install, so the x64 biome cannot be\n" +
        "provisioned without a shell (see npmCliPath). Set YAWLABS_BIOME_BIN=<path to a\n" +
        "working biome> instead.",
    );
  }

  console.error(`[lint] routing around the win32-arm64 biome build; provisioning x64 ${version} under emulation`);
  const install = spawnSync(
    process.execPath,
    [npmCli, "i", "--no-save", "--force", "--prefix", prefix, `@biomejs/cli-win32-x64@${version}`],
    { stdio: "inherit", shell: false, timeout: INSTALL_TIMEOUT_MS },
  );
  if (install.status !== 0 || !existsSync(bin)) {
    // Distinguish the two failures: a registry stall and a genuine install
    // error need different responses, and "npm exited null" says neither.
    const why =
      install.error && install.error.code === "ETIMEDOUT"
        ? `npm did not finish within ${INSTALL_TIMEOUT_MS / 1000}s and was killed`
        : `npm exited ${install.status}`;
    throw new Error(
      `Failed to provision @biomejs/cli-win32-x64@${version} (${why}).\n` +
        "This repo has no CI, so there is no other lint signal. Fix the install, or set\n" +
        "YAWLABS_BIOME_BIN=<path to a working biome> to point this script at one.",
    );
  }
  return bin;
}

function resolveBinary() {
  if (process.env.YAWLABS_BIOME_BIN) return process.env.YAWLABS_BIOME_BIN;

  // Windows ARM64 takes the emulated x64 path by default -- not because the
  // arm64 build is permanently broken (it is not; see the header), but because
  // whether THIS version of it runs is a per-version coin flip, and a lint gate
  // should not change meaning when a bump lands on a bad build.
  const routeThroughX64 = isWindows && process.arch === "arm64" && process.env.YAWLABS_BIOME_NATIVE !== "1";
  if (routeThroughX64) return emulatedX64Binary(installedBiomeVersion());

  const native = nativeBinary();
  if (!native) {
    throw new Error("No biome binary found in node_modules -- run `npm install` first.");
  }
  return native;
}

let binary;
try {
  binary = resolveBinary();
} catch (err) {
  console.error(`[lint] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Exit with biome's own status so `npm run lint` stays a usable gate, and so a
// non-zero result is a real finding rather than this wrapper's opinion.
//
// `shell` is enabled ONLY for a .cmd/.bat target: spawning one with shell:false
// throws EINVAL on Node 22 (the `.bin/biome.cmd` shim fallback, and any
// YAWLABS_BIOME_BIN pointing at a batch file). Everything else -- including
// every normal .exe path -- stays shell-free so arguments are passed verbatim.
const needsShell = /\.(cmd|bat)$/i.test(binary);
const run = spawnSync(binary, process.argv.slice(2), { stdio: "inherit", shell: needsShell, timeout: LINT_TIMEOUT_MS });
// Checked BEFORE the generic error and crash branches: a timeout kill sets
// `signal` to SIGTERM, which the crash check below would otherwise report as
// the known native-binary crash -- the wrong diagnosis entirely.
if (run.error && run.error.code === "ETIMEDOUT") {
  console.error(
    `[lint] biome did not finish within ${LINT_TIMEOUT_MS / 60_000} minutes and was killed (${binary}). ` +
      "That is far past a normal run, so treat it as a hung binary rather than a slow one.",
  );
  process.exit(1);
}
if (run.error) {
  console.error(`[lint] could not execute ${binary}: ${run.error.message}`);
  process.exit(1);
}
// A native crash surfaces differently by platform: POSIX reports a signal,
// while Windows reports an NTSTATUS as the exit CODE and leaves signal null
// (measured: the arm64 biome access violation is status 3221225477 / 0xC0000005,
// signal null). Checking only `signal` meant this diagnostic could never fire on
// the one host it was written for.
const crashed = run.signal !== null || (run.status ?? 0) >= 0xc0000000;
if (crashed) {
  const how = run.signal ? `killed by ${run.signal}` : `crashed with 0x${(run.status >>> 0).toString(16)}`;
  console.error(
    `[lint] biome ${how} (${binary}).\n` +
      "Some Windows ARM64 biome builds crash exactly like this -- 2.5.4, the version this repo\n" +
      "installs, is one of them, while 2.4.16 and 2.5.13 are not -- which is why this script\n" +
      "routes that host through the x64 build by default. Check the YAWLABS_BIOME_BIN /\n" +
      "YAWLABS_BIOME_NATIVE overrides.",
  );
  process.exit(1);
}
process.exit(run.status ?? 1);
