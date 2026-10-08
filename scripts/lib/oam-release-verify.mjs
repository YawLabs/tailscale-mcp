/**
 * Verify an oam release's signed RELEASE-MANIFEST, for scripts/build-binary-oam.mjs.
 *
 * From v0.18.0 every oam release carries RELEASE-MANIFEST -- the line
 * `oam-release-manifest v1`, then `tag <tag>`, then that release's SHA256SUMS --
 * and RELEASE-MANIFEST.sig, an SSH signature over it. oam's installers and
 * `oam self-update` take a binary's checksum from the manifest, not from the
 * unsigned SHA256SUMS beside it, and this does the same: a SHA256SUMS fetched
 * from the same place as the binary proves only that the two were uploaded
 * together.
 *
 * The trust root is vendored in scripts/oam-release-keys/ -- allowed_signers and
 * ranges, copied verbatim from oam's release-keys/ -- rather than fetched, for
 * the same reason. A manifest is accepted only when:
 *   1. `ssh-keygen -Y verify` accepts its signature for a principal in
 *      allowed_signers, under the namespace `oam-release`;
 *   2. its first two lines are, byte for byte, the v1 header and `tag <tag>`
 *      (and, when the caller pinned one, that tag is the one asked for);
 *   3. the signing key's line in ranges covers that tag.
 * The content is only parsed AFTER the signature verifies: until then it is
 * attacker-controlled.
 *
 * Everything fails closed. No ssh-keygen able to run `-Y verify` (OpenSSH 8.1+)
 * is an error, not a reason to fall back; the unsigned SHA256SUMS is used only
 * for a tag older than every range's start, which was released before signing
 * existed and has no manifest to verify.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_HEADER = "oam-release-manifest v1";
export const SIGN_NAMESPACE = "oam-release";
export const PRINCIPAL_PREFIX = "oam-release-";

/** The vendored trust root. */
export const DEFAULT_KEYS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "oam-release-keys");

const PLAIN_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** `v1.2.3` or `1.2.3` -> `v1.2.3`; anything else -> null. */
export function normalizeTag(tag) {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(String(tag ?? "").trim());
  return m ? `v${m[1]}` : null;
}

/** Compare two plain vX.Y.Z tags numerically: -1, 0 or 1. */
export function compareTags(a, b) {
  const pa = PLAIN_TAG.exec(a);
  const pb = PLAIN_TAG.exec(b);
  if (!pa || !pb) throw new Error(`not a plain vX.Y.Z tag: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Non-comment, non-blank lines. */
function meaningfulLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** The principals in an allowed_signers file, in file order. */
export function parsePrincipals(allowedSignersText) {
  return meaningfulLines(allowedSignersText)
    .map((l) => l.split(/\s+/)[0])
    .filter((p) => p.startsWith(PRINCIPAL_PREFIX));
}

/** ranges -> Map<id, { from, to }>, `to` null for an open range. */
export function parseRanges(rangesText) {
  const ranges = new Map();
  for (const line of meaningfulLines(rangesText)) {
    const [id, from, to, extra] = line.split(/\s+/);
    if (!id || !from || !to || extra !== undefined || !PLAIN_TAG.test(from) || (to !== "-" && !PLAIN_TAG.test(to))) {
      throw new Error(`ranges: malformed line '${line}'`);
    }
    if (ranges.has(id)) throw new Error(`ranges: '${id}' has more than one line`);
    ranges.set(id, { from, to: to === "-" ? null : to });
  }
  return ranges;
}

/** True when `principal` may have signed `tag` under `ranges`. */
export function tagInRange(ranges, principal, tag) {
  const range = ranges.get(principal.slice(PRINCIPAL_PREFIX.length));
  if (!range) return false;
  if (compareTags(range.from, tag) > 0) return false;
  return range.to === null || compareTags(tag, range.to) <= 0;
}

/** True when `tag` is older than every range's start: released before signing existed. */
export function predatesSigning(ranges, tag) {
  for (const { from } of ranges.values()) {
    if (compareTags(from, tag) <= 0) return false;
  }
  return true;
}

/**
 * An ssh-keygen that can run `-Y verify`, or null. PATH first; on Windows the
 * inbox OpenSSH as well, which is not always on PATH. OAM_SSH_KEYGEN overrides.
 */
export function findSshKeygen(env = process.env) {
  const candidates = [];
  if (env.OAM_SSH_KEYGEN) candidates.push(env.OAM_SSH_KEYGEN);
  candidates.push("ssh-keygen");
  if (process.platform === "win32") {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    candidates.push(join(root, "Sysnative", "OpenSSH", "ssh-keygen.exe"));
    candidates.push(join(root, "System32", "OpenSSH", "ssh-keygen.exe"));
  }
  for (const candidate of candidates) {
    if (candidate.includes("\\") || candidate.includes("/")) {
      if (!existsSync(candidate)) continue;
    }
    try {
      // `-Y verify` with no namespace exits non-zero on 8.1+ ("Too few
      // arguments for verify: missing namespace"); an older ssh-keygen rejects
      // `-Y` as an unknown option. Either way it ran, so the text is what tells
      // them apart.
      execFileSync(candidate, ["-Y", "verify"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      return candidate;
    } catch (err) {
      const text = `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
      if (err?.code !== "ENOENT" && /namespace|-Y verify|find-principals/i.test(text)) return candidate;
    }
  }
  return null;
}

