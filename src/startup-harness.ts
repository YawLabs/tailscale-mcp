/**
 * Test support, not server code: spawns the built server and returns its
 * startup stderr. Shared by index.test.ts and fullpass-core.test.ts so both
 * get the same spawn, env whitelist, timeout and ASCII guard -- a second
 * hand-rolled copy had already dropped the ASCII check. Lives outside a
 * *.test.ts name so `node --test "dist/**\/*.test.js"` does not run it as a
 * suite of its own. Nothing imports it from index.ts, so the esbuild bundle
 * (the only dist file package.json ships) never contains it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The compiled harness sits in dist/ alongside the bundle it spawns. Resolving
// via import.meta.url (not process.cwd()) keeps this working under any runner.
export const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");

/**
 * Startup stderr is ephemeral terminal output, so every byte of it must be
 * ASCII. A UTF-8 write racing the Windows console codepage renders anything
 * else as mojibake, and the mangled bytes travel verbatim into bug reports --
 * the profile tip shipped an em-dash and did exactly that. Enforced on the
 * harness rather than at one call site so it covers every startup path the
 * spawns reach, including warning branches added later.
 */
export function assertAsciiStderr(stderr: string): void {
  const offender = [...stderr].find((ch) => (ch.codePointAt(0) ?? 0) > 0x7f);
  assert.equal(
    offender,
    undefined,
    `startup stderr must stay ASCII; found ${JSON.stringify(offender)} in ${JSON.stringify(stderr)}`,
  );
}

/**
 * Start the server with a curated env, close its stdin, and return everything
 * it wrote to stderr before shutting down.
 *
 * Closing stdin is what makes this deterministic. The stdio transport only
 * listens for stdin `data` and `error`; it installs no EOF handler, and the
 * server deliberately adds no stdin-close or signal handler either. So the
 * child exits on stdin EOF exactly when its event loop drains: a request in
 * flight is finished and answered first (pinned by the "shutdown on stdin EOF"
 * test in index.test.ts), and with none in flight, as here, nothing holds the
 * loop, so the child exits promptly and `close` fires once stderr has been
 * fully drained -- no polling for a banner substring, no settle timer racing
 * the tip line that follows it, no kill. An earlier version waited for
 * "ready (" then settled 120ms later and treated exit as a failure; the child
 * had always already exited by then, so every case failed while printing the
 * exact output it was asserting on.
 *
 * The env is built from a whitelist rather than `...process.env` so a
 * TAILSCALE_* var set by the developer's shell (or leaked by a sibling test)
 * cannot silently change what this asserts.
 */
export async function captureStartup(extraEnv: Record<string, string>): Promise<string> {
  const captured = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [serverEntry], {
      env: { PATH: process.env.PATH ?? "", ...extraEnv },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        child.kill();
        reject(err);
      } else {
        resolvePromise(stderr);
      }
    };
    const timer = setTimeout(
      () => settle(new Error(`server did not exit after stdin EOF; stderr so far: ${JSON.stringify(stderr)}`)),
      15_000,
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => settle(err));
    // `close` (not `exit`) -- it fires after the stdio streams have drained, so
    // the last stderr line is guaranteed to be in the buffer.
    child.on("close", () => settle());
    // Signal EOF immediately; there is no MCP session to conduct here.
    child.stdin.end();
  });
  assertAsciiStderr(captured);
  return captured;
}
