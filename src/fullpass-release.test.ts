/**
 * Offline checks for the full-pass fixes to release.sh and the live probe
 * harness (scripts/live-probe.mjs). Nothing here sends a request: every
 * harness call is a dry run or a refusal, behind a fetch stub that throws.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function loadHarness() {
  return import(pathToFileURL(resolve(repoRoot, "scripts", "live-probe.mjs")).href);
}

function probeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(resolve(tmpdir(), "yaw-fullpass-state-"));
  return {
    TS_PROBE_FORBIDDEN_TAILNETS: "real.example.com,tailnet-real",
    LOCALAPPDATA: dir,
    XDG_STATE_HOME: dir,
    ...extra,
  };
}

async function withNoNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("an offline test attempted a network call");
  }) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe("live-probe full-pass fixes", () => {
  it("parseArgs splits an option at the first '=' only", async () => {
    const { parseArgs } = await loadHarness();
    const args = parseArgs(["list", "--state-dir=C:/x=y/state", "--allow-real-reversible=P7=a"]);
    assert.equal(args.flags["state-dir"], "C:/x=y/state");
    assert.deepEqual(args.allowRealReversible, ["P7=a"]);
    assert.equal(parseArgs(["run", "--execute"]).flags.execute, true);
  });

  it("collectIds finds a webhook's endpointId; createdIds ignores nested foreign ids", async () => {
    const { collectIds, createdIds } = await loadHarness();
    assert.deepEqual(collectIds({ endpointId: "w1", endpointUrl: "https://x" }, []), ["w1"]);
    const response = { id: "app1", owner: { id: "user9" }, device: { deviceId: "d1" } };
    assert.deepEqual(collectIds(response, []).sort(), ["app1", "d1", "user9"]);
    assert.deepEqual(createdIds(response), ["app1"]);
    assert.deepEqual(createdIds({ endpointId: "w1" }), ["w1"]);
    // Invite creates return an array: one created id per element, and a
    // device invite's own deviceId is a reference, not something created.
    assert.deepEqual(
      createdIds([
        { id: "i1", deviceId: "d1" },
        { id: "i2", deviceId: "d1" },
      ]),
      ["i1", "i2"],
    );
    assert.deepEqual(createdIds({ searchPaths: [] }), []);
    assert.deepEqual(createdIds(null), []);
  });

  it("scrub-check looks for the P15 downscope client secret", async () => {
    const { main } = await loadHarness();
    const tmp = mkdtempSync(resolve(tmpdir(), "yaw-fullpass-scrub-"));
    try {
      const planted = "tskey-client-DOWNSCOPE-PLANTED-NOT-REAL";
      mkdirSync(join(tmp, "P15"), { recursive: true });
      writeFileSync(join(tmp, "P15", "01-leak.json"), JSON.stringify({ response: { body: { secret: planted } } }));
      const lines: string[] = [];
      const code = await main(["scrub-check"], {
        env: probeEnv({ TS_PROBE_FIXTURE_ROOT: tmp, TS_PROBE_DOWNSCOPE_CLIENT_SECRET: planted }),
        log: (l: string) => lines.push(l),
      });
      const output = lines.join("\n");
      assert.equal(code, 1, output);
      assert.match(output, /TS_PROBE_DOWNSCOPE_CLIENT_SECRET/);
      assert.ok(!output.includes(planted), "scrub-check printed the secret it found");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("provision --execute refuses an empty forbidden list before sending", async () => {
    const { main } = await loadHarness();
    await withNoNetwork(() =>
      assert.rejects(
        () =>
          main(["provision", "--execute"], {
            env: { LOCALAPPDATA: mkdtempSync(resolve(tmpdir(), "yaw-fullpass-st-")) },
            log: () => {},
          }),
        /TS_PROBE_FORBIDDEN_TAILNETS is empty/,
      ),
    );
  });

  it("the dry-run interlock report names the pinned version TS_PROBE_PINNED_VERSION asks for", async () => {
    const { main } = await loadHarness();
    const lines: string[] = [];
    const code = await withNoNetwork(() =>
      main(["run", "--all"], {
        env: probeEnv({ TS_PROBE_PINNED_VERSION: "0.21.2" }),
        log: (l: string) => lines.push(l),
      }),
    );
    assert.equal(code, 0);
    const output = lines.join("\n");
    assert.match(output, /pinned build \(v0\.21\.2\):/);
    assert.ok(!output.includes("pinned v0.20.2 build"), "the label still hardcodes the default version");
  });

  it("cleanup --ack-manual closes manual-sweep entries without sending", async () => {
    const { main, readState } = await loadHarness();
    const stateDir = mkdtempSync(resolve(tmpdir(), "yaw-fullpass-ack-"));
    try {
      const statePath = join(stateDir, "probe-state.json");
      const manual = {
        kind: "undo",
        probeId: "P7-C4-webhook-patch",
        step: 2,
        done: false,
        needsManualSweep: true,
        undo: { id: null, method: "DELETE", path: "/webhooks/{id}", body: null },
      };
      const replayable = {
        kind: "undo",
        probeId: "P8-C5-key-put",
        step: 2,
        done: false,
        needsManualSweep: false,
        undo: { id: "k1", method: "DELETE", path: "/tailnet/{T}/keys/k1", body: null },
      };
      writeFileSync(statePath, JSON.stringify({ targets: {}, journal: [manual, replayable] }));
      const lines: string[] = [];
      const code = await withNoNetwork(() =>
        main(["cleanup", "--ack-manual", `--state-dir=${stateDir}`], {
          env: probeEnv({ TS_PROBE_TAILNET_ID: "probe-1" }),
          log: (l: string) => lines.push(l),
        }),
      );
      assert.equal(code, 0, lines.join("\n"));
      const state = readState(statePath);
      assert.equal(state.journal[0].done, true);
      assert.equal(typeof state.journal[0].manualSweepAckedAt, "string");
      // The replayable undo is untouched: acknowledging is for manual entries only.
      assert.equal(state.journal[1].done, false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("release.sh full-pass fixes", () => {
  const releaseSh = readFileSync(resolve(repoRoot, "release.sh"), "utf-8");

  it("the step 4 commit gate counts a CHANGELOG.md-only change as something to commit", () => {
    assert.match(releaseSh, /git status --porcelain package\.json package-lock\.json server\.json CHANGELOG\.md/);
  });

  it("pre-flight checks for jq, which the server.json sync needs", () => {
    assert.match(releaseSh, /^command -v jq >\/dev\/null +\|\| fail /m);
  });

  it("no printf format string spans a line break", () => {
    assert.doesNotMatch(releaseSh, /printf '[^'\n]*\n[^']*'/);
  });

  it("the npm package name is read from package.json, not hardcoded", () => {
    assert.match(releaseSh, /^PKG_NAME=\$\(node -p "require\('\.\/package\.json'\)\.name"\)$/m);
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as { name: string };
    assert.ok(!releaseSh.includes(`${pkg.name}@`), "release.sh still hardcodes <name>@<version>");
    assert.ok(!releaseSh.includes(pkg.name.replace("/", "%2F")), "release.sh still hardcodes the escaped name");
  });

  it("the CHANGELOG predecessor uses the same stable-only tag filter as compute_prev_tag", () => {
    assert.doesNotMatch(releaseSh, /git describe --tags/);
    assert.match(releaseSh, /changelog_prev_tag\(\) \{\n[^\n]*newest_stable_tag_except/);
    assert.match(releaseSh, /compute_prev_tag\(\) \{\n {2}stable_tags \|/);
  });
});
