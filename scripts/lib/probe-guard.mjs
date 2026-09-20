/**
 * Interlocks for the live shape probe harness (scripts/live-probe.mjs).
 *
 * Every function here exists to REFUSE something. They are independent on
 * purpose: an unsafe probe has to clear several of them, so one mistake -- a
 * pasted credential, a forgotten env var, a typo in a tailnet id -- is not
 * enough to point a destructive write at a real tailnet.
 *
 * The facts that shape all of this were read in src/api.ts of this repo at
 * tag v0.20.2:
 *
 *  1. getAuthConfig (api.ts:58-73) checks `apiKey !== undefined` FIRST, so an
 *     ambient TAILSCALE_API_KEY wins over the OAuth pair. The owner's shell
 *     exports the real key, so a harness that merely set OAuth vars for a
 *     disposable tailnet would still send every request with the real
 *     credential.
 *  2. getTailnet (api.ts:231-233) is `process.env.TAILSCALE_TAILNET || "-"`,
 *     and "-" means "whatever tailnet this token is scoped to". Combined with
 *     (1) that is the real tailnet. Note the `||`: an empty string falls back
 *     to "-" as well, so "set it to blank" is not a way to disable it.
 *  3. The OAuth token cache is a module-global (api.ts:41), invalidated only by
 *     wall-clock expiry or a 401, so a token minted for one target can be
 *     replayed on another target's arm unless the cache is reset between
 *     credential sets. api.ts exports __resetOAuthTokenCacheForTests for that.
 *  4. Both request paths call the GLOBAL fetch at call time (api.ts:138 for the
 *     token exchange, api.ts:562-567 for everything else), which is what makes
 *     a fetch-layer egress guard possible at all.
 *
 * So: strip every TAILSCALE_* name before importing anything from dist, address
 * an explicit tailnet id always, block "/tailnet/-/" at the fetch layer, and
 * bind each credential to the target it belongs to.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The API origin every probe request must land on. */
export const API_HOST = "api.tailscale.com";
export const API_PREFIX = "/api/v2";
export const TOKEN_PATH = "/oauth/token";

/** Raised by every refusal below, so live-probe.mjs can print it without a stack. */
export class ProbeRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbeRefusal";
    this.code = code;
  }
}

function refuse(code, message) {
  throw new ProbeRefusal(code, message);
}

