/**
 * Offline gate for the live shape probe harness (scripts/live-probe.mjs).
 *
 * This repo runs no CI, so `npm test` is the only gate that exists. Three
 * things are checked here, and all three are the kind of mistake that is cheap
 * to make and expensive to discover later:
 *
 *  1. FIXTURE INTEGRITY. A recorded exchange that still carries a `tskey-`, a
 *     real email address, a control-plane id, an invite code or an
 *     Authorization header must never reach a commit. The scanner runs against
 *     the real fixtures/live (empty today, and it stays passing as fixtures
 *     land) and, to prove it can actually fail, against a temp directory of
 *     deliberately planted bad ones.
 *  2. THE REFUSALS. Every interlock in probe-guard.mjs is exercised by the
 *     refusal it exists for. A guard nobody has seen refuse anything is a guard
 *     nobody knows works.
 *  3. THE DRY RUN SENDS NOTHING. `run --all` without --execute is checked with
 *     a fetch stub that throws on any call, in-process and again as a real
 *     child process, and the stub's call count must be zero.
 *
 * The harness itself is .mjs outside src/, so tsc does not compile it and it is
 * loaded here by URL at run time. Deliberate: a probe living under src/ would
 * be swept up by the integration suite's RUN_INTEGRATION_TESTS gate, which runs
 * on the operator's ambient credentials.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = resolve(repoRoot, "fixtures", "live");

// Loaded by URL because these are .mjs files outside src/ that tsc never sees.
// The specifier is computed, so it is not a module TypeScript tries to resolve.
async function loadHarness(relPath: string) {
  return import(pathToFileURL(resolve(repoRoot, relPath)).href);
}

/* ------------------------------------------------------- fixture scanner -- */

type Finding = { file: string; why: string };

const CONTROL_PLANE_ID = /\b[0-9a-zA-Z]{5,}CNTRL\b/;
const BARE_TSKEY = /tskey-/;
const INVITE_CODE = /\/admin\/invite\/[A-Za-z0-9]/;
const RAW_TS_NET = /\btail[0-9a-f]+\.ts\.net\b/;
const BEARER = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const EXAMPLE_DOMAINS = /@example\.(com|org|net)$/;

function fixtureFiles(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) fixtureFiles(path, out);
    else if (entry.name.endsWith(".json")) out.push(path);
  }
  return out;
}

/**
 * Scan one directory of fixtures. Returns findings rather than throwing, so the
 * planted-fixture test can assert WHICH rule fired rather than just that
 * something did.
 */
function scanLiveFixtures(root: string, requiredProvenanceKeys: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of fixtureFiles(root)) {
    const text = readFileSync(file, "utf-8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      findings.push({ file, why: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const provenance = parsed.provenance as Record<string, unknown> | undefined;
    if (!provenance || typeof provenance !== "object") {
      findings.push({ file, why: "missing provenance" });
    } else {
      for (const key of requiredProvenanceKeys) {
        if (!(key in provenance)) findings.push({ file, why: `provenance is missing ${key}` });
      }
    }

    // The redaction placeholders come out first: `<redacted:tskey>` must not
    // read as a leaked key, and `Bearer <redacted:credential>` must not read as
    // a leaked token.
    const scrubbed = text.replace(/<redacted(:[a-z-]+)?>/g, "");
    if (BARE_TSKEY.test(scrubbed)) findings.push({ file, why: "contains a tskey- prefix" });
    if (CONTROL_PLANE_ID.test(scrubbed)) findings.push({ file, why: "contains a raw control-plane id" });
    if (INVITE_CODE.test(scrubbed)) findings.push({ file, why: "contains an invite code" });
    if (RAW_TS_NET.test(scrubbed)) findings.push({ file, why: "contains a raw tailNNNN.ts.net name" });
    if (BEARER.test(scrubbed)) findings.push({ file, why: "contains an Authorization credential" });

    for (const email of scrubbed.match(EMAIL) ?? []) {
      if (!EXAMPLE_DOMAINS.test(email)) findings.push({ file, why: `contains a non-example email (${email})` });
    }

    const requestHeaders = (parsed.request as { headers?: Record<string, string> } | null)?.headers ?? {};
    for (const name of Object.keys(requestHeaders)) {
      if (name.toLowerCase() === "authorization") findings.push({ file, why: "kept an Authorization header" });
    }
  }
  return findings;
}

function plantFixture(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body, null, 2), "utf-8");
}

function goodProvenance(): Record<string, unknown> {
  return {
    capturedAt: "2026-01-01T00:00:00.000Z",
    harness: "scripts/live-probe.mjs",
    packageVersion: "0.20.2",
    gitHead: "0".repeat(40),
    targetKind: "api-only",
    credentialKind: "oauth",
    pinnedBuildVersion: "0.20.2",
  };
}

