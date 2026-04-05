import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

function mockFetchResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: new Headers(headers) }
  );
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
      const result = await handler() as { ok: boolean; data: { deviceCount: number; connected: boolean } };
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
      const result = await handler() as { ok: boolean; rawBody: string };
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

      const handler = aclTools[2].handler as (input: { policy: string }) => Promise<{ ok: boolean; data?: { message: string } }>;
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
      const handler = webhookTools[3].handler as (input: { webhookId: string; subscriptions: string[] }) => Promise<unknown>;
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
      assert.ok(capturedUrl.includes("/network-lock/status"), `Expected URL to contain /network-lock/status, got: ${capturedUrl}`);
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
      const result = await handler() as { ok: boolean; data: { settings?: unknown; settingsError?: string } };
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
      await handler({ deviceId: "dev-123", attributeKey: "custom:audit", value: "passed", expiry: "2026-12-01T00:00:00Z" });
      assert.ok(capturedUrl.includes("/device/dev-123/attributes/custom:audit"));
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
      assert.ok(capturedUrl.includes("/device/dev-123/attributes/custom:audit"));
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
});
