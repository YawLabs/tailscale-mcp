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
});
