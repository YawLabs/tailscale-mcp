import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// scripts/build-binary-oam.mjs takes the cross-build carrier's sha256 from oam's
// SIGNED RELEASE-MANIFEST. The verifier lives in scripts/lib, which tsconfig does
// not include, so it is imported from there the way live-fixtures.test.ts loads
// the probe harness.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Verified = { tag: string; principal: string; sums: Map<string, string> };
type Lib = {
  MANIFEST_HEADER: string;
  DEFAULT_KEYS_DIR: string;
  normalizeTag(tag: string): string | null;
  parseRanges(text: string): Map<string, { from: string; to: string | null }>;
  parsePrincipals(text: string): string[];
  tagInRange(ranges: Map<string, { from: string; to: string | null }>, principal: string, tag: string): boolean;
  predatesSigning(ranges: Map<string, { from: string; to: string | null }>, tag: string): boolean;
  parseSums(text: string): Map<string, string>;
  findSshKeygen(): string | null;
  verifyManifest(opts: {
    manifest: Buffer;
    sig: Buffer;
    expectedTag?: string | null;
    keysDir?: string;
    sshKeygen: string | null;
  }): Verified;
};

const lib = (await import(pathToFileURL(resolve(repoRoot, "scripts/lib/oam-release-verify.mjs")).href)) as Lib;

describe("oam release keys vendored for build-binary-oam", () => {
  it("names oam-release-k1, which signs from v0.18.0", () => {
    // A copy of oam's release-keys/allowed_signers and ranges. An emptied or
    // mangled copy would make every verification fail, which is loud -- but a
    // range that opened later would wrongly refuse v0.18.0, so pin it.
    const keys = lib.DEFAULT_KEYS_DIR;
    const principals = lib.parsePrincipals(readFileSync(join(keys, "allowed_signers"), "utf-8"));
    assert.ok(principals.includes("oam-release-k1"), JSON.stringify(principals));
    const ranges = lib.parseRanges(readFileSync(join(keys, "ranges"), "utf-8"));
    assert.equal(lib.tagInRange(ranges, "oam-release-k1", "v0.18.0"), true);
    assert.equal(lib.predatesSigning(ranges, "v0.17.1"), true, "the fallback to SHA256SUMS is for pre-0.18.0 tags");
    assert.equal(lib.predatesSigning(ranges, "v0.18.0"), false);
    assert.equal(lib.predatesSigning(ranges, "v1.0.0"), false, "a later tag with no manifest must not fall back");
  });
});

describe("oam release manifest helpers", () => {
  it("normalizes tags and refuses anything but X.Y.Z", () => {
    assert.equal(lib.normalizeTag("0.18.0"), "v0.18.0");
    assert.equal(lib.normalizeTag("v0.18.0"), "v0.18.0");
    assert.equal(lib.normalizeTag("latest"), null);
    assert.equal(lib.normalizeTag("v0.18"), null);
  });

  it("checks ranges numerically, inclusive at both ends", () => {
    const ranges = lib.parseRanges("# comment\nk1 v0.18.0 v0.21.3\nk2 v0.21.4 -\n");
    assert.equal(lib.tagInRange(ranges, "oam-release-k1", "v0.100.0"), false, "0.100.0 sorts before 0.21.3 as text");
    assert.equal(lib.tagInRange(ranges, "oam-release-k1", "v0.21.3"), true);
    assert.equal(lib.tagInRange(ranges, "oam-release-k1", "v0.21.4"), false, "a retired key may not sign later tags");
    assert.equal(lib.tagInRange(ranges, "oam-release-k2", "v0.21.4"), true);
    assert.equal(lib.tagInRange(ranges, "oam-release-k3", "v0.21.4"), false, "a key with no range signs nothing");
  });

  it("refuses a malformed ranges line rather than guessing", () => {
    assert.throws(() => lib.parseRanges("k1 v0.18.0\n"), /malformed/);
    assert.throws(() => lib.parseRanges("k1 v0.18.0 -\nk1 v0.19.0 -\n"), /more than one line/);
  });

  it("parses SHA256SUMS in both text and binary mode", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const sums = lib.parseSums(`${a}  oam-x86_64-unknown-linux-gnu\n${b} *oam-x86_64-pc-windows-msvc.exe\n`);
    assert.equal(sums.get("oam-x86_64-unknown-linux-gnu"), a);
    assert.equal(sums.get("oam-x86_64-pc-windows-msvc.exe"), "b".repeat(64));
  });

  it("refuses to verify without an ssh-keygen", () => {
    assert.throws(
      () => lib.verifyManifest({ manifest: Buffer.from(""), sig: Buffer.from(""), sshKeygen: null }),
      /no ssh-keygen that supports `-Y verify`/,
    );
  });
});

