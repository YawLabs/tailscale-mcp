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

  it("server.json packages[] version and npm identifier both match package.json", () => {
    const pkg = readJson("package.json");
    const server = readJson("server.json");
    type PackageEntry = { version: string; identifier?: string; registryType?: string };
    const packages = server.packages as PackageEntry[] | undefined;
    assert.ok(Array.isArray(packages) && packages.length > 0, "server.json must declare at least one package");
    // Precondition for the identifier check below: if `registryType` is ever
    // renamed or dropped, the gate inside the loop silently stops running and
    // this test would keep passing while checking nothing.
    assert.ok(
      packages.some((entry) => entry.registryType === "npm"),
      "server.json must still declare an npm package entry",
    );
    for (const entry of packages) {
      assert.equal(
        entry.version,
        pkg.version,
        `server.json packages entry (${entry.identifier ?? "<unnamed>"}) version (${entry.version}) ` +
          `must match package.json version (${String(pkg.version)})`,
      );
      // `identifier` is the package the registry hands an installer, so drift
      // here points `npx` at something other than what this repo publishes --
      // and release.sh rewrites only `.version` and `.packages[0].version`, so
      // identifier is hand-maintained. Same two-file drift the version checks
      // guard, one field over. The registry does validate npm ownership at
      // publish time, so the realistic cost is not a bad install but a release
      // aborting AFTER npm publish and the tag push; catching it here is a
      // whole release cheaper.
      //
      // Gated on registryType because `identifier` equals the npm name only for
      // npm entries: this repo already ships standalone binaries and Scoop /
      // Homebrew manifests, so an oci or mcpb entry (whose identifier is an
      // image reference) would false-fail an ungated assertion.
      if (entry.registryType === "npm") {
        assert.ok(typeof pkg.name === "string" && pkg.name.length > 0, "package.json must declare a non-empty `name`");
        assert.ok(
          typeof entry.identifier === "string" && entry.identifier.length > 0,
          "server.json npm package entry must declare a non-empty `identifier`",
        );
        assert.equal(
          entry.identifier,
          pkg.name,
          `server.json npm identifier (${String(entry.identifier)}) must equal package.json name (${String(pkg.name)})`,
        );
      }
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

describe("bundled version define", () => {
  // cli.test.ts spawns dist/index.js and compares its --version output to
  // package.json, which pins the version the shipped bundle REPORTS. What that
  // cannot see is where the number came from: index.ts falls back to reading
  // package.json at runtime when `__VERSION__` is undefined, and the fallback
  // returns the same string -- so a build.mjs that lost its esbuild `define`
  // would still print the right version and leave that suite green, shipping a
  // bundle that resolves its version off a file the npx tarball happens to
  // carry. This is the check that fails on it.
  //
  // Reading dist/ is safe here for the reason the compiled-test-artifacts block
  // below relies on: `npm test` is `npm run build && node --test
  // "dist/**/*.test.js"`, so the bundle has already been written by the time
  // this compiled test -- its sibling in dist/ -- runs.
  it("dist/index.js inlines the package.json version and keeps no __VERSION__ token", () => {
    const version = readJson("package.json").version;
    assert.ok(typeof version === "string" && version.length > 0, "package.json must declare a non-empty `version`");
    const bundle = readFileSync(resolve(repoRoot, "dist/index.js"), "utf-8");

    // Drop the `define` from build.mjs and the token survives substitution,
    // leaving `typeof __VERSION__ !== "undefined"` in the bundle -- false at
    // runtime, so the fallback path, silently.
    assert.ok(
      !bundle.includes("__VERSION__"),
      "dist/index.js still carries a __VERSION__ token, so esbuild's `define` in build.mjs did not substitute it " +
        "and the shipped bundle resolves its version by reading package.json at runtime",
    );
    // And what it substituted is the right value: the literal reaches the
    // bundle only through that define.
    assert.ok(
      bundle.includes(JSON.stringify(version)),
      `dist/index.js does not contain ${JSON.stringify(version)} as a string literal, so the define did not ` +
        "substitute package.json's version",
    );
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
  const LOCAL_CLI_TOTAL = TOTAL_WITH_LOCAL_CLI - DEFAULT_TOTAL;

  /** All capture-group-1 values for `re`, as numbers. Fails loudly if none match. */
  function allMatches(re: RegExp, label: string): number[] {
    const found = [...readme.matchAll(re)].map((m) => Number(m[1]));
    assert.ok(
      found.length > 0,
      `README pattern for ${label} matched nothing -- the doc was reworded, update this test`,
    );
    return found;
  }

  /**
   * Assert EVERY occurrence of `re` carries `expected`, not just the first.
   *
   * The single-value call sites below used to index `[0]` and drop the rest, so
   * a second, stale copy of a banner or a profile bullet was unchecked -- and
   * quickstart / config blocks are exactly the prose that gets duplicated. Not
   * `found.length === 1`: that would fail the suite the first time someone adds
   * a second CORRECT mention, which is a false failure on a valid README and
   * the kind of test-tax the aggregate-only note above declines. Asserting the
   * VALUE of every match catches the stale copy with no such downside.
   */
  function assertEveryMatch(re: RegExp, label: string, expected: number): void {
    const found = allMatches(re, label);
    for (const n of found) {
      assert.equal(
        n,
        expected,
        `README ${label}: found ${n}, registry says ${expected} (all matches: ${found.join(", ")})`,
      );
    }
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
    const minimal = countOf(groupsWithoutLocalCli, PROFILES.minimal);
    const core = countOf(groupsWithoutLocalCli, PROFILES.core);
    assertEveryMatch(/`minimal`\*\*\s*\((\d+) tools?\)/g, "minimal profile bullet", minimal);
    assertEveryMatch(/`core`\*\*\s*\((\d+) tools?\)/g, "core profile bullet", core);
    assertEveryMatch(/`full`\*\*\s*\((\d+) tools?, default\)/g, "full profile bullet", DEFAULT_TOTAL);
  });

  it("the 'N tools is a lot' lede matches the default tool count", () => {
    assertEveryMatch(/^(\d+) tools is a lot/gm, "the subsetting lede", DEFAULT_TOTAL);
  });

  it("the prose mentions of the default tool count all match the registry", () => {
    // The lede above is one of six hand-typed copies of the same number. These
    // are the other phrasings, in the tagline, the local-cli note, the Tools
    // heading and the oam section -- each one a place a reader forms an
    // expectation the banner then contradicts. They were unchecked because no
    // pattern matched them, not because anything guaranteed they agree.
    assertEveryMatch(/(\d+) admin-API tools/g, "the tagline tool count", DEFAULT_TOTAL);
    assertEveryMatch(/additive on top of the default (\d+)/g, "the local-cli additive note", DEFAULT_TOTAL);
    assertEveryMatch(/^## Tools \((\d+) \+ \d+ opt-in\)/gm, "the Tools section heading", DEFAULT_TOTAL);
    assertEveryMatch(/all (\d+) tools, all \d+ resources/g, "the oam verification note", DEFAULT_TOTAL);
  });

  it("the prose mentions of the opt-in local-cli count all match the registry", () => {
    // The default half of each of these phrasings is checked above, but the
    // local-cli half sat inside an uncaptured `\d+` -- matched, so the pattern
    // still found the line, yet never compared to anything. That is the worst
    // of both: the regex looks like coverage and the number underneath it can
    // go stale with the suite green. Local-cli is additive, so its count is the
    // difference between the two registry totals, not a separate constant.
    assertEveryMatch(/^## Tools \(\d+ \+ (\d+) opt-in\)/gm, "the Tools heading opt-in count", LOCAL_CLI_TOTAL);
    assertEveryMatch(/(\d+) optional local-CLI diagnostics/g, "the tagline local-cli count", LOCAL_CLI_TOTAL);
    assertEveryMatch(/the (\d+) local CLI tools are additive/g, "the additive-note local-cli count", LOCAL_CLI_TOTAL);
  });

  it("the local-cli banner example counts the local-cli tools", () => {
    // The exact drift this suite was added for: local-cli is ADDITIVE on top of
    // the default set, so its banner shows more tools, not the same number.
    assertEveryMatch(/ready \((\d+) tools, local-cli=on\)/g, "the local-cli banner example", TOTAL_WITH_LOCAL_CLI);
    assert.notEqual(TOTAL_WITH_LOCAL_CLI, DEFAULT_TOTAL, "local-cli must not show the same count as the default set");
  });

  it("the minimal-profile banner example matches the minimal preset", () => {
    const expected = countOf(groupsWithoutLocalCli, PROFILES.minimal);
    assertEveryMatch(/ready \((\d+) tools, profile=minimal/g, "the minimal banner example", expected);
  });

  it("the TAILSCALE_TOOLS override banner example matches devices+acl", () => {
    // `ready (N tools, profile=core (overridden by TAILSCALE_TOOLS), groups=devices,acl)`
    const expected = countOf(groupsWithoutLocalCli, ["devices", "acl"]);
    assertEveryMatch(/ready \((\d+) tools, profile=core \(overridden/g, "the override banner example", expected);
  });

  it("each <details> block's heading count matches the tool rows inside it", () => {
    // The sum check above reconciles equal-and-opposite drift: move a tool from
    // one group's heading to another's and the total still matches. Each block
    // carries its own tools one per table row, so checking a heading against
    // the rows BELOW it needs no prose-name -> export mapping -- it is pure
    // self-consistency inside the README, which is why it dodges the brittleness
    // the aggregate-only note above rejects. (The README's 16 blocks do not map
    // onto the registry's groups anyway: `invites` is split into Device and User
    // Invites, and `audit` is titled Logging.)
    const blocks = [...readme.matchAll(/<summary>.*?\((\d+) tools?\b[\s\S]*?<\/details>/g)];
    assert.ok(blocks.length > 10, `expected the README's tool <details> blocks, found ${blocks.length}`);
    for (const block of blocks) {
      const heading = block[0].slice(0, block[0].indexOf("</summary>"));
      const rows = [...block[0].matchAll(/^\|\s*`(tailscale_[a-z0-9_]+)`\s*\|/gm)];
      assert.equal(
        rows.length,
        Number(block[1]),
        `README block ${JSON.stringify(heading)} claims ${block[1]} tools but lists ${rows.length}`,
      );
    }
  });

  it("the README's tool tables name exactly the registry's tools", () => {
    // The counts above are all a rename survives: swap a name in the registry
    // and every number still reconciles, leaving the README telling operators
    // to call a tool that no longer exists. This is the check that catches it,
    // and it is group-agnostic on purpose -- a flat union on both sides, so the
    // README's headings can be reorganised freely.
    const documented = new Set([...readme.matchAll(/^\|\s*`(tailscale_[a-z0-9_]+)`\s*\|/gm)].map((m) => m[1]));
    const registered = new Set(
      Object.values(groupsWithLocalCli)
        .flat()
        .map((t) => t.name),
    );
    const undocumented = [...registered].filter((n) => !documented.has(n)).sort();
    const stale = [...documented].filter((n) => !registered.has(n)).sort();
    assert.deepEqual(undocumented, [], `registered but missing from the README tables: ${undocumented.join(", ")}`);
    assert.deepEqual(stale, [], `listed in the README but not registered (renamed or removed?): ${stale.join(", ")}`);
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

  /**
   * Every non-test .ts under src/, RECURSIVELY.
   *
   * It used to walk a hardcoded ["src", "src/tools"], which tracked today's
   * layout rather than what ships: tsconfig compiles all of `src`, so a var read
   * from a future src/<anything-else>/*.ts is bundled and shipped but was
   * outside this guard's field of view. The `used.size > 5` tripwire below could
   * not have caught that either -- the two known directories already yield 16
   * names, so it never fires on a directory that simply is not scanned.
   */
  function srcFiles(dir = "src"): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...srcFiles(rel));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(rel);
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

describe("compiled test artifacts", () => {
  // `npm test` is `npm run build && node --test "dist/**/*.test.js"`, and that
  // glob runs whatever is sitting in dist/. tsc does not delete the output of a
  // source that went away, and `clean` is wired only into prepublishOnly -- so a
  // renamed or deleted src/*.test.ts leaves its compiled dist/*.test.js in the
  // glob indefinitely, still passing against an equally stale dist/*.js that no
  // longer has a source behind it. The failure mode is quiet and durable: the
  // suite reports green forever on a file nobody can find in src/, and no
  // per-file reading of the tests can reveal it, because the defect lives in the
  // gap between package.json's scripts and the glob.
  //
  // There are no orphans today, so this is a tripwire rather than a repair. It
  // is preferred over making `test` depend on `clean` because that would cost a
  // full tsc rebuild on every single run; this costs two directory walks.
  function walk(dir: string, suffix: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(rel, suffix));
      else if (entry.name.endsWith(suffix)) out.push(rel);
    }
    return out;
  }

  it("dist/**/*.test.js maps one-to-one onto src/**/*.test.ts", () => {
    const fromSrc = walk("src", ".test.ts").map((p) => p.replace(/^src\//, "").replace(/\.ts$/, ".js"));
    const inDist = walk("dist", ".test.js").map((p) => p.replace(/^dist\//, ""));
    assert.ok(fromSrc.length > 5, `expected several test sources under src/, found ${fromSrc.length}`);

    const orphaned = inDist.filter((p) => !fromSrc.includes(p));
    assert.deepEqual(
      orphaned,
      [],
      `these compiled tests have no source in src/ and are still being run by the test glob -- ` +
        `run \`npm run clean\` and rebuild: ${orphaned.join(", ")}`,
    );

    // The other direction is a different bug with the same symptom (a test that
    // is not really running): a source that failed to compile, or landed
    // outside tsconfig's rootDir.
    const missing = fromSrc.filter((p) => !inDist.includes(p));
    assert.deepEqual(
      missing,
      [],
      `these test sources produced no dist/ output, so the suite never runs them: ${missing.join(", ")}`,
    );
  });
});

describe("coverage diagnostic", () => {
  // `npm run test:coverage` uses Node's BUILT-IN --experimental-test-coverage.
  // No c8, no nyc, no added dependency -- this package ships with zero runtime
  // deps and the bundle exists to keep the tarball small; a coverage tool is not
  // worth a devDependency when the runtime already has one. The exclude flag
  // wants Node 22+, which is what `devEngines` already requires of contributors;
  // `engines` stays at 20.11 because that floor is about RUNNING the server, and
  // this script is a development diagnostic.
  //
  // Two rows in that report read FALSE on this suite's exact shape, which is why
  // the script carries exclusions and no threshold:
  //
  //   1. `dist/index.js` reports around 34% line / 20% funcs with its uncovered
  //      lines running past 34,000. That row is not index.ts -- it is the esbuild
  //      bundle with zod and the MCP SDK inlined, instrumented through the child
  //      servers index.test.ts spawns. Excluded, because no number it reports
  //      would mean anything.
  //
  //   2. `dist/tools/posture.js` under-reports (~77% line / 25% funcs, listing
  //      all five handler bodies as uncovered) while running
  //      `node --experimental-test-coverage --test dist/handlers.test.js` alone
  //      reports the same file at 100. Cause: tools.test.ts cache-busts with
  //      `import("./posture.js?enumcase=1")` to re-evaluate the module, which
  //      registers a SECOND script URL for one file, and the reporter collapses
  //      the two rows to the worse one. Deterministic, not a race -- identical
  //      under --test-concurrency=1. Not excludable without losing the file
  //      entirely, so it is documented here instead.
  //
  // Hence: a diagnostic, deliberately not wired into `npm test` and deliberately
  // carrying no threshold flag. A gate set against those two rows would either
  // sit below the real number to accommodate them, or fail the build over five
  // phantom uncovered handlers.
  const pkg = readJson("package.json");
  const scripts = pkg.scripts as Record<string, string>;
  const devDeps = pkg.devDependencies as Record<string, string>;

  it("test:coverage uses the runtime's own coverage, with both false-reading rows excluded", () => {
    const coverage = scripts["test:coverage"];
    assert.ok(coverage, "package.json must declare a `test:coverage` script");
    assert.match(coverage, /--experimental-test-coverage/);
    assert.match(coverage, /--test-coverage-exclude=\S*\*\.test\.js/, "exclude the test files themselves");
    assert.match(coverage, /--test-coverage-exclude=\S*dist\/index\.js/, "exclude the esbuild bundle row");
    for (const dep of ["c8", "nyc"]) {
      assert.ok(!(dep in devDeps), `${dep} is not needed -- Node's built-in coverage is what test:coverage uses`);
    }
  });

  it("stays a diagnostic: not part of `npm test`, and not a threshold gate", () => {
    assert.ok(
      !scripts.test.includes("--experimental-test-coverage"),
      "coverage instrumentation slows every run; keep it out of the default test script",
    );
    assert.ok(
      !/--test-coverage-(lines|branches|functions)=/.test(scripts["test:coverage"]),
      "a threshold here would be measured against the two rows documented above -- see this describe's comment",
    );
  });
});
