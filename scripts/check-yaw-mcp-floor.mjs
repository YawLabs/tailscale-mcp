#!/usr/bin/env node
/**
 * Does this repo agree on the Yaw MCP release it is tested with, and is that
 * release still the latest?
 *
 * Modelled on scripts/check-oam-floor.mjs (same CLI shape, same exit-code split),
 * but this floor is documentation, not runtime: nothing in the server or the
 * launcher reads it. It records two facts about the Yaw MCP release this server
 * is tested with, and both live in the constants below:
 *
 *   YAW_MCP_MIN               the @yawlabs/mcp version README.md names as the
 *                             floor ("Tested with Yaw MCP X.Y.Z or newer.").
 *   YAW_MCP_COMPLIANCE_RANGE  the @yawlabs/mcp-compliance range that release pins
 *                             in its dependencies -- the grader yaw-mcp itself
 *                             uses, and so the one a devDependency on it must
 *                             grade with. tailscale-mcp has no such devDependency
 *                             today, so check (a) below is skipped here -- it
 *                             stays in so adding one on another range is caught.
 *                             Read it with `npm view @yawlabs/mcp@<min> dependencies`.
 *
 * DRIFT (offline, exit 1). Two things go wrong when the floor is bumped by hand:
 *   (a) the @yawlabs/mcp-compliance devDependency is left on the old range, so the
 *       release is graded by a different compliance line than yaw-mcp grades with;
 *   (b) a "Yaw MCP X.Y.Z or newer" claim in README.md or CLAUDE.md is left naming
 *       the old release.
 * Checked on every `npm test` through src/yaw-mcp-floor.test.ts, and again by
 * release.sh's pre-flight.
 *
 * STALENESS (online, never fails). Yaw MCP ships often, so a floor behind the
 * latest release is a prompt to re-test, not a broken repo: it prints a WARNING
 * and exits 0. Unlike the oam floor, there is no launcher refusing to serve on an
 * older Yaw MCP, so there is nothing for a stale floor to break.
 *
 * Usage:
 *   node scripts/check-yaw-mcp-floor.mjs              both checks
 *   node scripts/check-yaw-mcp-floor.mjs --offline    drift only, no network
 *   node scripts/check-yaw-mcp-floor.mjs --root DIR   check that tree (for tests)
 *
 * Exit 1 on drift, always -- an inconsistent repo is a bug with no upside.
 * Exit 0 with a WARNING line when the floor is stale. Exit 0 when the network is
 * unavailable (said so on stderr): a checker that turns an offline machine into
 * a failed release would just get switched off.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The Yaw MCP release this server is tested with. Bump both together. */
export const YAW_MCP_MIN = "1.1.13";
/** The @yawlabs/mcp-compliance range @yawlabs/mcp YAW_MCP_MIN pins. */
export const YAW_MCP_COMPLIANCE_RANGE = "^0.20.4";

const args = process.argv.slice(2);
const OFFLINE = args.includes("--offline");
const rootFlag = args.indexOf("--root");
const REPO_ROOT =
  rootFlag !== -1 && args[rootFlag + 1]
    ? resolve(args[rootFlag + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The public registry document for the latest dist-tag. No auth header and
// nothing about this machine or user goes with the request.
const REGISTRY_LATEST = "https://registry.npmjs.org/@yawlabs/mcp/latest";
const FETCH_TIMEOUT_MS = 10_000;

/** Files that may carry a floor claim. A missing one is skipped. */
const SCANNED = ["README.md", "CLAUDE.md"];

/**
 * A floor claim: the product name, a version, then "or newer" / "or later".
 * Deliberately narrow. The version must sit directly after the name and be
 * followed by the "or newer" phrase, so history never matches: "Cutting
 * @yawlabs/mcp 1.0.17", "the one Yaw MCP 1.1.13 requires", "Yaw MCP keeps the
 * first 100,000 bytes", or `yaw-mcp set tailscale ...`. The optional "v" covers
 * "Yaw MCP v1.1.13 or newer".
 */
const CLAIM_RE = /\b(?:Yaw MCP|yaw-mcp)\s+v?(\d+\.\d+\.\d+)\s+or\s+(?:newer|later)\b/gi;

export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The devDependency half: a @yawlabs/mcp-compliance devDependency, when there is
 * one, must be exactly YAW_MCP_COMPLIANCE_RANGE. A repo without one is not this
 * check's business (it grades nothing, so it cannot grade with the wrong line).
 * tailscale-mcp is such a repo today, so this returns null here.
 */
export function findComplianceRangeDrift(root) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch (err) {
    return `could not read package.json: ${err instanceof Error ? err.message : String(err)}`;
  }
  const range = pkg.devDependencies?.["@yawlabs/mcp-compliance"];
  if (range === undefined || range === YAW_MCP_COMPLIANCE_RANGE) return null;
  return `package.json pins @yawlabs/mcp-compliance ${range}, but Yaw MCP ${YAW_MCP_MIN} grades with ${YAW_MCP_COMPLIANCE_RANGE}`;
}

/** Every floor claim in SCANNED that names a version other than YAW_MCP_MIN. */
export function findClaimDrift(root) {
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
      for (const m of lines[i].matchAll(CLAIM_RE)) {
        if (m[1] !== YAW_MCP_MIN) {
          problems.push({ file: rel, line: i + 1, found: m[1], text: lines[i].trim().slice(0, 110) });
        }
      }
    }
  }
  return problems;
}

