#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/tailscale-mcp.
 *
 * Prefers the oam runtime (https://oamjs.org) and falls back to the Node
 * process already running this file.
 *
 *
 * WHY THE FALLBACK COSTS NOTHING
 * npm has already started Node to run this launcher, so falling back is a
 * plain `import()` of the server into THIS process: no extra spawn, no extra
 * startup, byte-identical to invoking dist/index.js directly. Discovery is
 * stat-only -- never a subprocess -- so the miss case stays sub-millisecond.
 *
 * WHAT THE OAM PATH COSTS
 * Reaching oam through an npm `bin` means Node boots first and oam boots
 * second, so the launcher is slower than either runtime alone. Measured on
 * npmjs-mcp (windows-arm64, n=12 medians, spawn to first MCP initialize):
 * oam 116ms, node 172ms, launcher 243ms. oam is the fastest runtime and the
 * launcher is the slowest path -- it exists for `npx` convenience.
 *
 * For an MCP host config, point straight at oam and skip this file:
 *   { "command": "oam", "args": ["run", "<abs>/dist/index.js"] }
 *
 * THE `--permission` SANDBOX (oam 0.9.0+, opt-in)
 * `TAILSCALE_MCP_SANDBOX=1` runs the server under oam's permission model:
 * network limited to the control-plane hosts, filesystem denied.
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
 * 0.9.0. Below it `child_process.execFile` ran its arguments through a SHELL,
 * `exec` accepted `timeout` and ignored it, `spawnSync` truncated at
 * `maxBuffer` while reporting success, and `stdio: 'inherit'`/`'ignore'` both
 * behaved as `'pipe'`. This server shells out to a CLI on its
 * main paths, so those were reachable bugs rather than theoretical ones: an
 * argument containing shell metacharacters was re-split and executed.
 * An older oam is not an error: the launcher falls back to Node and says so on
 * stderr. Pinning the floor here is what makes that fallback automatic.
 *
 * SELECTION
 *   TAILSCALE_MCP_RUNTIME=oam    require oam; fail loudly if it is missing
 *   TAILSCALE_MCP_RUNTIME=node   never use oam
 *   TAILSCALE_MCP_RUNTIME=auto   prefer oam, silently fall back (default)
 *   TAILSCALE_MCP_SANDBOX=1      run oam under --permission (oam 0.9.0+)
 *   OAM_BIN=/path/to/oam     explicit binary, checked before any discovery
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Oldest oam whose `child_process` matches Node. See MINIMUM OAM VERSION above. */
const OAM_MIN = [0, 9, 0];

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn() needs a real path.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/** Locate an oam binary, or null. Every branch is a stat, never a subprocess. */
function findOam() {
  // 1. Explicit override wins and is never second-guessed.
  const override = process.env.OAM_BIN;
  if (override) return existsSync(override) ? override : null;

  // 2. Installed locations, BEFORE PATH. Someone who develops oam itself
  //    usually has oam/target/release on PATH, and a build directory is the
  //    wrong thing for a user-facing launcher to bind to: cargo replaces the
  //    binary underneath running processes, and the dev build is not the
  //    release the user installed. Preferring the installed copy makes the
  //    default path "what a normal user has", and OAM_BIN remains the way to
  //    point deliberately at a dev build.
  //
  //    Both forms are checked on Windows: the installer defaults to
  //    %LOCALAPPDATA%oamin there, but oam's docs name ~/.oam/bin first and
  //    OAM_INSTALL_DIR can pick either, so checking one silently misses a real
  //    install.
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (isWin) {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  for (const candidate of installed) {
    if (existsSync(candidate)) return candidate;
  }

  // 3. PATH, resolved manually rather than by spawning `which`/`where`, which
  //    would cost a subprocess on every launch just to decide whether to spawn.
  const pathExt = isWin ? (process.env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of isWin ? pathExt : [""]) {
      const candidate = join(dir, isWin ? `oam${ext.toLowerCase()}` : "oam");
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * `oam --version` -> [major, minor, patch], or null when it cannot be read.
 * A pre-release suffix (0.9.0-rc.1) truncates to its base version.
 */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    // Not executable, wrong arch, or deleted since the stat. Caller degrades.
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

  const hosts = ["api.tailscale.com","login.tailscale.com"];

  const netFlag = `--allow-net=${hosts.join(",")}`;

  // Keep alphabetised and in sync with every env var the bundle reads -- a
  // missing entry is ABSENT from process.env rather than an error, so the
  // symptom is silent misbehaviour. TAILSCALE_LOCAL_CLI was missing here, which
  // meant the local-CLI tool group silently failed to register under the
  // sandbox even though --allow-child-process is granted below precisely so
  // those tools can shell out.
  const env = ["PATH","TAILSCALE_API_KEY","TAILSCALE_BINARY","TAILSCALE_DEBUG","TAILSCALE_EXTRA_POSTURE_PROVIDERS","TAILSCALE_EXTRA_WEBHOOK_EVENTS","TAILSCALE_LOCAL_CLI","TAILSCALE_MAX_CONCURRENT","TAILSCALE_OAUTH_CLIENT_ID","TAILSCALE_OAUTH_CLIENT_SECRET","TAILSCALE_OAUTH_TAILNET","TAILSCALE_PROFILE","TAILSCALE_READONLY","TAILSCALE_REQUEST_BUDGET_MS","TAILSCALE_RETRY_BASE_DELAY_MS","TAILSCALE_TAILNET","TAILSCALE_TOOLS"];

  const flags = ["--permission", netFlag, `--allow-env=${env.join(",")}`];
  flags.push("--allow-child-process");
  return flags;
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

const mode = (process.env.TAILSCALE_MCP_RUNTIME ?? "auto").toLowerCase();

if (mode === "node") {
  await runInProcess();
} else {
  const oam = findOam();

  if (!oam) {
    if (mode === "oam") {
      // Explicitly demanded, so this is a real misconfiguration. writeSync
      // because stderr is async for TTYs/pipes on Windows and process.exit
      // truncates pending writes.
      const { writeSync } = await import("node:fs");
      writeSync(
        2,
        "tailscale-mcp: TAILSCALE_MCP_RUNTIME=oam but no oam binary was found.\n" +
          "Install from https://oamjs.org, set OAM_BIN=/path/to/oam, or use TAILSCALE_MCP_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    await runInProcess();
  } else if (!atLeast(oamVersion(oam), OAM_MIN)) {
    // Discovery itself stays stat-only; this is the first subprocess, and it
    // runs only once we have already decided to spawn oam anyway. Measured 26ms
    // median (n=12, windows-arm64), paid once per MCP session.
    const min = OAM_MIN.join(".");
    if (mode === "oam") {
      const { writeSync } = await import("node:fs");
      writeSync(
        2,
        `tailscale-mcp: TAILSCALE_MCP_RUNTIME=oam but ${oam} is older than oam ${min}.\n` +
          `Run \`oam self-update\`, or use TAILSCALE_MCP_RUNTIME=node.\n`,
      );
      process.exit(1);
    }
    // auto: an old oam is a reason to prefer Node, not to fail. Say so, because
    // a silent downgrade is how someone keeps running an oam they meant to
    // update. stderr is safe -- MCP frames travel on stdout.
    process.stderr.write(`tailscale-mcp: oam at ${oam} is older than ${min}; using Node instead.\n`);
    await runInProcess();
  } else {
    // `--` separates oam's own flags from the script's argv, so `tailscale-mcp
    // --version` and any host-supplied flags survive the hop unchanged.
    const child = spawn(oam, [...sandboxFlags(), "run", SERVER_ENTRY, "--", ...process.argv.slice(2)], {
      // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
      // stdin/stdout is untouched and the host's stdin-close still reaches the
      // server's shutdown path.
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });

    // If oam cannot be executed at all (deleted between the stat and the spawn,
    // wrong arch, permission), fall back rather than failing the whole server.
    // `spawned` prevents falling back AFTER the child started, which would
    // double-start the server on the same stdio.
    let spawned = false;
    child.on("spawn", () => {
      spawned = true;
    });
    child.on("error", (err) => {
      if (spawned) return;
      if (mode === "oam") {
        process.stderr.write(`tailscale-mcp: failed to launch oam (${err.message})\n`);
        process.exit(1);
      }
      void runInProcess();
    });

    // Forward termination so the server's own shutdown path runs in the child
    // rather than the child being orphaned. No-op on Windows, harmless to add.
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        if (!child.killed) child.kill(sig);
      });
    }

    child.on("exit", (code, signal) => {
      // Mirror the child's fate: a signal death becomes 128+n so callers see a
      // conventional shell exit status rather than a bare 0.
      if (signal) {
        process.exit(128 + (constants.signals[signal] ?? 15));
      }
      process.exit(code ?? 0);
    });
  }
}
