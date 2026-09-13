import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = resolve(repoRoot, "bin/tailscale-mcp.mjs");
const launcherSource = readFileSync(launcherPath, "utf-8");

/**
 * Evaluate the REAL `sandboxFlags` source with an injected `process`.
 *
 * Why not import the launcher: its module body runs at import time (it resolves
 * a runtime and either spawns oam or imports the server), so importing it from
 * a test would launch a server. Making it importable would mean gating that
 * body behind an `import.meta.url === argv[1]` check -- a behaviour change to a
 * shipped runtime artifact whose failure mode (guard reads false under an npm
 * shim or symlink, launcher silently does nothing) is worse than the gap being
 * closed here.
 *
 * Extracting the source keeps the production file untouched while still
 * exercising the real logic rather than a copy that can drift. If the extraction
 * ever fails, that is a loud assertion, not a silent skip.
 */
function loadSandboxFlags(env: Record<string, string | undefined>): string[] {
  const match = launcherSource.match(/function sandboxFlags\(\) \{[\s\S]*?\n\}/);
  assert.ok(match, "could not extract sandboxFlags() from bin/tailscale-mcp.mjs -- was it renamed or reformatted?");
  const factory = new Function("process", `${match[0]}; return sandboxFlags();`) as (p: {
    env: Record<string, string | undefined>;
  }) => string[];
  return factory({ env });
}

describe("launcher sandboxFlags()", () => {
  it("grants nothing unless TAILSCALE_MCP_SANDBOX is exactly '1'", () => {
    // Exact-string contract, matching TAILSCALE_LOCAL_CLI's. A loose truthiness
    // check here would silently sandbox anyone who set the var to "0".
    for (const value of [undefined, "", "0", "true", "yes", "TRUE"]) {
      assert.deepEqual(
        loadSandboxFlags({ TAILSCALE_MCP_SANDBOX: value }),
        [],
        `TAILSCALE_MCP_SANDBOX=${JSON.stringify(value)} must not enable the sandbox`,
      );
    }
  });

  it("emits --permission first, since oam rejects it after the run subcommand", () => {
    // Ordering is load-bearing: these are oam PROCESS-level flags and must
    // precede `run`. The call site spreads this array before "run".
    const flags = loadSandboxFlags({ TAILSCALE_MCP_SANDBOX: "1" });
    assert.equal(flags[0], "--permission");
  });

  it("restricts net to the one host the bundle calls and nothing else", () => {
    // Exact-array on purpose: "and nothing else" is only enforceable by an
    // exact assertion, so a widened grant has to arrive as a deliberate diff
    // through this line. login.tailscale.com used to be granted here and was
    // dropped once an audit found nothing contacts it -- api.ts's BASE_URL,
    // the OAuth token exchange and the absolute-URL allow-list all name
    // api.tailscale.com, and console.tailscale.com only ever appears in error
    // TEXT. Deliberately NOT a scan of dist/index.js for each granted host:
    // that couples a source-reading unit test to a build artifact and loses
    // the "nothing else" half, which is the half worth having.
    const flags = loadSandboxFlags({ TAILSCALE_MCP_SANDBOX: "1" });
    const net = flags.find((f) => f.startsWith("--allow-net="));
    assert.ok(net, "expected an --allow-net grant");
    const hosts = net.slice("--allow-net=".length).split(",");
    assert.deepEqual(hosts, ["api.tailscale.com"]);
  });

  it("grants child-process, which the local-CLI tools require", () => {
    // Paired with TAILSCALE_LOCAL_CLI in the env allow-list: granting one
    // without the other is the bug fixed in 9f507bd.
    const flags = loadSandboxFlags({ TAILSCALE_MCP_SANDBOX: "1" });
    assert.ok(flags.includes("--allow-child-process"));
  });

  it("grants PATH plus a non-empty TAILSCALE_* env allow-list", () => {
    const flags = loadSandboxFlags({ TAILSCALE_MCP_SANDBOX: "1" });
    const envFlag = flags.find((f) => f.startsWith("--allow-env="));
    assert.ok(envFlag, "expected an --allow-env grant");
    const names = envFlag.slice("--allow-env=".length).split(",");
    assert.ok(names.includes("PATH"), "PATH is required for the local-CLI tools to find the binary");
    assert.ok(names.includes("TAILSCALE_LOCAL_CLI"), "regression guard for 9f507bd");
    assert.deepEqual([...names].sort(), names, "keep the list alphabetised so omissions are easy to spot");
  });

  it("does not grant filesystem access", () => {
    const flags = loadSandboxFlags({ TAILSCALE_MCP_SANDBOX: "1" });
    assert.ok(
      !flags.some((f) => f.startsWith("--allow-read") || f.startsWith("--allow-write") || f === "--allow-fs"),
      `filesystem must stay denied, got: ${flags.join(" ")}`,
    );
  });
});

/**
 * Lift top-level declarations out of the launcher source, evaluate them
 * together, and return the one called `name`.
 *
 * Same idiom and the same reason as loadSandboxFlags above: the module body
 * resolves a runtime and spawns or imports the server at import time, so
 * evaluating the real declaration as text is the only way to exercise it that
 * does not require a behaviour change to a shipped runtime artifact. A failed
 * extraction is a loud assertion, not a silent skip.
 *
 * Several patterns for a declaration that closes over others: runtimePlan reads
 * OAM_MIN, parseVersion and atLeast, and evaluated alone it would not fail at
 * extraction but with a ReferenceError at its first call.
 */
function loadFromSource<T>(patterns: RegExp | RegExp[], name: string): T {
  const pieces = (Array.isArray(patterns) ? patterns : [patterns]).map((pattern) => {
    const match = launcherSource.match(pattern);
    assert.ok(
      match,
      `could not extract ${pattern} (for ${name}) from bin/tailscale-mcp.mjs -- was it renamed or reformatted?`,
    );
    return match[0];
  });
  const factory = new Function(`${pieces.join("\n")}\nreturn ${name};`) as () => T;
  return factory();
}