async function fetchLatestYawMcp() {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(REGISTRY_LATEST, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`registry.npmjs.org answered ${res.status}`);
  const body = await res.json();
  const version = String(body.version ?? "");
  if (!parseVersion(version)) throw new Error(`could not read a version from ${JSON.stringify(body.version)}`);
  return { version, complianceRange: body.dependencies?.["@yawlabs/mcp-compliance"] ?? null };
}

async function main() {
  console.log(`Yaw MCP floor: ${YAW_MCP_MIN} (mcp-compliance ${YAW_MCP_COMPLIANCE_RANGE})`);

  let failed = false;

  const rangeDrift = findComplianceRangeDrift(REPO_ROOT);
  if (rangeDrift) {
    console.error(`DRIFT: ${rangeDrift}`);
    failed = true;
  }

  const drift = findClaimDrift(REPO_ROOT);
  if (drift.length > 0) {
    console.error(`DRIFT: ${drift.length} Yaw MCP floor claim(s) name a version other than ${YAW_MCP_MIN}:`);
    for (const d of drift) console.error(`  ${d.file}:${d.line}  says ${d.found}  |  ${d.text}`);
    console.error("Update them, or bump YAW_MCP_MIN in this script if the floor itself moved.");
    failed = true;
  } else if (!rangeDrift) {
    console.log(`  no drift: package.json and every floor claim in ${SCANNED.join(", ")} agree`);
  }

  if (!OFFLINE) {
    try {
      const latest = await fetchLatestYawMcp();
      const behind = compareVersions(parseVersion(YAW_MCP_MIN), parseVersion(latest.version)) < 0;
      const rangeMoved = latest.complianceRange !== YAW_MCP_COMPLIANCE_RANGE;
      if (behind || rangeMoved) {
        // A prompt to re-test, never a failure. See the header.
        console.log(
          `  WARNING: @yawlabs/mcp ${latest.version} is the latest (mcp-compliance ${latest.complianceRange ?? "none"});` +
            ` the floor is ${YAW_MCP_MIN} (mcp-compliance ${YAW_MCP_COMPLIANCE_RANGE}). Re-test on it and bump` +
            " YAW_MCP_MIN, YAW_MCP_COMPLIANCE_RANGE, the devDependency and the README claim together.",
        );
      } else {
        console.log(`  current: matches the latest @yawlabs/mcp release (${latest.version})`);
      }
    } catch (err) {
      // Deliberately not a failure. See the header.
      console.error(`  staleness not checked: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  process.exit(failed ? 1 : 0);
}

/**
 * True when `argv1` (process.argv[1]) names the module at `moduleUrl`. Both sides
 * are realpath'd, as in check-oam-floor.mjs: Node realpaths the main module's URL
 * but not argv[1], so from a junctioned checkout a plain compare skipped main()
 * and exited 0 in silence.
 */
export function isMainModule(argv1, moduleUrl) {
  if (!argv1) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

// Only run when invoked directly, so the helpers above stay importable.
if (isMainModule(process.argv[1], import.meta.url)) {
  await main();
}
