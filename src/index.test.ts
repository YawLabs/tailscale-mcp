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
 *
 * Two things here are NOT about the banner, and both exist because dist/index.js
 * is the only artifact package.json actually ships. It is the esbuild bundle, a
 * second copy of this codebase that no other test in the repo executes. So this
 * file also (a) joins the spawned bundle's tool count back to buildToolGroups --
 * the tsc copy every other test imports -- and (b) conducts one real MCP session
 * over stdio, since index.ts's resource URI and mimeType bindings are otherwise
 * read by nobody but a live client.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PROFILES } from "./filter.js";
// Imported so the banner counts below can be checked against the registry
// rather than only against themselves -- see registryToolCount. Coupling worth
// knowing (same caveat release-metadata.test.ts documents): buildToolGroups
// transitively imports all 14 tool modules and zod through them, so a
// module-load error anywhere under src/tools/ now fails THIS suite too, and
// the failure reads as a startup-banner problem. If this file fails
// unexpectedly, check that src/tools/*.ts loads first.
import { buildToolGroups } from "./server-wiring.js";

// The compiled test sits in dist/ alongside the bundle it spawns. Resolving via
// import.meta.url (not process.cwd()) keeps this working under any runner.
const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");

/**
 * Startup stderr is ephemeral terminal output, so every byte of it must be
 * ASCII. A UTF-8 write racing the Windows console codepage renders anything
 * else as mojibake, and the mangled bytes travel verbatim into bug reports --
 * the profile tip shipped an em-dash and did exactly that. Enforced on the
 * harness rather than at one call site so it covers every startup path the
 * spawns below reach, including warning branches added later.
 */