/** SHA-256 of a string, hex. Used to COMPARE secrets without ever printing one. */
export function fingerprint(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

/** First 12 hex characters of a fingerprint -- safe to print, useless to an attacker. */
export function shortFingerprint(value) {
  return `${fingerprint(value).slice(0, 12)}...`;
}

/**
 * Canonicalize a path so two spellings of the same directory compare equal.
 *
 * Every containment and identity test in this harness used to be string math
 * over `resolve()`d paths, and a checkout reached through a symlink, a Windows
 * directory junction (no admin rights needed) or a `subst` drive spells the
 * same tree two ways. That made `isInside` answer "outside the repo" for a
 * directory that IS the working tree -- which is how a junction pointing at
 * this tree's own dist/ passed the pinned-build guard's three legs and let a
 * CURRENT arm record the FIXED request instead of the shipped one.
 *
 * The target need not exist: the nearest ANCESTOR that does is realpath'd and
 * the remaining tail re-joined, because a state directory is routinely named
 * before it is created.
 */
export function canonicalPath(p) {
  const abs = resolve(p);
  let head = abs;
  const tail = [];
  for (;;) {
    try {
      const real = realpathSync.native(head);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch {
      const parent = dirname(head);
      // Reached the filesystem root without finding anything that exists.
      if (parent === head) return abs;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/**
 * Identity for comparing one path against another: canonical, and case-folded
 * on Windows. Same shape as bin/tailscale-mcp.mjs's own `pathKey`.
 */
export function pathKey(p, platform = process.platform) {
  const key = canonicalPath(p);
  return platform === "win32" ? key.toLowerCase() : key;
}

/**
 * Is this the name of a TAILSCALE_* variable?
 *
 * Windows environment names are case-INSENSITIVE but case-PRESERVING: a
 * variable the shell created as `Tailscale_Api_Key` is returned by
 * `process.env.TAILSCALE_API_KEY` -- which is the spelling api.ts reads -- but
 * `Object.keys(process.env)` reports the OS's stored spelling. A case-sensitive
 * prefix test therefore misses exactly the variables it is meant to remove.
 */
function isTailscaleName(name, platform) {
  return (platform === "win32" ? name.toUpperCase() : name).startsWith("TAILSCALE_");
}

/**
 * Read a variable by its CANONICAL name, honouring Windows' case-insensitive
 * lookup even on a synthetic env object (which is how the tests drive this).
 */
function lookupEnv(env, name, platform) {
  if (platform !== "win32") return env[name];
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted) return value;
  }
  return undefined;
}

/**
 * The TAILSCALE_* names this harness sets on itself once the ambient ones are
 * gone. Kept as a list so applyProbeCredentials can clear exactly what it set
 * between credential sets, rather than re-running the blanket strip.
 *
 * TAILSCALE_OAUTH_TAILNET is in the list because it must be CLEARED, never set:
 * reaching a disposable tailnet through `?tailnet=` on the token exchange is
 * the unverified mechanism finding C7 is about (api.ts:131-146). If the param
 * is silently ignored the minted token addresses the CREATING tailnet, and
 * every subsequent request would land on the real one. The harness reaches
 * target A with target A's own OAuth client instead.
 */
export const PROBE_MANAGED_ENV = [
  "TAILSCALE_API_KEY",
  "TAILSCALE_OAUTH_CLIENT_ID",
  "TAILSCALE_OAUTH_CLIENT_SECRET",
  "TAILSCALE_TAILNET",
  "TAILSCALE_OAUTH_TAILNET",
];

/**
 * G0, first half. Delete every TAILSCALE_* name from THIS process's env and
 * return the fingerprints of the credentials that were there.
 *
 * Call this before the first `await import()` of anything under a dist/: api.ts
 * reads process.env at call time rather than at module load, but the earlier
 * this runs the smaller the window in which an ambient key could be picked up.
 *
 * The values are hashed, never kept. Nothing in this harness can print, log or
 * send the owner's real key, because after this returns the harness no longer
 * has it.
 *
 * The scan is case-insensitive on Windows, where the name api.ts reads
 * (`TAILSCALE_API_KEY`) and the name the OS stored (`Tailscale_Api_Key`) can be
 * different spellings of one variable -- see isTailscaleName. The names
 * REPORTED are the stored spellings, so what is printed may not be uppercase.
 */
export function stripAmbientCredentials(env = process.env, platform = process.platform) {
  const removed = [];
  const ambient = { apiKeyFingerprint: null, oauthSecretFingerprint: null, tailnet: null, oauthTailnet: null };

  const apiKey = lookupEnv(env, "TAILSCALE_API_KEY", platform);
  if (typeof apiKey === "string" && apiKey.trim() !== "") ambient.apiKeyFingerprint = fingerprint(apiKey.trim());
  const oauthSecret = lookupEnv(env, "TAILSCALE_OAUTH_CLIENT_SECRET", platform);
  if (typeof oauthSecret === "string" && oauthSecret.trim() !== "") {
    ambient.oauthSecretFingerprint = fingerprint(oauthSecret.trim());
  }
  // Captured, not hashed: a tailnet NAME is not a secret, and G1 folds it into
  // the forbidden list so the owner's own environment adds to the protection
  // rather than being the only thing standing between a probe and production.
  const tailnet = lookupEnv(env, "TAILSCALE_TAILNET", platform)?.trim();
  if (tailnet && tailnet !== "-") ambient.tailnet = tailnet;
  const oauthTailnet = lookupEnv(env, "TAILSCALE_OAUTH_TAILNET", platform)?.trim();
  if (oauthTailnet && oauthTailnet !== "-") ambient.oauthTailnet = oauthTailnet;

  for (const name of Object.keys(env)) {
    if (isTailscaleName(name, platform)) {
      removed.push(name);
      delete env[name];
    }
  }
  removed.sort();
  return { removed, ambient };
}

/**
 * G0, second half. Refuse a probe credential that IS the ambient one.
 *
 * This is the "pasted the real key into the probe slot" case. Comparison is on
 * fingerprints held in memory; neither value is ever written anywhere.
 */
export function assertCredentialIsolation(probeSecrets, ambient) {
  for (const [name, value] of Object.entries(probeSecrets)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    const fp = fingerprint(value.trim());
    if (ambient.apiKeyFingerprint && fp === ambient.apiKeyFingerprint) {
      refuse(
        "ambient-credential-reused",
        `${name} is byte-identical to the TAILSCALE_API_KEY this shell exports. That key addresses the real ` +
          "tailnet. Supply a credential minted for the probe target instead.",
      );
    }
    if (ambient.oauthSecretFingerprint && fp === ambient.oauthSecretFingerprint) {
      refuse(
        "ambient-credential-reused",
        `${name} is byte-identical to the TAILSCALE_OAUTH_CLIENT_SECRET this shell exports. Supply a credential ` +
          "minted for the probe target instead.",
      );
    }
  }
}

/**
 * G1. An explicit target, never "-", never one the owner listed as forbidden.
 *
 * `forbidden` is MANDATORY and must be non-empty on any path that can send a
 * request. The reasoning is the same as tailnets.ts's refusal to delete "-"
 * (tailnets.ts:127-133): a self-reference cannot be checked against anything,
 * so there is nothing for a confirmation to confirm.
 */
export function assertExplicitTarget(tailnetId, forbidden, { requireForbiddenList = true } = {}) {
  const target = String(tailnetId ?? "").trim();
  if (target === "") {
    refuse("no-target", "No tailnet id supplied. Every probe addresses an explicit tailnet id.");
  }
  if (target === "-") {
    refuse(
      "bare-tailnet-target",
      'The tailnet id is "-", which means "whatever tailnet these credentials are scoped to" -- on the owner\'s ' +
        "shell that is the real tailnet. Name the target explicitly.",
    );
  }
  const list = normalizeForbidden(forbidden);
  if (requireForbiddenList && list.length === 0) {
    refuse(
      "empty-forbidden-list",
      "TS_PROBE_FORBIDDEN_TAILNETS is empty. Set it to the real tailnet's id AND its name/domain, " +
        "comma-separated. The harness refuses to send anything without a non-empty forbidden list.",
    );
  }
  if (list.includes(target.toLowerCase())) {
    refuse("forbidden-target", `Tailnet ${JSON.stringify(target)} is on TS_PROBE_FORBIDDEN_TAILNETS.`);
  }
  return target;
}

export function normalizeForbidden(forbidden) {
  // null and undefined are filtered BEFORE String(), because String(null) is
  // "null" -- an entry that quietly inflates the list and makes an empty
  // forbidden list look populated, which is exactly the check that must not be
  // satisfiable by accident.
  return (forbidden ?? [])
    .filter((entry) => entry !== null && entry !== undefined)
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry) => entry !== "" && entry !== "-");
}

/**
 * Where provision writes its state. Outside the repo by default.
 *
 * The last resort is never `"."`. A cwd-relative base put the file -- which
 * holds a disposable tailnet's OAuth client SECRET -- under the working tree
 * for the documented cwd whenever the profile variables were absent (`env -i`,
 * a systemd unit with no user profile, a distroless container, some CI
 * runners), and .gitignore's bare `probe-state.json` pattern then permitted the
 * write rather than refusing it. os.homedir() falls back to the passwd entry,
 * and os.tmpdir() is the floor.
 */
export function defaultStateDir(env = process.env, platform = process.platform) {
  const explicit = env.TS_PROBE_STATE_DIR?.trim();
  if (explicit) return resolve(explicit);
  const fallbackHome = () => {
    const home = homedir();
    return typeof home === "string" && home.trim() !== "" ? home.trim() : tmpdir();
  };
  // mode 0600 is a no-op on Windows, so the file's protection there is that it
  // lives in the user's own profile, not in a repo anyone might `git add -A`.
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA?.trim() || env.USERPROFILE?.trim() || fallbackHome()
      : env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || fallbackHome(), ".local", "state");
  return resolve(base, "yaw-tailscale-probe");
}