describe("live fixture integrity", () => {
  it("passes on the committed fixtures/live", async () => {
    const { REQUIRED_PROVENANCE_KEYS } = await loadHarness("scripts/lib/probe-recorder.mjs");
    const findings = scanLiveFixtures(FIXTURE_ROOT, REQUIRED_PROVENANCE_KEYS);
    assert.deepEqual(
      findings,
      [],
      `fixtures/live is not clean:\n${findings.map((f) => `${f.file}: ${f.why}`).join("\n")}`,
    );
  });

  it("fixtures/live ships empty, because nothing has been observed yet", () => {
    // If this ever fails, someone recorded a real observation -- which is the
    // point of the harness. Update the changelog wording tier at the same time:
    // an UNOBSERVED claim must not survive the first fixture.
    assert.deepEqual(fixtureFiles(FIXTURE_ROOT), []);
  });

  it("goes red on a planted tskey-, email, control-plane id, invite code or missing provenance", async () => {
    const { REQUIRED_PROVENANCE_KEYS } = await loadHarness("scripts/lib/probe-recorder.mjs");
    const tmp = mkdtempSync(resolve(tmpdir(), "yaw-bad-fixtures-"));
    try {
      const dir = join(tmp, "P8-C5-key-put");
      plantFixture(dir, "01-seed-leaked-key.json", {
        probeId: "P8-C5-key-put",
        step: 1,
        arm: "seed",
        provenance: goodProvenance(),
        response: { status: 200, body: { id: "k1", key: "tskey-auth-kAbCdEf-notreal" } },
      });
      plantFixture(dir, "02-observe-real-email.json", {
        probeId: "P8-C5-key-put",
        step: 2,
        arm: "observe",
        provenance: goodProvenance(),
        response: { status: 200, body: { userName: "someone@realcompany.io" } },
      });
      plantFixture(dir, "03-observe-control-plane-id.json", {
        probeId: "P8-C5-key-put",
        step: 3,
        arm: "observe",
        provenance: goodProvenance(),
        response: { status: 200, body: { nodeId: "nabc123CNTRL", dnsName: "box.tail1a2b3c.ts.net" } },
      });
      plantFixture(dir, "04-current-invite-code.json", {
        probeId: "P8-C5-key-put",
        step: 4,
        arm: "current",
        provenance: goodProvenance(),
        response: { status: 200, body: { inviteUrl: "https://login.tailscale.com/admin/invite/xK3p9QzA" } },
      });
      plantFixture(dir, "05-current-no-provenance.json", {
        probeId: "P8-C5-key-put",
        step: 5,
        arm: "current",
        response: { status: 200, body: {} },
      });
      plantFixture(dir, "06-current-authorization-header.json", {
        probeId: "P8-C5-key-put",
        step: 6,
        arm: "current",
        provenance: goodProvenance(),
        request: {
          method: "GET",
          path: "/tailnet/{tailnet}/keys",
          headers: { Authorization: "Basic abc" },
          body: null,
        },
        response: { status: 200, body: {} },
      });

      const whys = scanLiveFixtures(tmp, REQUIRED_PROVENANCE_KEYS).map((f) => f.why);
      const report = JSON.stringify(whys);
      assert.ok(
        whys.some((w) => w.includes("tskey-")),
        report,
      );
      assert.ok(
        whys.some((w) => w.includes("non-example email")),
        report,
      );
      assert.ok(
        whys.some((w) => w.includes("control-plane id")),
        report,
      );
      assert.ok(
        whys.some((w) => w.includes("tailNNNN.ts.net")),
        report,
      );
      assert.ok(
        whys.some((w) => w.includes("invite code")),
        report,
      );
      assert.ok(
        whys.some((w) => w === "missing provenance"),
        report,
      );
      assert.ok(
        whys.some((w) => w.includes("Authorization header")),
        report,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not mistake a redaction placeholder for the thing it replaced", async () => {
    const { REQUIRED_PROVENANCE_KEYS } = await loadHarness("scripts/lib/probe-recorder.mjs");
    const tmp = mkdtempSync(resolve(tmpdir(), "yaw-ok-fixtures-"));
    try {
      plantFixture(join(tmp, "P2-C1-user-invite"), "02-current-redacted.json", {
        probeId: "P2-C1-user-invite",
        step: 2,
        arm: "current",
        provenance: goodProvenance(),
        request: { method: "POST", path: "/tailnet/{tailnet}/user-invites", headers: {}, body: {} },
        response: {
          status: 200,
          headers: {},
          body: { id: "inv-1", inviteUrl: "<redacted>", email: "user@example.com", host: "tailXXXX.ts.net" },
        },
      });
      assert.deepEqual(scanLiveFixtures(tmp, REQUIRED_PROVENANCE_KEYS), []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/* ---------------------------------------------------------- the refusals -- */

async function guard() {
  return loadHarness("scripts/lib/probe-guard.mjs");
}

function refusalCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "<no code>";
  }
  throw new Error("expected a ProbeRefusal, but nothing was thrown");
}

describe("probe guard refusals", () => {
  it("G0 strips every TAILSCALE_* name and keeps only a fingerprint of the key", async () => {
    const g = await guard();
    const env: Record<string, string> = {
      TAILSCALE_API_KEY: "tskey-api-REAL",
      TAILSCALE_TAILNET: "real.example.com",
      TAILSCALE_OAUTH_TAILNET: "other.example.com",
      TAILSCALE_DEBUG: "1",
      TS_PROBE_TAILNET_ID: "probe-1",
    };
    const { removed, ambient } = g.stripAmbientCredentials(env);
    assert.deepEqual(removed, ["TAILSCALE_API_KEY", "TAILSCALE_DEBUG", "TAILSCALE_OAUTH_TAILNET", "TAILSCALE_TAILNET"]);
    assert.equal(env.TAILSCALE_API_KEY, undefined);
    assert.equal(env.TS_PROBE_TAILNET_ID, "probe-1");
    assert.equal(ambient.apiKeyFingerprint, g.fingerprint("tskey-api-REAL"));
    assert.equal(ambient.tailnet, "real.example.com");
    assert.equal(ambient.oauthTailnet, "other.example.com");
    // The value itself is gone: only the hash survives.
    assert.ok(!JSON.stringify(ambient).includes("tskey-api-REAL"));
  });

  it("G0 refuses a probe credential that IS the ambient key", async () => {
    const g = await guard();
    const ambient = { apiKeyFingerprint: g.fingerprint("tskey-api-REAL"), oauthSecretFingerprint: null };
    assert.equal(
      refusalCode(() => g.assertCredentialIsolation({ TS_PROBE_API_KEY: "tskey-api-REAL" }, ambient)),
      "ambient-credential-reused",
    );
    // A different credential is fine.
    g.assertCredentialIsolation({ TS_PROBE_API_KEY: "tskey-api-PROBE" }, ambient);
  });

  it('G1 refuses "-", an empty forbidden list, and a forbidden target', async () => {
    const g = await guard();
    assert.equal(
      refusalCode(() => g.assertExplicitTarget("-", ["real.example.com"])),
      "bare-tailnet-target",
    );
    assert.equal(
      refusalCode(() => g.assertExplicitTarget("", ["real.example.com"])),
      "no-target",
    );
    assert.equal(
      refusalCode(() => g.assertExplicitTarget("probe-1", [])),
      "empty-forbidden-list",
    );
    assert.equal(
      refusalCode(() => g.assertExplicitTarget("Real.Example.com", ["real.example.com"])),
      "forbidden-target",
    );
    assert.equal(g.assertExplicitTarget("probe-1", ["real.example.com"]), "probe-1");
  });

  it("G1 does not let a null entry pad the forbidden list", async () => {
    const g = await guard();
    // String(null) is "null" -- an entry that would quietly satisfy the
    // non-empty check without forbidding anything.
    assert.deepEqual(g.normalizeForbidden([null, undefined, "", " ", "-"]), []);
    assert.equal(
      refusalCode(() => g.assertExplicitTarget("probe-1", [null, undefined])),
      "empty-forbidden-list",
    );
  });

  it("G2 refuses a target with no, mismatched, wrongly named or stale provenance", async () => {
    const g = await guard();
    const now = Date.parse("2026-02-01T00:00:00Z");
    assert.equal(
      refusalCode(() => g.assertProvenance(undefined, "probe-1", now)),
      "no-provenance",
    );
    assert.equal(
      refusalCode(() => g.assertProvenance({ createdByHarness: false }, "probe-1", now)),
      "no-provenance",
    );
    assert.equal(
      refusalCode(() =>
        g.assertProvenance({ createdByHarness: true, tailnetId: "other", displayName: "yaw-probe-x" }, "probe-1", now),
      ),
      "provenance-mismatch",
    );
    assert.equal(
      refusalCode(() =>
        g.assertProvenance({ createdByHarness: true, tailnetId: "probe-1", displayName: "prod" }, "probe-1", now),
      ),
      "provenance-name",
    );
    assert.equal(
      refusalCode(() =>
        g.assertProvenance(
          {
            createdByHarness: true,
            tailnetId: "probe-1",
            displayName: "yaw-probe-x",
            createdAt: "2026-01-01T00:00:00Z",
          },
          "probe-1",
          now,
        ),
      ),
      "provenance-age",
    );
    const fresh = {
      createdByHarness: true,
      tailnetId: "probe-1",
      displayName: "yaw-probe-x",
      createdAt: "2026-01-31T00:00:00Z",
    };
    assert.equal(g.assertProvenance(fresh, "probe-1", now), fresh);
  });

  it("G3 refuses an unexpected user, a foreign device or DNS the harness did not seed", async () => {
    const g = await guard();
    assert.equal(
      refusalCode(() =>
        g.assertServerAttestedEmptiness({ users: { users: [{ loginName: "someone@real.io" }] }, devices: [] }),
      ),
      "target-not-empty",
    );
    assert.equal(
      refusalCode(() =>
        g.assertServerAttestedEmptiness({ users: [], devices: { devices: [{ hostname: "prod-db-1" }] } }),
      ),
      "target-not-empty",
    );
    assert.equal(
      refusalCode(() =>
        g.assertServerAttestedEmptiness({
          users: [],
          devices: [],
          dnsConfiguration: { searchPaths: ["corp.realcompany.io"] },
        }),
      ),
      "target-not-empty",
    );
    // Target B's one expected human, a yaw-probe- node and harness-seeded DNS all pass.
    const ok = g.assertServerAttestedEmptiness({
      users: { users: [{ loginName: "Probe@Example.com" }] },
      devices: { devices: [{ hostname: "yaw-probe-node-1" }] },
      dnsConfiguration: { searchPaths: ["c2.yaw-probe.example.com"], splitDNS: { "corp.yaw-probe.example.com": [] } },
      expectLogin: "probe@example.com",
      targetKind: "human",
    });
    assert.equal(ok.userCount, 1);
    assert.equal(ok.deviceCount, 1);
  });

  it("G4 refuses a typed confirmation that does not match byte for byte", async () => {
    const g = await guard();
    assert.equal(
      refusalCode(() => g.assertTypedConfirmation("probe-1 ", "probe-1")),
      "confirmation-mismatch",
    );
    assert.equal(
      refusalCode(() => g.assertTypedConfirmation(undefined, "probe-1")),
      "confirmation-mismatch",
    );
    assert.equal(g.assertTypedConfirmation("probe-1", "probe-1"), true);
  });

  it("G6 refuses an unsafe probe on an unattested target, and a write without its flag", async () => {
    const g = await guard();
    const unsafe = { probeId: "P4c", safetyClass: "unsafe-needs-disposable-tailnet" };
    const write = { probeId: "P7", safetyClass: "safe-reversible-write" };
    const read = { probeId: "P1", safetyClass: "safe-read-only" };

    assert.equal(
      refusalCode(() => g.assertSafetyClassWiring(unsafe, { targetIsAttested: false })),
      "unattested-target",
    );
    // No flag exists that lets an unsafe probe onto an unattested target.
    assert.equal(
      refusalCode(() =>
        g.assertSafetyClassWiring(unsafe, {
          targetIsAttested: false,
          allowRealReversible: ["P4c"],
          allowRealReadonly: true,
        }),
      ),
      "unattested-target",
    );
    assert.equal(
      refusalCode(() => g.assertSafetyClassWiring(write, { targetIsAttested: false })),
      "unattested-target",
    );
    assert.equal(
      refusalCode(() => g.assertSafetyClassWiring(read, { targetIsAttested: false })),
      "unattested-target",
    );

    // Named per-probe, it goes through -- and only for the probe that was named.
    g.assertSafetyClassWiring(write, { targetIsAttested: false, allowRealReversible: ["P7"] });
    assert.equal(
      refusalCode(() => g.assertSafetyClassWiring(write, { targetIsAttested: false, allowRealReversible: ["P6"] })),
      "unattested-target",
    );
    g.assertSafetyClassWiring(read, { targetIsAttested: false, allowRealReadonly: true });
    g.assertSafetyClassWiring(unsafe, { targetIsAttested: true });
    assert.equal(
      refusalCode(() => g.requiredInterlocks("made-up")),
      "unknown-safety-class",
    );
  });

  it("routes the invite probes to a human target and refuses an API-only one", async () => {
    const g = await guard();
    const { findPlan } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    const p2 = findPlan("P2-C1-user-invite");
    assert.equal(p2.requiresTargetKind, "human");
    assert.equal(
      refusalCode(() => g.assertTargetRouting(p2, "api-only")),
      "wrong-target-kind",
    );
    assert.equal(g.assertTargetRouting(p2, "human"), "human");
    // A plan with no requirement runs anywhere.
    assert.equal(g.assertTargetRouting(findPlan("P1-C6-log-end"), "api-only"), "api-only");
  });

  it("applies probe credentials without ever setting TAILSCALE_OAUTH_TAILNET", async () => {
    const g = await guard();
    const env: Record<string, string> = { TAILSCALE_OAUTH_TAILNET: "left-over" };
    const auth = g.applyProbeCredentials({ kind: "api-key", secret: "tskey-api-PROBE" }, "probe-1", env);
    assert.equal(env.TAILSCALE_TAILNET, "probe-1");
    assert.equal(env.TAILSCALE_API_KEY, "tskey-api-PROBE");
    assert.equal(env.TAILSCALE_OAUTH_TAILNET, undefined);
    // Matches what getAuthHeader builds for an API key, so it can be bound to
    // the target before a single request goes out.
    assert.equal(auth, `Basic ${Buffer.from("tskey-api-PROBE:").toString("base64")}`);

    // Switching to OAuth clears the API key -- otherwise api.ts would prefer it.
    const bearerless = g.applyProbeCredentials({ kind: "oauth", clientId: "cid", secret: "csecret" }, "probe-2", env);
    assert.equal(bearerless, null);
    assert.equal(env.TAILSCALE_API_KEY, undefined);
    assert.equal(env.TAILSCALE_OAUTH_CLIENT_ID, "cid");
    assert.equal(env.TAILSCALE_TAILNET, "probe-2");

    assert.equal(
      refusalCode(() => g.applyProbeCredentials({ kind: "api-key", secret: "x" }, "-", {})),
      "bare-tailnet-target",
    );
    assert.equal(
      refusalCode(() => g.applyProbeCredentials({ kind: "api-key", secret: "x" }, "", {})),
      "bare-tailnet-target",
    );
  });

  it("refuses a stray TAILSCALE_* name or a set TAILSCALE_OAUTH_TAILNET", async () => {
    const g = await guard();
    assert.equal(
      refusalCode(() => g.assertEnvClean({ TAILSCALE_DEBUG: "1" })),
      "stray-tailscale-env",
    );
    assert.equal(
      refusalCode(() => g.assertEnvClean({ TAILSCALE_OAUTH_TAILNET: "x" })),
      "oauth-tailnet-set",
    );
    g.assertEnvClean({ TAILSCALE_TAILNET: "probe-1", TAILSCALE_API_KEY: "k", TS_PROBE_TAILNET_ID: "probe-1" });
  });

  it("requires a pinned v0.20.2 build made outside the working tree", async () => {
    const g = await guard();
    assert.equal(
      refusalCode(() => g.resolvePinnedDist({})),
      "no-pinned-build",
    );
    assert.equal(
      refusalCode(() => g.resolvePinnedDist({ TS_PROBE_PINNED_DIST: resolve(repoRoot, "dist") })),
      "pinned-build-inside-repo",
    );
    assert.equal(
      refusalCode(() => g.resolvePinnedDist({ TS_PROBE_PINNED_DIST: resolve(tmpdir(), "no-such-build-dir") })),
      "pinned-build-missing",
    );
    // Not pinning is only allowed where nothing can be sent.
    const unpinned = g.resolvePinnedDist({}, { requirePin: false });
    assert.equal(unpinned.pinned, false);
    assert.equal(unpinned.expectedVersion, "0.20.2");
  });

  it("refuses a pinned build whose version is not the shipped one", async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "yaw-pinned-"));
    try {
      const dist = join(tmp, "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "api.js"), "export const x = 1;\n", "utf-8");
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "0.19.0" }), "utf-8");
      const g = await guard();
      assert.equal(
        refusalCode(() => g.resolvePinnedDist({ TS_PROBE_PINNED_DIST: dist })),
        "pinned-build-version",
      );
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "0.20.2" }), "utf-8");
      const ok = g.resolvePinnedDist({ TS_PROBE_PINNED_DIST: dist });
      assert.equal(ok.pinned, true);
      assert.equal(ok.version, "0.20.2");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the state file out of the repo unless git already ignores it", async () => {
    const g = await guard();
    const inside = resolve(repoRoot, "probe-state.json");
    assert.equal(
      refusalCode(() => g.assertStatePathSafe(inside, { repoRoot, git: () => false })),
      "state-file-not-ignored",
    );
    assert.deepEqual(g.assertStatePathSafe(inside, { repoRoot, git: () => true }), {
      path: inside,
      insideRepo: true,
      ignored: true,
    });
    const outside = resolve(tmpdir(), "yaw-probe-state", "probe-state.json");
    assert.equal(g.assertStatePathSafe(outside, { repoRoot, git: () => false }).insideRepo, false);
  });

  it("treats the repo root itself as inside and a sibling directory as outside", async () => {
    const g = await guard();
    // relative() returns "" for an identical path and an absolute path across
    // Windows drives; neither starts with "..", so a naive check reads both as
    // inside the repo.
    assert.equal(g.isInside(repoRoot, repoRoot), true);
    assert.equal(g.isInside(repoRoot, resolve(repoRoot, "dist")), true);
    assert.equal(g.isInside(repoRoot, resolve(repoRoot, "..", "other-repo")), false);
  });

  it("G7 refuses anything that would send, without --execute", async () => {
    const g = await guard();
    assert.equal(
      refusalCode(() => g.assertExecuteAllowed({ execute: false, command: "run" })),
      "dry-run",
    );
    assert.equal(
      refusalCode(() => g.assertExecuteAllowed({ command: "teardown" })),
      "dry-run",
    );
    assert.equal(g.assertExecuteAllowed({ execute: true, command: "run" }), true);
  });
});

