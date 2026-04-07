import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

function mockFetchResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: new Headers(headers),
  });
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
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    });
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

      const handler = statusTools[0].handler;
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

      const handler = deviceTools[0].handler as (input: { fields?: string }) => Promise<unknown>;
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

      const handler = deviceTools[0].handler as (input: { fields?: string }) => Promise<unknown>;
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

      const handler = aclTools[0].handler;
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

      const handler = aclTools[2].handler as (input: { policy: string }) => Promise<{
        ok: boolean;
        data?: { message: string };
      }>;
      const result = await handler({ policy: '{ "acls": [] }' });
      assert.ok(result.ok);
      assert.equal(result.data?.message, "ACL policy is valid.");
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

      const handler = aclTools[1].handler as (input: { policy: string; etag: string }) => Promise<unknown>;
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

      const handler = keyTools[2].handler as (input: Record<string, unknown>) => Promise<unknown>;
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

      const handler = keyTools[2].handler as (input: Record<string, unknown>) => Promise<unknown>;
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
      const handler = tailnetTools[1].handler as (input: Record<string, unknown>) => Promise<unknown>;
      await handler({ devicesApprovalOn: true });
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { devicesApprovalOn: true });
      assert.ok(!("devicesAutoUpdatesOn" in parsed));
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
      const handler = webhookTools[3].handler as (input: {
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

  describe("tailscale_get_network_lock_status", () => {
    it("should call the correct network-lock endpoint", async () => {
      const { networkLockTools } = await import("./tools/network-lock.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { enabled: false });
      };

      const handler = networkLockTools[0].handler;
      await handler();
      assert.ok(
        capturedUrl.includes("/network-lock/status"),
        `Expected URL to contain /network-lock/status, got: ${capturedUrl}`,
      );
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

      const handler = auditTools[0].handler as (input: { start: string; end?: string }) => Promise<unknown>;
      await handler({ start: "2026-01-01T00:00:00Z", end: "2026-01-31T23:59:59Z" });
      assert.ok(capturedUrl.includes("start=2026-01-01T00%3A00%3A00Z"));
      assert.ok(capturedUrl.includes("end=2026-01-31T23%3A59%3A59Z"));
    });
  });

  describe("tailscale_set_contacts", () => {
    it("should only send provided contact fields", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return mockFetchResponse(200, {});
      };

      // set_contacts is index 3
      const handler = tailnetTools[3].handler as (input: Record<string, unknown>) => Promise<unknown>;
      await handler({ security: { email: "sec@example.com" } });
      const parsed = JSON.parse(capturedBody!);
      assert.deepEqual(parsed, { security: { email: "sec@example.com" } });
      assert.ok(!("account" in parsed));
      assert.ok(!("support" in parsed));
    });
  });

  describe("tailscale_status (settings error)", () => {
    it("should surface settings error while still returning ok", async () => {
      const { statusTools } = await import("./tools/status.js");
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/devices")) {
          return mockFetchResponse(200, { devices: [{ id: "1" }] });
        }
        return mockFetchResponse(500, "Internal Server Error");
      };

      const handler = statusTools[0].handler;
      const result = (await handler()) as { ok: boolean; data: { settings?: unknown; settingsError?: string } };
      assert.ok(result.ok);
      assert.equal(result.data.settings, undefined);
      assert.ok(result.data.settingsError);
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
      const handler = deviceTools[9].handler as (input: { deviceId: string }) => Promise<unknown>;
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

      const handler = deviceTools[10].handler as (input: Record<string, unknown>) => Promise<unknown>;
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

      const handler = deviceTools[10].handler as (input: Record<string, unknown>) => Promise<unknown>;
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

      const handler = deviceTools[11].handler as (input: Record<string, unknown>) => Promise<unknown>;
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

      const handler = auditTools[1].handler as (input: { start: string; end?: string }) => Promise<unknown>;
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

      const handler = webhookTools[3].handler as (input: Record<string, unknown>) => Promise<unknown>;
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

      const handler = userTools[2].handler as (input: { userId: string }) => Promise<unknown>;
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

      const handler = userTools[3].handler as (input: { userId: string }) => Promise<unknown>;
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

      const handler = userTools[4].handler as (input: { userId: string }) => Promise<unknown>;
      await handler({ userId: "user-456" });
      assert.ok(capturedUrl.includes("/users/user-456/restore"));
    });
  });

  describe("tailscale_update_user_role", () => {
    it("should PATCH user role", async () => {
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

      const handler = userTools[5].handler as (input: { userId: string; role: string }) => Promise<unknown>;
      await handler({ userId: "user-456", role: "admin" });
      assert.equal(capturedMethod, "PATCH");
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
      await (deviceTools[1].handler as (input: { deviceId: string }) => Promise<unknown>)({ deviceId: "dev-1" });
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
      await (deviceTools[2].handler as (input: { deviceId: string }) => Promise<unknown>)({ deviceId: "dev-1" });
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
      await (deviceTools[3].handler as (input: { deviceId: string }) => Promise<unknown>)({ deviceId: "dev-1" });
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
      await (deviceTools[4].handler as (input: { deviceId: string }) => Promise<unknown>)({ deviceId: "dev-1" });
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
      await (deviceTools[5].handler as (input: { deviceId: string; name: string }) => Promise<unknown>)({
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
      await (deviceTools[6].handler as (input: { deviceId: string }) => Promise<unknown>)({ deviceId: "dev-1" });
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
      await (deviceTools[7].handler as (input: { deviceId: string }) => Promise<unknown>)({ deviceId: "dev-1" });
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
      await (deviceTools[8].handler as (input: { deviceId: string; routes: string[] }) => Promise<unknown>)({
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
      await (deviceTools[12].handler as (input: { deviceId: string; tags: string[] }) => Promise<unknown>)({
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
      await (aclTools[3].handler as (input: { policy: string; type: string; previewFor: string }) => Promise<unknown>)({
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

  // ─── DNS: all 8 tools ───

  describe("tailscale_get_nameservers", () => {
    it("should GET /tailnet/{tailnet}/dns/nameservers", async () => {
      const { dnsTools } = await import("./tools/dns.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { dns: ["8.8.8.8"] });
      };
      await dnsTools[0].handler();
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
      await (dnsTools[1].handler as (input: { dns: string[] }) => Promise<unknown>)({ dns: ["8.8.8.8", "1.1.1.1"] });
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
      await dnsTools[2].handler();
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
      await (dnsTools[3].handler as (input: { searchPaths: string[] }) => Promise<unknown>)({
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
      await dnsTools[4].handler();
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
      await (dnsTools[5].handler as (input: { splitDns: Record<string, string[]> }) => Promise<unknown>)({
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
      await dnsTools[6].handler();
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
      await (dnsTools[7].handler as (input: { magicDNS: boolean }) => Promise<unknown>)({ magicDNS: false });
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
      await keyTools[0].handler();
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
      await (keyTools[1].handler as (input: { keyId: string }) => Promise<unknown>)({ keyId: "k-1" });
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
      await (keyTools[3].handler as (input: { keyId: string }) => Promise<unknown>)({ keyId: "k-1" });
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
      await userTools[0].handler();
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
      await (userTools[1].handler as (input: { userId: string }) => Promise<unknown>)({ userId: "u-1" });
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
      await tailnetTools[0].handler();
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
      await tailnetTools[2].handler();
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
      await webhookTools[0].handler();
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
      await (webhookTools[1].handler as (input: { webhookId: string }) => Promise<unknown>)({ webhookId: "wh-1" });
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
      await (webhookTools[2].handler as (input: { endpointUrl: string; subscriptions: string[] }) => Promise<unknown>)({
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
      await (webhookTools[4].handler as (input: { webhookId: string }) => Promise<unknown>)({ webhookId: "wh-1" });
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
      await postureTools[0].handler();
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
      await (postureTools[1].handler as (input: { integrationId: string }) => Promise<unknown>)({
        integrationId: "pi-1",
      });
      assert.ok(capturedUrl.includes("/posture/integrations/pi-1"));
    });
  });

  describe("tailscale_create_posture_integration", () => {
    it("should POST provider config to /posture/integrations", async () => {
      const { postureTools } = await import("./tools/posture.js");
      let capturedMethod = "";
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { id: "pi-new" });
      };
      await (postureTools[2].handler as (input: Record<string, unknown>) => Promise<unknown>)({
        provider: "crowdstrike",
        clientId: "cs-id",
        clientSecret: "cs-secret",
        tenantId: "tenant-1",
      });
      assert.equal(capturedMethod, "POST");
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.provider, "crowdstrike");
      assert.equal(parsed.clientId, "cs-id");
      assert.equal(parsed.clientSecret, "cs-secret");
      assert.equal(parsed.tenantId, "tenant-1");
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
      await (postureTools[3].handler as (input: Record<string, unknown>) => Promise<unknown>)({
        integrationId: "pi-1",
        clientId: "new-id",
        clientSecret: "new-secret",
      });
      assert.equal(capturedMethod, "PATCH");
      assert.ok(capturedUrl.includes("/posture/integrations/pi-1"));
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
      await (postureTools[4].handler as (input: { integrationId: string }) => Promise<unknown>)({
        integrationId: "pi-1",
      });
      assert.equal(capturedMethod, "DELETE");
      assert.ok(capturedUrl.includes("/posture/integrations/pi-1"));
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
      await (webhookTools[5].handler as (input: { webhookId: string }) => Promise<unknown>)({ webhookId: "wh-1" });
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.includes("/webhooks/wh-1/rotate"));
    });
  });

  // ─── Validation ───

  describe("tailscale_set_device_tags validation", () => {
    it("should reject tags without tag: prefix", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const handler = deviceTools[12].handler as (input: { deviceId: string; tags: string[] }) => Promise<unknown>;
      await assert.rejects(() => handler({ deviceId: "dev-1", tags: ["server", "tag:valid"] }), {
        message: /must start with 'tag:'/,
      });
    });
  });

  describe("tailscale_set_device_posture_attribute validation", () => {
    it("should reject attribute keys without custom: prefix", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const handler = deviceTools[10].handler as (input: Record<string, unknown>) => Promise<unknown>;
      await assert.rejects(() => handler({ deviceId: "dev-1", attributeKey: "badKey", value: "v" }), {
        message: /must start with 'custom:'/,
      });
    });
  });

  describe("tailscale_get_audit_log validation", () => {
    it("should reject invalid RFC3339 start date", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = auditTools[0].handler as (input: { start: string; end?: string }) => Promise<unknown>;
      await assert.rejects(() => handler({ start: "not-a-date" }), { message: /must be a valid RFC3339/ });
    });
  });

  // ─── Invites ───

  describe("tailscale_list_device_invites", () => {
    it("should GET /tailnet/{tailnet}/device-invites", async () => {
      const { inviteTools } = await import("./tools/invites.js");
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, []);
      };
      await inviteTools[0].handler();
      assert.ok(capturedUrl.includes("/tailnet/test.ts.net/device-invites"));
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
      await (inviteTools[5].handler as (input: Record<string, unknown>) => Promise<unknown>)({
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
      await (dnsTools[5].handler as (input: { splitDns: Record<string, string[]> }) => Promise<unknown>)({
        splitDns: { "example.com": ["10.0.0.1"] },
      });
      assert.equal(capturedMethod, "PUT");
    });
  });
});
