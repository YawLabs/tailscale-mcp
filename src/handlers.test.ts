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
  annotations: { readOnlyHint?: boolean };
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

    it("should include description even if empty string", async () => {
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
      assert.equal(parsed.description, "");
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
      await handler({ start: "2026-01-01T00:00:00Z", end: "2026-01-31T23:59:59Z" });
      assert.ok(capturedUrl.includes("start=2026-01-01T00%3A00%3A00Z"));
      assert.ok(capturedUrl.includes("end=2026-01-31T23%3A59%3A59Z"));
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
      await handler({ start: "2026-04-01T00:00:00Z" });
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
      const result = await handler({ start: "2026-04-01T00:00:00.123-05:00" });
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
});
