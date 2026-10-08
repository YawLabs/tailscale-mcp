import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { z } from "zod";

type AnyTool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
};

function findTool(tools: ReadonlyArray<{ name: string }>, name: string): AnyTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool as unknown as AnyTool;
}

describe("full-pass tools-b fixes", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
    delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
    delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
    // Same guardrail as handlers.test.ts: a test that forgets its own stub
    // gets a non-retried 599, never the real network.
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

  describe("tailscale_set_device_routes CIDR check", () => {
    it("rejects a zone-scoped IPv6 prefix that net.isIPv6 alone would accept", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const schema = findTool(deviceTools, "tailscale_set_device_routes").inputSchema;
      assert.equal(schema.safeParse({ deviceId: "n1", routes: ["fe80::1%eth0/64"] }).success, false);
      assert.equal(schema.safeParse({ deviceId: "n1", routes: ["fd7a:115c::/48", "10.0.0.0/24"] }).success, true);
    });
  });

  describe("tailscale_set_devices_authorized", () => {
    it("points at TAILSCALE_MAX_CONCURRENT for large batches, since POSTs are not retried", async () => {
      const { deviceTools } = await import("./tools/devices.js");
      const tool = findTool(deviceTools, "tailscale_set_devices_authorized");
      assert.match(tool.description, /TAILSCALE_MAX_CONCURRENT/);
      assert.match(tool.description, /429/);
    });
  });

  describe("tailscale_update_tailnet_settings devicesKeyDurationDays", () => {
    it("accepts whole days 1-180 and rejects fractions, zero, negatives and >180", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      const schema = findTool(tailnetTools, "tailscale_update_tailnet_settings").inputSchema;
      for (const ok of [1, 90, 180]) {
        assert.equal(schema.safeParse({ devicesKeyDurationDays: ok }).success, true, `expected ${ok} to pass`);
      }
      for (const bad of [0, -1, 0.5, 181]) {
        assert.equal(schema.safeParse({ devicesKeyDurationDays: bad }).success, false, `expected ${bad} to fail`);
      }
    });
  });

  describe("tailscale_set_contacts bodiless success", () => {
    it("records { status } for a type whose PATCH answered 200 with no body, so the key survives JSON", async () => {
      const { tailnetTools } = await import("./tools/tailnet.js");
      globalThis.fetch = async () => new Response(null, { status: 200, headers: { "content-length": "0" } });
      const handler = findTool(tailnetTools, "tailscale_set_contacts").handler;
      const res = (await handler({ security: { email: "sec@example.com" } })) as { ok: boolean; data: unknown };
      assert.equal(res.ok, true);
      assert.deepEqual(JSON.parse(JSON.stringify(res.data)), { security: { status: 200 } });
    });
  });

  describe("audit RFC3339 validation", () => {
    it("rejects lowercase 't'/'z' and says the designators must be uppercase", async () => {
      const { auditTools } = await import("./tools/audit.js");
      const handler = findTool(auditTools, "tailscale_get_audit_log").handler;
      await assert.rejects(() => handler({ start: "2026-04-01t00:00:00z" }), {
        message: /^start must be a valid RFC3339 date-time with an uppercase 'T' and 'Z'/,
      });
    });
  });

  describe("user role constants", () => {
    it("drive the user and invite role enums, with owner excluded from invites", async () => {
      const { USER_ROLES, INVITABLE_ROLES, userTools } = await import("./tools/users.js");
      const { inviteTools } = await import("./tools/invites.js");
      assert.ok(!(INVITABLE_ROLES as readonly string[]).includes("owner"));
      assert.deepEqual(
        INVITABLE_ROLES.filter((r) => !(USER_ROLES as readonly string[]).includes(r)),
        [],
      );
      const list = findTool(userTools, "tailscale_list_users").inputSchema;
      const update = findTool(userTools, "tailscale_update_user_role").inputSchema;
      const invite = findTool(inviteTools, "tailscale_create_user_invite").inputSchema;
      for (const role of USER_ROLES) {
        assert.equal(list.safeParse({ role }).success, true);
        assert.equal(update.safeParse({ userId: "u1", role }).success, true);
      }
      for (const role of INVITABLE_ROLES) assert.equal(invite.safeParse({ role }).success, true);
      assert.equal(invite.safeParse({ role: "owner" }).success, false);
    });
  });

  describe("tool description punctuation", () => {
    it("uses the house '--' rather than a Unicode em dash", async () => {
      // Every tool module, not just this cluster's: the CHANGELOG says the
      // descriptions use `--` throughout.
      const mods = await Promise.all([
        import("./tools/acl.js").then((m) => m.aclTools),
        import("./tools/audit.js").then((m) => m.auditTools),
        import("./tools/devices.js").then((m) => m.deviceTools),
        import("./tools/dns.js").then((m) => m.dnsTools),
        import("./tools/invites.js").then((m) => m.inviteTools),
        import("./tools/keys.js").then((m) => m.keyTools),
        import("./tools/local-cli.js").then((m) => m.localCliTools),
        import("./tools/log-streaming.js").then((m) => m.logStreamingTools),
        import("./tools/posture.js").then((m) => m.postureTools),
        import("./tools/services.js").then((m) => m.serviceTools),
        import("./tools/status.js").then((m) => m.statusTools),
        import("./tools/tailnet.js").then((m) => m.tailnetTools),
        import("./tools/tailnets.js").then((m) => m.tailnetsTools),
        import("./tools/users.js").then((m) => m.userTools),
        import("./tools/webhooks.js").then((m) => m.webhookTools),
      ]);
      const offenders = mods
        .flat()
        .filter((t) => (t as { description: string }).description.includes("—"))
        .map((t) => t.name);
      assert.deepEqual(offenders, []);
    });
  });

  describe("tailscale_list_services description", () => {
    it("no longer claims the API has no create endpoint", async () => {
      const { serviceTools } = await import("./tools/services.js");
      const desc = findTool(serviceTools, "tailscale_list_services").description;
      assert.doesNotMatch(desc, /no API endpoint to create/);
      assert.match(desc, /create-or-update/);
    });
  });
});
