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
// transitively imports every tool module and zod through them, so a
// module-load error anywhere under src/tools/ now fails THIS suite too, and
// the failure reads as a startup-banner problem. If this file fails
// unexpectedly, check that src/tools/*.ts loads first.
import { buildToolGroups, FORCED_APPROVAL_TOOLS, LARGE_RESULT_TOOLS, MAX_RESULT_SIZE_CHARS } from "./server-wiring.js";

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
  tools: Array<{ name: string; title?: string; _meta?: Record<string, unknown> }>;
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

/**
 * Conduct a session and call one tool, returning its decoded payload.
 *
 * Separate from conductMcpSession because that one is shaped around list results.
 * Both hand-roll the framing for the same reason: the stdio transport is
 * newline-delimited JSON with no Content-Length headers, and asserting against raw
 * frames keeps these tests independent of the SDK client's own behaviour.
 *
 * The payload is double-decoded on purpose -- wrapToolHandler serialises the tool's
 * `data` into a text content block, so what an agent actually reads is the JSON
 * inside that string, not the JSON-RPC result bag around it.
 */
async function callMcpTool(
  extraEnv: Record<string, string>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const NL = "\n";
  const child = spawn(process.execPath, [serverEntry], {
    env: { PATH: process.env.PATH ?? "", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    return await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      let buffered = "";
      const deadline = setTimeout(() => reject(new Error(`no tools/call response within 15s for ${toolName}`)), 15_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        for (let nl = buffered.indexOf(NL); nl >= 0; nl = buffered.indexOf(NL)) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (msg.id === 1) {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + NL);
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: toolName, arguments: args },
              }) + NL,
            );
          }
          if (msg.id === 2) {
            clearTimeout(deadline);
            const result = msg.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
            assert.ok(!result?.isError, `${toolName} returned an error: ${result?.content?.[0]?.text}`);
            const text = result?.content?.[0]?.text;
            assert.equal(typeof text, "string", `${toolName} returned no text content`);
            resolvePromise(JSON.parse(text as string) as Record<string, unknown>);
          }
        }
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
        }) + NL,
      );
    });
  } finally {
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
    // index.ts's server.registerTool(name, config, handler) call, which nothing
    // else in the repo reads.
    // The catalog tool is registered OUTSIDE buildToolGroups on purpose -- it is not a
    // Tailscale API tool, and every count in the README and release-metadata.test.ts
    // derives from that registry, so admitting it there would make the README's
    // "N admin-API tools" false. It must therefore appear in tools/list and NOT in
    // the registry, which is exactly what this asserts.
    assert.deepEqual(
      session.tools.map((t) => t.name).sort(),
      [...registryToolNames({}), "tailscale_tool_groups"].sort(),
      "tools/list disagrees with the tool registry plus the always-on catalog",
    );
  });
});

