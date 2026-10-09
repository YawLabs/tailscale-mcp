#!/usr/bin/env node
/**
 * Is the oam floor current, and does the whole repo agree on what it is?
 *
 * The policy is that this server is verified on ONE oam release at a time, and
 * `OAM_MIN` in bin/tailscale-mcp.mjs is what enforces it: the launcher refuses to serve
 * on anything older. Two things go wrong with that by hand, and both have.
 *
 * DRIFT. The floor is quoted in prose and in test fixtures as well as in the
 * constant -- README's "Running on oam.js" section, the launcher's own comments
 * and diagnostics, and launcher.test.ts's floor assertion and expected stderr. A
 * bump that misses one leaves the docs describing a floor the code does not have.
 * It has happened in the sibling aws-mcp, whose copy of this script this is. This
 * half needs no network and is checked on every `npm test` through
 * src/oam-floor.test.ts, which is what makes it gate a release (release.sh runs
 * the suite) without anyone remembering to run anything.
 *
 * STALENESS. oam keeps shipping, and "latest" moves faster than a release cycle:
 * the floor is stale again the moment upstream publishes. This half needs the
 * network, so it lives here and runs from release.sh rather than from the unit
 * suite.
 *
 * Usage:
 *   node scripts/check-oam-floor.mjs              both checks
 *   node scripts/check-oam-floor.mjs --offline    drift only, no network
 *   node scripts/check-oam-floor.mjs --root DIR   check that tree (for tests)
 *
 * Exit 1 on drift, always -- an inconsistent repo is a bug with no upside.
 * Exit 1 when the floor is behind the latest release, UNLESS
 * TAILSCALE_MCP_ALLOW_STALE_OAM=1, which is the deliberate, visible way to ship a
 * release anyway. Exit 0 when the network is unavailable: a checker that turns an
 * offline machine into a failed release would just get switched off.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const OFFLINE = args.includes("--offline");
const rootFlag = args.indexOf("--root");
const REPO_ROOT =
  rootFlag !== -1 && args[rootFlag + 1]
    ? resolve(args[rootFlag + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");

const OAM_RELEASES_API = "https://api.github.com/repos/YawLabs/oam/releases/latest";
const FETCH_TIMEOUT_MS = 10_000;

/** Files that quote the floor, with the line-level rules applied below. */
const SCANNED = ["bin/tailscale-mcp.mjs", "README.md", "src/launcher.test.ts"];

/**
 * A line is making a claim ABOUT the floor when it carries one of these. Chosen
 * from how the floor is actually phrased in this repo rather than invented
 * (X.Y.Z standing for the floor): "X.Y.Z or newer", "older than X.Y.Z",
 * "oam X.Y.Z is the minimum", "the current X.Y.Z floor", and the constant itself.
 */
const FLOOR_CLAIM = /or newer|older than|is the minimum|floor|OAM_MIN/i;

/**
 * ...and it has to be about OAM. Without this the scan flags other dependencies'
 * versions -- Node's floor ("Node.js 20.11+", "needs Node 20.11.0 or newer") and
 * the `tailscale` CLI's -- which share the same phrasing. aws-mcp's first run of
 * this check produced five such false positives against its AWS CLI lines, which
 * is how a checker gets switched off.
 */
const ABOUT_OAM = /\boam\b|OAM_MIN|OAM_BIN/i;

/**
 * ...unless the line is talking about the PAST, in which case an old version on
 * it is the point. Every one of these is a real sentence in the repo: the startup
 * numbers "taken with oam 0.8.2, long before the current floor", the sandbox note
 * "re-measured against oam X.Y.Z", and the launcher comment about a bug where it
 * "bound to 0.9.0" despite a newer oam being on PATH.
 */
const HISTORICAL = /taken with|re-measured|long before|used to|bound to|before 0\.9\.0/i;

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/g;

/**
 * The one version a floor claim may carry that is not the floor: the host's, in
 * the launcher's diagnostic "this process is oam <host>, older than <floor>".
 */
const HOST_VERSION = /\bis oam \d+\.\d+\.\d+, older than/g;

export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** The source of truth: `const OAM_MIN = [x, y, z];` in the launcher. */
export function readFloor(root) {
  const text = readFileSync(join(root, "bin/tailscale-mcp.mjs"), "utf8");
  const m = /const OAM_MIN = \[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(text);
  if (!m) throw new Error("could not find `const OAM_MIN = [x, y, z]` in bin/tailscale-mcp.mjs");
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Every floor claim in the repo that names a version other than the floor.
 *
 * Backslashes are stripped before matching because launcher.test.ts states the
 * floor inside a regex literal (`older than X\.Y\.Z`), and that is a floor claim
 * like any other -- it is asserting the launcher's own diagnostic.
 */
export function findDrift(root, floor) {
  const want = floor.join(".");
  const problems = [];
  for (const rel of SCANNED) {
    let text;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue; // a tree without this file is not this check's business
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!FLOOR_CLAIM.test(raw) || !ABOUT_OAM.test(raw) || HISTORICAL.test(raw)) continue;
      const line = raw.replaceAll("\\", "");
      // A HOST version beside the floor is not a floor claim: "this process is oam
      // 0.9.0, older than X.Y.Z" names the oam that was found AND the floor, and
      // both belong there. Only that one token is set aside. This used to skip any
      // line that named the floor, which passed a table row holding "X.Y.Z or
      // newer" beside a stale "older than <old floor>" -- the README's env-var
      // rows, after the 0.17.0 bump.
      const claims = line.replace(HOST_VERSION, "is oam <host>, older than");
      for (const m of claims.matchAll(VERSION_RE)) {
        if (m[0] !== want) {
          problems.push({ file: rel, line: i + 1, found: m[0], text: raw.trim().slice(0, 110) });
        }
      }
    }
  }
  return problems;
}

