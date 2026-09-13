#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/tailscale-mcp.
 *
 * Prefers the newest usable oam runtime (https://oamjs.org) and falls back to
 * Node. It never serves on an oam older than the floor below.
 *
 *
 * WHY THE FALLBACK COSTS NOTHING
 * npm has already started Node to run this launcher, so falling back is a
 * plain `import()` of the server into THIS process: no extra spawn, no extra
 * startup, byte-identical to invoking dist/index.js directly. Finding the
 * candidates is stat-only, so a machine without oam never pays for a
 * subprocess.
 *
 * WHAT THE OAM PATH COSTS
 * Reaching oam through an npm `bin` means Node boots first, every oam binary
 * found is asked for its version, and then oam boots to serve -- so the
 * launcher is slower than pointing a host at oam directly. Measured on
 * npmjs-mcp (windows-arm64, n=12 medians, spawn to first MCP initialize):
 * oam 116ms, node 172ms, launcher 243ms. It exists for `npx` convenience.
 *
 * For an MCP host config, point straight at oam and skip this file:
 *   { "command": "oam", "args": ["run", "<abs>/dist/index.js"] }
 *
 * WHICH OAM
 * OAM_BIN, when set and usable, is used as given. Otherwise every oam binary
 * discovery can see -- the installed locations, then PATH -- is asked for its
 * version, and the NEWEST one at or above the floor wins; a tie keeps search
 * order. Taking the first binary found instead let a stale copy early in the
 * search order hide a current one later: with oam 0.9.0 installed in ~/.oam/bin
 * and 0.15.2 on PATH, the launcher bound to 0.9.0 because installed locations
 * are searched first.
 *
 * An OAM_BIN that does not exist, is below the floor, or will not run is named
 * on stderr and discovery carries on. It used to stop everything: a typo in
 * OAM_BIN meant Node, with no hint why.
 *
 * ALREADY RUNNING ON OAM
 * A host can resolve this package's `bin` and launch `oam run <this file>`
 * instead of `node <this file>` -- Yaw MCP does, and so does oam's sidecar
 * regression matrix. This launcher used to discover oam and spawn it anyway,
 * so one server cost two runtime boots: measured on Windows, oam.exe with a
 * NESTED oam.exe + conhost.exe underneath it. Now, when `process.versions.oam`
 * clears the same MINIMUM OAM VERSION a discovered binary has to, the server is
 * imported into THIS process exactly as the Node fallback is -- no discovery,
 * no `oam --version` probe, no second oam. OAM_BIN is a discovery input, so it
 * is not consulted on that path: the host has already chosen which oam runs.
 *
 * TAILSCALE_MCP_SANDBOX=1 still takes the discovery path on such a host,
 * deliberately: `--permission` is a process-level flag that only a FRESH oam
 * can apply, so serving in-process there would drop the sandbox without a
 * word -- a security downgrade dressed up as an optimisation.
 *
 * A host oam BELOW the floor never serves. It used to, whenever discovery came
 * up empty. It now hands the server off to the newest usable oam, or to Node
 * found on PATH, or exits with an error when there is neither.
 *
 * Every handoff from an oam host PIPES stdio rather than inheriting it. Before
 * 0.9.0 oam treated `stdio: 'inherit'` as `'pipe'`, so an inherited handoff
 * from such a host connects the child to pipes nobody reads: measured with a
 * real oam 0.8.2 host on aws-mcp's copy of this launcher, the MCP handshake
 * never answered. Piping the streams explicitly completes it, to both oam and
 * Node, and is equally correct from a current oam, so the rule does not depend
 * on the host's version. A Node host keeps `inherit`, which hands over the
 * same fds untouched.
 *
 * Discovery asks for a spawn; it does not guarantee one. If it finds no usable
 * oam, or the spawn itself fails, the default TAILSCALE_MCP_RUNTIME=auto falls
 * back. A Node host runs the server in-process, and so does an oam host at the
 * floor -- which only reaches discovery for the sandbox -- so under
 * TAILSCALE_MCP_SANDBOX=1 that fallback serves WITHOUT `--permission`, and
 * nothing on stderr mentions the sandbox. A host below the floor hands off to
 * Node instead, which has no `--permission` to apply either. Pair the sandbox
 * with TAILSCALE_MCP_RUNTIME=oam to make a sandbox that cannot be applied fatal.
 *
 * THE `--permission` SANDBOX (opt-in)
 * `TAILSCALE_MCP_SANDBOX=1` runs the server under oam's permission model:
 * network limited to the one host the bundle actually calls
 * (api.tailscale.com), filesystem denied.
 *
 * Child-process is granted unconditionally because the local-CLI tools shell out
 * to the `tailscale` binary; that is also why PATH stays in the env grant, since
 * resolving the binary needs it.
 *
 * Opt-in, not default, because a denied environment variable is ABSENT from
 * process.env rather than throwing -- an under-granted TAILSCALE_API_KEY reads as
 * "unauthenticated" rather than "denied". The env list is derived from the
 * shipped bundle; keep it in step.
 *
 * MINIMUM OAM VERSION
 * The latest oam release, 0.15.2 -- bump OAM_MIN when oam ships a newer one.
 * Only the current oam is used and verified; an older one is passed over for a
 * newer oam, or for Node. The floor is not cosmetic: before 0.9.0
 * `child_process.execFile` ran its arguments through a SHELL, `exec` accepted
 * `timeout` and ignored it, `spawnSync` truncated at `maxBuffer` while
 * reporting success, and `stdio: 'inherit'`/`'ignore'` both behaved as
 * `'pipe'`. This server shells out to the `tailscale` CLI on its local-CLI
 * tools, so those were reachable bugs rather than theoretical ones: an argument
 * containing shell metacharacters was re-split and executed.
 *
 * SELECTION
 *   TAILSCALE_MCP_RUNTIME=auto   newest usable oam, else Node (default)
 *   TAILSCALE_MCP_RUNTIME=oam    newest usable oam, else exit with an error
 *                                (already running on oam at the floor satisfies
 *                                it, unless TAILSCALE_MCP_SANDBOX=1 needs a
 *                                fresh one)
 *   TAILSCALE_MCP_RUNTIME=node   Node: in THIS process on Node, handed off to
 *                                Node on PATH when THIS process is oam; never
 *                                sandboxed
 *   anything else                warns on stderr, then behaves as auto
 *   TAILSCALE_MCP_SANDBOX=1      spawn oam under --permission (see above)
 *   OAM_BIN=/path/to/oam         use this oam when it is usable, before discovery
 * The TAILSCALE_MCP_RUNTIME value is case-insensitive, and an empty value counts
 * as unset.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The latest oam release, and the oldest one used. See MINIMUM OAM VERSION above. */
const OAM_MIN = [0, 15, 2];

/**
 * Bound on each `oam --version` probe. A healthy oam answers in milliseconds;
 * the bound only exists so a wedged binary on PATH cannot hang the launch.
 */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn() needs a real path.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/** Identity for de-duplicating paths: resolved, and case-folded on Windows. */
function pathKey(p) {
  let key = p;
  try {
    key = realpathSync(p);
  } catch {
    // Unresolvable: fall back to the literal path.
  }
  return isWin ? key.toLowerCase() : key;
}

/**
 * Every oam binary discovery can see, in search order, de-duplicated. Stat-only,
 * never a subprocess.
 *
 * Installed locations come BEFORE PATH, so when two binaries report the same
 * version the installed copy wins the tie. Someone who develops oam itself
 * usually has oam/target/release on PATH, and cargo replaces that binary
 * underneath running processes; OAM_BIN remains the way to point deliberately
 * at a dev build. Both forms are checked on Windows: the installer defaults to
 * %LOCALAPPDATA%\oam\bin there, but oam's docs name ~/.oam/bin first and
 * OAM_INSTALL_DIR can pick either.
 *
 * PATH is walked manually rather than by spawning `which`/`where`, which would
 * cost a subprocess on every launch just to decide whether to spawn.
 *
 * Windows: `.exe` ONLY -- deliberately narrower than PATHEXT. Node refuses to
 * run a .cmd/.bat through execFile/spawn without `shell: true` (EINVAL, and for
 * spawn it throws SYNCHRONOUSLY rather than emitting 'error'), so walking the
 * full PATHEXT list would hand back a path this launcher cannot execute. A
 * skipped shim is still reported -- see findOamShim.
 */
function discoverOamPaths() {
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (isWin) {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe));
  const seen = new Set();
  const found = [];
  for (const candidate of [...installed, ...onPath]) {
    if (!existsSync(candidate)) continue;
    const key = pathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(candidate);
  }
  return found;
}