describe("launcher oam version floor", () => {
  // `atLeast(version, OAM_MIN)` is the gate every discovered oam passes through
  // before pickNewest may choose it, and the same gate decides whether an oam
  // host serves in-process. Nothing else pins either the comparison or the
  // constant, so every regression below would land green.
  const atLeast = loadFromSource<(v: number[] | null, min: number[]) => boolean>(
    /function atLeast\(v, min\) \{[\s\S]*?\n\}/,
    "atLeast",
  );
  const OAM_MIN = loadFromSource<number[]>(/const OAM_MIN = \[[^\]]*\];/, "OAM_MIN");

  it("is 0.15.2, the latest oam release", () => {
    // Only the latest oam is used and verified -- the floor README.md and the
    // MINIMUM OAM VERSION block both state. It is not cosmetic either: below
    // 0.9.0 oam ran execFile arguments through a shell, re-splitting them on
    // whitespace and executing metacharacters inside an argument, and this
    // server passes tool input (device names, tags, hostnames) to a CLI on its
    // local-CLI paths. Lowering the constant is a one-token change with no other
    // symptom, so it has to arrive as a deliberate diff through here -- and so
    // does raising it when oam ships a newer release.
    assert.deepEqual(OAM_MIN, [0, 15, 2]);
  });

  it("refuses a version that could not be read at all", () => {
    // oamVersion returns null when the binary would not run (not executable,
    // wrong arch, deleted since the stat) or its --version did not parse, and
    // that null reaches this same gate -- unusableReason only splits the two
    // REMEDIES apart afterwards. The `if (!v) return false` guard is what turns
    // "unreadable" into "passed over": drop it and the loop dereferences null,
    // killing the launcher with a TypeError instead of degrading, while
    // inverting it to `return true` hands the server to a binary that never
    // reported a version at all.
    assert.equal(atLeast(null, OAM_MIN), false);
  });

  it("accepts the floor itself and rejects the patch below it", () => {
    // Inclusive boundary: 0.15.2 IS the supported release, so an off-by-one that
    // demanded 0.15.3 would pass over every oam a user can actually install.
    assert.equal(atLeast([0, 15, 2], OAM_MIN), true);
    assert.equal(atLeast([0, 15, 1], OAM_MIN), false);
    assert.equal(atLeast([0, 9, 0], OAM_MIN), false);
  });

  it("compares components numerically, not lexicographically", () => {
    // 0.100.0 is newer than 0.15.2 but sorts BEFORE it as a string, so a compare
    // rewritten over `v.join(".")` -- or over the raw --version text, skipping
    // the parse entirely -- would pass over every such oam.
    assert.equal(atLeast([0, 100, 0], OAM_MIN), true);
    assert.equal(atLeast([1, 0, 0], OAM_MIN), true);
  });
});

const OAM_MIN_DECL = /const OAM_MIN = \[[^\]]*\];/;
const PARSE_VERSION_DECL = /function parseVersion\(text\) \{[\s\S]*?\n\}/;
const ATLEAST_DECL = /function atLeast\(v, min\) \{[\s\S]*?\n\}/;

type Plan = "in-process" | "discover" | "handoff-node";

