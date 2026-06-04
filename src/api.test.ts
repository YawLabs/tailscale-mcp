import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

// We need to mock fetch before importing api module, so we use dynamic imports
// and mock global.fetch

function mockFetchResponse(status: number, body: unknown, headers?: Record<string, string>) {
  const responseHeaders = new Headers(headers);
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: responseHeaders });
}

describe("API client", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let apiModule: typeof import("./api.js");

  beforeEach(async () => {
    // Reset env for each test
    process.env.TAILSCALE_API_KEY = "tskey-api-test123";
    delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
    delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
    process.env.TAILSCALE_TAILNET = "test.tailnet.ts.net";

    // Dynamic import to get fresh module reference
    apiModule = await import("./api.js");
    // Node caches ESM modules — clear the OAuth token closure so each test
    // starts cold and can observe refresh behavior deterministically.
    apiModule.__resetOAuthTokenCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  describe("getTailnet", () => {
    it("should return the configured tailnet", () => {
      process.env.TAILSCALE_TAILNET = "my.tailnet.ts.net";
      assert.equal(apiModule.getTailnet(), "my.tailnet.ts.net");
    });

    it("should return '-' when no tailnet is configured", () => {
      delete process.env.TAILSCALE_TAILNET;
      assert.equal(apiModule.getTailnet(), "-");
    });
  });

  describe("apiGet", () => {
    it("should make a GET request with correct auth header", async () => {
      let capturedRequest: { url: string; method: string; headers: Headers } | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        capturedRequest = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers) };
        return mockFetchResponse(200, { devices: [] });
      };

      const res = await apiModule.apiGet("/tailnet/test/devices");
      assert.ok(res.ok);
      assert.equal(res.status, 200);
      assert.ok(capturedRequest);
      assert.equal(capturedRequest.url, "https://api.tailscale.com/api/v2/tailnet/test/devices");
      assert.ok(capturedRequest.headers.get("Authorization")?.startsWith("Basic "));
    });

    it("should return error on non-ok response", async () => {
      // Use 500 here so the test exercises the raw-body fallthrough in
      // extractErrorMessage. 401/403 now go through formatAuthError and produce
      // structured messages -- those are covered by their own dedicated tests
      // ("formatAuthError platform-specific guidance" and the 403 cases).
      globalThis.fetch = async () => mockFetchResponse(500, "Internal Server Error");

      const res = await apiModule.apiGet("/tailnet/test/devices");
      assert.equal(res.ok, false);
      assert.equal(res.status, 500);
      assert.equal(res.error, "Internal Server Error");
    });

    it("should return raw body when acceptRaw is true", async () => {
      globalThis.fetch = async () => mockFetchResponse(200, "raw text content", { etag: '"abc123"' });

      const res = await apiModule.apiGet("/tailnet/test/acl", { acceptRaw: true });
      assert.ok(res.ok);
      assert.equal(res.rawBody, "raw text content");
      assert.equal(res.etag, '"abc123"');
    });

    it("should handle 204 no-content responses", async () => {
      globalThis.fetch = async () => new Response(null, { status: 204 });

      const res = await apiModule.apiGet("/some/endpoint");
      assert.ok(res.ok);
      assert.equal(res.status, 204);
      assert.equal(res.data, undefined);
    });

    it("should include etag in all response types", async () => {
      // JSON success
      globalThis.fetch = async () => mockFetchResponse(200, { ok: true }, { etag: '"json-etag"' });
      let res = await apiModule.apiGet("/test");
      assert.equal(res.etag, '"json-etag"');

      // Error response
      globalThis.fetch = async () => mockFetchResponse(500, "error", { etag: '"err-etag"' });
      res = await apiModule.apiGet("/test");
      assert.equal(res.etag, '"err-etag"');
    });

    it("should treat 200 with Content-Length: 0 as no-content success", async () => {
      // Mirror of the 204 path: JSON parsing must be skipped when the server
      // explicitly signals an empty body via Content-Length.
      globalThis.fetch = async () =>
        new Response(null, { status: 200, headers: new Headers({ "content-length": "0" }) });

      const res = await apiModule.apiGet("/some/endpoint");
      assert.equal(res.ok, true);
      assert.equal(res.status, 200);
      assert.equal(res.data, undefined);
    });

    it("should route acceptRaw 401 through formatAuthError", async () => {
      // Distinct from the JSON-401 path: the acceptRaw branch reads the body
      // as text first, and 401 must still hit the friendly auth-error formatter.
      globalThis.fetch = async () => mockFetchResponse(401, "unauthorized");

      const res = await apiModule.apiGet("/test", { acceptRaw: true });
      assert.equal(res.ok, false);
      assert.equal(res.status, 401);
      assert.match(res.error ?? "", /Authentication failed/);
    });
  });

  describe("apiPost", () => {
    it("should send JSON body", async () => {
      let capturedBody: string | undefined;
      let capturedContentType: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        capturedContentType = new Headers(init?.headers).get("Content-Type") ?? undefined;
        return mockFetchResponse(200, { success: true });
      };

      await apiModule.apiPost("/test", { key: "value" });
      assert.equal(capturedContentType, "application/json");
      assert.equal(capturedBody, '{"key":"value"}');
    });

    it("should send raw body with custom content type", async () => {
      let capturedBody: string | undefined;
      let capturedContentType: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = init?.body as string;
        capturedContentType = new Headers(init?.headers).get("Content-Type") ?? undefined;
        return mockFetchResponse(200, { success: true });
      };

      await apiModule.apiPost("/test", undefined, {
        rawBody: "{ /* hujson */ }",
        contentType: "application/hujson",
      });
      assert.equal(capturedContentType, "application/hujson");
      assert.equal(capturedBody, "{ /* hujson */ }");
    });

    it("should send If-Match header when ifMatch is provided", async () => {
      let capturedHeaders: Headers | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return mockFetchResponse(200, { success: true });
      };

      await apiModule.apiPost("/test", undefined, {
        rawBody: "body",
        ifMatch: '"etag-value"',
      });
      assert.equal(capturedHeaders?.get("If-Match"), '"etag-value"');
    });

    it("should default Content-Type to application/json when rawBody has no explicit contentType", async () => {
      // api.ts:375 picks "application/json" when options.contentType is unset.
      let capturedContentType: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedContentType = new Headers(init?.headers).get("Content-Type") ?? undefined;
        return mockFetchResponse(200, { success: true });
      };

      await apiModule.apiPost("/x", undefined, { rawBody: "{}" });
      assert.equal(capturedContentType, "application/json");
    });

    it("should handle 204 no-content responses (POST)", async () => {
      // Locks in the no-content path for POST. The apiGet equivalent already
      // exists; mirror it here so a regression in apiRequest's 204 handling
      // can't pass undetected for write verbs (Tailscale's actual responses
      // for POST /authorize, /expire, etc. are typically 200 today, but the
      // 204 branch is real and needs coverage).
      globalThis.fetch = async () => new Response(null, { status: 204 });
      const res = await apiModule.apiPost("/some/endpoint", { foo: "bar" });
      assert.ok(res.ok);
      assert.equal(res.status, 204);
      assert.equal(res.data, undefined);
    });
  });

  describe("apiPut", () => {
    it("should make a PUT request", async () => {
      let capturedMethod: string | undefined;
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedMethod = init?.method;
        capturedBody = init?.body as string;
        return mockFetchResponse(200, { updated: true });
      };

      const res = await apiModule.apiPut("/test", { key: "value" });
      assert.ok(res.ok);
      assert.equal(capturedMethod, "PUT");
      assert.equal(capturedBody, '{"key":"value"}');
    });
  });

  describe("apiPatch", () => {
    it("should make a PATCH request", async () => {
      let capturedMethod: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedMethod = init?.method;
        return mockFetchResponse(200, { updated: true });
      };

      const res = await apiModule.apiPatch("/test", { field: "value" });
      assert.ok(res.ok);
      assert.equal(capturedMethod, "PATCH");
    });
  });

  describe("apiDelete", () => {
    it("should make a DELETE request", async () => {
      let capturedMethod: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedMethod = init?.method;
        return mockFetchResponse(200, {});
      };

      const res = await apiModule.apiDelete("/test");
      assert.ok(res.ok);
      assert.equal(capturedMethod, "DELETE");
    });

    it("should handle 204 no-content responses (DELETE)", async () => {
      // DELETE in Tailscale's API frequently returns 204; pin the no-content
      // branch here so handler-level tests can use 200 mocks (which work
      // around Node's "Response with null body status cannot have body" rule)
      // without leaving the 204 path uncovered for write verbs.
      globalThis.fetch = async () => new Response(null, { status: 204 });
      const res = await apiModule.apiDelete("/some/endpoint");
      assert.ok(res.ok);
      assert.equal(res.status, 204);
      assert.equal(res.data, undefined);
    });
  });

  describe("apiRequest with absolute URL", () => {
    it("should use absolute URL as-is without prepending base URL", async () => {
      let capturedUrl: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return mockFetchResponse(200, {});
      };

      await apiModule.apiGet("https://custom.api.example.com/endpoint");
      assert.equal(capturedUrl, "https://custom.api.example.com/endpoint");
    });
  });

  describe("Authentication", () => {
    it("should throw when no credentials are configured", async () => {
      delete process.env.TAILSCALE_API_KEY;
      delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
      delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;

      globalThis.fetch = async () => mockFetchResponse(200, {});
      await assert.rejects(() => apiModule.apiGet("/test"), { message: /No Tailscale credentials configured/ });
    });

    it("should use Basic auth with API key", async () => {
      process.env.TAILSCALE_API_KEY = "tskey-api-mykey";
      let capturedAuth: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedAuth = new Headers(init?.headers).get("Authorization") ?? undefined;
        return mockFetchResponse(200, {});
      };

      await apiModule.apiGet("/test");
      const expected = `Basic ${Buffer.from("tskey-api-mykey:").toString("base64")}`;
      assert.equal(capturedAuth, expected);
    });

    it("should trim surrounding whitespace from TAILSCALE_API_KEY", async () => {
      // A trailing newline from a copy-paste used to flow into the
      // Authorization header verbatim and 401 with a misleading message.
      process.env.TAILSCALE_API_KEY = "  tskey-api-trimmed\n";
      let capturedAuth: string | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedAuth = new Headers(init?.headers).get("Authorization") ?? undefined;
        return mockFetchResponse(200, {});
      };

      await apiModule.apiGet("/test");
      const expected = `Basic ${Buffer.from("tskey-api-trimmed:").toString("base64")}`;
      assert.equal(capturedAuth, expected);
    });

    it("should reject TAILSCALE_API_KEY that is whitespace-only", async () => {
      process.env.TAILSCALE_API_KEY = "   ";
      globalThis.fetch = async () => mockFetchResponse(200, {});
      await assert.rejects(() => apiModule.apiGet("/test"), { message: /set but empty/ });
    });

    it("should reject TAILSCALE_API_KEY that is the empty string", async () => {
      process.env.TAILSCALE_API_KEY = "";
      globalThis.fetch = async () => mockFetchResponse(200, {});
      await assert.rejects(() => apiModule.apiGet("/test"), { message: /set but empty/ });
    });

    it("should trim whitespace from OAuth client id and secret", async () => {
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "  client-id  ";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "\tclient-secret\n";

      const tokenBodies: string[] = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          tokenBodies.push(init?.body as string);
          return mockFetchResponse(200, { access_token: "tkn", expires_in: 3600 });
        }
        return mockFetchResponse(200, {});
      };

      await apiModule.apiGet("/test");
      assert.equal(tokenBodies.length, 1);
      const params = new URLSearchParams(tokenBodies[0]);
      assert.equal(params.get("client_id"), "client-id");
      assert.equal(params.get("client_secret"), "client-secret");
    });

    it("should reject OAuth credentials that are whitespace-only", async () => {
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "   ";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "   ";
      globalThis.fetch = async () => mockFetchResponse(200, {});
      await assert.rejects(() => apiModule.apiGet("/test"), { message: /must both be set and non-empty/ });
    });

    it("should reject OAuth setup with only TAILSCALE_OAUTH_CLIENT_ID set", async () => {
      // Without this branch, half-set OAuth env falls through to the generic
      // "No Tailscale credentials configured" message — confusing because the
      // user clearly did configure something.
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
      globalThis.fetch = async () => mockFetchResponse(200, {});
      await assert.rejects(() => apiModule.apiGet("/test"), { message: /must both be set and non-empty/ });
    });

    it("should reject OAuth setup with only TAILSCALE_OAUTH_CLIENT_SECRET set", async () => {
      delete process.env.TAILSCALE_API_KEY;
      delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      globalThis.fetch = async () => mockFetchResponse(200, {});
      await assert.rejects(() => apiModule.apiGet("/test"), { message: /must both be set and non-empty/ });
    });

    it("should reject OAuth setup with empty-string client id", async () => {
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      globalThis.fetch = async () => mockFetchResponse(200, {});
      await assert.rejects(() => apiModule.apiGet("/test"), { message: /must both be set and non-empty/ });
    });

    it("should use Bearer auth with OAuth", async () => {
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";

      let callCount = 0;
      let capturedAuth: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        callCount++;
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          return mockFetchResponse(200, {
            access_token: "oauth-token-123",
            expires_in: 3600,
          });
        }
        capturedAuth = new Headers(init?.headers).get("Authorization") ?? undefined;
        return mockFetchResponse(200, {});
      };

      await apiModule.apiGet("/test");
      assert.equal(capturedAuth, "Bearer oauth-token-123");
      assert.equal(callCount, 2); // token + actual request
    });

    it("should dedupe concurrent OAuth token refresh requests", async () => {
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";

      let tokenFetches = 0;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          tokenFetches++;
          // Hold the refresh open long enough for the other concurrent callers
          // to arrive and observe the in-flight promise instead of racing.
          await new Promise((r) => setTimeout(r, 20));
          return mockFetchResponse(200, { access_token: "oauth-dedup-token", expires_in: 3600 });
        }
        return mockFetchResponse(200, {});
      };

      await Promise.all([
        apiModule.apiGet("/a"),
        apiModule.apiGet("/b"),
        apiModule.apiGet("/c"),
        apiModule.apiGet("/d"),
        apiModule.apiGet("/e"),
      ]);

      assert.equal(tokenFetches, 1, `expected 1 token refresh for 5 concurrent callers, got ${tokenFetches}`);
    });

    it("should reuse cached OAuth token on subsequent calls", async () => {
      // Once a token is cached with an expiry comfortably in the future, a
      // second apiGet must NOT hit /oauth/token again.
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      apiModule.__resetOAuthTokenCacheForTests();

      let tokenFetches = 0;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          tokenFetches++;
          return mockFetchResponse(200, { access_token: "tk", expires_in: 3600 });
        }
        return mockFetchResponse(200, {});
      };

      await apiModule.apiGet("/x");
      await apiModule.apiGet("/x");
      assert.equal(tokenFetches, 1, `expected 1 token refresh across 2 sequential calls, got ${tokenFetches}`);
    });

    it("should surface the scope-hint guidance on OAuth token exchange 401", async () => {
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      apiModule.__resetOAuthTokenCacheForTests();

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          return mockFetchResponse(401, "unauthorized");
        }
        return mockFetchResponse(200, {});
      };

      await assert.rejects(() => apiModule.apiGet("/x"), /scopes your tools need/);
    });

    it("should surface the scope-hint guidance on OAuth token exchange 403", async () => {
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      apiModule.__resetOAuthTokenCacheForTests();

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          return mockFetchResponse(403, "forbidden");
        }
        return mockFetchResponse(200, {});
      };

      await assert.rejects(() => apiModule.apiGet("/x"), /scopes your tools need/);
    });

    it("should NOT include the scope hint on non-auth OAuth exchange failures", async () => {
      // 500 from the token endpoint is server-side, not a credentials problem;
      // the scope-hint paragraph would be misleading.
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      apiModule.__resetOAuthTokenCacheForTests();

      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          return mockFetchResponse(500, "internal error");
        }
        return mockFetchResponse(200, {});
      };

      await assert.rejects(
        () => apiModule.apiGet("/x"),
        (err: Error) => {
          assert.match(err.message, /OAuth token exchange failed \(500\)/);
          assert.ok(!err.message.includes("scopes your tools need"), `unexpected scope hint in: ${err.message}`);
          return true;
        },
      );
    });

    it("should retry the OAuth exchange on the next call after a rejected refresh (no stuck promise)", async () => {
      // If the finally-block cleanup of oauthRefreshPromise ever regressed, a
      // single transient failure during /oauth/token would wedge every
      // subsequent call in the process -- they'd all reuse the same rejected
      // promise. Each unit test starts cold (the cache is reset in beforeEach),
      // so the bug only ever surfaces in production. This test exercises a
      // failure + recovery sequence within a single test to lock the contract.
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      apiModule.__resetOAuthTokenCacheForTests();

      let tokenFetches = 0;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          tokenFetches++;
          // First exchange fails; second must succeed for the test to prove
          // the rejected promise was cleared and a fresh attempt fired.
          if (tokenFetches === 1) return mockFetchResponse(401, "unauthorized");
          return mockFetchResponse(200, { access_token: "tk-recovered", expires_in: 3600 });
        }
        return mockFetchResponse(200, {});
      };

      await assert.rejects(() => apiModule.apiGet("/first"));
      const res = await apiModule.apiGet("/second");
      assert.equal(tokenFetches, 2, "second call must attempt a fresh OAuth exchange, not reuse the rejected promise");
      assert.ok(res.ok);
    });

    it("should dedupe concurrent OAuth callers even when the exchange fails, then recover", async () => {
      // Companion to "should dedupe concurrent OAuth token refresh requests"
      // (which covers the 200 path). Two contracts at once:
      //  1) All concurrent racers share the single in-flight exchange even on
      //     a 401 (no thundering herd on failure).
      //  2) The finally-block cleanup must still fire on the rejected promise
      //     so a SUBSEQUENT call doesn't dedup onto the stale rejected promise.
      // The sequential recovery test above proves cleanup at the call
      // boundary; this one proves it under concurrent load -- a regression
      // that moved the cleanup outside `finally` could leak the rejected
      // promise to the recovery call here.
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      apiModule.__resetOAuthTokenCacheForTests();

      let tokenFetches = 0;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          tokenFetches++;
          if (tokenFetches === 1) {
            // Hold long enough for B and C to arrive and dedup.
            await new Promise((r) => setTimeout(r, 20));
            return mockFetchResponse(401, "unauthorized");
          }
          return mockFetchResponse(200, { access_token: "tk-after-failure", expires_in: 3600 });
        }
        return mockFetchResponse(200, {});
      };

      const racers = await Promise.allSettled([apiModule.apiGet("/a"), apiModule.apiGet("/b"), apiModule.apiGet("/c")]);
      for (const r of racers) {
        assert.equal(r.status, "rejected", "all concurrent racers must share the single failed exchange");
      }
      assert.equal(tokenFetches, 1, `concurrent racers must dedup onto one exchange, got ${tokenFetches}`);

      // Post-rejection a fresh call must trigger a NEW exchange (cleanup fired).
      const recovery = await apiModule.apiGet("/recovery");
      assert.ok(recovery.ok);
      assert.equal(tokenFetches, 2, "post-rejection cleanup must allow a fresh exchange on the next call");
    });

    it("should reuse a cached token whose remaining lifetime exceeds the 60s skew", async () => {
      // Pins the upper boundary of the cache skew: a 90s TTL leaves 90s of
      // life, which is > the 60s skew, so the second call must NOT refresh.
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      apiModule.__resetOAuthTokenCacheForTests();

      let tokenFetches = 0;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          tokenFetches++;
          return mockFetchResponse(200, { access_token: "tk", expires_in: 90 });
        }
        return mockFetchResponse(200, {});
      };

      await apiModule.apiGet("/x");
      await apiModule.apiGet("/y");
      assert.equal(tokenFetches, 1, "token with 90s TTL must be reused (90s > 60s skew)");
    });

    it("should refresh a cached token whose remaining lifetime is inside the 60s skew", async () => {
      // The lower boundary: a 30s TTL falls inside the 60s skew window, so
      // the cached token is treated as already-stale and the next call must
      // re-exchange. Pinning both ends of the skew prevents a future refactor
      // from silently dropping or inflating the skew constant.
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      apiModule.__resetOAuthTokenCacheForTests();

      let tokenFetches = 0;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          tokenFetches++;
          return mockFetchResponse(200, { access_token: "tk", expires_in: 30 });
        }
        return mockFetchResponse(200, {});
      };

      await apiModule.apiGet("/x");
      await apiModule.apiGet("/y");
      assert.equal(tokenFetches, 2, "token with 30s TTL must be refreshed on the next call (30s < 60s skew)");
    });

    it("should prefer API key over OAuth when both are configured", async () => {
      // Precedence test: API key wins. The /oauth/token endpoint must NOT be
      // hit, and the Authorization header must be Basic (api key form).
      process.env.TAILSCALE_API_KEY = "tskey-api-precedence";
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      apiModule.__resetOAuthTokenCacheForTests();

      let tokenFetched = false;
      let capturedAuth: string | undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) {
          tokenFetched = true;
          return mockFetchResponse(200, { access_token: "tk", expires_in: 3600 });
        }
        capturedAuth = new Headers(init?.headers).get("Authorization") ?? undefined;
        return mockFetchResponse(200, {});
      };

      await apiModule.apiGet("/test");
      assert.equal(tokenFetched, false, "OAuth token endpoint must not be fetched when API key is set");
      assert.ok(capturedAuth?.startsWith("Basic "), `expected Basic auth, got: ${capturedAuth}`);
    });
  });

  describe("sanitizeDescription", () => {
    it("should replace slashes with hyphens", () => {
      assert.equal(apiModule.sanitizeDescription("CI/CD deploy"), "CI-CD deploy");
    });

    it("should replace underscores with hyphens", () => {
      assert.equal(apiModule.sanitizeDescription("my_key_name"), "my-key-name");
    });

    it("should strip characters outside alphanumeric hyphens and spaces", () => {
      assert.equal(apiModule.sanitizeDescription("test: hello (v1.0)"), "test hello v10");
    });

    it("should strip HTML-like characters", () => {
      assert.equal(apiModule.sanitizeDescription("test <script>alert</script>"), "test scriptalert-script");
    });

    it("should trim whitespace", () => {
      assert.equal(apiModule.sanitizeDescription("  hello  "), "hello");
    });

    it("should collapse multiple spaces", () => {
      assert.equal(apiModule.sanitizeDescription("hello   world"), "hello world");
    });

    it("should truncate to 50 characters", () => {
      const long = "a".repeat(60);
      assert.equal(apiModule.sanitizeDescription(long).length, 50);
    });

    it("should handle the reported failing description", () => {
      const result = apiModule.sanitizeDescription("census-docs CI/CD deploy");
      assert.equal(result, "census-docs CI-CD deploy");
      assert.ok(!/\//.test(result), "should not contain slashes");
    });

    it("should only contain allowed characters", () => {
      const result = apiModule.sanitizeDescription("Test!@#$%^&*()_+key/name.v2");
      assert.ok(/^[a-zA-Z0-9 -]*$/.test(result), `Result '${result}' contains disallowed characters`);
    });
  });

  describe("validateAndSanitizeDescription", () => {
    it("should return the sanitized value for normal input", () => {
      assert.equal(apiModule.validateAndSanitizeDescription("ci/cd token"), "ci-cd token");
    });

    it("should return undefined for an empty string (omit-the-field signal)", () => {
      assert.equal(apiModule.validateAndSanitizeDescription(""), undefined);
    });

    it("should return undefined for whitespace-only input", () => {
      assert.equal(apiModule.validateAndSanitizeDescription("   "), undefined);
    });

    it("should throw with a specific message when input had content but sanitized to empty", () => {
      // "!!!" has visible content but every char is stripped by the alphanumeric
      // rule. Pre-fix this returned "" and callers fell through to a misleading
      // "No fields to update" error -- now the caller learns exactly what went
      // wrong and why.
      assert.throws(
        () => apiModule.validateAndSanitizeDescription("!!!"),
        (err: Error) => {
          assert.match(err.message, /contains no valid characters after sanitization/);
          assert.match(err.message, /"!!!"/, `expected the offending input quoted, got: ${err.message}`);
          assert.match(err.message, /alphanumeric, spaces, and hyphens/);
          return true;
        },
      );
    });

    it("should throw on a multi-char invalid string after trim", () => {
      // Leading/trailing whitespace must not mask an all-invalid payload.
      assert.throws(() => apiModule.validateAndSanitizeDescription("  ??? "), /contains no valid characters/);
    });
  });

  describe("Request timeout", () => {
    it("should pass an AbortSignal to fetch", async () => {
      let capturedSignal: AbortSignal | undefined;
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return mockFetchResponse(200, {});
      };

      await apiModule.apiGet("/test");
      assert.ok(capturedSignal, "AbortSignal should be present");
    });
  });

  describe("429 retry", () => {
    it("should retry on 429 honoring Retry-After (seconds)", async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 3) return mockFetchResponse(429, "rate limited", { "retry-after": "0" });
        return mockFetchResponse(200, { ok: true });
      };
      const res = await apiModule.apiGet("/test");
      assert.ok(res.ok);
      assert.equal(attempts, 3);
    });

    it("should give up after MAX_429_RETRIES and surface the 429", async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return mockFetchResponse(429, "still rate limited", { "retry-after": "0" });
      };
      const res = await apiModule.apiGet("/test");
      assert.equal(res.ok, false);
      assert.equal(res.status, 429);
      // 1 initial attempt + 3 retries = 4 total
      assert.equal(attempts, 4);
    });

    it("should not retry on non-429 errors", async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return mockFetchResponse(500, "boom");
      };
      const res = await apiModule.apiGet("/test");
      assert.equal(res.ok, false);
      assert.equal(res.status, 500);
      assert.equal(attempts, 1);
    });

    it("should NOT retry 429 on POST (non-idempotent)", async () => {
      // Retrying a non-idempotent write could double-create if the original
      // request reached the server but the response was lost.
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return mockFetchResponse(429, "limited", { "retry-after": "0" });
      };
      const res = await apiModule.apiPost("/test", { foo: "bar" });
      assert.equal(res.ok, false);
      assert.equal(res.status, 429);
      assert.equal(attempts, 1, "POST must not be retried on 429");
    });

    it("should NOT retry 429 on PATCH (non-idempotent)", async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return mockFetchResponse(429, "limited", { "retry-after": "0" });
      };
      const res = await apiModule.apiPatch("/test", { foo: "bar" });
      assert.equal(res.ok, false);
      assert.equal(res.status, 429);
      assert.equal(attempts, 1, "PATCH must not be retried on 429");
    });

    it("should retry 429 on PUT (idempotent)", async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 2) return mockFetchResponse(429, "limited", { "retry-after": "0" });
        return mockFetchResponse(200, { ok: true });
      };
      const res = await apiModule.apiPut("/test", { foo: "bar" });
      assert.ok(res.ok);
      assert.equal(attempts, 2);
    });

    it("should retry 429 on DELETE (idempotent)", async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 2) return mockFetchResponse(429, "limited", { "retry-after": "0" });
        return mockFetchResponse(200, {});
      };
      const res = await apiModule.apiDelete("/test");
      assert.ok(res.ok);
      assert.equal(attempts, 2);
    });

    it("should give up retrying when the backoff sleep alone would exhaust the budget", async () => {
      // 100ms budget vs 1000ms Retry-After — the sleep alone would push past
      // the budget, leaving no positive time for the retry. Bail with the 429
      // after a single attempt instead of sleeping the budget away.
      process.env.TAILSCALE_REQUEST_BUDGET_MS = "100";
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return mockFetchResponse(429, "limited", { "retry-after": "1" });
      };
      try {
        const res = await apiModule.apiGet("/test");
        assert.equal(res.ok, false);
        assert.equal(res.status, 429);
        assert.equal(attempts, 1, "should not retry once budget is exhausted");
      } finally {
        delete process.env.TAILSCALE_REQUEST_BUDGET_MS;
      }
    });

    it("should still retry when the budget can fit the sleep + a short attempt", async () => {
      // Regression: the old bail check added a flat REQUEST_TIMEOUT_MS (30s)
      // to the predicted cost, which spuriously bailed on budgets in the
      // 30-60s range (e.g. budget=35s with retry-after=30s -> bail). The
      // current check is `requestBudgetMs - elapsed - delay > 0`, so any
      // positive headroom after the sleep is enough to proceed -- the next
      // iteration caps the attempt's fetch timeout to that headroom.
      //
      // Shape-equivalent miniature: budget=2000ms, retry-after=1s. The retry
      // has ~1000ms of attempt-timeout headroom after the sleep -- enough to
      // proceed and let the second response land.
      process.env.TAILSCALE_REQUEST_BUDGET_MS = "2000";
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 2) return mockFetchResponse(429, "limited", { "retry-after": "1" });
        return mockFetchResponse(200, { ok: true });
      };
      try {
        const res = await apiModule.apiGet("/test");
        assert.ok(res.ok, `expected retry to succeed, got status=${res.ok ? "ok" : res.status}`);
        assert.equal(attempts, 2, "should have retried once after the 1s Retry-After sleep");
      } finally {
        delete process.env.TAILSCALE_REQUEST_BUDGET_MS;
      }
    });

    it("should ignore TAILSCALE_REQUEST_BUDGET_MS that is non-numeric and use the default", async () => {
      process.env.TAILSCALE_REQUEST_BUDGET_MS = "not-a-number";
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 2) return mockFetchResponse(429, "limited", { "retry-after": "0" });
        return mockFetchResponse(200, { ok: true });
      };
      try {
        const res = await apiModule.apiGet("/test");
        assert.ok(res.ok);
        assert.equal(attempts, 2, "default budget should allow normal retry");
      } finally {
        delete process.env.TAILSCALE_REQUEST_BUDGET_MS;
      }
    });

    it("should honor HTTP-date Retry-After on 429", async () => {
      // Hits the Date.parse fallback branch in compute429DelayMs. Use a
      // 3-second offset (rather than 100ms) so .toUTCString()'s floor-to-
      // whole-seconds still leaves a measurable delay (~2-3s) -- this lets us
      // assert the date branch was actually *taken* (delay > 0), not merely
      // that it didn't throw. parseInt("Tue, ...") is NaN, so this can't
      // accidentally pass via the integer branch. Kept deliberately short: this
      // is the suite's only multi-second real sleep, so a smaller offset both
      // speeds the run and widens the upper-bound headroom against CI jitter.
      let attempts = 0;
      const startedAt = Date.now();
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 2) {
          const retryAfter = new Date(Date.now() + 3000).toUTCString();
          return mockFetchResponse(429, "limited", { "retry-after": retryAfter });
        }
        return mockFetchResponse(200, { ok: true });
      };
      const res = await apiModule.apiGet("/test");
      const elapsed = Date.now() - startedAt;
      assert.ok(res.ok);
      assert.equal(attempts, 2);
      // Implied delay floors into [~2000, 3000)ms; assert >= 1500 to absorb
      // scheduler jitter, < 8000 to catch a runaway "slept far too long" bug.
      assert.ok(elapsed >= 1500, `expected at least 1500ms elapsed (date branch should sleep), got ${elapsed}ms`);
      assert.ok(elapsed < 8000, `expected under 8s elapsed, got ${elapsed}ms`);
    });

    it("should fall back to backoff for a past/clock-skewed Retry-After date", async () => {
      // Mirror of the future-date test above, but for the other arm of the
      // `if (delta > 0)` guard in compute429DelayMs. A Retry-After whose
      // HTTP-date is already in the PAST yields delta <= 0; the date branch
      // must NOT return 0 (which would hot-retry against a server that just
      // said 429), but fall through to the exponential-backoff floor. The
      // backoff base for attempt 0 is DEFAULT_429_DELAY_MS (~1s), so the
      // retry still has a measurable sleep -- this distinguishes "fell
      // through to backoff" from "returned 0 and hot-retried".
      let attempts = 0;
      const startedAt = Date.now();
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 2) {
          const retryAfter = new Date(Date.now() - 5000).toUTCString();
          return mockFetchResponse(429, "limited", { "retry-after": retryAfter });
        }
        return mockFetchResponse(200, { ok: true });
      };
      const res = await apiModule.apiGet("/test");
      const elapsed = Date.now() - startedAt;
      assert.ok(res.ok);
      assert.equal(attempts, 2, "should still retry once after the past-date fell through to backoff");
      // Backoff base is ~1000ms for attempt 0; assert >= 500 to absorb timer
      // jitter while still catching a regression that returns 0 and hot-retries.
      assert.ok(
        elapsed >= 500,
        `expected at least 500ms elapsed (backoff floor, not a ~0ms hot-retry), got ${elapsed}ms`,
      );
    });

    it("should fall back to backoff for unparseable Retry-After", async () => {
      // "soon" parses as neither integer nor Date — must not throw or skip the
      // retry; the exponential-backoff fallback should kick in.
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 2) return mockFetchResponse(429, "limited", { "retry-after": "soon" });
        return mockFetchResponse(200, { ok: true });
      };
      const res = await apiModule.apiGet("/test");
      assert.ok(res.ok);
      assert.equal(attempts, 2);
    });
  });

  describe("Per-attempt timeout cap", () => {
    it("should cap the first attempt's fetch timeout to TAILSCALE_REQUEST_BUDGET_MS", async () => {
      // The budget is documented as "total wall-clock per apiRequest". Pre-fix
      // the first attempt always inherited the 30s REQUEST_TIMEOUT_MS, so a
      // 100ms budget could still let the call hang for ~30s. With the cap,
      // AbortSignal.timeout uses min(REQUEST_TIMEOUT_MS, remaining-budget) so
      // the documented contract holds on attempt 1, not just on retries.
      process.env.TAILSCALE_REQUEST_BUDGET_MS = "100";
      let abortedAtMs: number | undefined;
      const startedAt = Date.now();
      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          // AbortSignal.timeout uses an UNREFED timer -- without something
          // else keeping the event loop alive, node:test sees the loop go
          // idle and reports "Promise resolution is still pending but the
          // event loop has already resolved" before the abort can fire. The
          // refed fallback timer below keeps the loop alive long enough for
          // the (much shorter) abort signal to land.
          const fallback = setTimeout(() => resolve(new Response(null, { status: 200 })), 5000);
          init?.signal?.addEventListener("abort", () => {
            abortedAtMs = Date.now();
            clearTimeout(fallback);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      try {
        await assert.rejects(() => apiModule.apiGet("/test"));
        assert.ok(abortedAtMs !== undefined, "AbortSignal should have fired before the fallback");
        const elapsed = abortedAtMs - startedAt;
        // 1500ms is generous vs the 100ms intended cap; if the 30s timeout
        // were still in play, elapsed would be > 25000ms.
        assert.ok(elapsed < 1500, `expected abort within ~100ms budget, took ${elapsed}ms`);
      } finally {
        delete process.env.TAILSCALE_REQUEST_BUDGET_MS;
      }
    });

    it("should return a budget-exhausted error if the slot opens after the budget is spent", async () => {
      // Tight budget + a slow caller ahead of us in the semaphore queue means
      // by the time we get our slot, there's no time left to attempt at all.
      // Synthesize a clear error rather than firing a fetch that's guaranteed
      // to abort immediately.
      process.env.TAILSCALE_MAX_CONCURRENT = "1";
      process.env.TAILSCALE_REQUEST_BUDGET_MS = "100";
      apiModule.__resetConcurrencyStateForTests();
      globalThis.fetch = async () => {
        // Hold the slot for longer than the second caller's whole budget.
        await new Promise((r) => setTimeout(r, 250));
        return mockFetchResponse(200, { ok: true });
      };
      try {
        const first = apiModule.apiGet("/blocker");
        // Let the first caller take the slot and start its fetch.
        await new Promise((r) => setTimeout(r, 5));
        const second = await apiModule.apiGet("/late");
        await first;
        assert.equal(second.ok, false);
        assert.equal(second.status, 0);
        assert.match(second.error ?? "", /Request budget of 100ms exhausted/);
      } finally {
        delete process.env.TAILSCALE_MAX_CONCURRENT;
        delete process.env.TAILSCALE_REQUEST_BUDGET_MS;
        apiModule.__resetConcurrencyStateForTests();
      }
    });
  });

  describe("Auth resolution under TAILSCALE_MAX_CONCURRENT", () => {
    it("should resolve auth inside the concurrency slot (OAuth refresh does not bypass the cap)", async () => {
      // Pre-fix getAuthHeader ran OUTSIDE withConcurrencyLimit, so an OAuth
      // refresh could fire while another caller's apiRequest fetch was holding
      // the only slot -- peak fetches in flight = 2, breaking the cap.
      //
      // Setup that exposes the race:
      //  * cap = 1
      //  * Two callers (A, B) with OAuth auth and a fresh (empty) token cache
      //  * expires_in = 0 so every getAuthHeader has to refresh
      //
      // The race window is "B launches after A's OAuth fetch resolved but
      // while A's apiRequest fetch is still in flight." We synchronize on
      // that state via a Promise the mock fetch signals -- not on a wall-clock
      // timer. A fixed setTimeout(25) was previously used here, but on slow
      // CI A's OAuth fetch could drift past the gap, B would dedup against
      // A's in-flight refresh promise, and peak would stay at 1 in BOTH
      // pre-fix and post-fix code (false pass).
      //
      // Pre-fix at the sync point: A is mid-apiRequest (in slot), no OAuth
      // refresh is in flight. B's getAuthHeader runs OUTSIDE the slot and
      // fires its own OAuth fetch -> peak = 2.
      // Post-fix at the same point: B's getAuthHeader is inside its (queued)
      // slot, so it can't start until A releases -> peak = 1.
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      process.env.TAILSCALE_MAX_CONCURRENT = "1";
      apiModule.__resetOAuthTokenCacheForTests();
      apiModule.__resetConcurrencyStateForTests();

      let active = 0;
      let peak = 0;
      let signalApiRequestStarted: (() => void) | null = null;
      const apiRequestStarted = new Promise<void>((resolve) => {
        signalApiRequestStarted = resolve;
      });
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const isOAuth = url.includes("/oauth/token");
        active++;
        peak = Math.max(peak, active);
        if (!isOAuth && signalApiRequestStarted) {
          // First non-OAuth fetch entering flight = A's apiRequest fetch.
          // Signal the test body so it can launch B from a deterministic state.
          signalApiRequestStarted();
          signalApiRequestStarted = null;
        }
        if (isOAuth) {
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return mockFetchResponse(200, { access_token: "tk", expires_in: 0 });
        }
        await new Promise((r) => setTimeout(r, 80));
        active--;
        return mockFetchResponse(200, {});
      };

      try {
        const a = apiModule.apiGet("/a");
        // Deterministic sync point: A's OAuth has resolved and A's apiRequest
        // fetch is in flight. Slot held; no OAuth refresh in flight.
        await apiRequestStarted;
        const b = apiModule.apiGet("/b");
        await Promise.all([a, b]);
        assert.equal(peak, 1, `with cap=1, peak in-flight fetches (OAuth + apiRequest) must equal 1, got ${peak}`);
      } finally {
        delete process.env.TAILSCALE_MAX_CONCURRENT;
        delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
        delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
        apiModule.__resetOAuthTokenCacheForTests();
        apiModule.__resetConcurrencyStateForTests();
      }
    });
  });

  describe("Error message extraction", () => {
    it("should prefer .message from JSON error bodies", async () => {
      globalThis.fetch = async () => mockFetchResponse(400, { message: "tailnet not found" });
      const res = await apiModule.apiGet("/test");
      assert.equal(res.ok, false);
      assert.equal(res.error, "tailnet not found");
    });

    it("should prefer .error string when .message absent", async () => {
      globalThis.fetch = async () => mockFetchResponse(400, { error: "bad request" });
      const res = await apiModule.apiGet("/test");
      assert.equal(res.error, "bad request");
    });

    it("should fall back to raw body when JSON has no message/error string", async () => {
      globalThis.fetch = async () => mockFetchResponse(400, { code: 42, details: ["a", "b"] });
      const res = await apiModule.apiGet("/test");
      assert.match(res.error ?? "", /code/);
    });

    it("should leave non-JSON bodies untouched", async () => {
      globalThis.fetch = async () => mockFetchResponse(500, "Internal Server Error");
      const res = await apiModule.apiGet("/test");
      assert.equal(res.error, "Internal Server Error");
    });

    it("should not extract message on 401 (auth-error formatter wins)", async () => {
      globalThis.fetch = async () => mockFetchResponse(401, { message: "not authenticated" });
      const res = await apiModule.apiGet("/test");
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /Authentication failed/);
    });

    it("should ignore empty-string .message and fall through to .error", async () => {
      // api.ts:233 only accepts .message when length > 0; otherwise .error wins.
      globalThis.fetch = async () => mockFetchResponse(400, { message: "", error: "real error" });
      const res = await apiModule.apiGet("/test");
      assert.equal(res.error, "real error");
    });

    it("should return the raw body when a JSON-shaped body fails to parse", async () => {
      // Exercises the catch branch in extractErrorMessage: the body starts with
      // `{` (so it passes the startsWith fast-path and JSON.parse is attempted)
      // but is truncated/unterminated, so JSON.parse throws. The catch must fall
      // through to returning the raw body verbatim rather than swallowing it.
      // Use 500 so the error routes through extractErrorMessage, not
      // formatAuthError (which owns 401/403).
      const malformed = '{"message": ';
      globalThis.fetch = async () => mockFetchResponse(500, malformed);
      const res = await apiModule.apiGet("/test");
      assert.equal(res.ok, false);
      assert.equal(res.status, 500);
      assert.equal(res.error, malformed, "malformed JSON should fall through to the raw body verbatim");
    });
  });

  describe("TAILSCALE_DEBUG", () => {
    it("should write request lines to stderr when set to '1'", async () => {
      process.env.TAILSCALE_DEBUG = "1";
      const originalErr = console.error;
      const lines: string[] = [];
      console.error = (...args: unknown[]) => lines.push(args.join(" "));
      try {
        globalThis.fetch = async () => mockFetchResponse(200, {});
        await apiModule.apiGet("/test");
      } finally {
        console.error = originalErr;
        delete process.env.TAILSCALE_DEBUG;
      }
      assert.ok(
        lines.some((l) => l.includes("[tailscale-mcp]") && l.includes("GET")),
        `expected GET log line, got: ${JSON.stringify(lines)}`,
      );
    });

    it("should be silent when unset", async () => {
      const originalErr = console.error;
      const lines: string[] = [];
      console.error = (...args: unknown[]) => lines.push(args.join(" "));
      try {
        globalThis.fetch = async () => mockFetchResponse(200, {});
        await apiModule.apiGet("/test");
      } finally {
        console.error = originalErr;
      }
      assert.equal(lines.length, 0);
    });
  });

  describe("TAILSCALE_MAX_CONCURRENT", () => {
    it("should serialize calls when set to 1", async () => {
      process.env.TAILSCALE_MAX_CONCURRENT = "1";
      apiModule.__resetConcurrencyStateForTests();
      let active = 0;
      let peak = 0;
      globalThis.fetch = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return mockFetchResponse(200, {});
      };
      try {
        await Promise.all([apiModule.apiGet("/a"), apiModule.apiGet("/b"), apiModule.apiGet("/c")]);
      } finally {
        delete process.env.TAILSCALE_MAX_CONCURRENT;
        apiModule.__resetConcurrencyStateForTests();
      }
      assert.equal(peak, 1, `expected serialized execution, observed peak in-flight=${peak}`);
    });

    it("should not cap when unset", async () => {
      apiModule.__resetConcurrencyStateForTests();
      let active = 0;
      let peak = 0;
      globalThis.fetch = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return mockFetchResponse(200, {});
      };
      await Promise.all([apiModule.apiGet("/a"), apiModule.apiGet("/b"), apiModule.apiGet("/c")]);
      assert.ok(peak >= 2, `expected concurrent execution, observed peak in-flight=${peak}`);
    });

    it("should not cap when set to '0'", async () => {
      // 0 is the explicit no-cap sentinel — getConcurrencyLimit returns 0 and
      // withConcurrencyLimit short-circuits.
      process.env.TAILSCALE_MAX_CONCURRENT = "0";
      apiModule.__resetConcurrencyStateForTests();
      let active = 0;
      let peak = 0;
      globalThis.fetch = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return mockFetchResponse(200, {});
      };
      try {
        await Promise.all([apiModule.apiGet("/a"), apiModule.apiGet("/b"), apiModule.apiGet("/c")]);
      } finally {
        delete process.env.TAILSCALE_MAX_CONCURRENT;
        apiModule.__resetConcurrencyStateForTests();
      }
      assert.ok(peak >= 2, `expected concurrent execution with TAILSCALE_MAX_CONCURRENT=0, observed peak=${peak}`);
    });

    it("should not cap when set to '-1'", async () => {
      // Negative values are not "positive integer" per the doc — fall through
      // to no-cap behavior rather than throwing or applying as-is.
      process.env.TAILSCALE_MAX_CONCURRENT = "-1";
      apiModule.__resetConcurrencyStateForTests();
      let active = 0;
      let peak = 0;
      globalThis.fetch = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return mockFetchResponse(200, {});
      };
      try {
        await Promise.all([apiModule.apiGet("/a"), apiModule.apiGet("/b"), apiModule.apiGet("/c")]);
      } finally {
        delete process.env.TAILSCALE_MAX_CONCURRENT;
        apiModule.__resetConcurrencyStateForTests();
      }
      assert.ok(peak >= 2, `expected concurrent execution with TAILSCALE_MAX_CONCURRENT=-1, observed peak=${peak}`);
    });

    it("should not cap when set to a non-numeric value", async () => {
      process.env.TAILSCALE_MAX_CONCURRENT = "not-a-number";
      apiModule.__resetConcurrencyStateForTests();
      let active = 0;
      let peak = 0;
      globalThis.fetch = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return mockFetchResponse(200, {});
      };
      try {
        await Promise.all([apiModule.apiGet("/a"), apiModule.apiGet("/b"), apiModule.apiGet("/c")]);
      } finally {
        delete process.env.TAILSCALE_MAX_CONCURRENT;
        apiModule.__resetConcurrencyStateForTests();
      }
      assert.ok(
        peak >= 2,
        `expected concurrent execution with TAILSCALE_MAX_CONCURRENT=not-a-number, observed peak=${peak}`,
      );
    });

    it("should not cap when set to a partial-parse value like '3abc'", async () => {
      // Pre-fix this set the cap to 3 (Number.parseInt accepts trailing garbage).
      // Strict parsing via Number() returns NaN for the same input, so it falls
      // through to no-cap behavior. Documenting the stricter contract here so a
      // future regression to parseInt() can't slip past.
      process.env.TAILSCALE_MAX_CONCURRENT = "3abc";
      apiModule.__resetConcurrencyStateForTests();
      let active = 0;
      let peak = 0;
      globalThis.fetch = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return mockFetchResponse(200, {});
      };
      try {
        // Launch five so a former parseInt-cap of 3 would clamp peak to 3, but
        // strict parsing leaves the cap unset and all five can run together.
        await Promise.all([
          apiModule.apiGet("/a"),
          apiModule.apiGet("/b"),
          apiModule.apiGet("/c"),
          apiModule.apiGet("/d"),
          apiModule.apiGet("/e"),
        ]);
      } finally {
        delete process.env.TAILSCALE_MAX_CONCURRENT;
        apiModule.__resetConcurrencyStateForTests();
      }
      assert.ok(
        peak >= 4,
        `expected unbounded concurrency with TAILSCALE_MAX_CONCURRENT='3abc', observed peak=${peak}`,
      );
    });

    it("should not cap when set to a fractional value like '2.5'", async () => {
      // Number("2.5") is 2.5 -- not an integer. Pre-fix Number.parseInt("2.5")
      // would have returned 2 and applied a cap. Strict integer parsing
      // rejects fractions, so no cap is applied.
      process.env.TAILSCALE_MAX_CONCURRENT = "2.5";
      apiModule.__resetConcurrencyStateForTests();
      let active = 0;
      let peak = 0;
      globalThis.fetch = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return mockFetchResponse(200, {});
      };
      try {
        await Promise.all([
          apiModule.apiGet("/a"),
          apiModule.apiGet("/b"),
          apiModule.apiGet("/c"),
          apiModule.apiGet("/d"),
        ]);
      } finally {
        delete process.env.TAILSCALE_MAX_CONCURRENT;
        apiModule.__resetConcurrencyStateForTests();
      }
      assert.ok(peak >= 3, `expected unbounded concurrency with TAILSCALE_MAX_CONCURRENT='2.5', observed peak=${peak}`);
    });

    it("should never exceed the cap when many requests fan out and queue", async () => {
      // Stricter-than-existing assertion: peak must equal the cap exactly when
      // there are more concurrent requests than slots. The previous semaphore
      // could temporarily exceed `limit` by 1+ because `inFlight--` in `finally`
      // raced with new arrivals that read the lower count before queued waiters
      // resumed and re-incremented. Direct slot hand-off fixes this; this test
      // pins the contract so a regression to the old "decrement, resolve, let
      // waiter re-increment" pattern would surface.
      process.env.TAILSCALE_MAX_CONCURRENT = "2";
      apiModule.__resetConcurrencyStateForTests();
      let active = 0;
      let peak = 0;
      globalThis.fetch = async () => {
        active++;
        peak = Math.max(peak, active);
        // Two microtask hops + a tick to maximize the chance that resuming
        // waiters and fresh arrivals interleave in the microtask queue.
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return mockFetchResponse(200, {});
      };
      try {
        // 12 requests against a cap of 2 produces the maximum opportunity for
        // hand-off/arrival interleaving.
        await Promise.all(Array.from({ length: 12 }, (_, i) => apiModule.apiGet(`/p${i}`)));
      } finally {
        delete process.env.TAILSCALE_MAX_CONCURRENT;
        apiModule.__resetConcurrencyStateForTests();
      }
      assert.equal(peak, 2, `cap must be honored exactly; observed peak=${peak} with TAILSCALE_MAX_CONCURRENT=2`);
    });

    it("should never exceed the cap under deliberate race-window interleaving", async () => {
      // Reproduce the exact shape of the old bug: keep the cap saturated, then
      // inject fresh callers in the microtask window between an exiting
      // request's `finally` and the queued waiter's resume. Pre-fix this would
      // intermittently let peak climb to limit+1; with direct slot hand-off,
      // fresh arrivals always see `inFlight === limit` and queue.
      process.env.TAILSCALE_MAX_CONCURRENT = "3";
      apiModule.__resetConcurrencyStateForTests();
      let active = 0;
      let peak = 0;
      const ticks = (n: number) => {
        let p = Promise.resolve();
        for (let i = 0; i < n; i++) p = p.then(() => undefined);
        return p;
      };
      globalThis.fetch = async () => {
        active++;
        peak = Math.max(peak, active);
        await ticks(3);
        active--;
        return mockFetchResponse(200, {});
      };
      try {
        // Start the first wave (saturates + queues), then interleave a second
        // wave on each microtask hop so fresh arrivals land in the race window.
        const firstWave = Array.from({ length: 8 }, (_, i) => apiModule.apiGet(`/w1-${i}`));
        await ticks(1);
        const secondWave = Array.from({ length: 8 }, (_, i) => apiModule.apiGet(`/w2-${i}`));
        await ticks(1);
        const thirdWave = Array.from({ length: 8 }, (_, i) => apiModule.apiGet(`/w3-${i}`));
        await Promise.all([...firstWave, ...secondWave, ...thirdWave]);
      } finally {
        delete process.env.TAILSCALE_MAX_CONCURRENT;
        apiModule.__resetConcurrencyStateForTests();
      }
      assert.equal(peak, 3, `cap must be honored exactly across interleaved waves; observed peak=${peak}`);
    });

    it("should release the slot when a wrapped fetch rejects (so queued callers proceed)", async () => {
      // The slot release lives in withConcurrencyLimit's `finally`. Every other
      // cap test resolves its mock fetch -- this one exercises the throw path.
      // If `finally` ever broke (e.g. a refactor moved the increment outside
      // the try, or replaced try/finally with try/catch), a single transient
      // error would silently saturate the cap for the rest of the process
      // lifetime. The signal-on-fetch + setTimeout pattern keeps the second
      // caller queued at the moment the first throws, so the assertion really
      // tests "B inherited A's slot via the finally hand-off", not just
      // "B ran after A finished".
      process.env.TAILSCALE_MAX_CONCURRENT = "1";
      apiModule.__resetConcurrencyStateForTests();

      let signalFirstStarted: (() => void) | null = null;
      const firstFetchStarted = new Promise<void>((resolve) => {
        signalFirstStarted = resolve;
      });
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        if (fetchCount === 1) {
          signalFirstStarted?.();
          // Hold the slot long enough for B to queue, then throw. 100ms is
          // comfortably longer than B's await-chain microtasks need to push
          // it into the queue, so the test reliably exercises the hand-off
          // path even on a slow CI runner.
          await new Promise((r) => setTimeout(r, 100));
          throw new Error("simulated network down");
        }
        return mockFetchResponse(200, { ok: true });
      };

      try {
        const a = apiModule.apiGet("/a");
        // Deterministic sync point: A has taken the slot and entered fetch.
        await firstFetchStarted;
        // B must queue (inFlight=1, cap=1).
        const b = apiModule.apiGet("/b");
        await assert.rejects(() => a);
        const res = await b;
        assert.ok(res.ok, "B must succeed -- slot was released by A's finally block");
      } finally {
        delete process.env.TAILSCALE_MAX_CONCURRENT;
        apiModule.__resetConcurrencyStateForTests();
      }
    });

    it("should honor a strict cap of 1 (serialized) even with queued + fresh arrivals", async () => {
      // Cap of 1 makes the race the most visible: any double-count immediately
      // shows up as peak=2. With direct hand-off the cap is exact even when
      // requests arrive in a tight interleaved burst.
      process.env.TAILSCALE_MAX_CONCURRENT = "1";
      apiModule.__resetConcurrencyStateForTests();
      let active = 0;
      let peak = 0;
      globalThis.fetch = async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        await Promise.resolve();
        active--;
        return mockFetchResponse(200, {});
      };
      try {
        await Promise.all(Array.from({ length: 6 }, (_, i) => apiModule.apiGet(`/s${i}`)));
      } finally {
        delete process.env.TAILSCALE_MAX_CONCURRENT;
        apiModule.__resetConcurrencyStateForTests();
      }
      assert.equal(peak, 1, `cap of 1 must serialize; observed peak=${peak}`);
    });
  });

  describe("formatAuthError on 403 (per-call authorization failure)", () => {
    it("should produce a structured 403 message with API key wording", async () => {
      // Pre-fix this returned the raw body verbatim via extractErrorMessage,
      // which hid the actionable guidance. Now 403 routes through
      // formatAuthError just like 401, but with permission-shaped wording.
      process.env.TAILSCALE_API_KEY = "tskey-api-test";
      delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
      delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
      globalThis.fetch = async () => mockFetchResponse(403, "Forbidden");

      const res = await apiModule.apiGet("/test");
      assert.equal(res.ok, false);
      assert.equal(res.status, 403);
      assert.match(res.error ?? "", /Authorization failed \(HTTP 403\)/);
      assert.match(res.error ?? "", /API key lacks the permission required for this endpoint/);
      assert.match(res.error ?? "", /Adjust the API key permissions/);
      // 403 should NOT mention "expired or been revoked" (that's the 401-shape
      // diagnosis) -- a present-but-insufficient key is a different cause.
      assert.ok(
        !/expired or been revoked/.test(res.error ?? ""),
        `unexpected 401 wording in 403 message: ${res.error}`,
      );
      // The raw API body must still flow through so callers can see what
      // Tailscale actually said.
      assert.match(res.error ?? "", /API response: Forbidden/);
    });

    it("should produce a structured 403 message with OAuth-scope wording", async () => {
      // Most likely real-world 403: OAuth client authenticated successfully at
      // /oauth/token but lacks the specific scope this endpoint requires.
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      apiModule.__resetOAuthTokenCacheForTests();
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) return mockFetchResponse(200, { access_token: "tk", expires_in: 3600 });
        return mockFetchResponse(403, "missing scope: devices:write");
      };

      const res = await apiModule.apiGet("/test");
      assert.equal(res.ok, false);
      assert.equal(res.status, 403);
      assert.match(res.error ?? "", /Authorization failed \(HTTP 403\)/);
      assert.match(res.error ?? "", /OAuth client is missing a scope required for this endpoint/);
      assert.match(res.error ?? "", /Adjust the OAuth client scopes at:/);
      assert.match(res.error ?? "", /admin\/settings\/oauth/);
      assert.match(res.error ?? "", /API response: missing scope: devices:write/);
    });

    it("should produce a structured 401 message with OAuth-invalid-credentials wording", async () => {
      // The 401+OAuth arm of formatAuthError (api.ts cause line: "OAuth client
      // credentials are invalid or lack required scopes"). Distinct from the
      // 403+OAuth case above (scope-missing) and from the 401+apiKey case
      // ("expired or been revoked"). OAuth creds are configured the same way as
      // the 403+OAuth test, but the /oauth/token exchange succeeds and the
      // subsequent tool call returns 401.
      delete process.env.TAILSCALE_API_KEY;
      process.env.TAILSCALE_OAUTH_CLIENT_ID = "client-id";
      process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "client-secret";
      apiModule.__resetOAuthTokenCacheForTests();
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/oauth/token")) return mockFetchResponse(200, { access_token: "tk", expires_in: 3600 });
        return mockFetchResponse(401, "unauthorized");
      };

      const res = await apiModule.apiGet("/test");
      assert.equal(res.ok, false);
      assert.equal(res.status, 401);
      assert.match(res.error ?? "", /Authentication failed \(HTTP 401\)/);
      assert.match(res.error ?? "", /OAuth client credentials are invalid or lack required scopes/);
      // The 401+OAuth path must NOT surface the apiKey-shaped diagnosis.
      assert.ok(
        !/API key has expired or been revoked/.test(res.error ?? ""),
        `unexpected apiKey wording in 401+OAuth message: ${res.error}`,
      );
    });

    it("should NOT include the Windows env-var hint on a 403 (that's a 401-shaped cause)", async () => {
      // A 403 means the request was authenticated -- so the "env var not
      // visible" hint that the 401 path surfaces would be misdirection here.
      process.env.TAILSCALE_API_KEY = "tskey-api-test";
      delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
      delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;

      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      assert.ok(platformDescriptor, "expected process.platform to have an own-property descriptor");
      const realPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        globalThis.fetch = async () => mockFetchResponse(403, "Forbidden");
        const res = await apiModule.apiGet("/test");
        assert.equal(res.status, 403);
        assert.ok(
          !/On Windows, env vars set in bash\/WSL profiles/.test(res.error ?? ""),
          `403 message should not surface the 401 Windows hint, got: ${res.error}`,
        );
      } finally {
        Object.defineProperty(process, "platform", platformDescriptor);
        assert.equal(process.platform, realPlatform, "platform restore failed -- subsequent tests would be polluted");
      }
    });

    it("should route 403 through formatAuthError on the acceptRaw path too", async () => {
      // The non-acceptRaw and acceptRaw paths are separate branches in
      // apiRequest -- regression-prone duplicate guard, pin both.
      process.env.TAILSCALE_API_KEY = "tskey-api-test";
      delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
      delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
      globalThis.fetch = async () => mockFetchResponse(403, "Forbidden raw");

      const res = await apiModule.apiGet("/test", { acceptRaw: true });
      assert.equal(res.ok, false);
      assert.equal(res.status, 403);
      assert.match(res.error ?? "", /Authorization failed \(HTTP 403\)/);
      // rawBody must still be populated on acceptRaw paths regardless of the
      // synthesized error message.
      assert.equal(res.rawBody, "Forbidden raw");
    });
  });

  describe("formatAuthError platform-specific guidance", () => {
    it("should include Windows-specific hint when platform is win32 and using API key", async () => {
      // The Windows hint only fires for the non-OAuth path (api.ts:197).
      process.env.TAILSCALE_API_KEY = "tskey-api-test";
      delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
      delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;

      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      // Refuse to run if we couldn't snapshot the original -- otherwise we'd
      // leave the process pinned to win32 for every subsequent test in the
      // file. (Defensive; Node always defines this property.)
      assert.ok(platformDescriptor, "expected process.platform to have an own-property descriptor");
      const realPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        globalThis.fetch = async () => mockFetchResponse(401, "unauthorized");
        const res = await apiModule.apiGet("/test");
        assert.equal(res.ok, false);
        assert.equal(res.status, 401);
        assert.ok(
          res.error?.includes("On Windows, env vars set in bash/WSL profiles"),
          `expected Windows hint in error, got: ${res.error}`,
        );
      } finally {
        Object.defineProperty(process, "platform", platformDescriptor);
        // Belt-and-braces sanity check: confirm the restore actually landed.
        assert.equal(process.platform, realPlatform, "platform restore failed -- subsequent tests would be polluted");
      }
    });
  });
});
