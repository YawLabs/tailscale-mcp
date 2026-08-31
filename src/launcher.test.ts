import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
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
 * Lift one top-level declaration out of the launcher source and evaluate it.
 *
 * Same idiom and the same reason as loadSandboxFlags above: the module body
 * resolves a runtime and spawns or imports the server at import time, so
 * evaluating the real declaration as text is the only way to exercise it that
 * does not require a behaviour change to a shipped runtime artifact. A failed
 * extraction is a loud assertion, not a silent skip.
 */
function loadFromSource<T>(pattern: RegExp, name: string): T {
  const match = launcherSource.match(pattern);
  assert.ok(match, `could not extract ${name} from bin/tailscale-mcp.mjs -- was it renamed or reformatted?`);
  const factory = new Function(`${match[0]}; return ${name};`) as () => T;
  return factory();
}

describe("launcher oam version floor", () => {
  // Given a discovered oam, `atLeast(found, OAM_MIN)` is the SOLE gate deciding
  // whether the server is handed to it. Nothing pinned either the comparison or
  // the constant, so every regression below lands green.
  const atLeast = loadFromSource<(v: number[] | null, min: number[]) => boolean>(
    /function atLeast\(v, min\) \{[\s\S]*?\n\}/,
    "atLeast",
  );
  const OAM_MIN = loadFromSource<number[]>(/const OAM_MIN = \[[^\]]*\];/, "OAM_MIN");

  it("is 0.9.0, the release where oam stopped re-splitting execFile arguments through a shell", () => {
    // The floor README:541 and the MINIMUM OAM VERSION block both state. Below
    // 0.9.0 oam ran execFile arguments through a shell, re-splitting them on
    // whitespace and executing metacharacters inside an argument -- and this
    // server passes tool input (device names, tags, hostnames) to a CLI on its
    // local-CLI paths. Quietly lowering the constant is a one-token change with
    // no other symptom, so it has to arrive as a deliberate diff through here.
    assert.deepEqual(OAM_MIN, [0, 9, 0]);
  });

  it("refuses a version that could not be read at all", () => {
    // oamVersion returns null when the binary would not run (not executable,
    // wrong arch, deleted since the stat) or its --version did not parse, and
    // that null reaches this same gate -- bin:325-330 only splits the two
    // REMEDIES apart afterwards. The `if (!v) return false` guard is what turns
    // "unreadable" into a clean fallback: drop it and the loop dereferences null,
    // killing the launcher at the gate with a TypeError instead of degrading to
    // Node, while inverting it to `return true` hands the server to a binary
    // that never reported a version at all.
    assert.equal(atLeast(null, OAM_MIN), false);
  });

  it("accepts the floor itself and rejects the patch below it", () => {
    // Inclusive boundary: 0.9.0 IS the supported release, so an off-by-one that
    // demanded 0.9.1 would fall every user who installed exactly what the README
    // names back to Node, with only a stderr line to say so.
    assert.equal(atLeast([0, 9, 0], OAM_MIN), true);
    assert.equal(atLeast([0, 8, 9], OAM_MIN), false);
  });

  it("compares components numerically, not lexicographically", () => {
    // 0.10.0 is newer than 0.9.0 but sorts BEFORE it as a string, so a compare
    // rewritten over `v.join(".")` -- or over the raw --version text, skipping
    // the parse entirely -- rejects every 0.10+ oam and silently downgrades.
    assert.equal(atLeast([0, 10, 0], OAM_MIN), true);
    assert.equal(atLeast([1, 0, 0], OAM_MIN), true);
  });
});

type LauncherRun = { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null };

/**
 * Run the REAL bin entry and return everything it wrote to stdout and stderr.
 *
 * The tests above read bin/tailscale-mcp.mjs as TEXT; this is the only place
 * the shipped `bin` is executed. Two env pins make that hermetic and both are
 * load-bearing. TAILSCALE_MCP_RUNTIME=node takes the `runInProcess()` branch
 * before any oam discovery happens; OAM_BIN=process.execPath covers the case
 * where that dispatch has drifted, because findOam checks the explicit override
 * FIRST and returns without ever reaching the installed-location or PATH scans
 * behind it. A real oam on the developer's box therefore cannot be reached from
 * here, so the run behaves identically on a machine with oam installed and on
 * one without.
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
 */
