import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// scripts/update-manifests.mjs writes package.json's description into a Ruby
// double-quoted string in the Homebrew formula. These tests pin the escaping
// that keeps that value a plain string (CodeQL js/incomplete-sanitization).
// The compiled test lives in dist/, so the repo root is one level up.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts", "update-manifests.mjs");

type Asset = { url: string; sha256: string };
type FormulaInput = {
  className: string;
  cmd: string;
  description: unknown;
  homepage: string;
  version: string;
  license: string | null;
  assets: { macArm64: Asset; macX64: Asset; linuxX64: Asset };
};
type ScriptModule = {
  rubyString: (value: unknown) => string;
  formulaDesc: (description: unknown) => string;
  renderFormula: (input: FormulaInput) => string;
  main: (opts: {
    argv: string[];
    fetchHashes: (ctx: { tag: string; repoSlug: string; cmd: string }) => Record<string, string>;
  }) => { scoopPath: string; formulaPath: string };
};

let mod: ScriptModule;

before(async () => {
  // A computed specifier keeps tsc from resolving the untyped .mjs, and
  // importing it must not run the release side effects (gh release download).
  mod = (await import(pathToFileURL(scriptPath).href)) as ScriptModule;
});

// Read the body of a Ruby double-quoted literal the way Ruby does, failing on
// anything that would end the string early or interpolate code.
function parseRubyDq(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const next = body[++i];
      if (next === undefined) throw new Error("dangling backslash escapes the closing quote");
      out += next === "n" ? "\n" : next === "r" ? "\r" : next;
    } else if (c === '"') {
      throw new Error(`unescaped quote at ${i} ends the string early`);
    } else if (c === "#" && /[{@$]/.test(body[i + 1] ?? "")) {
      throw new Error(`unescaped interpolation at ${i}`);
    } else if (c === "\n" || c === "\r") {
      throw new Error(`raw line break at ${i}`);
    } else {
      out += c;
    }
  }
  return out;
}

const HOSTILE = 'evil \\" "quoted" #{system("rm -rf ~")} #@ivar #$global C# fine\nsecond line\r\n';

function formulaInput(description: unknown): FormulaInput {
  const asset = (name: string): Asset => ({ url: `https://example.test/${name}`, sha256: "a".repeat(64) });
  return {
    className: "TailscaleMcp",
    cmd: "tailscale-mcp",
    description,
    homepage: "https://yaw.sh/mcp-servers/tailscale-mcp/",
    version: "0.21.1",
    license: "MIT",
    assets: { macArm64: asset("mac-arm64"), macX64: asset("mac-x64"), linuxX64: asset("linux-x64") },
  };
}

describe("update-manifests rubyString", () => {
  const cases = [
    "Tailscale MCP server: admin-API tools for devices, ACLs, DNS, auth keys, users, and audit logs, plus a CLI to validate and deploy ACLs.",
    'He said "hi"',
    "trailing backslash \\",
    'backslash then quote \\"',
    "C:\\path\\to\\thing",
    '#{system("rm -rf ~")}',
    "#@ivar and #$global",
    "line one\nline two\r\n",
    "C# support, issue #12",
    "",
  ];

  for (const input of cases) {
    it(`round-trips ${JSON.stringify(input)}`, () => {
      assert.equal(parseRubyDq(mod.rubyString(input)), input);
    });
  }

  it("escapes the backslash before the quote", () => {
    // The old `.replace(/"/g, '\\"')` turned `\"` into `\\"`, which Ruby reads
    // as an escaped backslash followed by a closing quote.
    assert.equal(mod.rubyString('a\\"b'), 'a\\\\\\"b');
  });

  it("escapes # only where it starts interpolation", () => {
    // brew style flags `\#` that is not followed by {, @ or $ as redundant.
    assert.equal(mod.rubyString("C# support, issue #12"), "C# support, issue #12");
    assert.equal(mod.rubyString("#{x} #@y #$z"), "\\#{x} \\#@y \\#$z");
  });

  it("treats null and undefined as empty", () => {
    assert.equal(mod.rubyString(undefined), "");
    assert.equal(mod.rubyString(null), "");
  });
});

describe("update-manifests renderFormula", () => {
  it("passes the description through rubyString", () => {
    const formula = mod.renderFormula(formulaInput(HOSTILE));
    const descLines = formula.split("\n").filter((l) => l.startsWith("  desc "));
    assert.equal(descLines.length, 1, "the description must stay on one line");
    const m = /^ {2}desc "(.*)"$/.exec(descLines[0]);
    assert.ok(m, `unexpected desc line: ${descLines[0]}`);
    assert.equal(m[1], mod.rubyString(HOSTILE));
    assert.equal(parseRubyDq(m[1]), HOSTILE);
  });

  it("renders a proprietary license as :cannot_represent", () => {
    const formula = mod.renderFormula({ ...formulaInput("x"), license: null });
    assert.match(formula, /^ {2}license :cannot_represent$/m);
  });

  it("rejects a class name that is not a Ruby constant", () => {
    assert.throws(() => mod.renderFormula({ ...formulaInput("x"), className: "Foo; system('x')" }), /class name/);
  });
});

describe("update-manifests main", () => {
  it("writes the manifests for the real package.json with the network call stubbed", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
      description: string;
      version: string;
    };
    const out = mkdtempSync(join(tmpdir(), "tailscale-mcp-manifests-"));
    const log = console.log;
    console.log = () => {};
    try {
      const seen: string[] = [];
      const { scoopPath, formulaPath } = mod.main({
        argv: [
          "node",
          scriptPath,
          "--version",
          pkg.version,
          "--scoop-dir",
          join(out, "scoop"),
          "--homebrew-dir",
          join(out, "brew"),
        ],
        fetchHashes: ({ tag, repoSlug, cmd }) => {
          seen.push(`${repoSlug} ${tag}`);
          const hashes: Record<string, string> = {};
          for (const suffix of ["win32-x64.exe", "win32-arm64.exe", "darwin-arm64", "darwin-x64", "linux-x64"]) {
            hashes[`${cmd}-${suffix}`] = suffix.replace(/[^0-9a-f]/g, "0").padEnd(64, "f");
          }
          return hashes;
        },
      });
      assert.deepEqual(seen, [`YawLabs/tailscale-mcp v${pkg.version}`]);
      const formula = readFileSync(formulaPath, "utf-8");
      assert.match(formula, /^class TailscaleMcp < Formula$/m);
      assert.ok(formula.includes(`  desc "${mod.rubyString(mod.formulaDesc(pkg.description))}"\n`));
      assert.ok(formula.includes(`  version "${pkg.version}"\n`));
      assert.ok(formula.includes('  license "MIT"\n'));
      const scoop = JSON.parse(readFileSync(scoopPath, "utf-8")) as { description: string; version: string };
      assert.equal(scoop.description, pkg.description);
      assert.equal(scoop.version, pkg.version);
    } finally {
      console.log = log;
      rmSync(out, { recursive: true, force: true });
    }
  });
});
