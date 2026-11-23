import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The release-asset scripts under scripts/: stage-release-asset.mjs and
// update-manifests.mjs. The compiled test lives in dist/, so the repo root is
// one level up.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type StageModule = {
  assetNameFor: (o: { binName: string; target: string }) => string;
  findBuiltBinary: (o: {
    root: string;
    binName: string;
    target: string;
    exists?: (p: string) => boolean;
  }) => string | null;
};
type ManifestModule = {
  formulaDesc: (description: unknown) => string;
  main: (opts: {
    argv: string[];
    fetchHashes: (ctx: { tag: string; repoSlug: string; cmd: string }) => Record<string, string>;
    git?: (dir: string, ...args: string[]) => void;
  }) => { scoopPath: string; formulaPath: string };
};

let stage: StageModule;
let manifests: ManifestModule;

before(async () => {
  // Computed specifiers keep tsc from resolving the untyped .mjs files; both
  // guard their side effects behind an invoked-directly check.
  stage = (await import(pathToFileURL(join(repoRoot, "scripts", "stage-release-asset.mjs")).href)) as StageModule;
  manifests = (await import(pathToFileURL(join(repoRoot, "scripts", "update-manifests.mjs")).href)) as ManifestModule;
});

describe("stage-release-asset finds what the build script wrote", () => {
  it("names the asset after the target the manifests point at, with .exe only on Windows", () => {
    assert.equal(stage.assetNameFor({ binName: "tailscale-mcp", target: "linux-x64" }), "tailscale-mcp-linux-x64");
    assert.equal(
      stage.assetNameFor({ binName: "tailscale-mcp", target: "darwin-arm64" }),
      "tailscale-mcp-darwin-arm64",
    );
    assert.equal(stage.assetNameFor({ binName: "tailscale-mcp", target: "win32-x64" }), "tailscale-mcp-win32-x64.exe");
  });

  it("looks in bin/<target>/ -- the cross-build target, not the host -- and reports a missing build as null", () => {
    const built = join("/r", "bin", "linux-x64", "t");
    const found = stage.findBuiltBinary({ root: "/r", binName: "t", target: "linux-x64", exists: (p) => p === built });
    assert.equal(found, built);
    assert.equal(
      stage.findBuiltBinary({ root: "/r", binName: "t", target: "win32-x64", exists: (p) => p === built }),
      null,
    );
    assert.equal(
      stage.findBuiltBinary({ root: "/r", binName: "t", target: "win32-x64", exists: () => true }),
      join("/r", "bin", "win32-x64", "t.exe"),
    );
  });
});

describe("update-manifests Homebrew desc", () => {
  it("fits brew audit: at most 80 characters, no trailing full stop", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as { description: string };
    const desc = manifests.formulaDesc(pkg.description);
    assert.ok(desc.length > 0 && desc.length <= 80, `desc is ${desc.length} chars: ${desc}`);
    assert.ok(!desc.endsWith("."), desc);
  });

  it("keeps a short description whole and cuts a long one at a word", () => {
    assert.equal(manifests.formulaDesc("Short summary."), "Short summary");
    const long = `${"word ".repeat(30)}end.`;
    const cut = manifests.formulaDesc(long);
    assert.ok(cut.length <= 80);
    assert.ok(cut.endsWith("word"), cut);
  });
});

describe("update-manifests --push and the manifest checkouts", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ["YAW_SCOOP_DIR", "YAW_HOMEBREW_DIR", "HOME", "USERPROFILE"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function stubHashes({ cmd }: { cmd: string }): Record<string, string> {
    const hashes: Record<string, string> = {};
    for (const suffix of ["win32-x64.exe", "win32-arm64.exe", "darwin-arm64", "darwin-x64", "linux-x64"]) {
      hashes[`${cmd}-${suffix}`] = "f".repeat(64);
    }
    return hashes;
  }

  it("pulls each checkout BEFORE rewriting its tracked manifest", () => {
    const out = mkdtempSync(join(tmpdir(), "tailscale-mcp-push-"));
    const log = console.log;
    console.log = () => {};
    try {
      const calls: string[] = [];
      const { scoopPath, formulaPath } = manifests.main({
        argv: ["node", "x", "--scoop-dir", join(out, "scoop"), "--homebrew-dir", join(out, "brew"), "--push"],
        fetchHashes: stubHashes,
        git: (dir, ...args) => {
          // Record whether the repo's manifest already existed when git ran: a
          // pull --rebase over a rewritten tracked file is what git refuses.
          const repo = dir.endsWith("scoop") ? "scoop" : "brew";
          const file =
            repo === "scoop"
              ? join(out, "scoop", "bucket", "tailscale-mcp.json")
              : join(out, "brew", "Formula", "tailscale-mcp.rb");
          calls.push(`${repo} ${args[0]} ${existsSync(file) ? "written" : "absent"}`);
        },
      });
      assert.ok(existsSync(scoopPath) && existsSync(formulaPath));
      assert.deepEqual(calls, [
        "scoop pull absent",
        "brew pull absent",
        "scoop add written",
        "scoop commit written",
        "scoop push written",
        "brew add written",
        "brew commit written",
        "brew push written",
      ]);
    } finally {
      console.log = log;
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("treats an empty YAW_SCOOP_DIR / YAW_HOMEBREW_DIR as unset instead of writing into the cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "tailscale-mcp-home-"));
    const log = console.log;
    console.log = () => {};
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.YAW_SCOOP_DIR = "";
      process.env.YAW_HOMEBREW_DIR = "";
      const { scoopPath, formulaPath } = manifests.main({ argv: ["node", "x"], fetchHashes: stubHashes });
      assert.ok(scoopPath.startsWith(join(home, "yaw", "scoop-yaw")), scoopPath);
      assert.ok(formulaPath.startsWith(join(home, "yaw", "homebrew-yaw")), formulaPath);
    } finally {
      console.log = log;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
