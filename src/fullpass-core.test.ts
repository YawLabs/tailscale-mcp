import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { __resetOAuthTokenCacheForTests, apiGet, hasUsableCredentials } from "./api.js";
import { formatBannerFilterSuffix, tailnetStatusResource } from "./server-wiring.js";
import { buildMetaTools, type CatalogState, explainTool } from "./tools/meta.js";
import { statusTools } from "./tools/status.js";

/**
 * Pins for the fixes from the full-pass review of the core modules (status fetch,
 * api.ts response handling, the catalog's remedies, and startup stderr).
 */

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  Object.assign(process.env, originalEnv);
}

function baseEnv(): void {
  delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
  delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
  delete process.env.TAILSCALE_REQUEST_BUDGET_MS;
  process.env.TAILSCALE_API_KEY = "tskey-api-test123";
  process.env.TAILSCALE_TAILNET = "test.tailnet.ts.net";
  process.env.TAILSCALE_RETRY_BASE_DELAY_MS = "1";
}

describe("status fetch pair", () => {
  beforeEach(baseEnv);
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  function captureUrls(): string[] {
    const urls: string[] = [];
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const body = url.includes("/devices") ? { devices: [{ id: "a" }, { id: "b" }] } : { devicesApprovalOn: false };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    return urls;
  }

  it("the tool and the resource send the same documented query", async () => {
    // The spec documents only fields=all|default. Both surfaces go through one helper,
    // so neither can drift back to the undocumented fields=id on its own.
    const toolUrls = captureUrls();
    const result = (await statusTools[0].handler()) as unknown as { ok: boolean; data: { deviceCount: number } };
    assert.equal(result.ok, true);
    assert.equal(result.data.deviceCount, 2);

    const resourceUrls = captureUrls();
    const res = await tailnetStatusResource(new URL("tailscale://tailnet/status"));
    assert.equal(JSON.parse(res.contents[0].text).deviceCount, 2);

    for (const urls of [toolUrls, resourceUrls]) {
      const devices = urls.filter((u) => u.includes("/devices"));
      assert.equal(devices.length, 1);
      assert.match(devices[0], /\/tailnet\/test\.tailnet\.ts\.net\/devices\?fields=default$/);
      assert.ok(urls.some((u) => u.endsWith("/tailnet/test.tailnet.ts.net/settings")));
      assert.ok(!urls.some((u) => u.includes("fields=id")));
    }
  });
});

describe("api.ts response handling", () => {
  beforeEach(() => {
    baseEnv();
    __resetOAuthTokenCacheForTests();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetOAuthTokenCacheForTests();
    restoreEnv();
  });

  it("treats an empty 200 with no content-length as success", async () => {
    globalThis.fetch = async () => new Response("", { status: 200 });
    const res = await apiGet("/tailnet/-/thing");
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.data, undefined);
  });

  it("still reports an unparseable non-empty 200 as a body-read failure", async () => {
    globalThis.fetch = async () => new Response("not json", { status: 200 });
    const res = await apiGet("/tailnet/-/thing");
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Failed to read response body/);
  });

  it("keeps the 429 in the error when a later retry fails at the transport level", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      throw new TypeError("fetch failed");
    };
    const res = await apiGet("/tailnet/-/thing");
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /request failed: fetch failed/);
    assert.match(res.error ?? "", /an earlier attempt was rate-limited: HTTP 429/);
  });

  it("does not add the rate-limit note when no 429 preceded the failure", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const res = await apiGet("/tailnet/-/thing");
    assert.equal(res.ok, false);
    assert.ok(!/rate-limited/.test(res.error ?? ""), res.error ?? "");
  });

  function oauthEnv(): void {
    delete process.env.TAILSCALE_API_KEY;
    process.env.TAILSCALE_OAUTH_CLIENT_ID = "cid";
    process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "csecret";
  }

  it("caches an OAuth token whose response omits expires_in instead of re-minting per request", async () => {
    oauthEnv();
    let tokenFetches = 0;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        tokenFetches++;
        return new Response(JSON.stringify({ access_token: "tk" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    };
    await apiGet("/tailnet/-/a");
    await apiGet("/tailnet/-/b");
    assert.equal(tokenFetches, 1, "a NaN expiry would mint a token on every request");
  });

  it("fails the exchange clearly when the token response has no access_token", async () => {
    oauthEnv();
    globalThis.fetch = async () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 });
    await assert.rejects(() => apiGet("/tailnet/-/a"), /no access_token/);
  });

  it("hasUsableCredentials follows getAuthConfig's trimming and precedence", () => {
    process.env.TAILSCALE_API_KEY = "tskey-api-x";
    assert.equal(hasUsableCredentials(), true);
    process.env.TAILSCALE_API_KEY = "   ";
    assert.equal(hasUsableCredentials(), false);
    // An empty API key wins over a valid OAuth pair in getAuthConfig, so it is not usable.
    process.env.TAILSCALE_API_KEY = "";
    process.env.TAILSCALE_OAUTH_CLIENT_ID = "cid";
    process.env.TAILSCALE_OAUTH_CLIENT_SECRET = "csecret";
    assert.equal(hasUsableCredentials(), false);
    delete process.env.TAILSCALE_API_KEY;
    assert.equal(hasUsableCredentials(), true);
    process.env.TAILSCALE_OAUTH_CLIENT_SECRET = " ";
    assert.equal(hasUsableCredentials(), false);
  });
});

