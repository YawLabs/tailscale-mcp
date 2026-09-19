import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Same resolution as release-metadata.test.ts: __dirname for the compiled test
// is dist/, so the repo root is one level up, and nothing here depends on
// process.cwd().
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf-8");
}

/**
 * The floor, read from package.json rather than written here, so this suite
 * measures the shipped declaration instead of a second copy of it.
 */
function declaredFloor(): number[] {
  const engines = (JSON.parse(read("package.json")) as { engines?: { node?: string } }).engines?.node;
  assert.ok(engines, "package.json has no engines.node -- the floor these tests enforce is gone");
  const found = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(engines);
  assert.ok(
    found,
    `engines.node is ${JSON.stringify(engines)}; this suite only understands the ">=x.y.z" form it has ` +
      `always used. Widen the parser deliberately rather than letting the floor stop being enforced.`,
  );
  return [Number(found[1]), Number(found[2]), Number(found[3])];
}

/** `[20, 11, 0]` from "20.11.0". */
function parts(version: string): number[] {
  return version.split(".").map(Number);
}

/** True when `v` is strictly newer than `floor`, comparing in order. */
function isNewerThan(v: number[], floor: number[]): boolean {
  for (let i = 0; i < Math.max(v.length, floor.length); i++) {
    const a = v[i] ?? 0;
    const b = floor[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

/**
 * APIs that exist on a contributor's Node 22+ but not on the floor.
 *
 * Nothing else in the repo can catch one of these before publish. tsc pins the
 * LANGUAGE level at the tsconfig target, but `types: ["node"]` pulls in
 * @types/node 26, which declares every Node builtin unconditionally against an
 * engines floor of 20.11 -- so `process.getBuiltinModule`, `util.styleText`
 * and `node:sqlite` all type-check clean and then throw on the floor. biome
 * runs the recommended rules only, esbuild's `target: node20` rewrites syntax
 * rather than checking APIs, and there is no CI. The default lib for the
 * target is es2022.FULL, which also pulls in lib.dom, so `document`, `window`
 * and `localStorage` type-check clean in a Node-only package and throw a
 * ReferenceError on EVERY Node version -- those are in the table too.
 *
 * `since` is the Node release that first shipped the API (the stable one where
 * a feature landed behind a flag first). The assertion below fails if a floor
 * bump ever makes one of these entries available, which is the prompt to drop
 * it rather than keep enforcing a rule that no longer holds.
 *
 * Patterns are deliberately narrow: this is a text scan, so a broad one
 * ("document") would fire on prose. Full-line comments are skipped for the same
 * reason (see scanLines).
 */
interface PostFloorApi {
  readonly name: string;
  readonly since: string;
  readonly pattern: RegExp;
}

const POST_FLOOR_APIS: readonly PostFloorApi[] = [
  // Language-level, via V8. tsc catches these under the current tsconfig
  // target; they are listed anyway because the target is one edit away from
  // moving and this scan does not care what the target says.
  { name: "Object.groupBy", since: "21.0.0", pattern: /\bObject\.groupBy\b/ },
  { name: "Map.groupBy", since: "21.0.0", pattern: /\bMap\.groupBy\b/ },
  { name: "Promise.withResolvers", since: "22.0.0", pattern: /\bPromise\.withResolvers\b/ },
  { name: "Array.fromAsync", since: "22.0.0", pattern: /\bArray\.fromAsync\b/ },
  { name: "Iterator.from", since: "22.0.0", pattern: /\bIterator\.from\b/ },
  { name: "RegExp.escape", since: "24.0.0", pattern: /\bRegExp\.escape\b/ },
  { name: "Error.isError", since: "24.0.0", pattern: /\bError\.isError\b/ },
  { name: "Float16Array", since: "24.0.0", pattern: /\bFloat16Array\b/ },
  // Node builtins. These are the half nothing in the toolchain rejects.
  { name: "util.styleText", since: "20.12.0", pattern: /\bstyleText\s*\(/ },
  { name: "process.loadEnvFile", since: "20.12.0", pattern: /\bprocess\.loadEnvFile\b/ },
  { name: "process.getBuiltinModule", since: "20.16.0", pattern: /\bprocess\.getBuiltinModule\b/ },
  { name: "URL.parse (static)", since: "22.1.0", pattern: /\bURL\.parse\s*\(/ },
  { name: "the WebSocket global", since: "22.4.0", pattern: /\bnew WebSocket\b|\bglobalThis\.WebSocket\b/ },
  { name: "node:sqlite", since: "22.5.0", pattern: /["']node:sqlite["']/ },
  { name: "fs.glob / fs.globSync", since: "22.0.0", pattern: /\bglobSync\s*\(|\bfs\.glob\s*\(/ },
  { name: "process.features.typescript", since: "22.10.0", pattern: /\bprocess\.features\.typescript\b/ },
  { name: "the navigator global", since: "21.0.0", pattern: /\bnavigator\.\w/ },
];

/**
 * Browser globals that lib.dom hands this Node-only package for free. Not a
 * floor question at all -- these throw on every Node -- but the same scan
 * catches them and nothing else in the repo does.
 */
const BROWSER_GLOBALS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "document", pattern: /\bdocument\.(getElementById|querySelector|createElement|body|cookie)\b/ },
  { name: "window", pattern: /\bwindow\.(document|location|localStorage|alert)\b/ },
  { name: "localStorage", pattern: /\blocalStorage\.\w/ },
  { name: "sessionStorage", pattern: /\bsessionStorage\.\w/ },
  { name: "HTMLElement", pattern: /\bHTMLElement\b/ },
  { name: "XMLHttpRequest", pattern: /\bXMLHttpRequest\b/ },
];

/**
 * Every file that reaches a user: the sources tsc compiles into the published
 * bundle, plus the launcher, which ships as-is. Test sources are excluded --
 * they run on `devEngines` (Node 22+) and never ship.
 */
function shippedFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(repoRoot, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...shippedFiles(rel));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

/**
 * Matches, as `file:line name` strings.
 *
 * Whole-line comments are skipped: a scan of text cannot tell a call from a
 * sentence about one, and this repo's comments discuss APIs by name often
 * enough that the alternative is a false failure on a file that is correct. A
 * trailing comment on a line of code is still scanned, which is the direction
 * that matters -- the code on it is scanned too.
 */
function scanLines(rel: string, text: string, table: readonly { name: string; pattern: RegExp }[]): string[] {
  const hits: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    for (const entry of table) {
      if (entry.pattern.test(line)) hits.push(`${rel}:${index + 1} ${entry.name}`);
    }
  });
  return hits;
}

describe("Node engine floor", () => {
  it("declares the same floor in package.json, the launcher and the server entry", () => {
    // Three copies exist because each is read by something that cannot see the
    // others: npm reads engines, bin/tailscale-mcp.mjs runs before any import,
    // and dist/index.js is launched directly by the README's fast path. This is
    // the test that keeps them from drifting apart.
    const floor = declaredFloor();
    for (const rel of ["bin/tailscale-mcp.mjs", "src/index.ts"]) {
      const found = /const NODE_MIN = \[(\d+), (\d+), (\d+)\]/.exec(read(rel));
      assert.ok(found, `${rel} has no \`const NODE_MIN = [x, y, z]\` -- was it renamed or reformatted?`);
      assert.deepEqual(
        [Number(found[1]), Number(found[2]), Number(found[3])],
        floor,
        `${rel}'s NODE_MIN disagrees with package.json engines.node`,
      );
    }
  });

  it("refuses a sub-floor Node and passes everything at or above it", () => {
    // The real function out of the shipped launcher, not a copy: importing the
    // file would run its module body (it resolves a runtime and spawns), which
    // is the same reason launcher.test.ts extracts sandboxFlags() this way.
    const source = read("bin/tailscale-mcp.mjs");
    const extracts = [
      /const NODE_MIN = \[[^\]]*\];/,
      /function parseVersion\(text\) \{[\s\S]*?\n\}/,
      /function atLeast\(v, min\) \{[\s\S]*?\n\}/,
      /function nodeFloorFailure\(versions\) \{[\s\S]*?\n\}/,
    ].map((pattern) => {
      const found = pattern.exec(source);
      assert.ok(found, `could not extract ${String(pattern)} from bin/tailscale-mcp.mjs -- was it renamed?`);
      return found[0];
    });
    const nodeFloorFailure = new Function(`${extracts.join("\n")}\nreturn nodeFloorFailure;`)() as (versions: {
      node?: string;
      oam?: string;
    }) => string | null;

    const floor = declaredFloor().join(".");
    assert.equal(nodeFloorFailure({ node: floor }), null, "the floor itself must be accepted");
    assert.equal(nodeFloorFailure({ node: "22.14.0" }), null);
    assert.equal(nodeFloorFailure({ node: "20.19.4" }), null);
    // Sub-floor on each of the three parts.
    for (const version of ["20.10.0", "20.0.0", "18.20.8"]) {
      const message = nodeFloorFailure({ node: version });
      assert.ok(message, `Node ${version} is below ${floor} and must be refused`);
      assert.match(message, new RegExp(`needs Node ${floor.replace(/\./g, "\\.")} or newer`));
      assert.match(message, new RegExp(version.replace(/\./g, "\\.")), "the message must name what it found");
    }
    // oam reports its own version in `versions.oam` and the launcher checks
    // that against OAM_MIN; measuring Node's floor there compares the wrong
    // number, so the guard stands down.
    assert.equal(nodeFloorFailure({ oam: "0.15.2", node: "18.0.0" }), null);
    // An unreadable version is not evidence of a sub-floor Node.
    assert.equal(nodeFloorFailure({ node: undefined }), null);
    assert.equal(nodeFloorFailure({ node: "not-a-version" }), null);
  });

  it("keeps the post-floor API table above the declared floor", () => {
    // A floor bump makes some of these legal. Without this, the table would go
    // on rejecting an API the package now supports, and the rejection would
    // read as a rule rather than as the stale entry it is.
    const floor = declaredFloor();
    const stale = POST_FLOOR_APIS.filter((api) => !isNewerThan(parts(api.since), floor)).map(
      (api) => `${api.name} (${api.since})`,
    );
    assert.deepEqual(
      stale,
      [],
      `these entries are at or below the current floor (${floor.join(".")}) and are no longer violations -- ` +
        `drop them from POST_FLOOR_APIS: ${stale.join(", ")}`,
    );
  });

  it("finds no API newer than the floor in src/ or bin/", () => {
    const files = [...shippedFiles(), "bin/tailscale-mcp.mjs"];
    assert.ok(files.length > 10, `expected the shipped sources, found ${files.length}`);

    const violations: string[] = [];
    for (const rel of files) {
      violations.push(...scanLines(rel, read(rel), [...POST_FLOOR_APIS, ...BROWSER_GLOBALS]));
    }
    assert.deepEqual(
      violations,
      [],
      `these shipped lines use an API the package's own engines floor does not have (or a browser global ` +
        `lib.dom lends this Node-only package). @types/node declares them all unconditionally, so tsc will ` +
        `not say so: ${violations.join(", ")}`,
    );
  });

  it("catches a planted violation, so a green run means something", () => {
    // Without this the whole suite is one regex typo away from passing
    // vacuously on a file it never really read.
    const planted = [
      "const groups = Object.groupBy(devices, (d) => d.os);",
      "const { promise, resolve } = Promise.withResolvers();",
      'const db = new DatabaseSync("node:sqlite");',
      "process.getBuiltinModule('node:fs');",
      "document.body.innerHTML = tailnet;",
    ].join("\n");
    const hits = scanLines("planted.ts", planted, [...POST_FLOOR_APIS, ...BROWSER_GLOBALS]);
    assert.deepEqual(
      hits.map((h) => h.split(" ").slice(1).join(" ")),
      ["Object.groupBy", "Promise.withResolvers", "node:sqlite", "process.getBuiltinModule", "document"],
      "the scanner stopped matching what it exists to match",
    );
    // And the comment skip really skips, rather than the patterns never firing.
    assert.deepEqual(scanLines("planted.ts", "// Object.groupBy is Node 21", POST_FLOOR_APIS), []);
  });
});
