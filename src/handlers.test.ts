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
      await handler({ fields: "id,name,addresses" });
      assert.ok(capturedUrl.includes("fields=id%2Cname%2Caddresses"));
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
      // URLSearchParams.set replaces; without this guard a filters.fields entry
      // would silently overwrite the top-level fields= the caller set, losing
      // their explicit column selection.
      const { deviceTools } = await import("./tools/devices.js");
      const handler = findTool(deviceTools, "tailscale_list_devices").handler as (input: {
        fields?: string;
        filters?: Record<string, string>;
      }) => Promise<unknown>;
      await assert.rejects(() => handler({ fields: "id", filters: { fields: "all" } }), {
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
  });

  describe("tailscale_update_acl", () => {
    it("should send raw HuJSON body with If-Match header", async () => {
      const { aclTools } = await import("./tools/acl.js");
      let capturedHeaders: Headers | undefined;
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { success: true });
      };

      const handler = findTool(aclTools, "tailscale_update_acl").handler as (input: {
        policy: string;
        etag: string;
      }) => Promise<unknown>;
      await handler({ policy: '{ /* hujson */ "acls": [] }', etag: '"etag-1"' });
      assert.equal(capturedHeaders?.get("If-Match"), '"etag-1"');
      assert.equal(capturedHeaders?.get("Content-Type"), "application/hujson");
      assert.equal(capturedBody, '{ /* hujson */ "acls": [] }');
    });
  });

  describe("tailscale_create_key", () => {
    it("should include expirySeconds when set to a number", async () => {
      const { keyTools } = await import("./tools/keys.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { key: "tskey-auth-test" });
      };

      const handler = findTool(keyTools, "tailscale_create_key").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ expirySeconds: 3600, description: "test key" });
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
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { success: true });
      };

      // The update tool is index 1
      const handler = findTool(tailnetTools, "tailscale_update_tailnet_settings").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ devicesApprovalOn: true });
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
      });
      const parsed = JSON.parse(capturedBody!);
      assert.equal(Object.keys(parsed).length, 9);
      assert.equal(parsed.httpsEnabled, true);
      assert.equal(parsed.devicesKeyDurationDays, 90);
      assert.equal(parsed.usersRoleAllowedToJoinExternalTailnets, "member");
      assert.equal(parsed.postureIdentityCollectionOn, false);
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
      assert.ok(capturedUrl.includes("start=2026-01-01T00%3A00%3A00Z"));
      assert.ok(capturedUrl.includes("end=2026-01-30T23%3A59%3A59Z"));
    });
  });

  describe("tailscale_set_contacts", () => {
    it("should only send provided contact fields via per-type PATCH calls", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      let capturedUrl = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };

      // set_contacts is index 3
      const handler = findTool(tailnetTools, "tailscale_set_contacts").handler as (
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      await handler({ security: { email: "sec@example.com" } });
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
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
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
      });
      assert.ok(capturedUrl.includes("/device/dev-123/attributes/custom%3Aaudit"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.value, "passed");
      assert.equal(parsed.expiry, "2026-12-01T00:00:00Z");
    });

    it("should omit expiry when not provided", async () => {
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
      assert.equal(parsed.value, "passed");
      assert.ok(!("expiry" in parsed));
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
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, {});
      };

      const handler = findTool(userTools, "tailscale_suspend_user").handler as (input: {
        userId: string;
      }) => Promise<unknown>;
      await handler({ userId: "user-456" });
      assert.ok(capturedUrl.includes("/users/user-456/suspend"));
    });
  });

  describe("tailscale_restore_user", () => {
    it("should POST to the restore endpoint", async () => {
      const { userTools } = await import("./tools/users.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, {});
      };

      const handler = findTool(userTools, "tailscale_restore_user").handler as (input: {
        userId: string;
      }) => Promise<unknown>;
      await handler({ userId: "user-456" });
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
      assert.ok(capturedUrl.endsWith("/device/dev-1"));
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
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      await (
        findTool(deviceTools, "tailscale_deauthorize_device").handler as (input: {
          deviceId: string;
        }) => Promise<unknown>
      )({ deviceId: "dev-1" });
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
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = init?.body as string;
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
      assert.ok(capturedUrl.includes("/device/dev-1/name"));
      assert.deepEqual(JSON.parse(capturedBody!), { name: "new-name.tail.ts.net" });
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
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = init?.body as string;
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
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      await (
        findTool(dnsTools, "tailscale_set_search_paths").handler as (input: {
          searchPaths: string[];
        }) => Promise<unknown>
      )({
        searchPaths: ["corp.example.com"],
      });
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
    it("should POST the split DNS map directly to /dns/split-dns", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      await (
        findTool(dnsTools, "tailscale_set_split_dns").handler as (input: {
          splitDns: Record<string, string[]>;
        }) => Promise<unknown>
      )({
        splitDns: { "corp.example.com": ["10.0.0.1"] },
      });
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
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };
      await (
        findTool(dnsTools, "tailscale_set_dns_preferences").handler as (input: {
          magicDNS: boolean;
        }) => Promise<unknown>
      )({ magicDNS: false });
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
      const calls: { url: string; body: unknown }[] = [];
      let active = 0;
      let peak = 0;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, body: JSON.parse(init?.body as string) });
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

  describe("Idempotent hints on send-side-effect tools", () => {
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
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/configuration/stream")) return mockFetchResponse(500, { message: "config boom" });
        return mockFetchResponse(503, { message: "network boom" });
      };
      const handler = findTool(logStreamingTools, "tailscale_list_log_stream_configs").handler;
      const result = (await handler()) as { ok: boolean; error?: string };
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /config boom/);
      assert.match(result.error ?? "", /network boom/);
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
    it("should POST to /aws-external-id with no body and no Content-Type leak", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody: string | undefined;
      let capturedContentType: string | null = null;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string | undefined;
        capturedContentType = new Headers(init?.headers).get("Content-Type");
        return mockFetchResponse(200, { externalId: "ext-123" });
      };
      const handler = findTool(logStreamingTools, "tailscale_create_aws_external_id").handler;
      const result = (await handler()) as { ok: boolean };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/aws-external-id"));
      assert.equal(capturedBody, undefined);
      // No body -> no Content-Type header should be set (api.ts:374-380 only
      // sets Content-Type when there's a body to describe). Locks in the
      // "empty POST stays empty" contract so a future apiPost refactor can't
      // silently start sending application/json on body-less calls.
      assert.equal(capturedContentType, null);
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
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
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedBody = init?.body as string;
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
        scopes: ["devices:read", "dns"],
        tags: ["tag:ci"],
      })) as { ok: boolean };
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.keyType, "client");
      assert.deepEqual(parsed.scopes, ["devices:read", "dns"]);
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
            scopes: ["devices:read"],
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
            scopes: ["devices:read"],
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
        scopes: ["devices:read"],
        issuer: "https://token.actions.githubusercontent.com",
        subject: "repo:my-org/my-repo:*",
        audience: "https://api.tailscale.com",
        customClaimRules: { repo_owner: "my-org" },
        tags: ["tag:ci"],
      })) as { ok: boolean };
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.keyType, "federated");
      assert.deepEqual(parsed.scopes, ["devices:read"]);
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
            scopes: ["devices:read"],
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
      await assert.rejects(() => handler({ scopes: ["devices:read"] }), {
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
        scopes: ["devices:read"],
        tags: ["tag:ci"],
      })) as { ok: boolean };
      assert.equal(capturedMethod, "PUT");
      assert.ok(capturedUrl.includes("/keys/k%3A1"));
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.description, "ci-cd token");
      assert.deepEqual(parsed.scopes, ["devices:read"]);
      assert.deepEqual(parsed.tags, ["tag:ci"]);
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
        filters?: Record<string, string>;
      }) => Promise<unknown>;
      const result = (await handler({ filters: { isEphemeral: "true", os: "linux" } })) as { ok: boolean };
      assert.ok(capturedUrl.includes("isEphemeral=true"), `missing isEphemeral= in: ${capturedUrl}`);
      assert.ok(capturedUrl.includes("os=linux"), `missing os= in: ${capturedUrl}`);
      assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
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
});