/**
 * Refuse a state path that sits inside the repo unless git says it is ignored.
 *
 * The default path is outside the repo entirely (see defaultStateDir); this
 * covers the owner who overrides TS_PROBE_STATE_DIR to somewhere convenient and
 * lands on a tracked directory holding an OAuth client secret.
 */
export function assertStatePathSafe(statePath, { repoRoot = REPO_ROOT, git = defaultGitCheckIgnore } = {}) {
  const abs = resolve(statePath);
  if (!isInside(repoRoot, abs)) return { path: abs, insideRepo: false, ignored: null };
  const answer = git(abs, repoRoot);
  if (answer === true) return { path: abs, insideRepo: true, ignored: true };
  if (answer === false) {
    refuse(
      "state-file-not-ignored",
      `The probe state file would be written to ${abs}, which is inside the repo and NOT ignored by git. ` +
        "It holds an OAuth client secret. Leave TS_PROBE_STATE_DIR unset (the default is outside the repo) " +
        "or point it somewhere git ignores.",
    );
  }
  // Anything else means git never ANSWERED. Still a refusal -- the file holds a
  // secret and nothing has shown it is ignored -- but it must not send the
  // contributor to edit a .gitignore that may already be correct.
  refuse(
    "git-unavailable",
    `git could not answer whether ${abs} is ignored (${describeGitFailure(answer)}), so the harness cannot show ` +
      "the probe state file -- which holds an OAuth client secret -- would stay out of a commit. Leave " +
      "TS_PROBE_STATE_DIR unset (the default is outside the repo entirely), or fix the git invocation above.",
  );
}

function describeGitFailure(answer) {
  if (answer && typeof answer === "object") {
    return answer.stderr ? `${answer.why}: ${answer.stderr}` : String(answer.why);
  }
  return `the ignore check returned ${JSON.stringify(answer ?? null)}`;
}

/**
 * Is `candidate` the same as, or under, `root`?
 *
 * Both sides are canonicalized first, because a symlinked, junctioned or
 * `subst`ed spelling of the working tree resolves to a path that is lexically
 * nowhere near it -- and every caller here treats "outside the repo" as the
 * permissive answer.
 *
 * `relative()` alone is not enough on Windows either: for a path on ANOTHER
 * DRIVE it returns an absolute path ("D:\\probe"), which does not start with
 * ".." and would read as "inside the repo". A drive-relative answer also comes
 * back "" when the two paths are equal, which IS inside. Both are checked
 * explicitly.
 */
export function isInside(root, candidate) {
  const rel = relative(canonicalPath(root), canonicalPath(candidate));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return !rel.startsWith("..");
}

/**
 * Tri-state, because `git check-ignore` has four outcomes and only two of them
 * are an answer: 0 is "ignored", 1 is "not ignored", and 128 (no .git
 * directory, dubious ownership, a corrupt index) or a null status (git not on
 * PATH, or the timeout) mean git never looked. Collapsing those onto `false`
 * reported "this path is not ignored" for a check that never ran.
 */
function defaultGitCheckIgnore(path, cwd) {
  const res = spawnSync("git", ["check-ignore", "-q", path], { cwd, timeout: 30_000, encoding: "utf8" });
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  return {
    unknown: true,
    why: res.error?.code ?? `git exited ${res.status}`,
    stderr: String(res.stderr ?? "").trim(),
  };
}

/**
 * G2. Provenance: only a tailnet THIS harness created, recently, under the
 * probe naming convention, may take an unsafe write.
 *
 * A tailnet the harness created minutes ago cannot be the real one.
 */
export const PROVENANCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const PROBE_NAME_PREFIX = "yaw-probe-";

export function assertProvenance(record, tailnetId, now = Date.now()) {
  if (!record || typeof record !== "object") {
    refuse(
      "no-provenance",
      `No provisioning record found for ${tailnetId}. Unsafe probes run only against a tailnet this harness ` +
        "created with `node scripts/live-probe.mjs provision`.",
    );
  }
  if (record.createdByHarness !== true) {
    refuse("no-provenance", `The provisioning record for ${tailnetId} does not claim createdByHarness: true.`);
  }
  if (record.tailnetId !== tailnetId) {
    refuse(
      "provenance-mismatch",
      `The provisioning record names tailnet ${JSON.stringify(record.tailnetId)}, but the target is ` +
        `${JSON.stringify(tailnetId)}.`,
    );
  }
  if (typeof record.displayName !== "string" || !record.displayName.startsWith(PROBE_NAME_PREFIX)) {
    refuse(
      "provenance-name",
      `The provisioned tailnet's displayName ${JSON.stringify(record.displayName)} does not start with ` +
        `${JSON.stringify(PROBE_NAME_PREFIX)}.`,
    );
  }
  const createdAt = Date.parse(record.createdAt ?? "");
  if (!Number.isFinite(createdAt)) {
    refuse("provenance-age", `The provisioning record for ${tailnetId} has no parseable createdAt.`);
  }
  const ageMs = now - createdAt;
  if (ageMs > PROVENANCE_MAX_AGE_MS) {
    refuse(
      "provenance-age",
      `The provisioning record for ${tailnetId} is ${Math.round(ageMs / 86_400_000)} days old (limit ` +
        `${PROVENANCE_MAX_AGE_MS / 86_400_000}). Provision a fresh target rather than trusting a stale record.`,
    );
  }
  return record;
}