/**
 * Version text -> [major, minor, patch], or null when it holds no version.
 * A pre-release suffix (0.9.0-rc.1) truncates to its base version.
 *
 * Shared by the two places a version is read -- a discovered binary's
 * `oam --version` output ("oam 0.15.1") and the host's own
 * `process.versions.oam` ("0.15.1") -- so they cannot disagree about what a
 * version string means, or which floor it has to clear.
 */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `oam --version` -> [major, minor, patch], or null when it cannot be read. */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseVersion(out);
  } catch {
    // Not executable, wrong arch, wedged, or deleted since the stat. Caller degrades.
    return null;
  }
}

/** True when `v` is at least `min`, comparing major/minor/patch in order. */
function atLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/**
 * The newest candidate at or above the floor, or null. `candidates` is
 * `{ path, version }[]` in search order, `version` null when unreadable.
 * Strictly-greater replaces, so a tie keeps the earlier candidate.
 *
 * Pure on purpose, like runtimePlan: the choice is testable without binaries.
 */
function pickNewest(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!atLeast(candidate.version, OAM_MIN)) continue;
    if (!best || !atLeast(best.version, candidate.version)) best = candidate;
  }
  return best;
}

/**
 * Where the server runs, decided BEFORE any discovery:
 *   "in-process"   import it into THIS process
 *   "discover"     choose an oam and spawn it, or fall back (see fallBack)
 *   "handoff-node" hand it off to Node on PATH: THIS process is an oam and
 *                  TAILSCALE_MCP_RUNTIME=node asked for Node
 *
 * `hostOam` is `process.versions.oam`: oam's own key, absent on Node. An oam
 * host whose version cannot be read is treated as below the floor -- it never
 * proved it is a supported oam. Every mode but `node` is decided the same way:
 * `oam` is satisfied by a host that already is one, and an unrecognized value
 * has been warned about and lands with auto.
 *
 * `sandbox` is whether a spawn would carry flags only a fresh oam can apply;
 * see ALREADY RUNNING ON OAM above for why that alone forces the discovery
 * path, and why discovery can still end in-process without those flags. Under
 * `node` it is moot: Node has no `--permission` to apply. The floor is OAM_MIN
 * itself, not a parameter, so a host oam and a discovered one can never be held
 * to different minimums.
 *
 * Pure on purpose: every input is passed in, so the whole decision is testable
 * without booting a runtime.
 */
