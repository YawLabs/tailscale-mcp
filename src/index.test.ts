/**
 * Startup-output tests for index.ts.
 *
 * index.ts's module body starts the MCP server on import, so it cannot be
 * imported into a test -- the registry was extracted to server-wiring.ts
 * (buildToolGroups) for exactly that reason, but the banner assembly, the
 * warning branches and the profile-tip gate still live in the module body and
 * are only observable by running the thing. So these spawn the built server,
 * read its stderr banner, and kill it.
 *
 * The banner is the operator's first and often only signal when debugging "why
 * do I see a different tool count than I expected", which makes it worth the
 * cost of a process spawn.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// The compiled test sits in dist/ alongside the bundle it spawns. Resolving via
// import.meta.url (not process.cwd()) keeps this working under any runner.
const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");

/**
 * Start the server with a curated env, close its stdin, and return everything
 * it wrote to stderr before shutting down.
 *
 * Closing stdin is what makes this deterministic. The stdio transport treats
 * EOF on stdin as "the client hung up" and exits, so the child terminates on
 * its own and `close` fires once stderr has been fully drained -- no polling
 * for a banner substring, no settle timer racing the tip line that follows it,
 * no kill. An earlier version waited for "ready (" then settled 120ms later and
 * treated exit as a failure; the child had always already exited by then, so
 * every case failed while printing the exact output it was asserting on.
 *
 * The env is built from a whitelist rather than `...process.env` so a
 * TAILSCALE_* var set by the developer's shell (or leaked by a sibling test)
 * cannot silently change what this asserts.
 */
async function captureStartup(extraEnv: Record<string, string>): Promise<string> {
  return new Promise((resolvePromise, reject) => {
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
}

/** Pull the tool count out of a `ready (N tools...)` banner. */
function toolCount(stderr: string): number {
  const m = stderr.match(/ready \((\d+) tools/);
  assert.ok(m, `no ready banner found in: ${JSON.stringify(stderr)}`);
  return Number(m[1]);
}

const API_KEY = { TAILSCALE_API_KEY: "tskey-api-startup-test" };

describe("server startup banner", () => {
  it("reports the default tool count and offers the profile tip when creds are set", async () => {
    const stderr = await captureStartup({ ...API_KEY });
    assert.match(stderr, /ready \(\d+ tools\)/, "no filters configured -> bare count, no suffix");
    assert.match(stderr, /tip .* set TAILSCALE_PROFILE=core \(\d+ tools\)/);
    // The tip's numbers are derived from the registry, not hard-coded; assert
    // they are internally consistent with the profiles being smaller.
    const total = toolCount(stderr);
    const core = Number(stderr.match(/TAILSCALE_PROFILE=core \((\d+) tools\)/)?.[1]);
    const minimal = Number(stderr.match(/=minimal \((\d+)\)/)?.[1]);
    assert.ok(minimal < core && core < total, `expected minimal < core < total, got ${minimal} < ${core} < ${total}`);
  });

  it("suppresses the profile tip when no credentials are configured", async () => {
    // On a fresh install the first useful message is the auth error from the
    // first tool call. Leading with "you have too many tools" would bury it.
    const stderr = await captureStartup({});
    assert.match(stderr, /ready \(\d+ tools\)/, "the server must still start and report its count");
    assert.ok(!/tip/.test(stderr), `tip must be suppressed without creds, got: ${JSON.stringify(stderr)}`);
  });

  it("applies a profile preset and drops the tip once a filter is configured", async () => {
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_PROFILE: "minimal" });
    assert.match(stderr, /ready \(\d+ tools, profile=minimal\)/);
    assert.ok(!/tip/.test(stderr), "the tip is redundant once the operator has already subset the tools");
    const full = toolCount(await captureStartup({ ...API_KEY }));
    assert.ok(toolCount(stderr) < full, "minimal must load fewer tools than the default");
  });

  it("adds the local-cli group and its banner marker when opted in", async () => {
    const withCli = await captureStartup({ ...API_KEY, TAILSCALE_LOCAL_CLI: "1" });
    const withoutCli = await captureStartup({ ...API_KEY });
    assert.match(withCli, /local-cli=on/);
    assert.ok(
      toolCount(withCli) > toolCount(withoutCli),
      `local-cli is additive: ${toolCount(withCli)} must exceed ${toolCount(withoutCli)}`,
    );
  });

  it("warns about an unknown TAILSCALE_TOOLS group and names the valid ones", async () => {
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_TOOLS: "devises,acl" });
    assert.match(stderr, /TAILSCALE_TOOLS includes unknown group\(s\): devises/);
    assert.match(stderr, /Valid groups:/);
    // A partial typo still filters on the valid name rather than failing open.
    assert.match(stderr, /groups=devises,acl/);
  });

  it("warns about an unknown profile and falls back to loading everything", async () => {
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_PROFILE: "strict-mode" });
    assert.match(stderr, /TAILSCALE_PROFILE="strict-mode" is not a known profile/);
    assert.match(stderr, /Falling back to no profile filter/);
    // Crucially, the profile warning must NOT be misattributed to TAILSCALE_TOOLS,
    // which the operator never set.
    assert.ok(!/TAILSCALE_TOOLS includes unknown/.test(stderr), "wrong env var blamed for a profile problem");
    assert.equal(toolCount(stderr), toolCount(await captureStartup({ ...API_KEY })));
  });

  it("reports readonly mode in the banner", async () => {
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_READONLY: "1" });
    assert.match(stderr, /readonly/);
    assert.ok(
      toolCount(stderr) < toolCount(await captureStartup({ ...API_KEY })),
      "readonly must drop the write tools",
    );
  });
});
