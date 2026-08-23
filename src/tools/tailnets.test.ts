import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { tailnetsTools } from "./tailnets.js";

function mockFetchResponse(status: number, body: unknown) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

type AnyTool = {
  name: string;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  handler: (input?: unknown) => Promise<unknown>;
};
function findTool(name: string): AnyTool {
  const tool = tailnetsTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool as unknown as AnyTool;
}

describe("org-tailnets tools", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
    delete process.env.TAILSCALE_OAUTH_TAILNET;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  describe("tailscale_list_org_tailnets", () => {
    it("defaults the organization to '-' and sends no pagination params", async () => {
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { tailnets: [] });
      };
      const handler = findTool("tailscale_list_org_tailnets").handler as (i: unknown) => Promise<unknown>;
      await handler({});
      assert.ok(capturedUrl.endsWith("/organizations/-/tailnets"), `got ${capturedUrl}`);
    });

    it("passes limit and cursor through when provided", async () => {
      // Pagination landed on this endpoint in Aug 2026; without forwarding the
      // cursor an agent silently sees only the first page.
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { tailnets: [], cursor: "" });
      };
      const handler = findTool("tailscale_list_org_tailnets").handler as (i: unknown) => Promise<unknown>;
      await handler({ limit: 50, cursor: "abc/def" });
      assert.ok(capturedUrl.includes("limit=50"), `got ${capturedUrl}`);
      assert.ok(capturedUrl.includes("cursor=abc%2Fdef"), `got ${capturedUrl}`);
    });

    it("percent-encodes an explicit organization id", async () => {
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, { tailnets: [] });
      };
      const handler = findTool("tailscale_list_org_tailnets").handler as (i: unknown) => Promise<unknown>;
      await handler({ organization: "org/1" });
      assert.ok(capturedUrl.includes("/organizations/org%2F1/tailnets"), `got ${capturedUrl}`);
    });

    it("is marked read-only", () => {
      assert.equal(findTool("tailscale_list_org_tailnets").annotations.readOnlyHint, true);
    });
  });

  describe("tailscale_create_org_tailnet", () => {
    it("POSTs displayName to the organization's tailnets collection", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedBody = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "";
        capturedBody = String(init?.body ?? "");
        return mockFetchResponse(200, { id: "tn-1", oauthClient: { id: "c", secret: "s" } });
      };
      const handler = findTool("tailscale_create_org_tailnet").handler as (i: unknown) => Promise<unknown>;
      const res = (await handler({ displayName: "Agent Sandbox" })) as { ok: boolean };
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedUrl.endsWith("/organizations/-/tailnets"), `got ${capturedUrl}`);
      assert.deepEqual(JSON.parse(capturedBody), { displayName: "Agent Sandbox" });
      assert.ok(res.ok);
    });

    it("rejects an empty displayName at the schema layer", () => {
      const schema = findTool("tailscale_create_org_tailnet").inputSchema;
      assert.equal(schema.safeParse({ displayName: "" }).success, false);
    });
  });

  describe("tailscale_delete_tailnet", () => {
    it("refuses when confirmTailnet does not match the configured tailnet", async () => {
      let called = false;
      globalThis.fetch = async () => {
        called = true;
        return mockFetchResponse(200, {});
      };
      const handler = findTool("tailscale_delete_tailnet").handler as (i: unknown) => Promise<unknown>;
      await assert.rejects(() => handler({ confirmTailnet: "wrong.ts.net" }), {
        message: /does not match the configured tailnet/,
      });
      assert.equal(called, false, "no request may be sent when confirmation fails");
    });

    it("refuses when the tailnet resolves to the '-' self-reference", async () => {
      delete process.env.TAILSCALE_TAILNET;
      let called = false;
      globalThis.fetch = async () => {
        called = true;
        return mockFetchResponse(200, {});
      };
      const handler = findTool("tailscale_delete_tailnet").handler as (i: unknown) => Promise<unknown>;
      await assert.rejects(() => handler({ confirmTailnet: "-" }), { message: /nothing specific to confirm against/ });
      assert.equal(called, false);
    });

    it("DELETEs the tailnet when confirmation matches", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedMethod = init?.method ?? "";
        return mockFetchResponse(200, {});
      };
      const handler = findTool("tailscale_delete_tailnet").handler as (i: unknown) => Promise<unknown>;
      const res = (await handler({ confirmTailnet: "test.ts.net" })) as { ok: boolean };
      assert.equal(capturedMethod, "DELETE");
      assert.ok(capturedUrl.endsWith("/tailnet/test.ts.net"), `got ${capturedUrl}`);
      assert.ok(res.ok);
    });

    it("confirms against TAILSCALE_OAUTH_TAILNET when it is set", async () => {
      // The OAuth target is the tailnet the minted token actually addresses, so
      // it is what the DELETE hits -- confirming against TAILSCALE_TAILNET here
      // would guard the wrong name.
      process.env.TAILSCALE_OAUTH_TAILNET = "api-only-1";
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, {});
      };
      const handler = findTool("tailscale_delete_tailnet").handler as (i: unknown) => Promise<unknown>;
      await assert.rejects(() => handler({ confirmTailnet: "test.ts.net" }), {
        message: /does not match the configured tailnet/,
      });
      const res = (await handler({ confirmTailnet: "api-only-1" })) as { ok: boolean };
      assert.ok(res.ok);
      assert.ok(capturedUrl.endsWith("/tailnet/api-only-1"), `got ${capturedUrl}`);
    });

    it("is marked destructive", () => {
      assert.equal(findTool("tailscale_delete_tailnet").annotations.destructiveHint, true);
    });
  });
});