function runtimePlan({ mode, hostOam, sandbox }) {
  const onOam = hostOam !== undefined;
  if (mode === "node") return onOam ? "handoff-node" : "in-process";
  if (sandbox) return "discover";
  return atLeast(parseVersion(hostOam ?? ""), OAM_MIN) ? "in-process" : "discover";
}

/**
 * Whether a fallback may serve in THIS process: on Node, or on an oam host at
 * the floor. The only host at the floor that ever reaches a fallback is one
 * that took the discovery path for TAILSCALE_MCP_SANDBOX=1, and it serves
 * without `--permission`, as it always has. A host below the floor never
 * serves.
 *
 * Pure on purpose, like runtimePlan.
 */
function fallbackInProcess(hostOam) {
  return hostOam === undefined || atLeast(parseVersion(hostOam), OAM_MIN);
}

/**
 * The `--permission` grant list, or [] when the sandbox is not requested.
 *
 * These are oam's PROCESS-level flags: they belong before the `run` subcommand,
 * not after it. `oam run --permission file.js` is rejected outright, which is a
 * good failure but only because it is loud -- ordering here is load-bearing.
 *
 * Net grants prefix-match `host` for fetch and `host:port` for sockets.
 * A denied environment variable is ABSENT from process.env rather than throwing,
 * so the env list below is derived from what the bundle actually reads; trimming
 * it produces silent misbehaviour, not a clear denial.
 */