const sshKeygen = lib.findSshKeygen();

describe("verifyManifest against a throwaway release key", {
  skip: !sshKeygen && "no ssh-keygen with -Y verify",
}, () => {
  // A real signature from a key made here, with the same principal, namespace
  // and file layout as oam's -- so every check runs through ssh-keygen for real,
  // offline.
  const keygen = sshKeygen as string;
  let dir = "";
  let keysDir = "";
  let key = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "tailscale-mcp-oam-sign-"));
    keysDir = join(dir, "keys");
    mkdirSync(keysDir);
    key = join(dir, "k1");
    execFileSync(keygen, ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", key], { stdio: "ignore" });
    const pub = readFileSync(`${key}.pub`, "utf-8").trim().split(/\s+/).slice(0, 2).join(" ");
    writeFileSync(join(keysDir, "allowed_signers"), `oam-release-k1 namespaces="oam-release" ${pub}\n`);
    writeFileSync(join(keysDir, "ranges"), "k1 v0.18.0 -\n");
  });
  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const SHA = "c".repeat(64);
  function signed(body: string, namespace = "oam-release"): { manifest: Buffer; sig: Buffer } {
    const file = join(dir, `m-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, body);
    execFileSync(keygen, ["-Y", "sign", "-f", key, "-n", namespace, file], { stdio: "ignore" });
    return { manifest: readFileSync(file), sig: readFileSync(`${file}.sig`) };
  }
  const good = (tag: string) => `${lib.MANIFEST_HEADER}\ntag ${tag}\n${SHA}  oam-x86_64-unknown-linux-gnu\n`;

  it("accepts a good manifest and returns its tag and sums", () => {
    const v = lib.verifyManifest({ ...signed(good("v0.18.0")), keysDir, sshKeygen: keygen });
    assert.equal(v.tag, "v0.18.0");
    assert.equal(v.principal, "oam-release-k1");
    assert.equal(v.sums.get("oam-x86_64-unknown-linux-gnu"), SHA);
  });

  it("refuses a manifest altered after signing", () => {
    const { manifest, sig } = signed(good("v0.18.0"));
    const tampered = Buffer.from(manifest.toString().replace(SHA, "d".repeat(64)));
    assert.throws(() => lib.verifyManifest({ manifest: tampered, sig, keysDir, sshKeygen: keygen }), /does not verify/);
  });

  it("refuses a signature made for another namespace", () => {
    assert.throws(
      () => lib.verifyManifest({ ...signed(good("v0.18.0"), "file"), keysDir, sshKeygen: keygen }),
      /does not verify/,
    );
  });

  it("refuses a manifest for a different tag than the one pinned", () => {
    assert.throws(
      () => lib.verifyManifest({ ...signed(good("v0.18.0")), expectedTag: "v0.19.0", keysDir, sshKeygen: keygen }),
      /signed for v0\.18\.0, not v0\.19\.0/,
    );
  });

  it("refuses a tag outside the signing key's range", () => {
    assert.throws(
      () => lib.verifyManifest({ ...signed(good("v0.17.0")), keysDir, sshKeygen: keygen }),
      /may not sign v0\.17\.0/,
    );
  });

  it("refuses a wrong header even when it is signed", () => {
    assert.throws(
      () =>
        lib.verifyManifest({
          ...signed(`oam-release-manifest v2\ntag v0.18.0\n${SHA}  x\n`),
          keysDir,
          sshKeygen: keygen,
        }),
      /line 1/,
    );
  });
});