/**
 * G2, second half. The emptiness attestation has to be RECENT.
 *
 * `preflight` is the only thing that ever looks at the target, and it looks
 * once. A device or a user can join a tailnet at any moment, so an attestation
 * written last week says nothing about the tailnet a replace-all DNS write is
 * about to land on. An hour is deliberately short: preflight is three GETs and
 * costs nothing to re-run.
 *
 * Checked on the RUN path, not only where the attestation is written -- the
 * truthiness test `createdByHarness && attestedAt` that unlocks an unsafe probe
 * cannot tell a fresh attestation from an ancient one.
 */
export const ATTESTATION_MAX_AGE_MS = 60 * 60 * 1000;

export function assertAttestationFresh(record, tailnetId, now = Date.now()) {
  const attestedAt = Date.parse(record?.attestedAt ?? "");
  if (!Number.isFinite(attestedAt)) {
    refuse(
      "attestation-missing",
      `${tailnetId} has no server-attested emptiness record. Run \`node scripts/live-probe.mjs preflight ` +
        "--execute` against it first: an unsafe probe runs only against a target the SERVER has just said is empty.",
    );
  }
  const ageMs = now - attestedAt;
  if (ageMs > ATTESTATION_MAX_AGE_MS) {
    refuse(
      "attestation-stale",
      `The emptiness attestation for ${tailnetId} is ${Math.round(ageMs / 60_000)} minutes old (limit ` +
        `${ATTESTATION_MAX_AGE_MS / 60_000}). Devices and users can join between preflight and the run, and ` +
        "nothing else looks. Re-run `node scripts/live-probe.mjs preflight --execute`.",
    );
  }
  return record;
}

/**
 * G3. Server-attested emptiness, from GETs the harness just made.
 *
 * The real tailnet fails this by construction: the repo's own integration suite
 * requires its target to have at least one device and at least one key
 * (integration.test.ts:23-26).
 *
 * `expectLogin` is target B's single human user. On target A (API-only) there
 * are no users at all, so pass undefined and any user is a refusal.
 */
export function assertServerAttestedEmptiness({ users, devices, dnsConfiguration, expectLogin, targetKind }) {
  const userList = Array.isArray(users?.users) ? users.users : Array.isArray(users) ? users : [];
  const deviceList = Array.isArray(devices?.devices) ? devices.devices : Array.isArray(devices) ? devices : [];

  const unexpectedUsers = userList
    .map((user) => String(user?.loginName ?? user?.id ?? "unknown"))
    .filter((login) => !expectLogin || login.toLowerCase() !== String(expectLogin).trim().toLowerCase());
  if (unexpectedUsers.length > 0) {
    refuse(
      "target-not-empty",
      `The target holds ${unexpectedUsers.length} user(s) this harness did not expect` +
        `${expectLogin ? ` (expected only ${expectLogin})` : " (an API-only tailnet should have none)"}. ` +
        "That is not a disposable target.",
    );
  }

  const foreignDevices = deviceList
    .map((device) => String(device?.hostname ?? device?.name ?? "unknown"))
    .filter((hostname) => !hostname.toLowerCase().startsWith(PROBE_NAME_PREFIX));
  if (foreignDevices.length > 0) {
    refuse(
      "target-not-empty",
      `The target holds ${foreignDevices.length} device(s) whose hostname does not start with ` +
        `${JSON.stringify(PROBE_NAME_PREFIX)}. That is not a disposable target.`,
    );
  }

  // DNS is checked separately because P4/P5 are the probes that can wipe it:
  // anything already configured that the harness did not seed is somebody's
  // real DNS.
  const seeded = dnsConfigurationLooksSeeded(dnsConfiguration);
  if (!seeded.ok) {
    refuse(
      "target-not-empty",
      `GET /dns/configuration on the target shows configuration this harness did not seed: ${seeded.why}. ` +
        "Refusing, because the DNS probes are replace-all writes.",
    );
  }

  return { userCount: userList.length, deviceCount: deviceList.length, targetKind };
}

/**
 * "Seeded by this harness, or empty" for a DNS configuration document.
 *
 * Deliberately conservative: every search path and split-DNS key must be a
 * probe value under yaw-probe.example.com, and the shape is checked without
 * assuming which of the two documented spellings the server returns -- which
 * of `splitDNS` and `splitDns` comes back is literally what P4a asks.
 */
export function dnsConfigurationLooksSeeded(config) {
  if (config === undefined || config === null) return { ok: true, why: "" };
  if (typeof config !== "object") return { ok: false, why: `unexpected shape ${typeof config}` };

  const probeDomain = /(^|\.)yaw-probe\.example\.com\.?$/i;
  const searchPaths = Array.isArray(config.searchPaths) ? config.searchPaths : [];
  const foreignPaths = searchPaths.filter((path) => !probeDomain.test(String(path)));
  if (foreignPaths.length > 0) return { ok: false, why: `${foreignPaths.length} non-probe search path(s)` };

  const splitKeys = Object.keys(config.splitDNS ?? config.splitDns ?? {});
  const foreignSplit = splitKeys.filter((domain) => !probeDomain.test(domain));
  if (foreignSplit.length > 0) return { ok: false, why: `${foreignSplit.length} non-probe split-DNS domain(s)` };

  return { ok: true, why: "" };
}

