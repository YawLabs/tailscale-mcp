/**
 * Local tailscale CLI runner: the execFile boundary, spawn concurrency and
 * failure classification for the tool definitions in tools/local-cli.ts.
 * Opt-in via TAILSCALE_LOCAL_CLI=1|true.
 *
 * Why this exists separately from api.ts: api.ts speaks to the v2 REST API
 * (admin/tailnet operations). This file shells out to the local `tailscale`
 * binary for operations that report THIS MACHINE'S view of the tailnet --
 * its own connection state, DERP latency to other peers, NAT diagnostics.
 *
 * Scope is deliberately narrow: read-only diagnostics that don't require
 * root. We don't expose `tailscale up/down/set/lock` -- those need elevation
 * and have non-trivial argument-injection surface if driven by an LLM.
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Where a default install puts the CLI when PATH does not have it.
 *
 * macOS is the case that needs this: the standard install keeps the binary
 * inside the app bundle and adds nothing to PATH, and even a Homebrew install
 * is invisible to an MCP client launched from the Dock or Spotlight, which
 * inherits a minimal PATH rather than the shell's. Linux is here for the snap,
 * whose wrapper lives outside some minimal PATHs.
 *
 * `tailscale.exe` is deliberately absent from the Linux list. In WSL it is
 * usually the only tailscale anything can see, it cannot be exec'd by a Linux
 * process anyway (execvp does no suffix search), and it answers for the
 * WINDOWS host's tailnet -- while every tool in this group says "this
 * machine's". Falling through to it silently would be the wrong answer
 * delivered confidently.
 *
 * Windows is not listed: the installer puts tailscale.exe on the machine PATH,
 * which a GUI-launched client inherits.
 */
const DARWIN_CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
];
const LINUX_CANDIDATES = ["/usr/bin/tailscale", "/snap/bin/tailscale"];
// The bare name resolveBinary falls back to, which is the only spelling PATH
// ever resolves.
const PATH_BINARY = "tailscale";

// execFile is captured at module load so tests can swap it. Mirrors the
// __resetOAuthTokenCacheForTests pattern in api.ts.
type ExecFileCb = typeof execFileCb;
let execFileImpl: ExecFileCb = execFileCb;

/**
 * What to say when the spawn came back EACCES: the path exists but cannot be
 * executed. On Linux and macOS that is where a TAILSCALE_BINARY pointing at a
 * DIRECTORY lands (execve(2) refuses anything that is not a regular file with
 * EACCES), as well as a file missing its execute bit. Windows reports a
 * directory as ENOENT instead, which describeMissingBinary covers.
 *
 * Only the bare name was resolved by PATH. An absolute path that did not come
 * from TAILSCALE_BINARY came from the default-install-path list, which is
 * checked BEFORE PATH -- saying "found in PATH" there would send the operator
 * to fix a PATH that was never consulted.
 */
function describeUnexecutableBinary(binary: string, fromEnv: boolean): string {
  const where = fromEnv
    ? `'${binary}', which is where TAILSCALE_BINARY points`
    : binary === PATH_BINARY
      ? `'${binary}', found in PATH`
      : `'${binary}', a default install path (checked before PATH)`;
  return (
    `Found the 'tailscale' binary at ${where}, but it could not be executed (EACCES). ` +
    `It must be an executable file -- not a directory -- with execute permission for the user running this server. ` +
    `Set TAILSCALE_BINARY to the absolute path of the tailscale executable, or reinstall Tailscale (https://tailscale.com/download).`
  );
}

/**
 * @internal Not part of the public API. Tests use this to inject a fake
 * execFile so the spawn-handling code can run without a real `tailscale`
 * binary present on the test host.
 */
export function __setExecFileForTests(fn: ExecFileCb | null): void {
  execFileImpl = fn ?? execFileCb;
}

/** The candidates to stat for `platform`, in order. Empty when there are none. */
function binaryCandidates(platform: string): string[] {
  if (platform === "darwin") return DARWIN_CANDIDATES;
  if (platform === "linux") return LINUX_CANDIDATES;
  return [];
}

