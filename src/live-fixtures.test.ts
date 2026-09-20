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
 *  4. THE CONTRIBUTOR SCRIPTS beside it, where a defect is silent rather than
 *     loud: the entry-point guard that made the whole CLI a no-op behind a
 *     symlink, and lint.mjs's cmd.exe shim path.
 *
 * The harness itself is .mjs outside src/, so tsc does not compile it and it is
 * loaded here by URL at run time. Deliberate: a probe living under src/ would
 * be swept up by the integration suite's RUN_INTEGRATION_TESTS gate, which runs
 * on the operator's ambient credentials.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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

type Finding = { file: string; why: string; evidence?: string };

/**
 * THE scanner, not a copy of it.
 *
 * `scanFixtures` and `fixtureFiles` live in scripts/lib/probe-recorder.mjs and
 * are what `live-probe.mjs scrub-check` runs. This file used to carry its own
 * regex set with different thresholds, so a fixture could pass the committed
 * gate and fail the operator's one (or the reverse). One rule set, two callers:
 * this test, which is the only gate `npm test` runs, and scrub-check, which
 * adds the one comparison a committed test cannot make -- against the literal
 * credentials in the operator's own shell.
 */
async function liveScanner(): Promise<{
  scanFixtures: (root: string, keys: string[]) => Finding[];
  fixtureFiles: (root: string) => string[];
  REQUIRED_PROVENANCE_KEYS: string[];
}> {
  return loadHarness("scripts/lib/probe-recorder.mjs");
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
    const { scanFixtures, REQUIRED_PROVENANCE_KEYS } = await liveScanner();
    const findings = scanFixtures(FIXTURE_ROOT, REQUIRED_PROVENANCE_KEYS);
    assert.deepEqual(
      findings,
      [],
      `fixtures/live is not clean:\n${findings.map((f) => `${f.file}: ${f.why}`).join("\n")}`,
    );
  });

  it("fixtures/live ships empty, because nothing has been observed yet", async () => {
    // If this ever fails, someone recorded a real observation -- which is the
    // point of the harness. Update the changelog wording tier at the same time:
    // an UNOBSERVED claim must not survive the first fixture.
    const { fixtureFiles } = await liveScanner();
    assert.deepEqual(fixtureFiles(FIXTURE_ROOT), []);
  });

  it("goes red on a planted tskey-, email, control-plane id, invite code or missing provenance", async () => {
    const { scanFixtures, REQUIRED_PROVENANCE_KEYS } = await liveScanner();
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

      const whys = scanFixtures(tmp, REQUIRED_PROVENANCE_KEYS).map((f) => f.why);
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
    const { scanFixtures, REQUIRED_PROVENANCE_KEYS } = await liveScanner();
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
      assert.deepEqual(scanFixtures(tmp, REQUIRED_PROVENANCE_KEYS), []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("goes red on an internal domain kept as a map KEY under countsOnly", async () => {
    // The rule none of the others can enforce. A split-DNS document is keyed by
    // domain name, so a `keySets` entry can carry an operator's internal
    // domains with no tskey-, no email and no tailNNNN.ts.net anywhere in the
    // file. countsOnly says the body never reaches disk; this says the KEYS
    // do not either.
    const { scanFixtures, REQUIRED_PROVENANCE_KEYS } = await liveScanner();
    const tmp = mkdtempSync(resolve(tmpdir(), "yaw-key-leak-"));
    try {
      plantFixture(join(tmp, "P4a-dns-config-read"), "01-observe-split-dns.json", {
        probeId: "P4a-dns-config-read",
        step: 1,
        arm: "observe",
        provenance: { ...goodProvenance(), countsOnly: true },
        response: {
          status: 200,
          countsOnly: true,
          body: null,
          keySets: {
            $: ["magicDNS", "splitDNS"],
            "$.splitDNS": ["corp.acme-internal.lan", "finance.secret-division.lan"],
          },
          summary: { kind: "object", keys: ["magicDNS", "splitDNS"] },
        },
      });
      const findings = scanFixtures(tmp, REQUIRED_PROVENANCE_KEYS);
      const report = JSON.stringify(findings);
      assert.ok(
        findings.some((f) => f.why.includes("map key that is tailnet data") && f.evidence === "corp.acme-internal.lan"),
        report,
      );
      assert.ok(
        findings.some((f) => f.evidence === "finance.secret-division.lan"),
        report,
      );
      // And the schema keys beside them are NOT findings: the point of keeping
      // key sets at all is that `magicDNS` and `splitDNS` are schema facts.
      assert.ok(!findings.some((f) => f.evidence === "magicDNS" || f.evidence === "splitDNS"), report);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the recorder never puts an internal domain in a countsOnly fixture in the first place", async () => {
    const { createRecorder, REDACTED_KEY } = await loadHarness("scripts/lib/probe-recorder.mjs");
    const { scanFixtures, REQUIRED_PROVENANCE_KEYS } = await liveScanner();
    const internal = ["corp.acme-internal.lan", "finance.secret-division.lan"];
    const body = {
      magicDNS: true,
      splitDNS: { [internal[0]]: ["10.0.0.1"], [internal[1]]: ["10.0.0.2"] },
      // A domain as a VALUE as well as a key: scrubString cannot see either,
      // which is why countsOnly has to drop the document rather than clean it.
      searchPaths: internal.slice(),
    };

    const original = globalThis.fetch;
    const tmp = mkdtempSync(resolve(tmpdir(), "yaw-recorder-"));
    let fixture: Record<string, unknown>;
    try {
      // The stub goes on FIRST: install() captures whatever fetch is at that
      // moment as the transport it wraps. Nothing here reaches a socket.
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
      const recorder = createRecorder({
        guard: { check: () => {}, setContext: () => {} },
        tailnetId: "probe-1",
        targetKind: "api-only",
        credentialKind: "oauth",
        pinnedBuildVersion: "0.20.2",
        countsOnly: true,
        paceMs: 0,
      });
      recorder.install();
      recorder.setContext({ probeId: "P4a-dns-config-read", step: 1, arm: "observe", derive: null });
      try {
        await globalThis.fetch("https://api.tailscale.com/api/v2/tailnet/probe-1/dns/configuration", {
          method: "GET",
          headers: { authorization: "Basic redacted-anyway" },
        });
      } finally {
        recorder.uninstall();
      }
      fixture = recorder.buildFixture({
        probeId: "P4a-dns-config-read",
        step: 1,
        arm: "observe",
        // The envelope executeStep ACTUALLY passes. A null one is the single
        // shape it never produces -- both call sites pass one
        // (live-probe.mjs:538-543, :674-680) -- and testing against a null was
        // how the whole document went on reaching disk one field below the
        // `body: null` countsOnly had just written: `data` for an apiRequest
        // step, `rawBody` for P13's ACL text.
        envelope: { ok: true, status: 200, data: body, rawBody: JSON.stringify(body) },
        note: null,
      });
      recorder.writeFixture(join(tmp, "P4a-dns-config-read"), fixture);

      const text = JSON.stringify(fixture);
      for (const domain of internal) {
        assert.ok(!text.includes(domain), `the fixture kept ${domain}`);
      }
      // The SHAPE still survives, which is the whole reason key sets are kept.
      const response = fixture.response as {
        body: unknown;
        keySets: Record<string, string[]>;
        summary: { children: Record<string, { keys: string[]; redactedKeyCount?: number }> };
      };
      assert.equal(response.body, null);
      assert.deepEqual(response.keySets.$, ["magicDNS", "searchPaths", "splitDNS"]);
      assert.deepEqual(response.keySets["$.splitDNS"], [REDACTED_KEY]);
      assert.equal(response.summary.children.splitDNS.redactedKeyCount, 2, "the COUNT is the fact that survives");

      // And the envelope is projected the same way, not written whole: the
      // status answer survives, the document becomes counts and key sets, and
      // the raw text becomes its length.
      const envelope = fixture.envelope as {
        countsOnly: boolean;
        ok: boolean;
        status: number;
        data: { keySets: Record<string, string[]>; summary: { keys: string[] } };
        rawBody: { kind: string; length: number };
      };
      assert.equal(envelope.countsOnly, true);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.status, 200);
      assert.deepEqual(envelope.data.keySets["$.splitDNS"], [REDACTED_KEY]);
      assert.deepEqual(envelope.data.summary.keys, ["magicDNS", "searchPaths", "splitDNS"]);
      assert.equal(envelope.rawBody.kind, "text");
      assert.ok(envelope.rawBody.length > 0, "the length is the fact that survives a raw body");

      // And what it wrote passes the committed gate, which is the fixture the
      // planted test above proves can fail.
      assert.deepEqual(scanFixtures(tmp, REQUIRED_PROVENANCE_KEYS), []);
    } finally {
      globalThis.fetch = original;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the offline scanner reads the envelope too, not only the response", async () => {
    // The scanner's countsOnly key rule used to walk `response` alone, so the
    // one field that was written whole was also the one field it could not see.
    const { scanFixtures, REQUIRED_PROVENANCE_KEYS } = await liveScanner();
    const tmp = mkdtempSync(resolve(tmpdir(), "yaw-envelope-scan-"));
    try {
      plantFixture(join(tmp, "P4a-dns-config-read"), "01-observe-dns.json", {
        probeId: "P4a-dns-config-read",
        step: 1,
        arm: "observe",
        provenance: { ...goodProvenance(), countsOnly: true },
        response: { status: 200, countsOnly: true, body: null, keySets: { $: ["splitDNS"] } },
        envelope: {
          countsOnly: true,
          ok: true,
          status: 200,
          data: {
            summary: { kind: "object", keys: ["splitDNS"] },
            keySets: { "$.splitDNS": ["corp.acme-internal.lan"] },
          },
        },
      });
      const findings = scanFixtures(tmp, REQUIRED_PROVENANCE_KEYS);
      assert.ok(
        findings.some((f) => f.why.includes("map key that is tailnet data") && f.evidence === "corp.acme-internal.lan"),
        JSON.stringify(findings),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a minted access token never reaches a fixture, whatever shape it has", async () => {
    const { rawRequest } = await loadHarness("scripts/live-probe.mjs");
    const { createRecorder } = await loadHarness("scripts/lib/probe-recorder.mjs");
    const { scanFixtures, REQUIRED_PROVENANCE_KEYS } = await liveScanner();
    // Deliberately NOT `tskey-` shaped. Tailscale's access tokens carry that
    // prefix today and scrubString happens to catch it -- but nothing in this
    // harness makes that true, and the fixture used to hold the literal token
    // in `envelope.raw` while `envelope.parsed.access_token` beside it read
    // `<redacted>`.
    const token = "eyJhbGciOiJIUzI1NiJ9.aaaabbbbccccddddeeeeffff.gggghhhhiiiijjjj";
    const mintBody = JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 3600 });
    const original = globalThis.fetch;
    const tmp = mkdtempSync(resolve(tmpdir(), "yaw-mint-"));
    try {
      globalThis.fetch = (async () =>
        new Response(mintBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
      const envelope = await rawRequest("POST", "/oauth/token", { form: { client_id: "x", client_secret: "y" } });
      // The mint still works -- the step reads the token off `parsed` -- and
      // the raw text it arrived in is not carried along beside it.
      assert.equal((envelope as { parsed: { access_token: string } }).parsed.access_token, token);
      assert.equal((envelope as { raw: string | null }).raw, null);

      // countsOnly OFF: the weakest recording mode, which is what an attested
      // disposable target gets. Even there the token must not survive.
      const recorder = createRecorder({
        guard: { check: () => {}, setContext: () => {} },
        tailnetId: "probe-1",
        targetKind: "api-only",
        credentialKind: "oauth",
        pinnedBuildVersion: "0.20.2",
        countsOnly: false,
        paceMs: 0,
      });
      const fixture = recorder.buildFixture({
        probeId: "P15-oauth-downscope",
        step: 2,
        arm: "control",
        envelope,
        note: null,
      });
      recorder.writeFixture(join(tmp, "P15-oauth-downscope"), fixture);
      assert.ok(!JSON.stringify(fixture).includes(token), "the fixture kept the minted access token");
      assert.equal((fixture.envelope as { parsed: { access_token: string } }).parsed.access_token, "<redacted>");
      assert.deepEqual(scanFixtures(tmp, REQUIRED_PROVENANCE_KEYS), []);

      // A body that does NOT parse is still evidence, and is still kept: that
      // is the one case recordResponse keeps a raw body for, and the rule here
      // is the same rule.
      globalThis.fetch = (async () =>
        new Response("upstream timeout", {
          status: 504,
          headers: { "content-type": "text/plain" },
        })) as unknown as typeof fetch;
      const failed = (await rawRequest("POST", "/oauth/token", { form: { client_id: "x" } })) as {
        parsed: unknown;
        raw: string | null;
      };
      assert.equal(failed.parsed, null);
      assert.equal(failed.raw, "upstream timeout");
    } finally {
      globalThis.fetch = original;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("on an ATTESTED target the same key set is kept, and that is deliberate", async () => {
    // The asymmetry is the design: countsOnly is for a tailnet whose contents
    // are not the harness's to record. A disposable tailnet this harness
    // provisioned and attested empty holds only what the probe seeded, and
    // P4b's round trip is decided by comparing those keys exactly.
    const { keySetMap, REDACTED_KEY } = await loadHarness("scripts/lib/probe-recorder.mjs");
    const doc = { splitDNS: { "c25.yaw-probe.example.com": ["10.0.0.1"] } };
    assert.deepEqual(keySetMap(doc, { scrub: {}, countsOnly: false })["$.splitDNS"], ["c25.yaw-probe.example.com"]);
    assert.deepEqual(keySetMap(doc, { scrub: {}, countsOnly: true })["$.splitDNS"], [REDACTED_KEY]);
  });
});

/* ---------------------------------------------------------- the refusals -- */

async function guard() {
  return loadHarness("scripts/lib/probe-guard.mjs");
}

/**
 * A directory link to `target`, or null when this host will not make one.
 *
 * A Windows directory JUNCTION needs no administrator rights and no developer
 * mode, which is what makes "the checkout is reached through a link" an
 * ordinary situation rather than an exotic one.
 */
function linkDir(target: string, linkPath: string): string | null {
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return linkPath;
  } catch {
    return null;
  }
}

/**
 * Remove the LINK, never what it points at. `rmdir` on a junction and `unlink`
 * on a symlink both operate on the link itself; a recursive delete through one
 * would be pointed at the working tree.
 */
function unlinkDir(linkPath: string): void {
  try {
    if (process.platform === "win32") rmdirSync(linkPath);
    else unlinkSync(linkPath);
  } catch {
    // Never created, or already gone.
  }
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

  it("G0 strips a MIXED-CASE TAILSCALE_ name too, because Windows reads it anyway", async () => {
    const g = await guard();
    // Windows environment names are case-insensitive but case-PRESERVING. A
    // variable the shell created as `Tailscale_Api_Key` is what
    // Object.keys reports, while `process.env.TAILSCALE_API_KEY` -- the read
    // api.ts performs, and the one that WINS over the OAuth pair -- still finds
    // it. A case-sensitive strip left the owner's real key in place.
    const env: Record<string, string> = {
      Tailscale_Api_Key: "tskey-api-REAL",
      Tailscale_Debug: "1",
      TS_PROBE_TAILNET_ID: "probe-1",
    };
    const { removed, ambient } = g.stripAmbientCredentials(env, "win32");
    assert.deepEqual(removed, ["Tailscale_Api_Key", "Tailscale_Debug"]);
    assert.equal(env.Tailscale_Api_Key, undefined);
    assert.equal(env.TS_PROBE_TAILNET_ID, "probe-1");
    // The fingerprint is captured through the same case-insensitive lookup, so
    // a key pasted back into a probe slot is still refused by G0's second half.
    assert.equal(ambient.apiKeyFingerprint, g.fingerprint("tskey-api-REAL"));
    // On POSIX the spelling is the name: nothing is widened by accident.
    const posix: Record<string, string> = { Tailscale_Api_Key: "x" };
    assert.deepEqual(g.stripAmbientCredentials(posix, "linux").removed, []);
    assert.equal(posix.Tailscale_Api_Key, "x");
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

  it("the belt-and-braces re-check sees a mixed-case stray, and still passes its own names", async () => {
    const g = await guard();
    // The backstop had the same case blindness as the strip it backs up.
    assert.equal(
      refusalCode(() => g.assertEnvClean({ Tailscale_Debug: "1" }, "win32")),
      "stray-tailscale-env",
    );
    assert.equal(
      refusalCode(() => g.assertEnvClean({ Tailscale_Oauth_Tailnet: "x" }, "win32")),
      "oauth-tailnet-set",
    );
    // The false-refusal guard: `env.TAILSCALE_TAILNET = target` updates a
    // variable Windows may still be STORING as `Tailscale_Tailnet`, and that
    // stored spelling is what Object.keys reports. Canonicalising the prefix
    // test without canonicalising the PROBE_MANAGED_ENV membership test would
    // refuse a name this harness set itself.
    g.assertEnvClean({ Tailscale_Tailnet: "probe-1", Tailscale_Api_Key: "k" }, "win32");
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

  it("says git could not ANSWER rather than blaming a .gitignore that may be right", async () => {
    const g = await guard();
    const inside = resolve(repoRoot, "probe-state.json");
    // `git check-ignore` has four outcomes and only two are an answer: 0
    // ignored, 1 not ignored, 128 (no .git, dubious ownership, corrupt index)
    // and a null status (git not on PATH, or the spawn timeout). Collapsing the
    // last two onto "not ignored" sent the contributor to edit a file that may
    // already be correct.
    assert.equal(
      refusalCode(() => g.assertStatePathSafe(inside, { repoRoot, git: () => ({ unknown: true, why: "ENOENT" }) })),
      "git-unavailable",
    );
    assert.equal(
      refusalCode(() =>
        g.assertStatePathSafe(inside, { repoRoot, git: () => ({ unknown: true, why: "git exited 128" }) }),
      ),
      "git-unavailable",
    );
  });

  it("never bases the state file on the current directory, whatever the environment lacks", async () => {
    const g = await guard();
    // With XDG_STATE_HOME and HOME both unset the base used to be ".", so an
    // OAuth client secret landed under the cwd -- inside the working tree for
    // the documented one. Reachable from `env -i`, a systemd unit with no user
    // profile, a distroless container and some CI runners.
    const posix = g.defaultStateDir({}, "linux");
    const windows = g.defaultStateDir({}, "win32");
    for (const dir of [posix, windows]) {
      assert.ok(isAbsolute(dir), `${dir} is not absolute`);
      assert.ok(dir !== resolve(".") && !dir.startsWith(`${resolve(".")}${sep}`), `${dir} is under the cwd`);
    }
    assert.equal(posix, resolve(homedir(), ".local", "state", "yaw-tailscale-probe"));
    assert.equal(windows, resolve(homedir(), "yaw-tailscale-probe"));
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

  it("sees through a junctioned or symlinked spelling of the working tree", async (t) => {
    const g = await guard();
    const tmp = mkdtempSync(resolve(tmpdir(), "yaw-link-"));
    const link = join(tmp, "repo-link");
    try {
      if (!linkDir(repoRoot, link)) {
        t.skip("this host does not permit creating a directory link");
        return;
      }
      // The containment test used to be string math over resolve()d paths, so
      // this answered "outside the repo" -- and resolvePinnedDist then accepted
      // the working tree's OWN dist/ as the pinned v0.20.2 build. A CURRENT arm
      // taken from it records the FIXED request, which is the one thing the
      // pinned-build rule exists to prevent.
      assert.equal(g.isInside(repoRoot, join(link, "dist")), true);
      assert.equal(
        refusalCode(() => g.resolvePinnedDist({ TS_PROBE_PINNED_DIST: join(link, "dist") })),
        "pinned-build-inside-repo",
      );
      // A path that does not exist yet still canonicalizes, via its nearest
      // existing ancestor -- a state directory is routinely named before it is
      // created.
      assert.equal(g.isInside(repoRoot, join(link, "no-such-dir", "probe-state.json")), true);
    } finally {
      unlinkDir(link);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("names the MSYS cause instead of refusing a C:\\c\\... path that looks almost right", async () => {
    const g = await guard();
    // Git Bash prints /c/Users/...; Node's win32 resolver turns that into
    // C:\c\Users\..., and every later check then names a directory the
    // contributor never typed.
    assert.equal(
      refusalCode(() =>
        g.resolvePinnedDist({ TS_PROBE_PINNED_DIST: "/c/Users/you/tailscale-mcp-v0.20.2/dist" }, { platform: "win32" }),
      ),
      "pinned-build-msys-path",
    );
    // The same value on a POSIX host is an ordinary absolute path.
    assert.equal(
      refusalCode(() =>
        g.resolvePinnedDist({ TS_PROBE_PINNED_DIST: "/c/Users/you/tailscale-mcp-v0.20.2/dist" }, { platform: "linux" }),
      ),
      "pinned-build-missing",
    );
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

/* ------------------------------------------------- the run-path preconditions -- */

describe("run preconditions", () => {
  // G2 and G6 were both written where the provisioning record is CREATED and
  // never re-checked where it is USED. assertRunPreconditions is the one place
  // the run path calls, so it is the one place worth testing.
  async function preconditions() {
    const { assertRunPreconditions } = await loadHarness("scripts/live-probe.mjs");
    const { findPlan } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    return { assertRunPreconditions, findPlan };
  }

  const attestedRecord = (overrides: Record<string, unknown> = {}) => ({
    createdByHarness: true,
    tailnetId: "probe-1",
    displayName: "yaw-probe-x",
    createdAt: "2026-01-31T00:00:00Z",
    attestedAt: "2026-01-31T23:30:00Z",
    ...overrides,
  });
  const now = Date.parse("2026-02-01T00:00:00Z");

  it("G6 drops a safe-read-only probe to GET-only egress on an unattested target", async () => {
    const { assertRunPreconditions, findPlan } = await preconditions();
    // P9 declares GET and POST. --allow-real-readonly used to let that POST
    // through onto a real tailnet, because the guard's method set came straight
    // from plan.methods and the flag never reached it.
    const p9 = assertRunPreconditions(findPlan("P9-C7-oauth-tailnet-param"), {
      targetKind: "api-only",
      targetIsAttested: false,
      tailnetId: "probe-1",
      allowRealReadonly: true,
      allowRealReversible: [],
      nowMs: now,
    });
    assert.equal(p9.readOnlyDrop, true);
    assert.deepEqual(p9.methods, ["GET"]);

    // P14's ONLY method is POST /acl/validate. Dropped to GET it can send
    // nothing at all, which is the honest answer: it needs a provisioned target.
    const p14 = assertRunPreconditions(findPlan("P14-acl-validate-tests"), {
      targetIsAttested: false,
      tailnetId: "probe-1",
      allowRealReadonly: true,
      allowRealReversible: [],
      nowMs: now,
    });
    assert.equal(p14.readOnlyDrop, true);
    assert.deepEqual(p14.methods, []);
  });

  it("the dropped method list is what the egress guard is actually built from", async () => {
    // The drop is only worth anything if it reaches the fetch wrapper.
    const { assertRunPreconditions, findPlan } = await preconditions();
    const g = await guard();
    const plan = findPlan("P9-C7-oauth-tailnet-param");
    const { methods } = assertRunPreconditions(plan, {
      targetKind: "api-only",
      targetIsAttested: false,
      tailnetId: "probe-1",
      allowRealReadonly: true,
      allowRealReversible: [],
      nowMs: now,
    });
    const dropped = g.createEgressGuard({
      target: "probe-1",
      mode: "readonly",
      methods,
      allowedRequests: plan.allowedRequests,
    });
    assert.equal(
      refusalCode(() =>
        dropped.check("https://api.tailscale.com/api/v2/tailnet/probe-1/dns/searchpaths", "POST", "Basic x"),
      ),
      "egress-method",
    );
    assert.deepEqual(
      dropped.check("https://api.tailscale.com/api/v2/tailnet/probe-1/dns/searchpaths", "GET", "Basic x"),
      { allowed: true, kind: "tailnet-scoped" },
    );
  });

  it("an attested target keeps the probe's declared methods", async () => {
    const { assertRunPreconditions, findPlan } = await preconditions();
    const result = assertRunPreconditions(findPlan("P9-C7-oauth-tailnet-param"), {
      targetKind: "api-only",
      targetIsAttested: true,
      targetRecord: attestedRecord(),
      tailnetId: "probe-1",
      allowRealReadonly: false,
      allowRealReversible: [],
      nowMs: now,
    });
    assert.equal(result.readOnlyDrop, false);
    assert.deepEqual(result.methods, ["GET", "POST"]);
  });

  it("G2 re-checks provenance and attestation freshness where the record is USED", async () => {
    const { assertRunPreconditions, findPlan } = await preconditions();
    const plan = findPlan("P4b-dns-config-noop-roundtrip");
    const run = (record: Record<string, unknown>) =>
      assertRunPreconditions(plan, {
        targetIsAttested: true,
        targetRecord: record,
        tailnetId: "probe-1",
        allowRealReadonly: false,
        allowRealReversible: [],
        nowMs: now,
      });

    // `targetIsAttested` is a two-field truthiness test -- createdByHarness &&
    // attestedAt. It cannot tell a record provisioned an hour ago from one
    // provisioned last month, nor a yaw-probe- tailnet from a production one
    // someone hand-edited into the state file. These four refusals are what
    // stands behind it on the run path, and none of them used to run there.
    assert.equal(
      refusalCode(() => run(attestedRecord({ createdAt: "2026-01-01T00:00:00Z" }))),
      "provenance-age",
    );
    assert.equal(
      refusalCode(() => run(attestedRecord({ displayName: "prod" }))),
      "provenance-name",
    );
    assert.equal(
      refusalCode(() => run(attestedRecord({ tailnetId: "somewhere-else" }))),
      "provenance-mismatch",
    );
    // Provisioned yesterday, well inside the 7-day provenance window, but the
    // emptiness attestation is from yesterday too. Devices and users join
    // between a preflight and a run, and nothing else looks.
    assert.equal(
      refusalCode(() => run(attestedRecord({ attestedAt: "2026-01-31T00:00:00Z" }))),
      "attestation-stale",
    );
    assert.equal(
      refusalCode(() => run(attestedRecord({ attestedAt: undefined }))),
      "attestation-missing",
    );

    const ok = run(attestedRecord());
    assert.equal(ok.needs.provenance, true);
    assert.equal(ok.readOnlyDrop, false);
  });

  it("a forged two-field record unlocks nothing, whatever the probe's class", async () => {
    // The re-check above was gated on `needs.provenance`, which is true for the
    // unsafe class and nothing else -- so the class with the WEAKER declared
    // interlocks had no re-check at all. `targetIsAttested` is
    // `createdByHarness && attestedAt`, two fields anyone can type into the
    // state file, and being attested is what removes the
    // --allow-real-reversible requirement in the first place. With this record
    // and a target named as production, P5/P6/P7/P8/P10 all ran with their full
    // GET/POST/PUT/PATCH/DELETE lists while P4b was refused.
    const { assertRunPreconditions, findPlan } = await preconditions();
    const forged = { createdByHarness: true, attestedAt: "1999-01-01T00:00:00Z" };
    const reversible = [
      "P5-C25-split-dns-null",
      "P6-C3-service-put",
      "P7-C4-webhook-patch",
      "P8-C5-key-put",
      "P10-C9-oauth-app-casing",
    ];
    for (const probeId of reversible) {
      assert.equal(
        refusalCode(() =>
          assertRunPreconditions(findPlan(probeId), {
            targetKind: "api-only",
            targetIsAttested: true,
            targetRecord: forged,
            tailnetId: "the-real-production-tailnet.example.com",
            allowRealReversible: [],
            allowRealReadonly: false,
            nowMs: now,
          }),
        ),
        "provenance-mismatch",
        `${probeId} accepted a record that names no tailnet`,
      );
    }
    // And an hour-old attestation on an otherwise perfect record is refused for
    // a safe-reversible-write probe, not only for the unsafe one.
    assert.equal(
      refusalCode(() =>
        assertRunPreconditions(findPlan("P5-C25-split-dns-null"), {
          targetKind: "api-only",
          targetIsAttested: true,
          targetRecord: attestedRecord({ attestedAt: "2026-01-31T22:00:00Z" }),
          tailnetId: "probe-1",
          allowRealReversible: [],
          nowMs: now,
        }),
      ),
      "attestation-stale",
    );
    // The legitimate path still runs: a fresh record on the tailnet it names.
    const ok = assertRunPreconditions(findPlan("P5-C25-split-dns-null"), {
      targetKind: "api-only",
      targetIsAttested: true,
      targetRecord: attestedRecord(),
      tailnetId: "probe-1",
      allowRealReversible: [],
      nowMs: now,
    });
    assert.equal(ok.recordChecked, true);
    assert.deepEqual(ok.methods, ["GET", "PATCH", "PUT"]);
  });

  it("counts-only is a property of the TARGET, and a plan can only escalate it", async () => {
    // It used to be a per-plan opt-in, and the five probes
    // --allow-real-reversible exists to permit on a real tailnet were exactly
    // the ones that did not declare it: P5's baseline GET wrote the operator's
    // whole split-DNS map into a committed fixture, keys and nameserver
    // addresses alike, while fixtures/live/README.md promised the opposite.
    const { assertRunPreconditions, findPlan } = await preconditions();
    const onTarget = (probeId: string, attested: boolean, extra: Record<string, unknown> = {}) =>
      assertRunPreconditions(findPlan(probeId), {
        targetKind: "api-only",
        targetIsAttested: attested,
        targetRecord: attested ? attestedRecord() : undefined,
        tailnetId: "probe-1",
        allowRealReversible: [],
        allowRealReadonly: true,
        nowMs: now,
        ...extra,
      });

    // Declares nothing, permitted on a real tailnet by its own flag: counts
    // only there, full bodies on a tailnet this harness provisioned.
    const p5Real = onTarget("P5-C25-split-dns-null", false, { allowRealReversible: ["P5-C25-split-dns-null"] });
    assert.equal(p5Real.countsOnly, true);
    assert.equal(p5Real.emptinessOverridden, true, "G3 is not met here, and the run path says so");
    assert.equal(onTarget("P5-C25-split-dns-null", true).countsOnly, false);

    // `countsOnly: true` ESCALATES: a log, an audit entry and a token response
    // are not things the probe seeded, so they are counts-only even on a
    // disposable target.
    for (const probeId of ["P1-C6-log-end", "P17-audit-multivalue-filters", "P15-oauth-downscope"]) {
      assert.equal(onTarget(probeId, true).countsOnly, true, `${probeId} stopped escalating`);
      assert.equal(onTarget(probeId, false).countsOnly, true, `${probeId} is not counts-only on a real tailnet`);
    }
    // An attested target is the only thing that turns full bodies on.
    assert.equal(onTarget("P12-devices-fields-projection", false).countsOnly, true);
    assert.equal(onTarget("P12-devices-fields-projection", true).countsOnly, false);
  });

  it("a safe-read-only probe needs no provenance record at all", async () => {
    // The freshness rules must not leak onto the read-only probes, which are
    // the ones the brief allows on the real tailnet in the first place.
    const { assertRunPreconditions, findPlan } = await preconditions();
    const result = assertRunPreconditions(findPlan("P1-C6-log-end"), {
      targetIsAttested: false,
      targetRecord: undefined,
      tailnetId: "probe-1",
      allowRealReadonly: true,
      allowRealReversible: [],
      nowMs: now,
    });
    assert.equal(result.needs.provenance, false);
    assert.deepEqual(result.methods, ["GET"]);
  });

  it("still refuses the wrong target kind and the unflagged write", async () => {
    // assertRunPreconditions took over two refusals that used to be inline in
    // runLive. They have to still fire from their new home.
    const { assertRunPreconditions, findPlan } = await preconditions();
    const base = { targetIsAttested: false, tailnetId: "probe-1", allowRealReversible: [], nowMs: now };
    assert.equal(
      refusalCode(() => assertRunPreconditions(findPlan("P2-C1-user-invite"), { ...base, targetKind: "api-only" })),
      "wrong-target-kind",
    );
    assert.equal(
      refusalCode(() => assertRunPreconditions(findPlan("P4b-dns-config-noop-roundtrip"), { ...base })),
      "unattested-target",
    );
    assert.equal(
      refusalCode(() => assertRunPreconditions(findPlan("P1-C6-log-end"), { ...base, allowRealReadonly: false })),
      "unattested-target",
    );
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
      // Counts-only belongs to the TARGET. A plan may escalate to `true` or
      // restate the default, and `false` is refused here rather than silently
      // ignored by the runner: it would read as "full bodies on any target",
      // which is the promise fixtures/live/README.md makes in reverse.
      assert.ok(
        plan.countsOnly === true || plan.countsOnly === "unattested" || plan.countsOnly === undefined,
        `${plan.probeId} declares countsOnly ${JSON.stringify(plan.countsOnly)}; only true, "unattested" or nothing`,
      );
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

    // The allowlist pattern is a PATHNAME rule, because that is all the egress
    // guard can enforce: it matches against `parsed.pathname`, which never has
    // a `?` in it (probe-guard.mjs). So the query comes off before the match.
    //
    // It must not simply be DISCARDED, though. A query string is where a GET
    // says what it is really asking for -- `fields=all`, `actor=<somebody>`,
    // `details=true` -- and an assertion that matched the path and ignored the
    // rest would wave all of that through unread. So every parameter a step
    // declares has to be named in the `query` list of an entry that matched,
    // which is a line in the plan where a reviewer sees it.
    function match(
      plan: { probeId: string; allowedRequests: { method: string; pattern: RegExp; query?: string[] }[] },
      what: string,
      method: string,
      declaredPath: string,
    ): void {
      const [pathname, query = ""] = String(declaredPath).split("?");
      const entries = plan.allowedRequests.filter((e) => e.method === method && e.pattern.test(pathname));
      assert.ok(entries.length > 0, `${plan.probeId} ${what}: ${method} ${pathname} is not on its own allowlist`);
      const params = [...new Set([...new URLSearchParams(query).keys()])].sort();
      const undeclared = params.filter((name) => !entries.some((e) => (e.query ?? []).includes(name)));
      assert.deepEqual(
        undeclared,
        [],
        `${plan.probeId} ${what}: ${method} ${pathname} carries query parameter(s) its allowlist entry does not ` +
          `name. Add them to the \`query\` list on that entry so the request a reviewer approves is the one sent.`,
      );
    }

    for (const plan of PLANS) {
      if (!plan.allowedRequests) continue;
      for (const step of plan.steps(planCtx())) {
        // The token mint is allowed on every probe, separately from the
        // per-probe path allowlist, because it changes no tailnet state.
        if (String(step.path).startsWith("/oauth/token")) continue;
        match(plan, `step ${step.n}`, step.method, String(step.path));

        // The undo is a request the harness sends too, during `cleanup` after a
        // crash. It has to be on the allowlist for the same reason the step is.
        if (step.undo) match(plan, `step ${step.n} undo`, step.undo.method, String(step.undo.path));
      }
    }
  });

  it("a query parameter no allowlist entry names is caught, not waved through", async () => {
    // The gate above is only worth having if it can fail. This is the shape it
    // exists to catch: the pathname is on the allowlist, and the step quietly
    // filters by something the entry never declared.
    const { PATTERNS, get } = await loadHarness("scripts/lib/probe-plans/_shared.mjs");
    const entry = get(PATTERNS.devices, ["fields"]);
    assert.deepEqual(entry, { method: "GET", pattern: PATTERNS.devices, query: ["fields"] });

    const [pathname, query] = "/tailnet/{T}/devices?fields=id&actor=someone".split("?");
    assert.ok(entry.pattern.test(pathname), "the pathname still matches once the query is split off");
    const undeclared = [...new URLSearchParams(query).keys()].filter((name) => !entry.query.includes(name));
    assert.deepEqual(undeclared, ["actor"]);

    // And the pattern itself must NOT match a path with the query still on it:
    // that was the old `(\?.*)?` tail, which made the same regex mean one thing
    // to the guard and another to this test.
    assert.ok(!entry.pattern.test("/tailnet/{T}/devices?fields=id"));
  });

  it("no step sends a <TS_PROBE_...> literal as if it were a value", async () => {
    // P7 used to read its two sink URLs off `ctx.state` -- the state FILE,
    // {targets, journal}, which never held them -- so both always fell through
    // to the literal "<TS_PROBE_SINK_A>", zod rejected it, and every later step
    // aborted on an unresolved {W}. A display placeholder is only allowed where
    // the runner substitutes it: the two credential fields of a token mint.
    const { PLANS } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    const { FORM_CREDENTIAL_KEYS } = await loadHarness("scripts/live-probe.mjs");
    const LITERAL = /<TS_PROBE_[A-Z0-9_]+>/g;
    const expected: Record<string, string> = {
      creating: "TS_PROBE_CREATING_CLIENT",
      downscope: "TS_PROBE_DOWNSCOPE_CLIENT",
    };
    for (const plan of PLANS) {
      for (const step of plan.steps(planCtx())) {
        const sent = JSON.stringify({ path: step.path, body: step.body ?? null, tool: step.tool ?? null });
        assert.deepEqual(
          sent.match(LITERAL) ?? [],
          [],
          `${plan.probeId} step ${step.n} would send a display placeholder as a value. Use a {placeholder} the ` +
            `runner resolves (or refuses) instead.`,
        );
        for (const [key, value] of Object.entries(step.form ?? {})) {
          for (const literal of String(value).match(LITERAL) ?? []) {
            assert.ok(
              FORM_CREDENTIAL_KEYS.has(key),
              `${plan.probeId} step ${step.n}: ${literal} sits on form field ${key}, which the runner does not fill`,
            );
            assert.ok(
              literal.startsWith(`<${expected[plan.mintCredential]}`),
              `${plan.probeId} step ${step.n}: ${literal} names a variable this plan's mintCredential ` +
                `(${plan.mintCredential}) does not read`,
            );
          }
        }
      }
    }
  });

  it("every plan that mints a token says which client it mints with", async () => {
    // Without this, every mint in the harness authenticated with
    // TS_PROBE_CREATING_CLIENT_* -- P9's short-lived `all`-scope client in a
    // real tailnet -- including P15 step 8, which asks for dns:write.
    const { PLANS } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    const minters = PLANS.filter((p: { steps: (c: unknown) => { form?: unknown }[] }) =>
      p.steps(planCtx()).some((s) => s.form),
    ).map((p: { probeId: string; mintCredential?: string }) => [p.probeId, p.mintCredential]);
    assert.deepEqual(minters.sort(), [
      ["P15-oauth-downscope", "downscope"],
      ["P9-C7-oauth-tailnet-param", "creating"],
    ]);
  });

  it("P15's two observation arms run under the MINTED token, not the target credential", async () => {
    // The whole thesis of P15: a down-scoped token grants the narrow thing and
    // refuses the wide one. Sent under the ordinary target credential, both
    // arms would record that credential's answer to a question about a
    // different token -- a 403 that never happened, or a 200 that proves
    // nothing.
    const { findPlan } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    const steps = findPlan("P15-oauth-downscope").steps(planCtx());
    const observation = steps.filter((s: { path: string }) => !String(s.path).startsWith("/oauth/token"));
    assert.ok(observation.length > 0);
    for (const step of observation) {
      assert.equal(
        step.credentialTarget,
        "minted",
        `P15 step ${step.n} (${step.method} ${step.path}) would go out under the target credential`,
      );
    }
  });

  it("a mint with no credential is refused, not sent as a placeholder", async () => {
    const { resolveMintForm } = await loadHarness("scripts/live-probe.mjs");
    const { findPlan } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    const plan = findPlan("P15-oauth-downscope");
    const mint = plan.steps(planCtx()).find((s: { form?: unknown }) => Boolean(s.form));
    assert.ok(mint, "P15 must still have a mint step");

    // Unset. The old code posted the display placeholder to the token endpoint
    // and recorded the resulting failure as if it were an answer about scopes.
    assert.equal(
      refusalCode(() =>
        resolveMintForm(plan, mint, {
          formValues: { grant_type: "client_credentials" },
          mintCredentialLabel: "TS_PROBE_DOWNSCOPE_CLIENT_ID / _SECRET",
          tailnetId: "probe-1",
          ids: {},
        }),
      ),
      "missing-mint-credential",
    );

    // Set: substituted, and a non-credential field still resolves {T}.
    const scoped = plan
      .steps(planCtx())
      .find((s: { form?: { tailnet?: string } }) => s.form?.tailnet !== undefined) as {
      form: Record<string, string>;
      n: number;
    };
    const form = resolveMintForm(plan, scoped, {
      formValues: { client_id: "cid", client_secret: "csecret", grant_type: "client_credentials" },
      mintCredentialLabel: "TS_PROBE_DOWNSCOPE_CLIENT_ID / _SECRET",
      tailnetId: "probe-1",
      ids: {},
    });
    assert.equal(form.client_id, "cid");
    assert.equal(form.client_secret, "csecret");
    assert.equal(form.tailnet, "probe-1");
  });

  it("every {placeholder} a step writes is one the runner can fill", async () => {
    // P2, P3 and P8 all ended with a cleanup step addressing `{id}`, which the
    // runner never sets: their creates register ids PLURAL, or under distinct
    // keys, so each of those probes finished by throwing unresolved-placeholder
    // AFTER creating live objects. They are journal sweeps now, and this is the
    // gate that keeps a plan from writing a placeholder nothing fills.
    const { PLANS } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    const { SEEDED_ID_KEYS } = await loadHarness("scripts/live-probe.mjs");
    const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
    for (const plan of PLANS) {
      // {T} is the target; the rest are seeded from TS_PROBE_* before step 1.
      const available = new Set<string>(["T", ...SEEDED_ID_KEYS]);
      for (const step of plan.steps(planCtx())) {
        const check = (text: string, what: string, extra: string[] = []) => {
          for (const [, name] of text.matchAll(PLACEHOLDER)) {
            assert.ok(
              available.has(name) || extra.includes(name),
              `${plan.probeId} step ${step.n} ${what} writes {${name}}, which nothing fills. It must come from ` +
                `{T}, a seeded id (${SEEDED_ID_KEYS.join(", ")}), or an earlier step's idKey.`,
            );
          }
        };
        // A journal sweep never resolves its own path: the runner replays the
        // undos it journalled, each already carrying the id that came back. The
        // declared path is the shape of those requests, for a reader.
        if (step.sweep !== "journal") {
          check(String(step.path), "path");
          check(JSON.stringify(step.tool?.input ?? null), "tool input");
          check(JSON.stringify(step.form ?? null), "form");
          // A raw step's body is sent exactly as written -- only a tool input
          // and a path go through resolvePath -- so a placeholder in one would
          // cross the wire as a literal.
          if (!step.tool) check(JSON.stringify(step.body ?? null), "body");
        }
        // An undo resolves against {...ctx.ids, id}, where `id` is the one the
        // create's own response returned.
        if (step.undo) check(String(step.undo.path), "undo path", ["id"]);
        if (step.registers === "id") available.add(step.idKey ?? "id");
      }
    }
  });

  it("the cleanup of a multi-create probe is a journal sweep, not a single {id}", async () => {
    // P10's `{id}` resolved, but to the LAST app created: every
    // `registers: "id"` step overwrites ctx.ids.id. A single-id cleanup on a
    // probe that creates several objects leaves the earlier ones behind.
    const { PLANS } = await loadHarness("scripts/lib/probe-plans/index.mjs");
    for (const plan of PLANS) {
      const steps = plan.steps(planCtx());
      const creates = steps.filter((s: { undo?: unknown }) => Boolean(s.undo)).length;
      if (creates < 2) continue;
      const cleanup = steps.filter((s: { arm: string }) => s.arm === "cleanup");
      assert.ok(
        cleanup.length > 0 && cleanup.every((s: { sweep?: string }) => s.sweep === "journal"),
        `${plan.probeId} creates ${creates} objects, so its cleanup has to sweep the journal`,
      );
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

/* ------------------------------------------------- the declared-vs-emitted note -- */

describe("planned request comparison", () => {
  // The CURRENT arms exist to find out what the shipped handler emits, so a
  // difference is a NOTE, not a refusal. It used to be a substring test over
  // `path + query`, which fired on every step carrying a query string -- all
  // ten of P1's and four of P13's -- because the handler builds its parameters
  // in its own order. A mismatch that always fires tells the operator nothing.
  it("ignores query order but reports a real difference", async () => {
    const { comparePlannedRequest } = await loadHarness("scripts/live-probe.mjs");
    const declared = "/tailnet/{tailnet}/logging/configuration?start=A&end=B";
    assert.equal(comparePlannedRequest(declared, "/tailnet/{tailnet}/logging/configuration?end=B&start=A"), null);
    assert.equal(comparePlannedRequest("/tailnet/{tailnet}/acl", "/tailnet/{tailnet}/acl"), null);

    // A parameter the handler dropped -- which is exactly finding C6.
    assert.match(
      String(comparePlannedRequest(declared, "/tailnet/{tailnet}/logging/configuration?start=A")),
      /end=<absent> \(planned B\)/,
    );
    // A different value.
    assert.match(
      String(comparePlannedRequest(declared, "/tailnet/{tailnet}/logging/configuration?start=A&end=Z")),
      /end=Z \(planned B\)/,
    );
    // A different path is still a path mismatch, reported as one.
    assert.match(
      String(comparePlannedRequest(declared, "/tailnet/{tailnet}/logging/network?start=A&end=B")),
      /emitted \/tailnet\/\{tailnet\}\/logging\/network, not the planned/,
    );
    // Repeated parameters compare as a set, not by order (P12, P17).
    assert.equal(
      comparePlannedRequest("/tailnet/{tailnet}/devices?tags=b&tags=a", "/tailnet/{tailnet}/devices?tags=a&tags=b"),
      null,
    );
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

  it("refuses a state file that exists but does not parse, and eats a BOM", async () => {
    const { main } = await loadHarness("scripts/live-probe.mjs");
    const dir = mkdtempSync(resolve(tmpdir(), "yaw-state-"));
    try {
      const path = join(dir, "probe-state.json");
      // Swallowing this into an empty state lost the cleanup journal AND the
      // target's client secret -- which scrub-check then drops from the values
      // it greps the fixtures for, before printing "clean".
      writeFileSync(path, "{ not json", "utf-8");
      await assert.rejects(
        main(["list", `--state-dir=${dir}`], { env: probeEnv(), log: () => {} }),
        (err: { code?: string }) => err.code === "unreadable-state",
      );
      // A BOM from a hand edit in a Windows editor is one way to get there, and
      // it is the one that should just work.
      writeFileSync(path, `﻿${JSON.stringify({ targets: {}, journal: [] })}`, "utf-8");
      assert.equal(await main(["list", `--state-dir=${dir}`], { env: probeEnv(), log: () => {} }), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a TS_PROBE_OPENAPI that names a file that is not there", async () => {
    const { main } = await loadHarness("scripts/live-probe.mjs");
    // A missing spec used to degrade to `openapiSha256: null`, which reads as
    // "captured with no spec in hand" rather than "the spec was named and
    // missed".
    await assert.rejects(
      main(["list"], { env: probeEnv({ TS_PROBE_OPENAPI: "no-such-spec.yaml" }), log: () => {} }),
      (err: { code?: string }) => err.code === "openapi-missing",
    );
    // A relative value is anchored at the REPO ROOT, not the cwd.
    assert.equal(await main(["list"], { env: probeEnv({ TS_PROBE_OPENAPI: "package.json" }), log: () => {} }), 0);
  });

  it("turns a stalled harness-local request into a readable failure, not a 300s park", async () => {
    const { rawRequest } = await loadHarness("scripts/live-probe.mjs");
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      const err = new Error("This operation was aborted");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    try {
      await assert.rejects(
        rawRequest("POST", "/oauth/token", { form: { grant_type: "client_credentials" } }),
        (err: Error) => /POST \/oauth\/token did not answer within 30s/.test(err.message),
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("forces 0600 on a state file that already existed with looser bits", async (t) => {
    if (process.platform === "win32") {
      t.skip("Windows does not carry Unix permissions");
      return;
    }
    const { writeState } = await loadHarness("scripts/live-probe.mjs");
    const dir = mkdtempSync(resolve(tmpdir(), "yaw-state-mode-"));
    try {
      const path = join(dir, "probe-state.json");
      // `mode` on writeFileSync is the open(2) CREATION mode: ignored when the
      // file is already there, so a pre-existing 0644 file kept 0644 through
      // every write while the comment claimed 0600.
      writeFileSync(path, "{}", "utf-8");
      chmodSync(path, 0o644);
      writeState(path, { targets: {}, journal: [] });
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("refuses a --state-dir inside the repo at the entry point, not just in the helper", async () => {
    // The state file holds a disposable tailnet's OAuth client secret. The
    // check was hoisted out of the two commands that happened to call it and
    // into main, and every test of it called the helper directly -- so a
    // refactor that dropped the call from main would have gone green.
    //
    // The injected `git` is what makes this reachable at all: .gitignore
    // ignores `probe-state.json` at any depth, so the real check-ignore answers
    // "ignored" for every --state-dir inside the repo. The interlock exists for
    // the day that line is edited away, and this is the only way to drive it
    // through the entry point. `list` is the command that sends the least.
    const { main } = await loadHarness("scripts/live-probe.mjs");
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("a refusal path attempted a network call");
    }) as unknown as typeof fetch;
    try {
      await assert.rejects(
        () =>
          main(["list", `--state-dir=${resolve(repoRoot, "fixtures")}`], {
            env: probeEnv(),
            log: () => {},
            git: () => false,
          }),
        /inside the repo and NOT ignored by git/,
      );
      // The same path with git saying "ignored" is allowed, so the refusal is
      // the ignore rule and not the location alone.
      assert.equal(
        await main(["list", `--state-dir=${resolve(repoRoot, "fixtures")}`], {
          env: probeEnv(),
          log: () => {},
          git: () => true,
        }),
        0,
      );
      // ... and the default, which is outside the repo, still lists.
      assert.equal(await main(["list"], { env: probeEnv(), log: () => {} }), 0);
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

  it("G0 refuses --execute through an injected env, because api.ts reads process.env", async () => {
    // THE interlock the harness rests on, and the one shape that could have
    // escaped it. `main(argv, { env })` strips the object it is HANDED, but
    // getAuthConfig reads process.env.TAILSCALE_API_KEY directly (api.ts:58-63)
    // and getTailnet defaults the tailnet to "-" from process.env (api.ts:231).
    // So through this entry point the probe credential would go into a synthetic
    // object api.ts never looks at, the operator's real key would authenticate
    // every request, and assertCredentialIsolation would be comparing against a
    // fingerprint computed from the synthetic object -- passing on a credential
    // it never saw. There is no safe way to do that, so --execute refuses here
    // and the CLI (where env IS process.env, and the strip is real) is the only
    // way to send anything.
    const { main } = await loadHarness("scripts/live-probe.mjs");
    const sentinel = "tskey-api-AMBIENT-NOT-REAL-process-env";
    const had = Object.hasOwn(process.env, "TAILSCALE_API_KEY") ? process.env.TAILSCALE_API_KEY : undefined;
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("the synthetic-env refusal path attempted a network call");
    }) as unknown as typeof fetch;
    process.env.TAILSCALE_API_KEY = sentinel;
    try {
      await assert.rejects(
        () =>
          main(["run", "P1-C6-log-end", "--execute"], {
            // Everything G1 asks for is satisfied, so this refusal is the only
            // thing standing between the injected entry point and a request.
            env: probeEnv({ TS_PROBE_TAILNET_ID: "probe-1", TAILSCALE_API_KEY: "tskey-api-INJECTED-NOT-REAL" }),
            log: () => {},
          }),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, "synthetic-env");
          assert.match(String((err as Error).message), /injected environment/);
          return true;
        },
      );
      // And the premise, stated as an assertion rather than as a comment: the
      // strip main ran did NOT touch process.env, which is where api.ts looks.
      assert.equal(process.env.TAILSCALE_API_KEY, sentinel);
    } finally {
      globalThis.fetch = original;
      if (had === undefined) delete process.env.TAILSCALE_API_KEY;
      else process.env.TAILSCALE_API_KEY = had;
    }
    assert.equal(calls, 0, "the refusal path reached the network");
  });

  it("a dry run through an injected env is still allowed, because it sends nothing", async () => {
    // The refusal above is about --execute only. If it applied to dry runs, the
    // review artefact the whole harness exists to produce would be unreachable
    // from a test, and the "makes ZERO network calls" proofs could not run.
    const { main } = await loadHarness("scripts/live-probe.mjs");
    const lines: string[] = [];
    const code = await main(["run", "P1-C6-log-end"], {
      env: probeEnv({ TS_PROBE_TAILNET_ID: "probe-1" }),
      log: (line: string) => lines.push(line),
    });
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /DRY RUN -- nothing was sent\./);
  });

  it("a single-dash option is a usage error, not a flag", async () => {
    // `-execute` used to parse as `--execute`: one missing keystroke in an
    // otherwise harmless position was the thing that authorised sending.
    const { main, parseArgs } = await loadHarness("scripts/live-probe.mjs");
    const args = parseArgs(["run", "P1-C6-log-end", "-execute"]);
    assert.deepEqual(args.badOptions, ["-execute"]);
    assert.notEqual(args.flags.execute, true);

    const lines: string[] = [];
    assert.equal(
      await main(["run", "P1-C6-log-end", "-execute"], { env: probeEnv(), log: (l: string) => lines.push(l) }),
      2,
    );
    assert.match(lines.join("\n"), /Unrecognised option\(s\): -execute/);
    // A mistyped option must not be silently dropped while the rest of the
    // command line runs on without it.
    assert.ok(!lines.join("\n").includes("DRY RUN"), "the command ran anyway with the option dropped");
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
      //
      // The child inherits this shell, so the COUNT is whatever the contributor
      // happens to export. An exact count here was green only on a machine with
      // exactly one TAILSCALE_ name: anyone using the OAuth path that
      // CONTRIBUTING.md and integration.test.ts both document would have seen
      // "stripped 4" and a red suite in the repo's only gate. Assert on the two
      // names this test controls, and on the count being at least those two.
      const stripped = /stripped (\d+) TAILSCALE_\* variable\(s\) from this process: (.*)/.exec(output);
      assert.ok(stripped, `no strip line in:\n${output}`);
      const names = stripped[2].split(", ").map((name) => name.trim());
      assert.ok(names.includes("TAILSCALE_API_KEY"), stripped[0]);
      assert.ok(names.includes("TAILSCALE_TAILNET"), stripped[0]);
      assert.ok(Number(stripped[1]) >= 2, stripped[0]);
      assert.equal(Number(stripped[1]), names.length, "the count and the list must agree");
      assert.ok(!output.includes("tskey-api-AMBIENT-NOT-REAL"), "the ambient key was printed");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("still runs when the checkout is reached through a symlink or junction", (t) => {
    // The entry-point guard compared a realpath'd import.meta.url (the ESM
    // loader resolves links) against a merely resolve()d argv[1]. Through a
    // link the two spellings differ, `invokedDirectly` went false, and since
    // the `if` is the file's only top-level statement the process printed
    // NOTHING and exited 0 -- indistinguishable from success for a tool whose
    // entire product is the printed request list.
    //
    // This test cannot use `repoRoot` directly: it is already realpath'd, which
    // is exactly why the defect survived the suite.
    const tmp = mkdtempSync(resolve(tmpdir(), "yaw-junction-"));
    const link = join(tmp, "repo-link");
    try {
      if (!linkDir(repoRoot, link)) {
        t.skip("this host does not permit creating a directory link");
        return;
      }
      const res = spawnSync(process.execPath, [join(link, "scripts", "live-probe.mjs"), "list"], {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 120_000,
        env: { ...process.env, LOCALAPPDATA: tmp, XDG_STATE_HOME: tmp, TS_PROBE_OPENAPI: "" },
      });
      const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      assert.equal(res.status, 0, `exited ${res.status}:\n${output}`);
      assert.match(output, /live-probe: stripped \d+ TAILSCALE_\* variable\(s\)/, output);
      assert.match(output, /NOT IMPLEMENTED \(by design, not by omission\)/, output);
    } finally {
      unlinkDir(link);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------- contributor scripts -- */

describe("contributor scripts", () => {
  it("lint.mjs runs a .cmd shim whose path contains a space", (t) => {
    if (process.platform !== "win32") {
      t.skip("the cmd.exe re-splitting hazard is Windows-only");
      return;
    }
    // Node's Windows shell path builds `cmd.exe /d /s /c "<command> <args>"`
    // and quotes nothing inside it, so an unquoted .cmd truncated at the first
    // space in the checkout path (`'C:\a' is not recognized`). `shell: false`
    // is not the way out either -- it throws EINVAL on a .cmd. Same hazard
    // lint.mjs's own npmCliPath comment documents for npm.
    const tmp = mkdtempSync(resolve(tmpdir(), "yaw lint-"));
    try {
      const shim = join(tmp, "fake-biome.cmd");
      writeFileSync(shim, ["@echo off", "echo FAKE-BIOME-RAN", "exit /b 0", ""].join("\r\n"), "utf-8");
      const res = spawnSync(process.execPath, [join(repoRoot, "scripts", "lint.mjs"), "check", "src/"], {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 120_000,
        env: { ...process.env, YAWLABS_BIOME_BIN: shim },
      });
      const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      assert.equal(res.status, 0, `exited ${res.status}:\n${output}`);
      assert.match(output, /FAKE-BIOME-RAN/, output);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