/**
 * Verify `manifest` (Buffer) against `sig` (Buffer). Returns
 * `{ tag, principal, sums }` where `sums` maps asset name -> sha256 hex.
 * Throws an Error naming the first check that failed.
 *
 * `expectedTag`, when given, must be the tag inside the manifest; pass null for
 * a `latest` download, where the manifest is what says which tag it is.
 */
export function verifyManifest({ manifest, sig, expectedTag = null, keysDir = DEFAULT_KEYS_DIR, sshKeygen }) {
  if (!sshKeygen) {
    throw new Error(
      "no ssh-keygen that supports `-Y verify` (OpenSSH 8.1 or newer) was found; it is needed to verify the oam " +
        "release signature. Install OpenSSH, or point OAM_SSH_KEYGEN at one.",
    );
  }
  const allowedSigners = join(keysDir, "allowed_signers");
  const principals = parsePrincipals(readFileSync(allowedSigners, "utf-8"));
  const ranges = parseRanges(readFileSync(join(keysDir, "ranges"), "utf-8"));
  if (principals.length === 0) throw new Error(`${allowedSigners} holds no release key`);

  const work = mkdtempSync(join(tmpdir(), "oam-manifest-"));
  let principal = null;
  let last = "";
  try {
    const sigPath = join(work, "RELEASE-MANIFEST.sig");
    writeFileSync(sigPath, sig);
    for (const candidate of principals) {
      try {
        execFileSync(
          sshKeygen,
          ["-Y", "verify", "-f", allowedSigners, "-I", candidate, "-n", SIGN_NAMESPACE, "-s", sigPath],
          { input: manifest, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        );
        principal = candidate;
        break;
      } catch (err) {
        last = `${err?.stderr ?? err?.message ?? err}`.trim();
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (!principal) {
    throw new Error(
      `RELEASE-MANIFEST.sig does not verify against any key in ${allowedSigners} (namespace ${SIGN_NAMESPACE})` +
        (last ? `: ${last}` : ""),
    );
  }

  // Signed, so the content can be read now. The header is compared as bytes.
  const text = manifest.toString("latin1");
  const nl1 = text.indexOf("\n");
  const nl2 = nl1 === -1 ? -1 : text.indexOf("\n", nl1 + 1);
  if (nl2 === -1) throw new Error("RELEASE-MANIFEST has no two-line header");
  const line1 = text.slice(0, nl1);
  const line2 = text.slice(nl1 + 1, nl2);
  if (line1 !== MANIFEST_HEADER) throw new Error(`RELEASE-MANIFEST line 1 is '${line1}', not '${MANIFEST_HEADER}'`);
  const tagMatch = /^tag (v\d+\.\d+\.\d+)$/.exec(line2);
  if (!tagMatch) throw new Error(`RELEASE-MANIFEST line 2 is '${line2}', not 'tag vX.Y.Z'`);
  const tag = tagMatch[1];
  if (expectedTag !== null && tag !== expectedTag) {
    throw new Error(`RELEASE-MANIFEST is signed for ${tag}, not ${expectedTag} -- a replayed or misfiled release`);
  }
  if (!tagInRange(ranges, principal, tag)) {
    throw new Error(`${principal} may not sign ${tag} (scripts/oam-release-keys/ranges)`);
  }

  const sums = parseSums(text.slice(nl2 + 1));
  return { tag, principal, sums };
}

/** SHA256SUMS text -> Map<name, sha256>. `*name` (binary mode) is accepted. */
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64}) [ *]?(\S+)\s*$/i.exec(line.trim());
    if (m) sums.set(m[2].replace(/^\*/, ""), m[1].toLowerCase());
  }
  return sums;
}