describe("tool _meta over a live session", () => {
  // These assert against the SPAWNED BUNDLE, not the tsc copy the unit tests
  // import. That distinction is the whole point: buildToolMeta can be perfect
  // while index.ts forgets to pass `_meta` to registerTool, or while a future
  // edit reverts to the legacy server.tool() -- which silently drops `_meta`
  // and `title` on the floor rather than failing. Only a real tools/list can
  // see that, and nothing else in the repo reads it.
  const APPROVAL_KEY = "anthropic/requiresUserInteraction";
  const SIZE_KEY = "anthropic/maxResultSizeChars";

  it("carries the approval flag on exactly the forced set when the gate is on", { timeout: 30_000 }, async () => {
    const session = await conductMcpSession({ ...API_KEY, TAILSCALE_REQUIRE_APPROVAL: "1" });
    const flagged = session.tools
      .filter((t) => t._meta?.[APPROVAL_KEY] === true)
      .map((t) => t.name)
      .sort();
    assert.deepEqual(
      flagged,
      [...FORCED_APPROVAL_TOOLS].sort(),
      "the tools a client is told it must never auto-approve drifted from FORCED_APPROVAL_TOOLS",
    );
  });

  it("omits the approval flag from every tool when the gate is off", { timeout: 30_000 }, async () => {
    // The default. A regression that flipped this on would deny these calls
    // outright for every unattended agent, which is worse than the gap it fixes.
    const session = await conductMcpSession({ ...API_KEY });
    const flagged = session.tools.filter((t) => t._meta?.[APPROVAL_KEY] !== undefined).map((t) => t.name);
    assert.deepEqual(flagged, [], "forced approval must be strictly opt-in");
  });

  it("declares the size cap on exactly the large-result set, gate independent", { timeout: 30_000 }, async () => {
    const envs: Array<Record<string, string>> = [{ ...API_KEY }, { ...API_KEY, TAILSCALE_REQUIRE_APPROVAL: "1" }];
    for (const env of envs) {
      const session = await conductMcpSession(env);
      const capped = session.tools.filter((t) => t._meta?.[SIZE_KEY] !== undefined);
      assert.deepEqual(
        capped.map((t) => t.name).sort(),
        [...LARGE_RESULT_TOOLS].sort(),
        `size caps drifted (TAILSCALE_REQUIRE_APPROVAL=${env.TAILSCALE_REQUIRE_APPROVAL ?? "unset"})`,
      );
      for (const tool of capped) {
        const value = tool._meta?.[SIZE_KEY];
        assert.equal(typeof value, "number", `${tool.name} must declare a numeric cap`);
        assert.ok(
          Number.isInteger(value) && (value as number) > 0 && (value as number) <= 500_000,
          `${tool.name} cap ${String(value)} is outside the accepted range; above the ceiling it is ignored`,
        );
        assert.equal(value, MAX_RESULT_SIZE_CHARS);
      }
    }
  });

  it("populates the top-level title, which the legacy registration could not", { timeout: 30_000 }, async () => {
    // The observable win of the registerTool migration. server.tool() hardcodes
    // title to undefined when it builds the registry entry, so before the
    // migration every tool advertised `title: undefined` no matter what its
    // annotations said. A revert would blank this out.
    const session = await conductMcpSession({ ...API_KEY });
    const untitled = session.tools.filter((t) => typeof t.title !== "string" || t.title.length === 0);
    assert.deepEqual(
      untitled.map((t) => t.name),
      [],
      "every tool sets annotations.title; all of them should surface",
    );

    const listDevices = session.tools.find((t) => t.name === "tailscale_list_devices");
    assert.equal(listDevices?.title, "List devices", "title must come from the tool's own annotations");
  });
});