function sandboxFlags() {
  if (process.env.TAILSCALE_MCP_SANDBOX !== "1") return [];

  // ONE host, deliberately. Every outbound request the bundle makes targets
  // api.tailscale.com: BASE_URL, the OAuth token exchange, and the absolute-URL
  // allow-list that refuses to send credentials anywhere else. login.tailscale.com
  // was granted here as well until an audit found no code path that contacts it
  // -- console.tailscale.com appears in error TEXT, never as a request target.
  // An unused grant is the one kind of over-permission nothing ever surfaces:
  // removing it cannot break a call that was never made, and keeping it widens
  // the sandbox for no behaviour. launcher.test.ts pins this list exactly so a
  // future host lands as a reviewed diff rather than a quiet widening.
  const hosts = ["api.tailscale.com"];

  const netFlag = `--allow-net=${hosts.join(",")}`;

  // Keep alphabetised and in sync with every env var the bundle reads -- a
  // missing entry is ABSENT from process.env rather than an error, so the
  // symptom is silent misbehaviour. TAILSCALE_LOCAL_CLI was missing here, which
  // meant the local-CLI tool group silently failed to register under the
  // sandbox even though --allow-child-process is granted below precisely so
  // those tools can shell out.
  const env = [
    "PATH",
    "TAILSCALE_API_KEY",
    "TAILSCALE_BINARY",
    "TAILSCALE_DEBUG",
    "TAILSCALE_EXTRA_POSTURE_PROVIDERS",
    "TAILSCALE_EXTRA_WEBHOOK_EVENTS",
    "TAILSCALE_LOCAL_CLI",
    "TAILSCALE_MAX_CONCURRENT",
    "TAILSCALE_OAUTH_CLIENT_ID",
    "TAILSCALE_OAUTH_CLIENT_SECRET",
    "TAILSCALE_OAUTH_TAILNET",
    "TAILSCALE_PROFILE",
    "TAILSCALE_READONLY",
    "TAILSCALE_REQUEST_BUDGET_MS",
    "TAILSCALE_REQUIRE_APPROVAL",
    "TAILSCALE_RETRY_BASE_DELAY_MS",
    "TAILSCALE_TAILNET",
    "TAILSCALE_TOOLS",
    "TAILSCALE_WRITE_GROUPS",
  ];

  const flags = ["--permission", netFlag, `--allow-env=${env.join(",")}`];
  flags.push("--allow-child-process");
  return flags;
}

/**
 * Write a diagnostic to stderr synchronously, so a following process.exit
 * cannot truncate it.
 *
 * Not a bare writeSync: that call can short-write (it returns a byte count) and
 * on macOS it can throw EAGAIN, because Node makes a piped stderr non-blocking
 * there rather than blocking the write. Loop over the remaining bytes, and if
 * stderr turns out to be unusable give up quietly -- failing to print a
 * diagnostic is not worth crashing a stdio server over.
 */
async function errSync(message) {
  const { writeSync } = await import("node:fs");
  const buf = Buffer.from(message);
  let off = 0;
  for (let attempts = 0; off < buf.length && attempts < 1000; attempts++) {
    try {
      off += writeSync(2, buf, off, buf.length - off);
    } catch (err) {
      if (err?.code !== "EAGAIN") return;
      // Pipe is full and the reader has not drained yet -- retry.
    }
  }
}

/**
 * An oam-named .cmd/.bat on PATH: a real install in a shape this launcher
 * cannot spawn. Reported rather than ignored, because "no oam binary was found"
 * reads as "install oam" -- the one thing that will not help. Windows only;
 * there is no such shim concept on POSIX.
 */