describe("probe egress guard", () => {
  async function makeGuard(overrides: Record<string, unknown> = {}) {
    const g = await guard();
    return g.createEgressGuard({ target: "probe-1", ...overrides });
  }

  it("refuses another origin, a non-API path and an unparseable URL", async () => {
    const eg = await makeGuard();
    assert.equal(
      refusalCode(() => eg.check("https://evil.example.com/api/v2/tailnet/probe-1/devices", "GET", "Basic x")),
      "egress-wrong-host",
    );
    assert.equal(
      refusalCode(() => eg.check("http://api.tailscale.com/api/v2/tailnet/probe-1/devices", "GET", "Basic x")),
      "egress-wrong-host",
    );
    assert.equal(
      refusalCode(() => eg.check("https://api.tailscale.com/healthz", "GET", "Basic x")),
      "egress-bad-path",
    );
    assert.equal(
      refusalCode(() => eg.check("not a url", "GET", "Basic x")),
      "egress-bad-url",
    );
  });

  it('refuses "/tailnet/-/" outright unless a probe declared the discriminator', async () => {
    const eg = await makeGuard();
    assert.equal(
      refusalCode(() => eg.check("https://api.tailscale.com/api/v2/tailnet/-/dns/searchpaths", "GET", "Bearer t")),
      "egress-bare-tailnet",
    );
    const p9 = await makeGuard({ allowBareTailnetGet: true, methods: ["GET", "POST"] });
    assert.equal(
      p9.check("https://api.tailscale.com/api/v2/tailnet/-/dns/searchpaths", "GET", "Bearer t").kind,
      "bare-tailnet-discriminator",
    );
    // Still GET only, even for the probe that asked for it.
    assert.equal(
      refusalCode(() => p9.check("https://api.tailscale.com/api/v2/tailnet/-/dns/searchpaths", "POST", "Bearer t")),
      "egress-bare-tailnet",
    );
  });

  it("refuses a tailnet that is not the declared target", async () => {
    const eg = await makeGuard();
    assert.equal(
      refusalCode(() => eg.check("https://api.tailscale.com/api/v2/tailnet/prod.example.com/acl", "GET", "Basic x")),
      "egress-wrong-tailnet",
    );
    assert.equal(
      eg.check("https://api.tailscale.com/api/v2/tailnet/probe-1/acl", "GET", "Basic x").kind,
      "tailnet-scoped",
    );
  });

  it("refuses a resource id this run never saw", async () => {
    const eg = await makeGuard();
    assert.equal(
      refusalCode(() => eg.check("https://api.tailscale.com/api/v2/webhooks/w-someone-elses", "DELETE", "Basic x")),
      "egress-unregistered-id",
    );
    eg.registerId("w-mine");
    assert.equal(
      eg.check("https://api.tailscale.com/api/v2/webhooks/w-mine", "DELETE", "Basic x").kind,
      "resource-scoped",
    );
  });

  it("enforces the per-probe method allowlist, and always permits the token POST", async () => {
    const readonly = await makeGuard({ mode: "readonly", methods: ["GET"] });
    assert.equal(
      refusalCode(() => readonly.check("https://api.tailscale.com/api/v2/tailnet/probe-1/acl", "POST", "Basic x")),
      "egress-method",
    );
    // A read-only probe authenticating with OAuth still has to mint a token.
    assert.equal(readonly.check("https://api.tailscale.com/api/v2/oauth/token", "POST", undefined).kind, "oauth-token");
    assert.equal(
      refusalCode(() => readonly.check("https://api.tailscale.com/api/v2/oauth/token", "GET", undefined)),
      "egress-method",
    );
  });

  it("refuses a path the probe's own plan never named", async () => {
    const { PATTERNS, post } = await loadHarness("scripts/lib/probe-plans/_shared.mjs");
    const eg = await makeGuard({ methods: ["POST"], allowedRequests: [post(PATTERNS.aclValidate)] });
    assert.equal(
      eg.check("https://api.tailscale.com/api/v2/tailnet/probe-1/acl/validate", "POST", "Basic x").allowed,
      true,
    );
    // POST /acl is the replace-the-whole-policy endpoint on the same prefix.
    assert.equal(
      refusalCode(() => eg.check("https://api.tailscale.com/api/v2/tailnet/probe-1/acl", "POST", "Basic x")),
      "egress-not-planned",
    );
  });

  it("refuses a credential that belongs to another target", async () => {
    const eg = await makeGuard();
    eg.setContext({ credentialTarget: "probe-1" });
    eg.check("https://api.tailscale.com/api/v2/tailnet/probe-1/acl", "GET", "Bearer token-for-A");
    eg.setContext({ credentialTarget: "creating" });
    // Same bearer, different declared target: this is the cached-token case
    // api.ts's module-global makes possible.
    assert.equal(
      refusalCode(() => eg.check("https://api.tailscale.com/api/v2/tailnet/probe-1/acl", "GET", "Bearer token-for-A")),
      "egress-credential-mismatch",
    );
  });

  it("refuses a request with no Authorization header at all", async () => {
    const eg = await makeGuard();
    assert.equal(
      refusalCode(() => eg.check("https://api.tailscale.com/api/v2/tailnet/probe-1/acl", "GET", undefined)),
      "egress-no-credential",
    );
  });

  it("refuses the organization endpoint unless provision or teardown enabled it", async () => {
    const eg = await makeGuard();
    assert.equal(
      refusalCode(() => eg.check("https://api.tailscale.com/api/v2/organizations/-/tailnets", "POST", "Bearer t")),
      "egress-org",
    );
    const provisioning = await makeGuard({ allowOrganizations: true });
    assert.equal(
      provisioning.check("https://api.tailscale.com/api/v2/organizations/-/tailnets", "POST", "Bearer t").kind,
      "organizations",
    );
  });

  it("refuses a path no plan declares, and records every block", async () => {
    const eg = await makeGuard();
    assert.equal(
      refusalCode(() => eg.check("https://api.tailscale.com/api/v2/device-invites/-/accept", "POST", "Basic x")),
      "egress-unknown-path",
    );
    assert.equal(eg.blockedRequests.length, 1);
    assert.equal(eg.blockedRequests[0].why, "path not on the allowlist");
  });
});