/**
 * G4. Typed confirmation, byte for byte, mirroring tailnets.ts's confirmTailnet
 * (tailnets.ts:141-147).
 *
 * Same honest caveat that tool's description carries: when the caller supplies
 * both halves this catches a typo, not a wrong intent. It is one interlock of
 * several, not the gate.
 */
export function assertTypedConfirmation(confirmValue, tailnetId) {
  if (confirmValue !== tailnetId) {
    refuse(
      "confirmation-mismatch",
      `--destroy-tailnet=${JSON.stringify(confirmValue ?? "")} does not match the target tailnet ` +
        `${JSON.stringify(tailnetId)} byte for byte. Refusing.`,
    );
  }
  return true;
}

/**
 * G6. Safety-class wiring: which interlocks a given probe needs.
 *
 * - unsafe-needs-disposable-tailnet: G2 + G3 + G4. Never on a real tailnet.
 * - safe-reversible-write: G1 + G3, OR an explicit per-probe
 *   --allow-real-reversible=<probeId>.
 * - safe-read-only: on an unattested target, --allow-real-readonly, and the
 *   egress guard drops to GET-only.
 */
export function requiredInterlocks(safetyClass) {
  switch (safetyClass) {
    case "unsafe-needs-disposable-tailnet":
      return { provenance: true, emptiness: true, typedConfirmation: true, realTailnetAllowed: false };
    case "safe-reversible-write":
      return { provenance: false, emptiness: true, typedConfirmation: false, realTailnetAllowed: "per-probe-flag" };
    case "safe-read-only":
      return { provenance: false, emptiness: false, typedConfirmation: false, realTailnetAllowed: "readonly-flag" };
    default:
      return refuse("unknown-safety-class", `Probe declares an unknown safetyClass ${JSON.stringify(safetyClass)}.`);
  }
}

export function assertSafetyClassWiring(plan, ctx) {
  const needs = requiredInterlocks(plan.safetyClass);

  if (ctx.targetIsAttested !== true) {
    if (plan.safetyClass === "unsafe-needs-disposable-tailnet") {
      refuse(
        "unattested-target",
        `${plan.probeId} is ${plan.safetyClass}. It runs only against a tailnet this harness provisioned ` +
          "(provenance + server-attested emptiness + typed confirmation). It is never allowed on a real tailnet.",
      );
    }
    if (plan.safetyClass === "safe-reversible-write" && !ctx.allowRealReversible?.includes(plan.probeId)) {
      refuse(
        "unattested-target",
        `${plan.probeId} writes to the target and the target is not attested as disposable. Either provision a ` +
          `disposable target, or pass --allow-real-reversible=${plan.probeId} to take responsibility for it.`,
      );
    }
    if (plan.safetyClass === "safe-read-only" && ctx.allowRealReadonly !== true) {
      refuse(
        "unattested-target",
        `${plan.probeId} reads from an unattested target. Pass --allow-real-readonly to permit it; the egress ` +
          "guard then drops to GET-only.",
      );
    }
  }

  return needs;
}

/**
 * Route a probe to the target its credential needs demand (critic amendment 3).
 *
 * P2 and P3 create invites, which "require an inviting user" and are refused
 * for OAuth-minted tokens (openapi.yaml:831, :938). Target A is an API-only
 * tailnet with no human users at all, so those probes can only ever run on
 * target B. Left to a flag this would be a runtime 403 the owner has to
 * interpret; as a refusal it is a sentence.
 */
export function assertTargetRouting(plan, targetKind) {
  const required = plan.requiresTargetKind;
  if (!required) return targetKind;
  if (required !== targetKind) {
    refuse(
      "wrong-target-kind",
      `${plan.probeId} requires a ${required} target (${plan.requiresTargetKindWhy ?? "see the plan"}), but the ` +
        `configured target is ${JSON.stringify(targetKind)}. Set TS_PROBE_TARGET_KIND and point ` +
        "TS_PROBE_TAILNET_ID at the right tailnet.",
    );
  }
  return targetKind;
}

/**
 * G5. The egress guard, enforced inside the fetch wrapper so a blocked request
 * never leaves the process.
 *
 * What it checks, in order:
 *  - the origin is https://api.tailscale.com and the path is under /api/v2
 *  - POST /oauth/token is always allowed (it changes no tailnet state) and is
 *    the ONLY thing allowed on that path
 *  - "/tailnet/-/" is refused outright, except for a probe that has declared a
 *    bare-tailnet discriminator (P9, GET only -- reading the search paths under
 *    a possibly-mis-scoped token is the whole question that probe asks)
 *  - a tailnet-scoped path names the declared target and nothing else
 *  - a non-tailnet-scoped resource path (/webhooks/{id}, /user-invites/{id},
 *    /device-invites/{id}, /device/{id}/device-invites) names an id THIS RUN
 *    registered from an earlier response
 *  - the method is in the plan's allowlist ("readonly" is GET only)
 *  - when the plan declares `allowedRequests`, the method AND path must match
 *    one of its entries. That is how a probe whose only write is a harmless
 *    POST (ACL validate, ACL preview) gets POST without also getting POST /acl,
 *    which replaces the whole policy on the same prefix.
 *  - the Authorization header carries a credential this run has only ever used
 *    for the arm's declared credential target, so a cached OAuth token cannot
 *    ride along onto another target
 */