function findOamShim() {
  if (!isWin) return null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of [".cmd", ".bat"]) {
      const candidate = join(dir, `oam${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** A Node binary on PATH, or null. Stat-only; used only when THIS process is oam. */
function findNodeOnPath() {
  const name = isWin ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Why a candidate was passed over, for stderr. "Too old" and "could not be run"
 * stay distinct: a binary that is not executable, is the wrong arch, or printed
 * no parseable version is not outdated, and `oam self-update` will not fix it.
 */
function unusableReason(path, version, label = path) {
  const min = OAM_MIN.join(".");
  return version
    ? `${label} is oam ${version.join(".")}, older than ${min}`
    : `${label} could not be run, or did not report a version this launcher understands`;
}

/**
 * Choose the oam to spawn: a usable OAM_BIN, else the newest usable discovered
 * binary. Returns the choice (or null) plus stderr notes: `overrideNote` about
 * an unusable OAM_BIN, and `skipped` describing what was found and rejected
 * when nothing was usable.
 */
function chooseOam() {
  const override = process.env.OAM_BIN;
  let overrideNote = null;
  if (override) {
    if (!existsSync(override)) {
      overrideNote = `OAM_BIN=${override} does not exist`;
    } else {
      const version = oamVersion(override);
      if (atLeast(version, OAM_MIN)) return { chosen: { path: override, version }, overrideNote, skipped: [] };
      overrideNote = unusableReason(override, version, `OAM_BIN=${override}`);
    }
  }
  const overrideKey = override ? pathKey(override) : null;
  const candidates = discoverOamPaths()
    .filter((path) => pathKey(path) !== overrideKey)
    .map((path) => ({ path, version: oamVersion(path) }));
  const chosen = pickNewest(candidates);
  const skipped = chosen ? [] : candidates.map((c) => unusableReason(c.path, c.version));
  return { chosen, overrideNote, skipped };
}

/** Run the server in THIS process. The zero-overhead fallback. */
async function runInProcess() {
  // A server may gate its bootstrap on being the process ENTRY POINT --
  // `import.meta.url === pathToFileURL(process.argv[1]).href` -- so that its own
  // test file can import the module for unit tests without connecting a stdio
  // transport. aws-mcp does exactly this. Importing the server here would leave
  // argv[1] pointing at THIS launcher, the guard would read false, and the
  // server would load but never serve: the MCP handshake just hangs.
  //
  // Point argv[1] at the server first, so the in-process path is
  // indistinguishable from having executed the file directly. The spawn path
  // needs no equivalent -- there argv[1] is already the server.
  process.argv[1] = SERVER_ENTRY;
  await import(SERVER_URL.href);
}

// ONE reporter for every failed in-process fallback. runInProcess() is a bare
// import() that rejects when dist/index.js is missing, and at ESM top level an
// unhandled rejection is an uncaught exception -- replacing this launcher's
// diagnostic with a raw stack trace.
const fallbackFailed = (e) => {
  process.stderr.write(`tailscale-mcp: fallback to Node failed (${e?.message ?? e})\n`);
  process.exitCode = 1;
};

/**
 * Spawn the server in a child runtime and mirror its lifetime.
 *
 * `onLaunchFailed(err)` runs when the child could not be started at all; it is
 * never called once the child is running, which would double-start the server
 * on the same stdio.
 */
async function launchChild(cmd, args, onLaunchFailed) {
  // Every handoff from an oam host pipes; see ALREADY RUNNING ON OAM. That is a
  // host below the floor, one at the floor spawning a fresh oam for the
  // sandbox, or any oam under TAILSCALE_MCP_RUNTIME=node.
  const piped = process.versions.oam !== undefined;
  let child = null;
  try {
    child = spawn(cmd, args, {
      // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
      // stdin/stdout is untouched and the host's stdin-close still reaches the
      // server's shutdown path. Piping preserves both as well: bytes are copied
      // unchanged, and stdin's end propagates to the child.
      stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    // spawn() THROWS for some failures instead of emitting 'error', and the
    // 'error' listener is registered AFTER this call, so it can never observe
    // one -- an uncaught throw here kills the launcher with a raw stack trace
    // instead of falling back.
    await onLaunchFailed(err).catch(fallbackFailed);
    return;
  }

  if (piped) {
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    // A child that exits before reading everything closes its stdin; the
    // resulting EPIPE is not worth crashing over.
    child.stdin.on("error", () => {});
  }

  // If the runtime cannot be executed at all (deleted between the stat and the
  // spawn, wrong arch, permission), fall back rather than failing the whole
  // server. `spawned` prevents falling back AFTER the child started.
  let spawned = false;
  child.on("spawn", () => {
    spawned = true;
  });
  child.on("error", (err) => {
    if (spawned) return;
    // Handle the rejection instead of discarding it: a failing in-process
    // fallback would otherwise escape as an unhandled rejection, replacing
    // this launcher's diagnostic with a raw stack trace.
    onLaunchFailed(err).catch(fallbackFailed);
  });

  // Forward termination so the server's own shutdown path runs in the child
  // rather than the child being orphaned.
  //
  // Registering ANY handler for these suppresses Node's default
  // terminate-on-signal, so the parent's exit has to be arranged explicitly.
  // `child.killed` only records that kill() was CALLED, never that the child
  // is gone, so gating on it swallows every signal after the first and wedges
  // the launcher with no escape hatch.
  //
  // Escalation is driven by a TIMER, not by counting signals. Counting is
  // ambiguous: a supervisor routinely sends SIGINT then SIGTERM milliseconds
  // apart, and a terminal Ctrl-C reaches the whole process group, so reading
  // "a second signal" as impatience hard-kills a child that is already
  // shutting down cleanly. A timer makes the count irrelevant -- ONE press is
  // enough, and a wedged child dies on schedule. setTimeout is monotonic, so
  // a wall-clock step cannot mis-gate the window either.
  //
  // POSIX vs Windows, and why we do NOT forward on Windows.
  // On POSIX child.kill(sig) delivers a real, catchable signal, so forwarding
  // is what lets the child run its shutdown. On Windows there are no POSIX
  // signals: child.kill IGNORES the name and calls TerminateProcess -- an
  // immediate hard kill (verified: a child with a SIGTERM handler never runs
  // it and dies with code=null, signal=SIGTERM). Forwarding there ABORTS the
  // graceful shutdown the console's own Ctrl-C just started, skipping the
  // child's process.on("exit") cleanup. The console has already notified the
  // child, so on Windows the timer below is the only kill we issue.
  const ESCALATE_AFTER_MS = 2000;
  let escalation = null;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      // No try/catch: kill() on an already-exited child returns false, it does
      // not throw. It throws only for a signal the platform does not know,
      // which SIGINT/SIGTERM/SIGKILL never are.
      if (!isWin) child.kill(sig);
      if (escalation) return; // already counting down; further signals are noise
      escalation = setTimeout(() => {
        // Still here after its grace window. Stop waiting on it.
        child.kill("SIGKILL");
        process.exit(128 + (constants.signals[sig] ?? 15));
      }, ESCALATE_AFTER_MS);
    });
  }

  // Piped: wait for 'close', so the child's last stdout bytes are copied out
  // before this process exits. Inherited: 'exit' is enough, the fds were never
  // ours to drain.
  child.on(piped ? "close" : "exit", (code, signal) => {
    if (escalation) clearTimeout(escalation);
    // Mirror the child's fate: a signal death becomes 128+n so callers see a
    // conventional shell exit status rather than a bare 0.
    if (signal) {
      process.exit(128 + (constants.signals[signal] ?? 15));
    }
    process.exit(code ?? 0);
  });
}

/**
 * Hand the server to Node on PATH. Only reachable when THIS process is oam --
 * one below the floor, or any oam under TAILSCALE_MCP_RUNTIME=node -- so there
 * is no in-process option left. An empty `reason` prints no note: the host is a
 * supported oam and TAILSCALE_MCP_RUNTIME=node asked for Node, which is not news.
 */
async function handOffToNode(reason) {
  const node = findNodeOnPath();
  if (!node) {
    const remedy =
      mode === "node"
        ? "Put Node on PATH, or launch this command with node.\n"
        : `Run \`oam self-update\` to get oam ${OAM_MIN.join(".")} or newer, or launch this command with node.\n`;
    await errSync(
      `tailscale-mcp: ${reason || `TAILSCALE_MCP_RUNTIME=node on oam ${process.versions.oam}`}, and no Node was found on PATH to run the server.\n${remedy}`,
    );
    process.exit(1);
  }
  if (reason) await errSync(`tailscale-mcp: ${reason}; running on ${node} instead.\n`);
  await launchChild(node, [SERVER_ENTRY, ...process.argv.slice(2)], async (err) => {
    await errSync(`tailscale-mcp: failed to launch Node at ${node} (${err?.message ?? err})\n`);
    process.exit(1);
  });
}

