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
 *       the old release;
 *   (c) no such claim is left at all (reworded or deleted), so (b) checks nothing.
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

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, isMainModule, parseVersion } from "./lib/floor-version.mjs";

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

/** Every floor claim in SCANNED, whatever version it names. */
export function findClaims(root) {
  const claims = [];
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
        claims.push({ file: rel, line: i + 1, found: m[1], text: lines[i].trim().slice(0, 110) });
      }
    }
  }
  return claims;
}

/** Every floor claim in SCANNED that names a version other than YAW_MCP_MIN. */
export function findClaimDrift(root) {
  return findClaims(root).filter((c) => c.found !== YAW_MCP_MIN);
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

  // No claim at all is drift too: with no @yawlabs/mcp-compliance devDependency
  // (this repo has none) the README sentence is the only thing this half
  // checks, so rewording it past CLAIM_RE or deleting it used to leave the
  // checker reporting "no drift" while checking nothing.
  const claims = findClaims(REPO_ROOT);
  const drift = findClaimDrift(REPO_ROOT);
  if (claims.length === 0) {
    console.error(
      `DRIFT: no "Yaw MCP ${YAW_MCP_MIN} or newer" claim found in ${SCANNED.join(", ")} -- the floor is documented nowhere.`,
    );
    console.error("Restore the README sentence, or reword it so CLAIM_RE in this script still matches it.");
    failed = true;
  } else if (drift.length > 0) {
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

// Only run when invoked directly. isMainModule (scripts/lib/floor-version.mjs)
// realpaths both sides, so this still runs from a junctioned checkout.
if (isMainModule(process.argv[1], import.meta.url)) {
  await main();
}