export function createEgressGuard({
  target,
  mode = "full",
  methods = null,
  allowedRequests = null,
  allowBareTailnetGet = false,
  allowOrganizations = false,
}) {
  const registeredIds = new Set();
  /** Authorization fingerprint -> the credential target it was first seen under. */
  const credentialOwners = new Map();
  const blocked = [];
  const sent = [];
  let context = { probeId: "<none>", step: "<none>", target, credentialTarget: target };

  const allowedMethods = new Set(
    methods ?? (mode === "readonly" ? ["GET"] : ["GET", "POST", "PUT", "PATCH", "DELETE"]),
  );

  function block(parsedOrUrl, method, why, code, message) {
    blocked.push({ url: String(parsedOrUrl), method, why, probeId: context.probeId, step: context.step });
    refuse(code, message);
  }

  return {
    mode,
    setContext(next) {
      context = { ...context, ...next };
    },
    get context() {
      return { ...context };
    },
    /**
     * Record an id returned by an earlier response so a later non-tailnet-scoped
     * path may name it. Nothing else can be addressed on those paths.
     */
    registerId(id) {
      if (typeof id === "string" && id.trim() !== "") registeredIds.add(id.trim());
      return this;
    },
    get registeredIdCount() {
      return registeredIds.size;
    },
    /**
     * Pre-bind a credential whose Authorization header is known before the first
     * request (the API-key path: `Basic base64(key:)`). OAuth bearers are bound
     * on first sight instead, since the token does not exist until it is minted.
     */
    bindCredential(credentialTarget, authorizationHeader) {
      if (!authorizationHeader) return this;
      const fp = fingerprint(authorizationHeader);
      const owner = credentialOwners.get(fp);
      if (owner !== undefined && owner !== credentialTarget) {
        refuse(
          "egress-credential-mismatch",
          `The credential offered for ${JSON.stringify(credentialTarget)} is the same one already used for ` +
            `${JSON.stringify(owner)}. One credential addresses one target.`,
        );
      }
      credentialOwners.set(fp, credentialTarget);
      return this;
    },
    get blockedRequests() {
      return blocked.slice();
    },
    get sentRequests() {
      return sent.slice();
    },
    /** Throws ProbeRefusal when the request must not be sent. */
    check(url, method, authorizationHeader) {
      const upper = String(method ?? "GET").toUpperCase();
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        block(String(url), upper, "unparseable URL", "egress-bad-url", `Refusing an unparseable request URL.`);
      }

      if (parsed.protocol !== "https:" || parsed.host !== API_HOST) {
        block(
          parsed.href,
          upper,
          "wrong origin",
          "egress-wrong-host",
          `Refusing a request to ${parsed.origin} -- the only permitted origin is https://${API_HOST}.`,
        );
      }
      if (!parsed.pathname.startsWith(`${API_PREFIX}/`)) {
        block(
          parsed.href,
          upper,
          "outside /api/v2",
          "egress-bad-path",
          `Refusing a request to ${parsed.pathname} -- outside ${API_PREFIX}.`,
        );
      }

      const rest = parsed.pathname.slice(API_PREFIX.length);

      // The token exchange first, and outside the per-mode method allowlist: it
      // creates no tailnet state, and a read-only probe authenticating with an
      // OAuth client cannot send a single GET without it.
      if (rest === TOKEN_PATH) {
        if (upper !== "POST") {
          block(
            parsed.href,
            upper,
            "token endpoint takes POST only",
            "egress-method",
            `Refusing ${upper} ${TOKEN_PATH} -- the token exchange is a POST.`,
          );
        }
        sent.push({ url: parsed.href, method: upper, kind: "oauth-token", probeId: context.probeId });
        return { allowed: true, kind: "oauth-token" };
      }

      if (!allowedMethods.has(upper)) {
        block(
          parsed.href,
          upper,
          `method not allowed in ${mode} mode`,
          "egress-method",
          `Refusing ${upper} ${parsed.pathname} -- this probe runs in ${mode} mode, which permits ` +
            `${[...allowedMethods].join("/")} only (plus POST ${TOKEN_PATH}).`,
        );
      }

      if (allowedRequests && !allowedRequests.some((entry) => entry.method === upper && entry.pattern.test(rest))) {
        block(
          parsed.href,
          upper,
          "not on this probe's request allowlist",
          "egress-not-planned",
          `Refusing ${upper} ${parsed.pathname}: this probe declares an explicit request allowlist and nothing on ` +
            "it matches. A probe that reaches a path its plan never named is a bug in the plan or in the handler, " +
            "not something to let through.",
        );
      }

      const tailnetMatch = /^\/tailnet\/([^/]+)(\/.*)?$/.exec(rest);
      if (tailnetMatch) {
        const named = decodeURIComponent(tailnetMatch[1]);
        if (named === "-") {
          if (!(allowBareTailnetGet && upper === "GET")) {
            block(
              parsed.href,
              upper,
              "bare '-' tailnet",
              "egress-bare-tailnet",
              `Refusing ${upper} ${parsed.pathname}: "/tailnet/-/" resolves to whatever tailnet the token is ` +
                "scoped to, which on a mis-scoped token is the real one.",
            );
          }
          this.assertCredentialBinding(authorizationHeader, parsed, upper);
          sent.push({ url: parsed.href, method: upper, kind: "bare-tailnet-discriminator", probeId: context.probeId });
          return { allowed: true, kind: "bare-tailnet-discriminator" };
        }
        if (named !== context.target) {
          block(
            parsed.href,
            upper,
            "wrong tailnet",
            "egress-wrong-tailnet",
            `Refusing ${upper} ${parsed.pathname}: it names tailnet ${JSON.stringify(named)} while this arm ` +
              `declared ${JSON.stringify(context.target)}.`,
          );
        }
        this.assertCredentialBinding(authorizationHeader, parsed, upper);
        sent.push({ url: parsed.href, method: upper, kind: "tailnet-scoped", probeId: context.probeId });
        return { allowed: true, kind: "tailnet-scoped" };
      }

      if (/^\/organizations\/([^/]+)\/tailnets$/.test(rest)) {
        if (!allowOrganizations) {
          block(
            parsed.href,
            upper,
            "org endpoint not enabled for this command",
            "egress-org",
            `Refusing ${upper} ${parsed.pathname}: the organization tailnets endpoint is reachable only from ` +
              "`provision` and `teardown`.",
          );
        }
        this.assertCredentialBinding(authorizationHeader, parsed, upper);
        sent.push({ url: parsed.href, method: upper, kind: "organizations", probeId: context.probeId });
        return { allowed: true, kind: "organizations" };
      }

      // Non-tailnet-scoped resource paths. Each id must have come back from an
      // earlier response in THIS run, so a probe can only touch objects it made
      // or listed (invites.ts:48, :65, :82, :161, :178; webhooks.ts:149, :198, :215).
      const resourceMatch =
        /^\/(webhooks|user-invites|device-invites)\/([^/]+)$/.exec(rest) ??
        /^\/(device)\/([^/]+)\/device-invites$/.exec(rest);
      if (resourceMatch) {
        const id = decodeURIComponent(resourceMatch[2]);
        if (!registeredIds.has(id)) {
          block(
            parsed.href,
            upper,
            "unregistered resource id",
            "egress-unregistered-id",
            `Refusing ${upper} ${parsed.pathname}: ${JSON.stringify(id)} was not returned by an earlier request in ` +
              "this run, so the harness cannot show it is an object the probe created or listed.",
          );
        }
        this.assertCredentialBinding(authorizationHeader, parsed, upper);
        sent.push({ url: parsed.href, method: upper, kind: "resource-scoped", probeId: context.probeId });
        return { allowed: true, kind: "resource-scoped" };
      }

      return block(
        parsed.href,
        upper,
        "path not on the allowlist",
        "egress-unknown-path",
        `Refusing ${upper} ${parsed.pathname}: not a path any probe plan declares. The allowlist is ` +
          `/tailnet/<target>/..., ${TOKEN_PATH}, /organizations/<org>/tailnets, and the four non-tailnet-scoped ` +
          "resource paths.",
      );
    },

    /**
     * Critic amendment 3: a token minted for target A must not ride onto target
     * B just because api.ts caches it in a module-global (api.ts:41). The
     * harness also resets that cache between credential sets; this is the check
     * that catches it if the reset is ever missed.
     *
     * A fingerprint is claimed by the FIRST credential target it is seen under,
     * so no pre-registration is needed for an OAuth bearer that does not exist
     * until it is minted.
     */
    assertCredentialBinding(authorizationHeader, parsed, method) {
      const declared = context.credentialTarget ?? context.target;
      if (!authorizationHeader) {
        block(
          parsed.href,
          method,
          "no Authorization header",
          "egress-no-credential",
          `Refusing ${method} ${parsed.pathname}: no Authorization header was built.`,
        );
      }
      const fp = fingerprint(authorizationHeader);
      const owner = credentialOwners.get(fp);
      if (owner === undefined) {
        credentialOwners.set(fp, declared);
        return;
      }
      if (owner !== declared) {
        block(
          parsed.href,
          method,
          "credential not bound to this target",
          "egress-credential-mismatch",
          `Refusing ${method} ${parsed.pathname}: this Authorization header was already used for ` +
            `${JSON.stringify(owner)} and this arm declared ${JSON.stringify(declared)}. A cached OAuth token from ` +
            "another credential set is the usual cause (api.ts:41 caches the token in a module-global; call " +
            "__resetOAuthTokenCacheForTests between credential sets).",
        );
      }
    },
  };
}