describe("catalog remedies", () => {
  const registry: CatalogState["fullRegistry"] = {
    status: [{ name: "get_status", annotations: { readOnlyHint: true } }],
    devices: [
      { name: "list_devices", annotations: { readOnlyHint: true } },
      { name: "delete_device", annotations: { readOnlyHint: false } },
    ],
    acl: [
      { name: "get_acl", annotations: { readOnlyHint: true } },
      { name: "update_acl", annotations: { readOnlyHint: false } },
    ],
  };
  function state(over: Partial<CatalogState> = {}): CatalogState {
    return {
      fullRegistry: registry,
      registeredNames: new Set(["get_status", "list_devices", "delete_device"]),
      toolsEnv: undefined,
      profileEnv: undefined,
      writeGroupsEnv: undefined,
      readonlyMode: false,
      localCliEnabled: false,
      ...over,
    };
  }

  it("blames the profile, not an ignored all-unknown TAILSCALE_TOOLS", () => {
    const r = explainTool(
      "get_acl",
      state({ toolsEnv: "devises", toolsIgnored: true, profileEnv: "minimal" }),
    ) as unknown as { reason: string; toEnable: string };
    assert.match(r.reason, /TAILSCALE_PROFILE="minimal"/);
    assert.ok(!/TAILSCALE_TOOLS/.test(r.reason), r.reason);
    assert.ok(!/add "acl" to TAILSCALE_TOOLS/.test(r.toEnable), r.toEnable);
  });

  it("does not blame a whitespace-only TAILSCALE_TOOLS, which parses as unset", () => {
    const r = explainTool("get_acl", state({ toolsEnv: "  ", profileEnv: "minimal" })) as unknown as {
      reason: string;
    };
    assert.match(r.reason, /TAILSCALE_PROFILE="minimal"/);
  });

  it("still blames TAILSCALE_TOOLS when it actually filtered", () => {
    const r = explainTool("get_acl", state({ toolsEnv: "status,devices" })) as unknown as { toEnable: string };
    assert.equal(r.toEnable, 'add "acl" to TAILSCALE_TOOLS');
  });

  it("names a typo'd write grant and leaves it out of the suggested value", () => {
    const r = explainTool(
      "delete_device",
      state({ writeGroupsEnv: "devises", registeredNames: new Set(["get_status", "list_devices"]) }),
    ) as unknown as { reason: string; toEnable: string };
    assert.match(r.reason, /"devises" is not a group name and grants nothing/);
    assert.equal(r.toEnable, 'add "devices" to TAILSCALE_WRITE_GROUPS (e.g. "devices")');
  });

  it("keeps the valid names of a partially typo'd grant in the suggestion", () => {
    const r = explainTool(
      "delete_device",
      state({ writeGroupsEnv: "acl,devises", registeredNames: new Set(["get_status", "list_devices"]) }),
    ) as unknown as { toEnable: string };
    assert.equal(r.toEnable, 'add "devices" to TAILSCALE_WRITE_GROUPS (e.g. "acl,devices")');
  });

  it("echoes TAILSCALE_READONLY as the operator set it, and marks an ignored TAILSCALE_TOOLS", async () => {
    const [tool] = buildMetaTools(
      state({ readonlyMode: true, readonlyEnv: "true", toolsEnv: "devises", toolsIgnored: true }),
    );
    const out = (await tool.handler({})) as { data: { activeFilters: string[] } };
    assert.ok(out.data.activeFilters.includes("TAILSCALE_READONLY=true"), JSON.stringify(out.data.activeFilters));
    assert.ok(
      out.data.activeFilters.includes("TAILSCALE_TOOLS=devises (ignored: names no known group)"),
      JSON.stringify(out.data.activeFilters),
    );
  });
});

