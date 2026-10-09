import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { __localCliInternals, __setExecFileForTests, runTailscaleCli } from "./local-cli-runner.js";

// The compiled test lives in dist/, so the repo root is one level up.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type StageModule = {
  candidateDirs: (o: { target: string; hostTarget: string; libc: string | null }) => string[];
  assetNameFor: (o: { binName: string; dir: string }) => string;
  findBuiltBinary: (o: {
    root: string;
    binName: string;
    dirs: string[];
    exists?: (p: string) => boolean;
    mtimeMs?: (p: string) => number;
  }) => { dir: string; path: string } | null;
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

describe("stage-release-asset finds what the build scripts wrote", () => {
  it("looks in the SEA builder's libc-suffixed Linux directory first", () => {
    assert.deepEqual(stage.candidateDirs({ target: "linux-x64", hostTarget: "linux-x64", libc: "glibc" }), [
      "linux-x64-glibc",
      "linux-x64",
    ]);
    assert.deepEqual(stage.candidateDirs({ target: "win32-x64", hostTarget: "win32-x64", libc: null }), ["win32-x64"]);
  });

  it("uses the cross-build target, not the host, for an oam cross-build", () => {
    assert.deepEqual(stage.candidateDirs({ target: "linux-x64", hostTarget: "win32-x64", libc: null }), ["linux-x64"]);
  });

  it("names the glibc build as the plain linux asset the manifests point at, and keeps musl distinct", () => {
    assert.equal(stage.assetNameFor({ binName: "tailscale-mcp", dir: "linux-x64-glibc" }), "tailscale-mcp-linux-x64");
    assert.equal(stage.assetNameFor({ binName: "tailscale-mcp", dir: "linux-x64" }), "tailscale-mcp-linux-x64");
    assert.equal(
      stage.assetNameFor({ binName: "tailscale-mcp", dir: "linux-x64-musl" }),
      "tailscale-mcp-linux-x64-musl",
    );
    assert.equal(stage.assetNameFor({ binName: "tailscale-mcp", dir: "win32-x64" }), "tailscale-mcp-win32-x64.exe");
  });

  it("stages the newer build when both builders have written one", () => {
    const mtimes: Record<string, number> = {
      [join("/r", "bin", "linux-x64-glibc", "t")]: 1,
      [join("/r", "bin", "linux-x64", "t")]: 2,
    };
    const found = stage.findBuiltBinary({
      root: "/r",
      binName: "t",
      dirs: ["linux-x64-glibc", "linux-x64"],
      exists: (p) => p in mtimes,
      mtimeMs: (p) => mtimes[p] ?? 0,
    });
    assert.equal(found?.dir, "linux-x64");
    assert.equal(
      stage.findBuiltBinary({ root: "/r", binName: "t", dirs: ["darwin-arm64"], exists: () => false }),
      null,
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

describe("local CLI: an unexecutable TAILSCALE_BINARY", () => {
  afterEach(() => {
    __setExecFileForTests(null);
  });

  it("names the directory / execute-permission cause on EACCES", async () => {
    const saved = process.env.TAILSCALE_BINARY;
    process.env.TAILSCALE_BINARY = "/opt/tailscale";
    try {
      const fake = (
        _file: string,
        _args: readonly string[],
        _options: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const err = Object.assign(new Error("spawn /opt/tailscale EACCES"), { code: "EACCES" });
        setImmediate(() => cb(err, "", ""));
      };
      __setExecFileForTests(fake as unknown as Parameters<typeof __setExecFileForTests>[0]);
      const res = await runTailscaleCli(["status"]);
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /\/opt\/tailscale/);
      assert.match(res.error ?? "", /not a directory/);
      assert.match(res.error ?? "", /TAILSCALE_BINARY/);
    } finally {
      if (saved === undefined) delete process.env.TAILSCALE_BINARY;
      else process.env.TAILSCALE_BINARY = saved;
    }
  });

  it("tells a Windows user the value must name tailscale.exe, not its folder", () => {
    const message = __localCliInternals.describeMissingBinary("C:/Program Files/Tailscale", true, "win32", false);
    assert.match(message, /not the folder/);
  });
});

describe("launcher: planned in-process load with no dist/index.js", () => {
  it("prints the launcher's one-line diagnostic instead of a raw stack", async () => {
    // A copy of the launcher with no dist/ beside it: TAILSCALE_MCP_RUNTIME=node
    // on Node is the planned in-process path.
    const dir = mkdtempSync(join(tmpdir(), "tailscale-mcp-nodist-"));
    try {
      mkdirSync(join(dir, "bin"));
      const launcher = join(dir, "bin", "tailscale-mcp.mjs");
      copyFileSync(join(repoRoot, "bin", "tailscale-mcp.mjs"), launcher);
      const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((done) => {
        const child = spawn(process.execPath, [launcher, "--version"], {
          env: { ...process.env, TAILSCALE_MCP_RUNTIME: "node", TAILSCALE_MCP_SANDBOX: "" },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let err = "";
        child.stderr.on("data", (b) => {
          err += b;
        });
        child.on("close", (c) => done({ code: c, stderr: err }));
      });
      assert.equal(code, 1, stderr);
      assert.match(stderr, /tailscale-mcp: could not load the server/);
      assert.ok(!/\n\s+at /.test(stderr), `expected no stack trace, got:\n${stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