describe("tailscale_delete_tailnet explicit target", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
    delete process.env.TAILSCALE_OAUTH_TAILNET;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  function findDelete() {
    const tool = tailnetsTools.find((t) => t.name === "tailscale_delete_tailnet");
    if (!tool) throw new Error("tool not found");
    return tool.handler as unknown as (i: unknown) => Promise<unknown>;
  }

  it("targets an explicit tailnet instead of the configured one", async () => {
    // The whole point: list org tailnets, pick one, delete it -- without
    // editing env and restarting the server.
    let capturedUrl = "";
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response("{}", { status: 200 });
    };
    const res = (await findDelete()({ tailnet: "other-tailnet", confirmTailnet: "other-tailnet" })) as {
      ok: boolean;
    };
    assert.ok(res.ok);
    assert.ok(capturedUrl.endsWith("/tailnet/other-tailnet"), `got ${capturedUrl}`);
  });

  it("confirms against the EXPLICIT target, not the configured tailnet", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    // The configured tailnet is test.ts.net; confirming with it must NOT
    // authorise deleting a different, explicitly-named tailnet.
    await assert.rejects(() => findDelete()({ tailnet: "other-tailnet", confirmTailnet: "test.ts.net" }), {
      message: /does not match the configured tailnet/,
    });
    assert.equal(called, false, "no request may be sent when confirmation fails");
  });

  it("percent-encodes the explicit target", async () => {
    // Unlike the env-derived path, this value is tool input, so it must be
    // encoded rather than interpolated raw.
    let capturedUrl = "";
    globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response("{}", { status: 200 });
    };
    await findDelete()({ tailnet: "weird/name", confirmTailnet: "weird/name" });
    assert.ok(capturedUrl.endsWith("/tailnet/weird%2Fname"), `got ${capturedUrl}`);
  });

  it("still refuses an explicit '-' target", async () => {
    await assert.rejects(() => findDelete()({ tailnet: "-", confirmTailnet: "-" }), {
      message: /nothing specific to confirm against/,
    });
  });
});

describe("tailscale_list_org_tailnets limit", () => {
  it("accepts a large limit -- the API is the authority on the ceiling", () => {
    const tool = tailnetsTools.find((t) => t.name === "tailscale_list_org_tailnets");
    if (!tool) throw new Error("tool not found");
    const schema = tool.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean } };
    assert.equal(schema.safeParse({ limit: 5000 }).success, true);
    // Still rejects values that are nonsense on any ceiling.
    assert.equal(schema.safeParse({ limit: 0 }).success, false);
    assert.equal(schema.safeParse({ limit: -1 }).success, false);
    assert.equal(schema.safeParse({ limit: 1.5 }).success, false);
  });
});