/**
 * The binary to spawn: the operator's override, else the first install path
 * that exists, else the bare name for PATH to resolve.
 *
 * One `stat` per candidate and never a subprocess, so the cost is a few
 * microseconds on a call that is about to spawn a process anyway.
 *
 * The install paths are checked BEFORE PATH, not after: when one of them
 * exists it wins over a different tailscale that is first on PATH (a
 * ~/.local/bin or nix build on Linux, a Homebrew CLI next to the macOS app
 * bundle). The bare name is the last resort, so PATH decides only when none
 * of the install paths exists -- which is every Windows machine, and any
 * install that lives somewhere else. TAILSCALE_BINARY is how to pick a
 * specific copy.
 */
function resolveBinary(platform: string = process.platform, exists: (path: string) => boolean = existsSync): string {
  const override = process.env.TAILSCALE_BINARY;
  if (override) return override;
  for (const candidate of binaryCandidates(platform)) {
    if (exists(candidate)) return candidate;
  }
  return PATH_BINARY;
}

/** True when this Linux is running under WSL. Cheap, and only read on ENOENT. */
function looksLikeWsl(platform: string, procVersion: () => string = readProcVersion): boolean {
  if (platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return /microsoft/i.test(procVersion());
}

function readProcVersion(): string {
  try {
    return readFileSync("/proc/version", "utf-8");
  } catch {
    // Not Linux, or an unreadable /proc. Absence is not evidence of WSL.
    return "";
  }
}

/**
 * What to say when the spawn came back ENOENT.
 *
 * Every branch opens with the same clause and names TAILSCALE_BINARY, and
 * every PATH-lookup branch also names the download page, because that is the
 * shape the caller's client renders and the three facts an operator needs (the
 * TAILSCALE_BINARY branch omits the download page: a bad path is not an
 * install problem). What changes per branch is the DIAGNOSIS:
 * the old single message blamed PATH even when TAILSCALE_BINARY had been set
 * and PATH was therefore never consulted, recommended as a remedy the exact
 * thing the operator had already done, and never echoed the value that failed.
 */
function describeMissingBinary(binary: string, fromEnv: boolean, platform: string, wsl: boolean): string {
  if (fromEnv) {
    const pathNote =
      platform === "win32"
        ? `On Windows the value must be a Windows path (C:/Program Files/Tailscale/tailscale.exe), not an MSYS one (/c/...) -- ` +
          `Git Bash rewrites /c/... when you type it at the prompt, but a value read from an MCP client's JSON config or a .env file arrives untranslated. ` +
          `It must also name tailscale.exe itself, not the folder it is in.`
        : `It must be the absolute path of an executable file, not a shell alias or function.`;
    return (
      `Could not find the 'tailscale' binary at '${binary}', which is where TAILSCALE_BINARY points. ` +
      `PATH was never consulted, so nothing here is a PATH problem. ${pathNote}`
    );
  }
  if (platform === "darwin") {
    return (
      `Could not find the 'tailscale' binary in PATH, or at ${DARWIN_CANDIDATES.join(", ")}. ` +
      `A default macOS install keeps the CLI inside the app bundle and puts nothing on PATH, and an MCP client ` +
      `launched from the Dock or Spotlight sees a minimal PATH rather than your shell's. ` +
      `Install Tailscale (https://tailscale.com/download) or set TAILSCALE_BINARY to its absolute path, ` +
      `usually /Applications/Tailscale.app/Contents/MacOS/Tailscale.`
    );
  }
  if (wsl) {
    return (
      `Could not find the 'tailscale' binary in PATH, or at ${LINUX_CANDIDATES.join(", ")}. ` +
      `This looks like WSL, where the only tailscale in reach is usually the Windows one: a Linux process cannot ` +
      `exec tailscale.exe, and pointing TAILSCALE_BINARY at it would report the WINDOWS host's tailnet rather than ` +
      `this machine's, which is what these tools describe. ` +
      `Install Tailscale inside the distro (https://tailscale.com/download/linux) and run tailscaled there.`
    );
  }
  return (
    `Could not find the 'tailscale' binary in PATH. ` +
    `Install Tailscale (https://tailscale.com/download) or set TAILSCALE_BINARY to its absolute path.`
  );
}

/**
 * What to say when execFile THREW instead of calling back. Node validates some
 * things synchronously, before any process exists: on Windows a .cmd or .bat
 * file is refused with EINVAL unless a shell is involved (which this runner
 * never uses), and a NUL byte in an argument is ERR_INVALID_ARG_VALUE on every
 * platform. The bare "spawn EINVAL" names neither the file nor the cause.
 */
function describeSpawnThrow(err: unknown, binary: string, fromEnv: boolean, platform: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (platform === "win32" && (err as NodeJS.ErrnoException | null)?.code === "EINVAL") {
    const where = fromEnv ? `'${binary}', which is where TAILSCALE_BINARY points` : `'${binary}'`;
    return (
      `Could not start the 'tailscale' binary at ${where} (EINVAL). ` +
      `Windows refuses to run a .cmd or .bat file without a shell, and this server never uses one. ` +
      `TAILSCALE_BINARY must name tailscale.exe itself (C:/Program Files/Tailscale/tailscale.exe), not a .cmd/.bat wrapper around it.`
    );
  }
  return `Could not start '${binary}': ${message}`;
}

/**
 * @internal Not part of the public API. Exposed so the tests can drive the
 * platform-dependent halves -- candidate discovery and the ENOENT diagnosis --
 * on every supported platform from whichever one the suite happens to run on.
 */
export const __localCliInternals = {
  resolveBinary,
  describeMissingBinary,
  describeUnexecutableBinary,
  describeSpawnThrow,
  looksLikeWsl,
  binaryCandidates,
};

export interface CliResult<T = unknown> {
  ok: boolean;
  data?: T;
  rawBody?: string;
  error?: string;
  // Machine-readable class for the two failure shapes callers branch on.
  // Callers used to substring-match the error text, which silently stopped
  // matching if a message here was reworded. Absent on every other failure.
  kind?: "output-limit" | "timeout";
  // exitCode is the binary's exit code when one was produced. Absent on
  // ENOENT (binary not found) and on timeout (we killed it).
  exitCode?: number;
}

export interface RunOptions {
  /** Parse stdout as JSON and surface it as `data` on success. */
  parseJson?: boolean;
  /** Per-invocation timeout in ms. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Cap on concurrent `tailscale` spawns, mirroring api.ts's
 * TAILSCALE_MAX_CONCURRENT semaphore for the REST side: an agent that fans out
 * across the local-CLI tools would otherwise spawn one process per call with no
 * bound at all, and the CLI's own rate limits (netcheck, ping) are per-machine.
 *
 * A fixed cap rather than an env-tunable one: this file reads no other knob,
 * and wiring one here would double the surface the sandbox allow-list has to
 * track (see bin/tailscale-mcp.mjs's `const env = [...]`) for a policy that is
 * about process fan-out, not operator tuning. Change the constant to change it.
 *
 * Slot hand-off, not decrement-then-increment: the releasing caller hands its
 * slot to the queued waiter directly, so the counter never dips in the gap
 * between "one spawn finished" and "the waiter resumes" -- a fresh arrival in
 * that microtask window would otherwise take the slot too and push real
 * concurrency past the cap. Same shape as api.ts's withConcurrencyLimit.
 */
const MAX_CLI_CONCURRENCY = 4;
let cliInFlight = 0;
const cliQueue: Array<() => void> = [];

/** Wait for a spawn slot. FIFO, so a burst cannot starve an early caller. */
async function acquireCliSlot(): Promise<void> {
  if (cliInFlight < MAX_CLI_CONCURRENCY) {
    cliInFlight++;
    return;
  }
  await new Promise<void>((resolve) => cliQueue.push(resolve));
}

/** Release the slot, handing it to the longest-waiting caller if there is one. */
function releaseCliSlot(): void {
  const next = cliQueue.shift();
  if (next)
    next(); // slot passes straight to the waiter; cliInFlight is unchanged
  else cliInFlight--;
}

/**
 * Run the local `tailscale` binary with the given args. Resolves with a
 * CliResult; never rejects. Designed to drop into the same wrapToolHandler
 * machinery api.ts uses, so the MCP error envelope shape stays consistent.
 *
 * Arguments are passed as an array (never via a shell), so callers don't
 * need to escape -- but tool inputs should still validate before reaching
 * here as a defense-in-depth measure.
 */
export async function runTailscaleCli<T = unknown>(args: string[], options: RunOptions = {}): Promise<CliResult<T>> {
  const binary = resolveBinary();
  const fromEnv = Boolean(process.env.TAILSCALE_BINARY);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Held for the WHOLE call -- spawn through callback -- so the cap counts
  // executions, not just launches, and the timeout budget is not eaten by queue
  // wait: the execFile timeout starts ticking only once the slot is granted.
  // The queue is awaited outside the promise below on purpose: resolving (never
  // rejecting) has to be the only outcome the caller can observe, and every
  // early `return resolve(...)` inside has to release the slot first, so release
  // happens in one place -- the callback -- rather than per branch. The one
  // other place is the catch below, for the call that never reaches a callback.
  await acquireCliSlot();

  return new Promise((resolve) => {
    // windowsHide: a server launched from a GUI client (no console of its own)
    // would otherwise flash a console window for every CLI call on Windows. The
    // launcher sets it on its spawns for the same reason.
    const execOptions = { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true };
    const onExit = (err: Error | null, stdout: unknown, stderr: unknown): void => {
      releaseCliSlot();
      // String-coerce defensively: execFile with the default 'utf8' encoding
      // returns strings, but a future env-level encoding override or a test
      // injecting Buffer could surprise us. String(null) is "null" which
      // would be misleading, so guard the nullish case first.
      const stdoutStr: string = stdout == null ? "" : String(stdout);
      const stderrStr: string = stderr == null ? "" : String(stderr);

      if (err) {
        const errno = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        if (errno.code === "ENOENT") {
          resolve({
            ok: false,
            error: describeMissingBinary(binary, fromEnv, process.platform, looksLikeWsl(process.platform)),
          });
          return;
        }
        if (errno.code === "EACCES") {
          resolve({ ok: false, error: describeUnexecutableBinary(binary, fromEnv) });
          return;
        }
        // Exceeding maxBuffer is its own failure mode and deserves its own
        // message. Verified against Node 22: the overflow rejects with a
        // RangeError carrying code ERR_CHILD_PROCESS_STDIO_MAXBUFFER, and --
        // unlike the timeout kill below -- `killed` and `signal` are BOTH
        // undefined. So this does not race the `killed` branch; position here
        // is for readability, not correctness.
        //
        // Without this arm the overflow fell through to the generic non-zero
        // arm and surfaced Node's bare "stdout maxBuffer length exceeded",
        // which names neither the command, nor the limit, nor what to do next.
        if (errno.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({
            ok: false,
            kind: "output-limit",
            error:
              `'${binary} ${args.join(" ")}' exceeded the ${MAX_BUFFER_BYTES / 1024 / 1024} MB output limit and was aborted -- no output was captured. ` +
              `This usually means a very large tailnet; narrow the query if the command supports it.`,
          });
          return;
        }
        // execFile sets `killed: true` when the timeout fires (it sends
        // SIGTERM after `timeout` ms). Surface that specifically so the
        // caller can distinguish "binary said no" from "we cut it off".
        if (errno.killed) {
          resolve({
            ok: false,
            kind: "timeout",
            error: `'${binary} ${args.join(" ")}' timed out after ${timeoutMs}ms`,
          });
          return;
        }
        // Non-zero exit. err.code is the exit code when it's a number;
        // stderr trimmed is the friendliest message; fall back to err.message.
        const exitCode = typeof errno.code === "number" ? errno.code : undefined;
        resolve({
          ok: false,
          error: stderrStr.trim() || err.message,
          exitCode,
        });
        return;
      }

      if (options.parseJson) {
        try {
          const data = JSON.parse(stdoutStr) as T;
          resolve({ ok: true, data, exitCode: 0 });
        } catch (parseErr) {
          resolve({
            ok: false,
            error: `Failed to parse JSON output from '${binary} ${args.join(" ")}': ${
              parseErr instanceof Error ? parseErr.message : String(parseErr)
            }`,
            rawBody: stdoutStr,
            exitCode: 0,
          });
        }
        return;
      }

      resolve({ ok: true, rawBody: stdoutStr, exitCode: 0 });
    };
    // execFile can throw before it spawns anything (see describeSpawnThrow), and
    // then the callback never runs. Left uncaught, that rejected a promise
    // documented as never rejecting and kept the slot for good: after
    // MAX_CLI_CONCURRENCY such calls every later one waited in acquireCliSlot
    // forever, with no timeout to end it because the timeout starts at spawn.
    try {
      execFileImpl(binary, args, execOptions, onExit);
    } catch (thrown) {
      releaseCliSlot();
      resolve({ ok: false, error: describeSpawnThrow(thrown, binary, fromEnv, process.platform) });
    }
  });
}