/* ------------------------------------------------------------- recording -- */

describe("probe recorder redaction", () => {
  it("scrubs keys, emails, tailnet names and bearer tokens out of a string", async () => {
    const r = await loadHarness("scripts/lib/probe-recorder.mjs");
    const out = r.scrubString(
      "key tskey-auth-abc123 for admin@realcompany.io on box.tail1a2b3c.ts.net in probe-1 with Bearer eyJhbGciOi",
      { tailnetId: "probe-1", forbidden: ["real.example.com"] },
    );
    assert.ok(!out.includes("tskey-auth-abc123"));
    assert.ok(!out.includes("admin@realcompany.io"));
    assert.ok(!out.includes("tail1a2b3c.ts.net"));
    assert.ok(!out.includes("eyJhbGciOi"));
    assert.ok(out.includes("{tailnet}"));
    assert.equal(
      r.scrubString("hosted on real.example.com", { forbidden: ["real.example.com"] }),
      "hosted on {forbidden-tailnet}",
    );
  });

  it("replaces secret VALUES while preserving their type", async () => {
    const r = await loadHarness("scripts/lib/probe-recorder.mjs");
    const { value, redactions } = r.redactValue({
      id: "k1",
      key: "tskey-auth-abc",
      nested: { client_secret: "s", scopes: ["devices:read"], count: 2 },
    });
    assert.equal(value.id, "k1");
    assert.equal(value.key, "<redacted>");
    assert.equal(value.nested.client_secret, "<redacted>");
    assert.deepEqual(value.nested.scopes, ["devices:read"]);
    assert.equal(value.nested.count, 2);
    assert.deepEqual(redactions.sort(), ["$.key", "$.nested.client_secret"]);
  });

  it("maps the FULL key set at every level, which is what P4a/P4b compare", async () => {
    const r = await loadHarness("scripts/lib/probe-recorder.mjs");
    const map = r.keySetMap({
      nameservers: [{ address: "1.1.1.1", useWithExitNode: true }, { address: "8.8.8.8" }],
      preferences: { magicDNS: true, overrideLocalDNS: false },
    });
    assert.deepEqual(map.$, ["nameservers", "preferences"]);
    // The union across array elements, so a ragged resolver list is visible.
    assert.deepEqual(map["$.nameservers[]"], ["address", "useWithExitNode"]);
    assert.deepEqual(map["$.preferences"], ["magicDNS", "overrideLocalDNS"]);
  });

  it("summarizes a body into counts and key sets, with no values", async () => {
    const r = await loadHarness("scripts/lib/probe-recorder.mjs");
    const summary = r.summarize({ logs: [{ eventGroupID: "g", actor: "someone@real.io" }] });
    const text = JSON.stringify(summary);
    assert.ok(text.includes("eventGroupID"));
    assert.ok(!text.includes("someone@real.io"));
    assert.equal(summary.children.logs.length, 1);
  });
});