/**
 * The launcher's floor and the test that pins it, compared as arrays rather than
 * as text. This is the one pair that must match exactly, and the assertion in
 * launcher.test.ts is deliberately a floor-pin, so a bump that misses it means the
 * suite is asserting the old floor.
 *
 * This repo's launcher.test.ts names the extracted constant OAM_MIN rather than
 * `floor`, so either spelling is accepted.
 */
export function findFloorAssertionMismatch(root, floor) {
  let text;
  try {
    text = readFileSync(join(root, "src/launcher.test.ts"), "utf8");
  } catch {
    return null;
  }
  const m = /assert\.deepEqual\((?:floor|OAM_MIN), \[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\)/.exec(text);
  if (!m) return "src/launcher.test.ts no longer pins the floor with assert.deepEqual(OAM_MIN, [x, y, z])";
  const pinned = [Number(m[1]), Number(m[2]), Number(m[3])];
  return compareVersions(pinned, floor) === 0
    ? null
    : `src/launcher.test.ts pins the floor at ${pinned.join(".")}, but OAM_MIN is ${floor.join(".")}`;
}

async function fetchLatestOam() {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const headers = { accept: "application/vnd.github+json", "user-agent": "tailscale-mcp-floor-check" };
  // A token is not required for a public release read, but use one when the
  // environment already has it: unauthenticated GitHub API calls are rate-limited
  // per IP, and a release script is exactly when that bites.
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(OAM_RELEASES_API, { headers, signal });
  if (!res.ok) throw new Error(`GitHub API answered ${res.status}`);
  const body = await res.json();
  const version = parseVersion(String(body.tag_name ?? ""));
  if (!version) throw new Error(`could not read a version from tag_name=${JSON.stringify(body.tag_name)}`);
  return { version, tag: body.tag_name };
}

async function main() {
  const floor = readFloor(REPO_ROOT);
  console.log(`oam floor (OAM_MIN in bin/tailscale-mcp.mjs): ${floor.join(".")}`);

  let failed = false;

  const mismatch = findFloorAssertionMismatch(REPO_ROOT, floor);
  if (mismatch) {
    console.error(`DRIFT: ${mismatch}`);
    failed = true;
  }

  const drift = findDrift(REPO_ROOT, floor);
  if (drift.length > 0) {
    console.error(`DRIFT: ${drift.length} floor claim(s) name a version other than ${floor.join(".")}:`);
    for (const d of drift) console.error(`  ${d.file}:${d.line}  says ${d.found}  |  ${d.text}`);
    console.error("Update them, or reword the line if it is describing the past (see HISTORICAL in this script).");
    failed = true;
  } else if (!mismatch) {
    console.log(`  no drift: every floor claim in ${SCANNED.join(", ")} agrees`);
  }

  if (!OFFLINE) {
    try {
      const latest = await fetchLatestOam();
      const cmp = compareVersions(floor, latest.version);
      if (cmp < 0) {
        console.error(`STALE: oam ${latest.tag} is published and the floor is ${floor.join(".")}.`);
        console.error("  The policy is one verified release at a time, so bump OAM_MIN, re-verify on it");
        console.error(
          "  (full MCP handshake plus the TAILSCALE_MCP_SANDBOX=1 check), and update the docs and fixtures.",
        );
        if (process.env.TAILSCALE_MCP_ALLOW_STALE_OAM === "1") {
          console.error("  TAILSCALE_MCP_ALLOW_STALE_OAM=1 is set -- continuing anyway.");
        } else {
          console.error("  Set TAILSCALE_MCP_ALLOW_STALE_OAM=1 to release on the old floor deliberately.");
          failed = true;
        }
      } else if (cmp > 0) {
        // Not an error: a floor ahead of the latest published release is what a
        // pre-release or a locally built oam looks like, and the launcher's own
        // behaviour (serve at or above the floor) is unaffected.
        console.log(`  floor is AHEAD of the latest published release (${latest.tag}) -- prerelease or local build`);
      } else {
        console.log(`  current: matches the latest oam release (${latest.tag})`);
      }
    } catch (err) {
      // Deliberately not a failure. See the header.
      console.log(`  staleness not checked: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  process.exit(failed ? 1 : 0);
}

// Only run when invoked directly, so the helpers above stay importable.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
