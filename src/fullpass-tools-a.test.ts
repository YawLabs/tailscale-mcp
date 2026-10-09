import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

// Pins for the full-pass fixes in src/tools/{acl,keys,log-streaming,webhooks}.ts.
// Same harness shape as handlers.test.ts: handlers are called directly, and a
// default 599 fetch stub keeps any unstubbed call off the real API.

type AnyTool = {
  name: string;
  description: string;
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  handler: (input?: unknown) => Promise<unknown>;
};
function findTool(tools: ReadonlyArray<{ name: string }>, name: string): AnyTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool as unknown as AnyTool;
}

describe("full-pass tools-a fixes", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
    delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
    delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
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

  describe("empty key and webhook ids are refused at the schema", () => {
    const cases: Array<[string, string, string, Record<string, unknown>]> = [
      ["keys", "tailscale_get_key", "keyId", {}],
      ["keys", "tailscale_delete_key", "keyId", {}],
      ["keys", "tailscale_update_key", "keyId", { description: "x" }],
      ["webhooks", "tailscale_get_webhook", "webhookId", {}],
      ["webhooks", "tailscale_update_webhook", "webhookId", { subscriptions: ["nodeCreated"] }],
      ["webhooks", "tailscale_delete_webhook", "webhookId", {}],
      ["webhooks", "tailscale_rotate_webhook_secret", "webhookId", {}],
      ["webhooks", "tailscale_test_webhook", "webhookId", {}],
    ];
    for (const [mod, name, field, extra] of cases) {
      it(`${name} rejects "" and " " for ${field} and accepts a real id`, async () => {
        const tools =
          mod === "keys"
            ? (await import("./tools/keys.js")).keyTools
            : (await import("./tools/webhooks.js")).webhookTools;
        const schema = findTool(tools, name).inputSchema;
        assert.equal(schema.safeParse({ ...extra, [field]: "" }).success, false);
        assert.equal(schema.safeParse({ ...extra, [field]: "  " }).success, false);
        assert.equal(schema.safeParse({ ...extra, [field]: "k123" }).success, true);
      });
    }
  });

  describe("webhook endpointUrl scheme check", () => {
    it("accepts an uppercase HTTPS scheme and still rejects http", async () => {
      const { webhookTools } = await import("./tools/webhooks.js");
      const schema = findTool(webhookTools, "tailscale_create_webhook").inputSchema;
      const sub = { subscriptions: ["nodeCreated"] };
      assert.equal(schema.safeParse({ ...sub, endpointUrl: "HTTPS://example.com/hook" }).success, true);
      assert.equal(schema.safeParse({ ...sub, endpointUrl: "Https://example.com/hook" }).success, true);
      assert.equal(schema.safeParse({ ...sub, endpointUrl: "https://example.com/hook" }).success, true);
      assert.equal(schema.safeParse({ ...sub, endpointUrl: "http://example.com/hook" }).success, false);
      assert.equal(schema.safeParse({ ...sub, endpointUrl: "HTTP://example.com/hook" }).success, false);
    });
  });

  describe("tailscale_get_acl without an ETag header", () => {
    it("appends a warning instead of returning bare policy text, and does not stack it", async () => {
      const { aclTools } = await import("./tools/acl.js");
      const handler = findTool(aclTools, "tailscale_get_acl").handler;
      const policy = '{\n  "acls": [],\n}\n';
      globalThis.fetch = async () => new Response(policy, { status: 200 });
      const first = (await handler()) as { ok: boolean; rawBody: string };
      assert.equal(first.ok, true);
      assert.ok(first.rawBody.startsWith('{\n  "acls": [],\n}'));
      assert.match(first.rawBody, /^\/\/ WARNING: the API returned no ETag/m);
      assert.doesNotMatch(first.rawBody, /^\/\/ ETag: /m);

      // Round-tripped back with an ETag now present: the warning is replaced,
      // not kept alongside the footer.
      globalThis.fetch = async () => new Response(first.rawBody, { status: 200, headers: { etag: '"e2"' } });
      const second = (await handler()) as { rawBody: string };
      assert.doesNotMatch(second.rawBody, /WARNING: the API returned no ETag/);
      assert.deepEqual(second.rawBody.match(/^\/\/ ETag: .*$/gm), ['// ETag: "e2"']);
    });
  });

  describe("tailscale_update_acl strips the get_acl footer before posting", () => {
    async function capturePost(policy: string): Promise<string> {
      const { aclTools } = await import("./tools/acl.js");
      let sent = "";
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent = String(init?.body ?? "");
        return new Response("{}", { status: 200 });
      };
      await findTool(aclTools, "tailscale_update_acl").handler({ policy, etag: '"e1"' });
      return sent;
    }

    it("removes the footer a get_acl round-trip carries", async () => {
      const { aclTools } = await import("./tools/acl.js");
      const stored = '{\n  "acls": [],\n}\n// keep: reviewed\n';
      globalThis.fetch = async () => new Response(stored, { status: 200, headers: { etag: '"e1"' } });
      const got = (await findTool(aclTools, "tailscale_get_acl").handler()) as { rawBody: string };
      assert.match(got.rawBody, /^\/\/ ETag: "e1"$/m);

      const sent = await capturePost(got.rawBody);
      assert.doesNotMatch(sent, /ETag/);
      assert.ok(sent.includes("// keep: reviewed"), "the policy's own trailing comment survives");
    });

    it("sends a policy with no footer byte-identical", async () => {
      const policy = '// header\n{\n  "acls": [], // inline\n}\n';
      assert.equal(await capturePost(policy), policy);
    });
  });

  describe("tailscale_diff_acl_access description", () => {
    it("does not claim the 60s budget stops an in-flight pair", async () => {
      const { aclTools } = await import("./tools/acl.js");
      const desc = findTool(aclTools, "tailscale_diff_acl_access").description;
      assert.doesNotMatch(desc, /60 seconds regardless/);
      assert.match(desc, /stops starting new users after 60 seconds/);
    });
  });

  describe("tailscale_list_log_stream_configs with unconfigured streams", () => {
    function stub(configStatus: number, networkStatus: number) {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const status = url.includes("/logging/configuration/") ? configStatus : networkStatus;
        if (status === 200) return new Response(JSON.stringify({ destinationType: "axiom" }), { status });
        return new Response(JSON.stringify({ message: `status ${status}` }), { status });
      };
    }

    it("reads two 404s as nothing configured, not as a failure", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      stub(404, 404);
      const result = (await findTool(logStreamingTools, "tailscale_list_log_stream_configs").handler()) as {
        ok: boolean;
        data: { configuration: unknown; network: unknown; errors: Record<string, string> };
      };
      assert.equal(result.ok, true);
      assert.equal(result.data.configuration, null);
      assert.equal(result.data.network, null);
      assert.match(result.data.errors.configuration, /HTTP 404: not configured/);
      assert.match(result.data.errors.network, /cannot view it/);
    });

    it("keeps a real failure next to a 404 as a partial result", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      stub(404, 500);
      const result = (await findTool(logStreamingTools, "tailscale_list_log_stream_configs").handler()) as {
        ok: boolean;
        data: { errors: Record<string, string> };
      };
      assert.equal(result.ok, true);
      assert.match(result.data.errors.configuration, /not configured/);
      assert.match(result.data.errors.network, /status 500/);
    });

    it("still fails when both arms fail with a non-404", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      stub(403, 500);
      const result = (await findTool(logStreamingTools, "tailscale_list_log_stream_configs").handler()) as {
        ok: boolean;
        error: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.error, /Both log streams failed/);
    });
  });

  describe("tailscale_set_log_stream_config s3 auth-mode guard", () => {
    const base = {
      logType: "network",
      destinationType: "s3",
      s3Bucket: "b",
      s3Region: "us-east-1",
    };

    it("rejects access-key credentials under rolearn", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler;
      await assert.rejects(
        () =>
          handler({
            ...base,
            s3AuthenticationType: "rolearn",
            s3RoleArn: "arn:aws:iam::1:role/r",
            s3AccessKeyId: "AKIA",
            s3SecretAccessKey: "s",
          }),
        { message: /s3AccessKeyId, s3SecretAccessKey cannot be used with s3AuthenticationType 'rolearn'/ },
      );
    });

    it("rejects s3RoleArn under accesskey", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      const handler = findTool(logStreamingTools, "tailscale_set_log_stream_config").handler;
      await assert.rejects(
        () =>
          handler({
            ...base,
            s3AuthenticationType: "accesskey",
            s3AccessKeyId: "AKIA",
            s3SecretAccessKey: "s",
            s3RoleArn: "arn:aws:iam::1:role/r",
          }),
        { message: /s3RoleArn cannot be used with s3AuthenticationType 'accesskey'/ },
      );
    });

    it("still forwards url on s3, which the spec allows as a custom endpoint", async () => {
      const { logStreamingTools } = await import("./tools/log-streaming.js");
      let sent: Record<string, unknown> = {};
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body ?? "{}"));
        return new Response("{}", { status: 200 });
      };
      await findTool(logStreamingTools, "tailscale_set_log_stream_config").handler({
        ...base,
        s3AuthenticationType: "rolearn",
        s3RoleArn: "arn:aws:iam::1:role/r",
        url: "https://s3.example.com",
      });
      assert.equal(sent.url, "https://s3.example.com");
      assert.equal(sent.s3RoleArn, "arn:aws:iam::1:role/r");
    });
  });
});