/**
 * Point api.ts's credential resolution at ONE probe credential and ONE explicit
 * tailnet, and return the Authorization header when it can be known up front.
 *
 * Clears the five managed names first so a previous arm's credential cannot
 * survive into this one -- api.ts:63 would prefer a left-over TAILSCALE_API_KEY
 * over the OAuth pair set here.
 *
 * TAILSCALE_OAUTH_TAILNET is never set. See PROBE_MANAGED_ENV.
 */
export function applyProbeCredentials(credential, tailnetId, env = process.env) {
  for (const name of PROBE_MANAGED_ENV) delete env[name];

  const target = String(tailnetId ?? "").trim();
  if (target === "" || target === "-") {
    refuse(
      "bare-tailnet-target",
      `Refusing to set TAILSCALE_TAILNET to ${JSON.stringify(target)}: getTailnet() (api.ts:231-233) turns both ` +
        'the empty string and "-" into "-", i.e. whatever tailnet the credential is scoped to.',
    );
  }
  env.TAILSCALE_TAILNET = target;

  if (credential?.kind === "api-key") {
    if (!credential.secret) refuse("no-credential", "The probe API-key credential has no secret.");
    env.TAILSCALE_API_KEY = credential.secret;
    // getAuthHeader (api.ts:212-213) builds exactly this for an API key, so it
    // can be bound to the target before a single request goes out.
    return `Basic ${Buffer.from(`${credential.secret}:`).toString("base64")}`;
  }
  if (credential?.kind === "oauth") {
    if (!credential.clientId || !credential.secret) {
      refuse("no-credential", "The probe OAuth credential needs both a client id and a client secret.");
    }
    env.TAILSCALE_OAUTH_CLIENT_ID = credential.clientId;
    env.TAILSCALE_OAUTH_CLIENT_SECRET = credential.secret;
    // The bearer does not exist until the token is minted, so the egress guard
    // binds it on first sight instead.
    return null;
  }
  return refuse("no-credential", `Unknown probe credential kind ${JSON.stringify(credential?.kind ?? null)}.`);
}

