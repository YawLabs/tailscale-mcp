import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PROFILES } from "./filter.js";
// Coupling worth knowing: buildToolGroups transitively imports all 14 tool
// modules (and zod through them), so a module-load error anywhere under
// src/tools/ fails THIS suite too, and the failure reads as a release-metadata
// problem. Accepted deliberately -- the README counts are only meaningful when
// checked against the live registry, and a hand-copied count here would be the
// exact drift these tests exist to catch. If this suite fails unexpectedly,
// check src/tools/*.ts loads first.
import { buildToolGroups } from "./server-wiring.js";

// Resolve via import.meta.url so the test works regardless of process.cwd() --
// `npm test` runs from the repo root today, but a future runner invoking
// dist/release-metadata.test.js directly would otherwise hit ENOENT silently.
// __dirname for the compiled test is dist/, so the repo root is one level up.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, rel), "utf-8")) as Record<string, unknown>;
}

describe("release metadata", () => {
  // server.json is what the Official MCP Registry reads at publish time. It
  // carries the version twice (top-level + packages[].version) and is bumped
  // separately from package.json by release.sh -- without this test, a manual
  // edit that updates one but not the other would ship a desynced registry
  // entry.
  it("server.json top-level version matches package.json", () => {
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    assert.equal(
      server.version,
      pkg.version,
      `server.json version (${String(server.version)}) must match package.json version (${String(pkg.version)})`,
    );
  });

  it("server.json packages[].version all match package.json", () => {
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    const packages = server.packages as Array<{ version: string; identifier?: string }> | undefined;
    assert.ok(Array.isArray(packages) && packages.length > 0, "server.json must declare at least one package");
    for (const entry of packages) {
      assert.equal(
        entry.version,
        pkg.version,
        `server.json packages entry (${entry.identifier ?? "<unnamed>"}) version (${entry.version}) ` +
          `must match package.json version (${String(pkg.version)})`,
      );
    }
  });

  it("mcpName in package.json matches server.json name", () => {
    // Catches a different drift mode: registry publish keys the package by
    // `name`, and the npm consumer looks at `mcpName`. They must agree or
    // discovery and install land on different identifiers.
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    // Precondition: both fields must actually be present. Without these the
    // equality below passes vacuously if BOTH happen to be undefined (e.g. a
    // refactor accidentally removes both fields), masking a real bug.
    assert.ok(
      typeof pkg.mcpName === "string" && pkg.mcpName.length > 0,
      "package.json must declare a non-empty `mcpName`",
    );
    assert.ok(typeof server.name === "string" && server.name.length > 0, "server.json must declare a non-empty `name`");
    assert.equal(pkg.mcpName, server.name, "package.json mcpName must equal server.json name");
  });
});

