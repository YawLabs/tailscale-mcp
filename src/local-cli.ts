/**
 * Local tailscale CLI integration. Opt-in via TAILSCALE_LOCAL_CLI=1|true.
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

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// execFile is captured at module load so tests can swap it. Mirrors the
// __resetOAuthTokenCacheForTests pattern in api.ts.
type ExecFileCb = typeof execFileCb;
let execFileImpl: ExecFileCb = execFileCb;

/**
 * @internal Not part of the public API. Tests use this to inject a fake
 * execFile so the spawn-handling code can run without a real `tailscale`
 * binary present on the test host.
 */
export function __setExecFileForTests(fn: ExecFileCb | null): void {
  execFileImpl = fn ?? execFileCb;
}

function getBinaryPath(): string {
  return process.env.TAILSCALE_BINARY || "tailscale";
}

export interface CliResult<T = unknown> {
  ok: boolean;
  data?: T;
  rawBody?: string;
  error?: string;
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
 * Run the local `tailscale` binary with the given args. Resolves with a
 * CliResult; never rejects. Designed to drop into the same wrapToolHandler
 * machinery api.ts uses, so the MCP error envelope shape stays consistent.
 *
 * Arguments are passed as an array (never via a shell), so callers don't
 * need to escape -- but tool inputs should still validate before reaching
 * here as a defense-in-depth measure.
 */
export async function runTailscaleCli<T = unknown>(args: string[], options: RunOptions = {}): Promise<CliResult<T>> {
  const binary = getBinaryPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    execFileImpl(binary, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES }, (err, stdout, stderr) => {
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
            error:
              `Could not find the 'tailscale' binary in PATH. ` +
              `Install Tailscale (https://tailscale.com/download) or set TAILSCALE_BINARY to its absolute path.`,
          });
          return;
        }
        // execFile sets `killed: true` when the timeout fires (it sends
        // SIGTERM after `timeout` ms). Surface that specifically so the
        // caller can distinguish "binary said no" from "we cut it off".
        if (errno.killed) {
          resolve({
            ok: false,
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
    });
  });
}