function assertAsciiStderr(stderr: string): void {
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

/** Pull the tool count out of a `ready (N tools...)` banner. */
function toolCount(stderr: string): number {
  const m = stderr.match(/ready \((\d+) tools/);
  assert.ok(m, `no ready banner found in: ${JSON.stringify(stderr)}`);
  return Number(m[1]);
}

/**
 * Tool count according to the tsc-compiled registry -- the OTHER copy of this
 * codebase sitting in dist/.
 *
 * `npm run build` is `tsc && node build.mjs`: tsc emits a module-per-file tree
 * that every other test in this repo imports, then esbuild overwrites
 * dist/index.js with a single ~1.2 MB bundle. package.json `files` ships only
 * that bundle, so dist/ holds two independent copies of the tool registry and
 * the one users receive is the one with no behavioral coverage -- the spawn
 * tests here run the bundle, while release-metadata.test.ts counts the tsc
 * copy.
 *
 * Nothing used to join the two. Every banner assertion in this file is
 * internally consistent (the bundle reporting its own count back to itself), so
 * an esbuild regression -- a stray `external`, a tree-shake that drops a tool
 * module, a `define` change -- left the whole suite green while shipping a
 * server with the wrong tools. Comparing a spawned banner against this number
 * is the assertion that fails on that.
 *
 * Pass the same env the child was spawned with: the registry is env-dependent
 * (TAILSCALE_LOCAL_CLI adds a group). `groupNames` narrows to a profile's
 * preset the way filterTools does.
 */
function registryToolCount(env: NodeJS.ProcessEnv, groupNames?: readonly string[]): number {
  const groups = buildToolGroups(env);
  return (groupNames ?? Object.keys(groups)).reduce((n, g) => n + (groups[g]?.length ?? 0), 0);
}

/** Every tool name the tsc registry produces for `env`, sorted for comparison. */
function registryToolNames(env: NodeJS.ProcessEnv): string[] {
  return Object.values(buildToolGroups(env))
    .flat()
    .map((t) => t.name)
    .sort();
}

/** A JSON-RPC response frame, narrowed to the parts these tests read. */
interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

/** What one MCP session hands back to the assertions below. */
interface McpSession {
  serverInfo: { name?: string; version?: string };
  tools: Array<{ name: string }>;
  resources: Array<{ name: string; uri: string; mimeType?: string }>;
}

/**
 * Spawn the server and actually conduct an MCP session with it: initialize,
 * notifications/initialized, tools/list, resources/list.
 *
 * captureStartup above closes stdin immediately because it only wants the
 * banner, which left index.ts's entire registration block unasserted -- the
 * server.tool argument order and all four server.resource URI + mimeType
 * bindings are client-facing contract strings that no test in this repo ever
 * read. Typo `tailscale://tailnet/acl` or flip the ACL resource's
 * "application/hujson" to "application/json" and every other test still passes
 * while real clients get an unparseable body.
 *
 * The framing is hand-rolled rather than driven through the SDK client on
 * purpose: the stdio transport is newline-delimited JSON with no Content-Length
 * headers, which is three lines to write, and asserting against the raw frames
 * keeps this test measuring the wire contract instead of the SDK's own
 * behavior. A chunk can split a message mid-line, hence the buffer.
 */
async function conductMcpSession(extraEnv: Record<string, string>): Promise<McpSession> {
  const child = spawn(process.execPath, [serverEntry], {
    env: { PATH: process.env.PATH ?? "", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const pending = new Map<number, { resolve: (msg: JsonRpcResponse) => void; reject: (err: Error) => void }>();
  const failAll = (err: Error) => {
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
  };
  // A session-wide deadline, mirroring captureStartup's. Without it a server
  // that accepts the connection but never answers would hang the in-flight
  // await, so the `finally` below would never run and the child would leak
  // past the end of the run instead of failing with a readable message.
  const deadline = setTimeout(
    () => failAll(new Error(`no MCP response within 15s; stderr so far: ${JSON.stringify(stderr)}`)),
    15_000,
  );

  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // stdout is reserved for the protocol under stdio MCP; anything else
        // there is itself the bug (a stray console.log corrupts every client).
        failAll(new Error(`non-JSON frame on the MCP stdout channel: ${JSON.stringify(line)}`));
        return;
      }
      const waiter = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
      if (waiter && typeof msg.id === "number") {
        pending.delete(msg.id);
        waiter.resolve(msg);
      }
    }
  });
  child.on("error", (err) => failAll(err));
  child.on("close", () => failAll(new Error(`server exited mid-session; stderr: ${JSON.stringify(stderr)}`)));

  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  let nextId = 0;
  const request = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++nextId;
    const msg = await new Promise<JsonRpcResponse>((resolveOne, rejectOne) => {
      pending.set(id, { resolve: resolveOne, reject: rejectOne });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    assert.ok(!msg.error, `${method} returned a JSON-RPC error: ${JSON.stringify(msg.error)}`);
    return msg.result ?? {};
  };

  try {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "index.test.ts", version: "0.0.0" },
    });
    // Every shipped client sends this after initialize; omitting it would leave
    // the server in a state no real session ever reaches.
    notify("notifications/initialized");
    const tools = await request("tools/list");
    const resources = await request("resources/list");
    // Cast then default, rather than defaulting an `unknown` and casting the
    // union: these fields come off a JSON-RPC result bag typed as
    // Record<string, unknown>, and the assertions are what actually check them.
    return {
      serverInfo: (init.serverInfo as McpSession["serverInfo"] | undefined) ?? {},
      tools: (tools.tools as McpSession["tools"] | undefined) ?? [],
      resources: (resources.resources as McpSession["resources"] | undefined) ?? [],
    };
  } finally {
    // Unlike captureStartup this child is mid-session, so it will not exit on
    // stdin EOF promptly enough to gate the test on. Kill it outright, in a
    // finally, so a failed assertion above can never leak a live server.
    clearTimeout(deadline);
    child.stdin.end();
    child.kill();
  }
}

const API_KEY = { TAILSCALE_API_KEY: "tskey-api-startup-test" };