/** What a fallback serves on, for stderr. */
function fallbackTarget(hostOam) {
  return hostOam !== undefined && fallbackInProcess(hostOam) ? `this oam ${hostOam} process` : "Node";
}

/** No usable oam, or it would not start, under a mode that allows a fallback. */
async function fallBack(hostOam, why) {
  if (fallbackInProcess(hostOam)) {
    await runInProcess();
    return;
  }
  await handOffToNode(`this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}, and ${why}`);
}

// Every value below is compared against `mode` after lowercasing, so an
// unrecognized one matched nothing and fell through to the auto branch --
// `TAILSCALE_MCP_RUNTIME=nod` silently PREFERRED oam on a box that has it,
// which is the opposite of what was asked for. Same handling as index.ts gives
// an unknown subcommand: auto is still the right landing place, it just stops
// being silent. An empty value is treated as unset, since `FOO=$UNSET` in a
// wrapper script is how it usually gets there.
const RUNTIMES = ["auto", "node", "oam"];
const requested = process.env.TAILSCALE_MCP_RUNTIME;
const mode = (requested ?? "auto").toLowerCase();
if (requested && !RUNTIMES.includes(mode)) {
  // Echo what was SET, not the lowercased form, so the typo is recognisable in
  // the host's log next to the config line that produced it.
  await errSync(
    `tailscale-mcp: unrecognized TAILSCALE_MCP_RUNTIME "${requested}" -- known values: ${RUNTIMES.join(", ")}. Using auto.\n`,
  );
}

