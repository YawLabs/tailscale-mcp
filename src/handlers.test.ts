import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

function mockFetchResponse(status: number, body: unknown, headers?: Record<string, string>) {
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
type AnyTool = {
  name: string;
  description: string;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  inputSchema: unknown;
  handler: (input?: unknown) => Promise<unknown>;
};
function findTool(tools: ReadonlyArray<{ name: string }>, name: string): AnyTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool as unknown as AnyTool;
}

describe("Tool handlers", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
    // Belt-and-braces: ensure no OAuth env leaks in if a future case sets them
    // and a restore in afterEach has any gap.
    delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
    delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;

    // Network isolation guardrail: nothing in this file should ever reach the
    // real api.tailscale.com. Every test that needs a response overwrites this
    // stub in its own body; the 40-plus assert.rejects cases install nothing,
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
    // directly here rather than through wrapToolHandler, and apiRequest turns
    // both into an {ok:false} envelope rather than throwing, so a regressed
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
      else process.env[key] = originalEnv[key];
    }
  });

  describe("tailscale_status", () => {
    it("should make parallel requests for devices and settings", async () => {
      const { statusTools } = await import("./tools/status.js");
      const urls: string[] = [];
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        urls.push(url);
        if (url.includes("/devices")) {
          return mockFetchResponse(200, { devices: [{ id: "1" }, { id: "2" }] });
        }
        return mockFetchResponse(200, { devicesApprovalOn: true });
      };

      const handler = findTool(statusTools, "tailscale_status").handler;
      const result = (await handler()) as { ok: boolean; data: { deviceCount: number; connected: boolean } };
      assert.ok(result.ok);
      assert.equal(result.data.deviceCount, 2);
      assert.equal(result.data.connected, true);
      assert.ok(urls.some((u) => u.includes("/devices")));
      assert.ok(urls.some((u) => u.includes("/settings")));
    });
  });

  describe("tailscale_list_devices", () => {
    it("should pass fields parameter when provided", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { devices: [] });
      };

      const handler = findTool(deviceTools, "tailscale_list_devices").handler as (input: {
        fields?: string;
      }) => Promise<unknown>;
      // 'all', not a comma list. The spec documents exactly two values (all,
      // default), so the old pin on `fields=id%2Cname%2Caddresses` codified a
      // per-column projection syntax Tailscale documents nowhere.
      await handler({ fields: "all" });
      assert.ok(capturedUrl.includes("fields=all"), `missing fields=all in: ${capturedUrl}`);
    });

    it("should not include fields parameter when omitted", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { devices: [] });
      };

      const handler = findTool(deviceTools, "tailscale_list_devices").handler as (input: {
        fields?: string;
      }) => Promise<unknown>;
      await handler({});
      assert.ok(!capturedUrl.includes("fields="));
    });

    it("should reject filters that include 'fields' (avoid silent shadow of the explicit fields param)", async () => {
      // Filter values are appended, not set, so a filters.fields entry no longer
      // overwrites the top-level fields= the caller set -- it sends a second
      // fields= and leaves the server to pick one. Ambiguity instead of a silent
      // overwrite, and still not what the caller asked for, so the guard stays.
      const { deviceTools } = await import("./tools/devices.js");
      const handler = findTool(deviceTools, "tailscale_list_devices").handler as (input: {
        fields?: string;
        filters?: Record<string, string | string[]>;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ fields: "default", filters: { fields: "all" } }), {
        message: /filters\.fields is not allowed/,
      });
      // Same guard, array form -- the union added for repeated keys must not
      // open a second way past it.
      await assert.rejects(() => handler({ fields: "default", filters: { fields: ["all"] } }), {
        message: /filters\.fields is not allowed/,
      });
    });
  });

  describe("tailscale_get_acl", () => {
    it("should append ETag instructions to raw body", async () => {
      const { aclTools } = await import("./tools/acl.js");
      globalThis.fetch = async () =>
        new Response('{ "acls": [] }', {
          status: 200,
          headers: { etag: '"acl-etag-1"' },
        });

      const handler = findTool(aclTools, "tailscale_get_acl").handler;
      const result = (await handler()) as { ok: boolean; rawBody: string };
      assert.ok(result.ok);
      assert.ok(result.rawBody.includes('{ "acls": [] }'));
      assert.ok(result.rawBody.includes("ETag:"));
      assert.ok(result.rawBody.includes('"acl-etag-1"'));
    });

    it("should embed ETag as a HuJSON // comment so round-tripping rawBody is safe", async () => {
      // Earlier versions used a `---\nETag:` separator. An agent that copied
      // rawBody verbatim into tailscale_update_acl would 400 the API. This
      // regression test pins the safe form.
      const { aclTools } = await import("./tools/acl.js");
      globalThis.fetch = async () =>
        new Response('{ "acls": [] }', {
          status: 200,
          headers: { etag: '"acl-etag-1"' },
        });
      const handler = findTool(aclTools, "tailscale_get_acl").handler;
      const result = (await handler()) as { ok: boolean; rawBody: string };
      assert.ok(!result.rawBody.includes("---"), "must not include a non-HuJSON --- separator");
      assert.match(result.rawBody, /^\/\/ ETag: "acl-etag-1"$/m);
    });

    it("should NOT stamp an ETag footer onto a failed fetch (res.ok && res.etag false arm)", async () => {
      // The happy path appends an ETag instruction footer. On a !ok response the
      // `res.ok && res.etag` guard is false, so the handler must return the error
      // verbatim -- never mutate an error body into a pseudo-policy with a footer
      // an agent might round-trip back into tailscale_update_acl.
      const { aclTools } = await import("./tools/acl.js");
      globalThis.fetch = async () =>
        new Response("forbidden", {
          status: 403,
          // Even with an etag present, a !ok response must skip the footer.
          headers: { etag: '"acl-etag-err"' },
        });
      const handler = findTool(aclTools, "tailscale_get_acl").handler;
      const result = (await handler()) as { ok: boolean; status: number; rawBody?: string };
      assert.equal(result.ok, false);
      assert.equal(result.status, 403);
      assert.ok(!result.rawBody?.includes("ETag:"), "error body must not carry the ETag instruction footer");
      assert.ok(
        !result.rawBody?.includes("tailscale_update_acl"),
        "error body must not carry the update-acl footer guidance",
      );
    });

    it("should not stack ETag footers when a round-tripped body already carries one", async () => {
      // tailscale_update_acl's description tells the agent to pass the full text
      // back, so whatever this handler stamped on is what the next get reads.
      // Appending unconditionally added one more footer block per edit cycle and
      // the stored policy grew without bound. Driving the handler twice, feeding
      // its own output back in, is that accumulation exactly as it happens live.
      const { aclTools } = await import("./tools/acl.js");
      const handler = findTool(aclTools, "tailscale_get_acl").handler;
      // Ends with a policy comment of its own: the strip walks back over the
      // trailing comment run, so this also pins that it stops at the footer.
      const policy = '{\n  "acls": [],\n}\n// keep: reviewed 2026-08\n';

      globalThis.fetch = async () => new Response(policy, { status: 200, headers: { etag: '"acl-etag-1"' } });
      const first = (await handler()) as { rawBody: string };

      globalThis.fetch = async () => new Response(first.rawBody, { status: 200, headers: { etag: '"acl-etag-2"' } });
      const second = (await handler()) as { rawBody: string };

      assert.deepEqual(
        second.rawBody.match(/^\/\/ ETag: .*$/gm),
        ['// ETag: "acl-etag-2"'],
        "exactly one ETag footer must remain, carrying the current ETag",
      );
      assert.equal(
        second.rawBody.replace('"acl-etag-2"', '"acl-etag-1"'),
        first.rawBody,
        "a round-tripped body must come back byte-identical apart from the refreshed ETag",
      );
      assert.ok(
        second.rawBody.includes("// keep: reviewed 2026-08"),
        "the policy's own trailing comment must survive the strip",
      );
    });
  });

  describe("tailscale_validate_acl", () => {
    it("should return friendly message on successful validation", async () => {
      const { aclTools } = await import("./tools/acl.js");
      globalThis.fetch = async () => new Response(null, { status: 200, headers: { "content-length": "0" } });

      const handler = findTool(aclTools, "tailscale_validate_acl").handler as (input: { policy: string }) => Promise<{
        ok: boolean;
        rawBody?: string;
      }>;
      const result = await handler({ policy: '{ "acls": [] }' });
      assert.ok(result.ok);
      assert.equal(result.rawBody, "ACL policy is valid.");
    });

    it("should treat a literal '{}' body as valid (matches cli.ts parseValidationError)", async () => {
      // Tailscale's validate endpoint returns 200 with either an empty body
      // or the literal `{}` for a VALID policy. Previously the MCP tool only
      // normalized the empty-body case, so a `{}` response surfaced verbatim
      // and looked like a diagnostic. cli.ts has always treated both as
      // success; this asserts the MCP tool now matches.
      const { aclTools } = await import("./tools/acl.js");
      globalThis.fetch = async () => new Response("{}", { status: 200 });

      const handler = findTool(aclTools, "tailscale_validate_acl").handler as (input: { policy: string }) => Promise<{
        ok: boolean;
        rawBody?: string;
      }>;
      const result = await handler({ policy: '{ "acls": [] }' });
      assert.ok(result.ok);
      assert.equal(result.rawBody, "ACL policy is valid.");
    });

    it("should surface the API error body verbatim when validation returns a non-empty body", async () => {
      // The happy path normalizes an empty 200 body to "ACL policy is valid.".
      // When the API returns 200 with a non-empty body, that body holds the
      // validation diagnostics -- `res.ok && !res.rawBody?.trim()` is false, so
      // the handler must pass the diagnostics through untouched rather than
      // overwrite them with the "valid" message.
      const { aclTools } = await import("./tools/acl.js");
      const apiError = "acl rule 0: dst tag :foo is not defined";
      // acceptRaw path: a 200 with a non-empty text body comes back as rawBody.
      globalThis.fetch = async () => new Response(apiError, { status: 200 });

      const handler = findTool(aclTools, "tailscale_validate_acl").handler as (input: { policy: string }) => Promise<{
        ok: boolean;
        rawBody?: string;
      }>;
      const result = await handler({ policy: '{ "acls": [{ "dst": ["tag:foo:*"] }] }' });
      assert.ok(result.ok);
      assert.equal(result.rawBody, apiError);
      assert.notEqual(result.rawBody, "ACL policy is valid.");
    });
  });

  describe("tailscale_update_acl", () => {
    it("should send raw HuJSON body with If-Match header", async () => {
      const { aclTools } = await import("./tools/acl.js");
      let capturedHeaders: Headers | undefined;
      let capturedBody: string | undefined;
      let capturedMethod = "";
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = init?.body as string;
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, { success: true });
      };

      const handler = findTool(aclTools, "tailscale_update_acl").handler as (input: {
        policy: string;
        etag: string;
      }) => Promise<unknown>;
      await handler({ policy: '{ /* hujson */ "acls": [] }', etag: '"etag-1"' });
      // The verb is invisible in the handler body -- it comes solely from which
      // api.ts helper is called (apiPost here). A one-token edit to apiPatch
      // would turn a full-policy overwrite into a merge the API treats
      // differently, with every other assertion in this test still green.
      assert.equal(capturedMethod, "POST");
      assert.equal(capturedHeaders?.get("If-Match"), '"etag-1"');
      assert.equal(capturedHeaders?.get("Content-Type"), "application/hujson");
      assert.equal(capturedBody, '{ /* hujson */ "acls": [] }');
    });

    it("should reject an empty or whitespace-only etag at the schema", async () => {
      // api.ts guards the header with `if (options?.ifMatch)`, so an empty etag
      // is falsy there: the If-Match header is omitted entirely and the policy
      // overwrite -- the widest-blast-radius write in the package -- ships with
      // no precondition, silently. The gate has to be the schema, and the test
      // has to be at the schema too, since these handlers are called directly
      // here. The happy path above holds the other half: a real etag still
      // reaches the header.
      const { aclTools } = await import("./tools/acl.js");
      const schema = findTool(aclTools, "tailscale_update_acl").inputSchema as {
        safeParse: (v: unknown) => { success: boolean; data?: { etag: string } };
      };
      const policy = '{ "acls": [] }';
      assert.equal(schema.safeParse({ policy, etag: "" }).success, false);
      // " " is truthy, so a bare .min(1) admits it and sends a whitespace
      // If-Match that cannot match any real ETag -- hence .trim() before .min.
      assert.equal(schema.safeParse({ policy, etag: "  " }).success, false);
      const parsed = schema.safeParse({ policy, etag: '  "etag-1"  ' });
      assert.equal(parsed.success, true);
      // The parsed value is what the MCP SDK hands the handler, so the trim is
      // observable at the header rather than only at the gate.
      assert.equal(parsed.data?.etag, '"etag-1"');
    });

    it("should send the quoted form of the etag whatever quoting the agent copied", async () => {
      // tailscale_get_acl hands the ETag back inside a `// ETag: "..."` footer,
      // so the quotes reach the agent as part of a comment line it retypes --
      // and an agent that drops them sends an unquoted If-Match. Both official
      // clients always send the quoted form (tailscale-client-go-v2 strips and
      // re-quotes, gitops-pusher concatenates quotes on), and the OpenAPI
      // spec's own examples are escaped-quoted, so normalizing here can only
      // move the header toward what the server is known to accept.
      const { aclTools } = await import("./tools/acl.js");
      // Collected rather than overwritten, so a case that sends no request at
      // all fails here instead of re-reading the previous case's header.
      const sent: Array<string | null> = [];
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Headers(init?.headers).get("If-Match"));
        return mockFetchResponse(200, { success: true });
      };

      const handler = findTool(aclTools, "tailscale_update_acl").handler as (input: {
        policy: string;
        etag: string;
      }) => Promise<unknown>;
      const cases: Array<[string, string]> = [
        // The quotes lost on the way out of the footer are put back.
        ["etag-1", '"etag-1"'],
        // The spec's first-write sentinel, which the etag description names.
        // Its own example is `-H "If-Match: \"ts-default\""`, so it is quoted
        // like any other value rather than passed bare.
        ["ts-default", '"ts-default"'],
        ['"ts-default"', '"ts-default"'],
        // Already correct: the header must come out byte-identical, which is
        // what makes this change a no-op for every caller doing it right.
        ['"etag-1"', '"etag-1"'],
        // A weak validator carries its own quoting. Stripping it would yield
        // `"W/abc"`, which is a different validator, not a requoted one.
        ['W/"abc"', 'W/"abc"'],
      ];
      for (const [etag] of cases) await handler({ policy: '{ "acls": [] }', etag });
      assert.deepEqual(
        sent,
        cases.map(([, expected]) => expected),
        `If-Match headers for ${cases.map(([etag]) => JSON.stringify(etag)).join(", ")}`,
      );
    });

    it("should reject an etag that is empty once its quotes come off, before any request", async () => {
      // `'""'` clears the schema's .trim().min(1) -- it is two characters --
      // and `'" "'` clears it at three, both unquoting to nothing. Unlike the
      // genuinely empty etag above, these are truthy, so api.ts's
      // `if (options?.ifMatch)` does set the header: what goes out is a
      // precondition that cannot match any ETag the tailnet holds. Per the
      // spec that buys a 412 -- fail-safe, but a confusing round trip instead
      // of a local error naming the field, which is the same trade the
      // schema's own .trim() is there to avoid. What the server does with it
      // was not observed against a live tailnet.
      const { aclTools } = await import("./tools/acl.js");
      let called = false;
      globalThis.fetch = async () => {
        called = true;
        return mockFetchResponse(200, { success: true });
      };

      const handler = findTool(aclTools, "tailscale_update_acl").handler as (input: {
        policy: string;
        etag: string;
      }) => Promise<unknown>;
      for (const etag of ['""', '" "']) {
        await assert.rejects(() => handler({ policy: '{ "acls": [] }', etag }), {
          message: /empty once its quotes are removed/,
        });
      }
      assert.equal(called, false, "an If-Match that cannot match is not worth sending the overwrite to find out");
    });

    it("should surface the failing user and assertion when the API rejects the policy", async () => {
      // This is the widest-blast-radius write in the package, and until now a
      // rejected policy reached the agent as the bare "test(s) failed" -- the
      // `data` array naming the user and the assertion was dropped in
      // extractErrorMessage. Body shape from Tailscale's historical api.md
      // ("Response: failed test error" for the set-ACL endpoint).
      const { aclTools } = await import("./tools/acl.js");
      globalThis.fetch = async () =>
        mockFetchResponse(400, {
          message: "test(s) failed",
          data: [{ user: "user1@example.com", errors: ['address "user2@example.com:400": want: Accept, got: Drop'] }],
        });

      const handler = findTool(aclTools, "tailscale_update_acl").handler as (input: {
        policy: string;
        etag: string;
      }) => Promise<{ ok: boolean; error?: string }>;
      const result = await handler({ policy: '{ "acls": [] }', etag: '"etag-1"' });
      assert.equal(result.ok, false);
      const error = result.error ?? "";
      assert.ok(error.includes("test(s) failed"), `expected the message, got: ${error}`);
      assert.ok(error.includes("For user user1@example.com:"), `expected the user line, got: ${error}`);
      assert.ok(
        error.includes('- address "user2@example.com:400": want: Accept, got: Drop'),
        `expected the assertion text, got: ${error}`,
      );
    });
  });

  describe("tailscale_create_key", () => {
    it("should include expirySeconds when set to a number", async () => {
      const { keyTools } = await import("./tools/keys.js");
      let capturedBody: string | undefined;
      let capturedMethod = "";
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, { key: "tskey-auth-test" });
      };

      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ expirySeconds: 3600, description: "test key" });
      // Key MINTING is a POST to the collection; the sibling update_key tool is
      // a PUT to a single key. Nothing else in these tests would notice if the
      // two helpers were swapped, so pin the verb on both sides.
      assert.equal(capturedMethod, "POST");
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.expirySeconds, 3600);
      assert.equal(parsed.description, "test key");
    });

    it("should omit description from the body when input is empty/whitespace-only", async () => {
      // Empty descriptions used to be forwarded verbatim, which the API may 400 on.
      // Treating "" / "   " as "no description" matches the user intent and is
      // identical to omitting the field.
      const { keyTools } = await import("./tools/keys.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { key: "tskey-auth-test" });
      };

      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ description: "" });
      const parsed = JSON.parse(capturedBody!);
      assert.ok(!("description" in parsed), `expected description to be omitted, got: ${JSON.stringify(parsed)}`);
    });
  });

  describe("tailscale_update_tailnet_settings", () => {
    it("should only send defined fields to the API", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      let capturedBody: string | undefined;
      let capturedMethod = "";
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, { success: true });
      };

      // The update tool is index 1
      const handler = findTool(tailnetTools, "tailscale_update_tailnet_settings").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ devicesApprovalOn: true });
      // PATCH, not PUT: the send-only-defined-fields behaviour asserted below is
      // a merge, and it is only safe because the API is told to merge. A helper
      // swap to apiPut would silently reset every unsent tailnet setting.
      assert.equal(capturedMethod, "PATCH");
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { devicesApprovalOn: true });
      assert.ok(!("devicesAutoUpdatesOn" in parsed));
    });

    it("should send httpsEnabled to the API", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { success: true });
      };

      const handler = findTool(tailnetTools, "tailscale_update_tailnet_settings").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ httpsEnabled: true });
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { httpsEnabled: true });
    });

    it("should send all new settings fields to the API", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { success: true });
      };

      const handler = findTool(tailnetTools, "tailscale_update_tailnet_settings").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({
        postureIdentityCollectionOn: true,
        usersRoleAllowedToJoinExternalTailnets: "admin",
      });
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, {
        postureIdentityCollectionOn: true,
        usersRoleAllowedToJoinExternalTailnets: "admin",
      });
    });

    it("should send all fields together when all are provided", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { success: true });
      };

      const handler = findTool(tailnetTools, "tailscale_update_tailnet_settings").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({
        devicesApprovalOn: false,
        devicesAutoUpdatesOn: true,
        devicesKeyDurationDays: 90,
        usersApprovalOn: false,
        usersRoleAllowedToJoinExternalTailnets: "member",
        networkFlowLoggingOn: true,
        regionalRoutingOn: true,
        postureIdentityCollectionOn: false,
        httpsEnabled: true,
        aclsExternallyManagedOn: true,
        aclsExternalLink: "https://github.com/example/acls",
      });
      const parsed = JSON.parse(capturedBody!);
      assert.equal(Object.keys(parsed).length, 11);
      assert.equal(parsed.httpsEnabled, true);
      assert.equal(parsed.devicesKeyDurationDays, 90);
      assert.equal(parsed.usersRoleAllowedToJoinExternalTailnets, "member");
      assert.equal(parsed.postureIdentityCollectionOn, false);
      assert.equal(parsed.aclsExternallyManagedOn, true);
      assert.equal(parsed.aclsExternalLink, "https://github.com/example/acls");
    });

    it("should not include undefined fields in the request body", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { success: true });
      };

      const handler = findTool(tailnetTools, "tailscale_update_tailnet_settings").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ httpsEnabled: false });
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { httpsEnabled: false });
      assert.ok(!("devicesApprovalOn" in parsed));
      assert.ok(!("postureIdentityCollectionOn" in parsed));
      assert.ok(!("usersRoleAllowedToJoinExternalTailnets" in parsed));
    });

    it("should reject empty input (no fields to update)", async () => {
      // Mirrors the guard on tailscale_set_dns_configuration -- PATCHing {} to the
      // settings endpoint is almost always a mistake. Every other test in this
      // block passes >=1 field; this pins the empty-input failure arm.
      const { tailnetTools } = await import("./tools/tailnet.js");
      const handler = findTool(tailnetTools, "tailscale_update_tailnet_settings").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({}), { message: /No fields to update/ });
    });
  });

  describe("tailscale_update_webhook", () => {
    it("should PATCH webhook subscriptions", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      let capturedMethod: string | undefined;
      let capturedUrl: string | undefined;
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method;
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { id: "wh-123" });
      };

      // The update tool is index 3
      const handler = findTool(webhookTools, "tailscale_update_webhook").handler as (input: {
        webhookId: string;
        subscriptions: string[];
      }) => Promise<unknown>;
      await handler({ webhookId: "wh-123", subscriptions: ["nodeCreated", "policyUpdate"] });
      assert.equal(capturedMethod, "PATCH");
      assert.ok(capturedUrl?.includes("/webhooks/wh-123"));
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed.subscriptions, ["nodeCreated", "policyUpdate"]);
    });
  });

  describe("webhook event-type catalog", () => {
    // Pins the contract for the TAILSCALE_EXTRA_WEBHOOK_EVENTS escape hatch:
    // operators can ship a new event Tailscale just rolled out without waiting
    // for this package to release, and the strict default still rejects typos.
    it("accepts every static event without the escape hatch", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      const schema = findTool(webhookTools, "tailscale_create_webhook").inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      const result = schema.safeParse({
        endpointUrl: "https://example.com/hook",
        subscriptions: ["nodeCreated", "policyUpdate", "userApproved"],
      });
      assert.ok(result.success, "every static event must validate without TAILSCALE_EXTRA_WEBHOOK_EVENTS");
    });

    it("rejects unknown events with a message that points at the escape hatch", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      const schema = findTool(webhookTools, "tailscale_create_webhook").inputSchema as {
        safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
      };
      const result = schema.safeParse({
        endpointUrl: "https://example.com/hook",
        subscriptions: ["totallyMadeUpEvent"],
      });
      assert.equal(result.success, false);
      const msg = result.error?.issues.map((i) => i.message).join(" | ") ?? "";
      assert.match(msg, /Unknown webhook event/);
      assert.match(msg, /TAILSCALE_EXTRA_WEBHOOK_EVENTS/);
      // The message must enumerate the known events so the operator can
      // immediately see what's allowed without reading source.
      assert.match(msg, /nodeCreated/);
    });

    it("accepts an unknown event when TAILSCALE_EXTRA_WEBHOOK_EVENTS adds it", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS = "newFutureEvent,anotherNewEvent";
      try {
        const schema = findTool(webhookTools, "tailscale_create_webhook").inputSchema as {
          safeParse: (v: unknown) => { success: boolean };
        };
        const result = schema.safeParse({
          endpointUrl: "https://example.com/hook",
          subscriptions: ["newFutureEvent", "nodeCreated", "anotherNewEvent"],
        });
        assert.ok(result.success, "events listed in TAILSCALE_EXTRA_WEBHOOK_EVENTS must validate");
      } finally {
        delete process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS;
      }
    });

    it("treats TAILSCALE_EXTRA_WEBHOOK_EVENTS='' (empty) as no extras", async () => {
      // Symmetry with TAILSCALE_TOOLS handling in filter.ts: an empty string
      // env var should not be treated as "block everything" or do anything
      // surprising -- it must behave the same as unset.
      const { webhookTools } = await import("./tools/webhooks.js");
      process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS = "";
      try {
        const schema = findTool(webhookTools, "tailscale_create_webhook").inputSchema as {
          safeParse: (v: unknown) => { success: boolean };
        };
        // Static event still accepted.
        assert.equal(
          schema.safeParse({ endpointUrl: "https://example.com/hook", subscriptions: ["nodeCreated"] }).success,
          true,
        );
        // Unknown event still rejected.
        assert.equal(
          schema.safeParse({ endpointUrl: "https://example.com/hook", subscriptions: ["totallyMadeUpEvent"] }).success,
          false,
        );
      } finally {
        delete process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS;
      }
    });

    it("treats TAILSCALE_EXTRA_WEBHOOK_EVENTS=',,,' (commas-only) as no extras", async () => {
      // Same parse pipeline as TAILSCALE_TOOLS: split + trim + filter(Boolean)
      // yields an empty list. Must not silently register an "" event or
      // anything else weird.
      const { webhookTools } = await import("./tools/webhooks.js");
      process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS = ",,,";
      try {
        const schema = findTool(webhookTools, "tailscale_create_webhook").inputSchema as {
          safeParse: (v: unknown) => { success: boolean };
        };
        assert.equal(
          schema.safeParse({ endpointUrl: "https://example.com/hook", subscriptions: ["nodeCreated"] }).success,
          true,
        );
        // Critically, the empty string must NOT have been added to the
        // allowed set as a side effect of the parse.
        assert.equal(schema.safeParse({ endpointUrl: "https://example.com/hook", subscriptions: [""] }).success, false);
      } finally {
        delete process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS;
      }
    });

    it("trims whitespace and ignores empty segments in TAILSCALE_EXTRA_WEBHOOK_EVENTS", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS = " foo , , bar ,";
      try {
        const schema = findTool(webhookTools, "tailscale_create_webhook").inputSchema as {
          safeParse: (v: unknown) => { success: boolean };
        };
        // Both extras allowed after trim.
        assert.equal(
          schema.safeParse({ endpointUrl: "https://example.com/hook", subscriptions: ["foo"] }).success,
          true,
        );
        assert.equal(
          schema.safeParse({ endpointUrl: "https://example.com/hook", subscriptions: ["bar"] }).success,
          true,
        );
        // Whitespace-padded variant must NOT have been silently registered.
        assert.equal(
          schema.safeParse({ endpointUrl: "https://example.com/hook", subscriptions: [" foo "] }).success,
          false,
        );
      } finally {
        delete process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS;
      }
    });

    it("update_webhook honors the escape hatch on the subscriptions field too", async () => {
      // Symmetry check: an operator who relies on the escape hatch for create
      // also expects update to accept the same events without a separate flag.
      const { webhookTools } = await import("./tools/webhooks.js");
      process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS = "newFutureEvent";
      try {
        const schema = findTool(webhookTools, "tailscale_update_webhook").inputSchema as {
          safeParse: (v: unknown) => { success: boolean };
        };
        assert.equal(schema.safeParse({ webhookId: "wh-1", subscriptions: ["newFutureEvent"] }).success, true);
      } finally {
        delete process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS;
      }
    });

    it("reports the failing element's index in issue.path for each bad event", async () => {
      // The array-level superRefine attaches `path: [i]` to each per-element
      // issue. The surrounding object schema prepends "subscriptions", giving
      // a final path of ["subscriptions", i] -- enough for an MCP client (or
      // a curious human) to point at the exact offending entry without
      // re-scanning the input.
      const { webhookTools } = await import("./tools/webhooks.js");
      const schema = findTool(webhookTools, "tailscale_create_webhook").inputSchema as {
        safeParse: (v: unknown) => {
          success: boolean;
          error?: { issues: Array<{ message: string; path: PropertyKey[] }> };
        };
      };
      const result = schema.safeParse({
        endpointUrl: "https://example.com/hook",
        // index 1 and index 3 are bad; index 0 and index 2 are valid.
        subscriptions: ["nodeCreated", "bogusEventOne", "policyUpdate", "bogusEventTwo"],
      });
      assert.equal(result.success, false);
      const issues = result.error?.issues ?? [];
      assert.equal(issues.length, 2, `expected exactly 2 issues, got ${issues.length}`);
      const paths = issues.map((i) => i.path);
      assert.deepEqual(
        paths.sort((a, b) => (a[1] as number) - (b[1] as number)),
        [
          ["subscriptions", 1],
          ["subscriptions", 3],
        ],
      );
      // Each rejected element gets its own message naming the bad value.
      const messages = issues.map((i) => i.message).join(" | ");
      assert.match(messages, /bogusEventOne/);
      assert.match(messages, /bogusEventTwo/);
    });
  });

  describe("tailscale_get_audit_log", () => {
    it("should pass start and end params", async () => {
      const { auditTools } = await import("./tools/audit.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { logs: [] });
      };

      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await handler({ start: "2026-01-01T00:00:00Z", end: "2026-01-30T23:59:59Z" });
      assert.ok(capturedUrl.includes("/logging/configuration"));
      assert.ok(capturedUrl.includes("start=2026-01-01T00%3A00%3A00Z"));
      assert.ok(capturedUrl.includes("end=2026-01-30T23%3A59%3A59Z"));
    });

    it("should send end = now when end is omitted", async () => {
      // Per the OpenAPI spec `end` is a required query parameter on both logging
      // endpoints, so the tool fills it in rather than relying on a server
      // default no Tailscale source documents. Second precision, matching the Go
      // client's `params.End.Format(time.RFC3339)`: no upstream example carries
      // a fractional second, and truncating only moves `end` earlier, so it
      // cannot push a passing range back over the 30-day guard.
      const { auditTools } = await import("./tools/audit.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { logs: [] });
      };

      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      const before = Date.now();
      // Computed, not a literal, so the 30-day guard doesn't fire as the
      // calendar drifts.
      await handler({ start: new Date(before - 3 * 24 * 60 * 60 * 1000).toISOString() });
      const end = new URL(capturedUrl).searchParams.get("end");
      assert.ok(end, `end must be sent even when the caller omits it, got: ${capturedUrl}`);
      assert.match(end, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.ok(Math.abs(Date.parse(end) - before) < 5000, `end=${end} is not within 5s of now`);
    });

    it("should never put an end earlier than start on the wire", async () => {
      // isoSecond truncates the wire `end` to whole seconds while the range
      // guard used to compare a millisecond-precision `new Date()`, so the one
      // shape whose start lands inside the second the handler runs in -- "tail
      // the audit log from now" -- passed the guard and then sent an `end` up
      // to 999ms BEFORE `start`, drawing a terse API 400 instead of the local
      // "end must be >= start" the guard exists to produce. The guard now reads
      // the value that goes on the wire, so either the clock has moved into the
      // next second (end > start, request sent) or the inversion is caught
      // here. Both are asserted, because which one happens is a race.
      const { auditTools } = await import("./tools/audit.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { logs: [] });
      };

      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      // A start with .000 milliseconds truncates to itself, which is the one
      // value that cannot show the defect.
      let start = new Date().toISOString();
      while (start.endsWith(".000Z")) start = new Date().toISOString();

      let refused = "";
      try {
        await handler({ start });
      } catch (err) {
        refused = err instanceof Error ? err.message : String(err);
        assert.match(refused, /end must be >= start/, "the only acceptable refusal here is the range guard's");
      }
      if (refused) {
        assert.equal(capturedUrl, "", "a range the guard rejected must not reach the wire");
      } else {
        const end = new URL(capturedUrl).searchParams.get("end") ?? "";
        assert.ok(
          Date.parse(end) >= Date.parse(start),
          `end=${end} precedes start=${start} on the wire, which is the API 400 this guard exists to prevent`,
        );
      }
    });

    it("should treat an empty end as omitted", async () => {
      // assertLogRange reads `end ? Date.parse(end) : <now>`, so "" is already
      // the default-to-now path for the range guard. A `??` on the wire value
      // would disagree with it and send a bare `end=`.
      const { auditTools } = await import("./tools/audit.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { logs: [] });
      };

      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await handler({ start: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), end: "" });
      const end = new URL(capturedUrl).searchParams.get("end");
      assert.match(end ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it("should append actor, target and event filters alongside the time window", async () => {
      const { auditTools } = await import("./tools/audit.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { logs: [] });
      };

      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
        actor?: string[];
        target?: string[];
        event?: string[];
      }) => Promise<unknown>;
      await handler({
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-30T23:59:59Z",
        actor: ["~bob"],
        target: ["mytarget1"],
        event: ["TAILNET.UPDATE.ACL"],
      });
      const params = new URL(capturedUrl).searchParams;
      assert.deepEqual(params.getAll("actor"), ["~bob"]);
      assert.deepEqual(params.getAll("target"), ["mytarget1"]);
      assert.deepEqual(params.getAll("event"), ["TAILNET.UPDATE.ACL"]);
      // The `~search` wildcard goes on the wire percent-encoded; the server
      // decodes it. Pinned because a filter that silently matched nothing would
      // read as "no such change" to the agent.
      assert.ok(capturedUrl.includes("actor=%7Ebob"), `expected an encoded ~ in: ${capturedUrl}`);
      // Filters are added to the time window, not instead of it.
      assert.equal(params.get("start"), "2026-01-01T00:00:00Z");
      assert.equal(params.get("end"), "2026-01-30T23:59:59Z");
    });

    it("should send no filter key for an empty or omitted filter", async () => {
      const { auditTools } = await import("./tools/audit.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { logs: [] });
      };

      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
        actor?: string[];
        target?: string[];
        event?: string[];
      }) => Promise<unknown>;
      await handler({ start: "2026-01-01T00:00:00Z", end: "2026-01-30T23:59:59Z", event: [] });
      assert.ok(!capturedUrl.includes("event="), `expected no event key in: ${capturedUrl}`);
      assert.ok(!capturedUrl.includes("actor="), `expected no actor key in: ${capturedUrl}`);
      assert.ok(!capturedUrl.includes("target="), `expected no target key in: ${capturedUrl}`);
    });

    it("should reject a blank filter value and trim the ones it accepts", async () => {
      // `.trim().min(1)` rather than a bare `.min(1)`, for the reason keys.ts
      // and tailnets.ts already spell out: " NODE.CREATE" is truthy, and it
      // would go on the wire as `event=+NODE.CREATE` and come back empty with no
      // error -- a silent under-report rather than a validation failure.
      const { auditTools } = await import("./tools/audit.js");
      const schema = findTool(auditTools, "tailscale_get_audit_log").inputSchema as {
        safeParse: (v: unknown) => { success: boolean; data?: { event?: string[] } };
      };
      const start = "2026-01-01T00:00:00Z";
      assert.equal(schema.safeParse({ start, event: ["  "] }).success, false);
      const parsed = schema.safeParse({ start, event: [" NODE.CREATE "] });
      assert.equal(parsed.success, true);
      assert.deepEqual(parsed.data?.event, ["NODE.CREATE"]);
    });

    it("should accept an event value the spec's enum does not list", async () => {
      // Free strings on purpose: the spec's event enum is 138 values and still
      // growing (the PAM_* entries are recent), so a closed zod enum would make
      // a new event type uncreatable rather than merely unvalidated -- the bug
      // class the changelog already records for webhook subscriptions.
      const { auditTools } = await import("./tools/audit.js");
      const schema = findTool(auditTools, "tailscale_get_audit_log").inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      assert.equal(schema.safeParse({ start: "2026-01-01T00:00:00Z", event: ["SOME.FUTURE.EVENT"] }).success, true);
    });

    it("should reject more than one value in a single filter", async () => {
      // Capped at one value until a live call records how the API reads a
      // repeated key. One value is wire-identical whether the server expects
      // repeated keys or a comma-joined list; two values under the wrong guess
      // would return a subset with no error, which in a compliance query reads
      // as "that change never happened".
      const { auditTools } = await import("./tools/audit.js");
      const schema = findTool(auditTools, "tailscale_get_audit_log").inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      const start = "2026-01-01T00:00:00Z";
      assert.equal(schema.safeParse({ start, event: ["NODE.CREATE", "NODE.DELETE"] }).success, false);
      assert.equal(schema.safeParse({ start, actor: ["~bob", "uc4p8fRHvJ11DEVEL"] }).success, false);
      assert.equal(schema.safeParse({ start, target: ["mytarget1", "sometarget2"] }).success, false);
    });

    it("should not expose the filters on tailscale_get_network_flow_logs", async () => {
      // The spec gives /logging/network only start and end. The object schema
      // STRIPS unknown keys rather than rejecting them, so the claim to pin is
      // that `actor` never reaches the handler -- not that the parse fails.
      const { auditTools } = await import("./tools/audit.js");
      const schema = findTool(auditTools, "tailscale_get_network_flow_logs").inputSchema as {
        safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> };
      };
      const parsed = schema.safeParse({ start: "2026-01-01T00:00:00Z", actor: ["~bob"] });
      assert.equal(parsed.success, true);
      assert.ok(!("actor" in (parsed.data ?? {})), `actor should be stripped, got: ${JSON.stringify(parsed.data)}`);
    });
  });

  describe("tailscale_set_contacts", () => {
    it("should only send provided contact fields via per-type PATCH calls", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      let capturedUrl = "";
      let capturedBody: string | undefined;
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = init?.body as string;
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };

      // set_contacts is index 3
      const handler = findTool(tailnetTools, "tailscale_set_contacts").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ security: { email: "sec@example.com" } });
      // The title of the sibling parallel test claims PATCH but nothing checked
      // it; the merge semantics are the whole point of sending one contact type
      // at a time, so pin the verb here.
      assert.equal(capturedMethod, "PATCH");
      assert.ok(
        capturedUrl.includes("/contacts/security"),
        `Expected URL to contain /contacts/security, got: ${capturedUrl}`,
      );
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { email: "sec@example.com" });
    });
  });

  describe("tailscale_status (settings error)", () => {
    it("should return ok:true with settings:null and errors.settings when only settings fails", async () => {
      const { statusTools } = await import("./tools/status.js");
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/devices")) {
          return mockFetchResponse(200, { devices: [{ id: "1" }] });
        }
        return mockFetchResponse(500, "Internal Server Error");
      };

      const handler = findTool(statusTools, "tailscale_status").handler;
      const result = (await handler()) as {
        ok: boolean;
        data: { settings: unknown; deviceCount: number; errors?: Record<string, string> };
      };
      assert.ok(result.ok);
      assert.equal(result.data.settings, null);
      assert.equal(result.data.deviceCount, 1);
      assert.ok(result.data.errors);
      assert.ok(result.data.errors.settings);
      assert.ok(!("devices" in result.data.errors));
    });

    it("should return ok:true with deviceCount:null and errors.devices when only devices fails", async () => {
      const { statusTools } = await import("./tools/status.js");
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/devices")) {
          return mockFetchResponse(500, "Internal Server Error");
        }
        return mockFetchResponse(200, { devicesApprovalOn: true });
      };

      const handler = findTool(statusTools, "tailscale_status").handler;
      const result = (await handler()) as {
        ok: boolean;
        data: { deviceCount: number | null; settings: unknown; errors?: Record<string, string> };
      };
      assert.ok(result.ok);
      assert.equal(result.data.deviceCount, null);
      assert.ok(result.data.settings);
      assert.ok(result.data.errors);
      assert.ok(result.data.errors.devices);
    });

    it("should fast-fail with ok:false when both devices and settings fail (auth likely broken)", async () => {
      const { statusTools } = await import("./tools/status.js");
      globalThis.fetch = async () => mockFetchResponse(401, "Unauthorized");

      const handler = findTool(statusTools, "tailscale_status").handler;
      const result = (await handler()) as { ok: boolean; status: number; error: string };
      assert.equal(result.ok, false);
      assert.equal(result.status, 401);
    });

    it("should report deviceCount:null when devices call succeeds but body lacks a devices array", async () => {
      // Previously this path fell back to `?? 0`, which would have reported
      // "0 devices" -- confidently wrong when the actual count is unknown.
      // Now it reports null so the caller can distinguish "empty tailnet"
      // from "we couldn't tell".
      const { statusTools } = await import("./tools/status.js");
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/devices")) {
          // Succeed but return a body without the `devices` key.
          return mockFetchResponse(200, { somethingElse: true });
        }
        return mockFetchResponse(200, { devicesApprovalOn: true });
      };

      const handler = findTool(statusTools, "tailscale_status").handler;
      const result = (await handler()) as {
        ok: boolean;
        data: { deviceCount: number | null; settings: unknown; errors?: Record<string, string> };
      };
      assert.ok(result.ok);
      assert.equal(result.data.deviceCount, null);
      // No errors entry: the call succeeded, the body shape was just unexpected.
      assert.equal(result.data.errors, undefined);
    });

    it("falls back to `HTTP <status>` for both falsy error shapes -- empty string and undefined", async () => {
      // composeTailnetStatusData writes `devicesRes.error || "HTTP <status>"`,
      // and `||` is load-bearing over `??`. What a real apiGet failure produces
      // is error:"" -- an empty 500 body, which extractErrorMessage returns
      // unchanged -- and "" is not nullish. Under `??` that empty string would
      // go into the errors bag and the status code would be dropped, leaving
      // the caller {"devices":""} with no way to tell a 500 from a 404. An
      // empty-body 5xx from a proxy in front of api.tailscale.com is the
      // realistic trigger; a `||` -> `??` swap is the regression this pins, and
      // the same contract governs the resource fallbacks in server-wiring.ts.
      //
      // Both falsy shapes in one test because `||` collapses them into a single
      // branch: error:"" (reachable through the fetch mock) and error:undefined
      // (not reachable -- apiRequest always sets error on the !ok path, so it
      // takes a hand-built envelope). They were two tests while the source said
      // `??`, where only the undefined arm reached the fallback at all; keeping
      // them apart now would advertise a branch distinction the source no
      // longer has.
      const { composeTailnetStatusData, statusTools } = await import("./tools/status.js");
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/devices")) {
          return mockFetchResponse(500, "");
        }
        return mockFetchResponse(200, { devicesApprovalOn: true });
      };

      const handler = findTool(statusTools, "tailscale_status").handler;
      const result = (await handler()) as {
        ok: boolean;
        data: { deviceCount: number | null; errors?: Record<string, string> };
      };
      assert.ok(result.ok);
      assert.equal(result.data.deviceCount, null);
      assert.ok(result.data.errors);
      assert.equal(result.data.errors?.devices, "HTTP 500", "an empty-string error must not reach the errors bag");

      // The undefined arm, via the exported helper directly.
      const devicesRes = { ok: false as const, status: 500 };
      const settingsRes = { ok: true as const, status: 200, data: { devicesApprovalOn: true } };
      const data = composeTailnetStatusData(devicesRes, settingsRes) as {
        deviceCount: number | null;
        errors?: Record<string, string>;
      };
      assert.equal(data.deviceCount, null);
      assert.ok(data.errors);
      assert.equal(data.errors?.devices, "HTTP 500", "a missing error key must not render as the string undefined");
    });
  });

  describe("tailscale_get_device_posture_attributes", () => {
    it("should call the correct attributes endpoint", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { attributes: {} });
      };

      // posture attributes GET is index 9
      const handler = findTool(deviceTools, "tailscale_get_device_posture_attributes").handler as (input: {
        deviceId: string;
      }) => Promise<unknown>;
      await handler({ deviceId: "dev-123" });
      assert.ok(capturedUrl.includes("/device/dev-123/attributes"));
    });
  });

  describe("tailscale_set_device_posture_attribute", () => {
    it("should POST attribute with value and optional expiry", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      let capturedBody: string | undefined;
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = init?.body as string;
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };

      const handler = findTool(deviceTools, "tailscale_set_device_posture_attribute").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({
        deviceId: "dev-123",
        attributeKey: "custom:audit",
        value: "passed",
        expiry: "2026-12-01T00:00:00Z",
      });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/device/dev-123/attributes/custom%3Aaudit"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.value, "passed");
      assert.equal(parsed.expiry, "2026-12-01T00:00:00Z");
    });

    it("should omit expiry and comment when not provided", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };

      const handler = findTool(deviceTools, "tailscale_set_device_posture_attribute").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ deviceId: "dev-123", attributeKey: "custom:audit", value: "passed" });
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { value: "passed" });
    });

    it("should send comment when provided", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };

      const handler = findTool(deviceTools, "tailscale_set_device_posture_attribute").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({
        deviceId: "dev-123",
        attributeKey: "custom:audit",
        value: "passed",
        expiry: "2026-12-01T00:00:00Z",
        comment: "JIT access for INC-1",
      });
      // deepEqual on the whole body, not just parsed.comment: the batch tool is
      // the only other sender of this field, and a stray key riding along on a
      // POST the spec gives exactly three properties should fail here.
      assert.deepEqual(JSON.parse(capturedBody!), {
        value: "passed",
        expiry: "2026-12-01T00:00:00Z",
        comment: "JIT access for INC-1",
      });
    });

    it("should cap comment at the spec's 200 characters", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const schema = findTool(deviceTools, "tailscale_set_device_posture_attribute").inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      const base = { deviceId: "dev-123", attributeKey: "custom:audit", value: "passed" };
      assert.equal(schema.safeParse({ ...base, comment: "x".repeat(200) }).success, true);
      assert.equal(schema.safeParse({ ...base, comment: "x".repeat(201) }).success, false);
    });
  });

  describe("tailscale_delete_device_posture_attribute", () => {
    it("should DELETE the correct attribute endpoint", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };

      const handler = findTool(deviceTools, "tailscale_delete_device_posture_attribute").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ deviceId: "dev-123", attributeKey: "custom:audit" });
      assert.equal(capturedMethod, "DELETE");
      assert.ok(capturedUrl.includes("/device/dev-123/attributes/custom%3Aaudit"));
    });
  });

  describe("tailscale_get_network_flow_logs", () => {
    it("should call network logging endpoint with params", async () => {
      const { auditTools } = await import("./tools/audit.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { logs: [] });
      };

      const handler = findTool(auditTools, "tailscale_get_network_flow_logs").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      // Pin end so the 30-day range guard doesn't fire as the calendar drifts.
      await handler({ start: "2026-04-01T00:00:00Z", end: "2026-04-15T00:00:00Z" });
      assert.ok(capturedUrl.includes("/logging/network"));
      assert.ok(capturedUrl.includes("start=2026-04-01T00%3A00%3A00Z"));
    });

    it("should reject an invalid RFC3339 start (proves the network-flow tool runs the shared validators)", async () => {
      // The RFC3339/range validators are shared with get_audit_log, but this is
      // a distinct tool/handler -- pin that network-flow actually calls them so a
      // future refactor can't drop the validation on this path silently.
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_network_flow_logs").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "not-a-date" }), { message: /must be a valid RFC3339/ });
    });

    it("should reject an invalid RFC3339 end (the end arm is a separate call site)", async () => {
      // Same gap as the audit tool: `end` has its own `if (input.end)` guard on
      // this handler, and a NaN end slips past assertLogRange silently because
      // every comparison against NaN is false. Pin it per tool -- the two
      // handlers call the validators independently, so covering one proves
      // nothing about the other.
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_network_flow_logs").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "2026-04-01T00:00:00Z", end: "not-a-date" }), {
        message: /^end must be a valid RFC3339/,
      });
    });

    it("should send end = now on a start-only request", async () => {
      // Each handler builds its own query string, the same reasoning the
      // RFC3339 cases above record -- so the audit tool's default-end case
      // proves nothing about this one. Pick a start a few days before now
      // (computed, not literal) so it stays valid and inside the 30-day cap as
      // the calendar drifts.
      const { auditTools } = await import("./tools/audit.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { logs: [] });
      };
      const handler = findTool(auditTools, "tailscale_get_network_flow_logs").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<{ ok: boolean }>;
      const before = Date.now();
      const start = new Date(before - 3 * 24 * 60 * 60 * 1000).toISOString();
      const result = await handler({ start });
      assert.ok(result.ok);
      assert.ok(capturedUrl.includes("/logging/network"));
      assert.ok(capturedUrl.includes("start="));
      // The spec marks `end` required here too, and the Go client's comment
      // reads "Both start and end parameters are required by the server" for
      // this endpoint specifically -- so the omitted case fills it in, at the
      // same second precision the Go client sends.
      const end = new URL(capturedUrl).searchParams.get("end");
      assert.ok(end, `end must be sent even when the caller omits it, got: ${capturedUrl}`);
      assert.match(end, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.ok(Math.abs(Date.parse(end) - before) < 5000, `end=${end} is not within 5s of now`);
    });

    it("should never put an end earlier than start on the wire", async () => {
      // The audit-log twin of this case carries the reasoning. Repeated on this
      // handler because the two call the guard independently, so a fix applied
      // to one leaves the other's inversion in place with nothing to catch it.
      const { auditTools } = await import("./tools/audit.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { logs: [] });
      };
      const handler = findTool(auditTools, "tailscale_get_network_flow_logs").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      let start = new Date().toISOString();
      while (start.endsWith(".000Z")) start = new Date().toISOString();

      let refused = "";
      try {
        await handler({ start });
      } catch (err) {
        refused = err instanceof Error ? err.message : String(err);
        assert.match(refused, /end must be >= start/, "the only acceptable refusal here is the range guard's");
      }
      if (refused) {
        assert.equal(capturedUrl, "", "a range the guard rejected must not reach the wire");
      } else {
        const wireEnd = new URL(capturedUrl).searchParams.get("end") ?? "";
        assert.ok(
          Date.parse(wireEnd) >= Date.parse(start),
          `end=${wireEnd} precedes start=${start} on the wire, which is the API 400 this guard exists to prevent`,
        );
      }
    });
  });

  describe("tailscale_update_webhook (endpoint URL)", () => {
    it("should send only endpointUrl when subscriptions not provided", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { id: "wh-123" });
      };

      const handler = findTool(webhookTools, "tailscale_update_webhook").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ webhookId: "wh-123", endpointUrl: "https://new.example.com/hook" });
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.endpointUrl, "https://new.example.com/hook");
      assert.ok(!("subscriptions" in parsed));
    });
  });

  describe("tailscale_approve_user", () => {
    it("should POST to the approve endpoint", async () => {
      const { userTools } = await import("./tools/users.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };

      const handler = findTool(userTools, "tailscale_approve_user").handler as (input: {
        userId: string;
      }) => Promise<unknown>;
      await handler({ userId: "user-456" });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/users/user-456/approve"));
    });
  });

  describe("tailscale_suspend_user", () => {
    it("should POST to the suspend endpoint", async () => {
      const { userTools } = await import("./tools/users.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };

      const handler = findTool(userTools, "tailscale_suspend_user").handler as (input: {
        userId: string;
      }) => Promise<unknown>;
      await handler({ userId: "user-456" });
      // Suspend/restore are POST-to-a-verb-path, not DELETE/PUT on the user:
      // hitting the same path with the wrong verb is a 405 at best and a
      // different operation at worst, and only the method distinguishes them.
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/users/user-456/suspend"));
    });
  });

  describe("tailscale_restore_user", () => {
    it("should POST to the restore endpoint", async () => {
      const { userTools } = await import("./tools/users.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };

      const handler = findTool(userTools, "tailscale_restore_user").handler as (input: {
        userId: string;
      }) => Promise<unknown>;
      await handler({ userId: "user-456" });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/users/user-456/restore"));
    });
  });

  describe("tailscale_update_user_role", () => {
    it("should POST user role", async () => {
      const { userTools } = await import("./tools/users.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };

      const handler = findTool(userTools, "tailscale_update_user_role").handler as (input: {
        userId: string;
        role: string;
      }) => Promise<unknown>;
      await handler({ userId: "user-456", role: "admin" });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/users/user-456/role"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.role, "admin");
    });
  });

  // ─── Devices: remaining handlers ───

  describe("tailscale_get_device", () => {
    it("should GET /device/{deviceId}", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { id: "dev-1" });
      };
      await (
        findTool(deviceTools, "tailscale_get_device").handler as (input: { deviceId: string }) => Promise<unknown>
      )({ deviceId: "dev-1" });
      // Omitted `fields` sends no query string at all. The tool does not default
      // to 'all', so a caller who asked for nothing keeps getting the default
      // subset rather than serial numbers and endpoints they never requested.
      assert.ok(capturedUrl.endsWith("/device/dev-1"), `expected a bare device URL, got: ${capturedUrl}`);
    });

    it("should send fields=all when asked, and pass the wider record through untouched", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      // Modelled on the spec's Device schema examples: the three groups that only
      // arrive with fields=all (enabledRoutes, clientConnectivity, postureIdentity)
      // alongside a couple of default-set fields, so a regression that started
      // reshaping the body would show up here rather than in a live run.
      const device = {
        id: "92960230385",
        nodeId: "n292kg92CNTRL",
        hostname: "pangolin",
        os: "linux",
        connectedToControl: true,
        enabledRoutes: ["10.0.0.0/16", "192.168.1.0/24"],
        clientConnectivity: {
          endpoints: ["199.9.14.201:59128", "192.68.0.21:59128"],
          mappingVariesByDestIP: false,
        },
        sshEnabled: false,
        postureIdentity: { serialNumbers: ["CP74LFQJXM"] },
      };
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, device);
      };
      const result = (await (
        findTool(deviceTools, "tailscale_get_device").handler as (input: {
          deviceId: string;
          fields?: string;
        }) => Promise<unknown>
      )({ deviceId: "dev-1", fields: "all" })) as { ok: boolean; data: unknown };
      assert.ok(capturedUrl.endsWith("/device/dev-1?fields=all"), `expected ?fields=all, got: ${capturedUrl}`);
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
      assert.deepEqual(result.data, device);
    });

    it("should accept only the two documented fields values", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const schema = findTool(deviceTools, "tailscale_get_device").inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      assert.equal(schema.safeParse({ deviceId: "dev-1" }).success, true);
      assert.equal(schema.safeParse({ deviceId: "dev-1", fields: "all" }).success, true);
      assert.equal(schema.safeParse({ deviceId: "dev-1", fields: "default" }).success, true);
      // The list tool still takes a free string, because its undocumented
      // comma-list form has shipped since the first commit and no live call has
      // settled what the server does with it. get_device is new here, so it
      // starts at the spec's enum and never advertises a form nobody has tried.
      assert.equal(schema.safeParse({ deviceId: "dev-1", fields: "id" }).success, false);
    });
  });

  describe("tailscale_authorize_device", () => {
    it("should POST authorized:true to /device/{id}/authorized", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      await (
        findTool(deviceTools, "tailscale_authorize_device").handler as (input: { deviceId: string }) => Promise<unknown>
      )({ deviceId: "dev-1" });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/device/dev-1/authorized"));
      assert.deepEqual(JSON.parse(capturedBody!), { authorized: true });
    });
  });

  describe("tailscale_deauthorize_device", () => {
    it("should POST authorized:false to /device/{id}/authorized", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedBody: string | undefined;
      let capturedMethod = "";
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      await (
        findTool(deviceTools, "tailscale_deauthorize_device").handler as (input: {
          deviceId: string;
        }) => Promise<unknown>
      )({ deviceId: "dev-1" });
      // The authorize twin above pins POST; this destructive half only checked
      // the body, so a helper swap here would have gone unnoticed.
      assert.equal(capturedMethod, "POST");
      assert.deepEqual(JSON.parse(capturedBody!), { authorized: false });
    });
  });

  describe("tailscale_delete_device", () => {
    it("should DELETE /device/{deviceId}", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      await (
        findTool(deviceTools, "tailscale_delete_device").handler as (input: { deviceId: string }) => Promise<unknown>
      )({ deviceId: "dev-1" });
      assert.equal(capturedMethod, "DELETE");
      assert.ok(capturedUrl.endsWith("/device/dev-1"));
    });
  });

  describe("tailscale_rename_device", () => {
    it("should POST name to /device/{id}/name", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      let capturedBody: string | undefined;
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = init?.body as string;
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      await (
        findTool(deviceTools, "tailscale_rename_device").handler as (input: {
          deviceId: string;
          name: string;
        }) => Promise<unknown>
      )({
        deviceId: "dev-1",
        name: "new-name.tail.ts.net",
      });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/device/dev-1/name"));
      assert.deepEqual(JSON.parse(capturedBody!), { name: "new-name.tail.ts.net" });
    });

    it("should send an empty name as-is, the spec's reset-to-OS-hostname idiom", async () => {
      // The description now advertises name: '' as the way to reset a device's
      // name. That only works if the empty string reaches the API: the usual
      // "drop falsy optional fields" shape elsewhere in this package would send
      // {} here and silently do nothing.
      const { deviceTools } = await import("./tools/devices.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      await (
        findTool(deviceTools, "tailscale_rename_device").handler as (input: {
          deviceId: string;
          name: string;
        }) => Promise<unknown>
      )({ deviceId: "dev-1", name: "" });
      assert.deepEqual(JSON.parse(capturedBody!), { name: "" });
    });

    it("should send a base name unchanged rather than requiring an FQDN", async () => {
      // Per the spec `name` takes either the FQDN or the bare base name. The
      // handler must not try to qualify it -- it has no tailnet DNS suffix to
      // qualify it with.
      const { deviceTools } = await import("./tools/devices.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      await (
        findTool(deviceTools, "tailscale_rename_device").handler as (input: {
          deviceId: string;
          name: string;
        }) => Promise<unknown>
      )({ deviceId: "dev-1", name: "nodename" });
      assert.deepEqual(JSON.parse(capturedBody!), { name: "nodename" });
    });

    it("should accept an empty name at the schema too", async () => {
      // A .min(1) added here would make the documented reset idiom
      // unreachable before a request is ever built.
      const { deviceTools } = await import("./tools/devices.js");
      const schema = findTool(deviceTools, "tailscale_rename_device").inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      assert.equal(schema.safeParse({ deviceId: "dev-1", name: "" }).success, true);
    });
  });

  describe("tailscale_expire_device", () => {
    it("should POST to /device/{id}/expire", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      await (
        findTool(deviceTools, "tailscale_expire_device").handler as (input: { deviceId: string }) => Promise<unknown>
      )({ deviceId: "dev-1" });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/device/dev-1/expire"));
    });
  });

  describe("tailscale_get_device_routes", () => {
    it("should GET /device/{id}/routes", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { advertisedRoutes: [], enabledRoutes: [] });
      };
      await (
        findTool(deviceTools, "tailscale_get_device_routes").handler as (input: {
          deviceId: string;
        }) => Promise<unknown>
      )({ deviceId: "dev-1" });
      assert.ok(capturedUrl.includes("/device/dev-1/routes"));
    });
  });

  describe("tailscale_set_device_routes", () => {
    it("should POST routes to /device/{id}/routes", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      await (
        findTool(deviceTools, "tailscale_set_device_routes").handler as (input: {
          deviceId: string;
          routes: string[];
        }) => Promise<unknown>
      )({
        deviceId: "dev-1",
        routes: ["10.0.0.0/24"],
      });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/device/dev-1/routes"));
      assert.deepEqual(JSON.parse(capturedBody!), { routes: ["10.0.0.0/24"] });
    });
  });

  describe("tailscale_set_device_tags", () => {
    it("should POST tags to /device/{id}/tags", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      let capturedBody: string | undefined;
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = init?.body as string;
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      await (
        findTool(deviceTools, "tailscale_set_device_tags").handler as (input: {
          deviceId: string;
          tags: string[];
        }) => Promise<unknown>
      )({
        deviceId: "dev-1",
        tags: ["tag:server"],
      });
      // Tags are REPLACED wholesale by this call, so the verb is part of the
      // contract the caller relies on.
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/device/dev-1/tags"));
      assert.deepEqual(JSON.parse(capturedBody!), { tags: ["tag:server"] });
    });
  });

  // ─── ACL: preview ───

  describe("tailscale_preview_acl", () => {
    it("should POST policy with type and previewFor query params", async () => {
      const { aclTools } = await import("./tools/acl.js");
      let capturedUrl = "";
      let capturedBody: string | undefined;
      let capturedContentType: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = init?.body as string;
        capturedContentType = new Headers(init?.headers).get("Content-Type") ?? undefined;
        return mockFetchResponse(200, { matches: [] });
      };
      await (
        findTool(aclTools, "tailscale_preview_acl").handler as (input: {
          policy: string;
          type: string;
          previewFor: string;
        }) => Promise<unknown>
      )({
        policy: '{"acls":[]}',
        type: "user",
        previewFor: "user@example.com",
      });
      assert.ok(capturedUrl.includes("/acl/preview"));
      assert.ok(capturedUrl.includes("type=user"));
      assert.ok(capturedUrl.includes("previewFor=user%40example.com"));
      assert.equal(capturedContentType, "application/hujson");
      assert.equal(capturedBody, '{"acls":[]}');
    });
  });

  // ─── DNS: all 11 tools ───

  describe("tailscale_get_nameservers", () => {
    it("should GET /tailnet/{tailnet}/dns/nameservers", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { dns: ["8.8.8.8"] });
      };
      await findTool(dnsTools, "tailscale_get_nameservers").handler();
      assert.ok(capturedUrl.includes("/dns/nameservers"));
    });
  });

  describe("tailscale_set_nameservers", () => {
    it("should POST dns array to /dns/nameservers", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      await (findTool(dnsTools, "tailscale_set_nameservers").handler as (input: { dns: string[] }) => Promise<unknown>)(
        { dns: ["8.8.8.8", "1.1.1.1"] },
      );
      assert.equal(capturedMethod, "POST");
      assert.deepEqual(JSON.parse(capturedBody!), { dns: ["8.8.8.8", "1.1.1.1"] });
    });
  });

  describe("tailscale_get_search_paths", () => {
    it("should GET /dns/searchpaths", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { searchPaths: [] });
      };
      await findTool(dnsTools, "tailscale_get_search_paths").handler();
      assert.ok(capturedUrl.includes("/dns/searchpaths"));
    });
  });

  describe("tailscale_set_search_paths", () => {
    it("should POST searchPaths to /dns/searchpaths", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedBody: string | undefined;
      let capturedMethod = "";
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      await (
        findTool(dnsTools, "tailscale_set_search_paths").handler as (input: {
          searchPaths: string[];
        }) => Promise<unknown>
      )({
        searchPaths: ["corp.example.com"],
      });
      // The DNS setters do not share one verb (POST here, PUT for set_split_dns,
      // PATCH for update_split_dns), so it cannot be inferred from the module --
      // only the api.ts helper the handler picked decides it.
      assert.equal(capturedMethod, "POST");
      assert.deepEqual(JSON.parse(capturedBody!), { searchPaths: ["corp.example.com"] });
    });
  });

  describe("tailscale_get_split_dns", () => {
    it("should GET /dns/split-dns", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, {});
      };
      await findTool(dnsTools, "tailscale_get_split_dns").handler();
      assert.ok(capturedUrl.includes("/dns/split-dns"));
    });
  });

  describe("tailscale_set_split_dns", () => {
    it("should PUT the split DNS map directly to /dns/split-dns", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedBody: string | undefined;
      let capturedMethod = "";
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      await (
        findTool(dnsTools, "tailscale_set_split_dns").handler as (input: {
          splitDns: Record<string, string[]>;
        }) => Promise<unknown>
      )({
        splitDns: { "corp.example.com": ["10.0.0.1"] },
      });
      // PUT (replace the whole map), not the PATCH that update_split_dns uses to
      // merge. This test was titled "should POST" and asserted neither, which is
      // exactly how a replace/merge mixup ships unnoticed.
      assert.equal(capturedMethod, "PUT");
      assert.deepEqual(JSON.parse(capturedBody!), { "corp.example.com": ["10.0.0.1"] });
    });
  });

  describe("tailscale_get_dns_preferences", () => {
    it("should GET /dns/preferences", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { magicDNS: true });
      };
      await findTool(dnsTools, "tailscale_get_dns_preferences").handler();
      assert.ok(capturedUrl.includes("/dns/preferences"));
    });
  });

  describe("tailscale_set_dns_preferences", () => {
    it("should POST magicDNS to /dns/preferences", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedBody: string | undefined;
      let capturedMethod = "";
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      await (
        findTool(dnsTools, "tailscale_set_dns_preferences").handler as (input: {
          magicDNS: boolean;
        }) => Promise<unknown>
      )({ magicDNS: false });
      assert.equal(capturedMethod, "POST");
      assert.deepEqual(JSON.parse(capturedBody!), { magicDNS: false });
    });
  });

  describe("tailscale_set_dns_configuration validation", () => {
    it("should reject empty input (no fields provided)", async () => {
      // Mirrors the guard on tailscale_update_tailnet_settings — POSTing {} to
      // the unified setter is almost always a mistake, and the API surfaces a
      // terse 400 if we let it through.
      const { dnsTools } = await import("./tools/dns.js");
      const handler = findTool(dnsTools, "tailscale_set_dns_configuration").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({}), { message: /No fields to update/ });
    });

    it("should accept input with at least one field", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(dnsTools, "tailscale_set_dns_configuration").handler as (
        input: Record<string, unknown>,
      ) => Promise<{ ok: boolean }>;
      const result = await handler({ magicDNS: true });
      assert.ok(result.ok);
      assert.deepEqual(JSON.parse(capturedBody!), { magicDNS: true });
    });
  });

  // ─── Keys: list, get, delete ───

  describe("tailscale_list_keys", () => {
    it("should GET /tailnet/{tailnet}/keys", async () => {
      const { keyTools } = await import("./tools/keys.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { keys: [] });
      };
      await findTool(keyTools, "tailscale_list_keys").handler({});
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/keys"));
    });

    it("should append ?all=true when all is set", async () => {
      // Default ({}) sends no query string, so the API returns the
      // credential-dependent set rather than every key in the tailnet. Setting
      // all:true must add ?all=true to get the tailnet-wide list -- pins the
      // only conditional in the list_keys handler.
      const { keyTools } = await import("./tools/keys.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { keys: [] });
      };
      await (findTool(keyTools, "tailscale_list_keys").handler as (input: { all?: boolean }) => Promise<unknown>)({
        all: true,
      });
      assert.ok(capturedUrl.includes("/keys?all=true"), `expected ?all=true, got: ${capturedUrl}`);
    });
  });

  describe("tailscale_get_key", () => {
    it("should GET /tailnet/{tailnet}/keys/{keyId}", async () => {
      const { keyTools } = await import("./tools/keys.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { id: "k-1" });
      };
      await (findTool(keyTools, "tailscale_get_key").handler as (input: { keyId: string }) => Promise<unknown>)({
        keyId: "k-1",
      });
      assert.ok(capturedUrl.includes("/keys/k-1"));
    });
  });

  describe("tailscale_delete_key", () => {
    it("should DELETE /tailnet/{tailnet}/keys/{keyId}", async () => {
      const { keyTools } = await import("./tools/keys.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      await (findTool(keyTools, "tailscale_delete_key").handler as (input: { keyId: string }) => Promise<unknown>)({
        keyId: "k-1",
      });
      assert.equal(capturedMethod, "DELETE");
      assert.ok(capturedUrl.includes("/keys/k-1"));
    });
  });

  // ─── Users: list, get ───

  describe("tailscale_list_users", () => {
    it("should GET /tailnet/{tailnet}/users", async () => {
      const { userTools } = await import("./tools/users.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { users: [] });
      };
      await findTool(userTools, "tailscale_list_users").handler({});
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/users"));
    });
  });

  describe("tailscale_get_user", () => {
    it("should GET /users/{userId}", async () => {
      const { userTools } = await import("./tools/users.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { id: "u-1" });
      };
      await (findTool(userTools, "tailscale_get_user").handler as (input: { userId: string }) => Promise<unknown>)({
        userId: "u-1",
      });
      assert.ok(capturedUrl.endsWith("/users/u-1"));
    });
  });

  // ─── Tailnet: get_settings, get_contacts ───

  describe("tailscale_get_tailnet_settings", () => {
    it("should GET /tailnet/{tailnet}/settings", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { devicesApprovalOn: false });
      };
      await findTool(tailnetTools, "tailscale_get_tailnet_settings").handler();
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/settings"));
    });
  });

  describe("tailscale_get_contacts", () => {
    it("should GET /tailnet/{tailnet}/contacts", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, {});
      };
      await findTool(tailnetTools, "tailscale_get_contacts").handler();
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/contacts"));
    });
  });

  // ─── Webhooks: list, get, create, delete ───

  describe("tailscale_list_webhooks", () => {
    it("should GET /tailnet/{tailnet}/webhooks", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { webhooks: [] });
      };
      await findTool(webhookTools, "tailscale_list_webhooks").handler();
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/webhooks"));
    });
  });

  describe("tailscale_get_webhook", () => {
    it("should GET /webhooks/{webhookId}", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { id: "wh-1" });
      };
      await (
        findTool(webhookTools, "tailscale_get_webhook").handler as (input: { webhookId: string }) => Promise<unknown>
      )({ webhookId: "wh-1" });
      assert.ok(capturedUrl.endsWith("/webhooks/wh-1"));
    });
  });

  describe("tailscale_create_webhook", () => {
    it("should POST endpointUrl and subscriptions to /tailnet/{tailnet}/webhooks", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { id: "wh-new" });
      };
      await (
        findTool(webhookTools, "tailscale_create_webhook").handler as (input: {
          endpointUrl: string;
          subscriptions: string[];
        }) => Promise<unknown>
      )({
        endpointUrl: "https://example.com/hook",
        subscriptions: ["nodeCreated"],
      });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/webhooks"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.endpointUrl, "https://example.com/hook");
      assert.deepEqual(parsed.subscriptions, ["nodeCreated"]);
    });
  });

  describe("tailscale_delete_webhook", () => {
    it("should DELETE /webhooks/{webhookId}", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      await (
        findTool(webhookTools, "tailscale_delete_webhook").handler as (input: { webhookId: string }) => Promise<unknown>
      )({ webhookId: "wh-1" });
      assert.equal(capturedMethod, "DELETE");
      assert.ok(capturedUrl.endsWith("/webhooks/wh-1"));
    });
  });

  // ─── Posture integrations: all 4 ───

  describe("tailscale_list_posture_integrations", () => {
    it("should GET /tailnet/{tailnet}/posture/integrations", async () => {
      const { postureTools } = await import("./tools/posture.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { integrations: [] });
      };
      await findTool(postureTools, "tailscale_list_posture_integrations").handler();
      assert.ok(capturedUrl.includes("/posture/integrations"));
    });
  });

  describe("tailscale_get_posture_integration", () => {
    it("should GET /posture/integrations/{id}", async () => {
      const { postureTools } = await import("./tools/posture.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { id: "pi-1" });
      };
      await (
        findTool(postureTools, "tailscale_get_posture_integration").handler as (input: {
          integrationId: string;
        }) => Promise<unknown>
      )({
        integrationId: "pi-1",
      });
      // Single-integration endpoints live at /posture/integrations/{id}, NOT under /tailnet/
      assert.ok(capturedUrl.endsWith("/posture/integrations/pi-1"));
      assert.ok(!capturedUrl.includes("/tailnet/"));
    });
  });

  describe("tailscale_create_posture_integration", () => {
    it("should POST provider config to /tailnet/{tailnet}/posture/integrations with cloudId", async () => {
      const { postureTools } = await import("./tools/posture.js");
      let capturedMethod = "";
      let capturedUrl = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { id: "pi-new" });
      };
      await (
        findTool(postureTools, "tailscale_create_posture_integration").handler as (
          input: Record<string, unknown>,
        ) => Promise<unknown>
      )({
        provider: "intune",
        clientId: "cs-id",
        clientSecret: "cs-secret",
        tenantId: "tenant-1",
        cloudId: "global",
      });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/posture/integrations"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.provider, "intune");
      assert.equal(parsed.clientId, "cs-id");
      assert.equal(parsed.clientSecret, "cs-secret");
      assert.equal(parsed.tenantId, "tenant-1");
      assert.equal(parsed.cloudId, "global");
      assert.ok(!("cloudEnvironment" in parsed));
    });

    it("should omit clientId/tenantId/cloudId when only provider + clientSecret are given", async () => {
      // Providers like Kolide leave clientId/tenantId/cloudId blank. Each is
      // guarded by an `if (input.X !== undefined)` arm; with the optionals
      // omitted those arms are false and the keys must NOT appear in the body
      // (sending empty strings would be a different, API-rejectable shape).
      const { postureTools } = await import("./tools/posture.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { id: "pi-new" });
      };
      await (
        findTool(postureTools, "tailscale_create_posture_integration").handler as (
          input: Record<string, unknown>,
        ) => Promise<unknown>
      )({
        provider: "kolide",
        clientSecret: "kolide-token",
      });
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.provider, "kolide");
      assert.equal(parsed.clientSecret, "kolide-token");
      assert.ok(!("clientId" in parsed), "clientId must be omitted when not provided");
      assert.ok(!("tenantId" in parsed), "tenantId must be omitted when not provided");
      assert.ok(!("cloudId" in parsed), "cloudId must be omitted when not provided");
    });
  });

  describe("tailscale_update_posture_integration", () => {
    it("should PATCH /posture/integrations/{id}", async () => {
      const { postureTools } = await import("./tools/posture.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      await (
        findTool(postureTools, "tailscale_update_posture_integration").handler as (
          input: Record<string, unknown>,
        ) => Promise<unknown>
      )({
        integrationId: "pi-1",
        clientId: "new-id",
        clientSecret: "new-secret",
      });
      assert.equal(capturedMethod, "PATCH");
      assert.ok(capturedUrl.endsWith("/posture/integrations/pi-1"));
      assert.ok(!capturedUrl.includes("/tailnet/"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.clientId, "new-id");
      assert.equal(parsed.clientSecret, "new-secret");
      assert.ok(!("integrationId" in parsed));
    });

    it("should include tenantId and cloudId in the PATCH body when set", async () => {
      // The happy path above only sets clientId+clientSecret. tenantId and
      // cloudId each have their own `!== undefined` arm in the handler; pin that
      // both flow through (and that integrationId stays in the URL, not the body).
      const { postureTools } = await import("./tools/posture.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      await (
        findTool(postureTools, "tailscale_update_posture_integration").handler as (
          input: Record<string, unknown>,
        ) => Promise<unknown>
      )({
        integrationId: "pi-1",
        tenantId: "tenant-2",
        cloudId: "us-gov",
      });
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.tenantId, "tenant-2");
      assert.equal(parsed.cloudId, "us-gov");
      assert.ok(!("integrationId" in parsed));
    });
  });

  describe("tailscale_delete_posture_integration", () => {
    it("should DELETE /posture/integrations/{id}", async () => {
      const { postureTools } = await import("./tools/posture.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      await (
        findTool(postureTools, "tailscale_delete_posture_integration").handler as (input: {
          integrationId: string;
        }) => Promise<unknown>
      )({
        integrationId: "pi-1",
      });
      assert.equal(capturedMethod, "DELETE");
      assert.ok(capturedUrl.endsWith("/posture/integrations/pi-1"));
      assert.ok(!capturedUrl.includes("/tailnet/"));
    });
  });

  describe("tailscale_rotate_webhook_secret", () => {
    it("should POST /webhooks/{id}/rotate", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, { newSecret: "whsec_new123" });
      };
      await (
        findTool(webhookTools, "tailscale_rotate_webhook_secret").handler as (input: {
          webhookId: string;
        }) => Promise<unknown>
      )({ webhookId: "wh-1" });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/webhooks/wh-1/rotate"));
    });
  });

  // ─── Validation ───

  describe("tailscale_set_device_tags validation", () => {
    it("should reject tags without tag: prefix", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const handler = findTool(deviceTools, "tailscale_set_device_tags").handler as (input: {
        deviceId: string;
        tags: string[];
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ deviceId: "dev-1", tags: ["server", "tag:valid"] }), {
        message: /must start with 'tag:'/,
      });
    });
  });

  describe("tailscale_set_device_posture_attribute validation", () => {
    it("should reject attribute keys without custom: prefix", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const handler = findTool(deviceTools, "tailscale_set_device_posture_attribute").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ deviceId: "dev-1", attributeKey: "badKey", value: "v" }), {
        message: /must start with 'custom:'/,
      });
    });
  });

  describe("tailscale_delete_device_posture_attribute validation", () => {
    it("should reject attribute keys without custom: prefix", async () => {
      // Mirrors the set_device_posture_attribute guard above: delete also rejects
      // non-custom keys client-side so an agent can't try to remove a
      // system-managed attribute (which the API would refuse with a terse error).
      const { deviceTools } = await import("./tools/devices.js");
      const handler = findTool(deviceTools, "tailscale_delete_device_posture_attribute").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ deviceId: "dev-1", attributeKey: "badKey" }), {
        message: /must start with 'custom:'/,
      });
    });
  });

  describe("tailscale_batch_update_posture_attributes", () => {
    it("should PATCH body wrapped in {nodes:...} to /tailnet/{tailnet}/device-attributes", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(deviceTools, "tailscale_batch_update_posture_attributes").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({
        nodes: {
          "dev-a": { "custom:compliant": { value: true } },
          "dev-b": { "custom:flag": { value: "ok", expiry: "2026-12-01T00:00:00Z" } },
          "dev-c": { "custom:old": null },
        },
        comment: "bulk update",
      });
      assert.equal(capturedMethod, "PATCH");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/device-attributes"));
      const parsed = JSON.parse(capturedBody!);
      assert.ok(parsed.nodes, "body must be wrapped in {nodes:...}");
      assert.deepEqual(parsed.nodes["dev-a"], { "custom:compliant": { value: true } });
      assert.deepEqual(parsed.nodes["dev-b"], { "custom:flag": { value: "ok", expiry: "2026-12-01T00:00:00Z" } });
      assert.equal(parsed.nodes["dev-c"]["custom:old"], null);
      assert.equal(parsed.comment, "bulk update");
    });

    it("should reject attribute keys without custom: prefix", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const handler = findTool(deviceTools, "tailscale_batch_update_posture_attributes").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ nodes: { "dev-a": { badKey: { value: "v" } } } }), {
        message: /must start with 'custom:'/,
      });
    });
  });

  describe("tailscale_get_audit_log validation", () => {
    it("should reject invalid RFC3339 start date", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "not-a-date" }), { message: /must be a valid RFC3339/ });
    });

    it("should reject invalid RFC3339 end date", async () => {
      // Every other case in this describe feeds a bad `start`, leaving the
      // `if (input.end) assertRFC3339(input.end, "end")` arm unexercised -- and
      // assertLogRange below it cannot cover for a drop: Date.parse("not-a-date")
      // is NaN, and both `endMs < startMs` and the 30-day comparison are false
      // for NaN, so garbage would be forwarded to the API unchecked. Anchoring
      // on "end must be" (not just /must be a valid RFC3339/) is what proves the
      // end arm fired rather than the already-covered start arm.
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "2026-04-01T00:00:00Z", end: "not-a-date" }), {
        message: /^end must be a valid RFC3339/,
      });
    });

    it("should reject RFC3339 missing timezone designator", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      // No trailing Z or +hh:mm — previous prefix-only check would accept this
      await assert.rejects(() => handler({ start: "2026-04-01T00:00:00" }), { message: /must be a valid RFC3339/ });
    });

    it("should reject RFC3339 with impossible month", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "2026-13-01T00:00:00Z" }), { message: /must be a valid RFC3339/ });
    });

    it("should accept RFC3339 with fractional seconds and offset", async () => {
      const { auditTools } = await import("./tools/audit.js");
      globalThis.fetch = async () => mockFetchResponse(200, { logs: [] });
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<{ ok: boolean }>;
      // Pin end so the 30-day range guard doesn't fire as the calendar drifts.
      const result = await handler({
        start: "2026-04-01T00:00:00.123-05:00",
        end: "2026-04-15T00:00:00.000-05:00",
      });
      assert.ok(result.ok);
    });

    it("should reject RFC3339 with Feb 29 in a non-leap year", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      // 2026 is not a leap year — Date.parse silently coerces this to Mar 1
      await assert.rejects(() => handler({ start: "2026-02-29T00:00:00Z" }), { message: /must be a valid RFC3339/ });
    });

    it("should accept RFC3339 with Feb 29 in a leap year", async () => {
      const { auditTools } = await import("./tools/audit.js");
      globalThis.fetch = async () => mockFetchResponse(200, { logs: [] });
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<{ ok: boolean }>;
      // Pin end so the 30-day range guard doesn't fire (2024 start vs now would exceed).
      const result = await handler({ start: "2024-02-29T00:00:00Z", end: "2024-03-01T00:00:00Z" });
      assert.ok(result.ok);
    });

    it("should reject RFC3339 with Apr 31 (April has 30 days)", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "2026-04-31T00:00:00Z" }), { message: /must be a valid RFC3339/ });
    });

    it("should accept RFC3339 with a 4-digit small year (no Date.UTC 1900 shift)", async () => {
      // Date.UTC(99, ...) silently maps to year 1999 (legacy ECMAScript behavior),
      // which would wrongly reject valid RFC3339 dates with small years like 0099.
      // Round-tripping through the string-form Date constructor preserves the
      // literal year. Realistic Tailscale audit timestamps don't hit this, but
      // the validator is general-purpose.
      const { auditTools } = await import("./tools/audit.js");
      globalThis.fetch = async () => mockFetchResponse(200, { logs: [] });
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<{ ok: boolean }>;
      // Pin both ends so the 30-day range guard doesn't fire.
      const result = await handler({ start: "0099-01-01T00:00:00Z", end: "0099-01-15T00:00:00Z" });
      assert.ok(result.ok);
    });
  });

  // ─── Invites ───

  describe("tailscale_list_device_invites", () => {
    it("should GET /device/{deviceId}/device-invites", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, []);
      };
      const handler = findTool(inviteTools, "tailscale_list_device_invites").handler as (input: {
        deviceId: string;
      }) => Promise<unknown>;
      await handler({ deviceId: "dev-123" });
      assert.ok(capturedUrl.includes("/device/dev-123/device-invites"));
    });
  });

  describe("tailscale_create_user_invite", () => {
    it("should POST /tailnet/{tailnet}/user-invites", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { id: "inv-1" });
      };
      await (
        findTool(inviteTools, "tailscale_create_user_invite").handler as (
          input: Record<string, unknown>,
        ) => Promise<unknown>
      )({
        email: "user@example.com",
        role: "admin",
      });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/user-invites"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.email, "user@example.com");
      assert.equal(parsed.role, "admin");
    });
  });

  describe("tailscale_set_split_dns", () => {
    it("should use PUT method", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedMethod = "";
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      await (
        findTool(dnsTools, "tailscale_set_split_dns").handler as (input: {
          splitDns: Record<string, string[]>;
        }) => Promise<unknown>
      )({
        splitDns: { "example.com": ["10.0.0.1"] },
      });
      assert.equal(capturedMethod, "PUT");
    });
  });

  describe("tailscale_set_devices_authorized (bulk)", () => {
    it("should POST authorized:true to /device/{id}/authorized for every id in parallel", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const calls: { url: string; method: string; body: unknown }[] = [];
      let active = 0;
      let peak = 0;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, method: init?.method ?? "GET", body: JSON.parse(init?.body as string) });
        active--;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(deviceTools, "tailscale_set_devices_authorized").handler as (
        input: Record<string, unknown>,
      ) => Promise<{ ok: boolean; data: { succeeded: string[]; failed: Record<string, unknown> } }>;
      const result = await handler({ deviceIds: ["a", "b", "c"], authorized: true });
      assert.ok(result.ok);
      assert.equal(calls.length, 3);
      assert.deepEqual(result.data.succeeded.sort(), ["a", "b", "c"]);
      assert.equal(Object.keys(result.data.failed).length, 0);
      assert.ok(peak >= 2, `expected parallel execution, peak=${peak}`);
      assert.deepEqual(calls[0].body, { authorized: true });
      // Assert the verb on EVERY fan-out call, not just calls[0]: this is the
      // bulk destructive tool, and the per-id loop is where a helper swap would
      // hide behind an aggregate result that still reports ok.
      assert.ok(
        calls.every((c) => c.method === "POST"),
        `expected every call to be POST, got: ${calls.map((c) => c.method).join(",")}`,
      );
    });

    it("should return per-id failures alongside successes when some calls fail", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/device/bad/")) return mockFetchResponse(404, "device not found");
        return mockFetchResponse(200, {});
      };
      const handler = findTool(deviceTools, "tailscale_set_devices_authorized").handler as (
        input: Record<string, unknown>,
      ) => Promise<{ ok: boolean; data: { succeeded: string[]; failed: Record<string, { status: number }> } }>;
      const result = await handler({ deviceIds: ["good", "bad"], authorized: false });
      assert.ok(result.ok);
      assert.deepEqual(result.data.succeeded, ["good"]);
      assert.equal(result.data.failed.bad.status, 404);
    });

    it("should fail-hard when ALL ids fail", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      globalThis.fetch = async () => mockFetchResponse(404, "not found");
      const handler = findTool(deviceTools, "tailscale_set_devices_authorized").handler as (
        input: Record<string, unknown>,
      ) => Promise<{ ok: boolean; status: number }>;
      const result = await handler({ deviceIds: ["x", "y"], authorized: true });
      assert.equal(result.ok, false);
      assert.equal(result.status, 404);
    });

    it("should dedupe duplicate device ids", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(deviceTools, "tailscale_set_devices_authorized").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ deviceIds: ["a", "a", "a", "b"], authorized: true });
      assert.equal(callCount, 2);
    });
  });

  describe("tailscale_set_contacts (parallel)", () => {
    it("should fan out per-type PATCHes in parallel", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      let active = 0;
      let peak = 0;
      const urls: string[] = [];
      globalThis.fetch = async (input: RequestInfo | URL) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        urls.push(typeof input === "string" ? input : input.toString());
        active--;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(tailnetTools, "tailscale_set_contacts").handler as (
        input: Record<string, unknown>,
      ) => Promise<{ ok: boolean }>;
      const result = await handler({
        account: { email: "a@example.com" },
        support: { email: "s@example.com" },
        security: { email: "sec@example.com" },
      });
      assert.ok(result.ok);
      assert.equal(urls.length, 3);
      assert.ok(peak >= 2, `expected parallel PATCHes, peak=${peak}`);
    });

    it("should reject non-email values at the Zod schema level", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      const tool = findTool(tailnetTools, "tailscale_set_contacts");
      const parsed = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      assert.equal(parsed.safeParse({ security: { email: "not-an-email" } }).success, false);
      assert.equal(parsed.safeParse({ security: { email: "ok@example.com" } }).success, true);
    });

    it("should reject empty input with a no-fields-to-update error", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      const handler = findTool(tailnetTools, "tailscale_set_contacts").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({}), { message: /No fields to update/ });
    });
  });

  describe("Email/URL/CIDR/IPv4 validators", () => {
    it("create_user_invite rejects malformed email", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      const tool = findTool(inviteTools, "tailscale_create_user_invite");
      const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      assert.equal(schema.safeParse({ email: "not-an-email" }).success, false);
      assert.equal(schema.safeParse({ email: "ok@example.com" }).success, true);
      assert.equal(schema.safeParse({}).success, true, "email is optional");
    });

    it("create_webhook rejects http:// endpointUrl", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      const tool = findTool(webhookTools, "tailscale_create_webhook");
      const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      assert.equal(
        schema.safeParse({ endpointUrl: "http://example.com/hook", subscriptions: ["nodeCreated"] }).success,
        false,
      );
      assert.equal(
        schema.safeParse({ endpointUrl: "https://example.com/hook", subscriptions: ["nodeCreated"] }).success,
        true,
      );
    });

    it("update_webhook rejects http:// endpointUrl (same shared schema as create)", async () => {
      // Pins that the shared endpointUrlSchema is wired into BOTH create and
      // update -- if someone unwittingly inlines a different URL schema on
      // the update side, this catches it.
      const { webhookTools } = await import("./tools/webhooks.js");
      const tool = findTool(webhookTools, "tailscale_update_webhook");
      const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      assert.equal(schema.safeParse({ webhookId: "w", endpointUrl: "http://example.com/hook" }).success, false);
      assert.equal(schema.safeParse({ webhookId: "w", endpointUrl: "https://example.com/hook" }).success, true);
    });

    it("create_webhook rejects an https-prefixed but unparseable endpointUrl", async () => {
      // The startsWith("https://") refine alone would pass these; only
      // z.url()'s WHATWG-URL validity check rejects them. Pins that the base
      // URL check survives -- a regression to plain z.string() would pass
      // every other webhook URL test (http:// is caught by the refine) while
      // letting garbage through to a terse Tailscale 400.
      const { webhookTools } = await import("./tools/webhooks.js");
      const tool = findTool(webhookTools, "tailscale_create_webhook");
      const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      assert.equal(schema.safeParse({ endpointUrl: "https://", subscriptions: ["nodeCreated"] }).success, false);
      assert.equal(
        schema.safeParse({ endpointUrl: "https://exa mple.com/hook", subscriptions: ["nodeCreated"] }).success,
        false,
      );
    });

    it("set_device_ip rejects an IPv6 address in the ipv4 field", async () => {
      // The realistic agent mistake: grabbing the device's v6 address from
      // tailscale_list_devices output and passing it here. The generic
      // "not-an-ip" case would not catch a regression to a loose IP check
      // that accepts both families.
      const { deviceTools } = await import("./tools/devices.js");
      const tool = findTool(deviceTools, "tailscale_set_device_ip");
      const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      assert.equal(schema.safeParse({ deviceId: "d", ipv4: "fd7a:115c:a1e0::1" }).success, false);
    });

    it("create_webhook rejects empty subscriptions array", async () => {
      // An empty list is a useless webhook — guard at the schema instead of
      // letting the API return a terse 400.
      const { webhookTools } = await import("./tools/webhooks.js");
      const tool = findTool(webhookTools, "tailscale_create_webhook");
      const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      assert.equal(schema.safeParse({ endpointUrl: "https://example.com/hook", subscriptions: [] }).success, false);
    });

    it("update_webhook rejects empty subscriptions when provided, allows omitted", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      const tool = findTool(webhookTools, "tailscale_update_webhook");
      const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      assert.equal(schema.safeParse({ webhookId: "w", subscriptions: [] }).success, false);
      assert.equal(schema.safeParse({ webhookId: "w", subscriptions: ["nodeCreated"] }).success, true);
      assert.equal(
        schema.safeParse({ webhookId: "w", endpointUrl: "https://x.example.com/h" }).success,
        true,
        "omitting subscriptions should still be valid",
      );
    });

    it("set_device_routes rejects non-CIDR strings", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const tool = findTool(deviceTools, "tailscale_set_device_routes");
      const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      assert.equal(schema.safeParse({ deviceId: "d", routes: ["10.0.0.0/24"] }).success, true);
      assert.equal(schema.safeParse({ deviceId: "d", routes: ["10.0.0.0"] }).success, false);
    });

    it("set_device_ip rejects non-IPv4 strings", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const tool = findTool(deviceTools, "tailscale_set_device_ip");
      const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      assert.equal(schema.safeParse({ deviceId: "d", ipv4: "100.64.0.1" }).success, true);
      assert.equal(schema.safeParse({ deviceId: "d", ipv4: "not-an-ip" }).success, false);
    });

    it("set_log_stream_config caps uploadPeriodMinutes at 1440", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      const tool = findTool(logStreamingTools, "tailscale_set_log_stream_config");
      const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      assert.equal(
        schema.safeParse({
          logType: "configuration",
          destinationType: "axiom",
          url: "https://api.axiom.co/v1/datasets/x/ingest",
          token: "tok",
          uploadPeriodMinutes: 9999,
        }).success,
        false,
      );
      assert.equal(
        schema.safeParse({
          logType: "configuration",
          destinationType: "axiom",
          url: "https://api.axiom.co/v1/datasets/x/ingest",
          token: "tok",
          uploadPeriodMinutes: 60,
        }).success,
        true,
      );
    });

    it("update_service rejects ports outside 1-65535 and non-integer values", async () => {
      // Without the int+range constraint the schema accepted any number, so the
      // agent would round-trip through Tailscale's API and get a terse 400. The
      // tightened schema surfaces the same failure synchronously with a useful
      // message.
      const { serviceTools } = await import("./tools/services.js");
      const tool = findTool(serviceTools, "tailscale_update_service");
      const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
      const base = { serviceName: "svc:web" };
      assert.equal(
        schema.safeParse({ ...base, ports: [{ protocol: "tcp", port: 0 }] }).success,
        false,
        "port=0 must be rejected",
      );
      assert.equal(
        schema.safeParse({ ...base, ports: [{ protocol: "tcp", port: -1 }] }).success,
        false,
        "negative port must be rejected",
      );
      assert.equal(
        schema.safeParse({ ...base, ports: [{ protocol: "tcp", port: 65536 }] }).success,
        false,
        "port=65536 must be rejected",
      );
      assert.equal(
        schema.safeParse({ ...base, ports: [{ protocol: "tcp", port: 8080.5 }] }).success,
        false,
        "fractional port must be rejected",
      );
      assert.equal(
        schema.safeParse({ ...base, ports: [{ protocol: "tcp", port: 443 }] }).success,
        true,
        "443 must be accepted",
      );
      assert.equal(
        schema.safeParse({ ...base, ports: [{ protocol: "udp", port: 65535 }] }).success,
        true,
        "65535 (max) must be accepted",
      );
      assert.equal(
        schema.safeParse({ ...base, ports: [{ protocol: "tcp", port: 1 }] }).success,
        true,
        "1 (min) must be accepted",
      );
    });
  });

  // Two side effects share one hint, so the title names both. A send is the
  // original case -- calling it twice delivers twice -- and a mint joined it
  // when tailscale_create_aws_external_id landed here: calling it twice yields
  // two different IDs. "send-side-effect tools" stopped describing the block
  // the moment the mint arrived.
  describe("Idempotent hints on tools that send or mint", () => {
    it("test_webhook is NOT marked idempotent", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      assert.equal(findTool(webhookTools, "tailscale_test_webhook").annotations.idempotentHint, false);
    });
    it("resend_device_invite is NOT marked idempotent", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      assert.equal(findTool(inviteTools, "tailscale_resend_device_invite").annotations.idempotentHint, false);
    });
    it("resend_user_invite is NOT marked idempotent", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      assert.equal(findTool(inviteTools, "tailscale_resend_user_invite").annotations.idempotentHint, false);
    });
    it("resend_contact_verification is NOT marked idempotent", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      assert.equal(findTool(tailnetTools, "tailscale_resend_contact_verification").annotations.idempotentHint, false);
    });
    it("create_aws_external_id is NOT marked idempotent", async () => {
      // A static hint has to hold for every accepted input: reusable:false
      // mints a distinct ID by design, and even reusable:true mints a new one
      // once the previous ID has been linked to an AWS account.
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      assert.equal(findTool(logStreamingTools, "tailscale_create_aws_external_id").annotations.idempotentHint, false);
    });
  });

  describe("tailscale_get_audit_log (range cap)", () => {
    it("should reject ranges > 30 days", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "2026-01-01T00:00:00Z", end: "2026-03-01T00:00:00Z" }), {
        message: /30-day Tailscale API limit/,
      });
    });

    it("should reject end < start", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "2026-04-01T00:00:00Z", end: "2026-01-01T00:00:00Z" }), {
        message: /end must be >= start/,
      });
    });

    it("should accept a 30-day range", async () => {
      const { auditTools } = await import("./tools/audit.js");
      globalThis.fetch = async () => mockFetchResponse(200, { logs: [] });
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<{ ok: boolean }>;
      const result = await handler({ start: "2026-01-01T00:00:00Z", end: "2026-01-31T00:00:00Z" });
      assert.ok(result.ok);
    });

    it("should reject 30 days + 1ms (exclusive boundary)", async () => {
      // The accept-30-day test above pins the inclusive side of the boundary;
      // this pins the exclusive side, so a future "the API actually accepts
      // 31 days now" change has to update one constant AND flip a test rather
      // than just bumping the constant.
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T00:00:00.001Z" }), {
        message: /30-day Tailscale API limit/,
      });
    });

    // The two cases below are the only ones in the suite that reach a FAILING
    // range through assertLogRange's `end ? Date.parse(end) : Date.now()`
    // default. Every other guard test passes an explicit `end`, and the one
    // start-only test is a 3-day window that cannot trip either guard -- so
    // mutating the default to `Date.parse(end ?? start)` makes every end-less
    // query a zero-length range that sails past both guards, and the suite
    // stays green. An end-less call is also the natural agent shape ("the
    // audit log for this year") and the only one with an unbounded window.
    //
    // Both starts are fixed literals rather than offsets from Date.now(), and
    // both are drift-proof BECAUSE the comparison is against the real current
    // time: a deep-past start only slides further over the cap, and a
    // year-9999 start stays ahead of now. A near-future literal (2027) would
    // not -- once the calendar passes it, it stops testing end<start and
    // becomes another 30-day-cap case.
    it("should reject an over-cap range when end is omitted", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      // Match the per-guard wording plus the end=<now> marker: a message-agnostic
      // rejects would also pass on the end<start guard and lose the distinction.
      await assert.rejects(() => handler({ start: "2020-01-01T00:00:00Z" }), {
        message: /30-day Tailscale API limit.*end=<now>/,
      });
    });

    it("should reject end < start when end is omitted", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "9999-01-01T00:00:00Z" }), {
        message: /end must be >= start.*end=<now>/,
      });
    });
  });

  describe("tailscale_get_network_flow_logs (range cap)", () => {
    // Mirrors the two end-less cases above on the other tool. assertLogRange is
    // shared, but each handler calls it independently -- the same reasoning the
    // RFC3339 cases in this file already record -- so a refactor that dropped
    // the call on one path would leave the other's tests green.
    it("should reject an over-cap range when end is omitted", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_network_flow_logs").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "2020-01-01T00:00:00Z" }), {
        message: /30-day Tailscale API limit.*end=<now>/,
      });
    });

    it("should reject end < start when end is omitted", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_network_flow_logs").handler as (input: {
        start: string;
        end?: string;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "9999-01-01T00:00:00Z" }), {
        message: /end must be >= start.*end=<now>/,
      });
    });
  });

  describe("tailscale_set_log_stream_config (s3 cross-field validation)", () => {
    it("should reject s3 destination missing required fields", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () =>
          handler({
            logType: "configuration",
            destinationType: "s3",
            // missing s3Bucket, s3Region, s3AuthenticationType
          }),
        { message: /s3Bucket.*s3Region.*s3AuthenticationType/ },
      );
    });

    it("should reject rolearn auth missing s3RoleArn", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () =>
          handler({
            logType: "configuration",
            destinationType: "s3",
            s3Bucket: "b",
            s3Region: "us-west-2",
            s3AuthenticationType: "rolearn",
          }),
        { message: /s3RoleArn/ },
      );
    });

    it("should reject splunk destination missing url + token", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ logType: "network", destinationType: "splunk" }), {
        message: /url.*token/,
      });
    });

    it("should reject non-s3 destination that includes s3-only fields (symmetric guard)", async () => {
      // Mirrors the auth-only-vs-non-auth guard in tools/keys.ts: s3* fields
      // silently flowing into a non-s3 destination would be passed through to
      // the API and rejected with a terse 400. Surfacing the conflict early
      // keeps the error actionable.
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () =>
          handler({
            logType: "configuration",
            destinationType: "splunk",
            url: "https://splunk.example.com",
            token: "tok",
            s3Bucket: "leftover-from-prior-config",
          }),
        { message: /s3Bucket.*can only be used with destinationType 's3'.*'splunk'/ },
      );
    });

    it("should list every offending s3-only field when multiple are passed to a non-s3 destination", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () =>
          handler({
            logType: "network",
            destinationType: "datadog",
            url: "https://http-intake.logs.datadoghq.com/api/v2/logs",
            token: "tok",
            s3Bucket: "b",
            s3Region: "us-east-1",
            s3RoleArn: "arn:aws:iam::123:role/x",
          }),
        { message: /s3Bucket.*s3Region.*s3RoleArn/ },
      );
    });
  });

  describe("tailscale_set_log_stream_config (s3)", () => {
    it("should pass through S3-specific fields when destinationType is s3", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      let capturedBody: string | undefined;
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({
        logType: "configuration",
        destinationType: "s3",
        s3Bucket: "my-logs",
        s3Region: "us-west-2",
        s3AuthenticationType: "rolearn",
        s3RoleArn: "arn:aws:iam::123456789012:role/TailscaleLogs",
        compressionFormat: "zstd",
        uploadPeriodMinutes: 5,
      });
      assert.equal(capturedMethod, "PUT");
      assert.ok(capturedUrl.includes("/logging/configuration/stream"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.destinationType, "s3");
      assert.equal(parsed.s3Bucket, "my-logs");
      assert.equal(parsed.s3Region, "us-west-2");
      assert.equal(parsed.s3AuthenticationType, "rolearn");
      assert.equal(parsed.s3RoleArn, "arn:aws:iam::123456789012:role/TailscaleLogs");
      assert.equal(parsed.compressionFormat, "zstd");
      assert.equal(parsed.uploadPeriodMinutes, 5);
      assert.ok(!("logType" in parsed), "logType belongs in the URL, not the body");
    });
  });

  // --- services.ts ---

  describe("tailscale_list_services", () => {
    it("should GET the tailnet services collection", async () => {
      const { serviceTools } = await import("./tools/services.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, { services: [] });
      };
      const handler = findTool(serviceTools, "tailscale_list_services").handler;
      const result = (await handler()) as { ok: boolean };
      assert.ok(result.ok);
      assert.equal(capturedMethod, "GET");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/services"));
    });
  });

  describe("tailscale_get_service", () => {
    it("should encode the serviceName segment (colon -> %3A)", async () => {
      const { serviceTools } = await import("./tools/services.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { name: "svc:web" });
      };
      const handler = findTool(serviceTools, "tailscale_get_service").handler as (input: {
        serviceName: string;
      }) => Promise<unknown>;
      const result = (await handler({ serviceName: "svc:web" })) as { ok: boolean };
      assert.ok(
        capturedUrl.includes("/services/svc%3Aweb"),
        `expected encoded serviceName in URL, got: ${capturedUrl}`,
      );
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_update_service", () => {
    it("should PUT the cleaned body with encoded serviceName", async () => {
      const { serviceTools } = await import("./tools/services.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(serviceTools, "tailscale_update_service").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await handler({
        serviceName: "svc:web",
        ports: [{ protocol: "tcp", port: 443 }],
        tags: ["tag:prod"],
        autoApproveHosts: true,
      })) as { ok: boolean };
      assert.equal(capturedMethod, "PUT");
      assert.ok(capturedUrl.includes("/services/svc%3Aweb"));
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed.ports, [{ protocol: "tcp", port: 443 }]);
      assert.deepEqual(parsed.tags, ["tag:prod"]);
      assert.equal(parsed.autoApproveHosts, true);
      assert.ok(!("serviceName" in parsed), "serviceName belongs in the URL, not the body");
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });

    it("should reject when no updatable fields are provided", async () => {
      const { serviceTools } = await import("./tools/services.js");
      const handler = findTool(serviceTools, "tailscale_update_service").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ serviceName: "svc:web" }), { message: /No fields to update/ });
    });

    it("should reject tags missing the 'tag:' prefix", async () => {
      const { serviceTools } = await import("./tools/services.js");
      const handler = findTool(serviceTools, "tailscale_update_service").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ serviceName: "svc:web", tags: ["prod"] }), {
        message: /must start with 'tag:' prefix/,
      });
    });
  });

  describe("tailscale_delete_service", () => {
    it("should DELETE with encoded serviceName", async () => {
      const { serviceTools } = await import("./tools/services.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(serviceTools, "tailscale_delete_service").handler as (input: {
        serviceName: string;
      }) => Promise<unknown>;
      const result = (await handler({ serviceName: "svc:web" })) as { ok: boolean };
      assert.equal(capturedMethod, "DELETE");
      assert.ok(capturedUrl.includes("/services/svc%3Aweb"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_list_service_hosts", () => {
    it("should GET the /devices subresource of an encoded service", async () => {
      const { serviceTools } = await import("./tools/services.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { devices: [] });
      };
      const handler = findTool(serviceTools, "tailscale_list_service_hosts").handler as (input: {
        serviceName: string;
      }) => Promise<unknown>;
      const result = (await handler({ serviceName: "svc:web" })) as { ok: boolean };
      assert.ok(capturedUrl.includes("/services/svc%3Aweb/devices"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_get_service_device_approval", () => {
    it("should encode both serviceName and deviceId path segments", async () => {
      const { serviceTools } = await import("./tools/services.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { approved: true });
      };
      const handler = findTool(serviceTools, "tailscale_get_service_device_approval").handler as (input: {
        serviceName: string;
        deviceId: string;
      }) => Promise<unknown>;
      const result = (await handler({ serviceName: "svc:web", deviceId: "node:abc" })) as { ok: boolean };
      assert.ok(capturedUrl.includes("svc%3Aweb"), `serviceName not encoded in: ${capturedUrl}`);
      assert.ok(capturedUrl.includes("node%3Aabc"), `deviceId not encoded in: ${capturedUrl}`);
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_set_service_device_approval", () => {
    it("should POST {approved} with both encoded path segments", async () => {
      const { serviceTools } = await import("./tools/services.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(serviceTools, "tailscale_set_service_device_approval").handler as (input: {
        serviceName: string;
        deviceId: string;
        approved: boolean;
      }) => Promise<unknown>;
      const result = (await handler({ serviceName: "svc:web", deviceId: "node:abc", approved: true })) as {
        ok: boolean;
      };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("svc%3Aweb"));
      assert.ok(capturedUrl.includes("node%3Aabc"));
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { approved: true });
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  // --- log-streaming.ts ---

  describe("tailscale_list_log_stream_configs (happy path)", () => {
    it("should return both configs with no errors key when both fetches succeed", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/configuration/stream")) return mockFetchResponse(200, { destinationType: "axiom" });
        return mockFetchResponse(200, { destinationType: "s3" });
      };
      const handler = findTool(logStreamingTools, "tailscale_list_log_stream_configs").handler;
      const result = (await handler()) as {
        ok: boolean;
        data: { configuration: unknown; network: unknown; errors?: unknown };
      };
      assert.ok(result.ok);
      assert.deepEqual(result.data.configuration, { destinationType: "axiom" });
      assert.deepEqual(result.data.network, { destinationType: "s3" });
      assert.ok(!("errors" in result.data), "no errors key expected on full success");
    });
  });

  describe("tailscale_list_log_stream_configs (partial failure)", () => {
    it("should return ok:true with network:null and errors.network when only network fails", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/configuration/stream")) return mockFetchResponse(200, { destinationType: "axiom" });
        return mockFetchResponse(500, { message: "network stream blew up" });
      };
      const handler = findTool(logStreamingTools, "tailscale_list_log_stream_configs").handler;
      const result = (await handler()) as {
        ok: boolean;
        data: { configuration: unknown; network: unknown; errors?: { network?: string } };
      };
      assert.ok(result.ok);
      assert.deepEqual(result.data.configuration, { destinationType: "axiom" });
      assert.equal(result.data.network, null);
      assert.ok(result.data.errors?.network);
      assert.match(String(result.data.errors.network), /network stream blew up/);
    });
  });

  describe("tailscale_list_log_stream_configs (total failure)", () => {
    it("should return ok:false with both error messages merged", async () => {
      // Shrink the backoff: 503 is a retryable gateway status on a GET, so the
      // network half otherwise burns ~7s of real sleeps before it gives up.
      process.env.TAILSCALE_RETRY_BASE_DELAY_MS = "1";
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/configuration/stream")) return mockFetchResponse(500, { message: "config boom" });
        return mockFetchResponse(503, { message: "network boom" });
      };
      try {
        const handler = findTool(logStreamingTools, "tailscale_list_log_stream_configs").handler;
        const result = (await handler()) as { ok: boolean; error?: string };
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /config boom/);
        assert.match(result.error ?? "", /network boom/);
      } finally {
        delete process.env.TAILSCALE_RETRY_BASE_DELAY_MS;
      }
    });
  });

  describe("tailscale_list_log_stream_configs (both transport-fail)", () => {
    it("should fall back to status 500 when both sub-calls have no HTTP status", async () => {
      // The existing total-failure test uses HTTP 500/503, so `configuration.status`
      // is truthy and the `|| 500` fallback never runs. A transport failure (DNS,
      // socket reset, timeout) now returns status 0 from apiRequest, which makes
      // BOTH statuses falsy and that arm reachable for the first time -- without
      // it the tool would report status 0, which is not a status any MCP client
      // can interpret.
      //
      // Shrink the backoff: GET is retryable, so a throwing fetch otherwise burns
      // ~7s of real sleeps across both parallel calls.
      process.env.TAILSCALE_RETRY_BASE_DELAY_MS = "1";
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      globalThis.fetch = async () => {
        throw new Error("getaddrinfo ENOTFOUND api.tailscale.com");
      };
      try {
        const handler = findTool(logStreamingTools, "tailscale_list_log_stream_configs").handler;
        const result = (await handler()) as { ok: boolean; status: number; error?: string };
        assert.equal(result.ok, false);
        assert.equal(result.status, 500, "status 0 from both sub-calls must surface as 500, not 0");
        assert.match(result.error ?? "", /Both log streams failed/);
        assert.match(result.error ?? "", /ENOTFOUND/, "the underlying cause should survive into the message");
      } finally {
        delete process.env.TAILSCALE_RETRY_BASE_DELAY_MS;
      }
    });
  });

  describe("tailscale_get_log_stream_config", () => {
    it("should GET the per-logType stream endpoint", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(logStreamingTools, "tailscale_get_log_stream_config").handler as (input: {
        logType: "configuration" | "network";
      }) => Promise<unknown>;
      const result = (await handler({ logType: "configuration" })) as { ok: boolean };
      assert.equal(capturedMethod, "GET");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/logging/configuration/stream"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_set_log_stream_config (s3 accesskey)", () => {
    it("should reject accesskey auth missing s3AccessKeyId and s3SecretAccessKey", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () =>
          handler({
            logType: "configuration",
            destinationType: "s3",
            s3Bucket: "b",
            s3Region: "us-west-2",
            s3AuthenticationType: "accesskey",
          }),
        { message: /s3AccessKeyId.*s3SecretAccessKey/ },
      );
    });

    it("should reject accesskey auth missing only s3SecretAccessKey", async () => {
      // Single-credential-missing arm: s3AccessKeyId present, secret absent. The
      // guard pushes only the missing field, so the message names s3SecretAccessKey
      // and must NOT claim s3AccessKeyId is missing.
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () =>
          handler({
            logType: "configuration",
            destinationType: "s3",
            s3Bucket: "b",
            s3Region: "us-west-2",
            s3AuthenticationType: "accesskey",
            s3AccessKeyId: "AKIAEXAMPLE",
          }),
        (err: Error) => /s3SecretAccessKey/.test(err.message) && !/s3AccessKeyId/.test(err.message),
      );
    });

    it("should reject accesskey auth missing only s3AccessKeyId", async () => {
      // The mirror of the above: secret present, key id absent. Message names
      // s3AccessKeyId and must NOT claim s3SecretAccessKey is missing.
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () =>
          handler({
            logType: "configuration",
            destinationType: "s3",
            s3Bucket: "b",
            s3Region: "us-west-2",
            s3AuthenticationType: "accesskey",
            s3SecretAccessKey: "secret-value",
          }),
        (err: Error) => /s3AccessKeyId/.test(err.message) && !/s3SecretAccessKey/.test(err.message),
      );
    });

    it("should pass through s3AccessKeyId and s3SecretAccessKey on the happy path", async () => {
      // Mirrors the rolearn happy-path test (line 2188). Without coverage on
      // accesskey, a handler change that dropped these credentials during body
      // assembly would surface as a confusing API error to the operator, not a
      // test failure.
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      let capturedBody: string | undefined;
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await handler({
        logType: "network",
        destinationType: "s3",
        s3Bucket: "my-logs",
        s3Region: "us-east-1",
        s3KeyPrefix: "tailscale/",
        s3AuthenticationType: "accesskey",
        s3AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
        s3SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      })) as { ok: boolean };
      assert.equal(capturedMethod, "PUT");
      assert.ok(capturedUrl.includes("/logging/network/stream"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.destinationType, "s3");
      assert.equal(parsed.s3AuthenticationType, "accesskey");
      assert.equal(parsed.s3AccessKeyId, "AKIAIOSFODNN7EXAMPLE");
      assert.equal(parsed.s3SecretAccessKey, "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
      assert.equal(parsed.s3KeyPrefix, "tailscale/");
      assert.ok(!("logType" in parsed), "logType belongs in the URL, not the body");
      assert.ok(!("s3RoleArn" in parsed), "s3RoleArn must not leak into an accesskey body");
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_set_log_stream_config (non-s3 happy path)", () => {
    it("should PUT a clean body for axiom destinations", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await handler({
        logType: "network",
        destinationType: "axiom",
        url: "https://api.axiom.co/v1/datasets/tailscale/ingest",
        token: "axiom-token",
        uploadPeriodMinutes: 10,
        compressionFormat: "gzip",
      })) as { ok: boolean };
      assert.equal(capturedMethod, "PUT");
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.destinationType, "axiom");
      assert.equal(parsed.url, "https://api.axiom.co/v1/datasets/tailscale/ingest");
      assert.equal(parsed.token, "axiom-token");
      assert.equal(parsed.uploadPeriodMinutes, 10);
      assert.equal(parsed.compressionFormat, "gzip");
      assert.ok(!("logType" in parsed), "logType belongs in the URL, not the body");
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_delete_log_stream_config", () => {
    it("should DELETE the per-logType stream endpoint", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(logStreamingTools, "tailscale_delete_log_stream_config").handler as (input: {
        logType: "configuration" | "network";
      }) => Promise<unknown>;
      const result = (await handler({ logType: "network" })) as { ok: boolean };
      assert.equal(capturedMethod, "DELETE");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/logging/network/stream"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_get_log_stream_status", () => {
    it("should GET the /status subresource", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, { lastSuccess: "2026-05-01T00:00:00Z" });
      };
      const handler = findTool(logStreamingTools, "tailscale_get_log_stream_status").handler as (input: {
        logType: "configuration" | "network";
      }) => Promise<unknown>;
      const result = (await handler({ logType: "configuration" })) as { ok: boolean };
      assert.equal(capturedMethod, "GET");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/logging/configuration/stream/status"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_create_aws_external_id", () => {
    // The three cases below all need the same capture, and the point of the
    // second one is that it differs from the first by a single body field.
    async function postExternalId(input?: { reusable?: boolean }) {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      let capturedContentType: string | null = null;
      globalThis.fetch = async (target: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof target === "string" ? target : target.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string | undefined;
        capturedContentType = new Headers(init?.headers).get("Content-Type");
        return mockFetchResponse(200, { externalId: "ext-123" });
      };
      const handler = findTool(logStreamingTools, "tailscale_create_aws_external_id").handler as (input?: {
        reusable?: boolean;
      }) => Promise<unknown>;
      const result = (await handler(input)) as { ok: boolean };
      return { capturedUrl, capturedMethod, capturedBody, capturedContentType, result };
    }

    it("should POST {reusable:true} by default", async () => {
      const captured = await postExternalId({});
      assert.equal(captured.capturedMethod, "POST");
      assert.ok(captured.capturedUrl.includes("/tailnet/test.ts.net/aws-external-id"));
      assert.equal(captured.capturedContentType, "application/json");
      assert.equal(captured.capturedBody, '{"reusable":true}');
      assert.ok(captured.result.ok, `expected ok, got: ${JSON.stringify(captured.result)}`);
    });

    it("should send reusable:false when the caller asks for a fresh ID", async () => {
      // The default is applied with `??`, not `||`: false is a meaningful value
      // here (it is what Tailscale's own Terraform provider passes to get one
      // distinct ID per resource), so a `|| true` regression would silently
      // turn every call back into a reusable mint.
      const captured = await postExternalId({ reusable: false });
      assert.equal(captured.capturedBody, '{"reusable":false}');
    });

    it("should default reusable when called with no argument at all", async () => {
      // Handler tests bypass Zod, and the wiring passes whatever the client
      // sent, so the handler cannot lean on a schema-level default.
      const captured = await postExternalId();
      assert.equal(captured.capturedBody, '{"reusable":true}');
    });
  });

  describe("tailscale_validate_aws_trust_policy", () => {
    it("should POST {roleArn} to the encoded externalId validate path", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { valid: true });
      };
      const handler = findTool(logStreamingTools, "tailscale_validate_aws_trust_policy").handler as (input: {
        externalId: string;
        roleArn: string;
      }) => Promise<unknown>;
      const result = (await handler({
        externalId: "ext:abc",
        roleArn: "arn:aws:iam::123456789012:role/TailscaleLogs",
      })) as { ok: boolean };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/aws-external-id/ext%3Aabc/validate-aws-trust-policy"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.roleArn, "arn:aws:iam::123456789012:role/TailscaleLogs");
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  // --- invites.ts ---

  describe("tailscale_create_device_invite", () => {
    it("should include all optional fields in the body when provided", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedUrl = "";
      let capturedBody: string | undefined;
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = init?.body as string;
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, { id: "inv-1" });
      };
      const handler = findTool(inviteTools, "tailscale_create_device_invite").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await handler({
        deviceId: "node:abc",
        multiUse: true,
        allowExitNode: true,
        email: "guest@example.com",
      })) as { ok: boolean };
      // The delete_device_invite sibling pins DELETE on a near-identical path;
      // pin the create side too so the pair cannot drift onto the same verb.
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/device/node%3Aabc/device-invites"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.multiUse, true);
      assert.equal(parsed.allowExitNode, true);
      assert.equal(parsed.email, "guest@example.com");
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });

    it("should send an empty body when no optional fields are provided", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { id: "inv-1" });
      };
      const handler = findTool(inviteTools, "tailscale_create_device_invite").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await handler({ deviceId: "12345" })) as { ok: boolean };
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, {});
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_get_device_invite", () => {
    it("should GET the encoded inviteId path", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, { id: "inv:1" });
      };
      const handler = findTool(inviteTools, "tailscale_get_device_invite").handler as (input: {
        inviteId: string;
      }) => Promise<unknown>;
      const result = (await handler({ inviteId: "inv:1" })) as { ok: boolean };
      assert.equal(capturedMethod, "GET");
      assert.ok(capturedUrl.includes("/device-invites/inv%3A1"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_delete_device_invite", () => {
    it("should DELETE the encoded inviteId path", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(inviteTools, "tailscale_delete_device_invite").handler as (input: {
        inviteId: string;
      }) => Promise<unknown>;
      const result = (await handler({ inviteId: "inv:1" })) as { ok: boolean };
      assert.equal(capturedMethod, "DELETE");
      assert.ok(capturedUrl.includes("/device-invites/inv%3A1"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_accept_device_invite", () => {
    it("should POST to the literal /device-invites/-/accept path", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(inviteTools, "tailscale_accept_device_invite").handler as (input: {
        invite: string;
      }) => Promise<unknown>;
      const result = (await handler({ invite: "https://login.tailscale.com/admin/invite/abc123" })) as {
        ok: boolean;
      };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.endsWith("/device-invites/-/accept"));
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { invite: "https://login.tailscale.com/admin/invite/abc123" });
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_get_user_invite", () => {
    it("should GET the encoded user-invite path", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(inviteTools, "tailscale_get_user_invite").handler as (input: {
        inviteId: string;
      }) => Promise<unknown>;
      const result = (await handler({ inviteId: "uinv:1" })) as { ok: boolean };
      assert.equal(capturedMethod, "GET");
      assert.ok(capturedUrl.includes("/user-invites/uinv%3A1"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_delete_user_invite", () => {
    it("should DELETE the encoded user-invite path", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(inviteTools, "tailscale_delete_user_invite").handler as (input: {
        inviteId: string;
      }) => Promise<unknown>;
      const result = (await handler({ inviteId: "uinv:1" })) as { ok: boolean };
      assert.equal(capturedMethod, "DELETE");
      assert.ok(capturedUrl.includes("/user-invites/uinv%3A1"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_list_user_invites", () => {
    it("should GET the tailnet-scoped user-invites collection", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, []);
      };
      const handler = findTool(inviteTools, "tailscale_list_user_invites").handler;
      const result = (await handler()) as { ok: boolean };
      assert.equal(capturedMethod, "GET");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/user-invites"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_resend_device_invite", () => {
    it("should POST to /device-invites/{id}/resend with encoded id", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(inviteTools, "tailscale_resend_device_invite").handler as (input: {
        inviteId: string;
      }) => Promise<unknown>;
      const result = (await handler({ inviteId: "inv:1" })) as { ok: boolean };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/device-invites/inv%3A1/resend"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_resend_user_invite", () => {
    it("should POST to /user-invites/{id}/resend with encoded id", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(inviteTools, "tailscale_resend_user_invite").handler as (input: {
        inviteId: string;
      }) => Promise<unknown>;
      const result = (await handler({ inviteId: "uinv:1" })) as { ok: boolean };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/user-invites/uinv%3A1/resend"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  // --- keys.ts ---

  describe("tailscale_create_key (client)", () => {
    it("should send keyType+scopes+tags, no capabilities", async () => {
      const { keyTools } = await import("./tools/keys.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { id: "client-1" });
      };
      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await handler({
        keyType: "client",
        scopes: ["devices:core:read", "dns:read"],
        tags: ["tag:ci"],
      })) as { ok: boolean };
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.keyType, "client");
      assert.deepEqual(parsed.scopes, ["devices:core:read", "dns:read"]);
      assert.deepEqual(parsed.tags, ["tag:ci"]);
      assert.ok(!("capabilities" in parsed), "capabilities is auth-only");
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });

    it("should reject client keyType with no scopes", async () => {
      const { keyTools } = await import("./tools/keys.js");
      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ keyType: "client" }), { message: /scopes are required/ });
    });
  });

  describe("tailscale_create_key (federated)", () => {
    it("should reject federated keyType missing issuer", async () => {
      const { keyTools } = await import("./tools/keys.js");
      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () =>
          handler({
            keyType: "federated",
            scopes: ["devices:core:read"],
            subject: "repo:my-org/my-repo:*",
          }),
        { message: /issuer is required/ },
      );
    });

    it("should reject federated keyType missing subject", async () => {
      const { keyTools } = await import("./tools/keys.js");
      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () =>
          handler({
            keyType: "federated",
            scopes: ["devices:core:read"],
            issuer: "https://token.actions.githubusercontent.com",
          }),
        { message: /subject is required/ },
      );
    });

    it("should send keyType+scopes+issuer+subject+audience+customClaimRules+tags", async () => {
      const { keyTools } = await import("./tools/keys.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { id: "fed-1" });
      };
      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await handler({
        keyType: "federated",
        scopes: ["devices:core:read"],
        issuer: "https://token.actions.githubusercontent.com",
        subject: "repo:my-org/my-repo:*",
        audience: "https://api.tailscale.com",
        customClaimRules: { repo_owner: "my-org" },
        tags: ["tag:ci"],
      })) as { ok: boolean };
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.keyType, "federated");
      assert.deepEqual(parsed.scopes, ["devices:core:read"]);
      assert.equal(parsed.issuer, "https://token.actions.githubusercontent.com");
      assert.equal(parsed.subject, "repo:my-org/my-repo:*");
      assert.equal(parsed.audience, "https://api.tailscale.com");
      assert.deepEqual(parsed.customClaimRules, { repo_owner: "my-org" });
      assert.deepEqual(parsed.tags, ["tag:ci"]);
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_create_key (auth-only fields with non-auth keyType)", () => {
    it("should reject reusable:true on a client key", async () => {
      const { keyTools } = await import("./tools/keys.js");
      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () =>
          handler({
            keyType: "client",
            scopes: ["devices:core:read"],
            reusable: true,
          }),
        { message: /reusable.*can only be used with keyType 'auth'/ },
      );
    });
  });

  describe("tailscale_create_key (non-auth fields with auth keyType)", () => {
    it("should reject scopes when keyType is auth (or omitted)", async () => {
      // Pre-fix this silently dropped 'scopes' because the auth branch never
      // reads it. The caller would get an auth key with no scopes and no
      // error, which doesn't match their intent. Symmetric guard makes the
      // mistake loud.
      const { keyTools } = await import("./tools/keys.js");
      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ scopes: ["devices:core:read"] }), {
        message: /scopes cannot be used with keyType 'auth'/,
      });
    });

    it("should reject federated-only fields when keyType is auth", async () => {
      const { keyTools } = await import("./tools/keys.js");
      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () =>
          handler({
            keyType: "auth",
            issuer: "https://token.actions.githubusercontent.com",
            subject: "repo:my-org/my-repo:*",
          }),
        { message: /issuer, subject cannot be used with keyType 'auth'/ },
      );
    });

    it("should still accept a plain auth key with no non-auth fields", async () => {
      const { keyTools } = await import("./tools/keys.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { key: "tskey-auth-test" });
      };
      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<{ ok: boolean }>;
      const result = await handler({ reusable: true, tags: ["tag:ci"] });
      assert.ok(result.ok);
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.capabilities.devices.create.reusable, true);
      assert.deepEqual(parsed.capabilities.devices.create.tags, ["tag:ci"]);
    });
  });

  describe("tailscale_create_key (validateTags)", () => {
    it("should reject tags missing the 'tag:' prefix", async () => {
      const { keyTools } = await import("./tools/keys.js");
      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ tags: ["ci"] }), { message: /must start with 'tag:' prefix/ });
    });
  });

  describe("tailscale_update_key (validateTags)", () => {
    it("should reject tags missing the 'tag:' prefix", async () => {
      // create_key, set_device_tags and update_service all have a rejecting test
      // for this helper; update_key calls validateTags too but had none, so
      // deleting its call was invisible -- and the failure that produces is a
      // terse API 400 rather than the local message the other three guarantee.
      const { keyTools } = await import("./tools/keys.js");
      const handler = findTool(keyTools, "tailscale_update_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ keyId: "k:1", tags: ["ci"] }), {
        message: /must start with 'tag:' prefix/,
      });
    });
  });

  describe("tailscale_update_key (no fields)", () => {
    it("should reject when only keyId is provided", async () => {
      const { keyTools } = await import("./tools/keys.js");
      const handler = findTool(keyTools, "tailscale_update_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ keyId: "k:1" }), { message: /No fields to update/ });
    });
  });

  describe("tailscale_update_key (happy path)", () => {
    it("should PUT a sanitized description, scopes, and tags to encoded keyId", async () => {
      const { keyTools } = await import("./tools/keys.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(keyTools, "tailscale_update_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await handler({
        keyId: "k:1",
        // sanitizeDescription replaces '/' with '-'
        description: "ci/cd token",
        scopes: ["devices:core:read"],
        tags: ["tag:ci"],
      })) as { ok: boolean };
      assert.equal(capturedMethod, "PUT");
      assert.ok(capturedUrl.includes("/keys/k%3A1"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.description, "ci-cd token");
      assert.deepEqual(parsed.scopes, ["devices:core:read"]);
      assert.deepEqual(parsed.tags, ["tag:ci"]);
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });

    it("should include federated fields (issuer/subject/audience/customClaimRules) in the PUT body", async () => {
      // The happy path above only sends description/scopes/tags. Federated
      // identities additionally accept these four fields; each has its own
      // `!== undefined` arm in the handler, so pin that all four make it through.
      const { keyTools } = await import("./tools/keys.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(keyTools, "tailscale_update_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<{ ok: boolean }>;
      const result = await handler({
        keyId: "k:1",
        issuer: "https://token.actions.githubusercontent.com",
        subject: "repo:my-org/my-repo:*",
        audience: "tailscale",
        customClaimRules: { environment: "prod" },
      });
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.issuer, "https://token.actions.githubusercontent.com");
      assert.equal(parsed.subject, "repo:my-org/my-repo:*");
      assert.equal(parsed.audience, "tailscale");
      assert.deepEqual(parsed.customClaimRules, { environment: "prod" });
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_create_key (description sanitized to empty)", () => {
    it("should throw a specific error when description has content but no valid chars survive sanitization", async () => {
      // Pre-fix this silently dropped the description, and if it was the only
      // field the user provided, the caller saw a misleading "No fields to
      // update" further down. The new helper throws inline with a clear
      // message that names the offending input.
      const { keyTools } = await import("./tools/keys.js");
      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () => handler({ description: "!!!" }),
        (err: Error) => {
          assert.match(err.message, /contains no valid characters after sanitization/);
          assert.match(err.message, /"!!!"/);
          assert.ok(
            !/No fields to update/.test(err.message),
            `should NOT surface the misleading 'No fields to update' message, got: ${err.message}`,
          );
          return true;
        },
      );
    });

    it("should still accept empty-string description as 'omit the field'", async () => {
      // Empty/whitespace input is unambiguous "no description" intent -- keep
      // this path silent so existing scripts that pass description: "" through
      // to a no-op still succeed.
      const { keyTools } = await import("./tools/keys.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { id: "k1" });
      };
      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await handler({ description: "" })) as { ok: boolean };
      assert.ok(result.ok);
      const parsed = JSON.parse(capturedBody!);
      assert.ok(!("description" in parsed), `description should be omitted, got body: ${capturedBody}`);
    });
  });

  describe("tailscale_update_key (description sanitized to empty)", () => {
    it("should throw a specific error instead of misleading 'No fields to update'", async () => {
      // The exact regression this rule was added for: user supplied a
      // description, but every character was invalid. Old behavior dropped the
      // field and then complained about an empty body; new behavior surfaces
      // the root cause.
      const { keyTools } = await import("./tools/keys.js");
      const handler = findTool(keyTools, "tailscale_update_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () => handler({ keyId: "k:1", description: "@@@!!!" }),
        (err: Error) => {
          assert.match(err.message, /contains no valid characters after sanitization/);
          assert.match(err.message, /"@@@!!!"/);
          assert.ok(
            !/No fields to update/.test(err.message),
            `should NOT surface the misleading 'No fields to update' message, got: ${err.message}`,
          );
          return true;
        },
      );
    });

    it("should still surface 'No fields to update' when description is empty AND no other field is set", async () => {
      // Empty description = omit-the-field; with no other update field present
      // the body is genuinely empty, so the existing error is correct here.
      const { keyTools } = await import("./tools/keys.js");
      const handler = findTool(keyTools, "tailscale_update_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ keyId: "k:1", description: "" }), { message: /No fields to update/ });
    });
  });

  // --- users.ts ---

  describe("tailscale_list_users (filters)", () => {
    it("should pass type and role as query-string params", async () => {
      const { userTools } = await import("./tools/users.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, []);
      };
      const handler = findTool(userTools, "tailscale_list_users").handler as (input: {
        type?: string;
        role?: string;
      }) => Promise<unknown>;
      const result = (await handler({ type: "member", role: "admin" })) as { ok: boolean };
      assert.ok(capturedUrl.includes("type=member"), `missing type= in: ${capturedUrl}`);
      assert.ok(capturedUrl.includes("role=admin"), `missing role= in: ${capturedUrl}`);
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_delete_user", () => {
    it("should POST (not DELETE) to /users/{id}/delete", async () => {
      const { userTools } = await import("./tools/users.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(userTools, "tailscale_delete_user").handler as (input: {
        userId: string;
      }) => Promise<unknown>;
      const result = (await handler({ userId: "user:1" })) as { ok: boolean };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/users/user%3A1/delete"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  // --- devices.ts ---

  describe("tailscale_list_devices (filters)", () => {
    it("should encode each filter as a query-string param", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { devices: [] });
      };
      const handler = findTool(deviceTools, "tailscale_list_devices").handler as (input: {
        filters?: Record<string, string | string[]>;
      }) => Promise<unknown>;
      const result = (await handler({ filters: { isEphemeral: "true", os: "linux" } })) as { ok: boolean };
      assert.ok(capturedUrl.includes("isEphemeral=true"), `missing isEphemeral= in: ${capturedUrl}`);
      assert.ok(capturedUrl.includes("os=linux"), `missing os= in: ${capturedUrl}`);
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });

    it("should repeat a filter key once per array value (the spec's own tags example)", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { devices: [] });
      };
      const handler = findTool(deviceTools, "tailscale_list_devices").handler as (input: {
        filters?: Record<string, string | string[]>;
      }) => Promise<unknown>;
      // openapi.yaml's filter example verbatim: isEphemeral=true&tags=tag:prod&
      // tags=tag:subnetrouter. A JS object cannot carry a duplicate key, so an
      // array value is the only way to express it -- and `set` would have kept
      // the last one, silently widening the result to every prod device.
      await handler({ filters: { isEphemeral: "true", tags: ["tag:prod", "tag:subnetrouter"] } });
      const params = new URL(capturedUrl).searchParams;
      assert.deepEqual(params.getAll("tags"), ["tag:prod", "tag:subnetrouter"]);
      assert.equal(params.get("isEphemeral"), "true");
    });

    it("should reject an empty filter array rather than drop the key", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const schema = findTool(deviceTools, "tailscale_list_devices").inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      // `{ tags: [] }` would emit no tags= parameter and quietly return the whole
      // tailnet -- the widest possible answer to a request that asked to narrow.
      assert.equal(schema.safeParse({ filters: { tags: [] } }).success, false);
      assert.equal(schema.safeParse({ filters: { tags: ["tag:prod"] } }).success, true);
      assert.equal(schema.safeParse({ filters: { tags: "tag:prod" } }).success, true);
    });
  });

  describe("tailscale_set_device_ip", () => {
    it("should POST {ipv4} to /device/{id}/ip", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(deviceTools, "tailscale_set_device_ip").handler as (input: {
        deviceId: string;
        ipv4: string;
      }) => Promise<unknown>;
      const result = (await handler({ deviceId: "12345", ipv4: "100.64.0.1" })) as { ok: boolean };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/device/12345/ip"));
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { ipv4: "100.64.0.1" });
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_update_device_key", () => {
    it("should POST {keyExpiryDisabled} to /device/{id}/key", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(deviceTools, "tailscale_update_device_key").handler as (input: {
        deviceId: string;
        keyExpiryDisabled: boolean;
      }) => Promise<unknown>;
      const result = (await handler({ deviceId: "12345", keyExpiryDisabled: true })) as { ok: boolean };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/device/12345/key"));
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { keyExpiryDisabled: true });
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_set_device_routes (IPv6)", () => {
    it("should accept an IPv6 CIDR and forward it in the body", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(deviceTools, "tailscale_set_device_routes").handler as (input: {
        deviceId: string;
        routes: string[];
      }) => Promise<unknown>;
      const result = (await handler({ deviceId: "12345", routes: ["fd7a:115c::/48"] })) as { ok: boolean };
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { routes: ["fd7a:115c::/48"] });
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_set_device_routes (strict CIDR validation)", () => {
    // The previous loose regex passed nonsense like "1.2.3/8" (only 3 octets)
    // and "100/8" (no address shape at all). Strict validation via
    // net.isIPv4 / net.isIPv6 + family-correct prefix bounds rejects these
    // client-side -- the Tailscale API is still authoritative on whether the
    // route is actually advertised by the device.

    const accepted: ReadonlyArray<readonly [string, string]> = [
      ["IPv4 /24", "10.0.0.0/24"],
      ["IPv4 /0", "0.0.0.0/0"],
      ["IPv4 /32 host route", "192.168.1.1/32"],
      ["IPv6 short form", "fd7a:115c::/48"],
      ["IPv6 /0", "::/0"],
      ["IPv6 /128 host route", "fd7a:115c::1/128"],
    ];

    for (const [label, cidr] of accepted) {
      it(`should accept ${label} (${cidr})`, async () => {
        const { deviceTools } = await import("./tools/devices.js");
        const tool = findTool(deviceTools, "tailscale_set_device_routes");
        const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
        assert.equal(
          schema.safeParse({ deviceId: "d", routes: [cidr] }).success,
          true,
          `expected ${cidr} to validate, did not`,
        );
      });
    }

    const rejected: ReadonlyArray<readonly [string, string]> = [
      ["3-octet IPv4 (typo)", "1.2.3/8"],
      ["bare number with prefix", "100/8"],
      ["empty address", "/24"],
      ["IPv4 prefix out of range (33)", "10.0.0.0/33"],
      ["IPv4 prefix out of range (large)", "10.0.0.0/200"],
      ["IPv6 prefix out of range (129)", "fd7a:115c::/129"],
      ["negative prefix", "10.0.0.0/-1"],
      ["non-numeric prefix", "10.0.0.0/abc"],
      ["no slash", "10.0.0.0"],
      ["double slash", "10.0.0.0//24"],
      ["IPv4 with letters", "10.0.0.x/24"],
      ["IPv6 missing colons (just hex)", "deadbeef/8"],
      // Trailing slash with no prefix: Number("") coerces to 0, which would
      // silently promote a single-host typo to a /0 default-route advertisement.
      ["trailing slash, empty prefix", "10.0.0.0/"],
      // Same Number-coerces-to-0 trap, different shapes: whitespace prefix,
      // signed prefix, decimal prefix all become 0 via Number() and would
      // validate as /0 without the strict-digit regex.
      ["trailing whitespace in prefix", "10.0.0.0/ "],
      ["leading-plus prefix", "10.0.0.0/+0"],
      ["decimal prefix", "10.0.0.0/0.0"],
    ];

    for (const [label, cidr] of rejected) {
      it(`should reject ${label} (${JSON.stringify(cidr)})`, async () => {
        const { deviceTools } = await import("./tools/devices.js");
        const tool = findTool(deviceTools, "tailscale_set_device_routes");
        const schema = tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } };
        assert.equal(
          schema.safeParse({ deviceId: "d", routes: [cidr] }).success,
          false,
          `expected ${JSON.stringify(cidr)} to fail validation, but it passed`,
        );
      });
    }
  });

  describe("tailscale_batch_update_posture_attributes (null delete)", () => {
    it("should pass through null attribute values as-is", async () => {
      // null is the API's intentional sentinel for "delete this attribute"
      // under JSON Merge Patch semantics. The handler must NOT strip nullish
      // values during body assembly -- if it did, callers would lose the only
      // way to delete a posture attribute via the batch endpoint.
      const { deviceTools } = await import("./tools/devices.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(deviceTools, "tailscale_batch_update_posture_attributes").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await handler({
        nodes: { "12345": { "custom:compliant": null } },
      })) as { ok: boolean };
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed.nodes, { "12345": { "custom:compliant": null } });
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_batch_update_posture_attributes (comment)", () => {
    it("should include the comment field alongside nodes", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(deviceTools, "tailscale_batch_update_posture_attributes").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await handler({
        nodes: { "12345": { "custom:compliant": { value: "true" } } },
        comment: "quarterly compliance sweep",
      })) as { ok: boolean };
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.comment, "quarterly compliance sweep");
      assert.deepEqual(parsed.nodes, { "12345": { "custom:compliant": { value: "true" } } });
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  // --- dns.ts ---

  describe("tailscale_update_split_dns", () => {
    it("should PATCH the splitDns map directly", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(dnsTools, "tailscale_update_split_dns").handler as (input: {
        splitDns: Record<string, string[]>;
      }) => Promise<unknown>;
      const result = (await handler({ splitDns: { "new.example.com": ["10.0.0.3"] } })) as { ok: boolean };
      assert.equal(capturedMethod, "PATCH");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/dns/split-dns"));
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { "new.example.com": ["10.0.0.3"] });
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });

    it("should forward an empty nameservers array verbatim (documented removal contract)", async () => {
      // The tool description tells users to send an empty array to remove a
      // domain from split DNS. A future refactor that filters empty arrays
      // would silently no-op the removal and users would think their DNS
      // update worked. Pinning the documented contract here.
      const { dnsTools } = await import("./tools/dns.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(dnsTools, "tailscale_update_split_dns").handler as (input: {
        splitDns: Record<string, string[]>;
      }) => Promise<unknown>;
      const result = (await handler({ splitDns: { "old.example.com": [] } })) as { ok: boolean };
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(
        parsed,
        { "old.example.com": [] },
        "empty array must be forwarded -- it's the documented removal idiom",
      );
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_get_dns_configuration", () => {
    it("should GET the unified /dns/configuration endpoint", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(dnsTools, "tailscale_get_dns_configuration").handler;
      const result = (await handler()) as { ok: boolean };
      assert.equal(capturedMethod, "GET");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/dns/configuration"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_set_dns_configuration", () => {
    it("should POST only the defined fields", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      const handler = findTool(dnsTools, "tailscale_set_dns_configuration").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await handler({
        dns: ["8.8.8.8"],
        magicDNS: true,
      })) as { ok: boolean };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/dns/configuration"));
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { dns: ["8.8.8.8"], magicDNS: true });
      assert.ok(!("searchPaths" in parsed));
      assert.ok(!("splitDns" in parsed));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  // --- webhooks.ts ---

  describe("tailscale_test_webhook", () => {
    it("should POST to /webhooks/{id}/test with the encoded id", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(webhookTools, "tailscale_test_webhook").handler as (input: {
        webhookId: string;
      }) => Promise<unknown>;
      const result = (await handler({ webhookId: "wh:1" })) as { ok: boolean };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/webhooks/wh%3A1/test"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("tailscale_update_webhook (no fields)", () => {
    it("should reject when only webhookId is provided", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      const handler = findTool(webhookTools, "tailscale_update_webhook").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ webhookId: "wh-123" }), { message: /No fields to update/ });
    });
  });

  // --- posture.ts ---

  describe("tailscale_update_posture_integration (no fields)", () => {
    it("should reject when only integrationId is provided", async () => {
      const { postureTools } = await import("./tools/posture.js");
      const handler = findTool(postureTools, "tailscale_update_posture_integration").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(() => handler({ integrationId: "pi-1" }), { message: /No fields to update/ });
    });
  });

  // --- tailnet.ts (set_contacts partial / total failure) ---

  describe("tailscale_set_contacts (partial failure)", () => {
    it("should return ok:true with applied + failed split when one type fails", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/contacts/account")) return mockFetchResponse(200, { ok: true });
        return mockFetchResponse(500, { message: "security stream blew up" });
      };
      const handler = findTool(tailnetTools, "tailscale_set_contacts").handler as (
        input: Record<string, unknown>,
      ) => Promise<{
        ok: boolean;
        data: { applied: Record<string, unknown>; failed: Record<string, { status: number; error: string }> };
      }>;
      const result = await handler({
        account: { email: "a@example.com" },
        security: { email: "sec@example.com" },
      });
      assert.ok(result.ok);
      assert.ok("account" in result.data.applied, "account should appear in applied");
      assert.ok("security" in result.data.failed, "security should appear in failed");
      assert.equal(result.data.failed.security.status, 500);
    });
  });

  describe("tailscale_set_contacts (total failure)", () => {
    it("should return ok:false with the first failed type's status and merged error string", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/contacts/account")) return mockFetchResponse(403, { message: "account forbidden" });
        return mockFetchResponse(500, { message: "security blew up" });
      };
      const handler = findTool(tailnetTools, "tailscale_set_contacts").handler as (
        input: Record<string, unknown>,
      ) => Promise<{ ok: boolean; status: number; error?: string }>;
      const result = await handler({
        account: { email: "a@example.com" },
        security: { email: "sec@example.com" },
      });
      assert.equal(result.ok, false);
      // The handler picks the first failed type's status (insertion order:
      // account is iterated before security per the source's ordered tuple).
      assert.equal(result.status, 403);
      assert.match(result.error ?? "", /account forbidden/);
      assert.match(result.error ?? "", /security blew up/);
    });
  });

  describe("tailscale_resend_contact_verification", () => {
    it("should POST to the encoded /contacts/{type}/resend-verification-email path", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(tailnetTools, "tailscale_resend_contact_verification").handler as (input: {
        contactType: "account" | "support" | "security";
      }) => Promise<unknown>;
      const result = (await handler({ contactType: "security" })) as { ok: boolean };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/contacts/security/resend-verification-email"));
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });
  });

  describe("posture provider validation", () => {
    // Regression pin: the provider field used to be a z.enum of six values, which
    // HARD-BLOCKED providers Tailscale added later (fleet, huntress) -- the schema
    // rejected them before a request was built, so the integration was
    // uncreatable rather than merely unvalidated.
    it("accepts every provider Tailscale currently supports", async () => {
      const { postureTools } = await import("./tools/posture.js");
      const schema = findTool(postureTools, "tailscale_create_posture_integration").inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      for (const provider of ["falcon", "fleet", "huntress", "intune", "jamfpro", "kandji", "kolide", "sentinelone"]) {
        const result = schema.safeParse({ provider, clientSecret: "s" });
        assert.ok(result.success, `provider ${provider} must validate`);
      }
    });

    it("rejects an unknown provider and names the escape hatch", async () => {
      const { postureTools } = await import("./tools/posture.js");
      const schema = findTool(postureTools, "tailscale_create_posture_integration").inputSchema as {
        safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } };
      };
      const result = schema.safeParse({ provider: "notarealprovider", clientSecret: "s" });
      assert.equal(result.success, false);
      const msg = result.error?.issues.map((i) => i.message).join(" ") ?? "";
      assert.match(msg, /TAILSCALE_EXTRA_POSTURE_PROVIDERS/);
    });

    it("accepts an unknown provider when TAILSCALE_EXTRA_POSTURE_PROVIDERS adds it", async () => {
      const { postureTools } = await import("./tools/posture.js");
      process.env.TAILSCALE_EXTRA_POSTURE_PROVIDERS = "brandnewedr, another ";
      try {
        const schema = findTool(postureTools, "tailscale_create_posture_integration").inputSchema as {
          safeParse: (v: unknown) => { success: boolean };
        };
        assert.ok(schema.safeParse({ provider: "brandnewedr", clientSecret: "s" }).success);
        // Entries are trimmed, matching the webhook escape hatch's parsing.
        assert.ok(schema.safeParse({ provider: "another", clientSecret: "s" }).success);
      } finally {
        delete process.env.TAILSCALE_EXTRA_POSTURE_PROVIDERS;
      }
    });
  });

  describe("tailscale_create_oauth_app", () => {
    it("should POST to /tailnet/{tailnet}/oauth-apps and omit allowedNodeAttributes when absent", async () => {
      const { keyTools } = await import("./tools/keys.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "";
        capturedBody = String(init?.body ?? "");
        return mockFetchResponse(200, { id: "app-1", clientSecret: "sec" });
      };
      const handler = findTool(keyTools, "tailscale_create_oauth_app").handler as (input: {
        name: string;
        redirectUris: string[];
        scopes: string[];
      }) => Promise<unknown>;
      const result = (await handler({
        name: "My App",
        redirectUris: ["https://example.com/cb"],
        scopes: ["auth_keys:create:once"],
      })) as { ok: boolean };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/oauth-apps"), `got ${capturedUrl}`);
      const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
      assert.equal(parsed.name, "My App");
      assert.ok(!("allowedNodeAttributes" in parsed), "absent optional field must not be sent");
      assert.ok(result.ok);
    });
  });

  describe("tailscale_get_oauth_app", () => {
    it("should GET the app by id with the id percent-encoded", async () => {
      const { keyTools } = await import("./tools/keys.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { id: "app:1" });
      };
      const handler = findTool(keyTools, "tailscale_get_oauth_app").handler as (input: {
        appId: string;
      }) => Promise<unknown>;
      await handler({ appId: "app:1" });
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/oauth-apps/app%3A1"), `got ${capturedUrl}`);
    });
  });

  describe("tailscale_list_oauth_apps", () => {
    it("should GET the collection path with no query string and return the body unchanged", async () => {
      // The collection route takes no parameters, so an appended query string
      // (copied from one of the paged list tools) is the plausible regression;
      // endsWith catches it where includes would not. The body is an OBJECT
      // {oauthApps:[...]}, not a bare array -- a handler that unwrapped it to
      // the array would break every caller reading .oauthApps.
      const { keyTools } = await import("./tools/keys.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "";
        return mockFetchResponse(200, { oauthApps: [{ id: "app-1", name: "My App" }] });
      };
      const handler = findTool(keyTools, "tailscale_list_oauth_apps").handler;
      const result = (await handler()) as { ok: boolean; data: unknown };
      assert.equal(capturedMethod, "GET");
      assert.ok(capturedUrl.endsWith("/tailnet/test.ts.net/oauth-apps"), `got ${capturedUrl}`);
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
      assert.deepEqual(result.data, { oauthApps: [{ id: "app-1", name: "My App" }] });
    });
  });

  describe("tailscale_delete_oauth_app", () => {
    it("should DELETE the app by id", async () => {
      // Verb assertion is not optional here: an audit found 18 mutating tools
      // that asserted only the URL, so an apiDelete -> apiGet slip read as a
      // pass. This tool is the revoke path for a credential-granting object.
      const { keyTools } = await import("./tools/keys.js");
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "";
        return mockFetchResponse(200, {});
      };
      const handler = findTool(keyTools, "tailscale_delete_oauth_app").handler as (input: {
        appId: string;
      }) => Promise<unknown>;
      const result = (await handler({ appId: "app-1" })) as { ok: boolean };
      assert.equal(capturedMethod, "DELETE");
      assert.ok(capturedUrl.endsWith("/tailnet/test.ts.net/oauth-apps/app-1"), `got ${capturedUrl}`);
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
    });

    it("must not let an appId escape its path segment", async () => {
      // encPath is the only thing stopping a caller-supplied id from
      // re-targeting the request: unencoded, "../keys/k-1" resolves to the keys
      // collection and this DELETE revokes an auth key instead of an OAuth app.
      const { keyTools } = await import("./tools/keys.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, {});
      };
      const handler = findTool(keyTools, "tailscale_delete_oauth_app").handler as (input: {
        appId: string;
      }) => Promise<unknown>;
      const cases = [
        ["../keys/k-1", "..%2Fkeys%2Fk-1"],
        ["app id/with slash", "app%20id%2Fwith%20slash"],
        ["app:1", "app%3A1"],
      ] as const;
      for (const [appId, encoded] of cases) {
        capturedUrl = "";
        await handler({ appId });
        assert.ok(
          capturedUrl.endsWith(`/tailnet/test.ts.net/oauth-apps/${encoded}`),
          `${JSON.stringify(appId)} not confined to one path segment: ${capturedUrl}`,
        );
      }
    });
  });

  describe("tailscale_create_oauth_app validation and optional fields", () => {
    it("forwards allowedNodeAttributes intact when provided", async () => {
      // Only the omitted branch was covered. This field shapes what a third
      // party may provision, so silently dropping it is a permissions bug.
      const { keyTools } = await import("./tools/keys.js");
      let capturedBody = "";
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = String(init?.body ?? "");
        return mockFetchResponse(200, { id: "app-1" });
      };
      const handler = findTool(keyTools, "tailscale_create_oauth_app").handler as (input: {
        name: string;
        redirectUris: string[];
        scopes: string[];
        allowedNodeAttributes: string[];
      }) => Promise<unknown>;
      await handler({
        name: "My App",
        redirectUris: ["https://example.com/cb"],
        scopes: ["auth_keys:create:once"],
        allowedNodeAttributes: ["custom:team", "custom:env"],
      });
      const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
      assert.deepEqual(parsed.allowedNodeAttributes, ["custom:team", "custom:env"]);
    });

    it("rejects a non-URL redirect URI at the schema layer", async () => {
      // Security-relevant in an authorization-code flow: if z.url() were ever
      // loosened in a refactor, nothing else would notice.
      const { keyTools } = await import("./tools/keys.js");
      const schema = findTool(keyTools, "tailscale_create_oauth_app").inputSchema as {
        safeParse: (v: unknown) => { success: boolean };
      };
      const base = { name: "App", scopes: ["auth_keys:create:once"] };
      for (const bad of ["not-a-url", "/relative/cb", "example.com/cb"]) {
        assert.equal(
          schema.safeParse({ ...base, redirectUris: [bad] }).success,
          false,
          `${JSON.stringify(bad)} must not validate as a redirect URI`,
        );
      }
      assert.equal(schema.safeParse({ ...base, redirectUris: ["https://example.com/cb"] }).success, true);
      // At least one URI and at least one scope are both required.
      assert.equal(schema.safeParse({ ...base, redirectUris: [] }).success, false);
      assert.equal(schema.safeParse({ name: "App", scopes: [], redirectUris: ["https://e.com/c"] }).success, false);
    });
  });
});