describe("TAILSCALE_WRITE_GROUPS wiring", () => {
  // These spawn the BUNDLE. filter.ts can resolve the grant perfectly while index.ts
  // forgets to pass writeGroups into formatBannerFilterSuffix -- the two banner fields
  // are optional precisely so fourteen existing call sites did not need mechanical
  // edits, and this is what pays for that choice.

  it("reports the grant in the banner and withholds writes outside it", async () => {
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_WRITE_GROUPS: "devices,keys" });
    assert.match(stderr, /write=devices,keys/);
    assert.ok(
      toolCount(stderr) < toolCount(await captureStartup({ ...API_KEY })),
      "a grant must withhold the writes outside it",
    );
  });

  it("grants nothing on a typo and names it, rather than falling back like TAILSCALE_TOOLS", async () => {
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_WRITE_GROUPS: "devises" });
    assert.match(stderr, /TAILSCALE_WRITE_GROUPS includes unknown group\(s\): devises/);
    assert.match(stderr, /write=none/);
    // The load filter's all-unknown fallback must NOT have leaked into the write gate.
    assert.equal(
      toolCount(stderr),
      toolCount(await captureStartup({ ...API_KEY, TAILSCALE_READONLY: "1" })),
      "an all-unknown grant must serve exactly the read-only surface",
    );
  });

  it("points a sentinel guess at the spelling that does what it meant", async () => {
    const all = await captureStartup({ ...API_KEY, TAILSCALE_WRITE_GROUPS: "all" });
    assert.match(all, /"all" is not a group name -- leave TAILSCALE_WRITE_GROUPS unset/);
    const none = await captureStartup({ ...API_KEY, TAILSCALE_WRITE_GROUPS: "none" });
    assert.match(none, /TAILSCALE_READONLY=1 is the shipped spelling/);
  });

  it("warns when a grant names a group the load filter never loaded", async () => {
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_TOOLS: "acl", TAILSCALE_WRITE_GROUPS: "dns" });
    assert.match(stderr, /does not load: dns\. Those grants had no effect/);
    // Distinct from the typo warning: the name is spelled correctly.
    assert.ok(!/includes unknown group/.test(stderr), "a loaded-filter mismatch is not a typo");
  });

  it("names readonly as the cause when it overrides a grant", async () => {
    const stderr = await captureStartup({
      ...API_KEY,
      TAILSCALE_READONLY: "1",
      TAILSCALE_WRITE_GROUPS: "devices",
    });
    assert.match(stderr, /readonly \(TAILSCALE_WRITE_GROUPS ignored\)/);
  });

  it("warns that writing keys, users or acl is admin-equivalent", async () => {
    // The single most important line this feature prints: the knob filters the tool
    // list, not the credential, and these three areas are tailnet-admin-equivalent.
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_WRITE_GROUPS: "keys" });
    assert.match(stderr, /can write to keys, which is tailnet-admin-equivalent/);
    assert.match(stderr, /Scope the Tailscale OAuth client itself/);
    // Silent when the grant excludes all three, so it does not become noise.
    const quiet = await captureStartup({ ...API_KEY, TAILSCALE_WRITE_GROUPS: "devices" });
    assert.ok(!/admin-equivalent/.test(quiet), "must not fire on a non-admin grant");
  });

  it("warns on the UNGATED default too, where all three are writable", async () => {
    // The warning is derived from what actually registered, not from the grant. An
    // earlier revision read `writeGroups` and so inverted the signal relative to the
    // risk: it fired on a NARROWED grant and stayed silent on the default, where keys
    // AND users AND acl are all writable. The operator in the more permissive state
    // heard less.
    const stderr = await captureStartup({ ...API_KEY });
    assert.match(stderr, /can write to keys, users, acl, which is tailnet-admin-equivalent/);
  });

  it("stays quiet about admin equivalence with no credentials, and under readonly", async () => {
    // No creds: a fresh install has a more useful first message to read (the auth
    // error on the first tool call), same gate as the profile tip.
    const noCreds = await captureStartup({ TAILSCALE_WRITE_GROUPS: "keys" });
    assert.ok(!/admin-equivalent/.test(noCreds), "a fresh install must not get a security lecture first");
    // Readonly: nothing is writable, so there is nothing to warn about.
    const ro = await captureStartup({ ...API_KEY, TAILSCALE_READONLY: "1" });
    assert.ok(!/admin-equivalent/.test(ro), "readonly writes nothing");
  });

  it("distinguishes a group that exists but is not enabled from a typo", async () => {
    // local-cli is a real group that only registers under TAILSCALE_LOCAL_CLI=1.
    // Reporting it as "unknown" alongside a list of valid groups that excludes it
    // sends the operator hunting a misspelling that does not exist -- the same
    // misattribution the unknownGroups / unknownProfileGroups split exists to prevent.
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_WRITE_GROUPS: "local-cli" });
    assert.match(stderr, /exist but are not enabled in this process: local-cli/);
    assert.match(stderr, /Set TAILSCALE_LOCAL_CLI=1/);
    assert.ok(!/includes unknown group/.test(stderr), "a real group name is not a typo");
  });

  it("reports a real typo and a not-enabled group as separate causes in one run", async () => {
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_WRITE_GROUPS: "local-cli,devises" });
    assert.match(stderr, /not enabled in this process: local-cli/);
    assert.match(stderr, /includes unknown group\(s\): devises/);
    // The typo warning must name ONLY the typo -- listing local-cli there would
    // contradict the line printed immediately above it.
    assert.ok(!/unknown group\(s\): local-cli/.test(stderr), "the two causes must not overlap");
  });

  it("names exactly one cause when readonly voids a grant that also named an unloaded group", async () => {
    // Readonly voided the grant before the load filter could matter, so also saying
    // "you named an unloaded group" hands the operator two fixes for a config where
    // neither name is the operative problem.
    const stderr = await captureStartup({
      ...API_KEY,
      TAILSCALE_READONLY: "1",
      TAILSCALE_TOOLS: "acl",
      TAILSCALE_WRITE_GROUPS: "dns",
    });
    assert.match(stderr, /readonly \(TAILSCALE_WRITE_GROUPS ignored\)/);
    assert.ok(!/had no effect/.test(stderr), "readonly is the single operative cause");
  });

  it("changes nothing when unset", async () => {
    const stderr = await captureStartup({ ...API_KEY });
    assert.ok(!/write=/.test(stderr), "no gate configured means no write= segment");
  });

  it("stays quiet about admin equivalence when the load filter excluded those groups", async () => {
    // The warning derives from what REGISTERED, so the load filter is a third distinct
    // way it can fall silent -- the other two (readonly, a non-admin grant) are covered
    // and this one was not. TAILSCALE_TOOLS=devices never loads keys/users/acl, so
    // there is nothing admin-equivalent to warn about even with no write gate at all.
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_TOOLS: "devices" });
    assert.ok(!/admin-equivalent/.test(stderr), "an unloaded group cannot be written to");
    assert.ok(!/write=/.test(stderr), "no write gate was configured");
  });

  it("reports a sentinel and a real typo together, hinting once", async () => {
    // What a confused operator actually types. The hint is selected by a .some() over
    // the filtered list, so a mixed input exercises a path neither pure case does.
    const stderr = await captureStartup({ ...API_KEY, TAILSCALE_WRITE_GROUPS: "all,devises" });
    assert.match(stderr, /unknown group\(s\): all, devises/);
    assert.match(stderr, /"all" is not a group name/);
    assert.ok(!/TAILSCALE_READONLY=1 is the shipped spelling/.test(stderr), "one hint, not both");
  });

  it("treats a granted local-cli as a silent no-op once the opt-in is on", async () => {
    // Mirror of the not-enabled warning: same name, and the only difference is whether
    // the opt-in registered the group.
    const stderr = await captureStartup({
      ...API_KEY,
      TAILSCALE_LOCAL_CLI: "1",
      TAILSCALE_WRITE_GROUPS: "local-cli",
    });
    assert.match(stderr, /write=local-cli/);
    assert.ok(!/not enabled in this process/.test(stderr), "it IS enabled here");
    assert.ok(!/includes unknown group/.test(stderr), "and it is not a typo");
  });
});