/* ------------------------------------------------------------- the plans -- */

describe("probe plans", () => {
  const planCtx = () => ({ now: new Date("2026-01-01T00:00:00Z"), state: {}, ids: {} });

  it("every plan is well formed and every probe id is unique", async () => {
    const { PLANS } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    const seen = new Set<string>();
    const classes = new Set(["safe-read-only", "safe-reversible-write", "unsafe-needs-disposable-tailnet"]);
    for (const plan of PLANS) {
      assert.ok(!seen.has(plan.probeId), `duplicate probe id ${plan.probeId}`);
      seen.add(plan.probeId);
      assert.ok(classes.has(plan.safetyClass), `${plan.probeId}: bad safetyClass ${plan.safetyClass}`);
      for (const field of ["question", "credentialNeeds", "blastRadius", "cleanup"]) {
        assert.equal(typeof plan[field], "string", `${plan.probeId} is missing ${field}`);
        assert.ok(plan[field].length > 0, `${plan.probeId}'s ${field} is empty`);
      }
      assert.ok(Array.isArray(plan.outcomes) && plan.outcomes.length > 0, `${plan.probeId} declares no outcomes`);
      assert.ok(Array.isArray(plan.methods) && plan.methods.length > 0, `${plan.probeId} declares no methods`);
      const steps = plan.steps(planCtx());
      assert.ok(steps.length > 0, `${plan.probeId} has no steps`);
      steps.forEach((step: Record<string, unknown>, i: number) => {
        assert.equal(step.n, i + 1, `${plan.probeId} step ordinals are not 1..n`);
        assert.equal(typeof step.method, "string");
        assert.equal(typeof step.path, "string");
        assert.ok(
          plan.methods.includes(step.method) || String(step.path).startsWith("/oauth/token"),
          `${plan.probeId} step ${step.n} uses ${step.method}, which its own methods list does not permit`,
        );
      });
    }
  });

  it("no plan step reaches a path its own request allowlist does not name", async () => {
    const { PLANS } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    for (const plan of PLANS) {
      if (!plan.allowedRequests) continue;
      for (const step of plan.steps(planCtx())) {
        // The token mint is allowed on every probe, separately from the
        // per-probe path allowlist, because it changes no tailnet state.
        if (String(step.path).startsWith("/oauth/token")) continue;
        const matched = plan.allowedRequests.some(
          (entry: { method: string; pattern: RegExp }) =>
            entry.method === step.method && entry.pattern.test(String(step.path)),
        );
        assert.ok(matched, `${plan.probeId} step ${step.n}: ${step.method} ${step.path} is not on its own allowlist`);

        // The undo is a request the harness sends too, during `cleanup` after a
        // crash. It has to be on the allowlist for the same reason the step is.
        if (step.undo) {
          const undoMatched = plan.allowedRequests.some(
            (entry: { method: string; pattern: RegExp }) =>
              entry.method === step.undo.method && entry.pattern.test(String(step.undo.path)),
          );
          assert.ok(
            undoMatched,
            `${plan.probeId} step ${step.n}: undo ${step.undo.method} ${step.undo.path} is not on its own allowlist`,
          );
        }
      }
    }
  });

  it("every step that creates something declares how to undo it", async () => {
    const { PLANS } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    const creators: string[] = [];
    for (const plan of PLANS) {
      for (const step of plan.steps(planCtx())) {
        if (step.undo) creators.push(`${plan.probeId}#${step.n}`);
      }
    }
    // The journal is the crash path: a create whose undo was never declared
    // leaves an object behind that `cleanup` cannot replay away.
    assert.ok(creators.length >= 14, `expected the create steps to declare undos, found ${creators.length}`);
    for (const plan of PLANS) {
      const hasCreate = plan
        .steps(planCtx())
        .some((s: { arm: string; registers?: string }) => s.arm === "seed" && s.registers === "id");
      if (!hasCreate) continue;
      const hasUndo = plan.steps(planCtx()).some((s: { undo?: unknown }) => Boolean(s.undo));
      assert.ok(hasUndo, `${plan.probeId} creates an object but declares no undo`);
    }
  });

  it("P11 is deliberately absent, and says so where a reader will see it", async () => {
    const { PLANS, NOT_IMPLEMENTED, findPlan, notImplementedReason } = await loadHarness(
      "scripts/lib/probe-plans/index.mjs",
    );
    assert.equal(findPlan("P11-C21-s3-external-id"), null);
    assert.ok(!PLANS.some((p: { probeId: string }) => p.probeId.startsWith("P11")));
    const reason = notImplementedReason("P11-C21-s3-external-id");
    assert.ok(reason, "P11 must be listed as deliberately not implemented, not merely missing");
    assert.match(reason.why, /UNSAFE/);
    assert.ok(reason.instead.length > 0);
    assert.ok(NOT_IMPLEMENTED.some((e: { probeId: string }) => e.probeId.startsWith("P16")));
  });

  it("only the probes whose endpoints demand a human target are routed to one", async () => {
    const { PLANS } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    const human = PLANS.filter((p: { requiresTargetKind?: string }) => p.requiresTargetKind === "human").map(
      (p: { probeId: string }) => p.probeId,
    );
    assert.deepEqual(human.sort(), ["P2-C1-user-invite", "P3-C1-device-invite"]);
  });

  it("only the DNS write probes carry the unsafe class", async () => {
    const { PLANS } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    const unsafe = PLANS.filter(
      (p: { safetyClass: string }) => p.safetyClass === "unsafe-needs-disposable-tailnet",
    ).map((p: { probeId: string }) => p.probeId);
    assert.deepEqual(unsafe.sort(), ["P4b-dns-config-noop-roundtrip", "P4c-dns-config-current-shape"]);
  });
});

