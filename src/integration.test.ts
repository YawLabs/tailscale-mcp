/**
 * Integration tests that hit the real Tailscale API.
 *
 * Gated behind RUN_INTEGRATION_TESTS=1 AND live credentials
 * (TAILSCALE_API_KEY or TAILSCALE_OAUTH_CLIENT_ID + TAILSCALE_OAUTH_CLIENT_SECRET).
 * Without both, the entire suite is skipped — so `npm test` in normal
 * development and PR CI remains fully offline.
 *
 * These tests exercise read-only tool handlers against a live tailnet to catch
 * API shape drift that fetch mocks cannot. No mutations are performed, so they
 * are safe to run against any tailnet (including production), though a
 * dedicated test tailnet is recommended.
 *
 * Run locally (bash):
 *   RUN_INTEGRATION_TESTS=1 TAILSCALE_API_KEY=tskey-api-... npm test
 *
 * CI: .github/workflows/integration.yml (manual dispatch only)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const hasCredentials =
  !!process.env.TAILSCALE_API_KEY ||
  (!!process.env.TAILSCALE_OAUTH_CLIENT_ID && !!process.env.TAILSCALE_OAUTH_CLIENT_SECRET);

const runIntegration = process.env.RUN_INTEGRATION_TESTS === "1" && hasCredentials;

type ApiResult<T> = {
  ok: boolean;
  status?: number;
  data?: T;
  rawBody?: string;
  etag?: string;
  error?: string;
};

describe("Integration: real Tailscale API (read-only)", { skip: !runIntegration }, () => {
  it("tailscale_status returns tailnet, deviceCount, and connected flag", async () => {
    const { statusTools } = await import("./tools/status.js");
    const tool = statusTools.find((t) => t.name === "tailscale_status");
    assert.ok(tool, "tailscale_status tool not found");
    const handler = tool.handler as () => Promise<
      ApiResult<{ connected: boolean; deviceCount: number; tailnet: string }>
    >;
    const result = await handler();
    assert.equal(result.ok, true, `API call failed: ${result.error ?? "(no error)"}`);
    assert.equal(typeof result.data?.tailnet, "string");
    assert.equal(typeof result.data?.connected, "boolean");
    assert.equal(typeof result.data?.deviceCount, "number");
  });

  it("tailscale_list_devices returns a devices array", async () => {
    const { deviceTools } = await import("./tools/devices.js");
    const tool = deviceTools.find((t) => t.name === "tailscale_list_devices");
    assert.ok(tool, "tailscale_list_devices tool not found");
    const handler = tool.handler as (input: { fields?: string }) => Promise<ApiResult<{ devices?: unknown[] }>>;
    const result = await handler({});
    assert.equal(result.ok, true, `API call failed: ${result.error ?? "(no error)"}`);
    assert.ok(Array.isArray(result.data?.devices), "expected data.devices to be an array");
  });

  it("tailscale_list_keys returns a keys array", async () => {
    const { keyTools } = await import("./tools/keys.js");
    const tool = keyTools.find((t) => t.name === "tailscale_list_keys");
    assert.ok(tool, "tailscale_list_keys tool not found");
    const handler = tool.handler as (input: { all?: boolean }) => Promise<ApiResult<{ keys?: unknown[] }>>;
    const result = await handler({});
    assert.equal(result.ok, true, `API call failed: ${result.error ?? "(no error)"}`);
    assert.ok(Array.isArray(result.data?.keys), "expected data.keys to be an array");
  });

  it("tailscale_get_acl returns non-empty HuJSON body with ETag marker", async () => {
    const { aclTools } = await import("./tools/acl.js");
    const tool = aclTools.find((t) => t.name === "tailscale_get_acl");
    assert.ok(tool, "tailscale_get_acl tool not found");
    const handler = tool.handler as () => Promise<ApiResult<unknown>>;
    const result = await handler();
    assert.equal(result.ok, true, `API call failed: ${result.error ?? "(no error)"}`);
    assert.equal(typeof result.rawBody, "string");
    assert.ok((result.rawBody?.length ?? 0) > 0, "expected non-empty ACL body");
    // The handler appends an ETag marker to rawBody for downstream update calls
    assert.match(result.rawBody ?? "", /ETag:\s*\S+/);
  });
});
