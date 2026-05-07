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
      globalThis.fetch = async () => mockFetchResponse(403, "Forbidden");

      const res = await apiModule.apiGet("/tailnet/test/devices");
      assert.equal(res.ok, false);
      assert.equal(res.status, 403);
      assert.equal(res.error, "Forbidden");
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

    it("should give up retrying when remaining budget can't fit another attempt", async () => {
      // 1s budget vs 30s per-attempt timeout — the first retry's predicted
      // wall-clock would already exceed the budget, so we should bail with the
      // 429 after a single attempt instead of sitting on the call.
      process.env.TAILSCALE_REQUEST_BUDGET_MS = "1000";
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return mockFetchResponse(429, "limited", { "retry-after": "0" });
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
      // 5-second offset (rather than 100ms) so .toUTCString()'s floor-to-
      // whole-seconds still leaves a measurable delay -- this lets us assert
      // the date branch was actually *taken* (delay > 0), not merely that it
      // didn't throw. parseInt("Tue, ...") is NaN, so this can't accidentally
      // pass via the integer branch.
      let attempts = 0;
      const startedAt = Date.now();
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 2) {
          const retryAfter = new Date(Date.now() + 5000).toUTCString();
          return mockFetchResponse(429, "limited", { "retry-after": retryAfter });
        }
        return mockFetchResponse(200, { ok: true });
      };
      const res = await apiModule.apiGet("/test");
      const elapsed = Date.now() - startedAt;
      assert.ok(res.ok);
      assert.equal(attempts, 2);
      // Generous lower bound: implied delay is somewhere in [~4000, 5000)ms
      // due to the second-floor; assert >= 3500 to absorb scheduler jitter.
      assert.ok(elapsed >= 3500, `expected at least 3500ms elapsed (date branch should sleep), got ${elapsed}ms`);
      assert.ok(elapsed < 8000, `expected under 8s elapsed, got ${elapsed}ms`);
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