describe("README tool counts", () => {
  // The startup banner derives its tool count from the live registry, so it can
  // never drift. The README's counts are hand-typed in seven places and DID
  // drift: the local-cli banner example claimed 89 tools when enabling local-cli
  // actually yields 93. These assertions make the README a checked artifact.
  //
  // Deliberately aggregate-only: matching each <summary> heading to its module
  // would need a brittle prose-name -> export mapping. Summing them catches
  // per-group drift without one, because the total has to reconcile.
  const readme = readFileSync(resolve(repoRoot, "README.md"), "utf-8");

  const groupsWithoutLocalCli = buildToolGroups({});
  const groupsWithLocalCli = buildToolGroups({ TAILSCALE_LOCAL_CLI: "1" });
  const countOf = (groups: Record<string, ReadonlyArray<unknown>>, names?: readonly string[]): number =>
    (names ?? Object.keys(groups)).reduce((n, g) => n + (groups[g]?.length ?? 0), 0);

  const DEFAULT_TOTAL = countOf(groupsWithoutLocalCli);
  const TOTAL_WITH_LOCAL_CLI = countOf(groupsWithLocalCli);

  /** All capture-group-1 values for `re`, as numbers. Fails loudly if none match. */
  function allMatches(re: RegExp, label: string): number[] {
    const found = [...readme.matchAll(re)].map((m) => Number(m[1]));
    assert.ok(
      found.length > 0,
      `README pattern for ${label} matched nothing -- the doc was reworded, update this test`,
    );
    return found;
  }

  it("the <summary> per-group counts sum to the full tool count including local-cli", () => {
    const perGroup = allMatches(/<summary>.*?\((\d+) tools?\b/g, "per-group <summary> headings");
    const sum = perGroup.reduce((a, b) => a + b, 0);
    assert.equal(
      sum,
      TOTAL_WITH_LOCAL_CLI,
      `README's per-group headings sum to ${sum} but the registry has ${TOTAL_WITH_LOCAL_CLI} tools ` +
        `(${DEFAULT_TOTAL} default + local-cli). Counts found: ${perGroup.join(", ")}`,
    );
  });

  it("the profile bullets match the PROFILES presets", () => {
    const minimal = allMatches(/`minimal`\*\*\s*\((\d+) tools?\)/g, "minimal profile bullet")[0];
    const core = allMatches(/`core`\*\*\s*\((\d+) tools?\)/g, "core profile bullet")[0];
    const full = allMatches(/`full`\*\*\s*\((\d+) tools?, default\)/g, "full profile bullet")[0];
    assert.equal(minimal, countOf(groupsWithoutLocalCli, PROFILES.minimal), "minimal profile count");
    assert.equal(core, countOf(groupsWithoutLocalCli, PROFILES.core), "core profile count");
    assert.equal(full, DEFAULT_TOTAL, "full profile count");
  });

  it("the 'N tools is a lot' lede matches the default tool count", () => {
    const lede = allMatches(/^(\d+) tools is a lot/gm, "the subsetting lede")[0];
    assert.equal(lede, DEFAULT_TOTAL);
  });

  it("the local-cli banner example counts the local-cli tools", () => {
    // The exact drift this suite was added for: local-cli is ADDITIVE on top of
    // the default set, so its banner shows more tools, not the same number.
    const banner = allMatches(/ready \((\d+) tools, local-cli=on\)/g, "the local-cli banner example")[0];
    assert.equal(
      banner,
      TOTAL_WITH_LOCAL_CLI,
      `README's local-cli banner says ${banner} tools; enabling local-cli yields ${TOTAL_WITH_LOCAL_CLI}`,
    );
    assert.notEqual(banner, DEFAULT_TOTAL, "local-cli must not show the same count as the default set");
  });

  it("the minimal-profile banner example matches the minimal preset", () => {
    const banner = allMatches(/ready \((\d+) tools, profile=minimal/g, "the minimal banner example")[0];
    assert.equal(banner, countOf(groupsWithoutLocalCli, PROFILES.minimal));
  });

  it("the TAILSCALE_TOOLS override banner example matches devices+acl", () => {
    // `ready (N tools, profile=core (overridden by TAILSCALE_TOOLS), groups=devices,acl)`
    const banner = allMatches(/ready \((\d+) tools, profile=core \(overridden/g, "the override banner example")[0];
    assert.equal(banner, countOf(groupsWithoutLocalCli, ["devices", "acl"]));
  });
});

describe("sandbox env allow-list", () => {
  // Regression guard. TAILSCALE_LOCAL_CLI was missing from this list, so under
  // TAILSCALE_MCP_SANDBOX=1 the variable was absent from process.env and the
  // local-CLI tool group silently never registered. oam denies a non-granted
  // env var by making it ABSENT rather than throwing, so the whole failure mode
  // is silent by construction -- exactly the kind that needs a test rather than
  // a careful reader.
  //
  // The original omission slipped through because the list was derived by
  // looking for `process.env.TAILSCALE_*`, and isLocalCliEnabled reads its var
  // off a passed-in `env` PARAMETER instead. This test greps for the NAME, not
  // the access pattern, so it has no such blind spot.
  const launcher = readFileSync(resolve(repoRoot, "bin/tailscale-mcp.mjs"), "utf-8");

  function srcFiles(): string[] {
    const out: string[] = [];
    for (const dir of ["src", "src/tools"]) {
      for (const name of readdirSync(resolve(repoRoot, dir))) {
        if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(`${dir}/${name}`);
      }
    }
    return out;
  }

  function namesIn(text: string): Set<string> {
    return new Set(text.match(/TAILSCALE_[A-Z0-9_]+/g) ?? []);
  }

  it("grants every TAILSCALE_* variable the server source reads", () => {
    const arrayMatch = launcher.match(/const env = \[([\s\S]*?)\];/);
    assert.ok(arrayMatch, "could not locate the `const env = [...]` allow-list in bin/tailscale-mcp.mjs");
    const granted = namesIn(arrayMatch[1]);

    const used = new Set<string>();
    for (const rel of srcFiles()) {
      for (const name of namesIn(readFileSync(resolve(repoRoot, rel), "utf-8"))) used.add(name);
    }
    assert.ok(used.size > 5, `expected to find several env vars in src/, found ${used.size}`);

    const missing = [...used].filter((n) => !granted.has(n)).sort();
    assert.deepEqual(
      missing,
      [],
      `these env vars are read by src/ but not granted in the sandbox allow-list, so they will be ` +
        `silently absent under TAILSCALE_MCP_SANDBOX=1: ${missing.join(", ")}`,
    );
  });
});