describe("server startup banner", () => {
  it("reports the default tool count and offers the profile tip when creds are set", async () => {
    const stderr = await captureStartup({ ...API_KEY });
    assert.match(stderr, /ready \(\d+ tools\)/, "no filters configured -> bare count, no suffix");
    // The separator is spelled out rather than covered by `.*`: it was an
    // em-dash, which a Windows console mangles, and a wildcard there matches the
    // mojibake just as happily as the fix.
    assert.match(stderr, /tip -- set TAILSCALE_PROFILE=core \(\d+ tools\)/);
    // The tip's numbers are derived from the registry, not hard-coded; assert
    // they are internally consistent with the profiles being smaller.
    const total = toolCount(stderr);
    const core = Number(stderr.match(/TAILSCALE_PROFILE=core \((\d+) tools\)/)?.[1]);
    const minimal = Number(stderr.match(/=minimal \((\d+)\)/)?.[1]);
    assert.ok(minimal < core && core < total, `expected minimal < core < total, got ${minimal} < ${core} < ${total}`);
    // Everything above is the bundle reporting its own numbers back to itself.
    // This is the join to the OTHER copy in dist/ -- free here, since the spawn
    // is already paid for -- and the one assertion an esbuild regression would
    // fail. See registryToolCount for why there are two copies to join.
    assert.equal(
      total,
      registryToolCount({}),
      "the shipped bundle registered a different number of tools than the tsc registry defines",
    );
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
    // The same bundle-vs-registry join as the default count above, reached by a
    // different path: the count now comes from filterTools intersecting
    // PROFILES.minimal with the groups. Worth making on both spawns, because
    // this one catches what the default cannot -- a REALLOCATION across the
    // profile boundary. A tool the bundle registers under `webhooks` that the
    // tsc registry puts under `audit` leaves the total at exactly the expected
    // number while moving the minimal count.
    assert.equal(toolCount(stderr), registryToolCount({}, PROFILES.minimal));
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
    // "additive" on its own is satisfied by any two numbers in the right order.
    // Pin the local-cli side against the registry too -- free here, since this
    // test already pays for the spawn, and it is the one group the bundle-join
    // assertions above cannot reach, both of them spawning without the opt-in.
    assert.equal(toolCount(withCli), registryToolCount({ TAILSCALE_LOCAL_CLI: "1" }));
  });

  it("warns about an unknown TAILSCALE_TOOLS group and names the valid ones", async () => {
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_TOOLS: "devises,acl" });
    assert.match(stderr, /TAILSCALE_TOOLS includes unknown group\(s\): devises/);
    assert.match(stderr, /Valid groups:/);
    // A partial typo still filters on the valid name rather than failing open.
    assert.match(stderr, /groups=devises,acl/);
  });

  it("reports the fallback when EVERY TAILSCALE_TOOLS group is unknown", async () => {
    // Distinct branch from the partial typo above: with no valid name left,
    // filterTools ignores TAILSCALE_TOOLS outright rather than starting a
    // zero-tool server, and index.ts appends a fallback note saying so. Only a
    // spawn can observe that note -- filter.test.ts covers the toolsAllUnknown
    // flag, but the message itself lives in index.ts's module body.
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_TOOLS: "devises,acls" });
    assert.match(stderr, /TAILSCALE_TOOLS includes unknown group\(s\): devises, acls/);
    assert.match(
      stderr,
      /Every requested group was unknown, so TAILSCALE_TOOLS was ignored and the default tool set was loaded instead\./,
    );
    // The filter was dropped, so the full default set loads. Checked against
    // the registry rather than a second spawn -- see registryToolCount.
    assert.equal(toolCount(stderr), registryToolCount({}));
    // ...and the banner must not advertise a filter it did not apply.
    // filterTools withholds explicitTools when it ignored them, so
    // formatBannerFilterSuffix has nothing to render.
    assert.ok(!/groups=/.test(stderr), `an ignored filter must not be reported as applied: ${JSON.stringify(stderr)}`);
    // The profile tip DOES still fire here, and that is intended, not a leak of
    // the "tip is redundant once the operator subset the tools" gate above:
    // their subset was thrown away, so they really are running the full surface
    // and "set TAILSCALE_PROFILE=core" is the correct next step.
    assert.match(stderr, /tip .* set TAILSCALE_PROFILE=core/);
  });

  it("warns about an unknown profile and falls back to loading everything", async () => {
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_PROFILE: "strict-mode" });
    assert.match(stderr, /TAILSCALE_PROFILE="strict-mode" is not a known profile/);
    assert.match(stderr, /Falling back to no profile filter/);
    // Both sides read PROFILES. The warning used to carry a hand-written
    // "minimal, core, full", so adding a preset would have left the one message
    // that enumerates the valid profiles calling the new one invalid -- and an
    // assertion spelling those same three names out here would not have noticed.
    const listed = stderr.match(/Valid profiles: (.*?)\. Falling back/)?.[1];
    assert.ok(listed, `the warning must enumerate the valid profiles: ${JSON.stringify(stderr)}`);
    assert.deepEqual(listed.split(", "), Object.keys(PROFILES), "the advertised profile list drifted from PROFILES");
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