const hostOam = process.versions.oam;

// The sandbox is read off the grant list rather than TAILSCALE_MCP_SANDBOX, so
// "would the spawn carry --permission" cannot drift from what the spawn below
// actually passes.
const sandbox = sandboxFlags();
const plan = runtimePlan({ mode, hostOam, sandbox: sandbox.length > 0 });

if (plan === "in-process") {
  await runInProcess();
} else if (plan === "handoff-node") {
  const belowFloor = !atLeast(parseVersion(hostOam), OAM_MIN);
  await handOffToNode(belowFloor ? `this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}` : "");
} else {
  const { chosen, overrideNote, skipped } = chooseOam();

  if (chosen) {
    if (overrideNote) {
      await errSync(`tailscale-mcp: ${overrideNote}; using ${chosen.path} (oam ${chosen.version.join(".")}).\n`);
    }
    // The sandbox flags go BEFORE `run` (see sandboxFlags), and `--` separates
    // oam's own flags from the script's argv, so `tailscale-mcp --version` and
    // any host-supplied flags survive the hop unchanged.
    await launchChild(chosen.path, [...sandbox, "run", SERVER_ENTRY, "--", ...process.argv.slice(2)], async (err) => {
      if (mode === "oam") {
        await errSync(`tailscale-mcp: failed to launch oam at ${chosen.path} (${err?.message ?? err})\n`);
        process.exit(1);
      }
      await errSync(
        `tailscale-mcp: failed to launch oam at ${chosen.path} (${err?.message ?? err}); using ${fallbackTarget(hostOam)} instead.\n`,
      );
      await fallBack(hostOam, "the newer oam would not start");
    });
  } else {
    const shim = findOamShim();
    const notes = [
      ...(overrideNote ? [overrideNote] : []),
      ...skipped,
      ...(shim
        ? [
            `found ${shim}, but Node cannot execute a .cmd/.bat directly -- install the native oam binary, or point OAM_BIN at one`,
          ]
        : []),
    ];
    if (mode === "oam") {
      await errSync(
        `tailscale-mcp: TAILSCALE_MCP_RUNTIME=oam but no usable oam (${OAM_MIN.join(".")} or newer) was found.\n` +
          notes.map((note) => `  ${note}\n`).join("") +
          "Install or update from https://oamjs.org, set OAM_BIN=/path/to/oam, or use TAILSCALE_MCP_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    // auto: falling back is correct, but silence is how someone never learns
    // their OAM_BIN is wrong or their oam is too old to use.
    if (notes.length > 0) {
      await errSync(`tailscale-mcp: ${notes.join("; ")}; using ${fallbackTarget(hostOam)} instead.\n`);
    }
    await fallBack(hostOam, "no newer oam was found").catch(fallbackFailed);
  }
}