/**
 * tailscale_diff_acl_access.
 *
 * Its own describe block rather than a case inside "Tool handlers": every test
 * here needs a fetch stub that routes by URL *and* request body (the two
 * preview calls per principal hit an identical URL and differ only by the
 * policy they carry), which is a different harness from the single-response
 * mocks above.
 *
 * Fixtures follow the shape the preview endpoint actually returns -- Go's
 * ACLPreviewResponse{Matches []UserRuleMatch, Type, PreviewFor}, where a match
 * carries users/ports/lineNumber/via/postures. Inventing a friendlier shape
 * here would produce tests that pass against a response Tailscale never sends.
 */
describe("tailscale_diff_acl_access", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
    delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
    delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
    globalThis.fetch = async () => mockFetchResponse(599, "no test installed a fetch stub");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  const BASELINE = '{"acls":[{"action":"accept","src":["alice@example.com"],"dst":["tag:prod:22"]}]}';

  /** A preview response in the real wire shape. */
  function preview(matches: Array<Record<string, unknown>>, previewFor: string) {
    return { matches, type: "user", previewFor };
  }

  /**
   * Route GET /acl, GET /users, and POST /acl/preview. `onPreview` receives the
   * policy text the call carried and the principal it was for, so a test can
   * return different rules for the baseline vs the proposed policy -- the only
   * thing distinguishing the two requests.
   */
  function installFetch(opts: {
    users?: Array<Record<string, unknown>>;
    usersStatus?: number;
    aclStatus?: number;
    onPreview: (policy: string, principal: string) => { status?: number; body: unknown };
  }) {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/acl/preview")) {
        const principal = new URL(url).searchParams.get("previewFor") ?? "";
        const result = opts.onPreview((init?.body as string) ?? "", principal);
        return mockFetchResponse(result.status ?? 200, result.body);
      }
      if (url.includes("/users")) {
        return mockFetchResponse(opts.usersStatus ?? 200, { users: opts.users ?? [] });
      }
      if (url.includes("/acl")) {
        return mockFetchResponse(opts.aclStatus ?? 200, BASELINE);
      }
      return mockFetchResponse(599, "unexpected URL in test");
    };
  }

  async function runDiff(input: Record<string, unknown>) {
    const { aclTools } = await import("./tools/acl.js");
    return (await findTool(aclTools, "tailscale_diff_acl_access").handler(input)) as {
      ok: boolean;
      error?: string;
      data?: {
        summary: string;
        principalsCompared: number;
        principalsFailed: number;
        principalsAvailable: number;
        truncated: boolean;
        scope: string;
        changed: Array<{ principal: string; lost: string[]; gained: string[] }>;
        unchanged: string[];
        failed: Array<{ principal: string; error: string }>;
      };
    };
  }

  it("reports what a user loses when the proposed policy revokes a destination", async () => {
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE
          ? { body: preview([{ users: [principal], ports: ["tag:prod:22", "tag:db:5432"], lineNumber: 3 }], principal) }
          : { body: preview([{ users: [principal], ports: ["tag:prod:22"], lineNumber: 3 }], principal) },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.data?.changed, [{ principal: "alice@example.com", lost: ["tag:db:5432"], gained: [] }]);
    assert.deepEqual(res.data?.unchanged, []);
    assert.match(res.data?.summary ?? "", /^1 of 1 users compared lose access/);
  });

  it("reports what a user gains on an additive change", async () => {
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE
          ? { body: preview([{ ports: ["tag:prod:22"], lineNumber: 3 }], principal) }
          : { body: preview([{ ports: ["tag:prod:22", "tag:new:443"], lineNumber: 3 }], principal) },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, [{ principal: "alice@example.com", lost: [], gained: ["tag:new:443"] }]);
    assert.match(res.data?.summary ?? "", /0 of 1 users compared lose access, 1 gain access/);
  });

  it("reports no change when the policies grant the same access", async () => {
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (_policy, principal) => ({ body: preview([{ ports: ["tag:prod:22"], lineNumber: 3 }], principal) }),
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, []);
    assert.deepEqual(res.data?.unchanged, ["alice@example.com"]);
  });

  it("does not treat a moved rule as an access change", async () => {
    // lineNumber is the rule's position in the policy text. Inserting a comment
    // at the top shifts every rule below it; keying the diff on lineNumber would
    // report the entire tailnet as losing and re-gaining all access on a
    // whitespace edit, which is the fastest way to make the tool ignorable.
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE
          ? { body: preview([{ ports: ["tag:prod:22"], lineNumber: 3 }], principal) }
          : { body: preview([{ ports: ["tag:prod:22"], lineNumber: 47 }], principal) },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, [], "a line-number shift is not an access change");
    assert.deepEqual(res.data?.unchanged, ["alice@example.com"]);
  });

  it("does not treat a narrowed src list as a change for a user who stays in it", async () => {
    // `users` on a match is the rule's SOURCE set. Dropping bob from
    // src:[alice,bob] leaves alice's reachable destinations identical; keying on
    // it would show alice both losing and gaining the same access.
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE
          ? {
              body: preview(
                [{ users: ["alice@example.com", "bob@example.com"], ports: ["tag:prod:22"], lineNumber: 3 }],
                principal,
              ),
            }
          : { body: preview([{ users: ["alice@example.com"], ports: ["tag:prod:22"], lineNumber: 3 }], principal) },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, []);
    assert.deepEqual(res.data?.unchanged, ["alice@example.com"]);
  });

  it("distinguishes access qualified by via and posture", async () => {
    // Reaching a destination only through a relay is a different grant from
    // reaching it directly, so this is correctly BOTH a loss and a gain.
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE
          ? { body: preview([{ ports: ["tag:prod:22"], lineNumber: 1 }], principal) }
          : { body: preview([{ ports: ["tag:prod:22"], via: ["tag:relay"], lineNumber: 1 }], principal) },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, [
      { principal: "alice@example.com", lost: ["tag:prod:22"], gained: ["tag:prod:22 via tag:relay"] },
    ]);
  });

  it("never reports a failed preview as lost access", async () => {
    // The single worst way this tool could lie. If the proposed-policy preview
    // fails and the baseline succeeds, an empty match set would render as
    // "loses everything" -- a fabricated total revocation that would either
    // block a safe change or, worse, be dismissed as noise.
    installFetch({
      users: [{ loginName: "alice@example.com" }, { loginName: "bob@example.com" }],
      onPreview: (policy, principal) => {
        if (principal === "alice@example.com" && policy !== BASELINE) {
          return { status: 500, body: { message: "preview backend exploded" } };
        }
        return { body: preview([{ ports: ["tag:prod:22"], lineNumber: 1 }], principal) };
      },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, [], "a failed preview must not become a finding");
    assert.deepEqual(res.data?.unchanged, ["bob@example.com"]);
    assert.equal(res.data?.failed.length, 1);
    assert.equal(res.data?.failed[0].principal, "alice@example.com");
    assert.match(res.data?.failed[0].error ?? "", /proposed policy failed/);
    assert.match(res.data?.summary ?? "", /^1 of 2 users could not be checked/);
  });

  it("treats an unparseable preview body as a failure, not an empty rule set", async () => {
    // Two principals so one still compares: with only the failing one, the
    // run compares nobody and correctly becomes a hard error, which would test
    // that guard rather than the parse handling this case is about.
    installFetch({
      users: [{ loginName: "alice@example.com" }, { loginName: "bob@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE || principal === "bob@example.com"
          ? { body: preview([{ ports: ["tag:prod:22"], lineNumber: 1 }], principal) }
          : { body: "<html>gateway error</html>" },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, []);
    assert.equal(res.data?.failed.length, 1);
    assert.match(res.data?.failed[0].error ?? "", /not valid JSON/);
  });

  it("treats a response with no matches array as a failure, not total revocation", async () => {
    // A response-shape change would otherwise read as "every principal can
    // reach nothing" -- a fake total revocation across the whole tailnet at
    // once, which is exactly when the tool most needs to be trusted.
    installFetch({
      users: [{ loginName: "alice@example.com" }, { loginName: "bob@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE || principal === "bob@example.com"
          ? { body: preview([{ ports: ["tag:prod:22"], lineNumber: 1 }], principal) }
          : { body: { type: "user", previewFor: principal } },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, []);
    assert.equal(res.data?.failed.length, 1);
    assert.match(res.data?.failed[0].error ?? "", /no .matches. array/);
  });

  it("caps the principals checked and reports the truncation with counts", async () => {
    const users = Array.from({ length: 30 }, (_, i) => ({ loginName: `u${i}@example.com` }));
    let previewCalls = 0;
    installFetch({
      users,
      onPreview: (_policy, principal) => {
        previewCalls++;
        return { body: preview([{ ports: ["tag:prod:22"], lineNumber: 1 }], principal) };
      },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.data?.principalsCompared, 25, "default cap");
    assert.equal(res.data?.principalsAvailable, 30);
    assert.equal(res.data?.truncated, true);
    assert.equal(previewCalls, 50, "two preview calls per principal checked");
    assert.match(res.data?.summary ?? "", /5 not checked \(cap 25\)/);
  });

  it("honors an explicit maxPrincipals and an explicit principals list", async () => {
    let usersListed = false;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/acl/preview")) {
        const principal = new URL(url).searchParams.get("previewFor") ?? "";
        return mockFetchResponse(200, preview([{ ports: ["tag:prod:22"], lineNumber: 1 }], principal));
      }
      if (url.includes("/users")) {
        usersListed = true;
        return mockFetchResponse(200, { users: [] });
      }
      return mockFetchResponse(200, BASELINE);
    };

    const res = await runDiff({
      policy: '{"acls":[]}',
      principals: ["a@example.com", "b@example.com", "c@example.com"],
      maxPrincipals: 2,
    });
    assert.equal(usersListed, false, "an explicit principals list must not trigger a users lookup");
    assert.equal(res.data?.principalsCompared, 2);
    assert.equal(res.data?.truncated, true);
  });

  it("fails loudly when no user emails can be resolved", async () => {
    // The alternative is a diff over zero principals, which serializes as a
    // clean result and would be read as "this change affects nobody".
    installFetch({
      users: [{ id: "u1" }, { id: "u2" }],
      onPreview: (_p, principal) => ({ body: preview([], principal) }),
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Pass .principals. explicitly/);
  });

  it("fails when the current ACL cannot be read, rather than diffing against nothing", async () => {
    installFetch({
      aclStatus: 403,
      users: [{ loginName: "alice@example.com" }],
      onPreview: (_p, principal) => ({ body: preview([], principal) }),
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /could not read the current ACL/);
  });

  it("is annotated read-only and states its blind spot in the payload", async () => {
    const { aclTools } = await import("./tools/acl.js");
    const tool = findTool(aclTools, "tailscale_diff_acl_access");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    // The tag/group blind spot must reach whoever reads the OUTPUT, who may
    // never have read the tool description.
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (_p, principal) => ({ body: preview([{ ports: ["a:1"], lineNumber: 1 }], principal) }),
    });
    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.match(res.data?.scope ?? "", /tags or groups/);
  });
});

/**
 * Second wave, all from an adversarial review of the first.
 *
 * The original fourteen guarded the inverse case thoroughly -- three separate
 * tests prove a FAILURE is never reported as lost access -- while nothing
 * proved a genuine total revocation IS reported. A regression that routed real
 * empty-match responses into `failed` would have kept all fourteen green while
 * silencing the exact finding the tool exists to produce.
 */
describe("tailscale_diff_acl_access -- regressions found by review", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
    delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
    delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
    globalThis.fetch = async () => mockFetchResponse(599, "no test installed a fetch stub");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  const BASELINE = '{"acls":[{"action":"accept","src":["alice@example.com"],"dst":["tag:prod:22"]}]}';

  function preview(matches: Array<Record<string, unknown>>, previewFor: string) {
    return { matches, type: "user", previewFor };
  }

  /** As the first block's helper, plus it records every preview URL requested. */
  function installFetch(opts: {
    users?: Array<Record<string, unknown>>;
    usersStatus?: number;
    aclStatus?: number;
    onPreview: (policy: string, principal: string) => { status?: number; body: unknown };
    previewUrls?: string[];
  }) {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/acl/preview")) {
        opts.previewUrls?.push(url);
        const principal = new URL(url).searchParams.get("previewFor") ?? "";
        const result = opts.onPreview((init?.body as string) ?? "", principal);
        return mockFetchResponse(result.status ?? 200, result.body);
      }
      if (url.includes("/users")) {
        return mockFetchResponse(opts.usersStatus ?? 200, { users: opts.users ?? [] });
      }
      if (url.includes("/acl")) {
        return mockFetchResponse(opts.aclStatus ?? 200, BASELINE);
      }
      return mockFetchResponse(599, "unexpected URL in test");
    };
  }

  async function runDiff(input: Record<string, unknown>) {
    const { aclTools } = await import("./tools/acl.js");
    return (await findTool(aclTools, "tailscale_diff_acl_access").handler(input)) as {
      ok: boolean;
      error?: string;
      data?: {
        summary: string;
        principalsCompared: number;
        principalsFailed: number;
        principalsAvailable: number;
        truncated: boolean;
        stoppedOnTimeBudget: boolean;
        scope: string;
        changed: Array<{ principal: string; lost: string[]; gained: string[] }>;
        unchanged: string[];
        failed: Array<{ principal: string; error: string }>;
      };
    };
  }

  /**
   * Run `fn` with Date.now advancing by `stepMs` on every read.
   *
   * The tool's time budget is a constant, so exercising it against a real clock
   * would mean a 60s test. Advancing a virtual clock per READ (rather than
   * stubbing a fixed sequence) keeps this robust to how many times api.ts reads
   * the clock internally for its own per-request budget -- the assertions below
   * are written against properties that hold regardless of the exact count,
   * because that count is an implementation detail of a different module.
   */
  async function withClockAdvancing<T>(stepMs: number, fn: () => Promise<T>): Promise<T> {
    const realNow = Date.now;
    let virtual = realNow();
    Date.now = () => {
      virtual += stepMs;
      return virtual;
    };
    try {
      return await fn();
    } finally {
      Date.now = realNow;
    }
  }

  it("reports a genuine total revocation, the headline case the tool exists for", async () => {
    // The real API returns {matches: []} for a principal a policy grants
    // nothing to. That is a legitimate empty rule set, NOT a failure -- the
    // three "failure is not revocation" tests must not have made this
    // indistinguishable from an error.
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE
          ? { body: preview([{ ports: ["tag:prod:22", "tag:db:5432"], lineNumber: 1 }], principal) }
          : { body: preview([], principal) },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.data?.changed, [
      { principal: "alice@example.com", lost: ["tag:db:5432", "tag:prod:22"], gained: [] },
    ]);
    assert.deepEqual(res.data?.failed, [], "an empty match set is a real answer, not a failure");
    assert.match(res.data?.summary ?? "", /^1 of 1 users compared lose access/);
  });

  it("puts a posture requirement in the diff key", async () => {
    // The original "via and posture" test only ever varied `via`, so the
    // posture half of the key was dead in the suite: deleting it kept every
    // test green.
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE
          ? { body: preview([{ ports: ["tag:prod:22"], lineNumber: 1 }], principal) }
          : { body: preview([{ ports: ["tag:prod:22"], postures: ["posture:latestMac"], lineNumber: 1 }], principal) },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, [
      {
        principal: "alice@example.com",
        lost: ["tag:prod:22"],
        gained: ["tag:prod:22 posture posture:latestMac"],
      },
    ]);
  });

  it("treats a reordered via list as unchanged, pinning the sort", async () => {
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE
          ? { body: preview([{ ports: ["p:1"], via: ["tag:a", "tag:b"], lineNumber: 1 }], principal) }
          : { body: preview([{ ports: ["p:1"], via: ["tag:b", "tag:a"], lineNumber: 1 }], principal) },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, [], "via ordering is not semantic; the sort() must absorb it");
  });

  it("excludes failed principals from the compared count and leads the summary with them", async () => {
    // Previously the denominator was the ATTEMPTED count, so a run with
    // failures still opened "0 of 25 users checked lose access" -- asserting
    // coverage of users never compared, and contradicting the tool's own
    // description, which promised failures were excluded from the counts.
    installFetch({
      users: [{ loginName: "a@example.com" }, { loginName: "b@example.com" }, { loginName: "c@example.com" }],
      onPreview: (policy, principal) => {
        if (principal === "a@example.com" && policy !== BASELINE) {
          return { status: 500, body: { message: "boom" } };
        }
        return { body: preview([{ ports: ["p:1"], lineNumber: 1 }], principal) };
      },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.data?.principalsCompared, 2, "the failed principal is not a compared one");
    assert.equal(res.data?.principalsFailed, 1);
    assert.match(res.data?.summary ?? "", /^1 of 3 users could not be checked/);
    assert.match(res.data?.summary ?? "", /0 of 2 users compared lose access/);
  });

  it("fails rather than returning a clean diff when nothing could be compared", async () => {
    // The single most reassuring-looking wrong answer: ok:true with changed:[]
    // over a run that compared nobody. Every other zero-information outcome
    // here is already a hard error.
    installFetch({
      users: [{ loginName: "a@example.com" }, { loginName: "b@example.com" }],
      onPreview: (policy) => (policy === BASELINE ? { status: 500, body: { message: "down" } } : { body: {} }),
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /no users could be compared/);
    assert.match(res.error ?? "", /all 2 preview attempts failed/);
  });

  it("abandons the run on a 401 instead of firing every remaining preview", async () => {
    // A revoked credential is not principal-specific. Continuing spends 2N
    // doomed requests and stacks one full multi-line auth diagnostic per
    // principal into the payload.
    const previewUrls: string[] = [];
    installFetch({
      users: Array.from({ length: 25 }, (_, i) => ({ loginName: `u${i}@example.com` })),
      previewUrls,
      onPreview: () => ({ status: 401, body: { message: "token revoked" } }),
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /authentication failed/);
    assert.ok(
      previewUrls.length <= 2,
      `must stop at the first principal, fired ${previewUrls.length} preview requests`,
    );
  });

  it("previews with type=user against the configured tailnet", async () => {
    // Nothing asserted the request itself: flipping type to "ipport" would fail
    // against the real API for every principal (an email is not an IP:port)
    // while the whole suite stayed green, because the stub only read previewFor.
    const previewUrls: string[] = [];
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      previewUrls,
      onPreview: (_p, principal) => ({ body: preview([{ ports: ["p:1"], lineNumber: 1 }], principal) }),
    });

    await runDiff({ policy: '{"acls":[]}' });
    assert.equal(previewUrls.length, 2);
    for (const url of previewUrls) {
      assert.match(url, /\/tailnet\/test\.ts\.net\/acl\/preview\?/);
      assert.match(url, /type=user/);
      assert.match(url, /previewFor=alice%40example\.com/);
    }
  });

  it("names the CURRENT policy when the baseline preview is the half that failed", async () => {
    // acl.ts's "current" branch was never exercised: every failure fixture
    // failed the proposed side.
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE
          ? { status: 503, body: { message: "unavailable" } }
          : { body: preview([{ ports: ["p:1"], lineNumber: 1 }], principal) },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.ok, false, "one principal, and it failed -- nothing was compared");
    assert.match(res.error ?? "", /current policy failed/);
  });

  it("surfaces a users-listing failure instead of diffing nobody", async () => {
    installFetch({
      usersStatus: 500,
      onPreview: (_p, principal) => ({ body: preview([], principal) }),
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /could not list users to diff/);
  });

  it("stops on its own time budget and says so, rather than running past the client's timeout", async () => {
    // api.ts's request budget is read fresh per apiRequest, so it bounded each
    // of this tool's ~52 requests and never the call. A run that outlives the
    // client's outer timeout hands back nothing, when a partial diff with the
    // limit named is strictly more useful.
    installFetch({
      users: Array.from({ length: 20 }, (_, i) => ({ loginName: `u${i}@example.com` })),
      onPreview: (_policy, principal) => ({ body: preview([{ ports: ["p:1"], lineNumber: 1 }], principal) }),
    });

    const res = await withClockAdvancing(3_000, () => runDiff({ policy: '{"acls":[]}' }));

    assert.equal(res.ok, true, "a partial answer beats a timeout");
    assert.equal(res.data?.stoppedOnTimeBudget, true);
    assert.equal(res.data?.truncated, true);
    assert.ok(
      (res.data?.principalsCompared ?? 0) >= 1,
      "the run should keep the comparisons it completed before the budget ran out",
    );
    assert.ok(
      (res.data?.principalsCompared ?? 0) < 20,
      `expected an early stop, compared ${res.data?.principalsCompared} of 20`,
    );
    // Naming WHICH limit stopped it is the point: a cap stop means raise
    // maxPrincipals, a time stop means the opposite.
    assert.match(res.data?.summary ?? "", /not checked \(60s time budget\)/);
    assert.ok(!/cap /.test(res.data?.summary ?? ""), "must not blame the cap for a time stop");
  });

  it("counts only principals actually attempted, so an early stop cannot inflate the compared total", async () => {
    // The failure this guards: `compared` was derived from the PLANNED list, so
    // breaking out early would have counted every un-attempted principal as
    // successfully compared -- the same overstatement the compared/attempted
    // split was introduced to remove, reappearing in a new place.
    installFetch({
      users: Array.from({ length: 20 }, (_, i) => ({ loginName: `u${i}@example.com` })),
      onPreview: (_policy, principal) => ({ body: preview([{ ports: ["p:1"], lineNumber: 1 }], principal) }),
    });

    const res = await withClockAdvancing(3_000, () => runDiff({ policy: '{"acls":[]}' }));

    const compared = res.data?.principalsCompared ?? 0;
    assert.equal(
      compared,
      (res.data?.changed.length ?? 0) + (res.data?.unchanged.length ?? 0),
      "compared must equal the principals that actually produced a verdict",
    );
    assert.equal(res.data?.principalsAvailable, 20, "the available total still describes the whole tailnet");
  });

  it("fails rather than returning an empty diff when the budget is gone before any comparison", async () => {
    installFetch({
      users: [{ loginName: "alice@example.com" }, { loginName: "bob@example.com" }],
      onPreview: (_policy, principal) => ({ body: preview([{ ports: ["p:1"], lineNumber: 1 }], principal) }),
    });

    // A large enough step that the two setup GETs alone exhaust the budget.
    const res = await withClockAdvancing(40_000, () => runDiff({ policy: '{"acls":[]}' }));

    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /no users could be compared/);
    assert.match(res.error ?? "", /budget for this call was spent/);
    assert.ok(
      !/preview attempts failed/.test(res.error ?? ""),
      "a time stop must not be reported as a preview failure -- the two have opposite remedies",
    );
  });

  it("rejects an explicitly empty principals list instead of scanning the whole tailnet", async () => {
    // The guard was `input.principals && input.principals.length > 0`, so an
    // explicit [] fell through to auto-enumeration: the caller asked for zero
    // principals and got every user and up to 50 requests.
    let usersListed = false;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/users")) {
        usersListed = true;
        return mockFetchResponse(200, { users: [{ loginName: "alice@example.com" }] });
      }
      return mockFetchResponse(200, BASELINE);
    };

    const res = await runDiff({ policy: '{"acls":[]}', principals: [] });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /empty list/);
    assert.equal(usersListed, false, "an empty list must not silently become 'check everyone'");
  });
});