describe("tailnet mismatch warning at startup", () => {
  // formatTailnetMismatchWarning is unit-tested in server-wiring.test.ts; these
  // pin that index.ts actually CALLS it. Without them the wiring could be
  // deleted and every other test would stay green.
  const OAUTH = {
    TAILSCALE_OAUTH_CLIENT_ID: "cid",
    TAILSCALE_OAUTH_CLIENT_SECRET: "csecret",
  };

  it("warns when TAILSCALE_OAUTH_TAILNET and TAILSCALE_TAILNET disagree", async () => {
    const stderr = await captureStartup({
      ...OAUTH,
      TAILSCALE_OAUTH_TAILNET: "api-only-1",
      TAILSCALE_TAILNET: "example.com",
    });
    assert.match(stderr, /api-only-1/);
    assert.match(stderr, /example\.com/);
    assert.match(stderr, /403/, "the warning must name the symptom, since 403s otherwise read as bad credentials");
    assert.match(stderr, /ready \(\d+ tools/, "the server must still start -- this is a warning, not a fatal");
  });

  it("stays silent when TAILSCALE_TAILNET is unset, so requests follow the token", async () => {
    const stderr = await captureStartup({ ...OAUTH, TAILSCALE_OAUTH_TAILNET: "api-only-1" });
    assert.ok(
      !/403/.test(stderr),
      `no mismatch warning expected when only the OAuth tailnet is set, got: ${JSON.stringify(stderr)}`,
    );
    assert.match(stderr, /ready \(\d+ tools/);
  });

  it("stays silent when both name the same tailnet", async () => {
    const stderr = await captureStartup({
      ...OAUTH,
      TAILSCALE_OAUTH_TAILNET: "api-only-1",
      TAILSCALE_TAILNET: "api-only-1",
    });
    assert.ok(!/403/.test(stderr), `identical values are not a mismatch, got: ${JSON.stringify(stderr)}`);
  });
});

describe("MCP protocol surface", () => {
  // No other test in this repo speaks MCP, which left index.ts's registration
  // block -- the four resource URI + mimeType bindings and the tool
  // registration itself -- as the only part of the server with no coverage at
  // all. server-wiring.test.ts exercises the four resource FUNCTIONS directly
  // and builds the URLs itself, so the URI strings in index.ts were never read
  // by anything but a real client.

  it("advertises the four resources and the whole registry over a live session", { timeout: 30_000 }, async () => {
    const session = await conductMcpSession({ ...API_KEY });

    assert.equal(session.serverInfo.name, "@yawlabs/tailscale-mcp");

    // Keyed by name rather than compared as an ordered list: registration order
    // is not the contract, and swapping two handlers in index.ts would not move
    // these strings anyway. What this does catch is a typo'd URI, a dropped
    // resource, and the mimeType flip that matters most -- the ACL resource
    // serves HuJSON (comments preserved), so "application/json" would tell
    // clients to parse it with a parser that rejects it.
    assert.deepEqual(
      Object.fromEntries(session.resources.map((r) => [r.name, { uri: r.uri, mimeType: r.mimeType }])),
      {
        "tailnet-status": { uri: "tailscale://tailnet/status", mimeType: "application/json" },
        "tailnet-devices": { uri: "tailscale://tailnet/devices", mimeType: "application/json" },
        "tailnet-acl": { uri: "tailscale://tailnet/acl", mimeType: "application/hujson" },
        "tailnet-dns": { uri: "tailscale://tailnet/dns", mimeType: "application/json" },
      },
      "the resource bindings a client sees drifted from what index.ts registers",
    );

    // Names, not just a count: this is the same bundle-vs-tsc join the describe
    // above makes on the banner, tightened one notch and taken at the layer a
    // client actually reads. A count alone cannot see a rename or a swap; this
    // can, and it also pins that the name argument stayed in first position of
    // index.ts's server.tool(name, description, shape, annotations, handler)
    // call, which nothing else in the repo reads.
    assert.deepEqual(
      session.tools.map((t) => t.name).sort(),
      registryToolNames({}),
      "tools/list disagrees with the tool registry",
    );
  });
});
