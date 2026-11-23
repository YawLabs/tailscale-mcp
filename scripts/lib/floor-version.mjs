// Helpers shared by scripts/check-oam-floor.mjs and scripts/check-yaw-mcp-floor.mjs.
// They used to be hand-copied into both, so a fix to one copy (the junction
// realpath fix in isMainModule, CHANGELOG 0.23.1) had to be repeated by hand in
// the other.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * [major, minor, patch] from "X.Y.Z" or "vX.Y.Z" (trailing text ignored), else null.
 * Anchored, unlike the launcher's parseVersion in bin/tailscale-mcp.mjs, which
 * reads `oam --version` output ("oam 0.15.1") and cannot import this file (it
 * ships alone, without scripts/).
 */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1 for two parseVersion() triples. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * True when `argv1` (process.argv[1]) names the module at `moduleUrl`. Node
 * realpaths the main module's URL (unless --preserve-symlinks-main) but leaves
 * argv[1] as typed, so from a junctioned or symlinked checkout a raw compare of
 * the two was false: main() never ran, and the check printed nothing and exited
 * 0 -- a silence that reads as a pass. Both sides are realpath'd, so the answer
 * holds with or without --preserve-symlinks-main. The same fix as yaw-mcp's
 * scripts/verify-oam-floor.mjs.
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