describe("launcher runtimePlan()", () => {
  const runtimePlan = loadFromSource<(ctx: { mode: string; hostOam: string | undefined; sandbox: boolean }) => Plan>(
    [
      OAM_MIN_DECL,
      PARSE_VERSION_DECL,
      ATLEAST_DECL,
      /function runtimePlan\(\{ mode, hostOam, sandbox \}\) \{[\s\S]*?\n\}/,
    ],
    "runtimePlan",
  );

  // Every mode that is not `node`. `nope` stands in for an unrecognized
  // TAILSCALE_MCP_RUNTIME: the call site warns and then passes the lowercased
  // value straight through, so it has to land wherever auto does.
  const OAM_CAPABLE_MODES = ["auto", "oam", "nope"];

  it("serves in-process when already hosted on an oam at or above the floor", () => {
    // The bug this exists for: a host that launches `oam run
    // bin/tailscale-mcp.mjs` got a SECOND oam, because the launcher discovered
    // and spawned one without asking what it was already running on. `oam` has
    // to take the shortcut as well as auto -- it demands oam, and the host
    // already is one.
    //
    // 0.15.2 pins the floor as inclusive (it IS the supported release), and
    // 0.100.0 pins a numeric compare: it sorts BEFORE 0.15.2 as a string, so a
    // compare over the raw text would spawn a nested oam on such a host.
    for (const mode of OAM_CAPABLE_MODES) {
      for (const hostOam of ["0.15.2", "0.16.0", "0.100.0", "1.0.0", "0.16.0-dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "in-process", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("keeps spawning a fresh oam when the sandbox is requested, even on oam", () => {
    // `--permission` is a process-level flag: only a FRESH oam can apply it.
    // Serving in-process here would silently drop the sandbox the user asked
    // for -- and a denied env var reads as absent rather than as an error, so
    // nothing downstream would reveal the downgrade either.
    for (const mode of OAM_CAPABLE_MODES) {
      for (const hostOam of ["0.15.2", "1.0.0", "0.8.2", undefined]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: true }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("never serves in-process on a host oam below the floor", () => {
    // Below the floor the host must hand off. Serving there was the bug: an oam
    // older than 0.9.0 runs this server's CLI arguments through a shell, and
    // anything older than the latest release is not what the server is
    // verified on. Where the handoff lands is chooseOam's and fallBack's job;
    // this only pins that the shortcut is not taken.
    for (const mode of OAM_CAPABLE_MODES) {
      for (const hostOam of ["0.15.1", "0.9.0", "0.8.2", "0.0.1"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("discovers on Node, where process.versions has no oam key", () => {
    // An unreadable value must not count as "new enough" either: that would
    // skip discovery on a host that never proved it is a supported oam.
    for (const mode of OAM_CAPABLE_MODES) {
      for (const hostOam of [undefined, "", "dev"]) {
        assert.equal(runtimePlan({ mode, hostOam, sandbox: false }), "discover", `mode=${mode} hostOam=${hostOam}`);
      }
    }
  });

  it("runs TAILSCALE_MCP_RUNTIME=node on Node: in-process on a Node host, handed off from any oam host", () => {
    // `node` means Node, and the sandbox is an oam-only feature, so a sandbox
    // request under `node` is never a reason to spawn oam. It used to leave an
    // oam host serving on itself; that is still oam, which is not what was asked.
    for (const sandbox of [false, true]) {
      assert.equal(runtimePlan({ mode: "node", hostOam: undefined, sandbox }), "in-process", `sandbox=${sandbox}`);
      for (const hostOam of ["0.8.2", "0.15.2", "1.0.0", "dev"]) {
        assert.equal(
          runtimePlan({ mode: "node", hostOam, sandbox }),
          "handoff-node",
          `hostOam=${hostOam} sandbox=${sandbox}`,
        );
      }
    }
  });
});

describe("launcher fallbackInProcess()", () => {
  // What a fallback serves on once discovery has come up empty or the chosen oam
  // would not start. It is the second place a below-floor host could slip back
  // into serving on itself, so it gets the same floor as runtimePlan.
  const fallbackInProcess = loadFromSource<(hostOam: string | undefined) => boolean>(
    [OAM_MIN_DECL, PARSE_VERSION_DECL, ATLEAST_DECL, /function fallbackInProcess\(hostOam\) \{[\s\S]*?\n\}/],
    "fallbackInProcess",
  );

  it("serves in THIS process on Node, and on an oam host at the floor", () => {
    // The at-floor host only reaches a fallback through TAILSCALE_MCP_SANDBOX=1,
    // and serving there without --permission is the documented behaviour.
    for (const hostOam of [undefined, "0.15.2", "1.0.0"]) {
      assert.equal(fallbackInProcess(hostOam), true, `hostOam=${hostOam}`);
    }
  });

  it("never serves on an oam host below the floor, or one with an unreadable version", () => {
    for (const hostOam of ["0.15.1", "0.9.0", "0.8.2", "", "dev"]) {
      assert.equal(fallbackInProcess(hostOam), false, `hostOam=${hostOam}`);
    }
  });
});

type Candidate = { path: string; version: number[] | null };

describe("launcher pickNewest()", () => {
  const pickNewest = loadFromSource<(candidates: Candidate[]) => Candidate | null>(
    [OAM_MIN_DECL, ATLEAST_DECL, /function pickNewest\(candidates\) \{[\s\S]*?\n\}/],
    "pickNewest",
  );
  const at = (path: string, version: number[] | null): Candidate => ({ path, version });

  it("takes the newest usable oam, not the first one found", () => {
    // The bug: discovery stopped at the first binary that existed, so an older
    // copy in an earlier location (the installed dir is searched before PATH)
    // hid a newer one later.
    const chosen = pickNewest([at("installed", [0, 15, 2]), at("path-a", [0, 16, 0]), at("path-b", [0, 15, 9])]);
    assert.equal(chosen?.path, "path-a");
  });

  it("compares numerically and keeps search order on a tie", () => {
    assert.equal(pickNewest([at("a", [0, 16, 0]), at("b", [0, 100, 0])])?.path, "b");
    assert.equal(pickNewest([at("first", [0, 15, 2]), at("second", [0, 15, 2])])?.path, "first");
  });

  it("skips binaries below the floor or with no readable version", () => {
    assert.equal(pickNewest([at("old", [0, 9, 0]), at("broken", null), at("good", [0, 15, 2])])?.path, "good");
    assert.equal(pickNewest([at("old", [0, 15, 1]), at("broken", null)]), null);
    assert.equal(pickNewest([]), null);
  });
});

type LauncherRun = { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null };

/**
 * Run the REAL bin entry and return everything it wrote to stdout and stderr.
 *
 * The tests above read bin/tailscale-mcp.mjs as TEXT; this is the only place
 * the shipped `bin` is executed. Two env pins make the default run hermetic and
 * both are load-bearing. TAILSCALE_MCP_RUNTIME=node takes the `runInProcess()`
 * branch before any oam discovery happens on a Node host; OAM_BIN=process.execPath
 * covers the case where that dispatch has drifted, because chooseOam takes a
 * usable OAM_BIN -- and `--version` on the Node running this test reports a
 * version far above the floor -- without ever reaching the installed-location
 * or PATH scans. A
 * real oam on the developer's box therefore cannot be reached from here, so the
 * run behaves identically on a machine with oam installed and on one without.
 * Cases that need discovery to come up EMPTY use noOam() instead.
 *
 * Env is a whitelist rather than `...process.env`, matching index.test.ts, so a
 * TAILSCALE_* var exported by the developer's shell cannot change what this
 * asserts -- TAILSCALE_MCP_RUNTIME especially, since an ambient `oam` would
 * send the run down the spawn branch and quietly test something else.
 *
 * Closing stdin is what makes it terminate: the stdio transport reads EOF as
 * "the client hung up" and exits, so there is no kill and no settle timer
 * racing the banner. `close` rather than `exit` so stderr has drained -- and
 * `close` carries the same (code, signal) pair, so the launcher's own exit
 * status is read from the event already being waited on.
 *
 * `nodeArgs` go to the Node running the launcher, before its path -- the hook
 * preload() uses to change what the launcher believes it is hosted on.
 */
function runLauncher(
  extraEnv: Record<string, string>,
  args: string[] = [],
  nodeArgs: string[] = [],
): Promise<LauncherRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, launcherPath, ...args], {
      // OAM_BIN points at the Node binary running this test on purpose -- see
      // the note above. It is inert while the dispatch is correct, and it is
      // what keeps a drifted dispatch from silently succeeding against a real
      // oam that happens to be installed on the box running the suite.
      env: {
        PATH: process.env.PATH ?? "",
        TAILSCALE_MCP_RUNTIME: "node",
        OAM_BIN: process.execPath,
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (err?: Error, code: number | null = null, signal: NodeJS.Signals | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        child.kill();
        reject(err);
      } else {
        resolvePromise({ stdout, stderr, code, signal });
      }
    };
    // Generous, because a handoff boots a second Node, and a bare Node start has
    // been measured at ~11s on a contended Windows box.
    const timer = setTimeout(
      () => settle(new Error(`launcher did not exit after stdin EOF; stderr so far: ${JSON.stringify(stderr)}`)),
      45_000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => settle(err));
    child.on("close", (code, signal) => settle(undefined, code, signal));
    // `--version` exits before we get here, and an EPIPE on a stream with no
    // 'error' listener is an uncaught exception that kills the test RUNNER
    // rather than failing an assertion.
    child.stdin.on("error", () => {
      // Nothing is ever written to the child, so a broken stdin pipe carries no
      // information: the assertions read stdout/stderr, and `close` still fires.
    });
    child.stdin.end();
  });
}

type McpResponse = { id?: number; result?: { serverInfo?: { name?: string }; tools?: unknown[] } };
type McpSession = LauncherRun & { responses: McpResponse[]; timedOut: boolean };

/**
 * Run the REAL bin entry as an MCP host would: send `initialize`, and only once
 * it is answered send `notifications/initialized` plus `tools/list` as a second
 * write, then close stdin after that answer. Same env whitelist and defaults as
 * runLauncher.
 *
 * Two separate writes on purpose. A launcher stdin that stops flowing partway
 * (see "launcher when the chosen oam fails to spawn") can still deliver the
 * FIRST chunk, so a single request proves nothing about the session after it.
 * Resolves rather than rejects on the deadline, so the assertion can show what
 * did arrive.
 */
function runMcpSession(extraEnv: Record<string, string>, nodeArgs: string[] = []): Promise<McpSession> {
  const send = (child: ReturnType<typeof spawn>, ...messages: object[]) =>
    child.stdin?.write(messages.map((m) => `${JSON.stringify(m)}\n`).join(""));
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [...nodeArgs, launcherPath], {
      env: { PATH: process.env.PATH ?? "", TAILSCALE_MCP_RUNTIME: "node", OAM_BIN: process.execPath, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let buffered = "";
    const responses: McpResponse[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 45_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      buffered += chunk;
      for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as McpResponse;
        responses.push(msg);
        if (msg.id === 1) {
          send(
            child,
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
          );
        } else if (msg.id === 2) {
          child.stdin.end();
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      // A launcher that died early breaks the pipe; `close` still reports it.
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, signal, responses, timedOut });
    });
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "launcher-test", version: "1" } },
    });
  });
}

/** Mirrors the launcher's own `isWin`, which gates two discovery branches. */
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

const PACKAGE_VERSION = (JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as { version: string })
  .version;
const KEY = "tskey-api-launcher-test";

/** `--version` answered with this package's version and exit 0. */
const printedVersion = (run: LauncherRun) => run.code === 0 && run.stdout.trim() === PACKAGE_VERSION;

/**
 * Node flags for runLauncher's `nodeArgs`: a preload that reports, at exit, what
 * the LAUNCHER process's argv[1] ended up as, and -- given a version -- defines
 * `process.versions.oam`, so the launcher sees the one fact it branches on
 * exactly as it would under `oam run`.
 *
 * The runtimePlan() tests prove the decision; the cases below use this to prove
 * the launcher WIRES it, which no amount of testing runtimePlan in isolation
 * can. A real oam cannot be assumed on every box this suite runs on, and the
 * preload changes nothing else.
 *
 * argv[1] is the only way to tell "served in-process" from "handed off to a
 * child that printed the same version": runInProcess points it at
 * dist/index.js, and a handoff leaves it on the launcher. The preload does not
 * follow a handoff -- `--import` is an execArgv flag, and the launcher passes
 * only process.env on.
 *
 * `extra` is more preload source, appended as-is (see FAIL_FIRST_SPAWN).
 */
function preload(hostOam?: string, extra = ""): string[] {
  const exitMarker = `import { writeSync } from "node:fs"; process.on("exit", () => { try { writeSync(2, "LAUNCHER_ARGV1=" + process.argv[1] + "\\n"); } catch {} });`;
  const posing =
    hostOam === undefined
      ? ""
      : `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`;
  return ["--import", `data:text/javascript,${encodeURIComponent(`${exitMarker}${posing}${extra}`)}`];
}

/**
 * Preload source that makes the launcher's FIRST `spawn` target a path that does
 * not exist, and lets every later one through untouched.
 *
 * The shape it stands in for: the chosen oam answered its `--version` probe and
 * was then deleted or replaced before the spawn (a cargo rebuild, a
 * self-update). The probe is `execFileSync`, which does not go through
 * `spawn`, so the version check still sees the real binary. syncBuiltinESMExports
 * is what makes the launcher's own `import { spawn } from "node:child_process"`
 * see the patched function.
 */
const FAIL_FIRST_SPAWN = [
  'import childProcess from "node:child_process";',
  'import { syncBuiltinESMExports } from "node:module";',
  "const realSpawn = childProcess.spawn;",
  "let failed = false;",
  "childProcess.spawn = function (cmd, args, opts) {",
  "  if (failed) return realSpawn.call(this, cmd, args, opts);",
  "  failed = true;",
  '  return realSpawn.call(this, cmd + ".does-not-exist", args, opts);',
  "};",
  "syncBuiltinESMExports();",
].join("\n");

const IN_PROCESS = /LAUNCHER_ARGV1=.*dist[\\/]index\.js/;
const NOT_IN_PROCESS = /LAUNCHER_ARGV1=.*tailscale-mcp\.mjs/;

/** An empty directory, shared by every case that needs somewhere with nothing in it. */
const EMPTY = mkdtempSync(join(tmpdir(), "tailscale-mcp-launcher-empty-"));
after(() => rmSync(EMPTY, { recursive: true, force: true }));

/** The directory of the Node running this suite: what a Node handoff finds on PATH. */
const NODE_DIR = dirname(process.execPath);

/**
 * Cases that need a Node handoff to SUCCEED put NODE_DIR on PATH, and discovery
 * then scans it too. An oam installed beside Node (one bin directory for both)
 * would be discovered and change the outcome, so those cases skip -- visibly in
 * the TAP output -- rather than assert something else.
 */
const NODE_DIR_HAS_OAM = existsSync(join(NODE_DIR, exe));
const SKIP_NODE_DIR = NODE_DIR_HAS_OAM && `an oam binary sits beside node in ${NODE_DIR}`;

/**
 * An environment in which discovery finds no oam at all.
 *
 * A nonexistent OAM_BIN used to be enough: the launcher returned on the override
 * before any scan. It no longer is -- a bad OAM_BIN is named on stderr and
 * discovery carries on, asking EVERY oam it can see -- so the installed
 * locations and PATH have to be emptied as well. os.homedir() reads USERPROFILE
 * on Windows and HOME on POSIX, so redirecting those plus LOCALAPPDATA empties
 * the installed locations, and PATH holds only `pathDirs`: an empty directory by
 * default, or NODE_DIR when a case needs Node to be found.
 */
function noOam(extra: Record<string, string> = {}, pathDirs: string[] = [EMPTY]): Record<string, string> {
  return {
    OAM_BIN: "",
    USERPROFILE: EMPTY,
    HOME: EMPTY,
    LOCALAPPDATA: EMPTY,
    PATH: pathDirs.join(delimiter),
    ...extra,
  };
}

describe("launcher entry point", () => {
  // Why this exists at all: `runInProcess()` is the path every
  // `npx @yawlabs/tailscale-mcp` takes on a machine without oam -- the
  // overwhelmingly common install -- and nothing else in the suite runs it.
  // Every other server spawn points straight at dist/index.js, so the launcher
  // could stop resolving `../dist/index.js` (a build-output layout change, a
  // `files` edit, a move of bin/) and every published install would hang while
  // this suite stayed green.
  it("TAILSCALE_MCP_RUNTIME=node loads the server from ../dist/index.js in this process", async () => {
    const { stderr } = await runLauncher({ TAILSCALE_API_KEY: KEY });
    // The banner is dist/index.js's own output, so seeing it here proves the
    // relative resolution off import.meta.url landed on the built bundle -- the
    // one thing a text-reading test can never check.
    assert.match(
      stderr,
      /@yawlabs\/tailscale-mcp v\d+\.\d+\.\d+ ready \(\d+ tools\)/,
      `expected the server's startup banner via the launcher, got: ${JSON.stringify(stderr)}`,
    );
    // Narrower than it looks, and NOT the guard against mode-dispatch drift:
    // with OAM_BIN pinned, a drifted dispatch takes the Node binary as a usable
    // oam and spawns `node run <entry>` -- which cannot find a file called
    // "run", exits non-zero, and prints none of these strings. The banner
    // assertion above is what goes red there. What this still catches is an oam
    // probe reached on the node branch itself, printing a degradation notice on
    // the way to an otherwise successful in-process start that the banner match
    // alone would accept.
    assert.ok(
      !/no usable oam|OAM_BIN=|using Node instead|failed to launch oam|fallback to Node failed/.test(stderr),
      `TAILSCALE_MCP_RUNTIME=node must not touch the oam paths, got: ${JSON.stringify(stderr)}`,
    );
  });

  it("forwards argv to the server rather than consuming it", async () => {
    // index.ts reads its subcommand from process.argv[2], and runInProcess
    // rewrites argv[1] (so a server that gates on being the entry point still
    // starts) while leaving the rest alone. `--version` is the cheapest witness
    // that the rest really is left alone: it prints on STDOUT and exits before
    // any transport is connected, so a launcher that rebuilt argv instead of
    // patching one slot would start the MCP server here and print a banner.
    const { stdout, stderr } = await runLauncher({ TAILSCALE_API_KEY: KEY }, ["--version"]);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/, `expected a version on stdout, got: ${JSON.stringify(stdout)}`);
    assert.ok(!/ready \(/.test(stderr), `--version must not start the server, got: ${JSON.stringify(stderr)}`);
  });
});

describe("launcher TAILSCALE_MCP_RUNTIME dispatch", () => {
  // Every branch downstream compares the lowercased value against a literal, so
  // an unrecognized one matched nothing and fell through to auto in silence:
  // TAILSCALE_MCP_RUNTIME=nod asked for Node and got "prefer oam" instead, which
  // on a box with oam installed is a different runtime rather than a different
  // spelling. index.ts already writes a line for an unknown subcommand for the
  // same reason. auto stays the landing place -- the diagnostic is the change.
  //
  // noOam() is what keeps these cases off a real oam: the auto branch most of
  // them take would otherwise discover and spawn one on a developer box.

  it("warns on an unrecognized value and still starts the server as auto", async () => {
    const { stderr } = await runLauncher(noOam({ TAILSCALE_MCP_RUNTIME: "Nope", TAILSCALE_API_KEY: KEY }));
    // The RAW value, not the lowercased form the comparison uses: what makes the
    // line actionable is recognising the string as it sits in the MCP config.
    assert.match(
      stderr,
      /unrecognized TAILSCALE_MCP_RUNTIME "Nope" -- known values: auto, node, oam\. Using auto\./,
      `expected the unrecognized-runtime warning, got: ${JSON.stringify(stderr)}`,
    );
    // The "then behaves as auto" half. Without it, a launcher that warned and
    // then refused to start would satisfy the assertion above.
    assert.match(
      stderr,
      /@yawlabs\/tailscale-mcp v\d+\.\d+\.\d+ ready \(\d+ tools\)/,
      `an unrecognized runtime must still start the server, got: ${JSON.stringify(stderr)}`,
    );
  });

  it("stays silent for every recognized value, whatever the case", async () => {
    // NODE is the one that pins the check reading the lowercased `mode` rather
    // than the raw value. `oam` exits 1 here because noOam() leaves nothing to
    // run, which is the point: its own diagnostic is the correct one and this
    // catches a membership test that would bury it under a spurious warning.
    const runs = await Promise.all(
      ["node", "NODE", "auto", "oam"].map(
        async (value) =>
          [value, (await runLauncher(noOam({ TAILSCALE_MCP_RUNTIME: value, TAILSCALE_API_KEY: KEY }))).stderr] as const,
      ),
    );
    for (const [value, stderr] of runs) {
      assert.ok(
        !/unrecognized TAILSCALE_MCP_RUNTIME/.test(stderr),
        `TAILSCALE_MCP_RUNTIME=${value} is recognized and must not warn, got: ${JSON.stringify(stderr)}`,
      );
    }
  });

  it("treats an empty value as unset rather than as a typo", async () => {
    // `TAILSCALE_MCP_RUNTIME=$SOMEVAR` in a wrapper script with SOMEVAR unset
    // arrives as the empty string -- verified to survive spawn as "" rather than
    // being dropped -- and warning there would put a line in the host's log for
    // a value nobody typed.
    const { stderr } = await runLauncher(noOam({ TAILSCALE_MCP_RUNTIME: "", TAILSCALE_API_KEY: KEY }));
    assert.ok(
      !/unrecognized TAILSCALE_MCP_RUNTIME/.test(stderr),
      `an empty value must be treated as unset, got: ${JSON.stringify(stderr)}`,
    );
    assert.match(stderr, /@yawlabs\/tailscale-mcp v\d+\.\d+\.\d+ ready \(\d+ tools\)/);
  });

  it("mirrors the spawned child's exit code instead of draining to 0", async () => {
    // The only case in this file that pins what the SPAWN branch does with the
    // child's exit status; the "launcher on an oam host" cases reach that branch
    // too, but only to show it was taken. runLauncher's default OAM_BIN -- the
    // Node binary running this test -- is deliberately kept here: chooseOam
    // takes it, since `node --version` clears the floor, and the launcher spawns
    // `node run <entry> -- `. Node has no `run` subcommand, so it treats the
    // literal "run" argument as a script path, fails to resolve it and exits 1.
    // No oam behaviour is involved; the dependence is on that argv shape.
    const { code, stderr } = await runLauncher({ TAILSCALE_MCP_RUNTIME: "oam", TAILSCALE_API_KEY: KEY });
    // Drop launchChild's exit handler and the parent simply drains once the
    // child handle closes: exit 0 after a crashed server, with byte-identical
    // stdout and stderr. Supervisors and MCP hosts that restart on non-zero
    // never restart, and `npx @yawlabs/tailscale-mcp && ...` proceeds.
    assert.equal(code, 1, `expected the child's code, got ${code} with stderr: ${JSON.stringify(stderr)}`);
    // `code === 1` alone would not test what it claims: mode=oam ALSO exits 1
    // from the no-usable-oam branch, so a regression that stopped spawning
    // entirely still satisfies it. These two pin that a child really ran -- the
    // stderr is the child's own module-resolution failure arriving through the
    // inherited fds, and the launcher itself printed nothing, which is what
    // rules out "no usable oam" and every other `tailscale-mcp:`-prefixed
    // diagnostic reaching this arm.
    assert.match(
      stderr,
      /Cannot find module|MODULE_NOT_FOUND/,
      `expected the child's own failure on stderr, got: ${JSON.stringify(stderr)}`,
    );
    assert.ok(
      !/^tailscale-mcp: /m.test(stderr),
      `the launcher must have spawned rather than diagnosed, got: ${JSON.stringify(stderr)}`,
    );
  });
});

describe("launcher on an oam host", () => {
  // runLauncher's OAM_BIN pin -- the Node binary running this test -- is what
  // makes the two outcomes unmistakable without a real oam. In-process,
  // `--version` reaches dist/index.js and prints the package version with exit
  // 0. On the discovery path chooseOam takes that Node, `node --version` clears
  // the floor, and the launcher spawns `node [flags] run <entry>`, which has no
  // `run` subcommand, prints no version and exits non-zero.

  it("control: on plain Node the launcher still discovers and spawns", async () => {
    // Without this, the in-process cases below would also pass for a launcher
    // that ALWAYS runs in-process and never uses oam at all.
    const run = await runLauncher({ TAILSCALE_MCP_RUNTIME: "auto", TAILSCALE_API_KEY: KEY }, ["--version"]);
    assert.equal(printedVersion(run), false, `expected a spawn, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
  });

  it("serves in-process instead of spawning a nested oam", async () => {
    // `oam` alongside auto: demanding oam on a host that already is one must
    // not be read as "go and find another".
    for (const runtime of ["auto", "oam"]) {
      const run = await runLauncher(
        { TAILSCALE_MCP_RUNTIME: runtime, TAILSCALE_API_KEY: KEY },
        ["--version"],
        preload("0.15.2"),
      );
      assert.equal(printedVersion(run), true, `TAILSCALE_MCP_RUNTIME=${runtime} -> ${JSON.stringify(run)}`);
      assert.match(run.stderr, IN_PROCESS);
    }
  });

  it("still spawns under TAILSCALE_MCP_SANDBOX=1, so --permission is not dropped", async () => {
    const run = await runLauncher(
      { TAILSCALE_MCP_RUNTIME: "auto", TAILSCALE_MCP_SANDBOX: "1", TAILSCALE_API_KEY: KEY },
      ["--version"],
      preload("0.15.2"),
    );
    assert.equal(printedVersion(run), false, `the sandbox must force a spawn, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
    // A spawned child failing, not the launcher diagnosing: every launcher
    // message starts with `tailscale-mcp: `.
    assert.ok(!/^tailscale-mcp: /m.test(run.stderr), `expected a spawn, got: ${JSON.stringify(run.stderr)}`);
    assert.match(run.stderr, NOT_IN_PROCESS);
  });

  it("does not serve on a host oam below the floor when a newer oam is usable", async () => {
    const run = await runLauncher(
      { TAILSCALE_MCP_RUNTIME: "auto", TAILSCALE_API_KEY: KEY },
      ["--version"],
      preload("0.15.1"),
    );
    assert.equal(printedVersion(run), false, `a below-floor host must not shortcut, got ${JSON.stringify(run)}`);
    assert.notEqual(run.code, 0);
    assert.ok(!/^tailscale-mcp: /m.test(run.stderr), `expected a spawn, got: ${JSON.stringify(run.stderr)}`);
    assert.match(run.stderr, NOT_IN_PROCESS);
  });
});

/**
 * A temp tree carrying an inert oam in each discovery location named, plus the
 * env that points the launcher's installed-location scan into it.
 *
 * No real executable is needed. An inert empty file named oam/oam.exe satisfies
 * existsSync; oamVersion then fails to run it and returns null, so it is found
 * but never usable -- and when nothing usable is found the launcher names every
 * such candidate on stderr, in search order.
 */
function makeTree(locations: Array<"localAppData" | "home" | "path">) {
  const root = mkdtempSync(join(tmpdir(), "tailscale-mcp-oam-"));
  const pathDir = join(root, "pathdir");
  const paths = {
    localAppData: join(root, "localappdata", "oam", "bin", exe),
    home: join(root, "home", ".oam", "bin", exe),
    path: join(pathDir, exe),
  };
  mkdirSync(pathDir, { recursive: true });
  for (const location of locations) {
    mkdirSync(dirname(paths[location]), { recursive: true });
    writeFileSync(paths[location], "");
  }
  const env = {
    OAM_BIN: "",
    USERPROFILE: join(root, "home"),
    HOME: join(root, "home"),
    LOCALAPPDATA: join(root, "localappdata"),
    // REPLACED, not prepended: discovery asks every oam it can see, so a real
    // oam anywhere on the developer's PATH would be chosen over the inert ones.
    PATH: pathDir,
  };
  return { root, pathDir, paths, env };
}

describe("launcher with no usable oam", () => {
  it("names an OAM_BIN that does not exist or will not run, then carries on with discovery", async () => {
    // It used to stop at OAM_BIN: a typo meant Node, with no hint why. The inert
    // installed copy is the witness that discovery ran after the bad override.
    const { root, paths, env } = makeTree(["home"]);
    const inert = join(root, "inert", exe);
    mkdirSync(dirname(inert), { recursive: true });
    writeFileSync(inert, "");
    try {
      for (const [override, why] of [
        [join(root, "no-such-dir", exe), "does not exist"],
        [inert, "could not be run, or did not report a version this launcher understands"],
      ] as const) {
        const run = await runLauncher(
          { ...env, OAM_BIN: override, TAILSCALE_MCP_RUNTIME: "auto", TAILSCALE_API_KEY: KEY },
          ["--version"],
          preload(),
        );
        assert.equal(printedVersion(run), true, `OAM_BIN=${override} -> ${JSON.stringify(run)}`);
        assert.match(run.stderr, IN_PROCESS);
        const note = run.stderr.split(/\r?\n/).find((line) => line.startsWith("tailscale-mcp: "));
        assert.ok(note, `expected a launcher note, got: ${JSON.stringify(run.stderr)}`);
        assert.ok(note.startsWith(`tailscale-mcp: OAM_BIN=${override} ${why}; `), note);
        assert.ok(note.includes(`${paths.home} could not be run`), `discovery must still run: ${note}`);
        assert.ok(note.endsWith("; using Node instead."), note);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hands a below-floor oam host off to Node rather than serving on it", { skip: SKIP_NODE_DIR }, async () => {
    // With the sandbox too: Node has no --permission to apply, but a host below
    // the floor must not serve either way.
    const extras: Record<string, string>[] = [{}, { TAILSCALE_MCP_SANDBOX: "1" }];
    for (const extra of extras) {
      const run = await runLauncher(
        noOam({ TAILSCALE_MCP_RUNTIME: "auto", TAILSCALE_API_KEY: KEY, ...extra }, [NODE_DIR]),
        ["--version"],
        preload("0.9.0"),
      );
      assert.equal(printedVersion(run), true, `the Node child must still serve: ${JSON.stringify(run)}`);
      assert.match(
        run.stderr,
        /this process is oam 0\.9\.0, older than 0\.15\.2, and no newer oam was found; running on .*node/,
      );
      // Served by the child, not in the launcher process: argv[1] was never
      // pointed at dist/index.js.
      assert.match(run.stderr, NOT_IN_PROCESS);
    }
  });

  it("refuses to serve on a below-floor oam host when there is no Node either", async () => {
    const run = await runLauncher(
      noOam({ TAILSCALE_MCP_RUNTIME: "auto", TAILSCALE_API_KEY: KEY }),
      ["--version"],
      preload("0.9.0"),
    );
    assert.equal(run.code, 1, JSON.stringify(run));
    assert.equal(run.stdout.trim(), "", "nothing may be served");
    assert.match(run.stderr, /no Node was found on PATH/);
    assert.match(run.stderr, /oam self-update/);
    assert.match(run.stderr, NOT_IN_PROCESS);
  });

  it("hands TAILSCALE_MCP_RUNTIME=node off to Node even on a supported oam host", async () => {
    const run = await runLauncher(
      noOam({ TAILSCALE_MCP_RUNTIME: "node", TAILSCALE_API_KEY: KEY }, [NODE_DIR]),
      ["--version"],
      preload("0.15.2"),
    );
    assert.equal(printedVersion(run), true, JSON.stringify(run));
    assert.match(run.stderr, NOT_IN_PROCESS);
    // Asked-for Node is not news, so no note.
    assert.ok(!/^tailscale-mcp: /m.test(run.stderr), JSON.stringify(run.stderr));
  });

  it("serves a sandboxed at-floor oam host in-process when there is no oam to spawn", async () => {
    // Unchanged repo-specific behaviour: TAILSCALE_MCP_SANDBOX=1 sends a
    // supported oam host to discovery, and with nothing to spawn auto serves in
    // that host process WITHOUT --permission, exactly as before. Only a host
    // below the floor is barred from that.
    const run = await runLauncher(
      noOam({ TAILSCALE_MCP_RUNTIME: "auto", TAILSCALE_MCP_SANDBOX: "1", TAILSCALE_API_KEY: KEY }),
      ["--version"],
      preload("0.15.2"),
    );
    assert.equal(printedVersion(run), true, JSON.stringify(run));
    assert.match(run.stderr, IN_PROCESS);
  });

  it("makes an unappliable sandbox fatal under TAILSCALE_MCP_RUNTIME=oam", async () => {
    // The documented way to refuse the fallback above.
    const run = await runLauncher(
      noOam({ TAILSCALE_MCP_RUNTIME: "oam", TAILSCALE_MCP_SANDBOX: "1", TAILSCALE_API_KEY: KEY }),
      ["--version"],
      preload("0.15.2"),
    );
    assert.equal(run.code, 1, JSON.stringify(run));
    assert.equal(run.stdout.trim(), "", "nothing may be served");
    assert.match(run.stderr, /TAILSCALE_MCP_RUNTIME=oam but no usable oam \(0\.15\.2 or newer\) was found/);
  });
});

describe("launcher when the chosen oam fails to spawn", () => {
  // Every handoff from an oam host pipes stdio and mirrors the child's 'close'.
  // A spawn that fails emits 'error' -- which starts the fallback -- and then
  // 'close' with the negative errno as its code, so a close handler that did not
  // wait for 'spawn' process.exit()ed the launcher in the middle of that
  // fallback, and nothing served (measured: exit 4294963238, i.e. -4058, ENOENT).
  // Stdin piped into the dead child is the other half: an in-process fallback
  // that survives the exit still answers the host's first request, then stdin
  // stops flowing once the pipe's write to the dead child fails, and the next
  // request is never read (measured: initialize answered, tools/list never).
  //
  // OAM_BIN is the Node running this suite: `node --version` clears the floor,
  // so it is the chosen "oam" without any discovery, and FAIL_FIRST_SPAWN makes
  // its spawn fail.

  it("still falls back when the chosen oam fails to spawn on an oam host", { skip: SKIP_NODE_DIR }, async () => {
    // The canonical case: a below-floor host whose newer oam will not start
    // hands off to Node, which spawns normally.
    const run = await runLauncher(
      noOam({ TAILSCALE_MCP_RUNTIME: "auto", TAILSCALE_API_KEY: KEY, OAM_BIN: process.execPath }, [NODE_DIR]),
      ["--version"],
      preload("0.9.0", FAIL_FIRST_SPAWN),
    );
    assert.equal(run.code, 0, JSON.stringify(run));
    assert.equal(run.stdout.trim(), PACKAGE_VERSION, "the Node fallback must still serve");
    assert.match(run.stderr, /failed to launch oam at .*; using Node instead\./);
    assert.match(
      run.stderr,
      /this process is oam 0\.9\.0, older than 0\.15\.2, and the newer oam would not start; running on .*node/,
    );
    assert.match(run.stderr, NOT_IN_PROCESS);
  });

  it("serves a whole MCP session in-process on a sandboxed at-floor oam host when its fresh oam fails to spawn", async () => {
    // This repo's own fallback: TAILSCALE_MCP_SANDBOX=1 sends a supported oam
    // host to discovery, and when the fresh oam will not start auto serves in
    // that host process. A real session over stdin rather than `--version`,
    // because the stdin half only shows on the host's SECOND write.
    const run = await runMcpSession(
      noOam({
        TAILSCALE_MCP_RUNTIME: "auto",
        TAILSCALE_MCP_SANDBOX: "1",
        TAILSCALE_API_KEY: KEY,
        OAM_BIN: process.execPath,
      }),
      preload("0.15.2", FAIL_FIRST_SPAWN),
    );
    const summary = JSON.stringify({ ...run, stdout: run.stdout.slice(0, 300) });
    assert.equal(run.timedOut, false, `the session hung: ${summary}`);
    assert.equal(run.code, 0, summary);
    const byId = (id: number) => run.responses.find((msg) => msg.id === id);
    assert.equal(byId(1)?.result?.serverInfo?.name, "@yawlabs/tailscale-mcp", summary);
    assert.ok(
      (byId(2)?.result?.tools?.length ?? 0) > 0,
      `tools/list, sent after initialize, went unanswered: ${summary}`,
    );
    assert.match(run.stderr, /failed to launch oam at .*; using this oam 0\.15\.2 process instead\./);
    assert.match(run.stderr, IN_PROCESS);
  });
});

describe("launcher oam discovery order", () => {
  // The only cases that pin the ORDER of the scans. Search order no longer
  // picks the binary outright -- the newest usable oam wins --
  // but it still breaks a TIE, and it is the order stderr names candidates in.
  // Under TAILSCALE_MCP_RUNTIME=oam with nothing usable the launcher lists every
  // candidate it found, one per line, before exiting 1; that list pins the order
  // exactly rather than by proxy.
  function candidateLines(stderr: string): string[] {
    return stderr.split(/\r?\n/).filter((line) => line.startsWith("  ") && line.includes(" could not be run"));
  }

  it("searches an installed ~/.oam/bin before PATH, so the installed copy wins a tie", async () => {
    // The tie-break exists because someone who develops oam itself has
    // oam/target/release on PATH, and cargo replaces that binary underneath
    // running processes. Reorder the scans -- move the PATH walk above the
    // installed locations -- and an equal-version dev build wins instead.
    const { root, paths, env } = makeTree(["home", "path"]);
    try {
      const { code, stderr } = await runLauncher({ ...env, TAILSCALE_MCP_RUNTIME: "oam" });
      assert.equal(code, 1, `TAILSCALE_MCP_RUNTIME=oam must hard-fail here, got ${code}`);
      assert.deepEqual(
        candidateLines(stderr),
        [`  ${paths.home} could not be run`, `  ${paths.path} could not be run`].map(
          (prefix) => `${prefix}, or did not report a version this launcher understands`,
        ),
        JSON.stringify(stderr),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The Windows installer's default location, and the only candidate that is
  // conditional: it is unshifted onto the list under isWin, so on POSIX this
  // asserts a path the launcher never builds. Skipped rather than
  // early-returned, so a skip is visible in the TAP output -- there is no CI
  // here, only release.sh's gate.
  it("searches %LOCALAPPDATA%\\oam\\bin before ~/.oam/bin and PATH", { skip: !isWin }, async () => {
    const { root, paths, env } = makeTree(["localAppData", "home", "path"]);
    try {
      const { code, stderr } = await runLauncher({ ...env, TAILSCALE_MCP_RUNTIME: "oam" });
      assert.equal(code, 1, `TAILSCALE_MCP_RUNTIME=oam must hard-fail here, got ${code}`);
      const lines = candidateLines(stderr);
      assert.equal(lines.length, 3, JSON.stringify(stderr));
      assert.ok(lines[0].startsWith(`  ${paths.localAppData} `), JSON.stringify(lines));
      assert.ok(lines[1].startsWith(`  ${paths.home} `), JSON.stringify(lines));
      assert.ok(lines[2].startsWith(`  ${paths.path} `), JSON.stringify(lines));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("asks each binary once, however many times PATH names its directory", async () => {
    // Every candidate now costs an `oam --version` subprocess, so a directory
    // listed twice on PATH -- common, and on Windows often in a different case --
    // must not be probed twice.
    const { root, pathDir, paths, env } = makeTree(["path"]);
    try {
      const dirs = [pathDir, pathDir, isWin ? pathDir.toUpperCase() : pathDir];
      const { code, stderr } = await runLauncher({ ...env, PATH: dirs.join(delimiter), TAILSCALE_MCP_RUNTIME: "oam" });
      assert.equal(code, 1, `TAILSCALE_MCP_RUNTIME=oam must hard-fail here, got ${code}`);
      const lines = candidateLines(stderr);
      assert.equal(lines.length, 1, JSON.stringify(stderr));
      assert.ok(lines[0].startsWith(`  ${paths.path} `), JSON.stringify(lines));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// findOamShim returns null on POSIX, so these would FAIL there rather than
// skip, and no CI exists to catch that. describe-level skip matches
// integration.test.ts.
describe("launcher findOamShim", { skip: !isWin }, () => {
  it("names an oam.cmd on PATH rather than reporting no oam at all", async () => {
    // Diagnostic quality, but the kind that turns a solvable state into a dead
    // end: an npm/scoop-style install leaves oam.cmd on PATH, discovery is
    // .exe-only because Node refuses to spawn a .cmd without a shell, and a bare
    // "no usable oam was found" then tells the user to install the thing they
    // already installed.
    //
    // mode=oam is the vehicle because it prints the note and exits before any
    // server boot; auto builds the same note but then runs the server, coupling
    // the assertion to a built dist/index.js.
    const shimDir = mkdtempSync(join(tmpdir(), "tailscale-mcp-shim-"));
    const shim = join(shimDir, "oam.cmd");
    writeFileSync(shim, "");
    try {
      // PATH holds only the shim's directory: discovery asks every oam.exe on
      // PATH, so a real one there would be chosen before the note is printed.
      const { code, stderr } = await runLauncher(noOam({ TAILSCALE_MCP_RUNTIME: "oam" }, [shimDir]));
      assert.equal(code, 1, `TAILSCALE_MCP_RUNTIME=oam must hard-fail here, got ${code}`);
      assert.match(stderr, /no usable oam \(0\.15\.2 or newer\) was found/);
      // The PATH, not just the sentence: "found <path>" is the whole reason the
      // branch exists, and asserting only the static half would pass against a
      // hardcoded string that names nothing.
      assert.ok(
        stderr.includes(`found ${shim}, but Node cannot execute a .cmd/.bat directly`),
        `expected the shim's own path in the note, got: ${JSON.stringify(stderr)}`,
      );
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
  });
});

describe("lint covers the shipped launcher", () => {
  // bin/tailscale-mcp.mjs is the npm `bin` entry -- the file every
  // `npx @yawlabs/tailscale-mcp` runs -- and `lint` was `biome check src/`, so
  // none of its 400-odd lines were ever checked. biome.json's own files.includes
  // is `**`, so the gap lived entirely in the script's argument list, which is
  // the shape that reads as covered. There are no CI workflows in this repo, so
  // release.sh's `npm run lint` is the only gate this file gets.
  const scripts = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")).scripts as Record<
    string,
    string
  >;

  /** The path arguments of a `biome check [--write] <paths...>` script. */
  function checkedPaths(script: string): string[] {
    return script
      .split(/\s+/)
      .filter((t) => t && t !== "--write")
      .slice(2)
      .sort();
  }

  it("checks the directory holding the bin entry", () => {
    assert.ok(
      checkedPaths(scripts.lint).includes("bin/"),
      `the shipped bin entry is unlinted: ${JSON.stringify(scripts.lint)}`,
    );
  });

  it("fixes exactly the paths it checks", () => {
    // Widening one without the other leaves `npm run lint:fix` unable to repair
    // what the release gate rejects -- or silently reformatting more than the
    // gate reads, which lands as an unexplained diff.
    assert.deepEqual(checkedPaths(scripts["lint:fix"]), checkedPaths(scripts.lint));
  });
});