function runLauncher(extraEnv: Record<string, string>, args: string[] = []): Promise<LauncherRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [launcherPath, ...args], {
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
    const timer = setTimeout(
      () => settle(new Error(`launcher did not exit after stdin EOF; stderr so far: ${JSON.stringify(stderr)}`)),
      15_000,
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

/**
 * A path that cannot exist, so findOam's explicit-override branch returns null
 * at once and never reaches the installed-location or PATH scans behind it --
 * which is what keeps a real oam on the developer's box out of every test that
 * exercises the no-binary paths.
 *
 * runLauncher's default OAM_BIN pin cannot be reused for those: it RESOLVES, so
 * the branch under test would go on to spawn `node run <entry>` and report a
 * missing file instead of the diagnostic being asserted.
 */
const NO_OAM = resolve(repoRoot, "no-such-directory", "oam");

/** Mirrors the launcher's own `isWin`, which gates two discovery branches. */
const isWin = process.platform === "win32";

describe("launcher entry point", () => {
  // Why this exists at all: `runInProcess()` is the path every
  // `npx @yawlabs/tailscale-mcp` takes on a machine without oam -- the
  // overwhelmingly common install -- and nothing else in the suite runs it.
  // Every other server spawn points straight at dist/index.js, so the launcher
  // could stop resolving `../dist/index.js` (a build-output layout change, a
  // `files` edit, a move of bin/) and every published install would hang while
  // this suite stayed green.
  it("TAILSCALE_MCP_RUNTIME=node loads the server from ../dist/index.js in this process", async () => {
    const { stderr } = await runLauncher({ TAILSCALE_API_KEY: "tskey-api-launcher-test" });
    // The banner is dist/index.js's own output, so seeing it here proves the
    // relative resolution off import.meta.url landed on the built bundle -- the
    // one thing a text-reading test can never check.
    assert.match(
      stderr,
      /@yawlabs\/tailscale-mcp v\d+\.\d+\.\d+ ready \(\d+ tools\)/,
      `expected the server's startup banner via the launcher, got: ${JSON.stringify(stderr)}`,
    );
    // Narrower than it looks, and NOT the guard against mode-dispatch drift:
    // with OAM_BIN pinned, a drifted dispatch resolves oam to the Node binary,
    // clears the version floor, and spawns `node run <entry>` -- which cannot
    // find a file called "run", exits non-zero, and prints none of these
    // strings. The banner assertion above is what goes red there. What this
    // still catches is an oam probe reached on the node branch itself, printing
    // a degradation notice on the way to an otherwise successful in-process
    // start that the banner match alone would accept.
    assert.ok(
      !/no runnable oam binary|using Node instead|failed to launch oam|fallback to Node failed/.test(stderr),
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
    const { stdout, stderr } = await runLauncher({ TAILSCALE_API_KEY: "tskey-api-launcher-test" }, ["--version"]);
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

  // NO_OAM (module scope) is what keeps these cases off a real oam: the auto
  // branch most of them take would otherwise spawn `node run <entry>` on a
  // developer box and report a missing file instead of what is under test.
  const KEY = "tskey-api-launcher-test";

  it("warns on an unrecognized value and still starts the server as auto", async () => {
    const { stderr } = await runLauncher({ TAILSCALE_MCP_RUNTIME: "Nope", OAM_BIN: NO_OAM, TAILSCALE_API_KEY: KEY });
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
    // than the raw value. `oam` exits 1 here because NO_OAM leaves nothing to
    // run, which is the point: its own diagnostic is the correct one and this
    // catches a membership test that would bury it under a spurious warning.
    const runs = await Promise.all(
      ["node", "NODE", "auto", "oam"].map(
        async (value) =>
          [
            value,
            (await runLauncher({ TAILSCALE_MCP_RUNTIME: value, OAM_BIN: NO_OAM, TAILSCALE_API_KEY: KEY })).stderr,
          ] as const,
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
    const { stderr } = await runLauncher({ TAILSCALE_MCP_RUNTIME: "", OAM_BIN: NO_OAM, TAILSCALE_API_KEY: KEY });
    assert.ok(
      !/unrecognized TAILSCALE_MCP_RUNTIME/.test(stderr),
      `an empty value must be treated as unset, got: ${JSON.stringify(stderr)}`,
    );
    assert.match(stderr, /@yawlabs\/tailscale-mcp v\d+\.\d+\.\d+ ready \(\d+ tools\)/);
  });

  it("mirrors the spawned child's exit code instead of draining to 0", async () => {
    // The only case in this file that reaches the SPAWN branch. runLauncher's
    // default OAM_BIN -- the Node binary running this test -- is deliberately
    // kept here rather than swapped for NO_OAM: findOam returns it, `node
    // --version` clears the floor, and the launcher spawns
    // `node run <entry> -- `. Node has no `run` subcommand, so it treats the
    // literal "run" argument (bin/tailscale-mcp.mjs:369) as a script path,
    // fails to resolve it and exits 1. No oam behaviour is involved; the
    // dependence is on that argv shape.
    const { code, stderr } = await runLauncher({ TAILSCALE_MCP_RUNTIME: "oam", TAILSCALE_API_KEY: KEY });
    // Drop the exit handler at bin:445 and the parent simply drains once the
    // child handle closes: exit 0 after a crashed server, with byte-identical
    // stdout and stderr. Supervisors and MCP hosts that restart on non-zero
    // never restart, and `npx @yawlabs/tailscale-mcp && ...` proceeds.
    assert.equal(code, 1, `expected the child's code, got ${code} with stderr: ${JSON.stringify(stderr)}`);
    // `code === 1` alone would not test what it claims: mode=oam ALSO exits 1
    // from the no-binary branch at bin:311, so a regression that stopped
    // spawning entirely still satisfies it. These two pin that a child really
    // ran -- the stderr is the child's own module-resolution failure arriving
    // through the inherited fds, and the launcher itself printed nothing, which
    // is what rules out "no runnable oam binary was found" and every other
    // `tailscale-mcp:`-prefixed diagnostic reaching this arm.
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

describe("launcher findOam discovery order", () => {
  // Nothing else in the suite reaches these scans: every other run pins OAM_BIN,
  // and findOam returns on that override before the installed-location and PATH
  // walks behind it. What they decide is not just startup cost --
  // TAILSCALE_MCP_SANDBOX=1 is honored ONLY on the spawn path (bin:369), so a
  // discovery regression that misses a real install drops the server into the
  // in-process fallback and runs it UNSANDBOXED, with no diagnostic at all.
  //
  // The fixture needs no real executable. An inert empty file named oam/oam.exe
  // satisfies existsSync; oamVersion then fails to run it and returns null; and
  // under TAILSCALE_MCP_RUNTIME=oam the launcher prints the path it CHOSE
  // verbatim (bin:327) before exiting 1. That line pins the order exactly rather
  // than by proxy.
  //
  // Hermetic because os.homedir() reads USERPROFILE on Windows and HOME on
  // POSIX, so redirecting those plus LOCALAPPDATA puts every installed-location
  // candidate inside the temp tree.
  const exe = isWin ? "oam.exe" : "oam";

  /** A temp tree carrying an inert oam in each discovery location named. */
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
      TAILSCALE_MCP_RUNTIME: "oam",
      // Empty rather than absent: findOam's override branch tests truthiness, so
      // "" falls through to the scans. runLauncher's default pins OAM_BIN at a
      // path that resolves, which would return before any of this ran.
      OAM_BIN: "",
      USERPROFILE: join(root, "home"),
      HOME: join(root, "home"),
      LOCALAPPDATA: join(root, "localappdata"),
      // PREPENDED, not replaced: the walk returns its first match, so a leading
      // temp entry wins over a real oam on the developer's PATH while the child
      // keeps the environment it needs to start at all.
      PATH: `${pathDir}${delimiter}${process.env.PATH ?? ""}`,
    };
    return { root, paths, env };
  }

  it("prefers an installed ~/.oam/bin over PATH", async () => {
    // The preference exists because someone who develops oam itself has
    // oam/target/release on PATH, and cargo replaces that binary underneath
    // running processes. Reorder the scans -- move the PATH walk above the
    // installed loop -- and the launcher binds to the build directory instead.
    const { root, paths, env } = makeTree(["home", "path"]);
    try {
      const { code, stderr } = await runLauncher(env);
      assert.equal(code, 1, `TAILSCALE_MCP_RUNTIME=oam must hard-fail here, got ${code}`);
      assert.ok(
        stderr.includes(paths.home),
        `expected the installed copy to win over PATH, got: ${JSON.stringify(stderr)}`,
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
  //
  // Losing the unshift is silent: ~/.oam/bin is still checked, so a box with
  // both copies keeps working and only a box with the installer's copy alone
  // falls through to PATH, or to Node.
  it("prefers %LOCALAPPDATA%\\oam\\bin over ~/.oam/bin and PATH", { skip: !isWin }, async () => {
    const { root, paths, env } = makeTree(["localAppData", "home", "path"]);
    try {
      const { code, stderr } = await runLauncher(env);
      assert.equal(code, 1, `TAILSCALE_MCP_RUNTIME=oam must hard-fail here, got ${code}`);
      assert.ok(
        stderr.includes(paths.localAppData),
        `expected the Windows installer's location to win, got: ${JSON.stringify(stderr)}`,
      );
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
    // end: an npm/scoop-style install leaves oam.cmd on PATH, findOam's walk is
    // .exe-only because Node refuses to spawn a .cmd without a shell, and the
    // bare "no runnable oam binary was found" then tells the user to install the
    // thing they already installed.
    //
    // mode=oam is the vehicle because it prints the note and exits before any
    // server boot; the auto arm builds the same shimNote (bin:296) but then runs
    // the server, coupling the assertion to a built dist/index.js.
    const shimDir = mkdtempSync(join(tmpdir(), "tailscale-mcp-shim-"));
    const shim = join(shimDir, "oam.cmd");
    writeFileSync(shim, "");
    try {
      const { code, stderr } = await runLauncher({
        TAILSCALE_MCP_RUNTIME: "oam",
        OAM_BIN: NO_OAM,
        // Prepended: findOamShim returns its FIRST match, so a leading temp
        // entry wins deterministically even on a box with a real oam.cmd.
        PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
      });
      assert.equal(code, 1, `TAILSCALE_MCP_RUNTIME=oam must hard-fail here, got ${code}`);
      assert.match(stderr, /no runnable oam binary was found/);
      // The PATH, not just the sentence: "Found <path>" is the whole reason the
      // branch exists, and asserting only the static half would pass against a
      // hardcoded string that names nothing.
      assert.ok(
        stderr.includes(`Found ${shim}, but Node cannot execute a .cmd/.bat directly.`),
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
