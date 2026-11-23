/**
 * Shared harness for the tests that call tool handlers directly
 * (handlers.test.ts, fullpass-tools-a.test.ts, fullpass-tools-b.test.ts).
 *
 * Each of those files used to carry its own copy of the env/fetch hooks and of
 * findTool, and the copies had drifted: three different AnyTool shapes, and the
 * same env-restore gap in all seven describes. Not a test file itself: there is
 * no `.test.` in the name, so the `npm test` glob over dist does not pick it
 * up. Not published either: package.json `files` ships dist/index.js only.
 */
import { afterEach, beforeEach } from "node:test";

export function mockFetchResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: new Headers(headers),
  });
}

// Look up a tool by name instead of positional index. Positional access silently
// shifted to the wrong tool whenever someone reordered entries in a tools/*.ts file.
//
// Returns a deliberately loose handler signature: the source `as const` tuples
// make each element's handler take a tool-specific input type, and unioning
// those across tuple elements would make the handler uncallable without
// per-tool narrowing. Tests cast to the specific input type they're exercising.
// The schema is typed only as far as the tests use it: every schema here is a
// zod object, and safeParse is the one method the tests call.
export type AnyTool = {
  name: string;
  description: string;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> } };
  handler: (input?: unknown) => Promise<unknown>;
};

export function findTool(tools: ReadonlyArray<{ name: string }>, name: string): AnyTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool as unknown as AnyTool;
}

/**
 * Variables api.ts or a tool module reads at call time that change what a test
 * observes. Deleted before every test so a value exported in the developer's
 * shell cannot change results: TAILSCALE_MAX_CONCURRENT=1, for instance,
 * serializes the fan-outs and fails every `peak >= 2` assertion. A test that
 * needs one sets it in its own body.
 */
const AMBIENT_ENV = [
  "TAILSCALE_OAUTH_CLIENT_ID",
  "TAILSCALE_OAUTH_CLIENT_SECRET",
  "TAILSCALE_OAUTH_TAILNET",
  "TAILSCALE_MAX_CONCURRENT",
  "TAILSCALE_REQUEST_BUDGET_MS",
  "TAILSCALE_RETRY_BASE_DELAY_MS",
  "TAILSCALE_EXTRA_WEBHOOK_EVENTS",
  "TAILSCALE_EXTRA_POSTURE_PROVIDERS",
  "TAILSCALE_DEBUG",
] as const;

/**
 * Register beforeEach/afterEach on the enclosing describe: API-key auth against
 * a fixed tailnet, a clean slate for AMBIENT_ENV, and a default fetch stub.
 * Call it once at the top of a describe body.
 */
export function installToolTestHarness(): void {
  // Captured when the describe body runs, before any test touches either.
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
    for (const key of AMBIENT_ENV) delete process.env[key];

    // Network isolation guardrail: nothing under this harness should ever reach
    // the real api.tailscale.com. Every test that needs a response overwrites
    // this stub in its own body; the many assert.rejects cases install nothing,
    // so without a default they would fall through to the REAL global fetch
    // that afterEach restores -- an outbound HTTPS request carrying the fake
    // key set above, sent from whatever machine runs the suite. Stopping that
    // is what the stub buys.
    //
    // A Response, not a throw. A thrown fetch is the transport-error path,
    // which apiRequest RETRIES on GET/PUT/DELETE (RETRYABLE_METHODS in api.ts)
    // with exponential backoff -- four attempts and ~7s of sleeps at the
    // default 1s base, per stray call. Only a 429 is retried on the status
    // path, so a synthetic 599 fails on the first attempt instead.
    //
    // Neither shape can silently pass a broken validator: handlers are called
    // directly rather than through wrapToolHandler, and apiRequest turns both
    // into an {ok:false} envelope rather than throwing, so a regressed
    // validator still fails its assert.rejects with "Missing expected
    // rejection". The explanation rides in the body because extractErrorMessage
    // passes non-JSON text through unchanged, landing it in the envelope's
    // `error` slot where a failing assertion will print it.
    globalThis.fetch = async () =>
      new Response("unexpected network call in unit test: the test must install its own fetch stub", { status: 599 });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    // Restore by walking originalEnv, not process.env: a key the test (or the
    // beforeEach above) deleted is no longer in process.env, so a loop over
    // process.env alone never puts it back for the rest of the file.
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) process.env[key] = value;
    }
  });
}