/**
 * Third wave, from a coverage pass over the finished tool.
 *
 * These cover branches the first two waves left dead rather than defects found
 * by review: the two email-field fallbacks, the whitespace filter, the
 * both-qualifiers key, the postures sort, dedup on an explicit list, the
 * no-ports match, and one run that exercises all three result buckets at once.
 */
describe("tailscale_diff_acl_access -- branch coverage", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
    delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
    delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
    globalThis.fetch = async () => mockFetchResponse(599, "no test installed a fetch stub");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  const BASELINE = '{"acls":[{"action":"accept","src":["alice@example.com"],"dst":["tag:prod:22"]}]}';

  function preview(matches: Array<Record<string, unknown>>, previewFor: string) {
    return { matches, type: "user", previewFor };
  }

  function installFetch(opts: {
    users?: Array<Record<string, unknown>>;
    onPreview: (policy: string, principal: string) => { status?: number; body: unknown };
    previewUrls?: string[];
  }) {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/acl/preview")) {
        opts.previewUrls?.push(url);
        const principal = new URL(url).searchParams.get("previewFor") ?? "";
        const result = opts.onPreview((init?.body as string) ?? "", principal);
        return mockFetchResponse(result.status ?? 200, result.body);
      }
      if (url.includes("/users")) return mockFetchResponse(200, { users: opts.users ?? [] });
      if (url.includes("/acl")) return mockFetchResponse(200, BASELINE);
      return mockFetchResponse(599, "unexpected URL in test");
    };
  }

  async function runDiff(input: Record<string, unknown>) {
    const { aclTools } = await import("./tools/acl.js");
    return (await findTool(aclTools, "tailscale_diff_acl_access").handler(input)) as {
      ok: boolean;
      error?: string;
      data?: {
        summary: string;
        principalsCompared: number;
        principalsFailed: number;
        principalsAvailable: number;
        truncated: boolean;
        changed: Array<{ principal: string; lost: string[]; gained: string[] }>;
        unchanged: string[];
        failed: Array<{ principal: string; error: string }>;
      };
    };
  }

  it("falls back to `email` and then `name` when `loginName` is absent", async () => {
    // Both fallback arms were dead: every existing fixture supplies loginName.
    // They exist to survive a Tailscale field rename, so without coverage their
    // first execution would be during the incident they were written for.
    const seen: string[] = [];
    installFetch({
      users: [{ email: "via-email@example.com" }, { name: "via-name@example.com" }],
      previewUrls: [],
      onPreview: (_policy, principal) => {
        seen.push(principal);
        return { body: preview([{ ports: ["p:1"], lineNumber: 1 }], principal) };
      },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.ok, true);
    assert.deepEqual(
      [...new Set(seen)].sort(),
      ["via-email@example.com", "via-name@example.com"],
      "both fallback fields must resolve to principals",
    );
    assert.equal(res.data?.principalsAvailable, 2);
  });

  it("drops whitespace-only and non-string user fields rather than previewing them", async () => {
    // A blank principal would go out as previewFor=%20%20%20 and come back as a
    // per-user failure that reads like an API fault rather than a bad record.
    const seen: string[] = [];
    installFetch({
      users: [
        { loginName: "   " },
        { loginName: "" },
        { loginName: 12345 },
        { loginName: null },
        { loginName: "real@example.com" },
      ],
      onPreview: (_policy, principal) => {
        seen.push(principal);
        return { body: preview([{ ports: ["p:1"], lineNumber: 1 }], principal) };
      },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual([...new Set(seen)], ["real@example.com"]);
    assert.equal(res.data?.principalsAvailable, 1);
    assert.deepEqual(res.data?.failed, [], "a filtered record must not surface as a failed principal");
  });

  it("errors when every user field is whitespace, rather than diffing nobody", async () => {
    installFetch({
      users: [{ loginName: "   " }, { loginName: "\t" }],
      onPreview: (_p, principal) => ({ body: preview([], principal) }),
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /no user emails could be read/);
  });

  it("composes the key from via AND postures when a match carries both", async () => {
    // One test varies via, another varies postures, neither has both -- so the
    // concatenation joining them was unasserted. "Reachable through a relay and
    // only from a compliant device" is an ordinary rule shape, and a wrong join
    // changes the key identically on both sides, which reads as unchanged.
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE
          ? { body: preview([{ ports: ["tag:prod:22"], lineNumber: 1 }], principal) }
          : {
              body: preview(
                [{ ports: ["tag:prod:22"], via: ["tag:relay"], postures: ["posture:mac"], lineNumber: 1 }],
                principal,
              ),
            },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, [
      {
        principal: "alice@example.com",
        lost: ["tag:prod:22"],
        gained: ["tag:prod:22 via tag:relay posture posture:mac"],
      },
    ]);
  });

  it("treats a reordered postures list as unchanged, pinning that sort too", async () => {
    // The identical sort() on the adjacent `via` line is pinned; this one was
    // not. The API is under no obligation to return either list in a stable
    // order, and the failure mode is a fabricated change on both sides.
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE
          ? { body: preview([{ ports: ["p:1"], postures: ["posture:a", "posture:b"], lineNumber: 1 }], principal) }
          : { body: preview([{ ports: ["p:1"], postures: ["posture:b", "posture:a"], lineNumber: 1 }], principal) },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, [], "posture ordering is not semantic");
    assert.deepEqual(res.data?.unchanged, ["alice@example.com"]);
  });

  it("dedupes an explicit principals list instead of previewing a user twice", async () => {
    // An agent assembling a principal list from two sources will pass
    // duplicates; a regression here doubles the request count against the time
    // budget and overstates principalsAvailable.
    const previewUrls: string[] = [];
    installFetch({
      previewUrls,
      onPreview: (_p, principal) => ({ body: preview([{ ports: ["p:1"], lineNumber: 1 }], principal) }),
    });

    const res = await runDiff({
      policy: '{"acls":[]}',
      principals: ["a@example.com", "a@example.com", "a@example.com"],
    });
    assert.equal(res.data?.principalsAvailable, 1);
    assert.equal(res.data?.principalsCompared, 1);
    assert.equal(previewUrls.length, 2, "one principal costs exactly two previews");
  });

  it("ignores a match that grants no ports rather than inventing a bare qualifier", async () => {
    // The doc comment states this is deliberate but nothing enforced it. A
    // change that emitted the qualifier alone would invent an access entry on
    // both sides, and this tool's contract is that it does not invent findings.
    installFetch({
      users: [{ loginName: "alice@example.com" }],
      onPreview: (policy, principal) =>
        policy === BASELINE
          ? { body: preview([{ ports: ["p:1"], lineNumber: 1 }], principal) }
          : {
              body: preview(
                [
                  { ports: ["p:1"], lineNumber: 1 },
                  { via: ["tag:relay"], postures: ["posture:mac"], lineNumber: 2 },
                ],
                principal,
              ),
            },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.deepEqual(res.data?.changed, [], "a portless match grants no enumerable destination");
    assert.deepEqual(res.data?.unchanged, ["alice@example.com"]);
  });

  it("reports all three buckets and both denominators correctly in one run", async () => {
    // The summary computes across changed/unchanged/failed with TWO different
    // denominators -- `attempted` for failures, `compared` for losses -- which
    // is exactly where an off-by-one hides. Existing tests exercise the buckets
    // in isolation or in pairs.
    installFetch({
      users: [
        { loginName: "loses@example.com" },
        { loginName: "same1@example.com" },
        { loginName: "broken@example.com" },
        { loginName: "same2@example.com" },
      ],
      onPreview: (policy, principal) => {
        if (principal === "broken@example.com" && policy !== BASELINE) {
          return { status: 500, body: { message: "boom" } };
        }
        if (principal === "loses@example.com" && policy !== BASELINE) {
          return { body: preview([], principal) };
        }
        return { body: preview([{ ports: ["tag:prod:22"], lineNumber: 1 }], principal) };
      },
    });

    const res = await runDiff({ policy: '{"acls":[]}' });
    assert.equal(res.ok, true);
    assert.equal(res.data?.principalsCompared, 3, "4 attempted minus 1 failed");
    assert.equal(res.data?.principalsFailed, 1);
    assert.deepEqual(res.data?.changed, [{ principal: "loses@example.com", lost: ["tag:prod:22"], gained: [] }]);
    assert.deepEqual(res.data?.unchanged, ["same1@example.com", "same2@example.com"]);
    assert.equal(res.data?.failed.length, 1);
    // Both denominators in one string: failures over ATTEMPTED, losses over COMPARED.
    assert.equal(
      res.data?.summary,
      "1 of 4 users could not be checked, 1 of 3 users compared lose access, 0 gain access, 2 unchanged",
    );
  });
});

describe("tailscale_diff_acl_access -- posture definitions", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
    delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
    delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
    globalThis.fetch = async () => mockFetchResponse(599, "no test installed a fetch stub");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  const BASELINE = '{"acls":[{"action":"accept","src":["alice@example.com"],"dst":["tag:prod:22"]}]}';

  /**
   * A preview response in the shape a LIVE tailnet returns -- verified by probing the
   * real API, not inferred from the Go struct. Two details came from that probe and
   * are reproduced deliberately: `postures` on a match is an explicit `null` when the
   * rule has no posture requirement, and the top-level definitions map is ABSENT
   * entirely (not empty) when the submitted policy defines no postures.
   */
  function preview(
    matches: Array<Record<string, unknown>>,
    previewFor: string,
    postureDefs?: Record<string, string[]>,
  ) {
    const body: Record<string, unknown> = { matches, type: "user", previewFor };
    if (postureDefs) body.postures = postureDefs;
    return body;
  }

  function installFetch(onPreview: (policy: string, principal: string) => unknown) {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/acl/preview")) {
        const principal = new URL(url).searchParams.get("previewFor") ?? "";
        return mockFetchResponse(200, onPreview((init?.body as string) ?? "", principal));
      }
      if (url.includes("/users")) return mockFetchResponse(200, { users: [{ loginName: "alice@example.com" }] });
      if (url.includes("/acl")) return mockFetchResponse(200, BASELINE);
      return mockFetchResponse(599, "unexpected URL");
    };
  }

  async function runDiff() {
    const { aclTools } = await import("./tools/acl.js");
    return (await findTool(aclTools, "tailscale_diff_acl_access").handler({ policy: '{"acls":[]}' })) as {
      ok: boolean;
      data?: {
        scope: string;
        changed: Array<{ principal: string; lost: string[]; gained: string[] }>;
        unchanged: string[];
      };
    };
  }

  it("detects a posture DEFINITION tightening that leaves every name identical", async () => {
    // The silent false-clean this fix exists for. The rule, the destination and the
    // posture NAME are byte-identical on both sides; only the definition moved, and
    // every device below the new version bound loses the destination. Before the
    // fix this reported "unchanged" for the whole tailnet.
    installFetch((policy, principal) =>
      policy === BASELINE
        ? preview([{ ports: ["tag:prod:22"], postures: ["posture:corp"], lineNumber: 3 }], principal, {
            "posture:corp": ["node:os == 'macos'"],
          })
        : preview([{ ports: ["tag:prod:22"], postures: ["posture:corp"], lineNumber: 3 }], principal, {
            "posture:corp": ["node:os == 'macos'", "node:tsVersion >= '1.80'"],
          }),
    );

    const res = await runDiff();
    assert.equal(res.data?.changed.length, 1, "a redefinition must not read as unchanged");
    assert.deepEqual(res.data?.changed[0]?.lost, ["tag:prod:22 posture posture:corp(node:os == 'macos')"]);
    assert.deepEqual(res.data?.changed[0]?.gained, [
      "tag:prod:22 posture posture:corp(node:os == 'macos';node:tsVersion >= '1.80')",
    ]);
  });

  it("treats a reordered definition as unchanged", async () => {
    // The rules are a set, not a sequence; without the sort a reordered definition
    // would read as a tightening and the tool would cry wolf.
    installFetch((policy, principal) =>
      policy === BASELINE
        ? preview([{ ports: ["p:1"], postures: ["posture:corp"], lineNumber: 1 }], principal, {
            "posture:corp": ["a == 1", "b == 2"],
          })
        : preview([{ ports: ["p:1"], postures: ["posture:corp"], lineNumber: 1 }], principal, {
            "posture:corp": ["b == 2", "a == 1"],
          }),
    );

    const res = await runDiff();
    assert.deepEqual(res.data?.changed, []);
    assert.deepEqual(res.data?.unchanged, ["alice@example.com"]);
  });

  it("falls back to names when only ONE side supplies definitions", async () => {
    // Resolving one side and not the other would manufacture a change on every
    // posture-gated grant -- an API-shape difference read as a security finding.
    // Under-reporting here is the safe direction for a tool that must not cry wolf.
    installFetch((policy, principal) =>
      policy === BASELINE
        ? preview([{ ports: ["p:1"], postures: ["posture:corp"], lineNumber: 1 }], principal, {
            "posture:corp": ["node:os == 'macos'"],
          })
        : preview([{ ports: ["p:1"], postures: ["posture:corp"], lineNumber: 1 }], principal),
    );

    const res = await runDiff();
    assert.deepEqual(res.data?.changed, [], "a missing map must not invent a change");
    assert.deepEqual(res.data?.unchanged, ["alice@example.com"]);
  });

  it("still detects a posture being ADDED, which the name alone carries", async () => {
    installFetch((policy, principal) =>
      policy === BASELINE
        ? preview([{ ports: ["p:1"], postures: null, lineNumber: 1 }], principal)
        : preview([{ ports: ["p:1"], postures: ["posture:corp"], lineNumber: 1 }], principal, {
            "posture:corp": ["node:os == 'macos'"],
          }),
    );

    const res = await runDiff();
    assert.equal(res.data?.changed.length, 1);
    assert.deepEqual(res.data?.changed[0]?.lost, ["p:1"]);
    assert.deepEqual(res.data?.changed[0]?.gained, ["p:1 posture posture:corp"]);
  });

  it("tolerates the explicit null a live tailnet returns for a postureless match", async () => {
    // Probed shape: matches carry `"postures": null`, not an absent key. `?? []`
    // handles both, and this pins that a stricter read would break against the API.
    installFetch((_policy, principal) => preview([{ ports: ["p:1"], postures: null, lineNumber: 1 }], principal));
    const res = await runDiff();
    assert.equal(res.ok, true);
    assert.deepEqual(res.data?.unchanged, ["alice@example.com"]);
  });

  it("keeps a name unresolved by the map in its bare form", async () => {
    // `name()` would collide with a genuinely empty definition, so an unresolvable
    // name stays bare rather than rendering empty parentheses.
    installFetch((policy, principal) =>
      policy === BASELINE
        ? preview([{ ports: ["p:1"], postures: ["posture:ghost"], lineNumber: 1 }], principal, {
            "posture:other": ["x"],
          })
        : preview([{ ports: ["p:1"], postures: ["posture:ghost"], lineNumber: 1 }], principal, {
            "posture:other": ["x"],
          }),
    );
    const res = await runDiff();
    assert.deepEqual(res.data?.changed, [], "an unresolvable name is stable across both sides");
  });

  it("states the corrected scope: postures compared, no port-range caveat", async () => {
    // The port-range limitation was DISPROVED against the live API -- `ip: [22,80,443]`
    // returns three separate port entries, never a comma-joined one -- so claiming it
    // told operators the tool was less precise than it is.
    installFetch((_policy, principal) => preview([{ ports: ["p:1"], lineNumber: 1 }], principal));
    const res = await runDiff();
    assert.match(res.data?.scope ?? "", /Posture definition changes ARE compared/);
    assert.match(res.data?.scope ?? "", /tags or groups/);
    assert.ok(!/port list is narrowed/.test(res.data?.scope ?? ""), "that limitation does not exist");
  });
});