/* ---------------------------------------------------------- the dry run -- */

describe("live-probe dry run", () => {
  function probeEnv(extra: Record<string, string> = {}): Record<string, string> {
    const dir = mkdtempSync(resolve(tmpdir(), "yaw-probe-state-"));
    return {
      TS_PROBE_FORBIDDEN_TAILNETS: "real.example.com,tailnet-real",
      LOCALAPPDATA: dir,
      XDG_STATE_HOME: dir,
      ...extra,
    };
  }

  it("run --all makes ZERO network calls and exits 0", async () => {
    const { main } = await loadHarness("scripts/live-probe.mjs");
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...args: unknown[]) => {
      calls++;
      throw new Error(`the dry run attempted a network call: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    try {
      const code = await main(["run", "--all"], { env: probeEnv(), log: (line: string) => lines.push(line) });
      assert.equal(code, 0);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls, 0, "the dry run called fetch");
    const text = lines.join("\n");
    assert.match(text, /DRY RUN -- nothing was sent\./);
    assert.match(text, /NOT IMPLEMENTED/);
    // The printed list is the deliverable: it must actually name requests.
    assert.match(text, /GET api\.tailscale\.com\/api\/v2\/tailnet\//);
  });

  it("every other subcommand is dry by default too", async () => {
    const { main } = await loadHarness("scripts/live-probe.mjs");
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("the dry run attempted a network call");
    }) as unknown as typeof fetch;
    try {
      for (const argv of [["provision"], ["preflight"], ["cleanup"], ["teardown"], ["list"]]) {
        const lines: string[] = [];
        const code = await main(argv, {
          env: probeEnv({ TS_PROBE_TAILNET_ID: "probe-1" }),
          log: (line: string) => lines.push(line),
        });
        assert.equal(code, 0, `${argv[0]} did not exit 0`);
        if (argv[0] !== "list") {
          assert.match(lines.join("\n"), /DRY RUN -- nothing was sent\./, `${argv[0]} did not say it was a dry run`);
        }
      }
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls, 0);
  });

  it("refuses to --execute without an explicit target or a forbidden list", async () => {
    const { main } = await loadHarness("scripts/live-probe.mjs");
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("a refusal path attempted a network call");
    }) as unknown as typeof fetch;
    try {
      await assert.rejects(
        () => main(["run", "P1-C6-log-end", "--execute"], { env: probeEnv(), log: () => {} }),
        /No tailnet id supplied/,
      );
      await assert.rejects(
        () =>
          main(["run", "P1-C6-log-end", "--execute"], {
            env: { TS_PROBE_TAILNET_ID: "probe-1", LOCALAPPDATA: mkdtempSync(resolve(tmpdir(), "yaw-st-")) },
            log: () => {},
          }),
        /TS_PROBE_FORBIDDEN_TAILNETS is empty/,
      );
      await assert.rejects(
        () =>
          main(["run", "P1-C6-log-end", "--execute"], {
            env: probeEnv({ TS_PROBE_TAILNET_ID: "real.example.com" }),
            log: () => {},
          }),
        /TS_PROBE_FORBIDDEN_TAILNETS/,
      );
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls, 0, "a refusal path reached the network");
  });

  it("scrub-check sweeps the fixtures, finds a planted leak, and never prints it", async () => {
    const { main } = await loadHarness("scripts/live-probe.mjs");
    const clean: string[] = [];
    assert.equal(await main(["scrub-check"], { env: probeEnv(), log: (l: string) => clean.push(l) }), 0);
    assert.match(clean.join("\n"), /scrub-check: clean\./);

    const tmp = mkdtempSync(resolve(tmpdir(), "yaw-scrub-"));
    try {
      const planted = "tskey-api-PLANTED-NOT-REAL";
      plantFixture(join(tmp, "P8-C5-key-put"), "01-seed-leak.json", {
        probeId: "P8-C5-key-put",
        step: 1,
        arm: "seed",
        provenance: goodProvenance(),
        response: { status: 200, body: { key: planted } },
      });
      const dirty: string[] = [];
      assert.equal(
        await main(["scrub-check"], {
          env: probeEnv({ TS_PROBE_FIXTURE_ROOT: tmp, TS_PROBE_API_KEY: planted }),
          log: (l: string) => dirty.push(l),
        }),
        1,
      );
      const output = dirty.join("\n");
      assert.match(output, /LEAK/);
      assert.match(output, /TS_PROBE_API_KEY/);
      // It reports the credential by fingerprint. Printing the value would put
      // the secret in a terminal scrollback, which is the thing being prevented.
      assert.ok(!output.includes(planted), "scrub-check printed the secret it found");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("names an unknown probe, and explains a deliberately absent one", async () => {
    const { main } = await loadHarness("scripts/live-probe.mjs");
    const unknown: string[] = [];
    assert.equal(await main(["run", "P99"], { env: probeEnv(), log: (l: string) => unknown.push(l) }), 2);
    assert.match(unknown.join("\n"), /Unknown probe/);

    const absent: string[] = [];
    assert.equal(
      await main(["run", "P11-C21-s3-external-id"], { env: probeEnv(), log: (l: string) => absent.push(l) }),
      2,
    );
    assert.match(absent.join("\n"), /NOT IMPLEMENTED/);
  });

  it("as a real child process, with a throwing fetch preloaded, still sends nothing", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "yaw-no-network-"));
    try {
      const preload = join(tmp, "no-network.mjs");
      writeFileSync(
        preload,
        "globalThis.fetch = (...a) => { throw new Error('NETWORK CALL ATTEMPTED: ' + String(a[0])); };" +
          String.fromCharCode(10),
        "utf-8",
      );
      const res = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, resolve(repoRoot, "scripts", "live-probe.mjs"), "run", "--all"],
        {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 120_000,
          // A deliberately hostile environment: the ambient credentials the
          // owner's shell really does export. The harness must strip them and
          // still send nothing.
          env: {
            ...process.env,
            TAILSCALE_API_KEY: "tskey-api-AMBIENT-NOT-REAL",
            TAILSCALE_TAILNET: "real.example.com",
            TS_PROBE_FORBIDDEN_TAILNETS: "real.example.com",
            LOCALAPPDATA: tmp,
            XDG_STATE_HOME: tmp,
          },
        },
      );
      const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      assert.equal(res.status, 0, `exited ${res.status}:\n${output}`);
      assert.ok(!output.includes("NETWORK CALL ATTEMPTED"), output);
      assert.match(output, /DRY RUN -- nothing was sent\./);
      // And it says out loud that it removed the ambient credentials.
      assert.match(output, /stripped 2 TAILSCALE_\* variable\(s\)/);
      assert.ok(!output.includes("tskey-api-AMBIENT-NOT-REAL"), "the ambient key was printed");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