describe("the always-on catalog tool", () => {
  // The exemption is the whole feature. A catalog that any filter can withhold is
  // useless precisely when it is needed -- the more restricted the server, the more
  // an agent needs to be told why.
  it("survives every filter combination, including ones that withhold everything else", async () => {
    const hostile: Array<[string, Record<string, string>]> = [
      ["readonly", { TAILSCALE_READONLY: "1" }],
      ["minimal profile", { TAILSCALE_PROFILE: "minimal" }],
      ["single group", { TAILSCALE_TOOLS: "audit" }],
      ["all-unknown tools", { TAILSCALE_TOOLS: "nonsense" }],
      ["no writes granted", { TAILSCALE_WRITE_GROUPS: "devises" }],
      [
        "everything at once",
        {
          TAILSCALE_PROFILE: "minimal",
          TAILSCALE_TOOLS: "audit",
          TAILSCALE_READONLY: "1",
          TAILSCALE_WRITE_GROUPS: "devises",
        },
      ],
    ];
    for (const [label, env] of hostile) {
      const session = await conductMcpSession({ ...API_KEY, ...env });
      const names = session.tools.map((t) => t.name);
      assert.ok(names.includes("tailscale_tool_groups"), `the catalog must survive: ${label}`);
    }
  });

  it("is callable and explains a withheld tool over a real session", async () => {
    // End to end through the protocol, against the spawned BUNDLE: the unit tests
    // exercise the pure functions, and this is what proves the wiring in index.ts
    // passes the right state rather than a plausible-looking empty one.
    const res = await callMcpTool({ ...API_KEY, TAILSCALE_WRITE_GROUPS: "dns" }, "tailscale_tool_groups", {
      toolName: "tailscale_delete_device",
    });
    assert.equal(res.available, false);
    assert.equal(res.group, "devices");
    assert.match(String(res.toEnable), /add "devices" to TAILSCALE_WRITE_GROUPS/);
  });

  it("distinguishes a nonexistent tool from a withheld one, end to end", async () => {
    const res = await callMcpTool({ ...API_KEY, TAILSCALE_WRITE_GROUPS: "dns" }, "tailscale_tool_groups", {
      toolName: "tailscale_reboot_device",
    });
    assert.equal(res.available, false);
    assert.equal(res.group, undefined, "no group -- it exists nowhere");
    assert.match(String(res.reason), /no tool by that name exists/);
    assert.equal(res.toEnable, undefined, "no env change can produce it");
  });

  it("reports the real registry's groups with per-group remedies", async () => {
    const res = await callMcpTool({ ...API_KEY, TAILSCALE_PROFILE: "minimal" }, "tailscale_tool_groups", {});
    const groups = res.groups as Array<{ group: string; status: string; toEnable?: string }>;
    const acl = groups.find((g) => g.group === "acl");
    assert.equal(acl?.status, "unavailable");
    assert.match(String(acl?.toEnable), /TAILSCALE_PROFILE=full/);
    // local-cli is off for a different reason and must say so rather than blaming
    // the profile the operator did set.
    const localCli = groups.find((g) => g.group === "local-cli");
    assert.equal(localCli?.toEnable, "set TAILSCALE_LOCAL_CLI=1");
  });
});