describe("banner filter suffix", () => {
  it("renders nothing for a whitespace-only profile", () => {
    const suffix = formatBannerFilterSuffix({
      unknownProfile: undefined,
      explicitTools: undefined,
      profileWouldFilter: undefined,
      profileEnv: "   ",
      readonlyMode: false,
      localCliEnabled: false,
    });
    assert.equal(suffix, "");
  });

  it("renders a padded valid profile trimmed", () => {
    const suffix = formatBannerFilterSuffix({
      unknownProfile: undefined,
      explicitTools: undefined,
      profileWouldFilter: true,
      profileEnv: " core ",
      readonlyMode: false,
      localCliEnabled: false,
    });
    assert.equal(suffix, "profile=core");
  });
});

// Startup stderr, observed on the built bundle the same way index.test.ts does.
const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");

async function captureStartup(extraEnv: Record<string, string>): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [serverEntry], {
      env: { PATH: process.env.PATH ?? "", ...extraEnv },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not exit after stdin EOF; stderr so far: ${JSON.stringify(stderr)}`));
    }, 15_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolvePromise(stderr);
    });
    child.stdin.end();
  });
}

describe("startup stderr", () => {
  it("cites only the admin-equivalent areas this process can write", async () => {
    const stderr = await captureStartup({ TAILSCALE_API_KEY: "tskey-api-x", TAILSCALE_WRITE_GROUPS: "keys" });
    assert.match(stderr, /can write to keys, which is tailnet-admin-equivalent\. tailscale_create_key mints/);
    assert.ok(!/tailscale_update_user_role|tailscale_update_acl/.test(stderr), stderr);
  });

  it("keeps all three examples on the ungated default", async () => {
    const stderr = await captureStartup({ TAILSCALE_API_KEY: "tskey-api-x" });
    assert.match(
      stderr,
      /asks for, tailscale_update_user_role accepts "owner", and tailscale_update_acl rewrites policy for every principal\./,
    );
  });

  it("does not treat a whitespace-only API key as working credentials", async () => {
    const stderr = await captureStartup({ TAILSCALE_API_KEY: "   " });
    assert.ok(!/tip -- set TAILSCALE_PROFILE/.test(stderr), stderr);
    assert.ok(!/admin-equivalent/.test(stderr), stderr);
  });

  it("shows the profile tip for a whitespace-only TAILSCALE_PROFILE", async () => {
    const stderr = await captureStartup({ TAILSCALE_API_KEY: "tskey-api-x", TAILSCALE_PROFILE: "   " });
    assert.ok(!/profile=/.test(stderr), stderr);
    assert.match(stderr, /tip -- set TAILSCALE_PROFILE=core/);
  });
});