/**
 * Belt and braces before every arm: nothing outside PROBE_MANAGED_ENV may carry
 * a TAILSCALE_ prefix, and TAILSCALE_OAUTH_TAILNET must be absent.
 */
export function assertEnvClean(env = process.env, platform = process.platform) {
  // BOTH sides are canonicalised on Windows, not just the prefix test. Making
  // the scan case-insensitive while leaving the PROBE_MANAGED_ENV membership
  // test case-sensitive would refuse a name this harness set itself:
  // `env.TAILSCALE_TAILNET = target` updates a variable the OS may still be
  // storing as `Tailscale_Tailnet`, and that stored spelling is what
  // Object.keys reports.
  const canon = (name) => (platform === "win32" ? name.toUpperCase() : name);
  const managed = new Set(PROBE_MANAGED_ENV.map(canon));
  const stray = Object.keys(env).filter((name) => isTailscaleName(name, platform) && !managed.has(canon(name)));
  if (stray.length > 0) {
    refuse(
      "stray-tailscale-env",
      `${stray.join(", ")} reappeared in the environment after the ambient strip. The harness reads TS_PROBE_* ` +
        "only; a TAILSCALE_* name here can change which credential or tailnet api.ts picks.",
    );
  }
  if (lookupEnv(env, "TAILSCALE_OAUTH_TAILNET", platform) !== undefined) {
    refuse(
      "oauth-tailnet-set",
      "TAILSCALE_OAUTH_TAILNET is set. Reaching a target through `?tailnet=` on the token exchange is the " +
        "unverified mechanism finding C7 is about: if the parameter is ignored, the minted token addresses the " +
        "CREATING tailnet. Reach target A with target A's own OAuth client instead.",
    );
  }
}

/**
 * The pinned-build rule (critic amendment 2).
 *
 * CURRENT arms must be produced by the code that SHIPPED, not by the working
 * tree -- whose dist/ now contains the fixes these probes are meant to gate. A
 * v0.20.2 build lives outside the repo, so nothing in the working tree can
 * change what a CURRENT arm emits.
 */
export function resolvePinnedDist(
  env = process.env,
  { requirePin = true, repoRoot = REPO_ROOT, platform = process.platform } = {},
) {
  const expectedVersion = env.TS_PROBE_PINNED_VERSION?.trim() || "0.20.2";
  const raw = env.TS_PROBE_PINNED_DIST?.trim();

  if (!raw) {
    if (requirePin) {
      refuse(
        "no-pinned-build",
        `TS_PROBE_PINNED_DIST is unset. CURRENT arms must run against a build of tag v${expectedVersion} made ` +
          "OUTSIDE this working tree -- the working tree's dist/ contains the fixes the probes exist to gate, so " +
          "a CURRENT arm taken from it would record the FIXED request and prove nothing. See CONTRIBUTING.md, " +
          '"Live shape probes".',
      );
    }
    return { dir: resolve(repoRoot, "dist"), version: null, pinned: false, expectedVersion };
  }

  // An MSYS/Git Bash path (`/c/Users/...`) is not a Windows path. Node's win32
  // resolver turns it into `C:\c\Users\...`, and every later check then names a
  // directory that looks almost right. Say what actually happened instead.
  if (platform === "win32" && /^\/[A-Za-z]\//.test(raw)) {
    refuse(
      "pinned-build-msys-path",
      `TS_PROBE_PINNED_DIST is ${JSON.stringify(raw)}, an MSYS/Git Bash path. Node on Windows resolves that to ` +
        `${resolve(raw)}, which is not where the build is. In Git Bash use \`pwd -W\` (or \`cygpath -w "$(pwd)"\`) ` +
        "so the value is a Windows path such as C:/Users/you/tailscale-mcp-v0.20.2/dist.",
    );
  }

  const dir = resolve(raw);
  if (isInside(repoRoot, dir)) {
    refuse(
      "pinned-build-inside-repo",
      `TS_PROBE_PINNED_DIST points at ${dir}, which is inside this working tree. Build tag v${expectedVersion} in ` +
        "a separate checkout (git worktree) so the working tree cannot change what a CURRENT arm emits.",
    );
  }
  if (!existsSync(resolve(dir, "api.js"))) {
    refuse("pinned-build-missing", `No api.js under ${dir}. Point TS_PROBE_PINNED_DIST at the built dist/ directory.`);
  }

  const version = readPinnedVersion(dir);
  if (version !== expectedVersion) {
    refuse(
      "pinned-build-version",
      `The build at ${dir} reports version ${JSON.stringify(version ?? "unknown")}, not ${expectedVersion}. ` +
        "CURRENT arms must come from the shipped build the probes are about.",
    );
  }
  return { dir, version, pinned: true, expectedVersion };
}

function readPinnedVersion(distDir) {
  const candidate = resolve(distDir, "..", "package.json");
  if (!existsSync(candidate)) return null;
  try {
    return JSON.parse(readFileSync(candidate, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * G7. Dry run is the default: --execute has to be typed, and everything that
 * could send a request goes through here first.
 */
export function assertExecuteAllowed({ execute, command }) {
  if (execute !== true) {
    refuse(
      "dry-run",
      `${command} would send live requests. Dry run is the default -- re-run with --execute once the printed ` +
        "request list is what you want sent.",
    );
  }
  return true;
}
