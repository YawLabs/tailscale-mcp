import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { __resetOAuthTokenCacheForTests } from "../api.js";
import { tailnetsTools } from "./tailnets.js";

function mockFetchResponse(status: number, body: unknown) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

type AnyTool = {
  name: string;
  description: string;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema: {
    safeParse: (v: unknown) => { success: boolean; data?: unknown };
    shape: { confirmTailnet: { description?: string } };
  };
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
    // The OAuth case mints a token; a cached one must not leak into later tests.
    __resetOAuthTokenCacheForTests();
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

    it("names only TAILSCALE_TAILNET in the '-' refusal under API-key auth", async () => {
      // getEffectiveTailnet never reads TAILSCALE_OAUTH_TAILNET while
      // TAILSCALE_API_KEY is set, so recommending it would be a no-op remedy.
      delete process.env.TAILSCALE_TAILNET;
      const handler = findTool("tailscale_delete_tailnet").handler as (i: unknown) => Promise<unknown>;
      await assert.rejects(
        () => handler({ confirmTailnet: "-" }),
        (err: unknown) => {
          const message = (err as Error).message;
          assert.match(message, /Set TAILSCALE_TAILNET to the tailnet's explicit name or id \(or pass `tailnet`\)/);
          assert.doesNotMatch(message, /TAILSCALE_OAUTH_TAILNET/);
          return true;
        },
      );
    });

    it("says a set TAILSCALE_OAUTH_TAILNET is ignored under API-key auth", async () => {
      delete process.env.TAILSCALE_TAILNET;
      process.env.TAILSCALE_OAUTH_TAILNET = "api-only-1";
      let called = false;
      globalThis.fetch = async () => {
        called = true;
        return mockFetchResponse(200, {});
      };
      const handler = findTool("tailscale_delete_tailnet").handler as (i: unknown) => Promise<unknown>;
      await assert.rejects(
        () => handler({ confirmTailnet: "-" }),
        (err: unknown) => {
          const message = (err as Error).message;
          assert.match(message, /Set TAILSCALE_TAILNET to/);
          assert.doesNotMatch(message, /Set TAILSCALE_TAILNET or TAILSCALE_OAUTH_TAILNET/);
          assert.match(message, /TAILSCALE_OAUTH_TAILNET is set but ignored while TAILSCALE_API_KEY is set/);
          return true;
        },
      );
      assert.equal(called, false);
    });

    it("offers TAILSCALE_OAUTH_TAILNET in the '-' refusal under OAuth auth", async () => {
      delete process.env.TAILSCALE_API_KEY;
      delete process.env.TAILSCALE_TAILNET;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      let called = false;
      globalThis.fetch = async () => {
        called = true;
        return mockFetchResponse(200, {});
      };
      const handler = findTool("tailscale_delete_tailnet").handler as (i: unknown) => Promise<unknown>;
      await assert.rejects(
        () => handler({ confirmTailnet: "-" }),
        (err: unknown) => {
          const message = (err as Error).message;
          assert.match(message, /Set TAILSCALE_TAILNET or TAILSCALE_OAUTH_TAILNET/);
          assert.doesNotMatch(message, /ignored/);
          return true;
        },
      );
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
      // would guard the wrong name. OAuth credentials, not the fixture's API
      // key: api.ts reads TAILSCALE_OAUTH_TAILNET only on the OAuth path.
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      process.env.TAILSCALE_OAUTH_TAILNET = "api-only-1";
      __resetOAuthTokenCacheForTests();
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) return mockFetchResponse(200, { access_token: "tok", expires_in: 3600 });
        capturedUrl = url;
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

    it("ignores a leftover TAILSCALE_OAUTH_TAILNET under API-key auth", async () => {
      // The API key wins in api.ts whenever it is set, and the OAuth target is
      // then never read -- every other tool addresses TAILSCALE_TAILNET, so the
      // default target here must too, and the refusal must not name the
      // leftover value.
      process.env.TAILSCALE_OAUTH_TAILNET = "api-only-1";
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, {});
      };
      const handler = findTool("tailscale_delete_tailnet").handler as (i: unknown) => Promise<unknown>;
      await assert.rejects(
        () => handler({ confirmTailnet: "api-only-1" }),
        (err: unknown) => {
          assert.match((err as Error).message, /does not match the configured tailnet "test\.ts\.net"/);
          return true;
        },
      );
      assert.equal(capturedUrl, "", "no request may be sent when confirmation fails");
      const res = (await handler({ confirmTailnet: "test.ts.net" })) as { ok: boolean };
      assert.ok(res.ok);
      assert.ok(capturedUrl.endsWith("/tailnet/test.ts.net"), `got ${capturedUrl}`);
    });

    it("is marked destructive", () => {
      assert.equal(findTool("tailscale_delete_tailnet").annotations.destructiveHint, true);
    });
  });

  describe("tailscale_delete_tailnet explicit target", () => {
    const findDelete = () => findTool("tailscale_delete_tailnet").handler;

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
      // authorise deleting a different, explicitly-named tailnet. The refusal has
      // to name the source of the target too: one shared "configured tailnet"
      // message described an input-supplied target as environment, pointing the
      // caller at TAILSCALE_TAILNET when env was never consulted.
      await assert.rejects(
        () => findDelete()({ tailnet: "other-tailnet", confirmTailnet: "test.ts.net" }),
        (err: unknown) => {
          const message = (err as Error).message;
          assert.match(message, /does not match the tailnet you named "other-tailnet"/);
          assert.doesNotMatch(message, /configured tailnet/);
          return true;
        },
      );
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

    it("tells an explicit '-' caller to pass a real `tailnet`, not to set env vars", async () => {
      // The explicit `tailnet` wins over every env var, so no env change would
      // alter the target. A set TAILSCALE_OAUTH_TAILNET must not pull in the
      // API-key "ignored" clause either.
      process.env.TAILSCALE_OAUTH_TAILNET = "api-only-1";
      await assert.rejects(
        () => findDelete()({ tailnet: "-", confirmTailnet: "-" }),
        (err: unknown) => {
          const message = (err as Error).message;
          assert.match(message, /Pass the tailnet's explicit name or id as `tailnet` instead of '-'/);
          assert.doesNotMatch(message, /TAILSCALE_/);
          return true;
        },
      );
    });
  });

  describe("tailscale_list_org_tailnets limit", () => {
    it("accepts a large limit -- the API is the authority on the ceiling", () => {
      const schema = findTool("tailscale_list_org_tailnets").inputSchema;
      assert.equal(schema.safeParse({ limit: 5000 }).success, true);
      // Still rejects values that are nonsense on any ceiling.
      assert.equal(schema.safeParse({ limit: 0 }).success, false);
      assert.equal(schema.safeParse({ limit: -1 }).success, false);
      assert.equal(schema.safeParse({ limit: 1.5 }).success, false);
    });
  });

  describe("org-tailnets input hygiene", () => {
    it("create percent-encodes an explicit organization id", async () => {
      // The list tool has this test; create builds the same path segment and
      // creating against the wrong org is not recoverable the way a bad list is.
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return new Response("{}", { status: 200 });
      };
      await findTool("tailscale_create_org_tailnet").handler({ displayName: "x", organization: "org/1" });
      assert.ok(capturedUrl.endsWith("/organizations/org%2F1/tailnets"), `got ${capturedUrl}`);
    });

    it("rejects whitespace-only string inputs rather than silently defaulting", () => {
      // A bare .min(1) accepts " ", which trimmed to "" and fell back to the
      // configured tailnet -- "delete the one I named" quietly becoming "delete
      // the default one".
      assert.equal(
        findTool("tailscale_delete_tailnet").inputSchema.safeParse({ tailnet: " ", confirmTailnet: "x" }).success,
        false,
      );
      assert.equal(
        findTool("tailscale_delete_tailnet").inputSchema.safeParse({ confirmTailnet: "   " }).success,
        false,
      );
      assert.equal(
        findTool("tailscale_create_org_tailnet").inputSchema.safeParse({ displayName: "  " }).success,
        false,
      );
      assert.equal(findTool("tailscale_list_org_tailnets").inputSchema.safeParse({ organization: " " }).success, false);
    });

    it("trims surrounding whitespace off otherwise-valid input", async () => {
      let capturedUrl = "";
      globalThis.fetch = async (input: RequestInfo | URL) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return new Response("{}", { status: 200 });
      };
      const del = findTool("tailscale_delete_tailnet");
      const parsed = del.inputSchema.safeParse({ tailnet: "  other  ", confirmTailnet: "  other  " }) as {
        success: boolean;
        data?: { tailnet?: string; confirmTailnet: string };
      };
      assert.ok(parsed.success);
      assert.equal(parsed.data?.tailnet, "other");
      await del.handler(parsed.data);
      assert.ok(capturedUrl.endsWith("/tailnet/other"), `got ${capturedUrl}`);
    });
  });

  describe("tailscale_delete_tailnet confirmation semantics", () => {
    const deleteTool = () => findTool("tailscale_delete_tailnet");

    it("discloses that the confirm guard only bites on the omit-`tailnet` path", () => {
      // The handler derives `target` from `input.tailnet` when that is given, so
      // a caller writing both fields in one call satisfies the guard out of its
      // own input. The field used to advertise an unconditional "deliberate
      // second look before an irreversible org-wide delete", which holds only
      // when `tailnet` is omitted and the value has to match operator env.
      // Rewording is welcome; losing the disclosure -- or the pointer to the
      // operator-side control a caller cannot satisfy -- is what this catches.
      const field = deleteTool().inputSchema.shape.confirmTailnet.description ?? "";
      assert.match(field, /not an authorization gate/);
      assert.match(field, /omitted/);
      assert.match(deleteTool().description, /TAILSCALE_READONLY/);
    });
  });
});
