import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  formatBannerFilterSuffix,
  isLocalCliEnabled,
  tailnetAclResource,
  tailnetDevicesResource,
  tailnetDnsResource,
  tailnetStatusResource,
  wrapToolHandler,
} from "./server-wiring.js";

function mockFetchResponse(status: number, body: unknown, headers?: Record<string, string>) {
  const responseHeaders = new Headers(headers);
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: responseHeaders });
}

type WrapResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

describe("server-wiring", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    delete process.env.TAILSCALE_OAUTH_CLIENT_ID;
    delete process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
    process.env.TAILSCALE_TAILNET = "test.ts.net";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  describe("wrapToolHandler", () => {
    it("ok response with data -> pretty-JSON content, no isError", async () => {
      const fakeTool = { handler: async () => ({ ok: true, data: { x: 1 } }) };
      const result = (await wrapToolHandler(fakeTool)({})) as WrapResult;
      assert.equal(result.isError, undefined);
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, "text");
      assert.deepEqual(JSON.parse(result.content[0].text), { x: 1 });
    });

    it("ok response with rawBody -> text equals rawBody (rawBody preferred over data)", async () => {
      const fakeTool = { handler: async () => ({ ok: true, rawBody: "raw text", data: { ignored: true } }) };
      const result = (await wrapToolHandler(fakeTool)({})) as WrapResult;
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].text, "raw text");
    });

    it("ok response with neither data nor rawBody -> {success: true} pretty JSON", async () => {
      const fakeTool = { handler: async () => ({ ok: true }) };
      const result = (await wrapToolHandler(fakeTool)({})) as WrapResult;
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].text, JSON.stringify({ success: true }, null, 2));
    });

    it("!ok response with error -> isError true and 'Error: <msg>'", async () => {
      const fakeTool = { handler: async () => ({ ok: false, error: "boom" }) };
      const result = (await wrapToolHandler(fakeTool)({})) as WrapResult;
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Error: boom");
    });

    it("!ok response with no error string -> 'Error: Unknown error'", async () => {
      const fakeTool = { handler: async () => ({ ok: false }) };
      const result = (await wrapToolHandler(fakeTool)({})) as WrapResult;
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Error: Unknown error");
    });

    it("handler throws Error -> isError true and 'Error: <message>'", async () => {
      const fakeTool = {
        handler: async () => {
          throw new Error("crash");
        },
      };
      const result = (await wrapToolHandler(fakeTool)({})) as WrapResult;
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Error: crash");
    });

    it("handler throws non-Error -> stringified value in 'Error: ...'", async () => {
      const fakeTool = {
        handler: async () => {
          throw "string failure";
        },
      };
      const result = (await wrapToolHandler(fakeTool)({})) as WrapResult;
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Error: string failure");
    });
  });

  describe("tailnetStatusResource", () => {
    it("both sub-fetches ok -> tailnet, deviceCount, settings; no errors key", async () => {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/devices")) return mockFetchResponse(200, { devices: [{ id: "a" }, { id: "b" }] });
        if (url.includes("/settings")) return mockFetchResponse(200, { x: 1 });
        return mockFetchResponse(404, "not found");
      };
      const uri = new URL("tailscale://tailnet/status");
      const result = await tailnetStatusResource(uri);
      assert.equal(result.contents[0].uri, uri.href);
      assert.equal(result.contents[0].mimeType, "application/json");
      const data = JSON.parse(result.contents[0].text);
      assert.equal(data.tailnet, "test.ts.net");
      assert.equal(data.deviceCount, 2);
      assert.deepEqual(data.settings, { x: 1 });
      assert.equal(data.errors, undefined);
    });

    it("devices fail, settings ok -> deviceCount null with errors.devices populated", async () => {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/devices")) return mockFetchResponse(500, "device boom");
        if (url.includes("/settings")) return mockFetchResponse(200, { x: 1 });
        return mockFetchResponse(404, "not found");
      };
      const uri = new URL("tailscale://tailnet/status");
      const result = await tailnetStatusResource(uri);
      const data = JSON.parse(result.contents[0].text);
      assert.equal(data.deviceCount, null);
      assert.deepEqual(data.settings, { x: 1 });
      assert.ok(data.errors);
      assert.equal(typeof data.errors.devices, "string");
      assert.ok(data.errors.devices.length > 0);
      assert.equal(data.errors.settings, undefined);
    });

    it("both fail -> both null and both errors keys present", async () => {
      globalThis.fetch = async () => mockFetchResponse(500, "all broken");
      const uri = new URL("tailscale://tailnet/status");
      const result = await tailnetStatusResource(uri);
      const data = JSON.parse(result.contents[0].text);
      assert.equal(data.deviceCount, null);
      assert.equal(data.settings, null);
      assert.ok(data.errors);
      assert.equal(typeof data.errors.devices, "string");
      assert.equal(typeof data.errors.settings, "string");
    });

    it("devices call succeeds with no devices array -> deviceCount:null, no errors entry", async () => {
      // Mirrors the equivalent test on tools/status.ts. Both resources got the
      // `?? null` (not `?? 0`) change at the same time; without this case the
      // server-wiring version could quietly regress to reporting "0 devices"
      // when the body shape is unexpected (204, surrogate-cached empty, etc.)
      // and the tools/status.ts test wouldn't catch it.
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/devices")) {
          return mockFetchResponse(200, { somethingElse: true });
        }
        return mockFetchResponse(200, { x: 1 });
      };
      const uri = new URL("tailscale://tailnet/status");
      const result = await tailnetStatusResource(uri);
      const data = JSON.parse(result.contents[0].text);
      assert.equal(data.deviceCount, null);
      assert.deepEqual(data.settings, { x: 1 });
      // The devices call succeeded -- it just had an unexpected body. No
      // errors entry should appear; that's reserved for actually-failed calls.
      assert.equal(data.errors, undefined);
    });
  });

  describe("tailnetDevicesResource", () => {
    it("ok path -> result text is the devices payload as JSON", async () => {
      const payload = { devices: [{ id: "x" }, { id: "y" }] };
      globalThis.fetch = async () => mockFetchResponse(200, payload);
      const uri = new URL("tailscale://tailnet/devices");
      const result = await tailnetDevicesResource(uri);
      assert.equal(result.contents[0].uri, uri.href);
      assert.equal(result.contents[0].mimeType, "application/json");
      assert.deepEqual(JSON.parse(result.contents[0].text), payload);
    });

    it("failure path -> result text is JSON {error: ...}", async () => {
      globalThis.fetch = async () => mockFetchResponse(500, "device list boom");
      const uri = new URL("tailscale://tailnet/devices");
      const result = await tailnetDevicesResource(uri);
      const parsed = JSON.parse(result.contents[0].text);
      assert.equal(typeof parsed.error, "string");
      assert.ok(parsed.error.length > 0);
    });
  });

  describe("tailnetAclResource", () => {
    it("ok path -> rawBody as text and HuJSON mimeType", async () => {
      const raw = "// my acl\n{\n  acls: [],\n}\n";
      globalThis.fetch = async () => mockFetchResponse(200, raw, { etag: '"abc"' });
      const uri = new URL("tailscale://tailnet/acl");
      const result = await tailnetAclResource(uri);
      assert.equal(result.contents[0].uri, uri.href);
      assert.equal(result.contents[0].mimeType, "application/hujson");
      assert.equal(result.contents[0].text, raw);
    });

    it("failure path -> text starts with '// Error:' (HuJSON-safe comment)", async () => {
      globalThis.fetch = async () => mockFetchResponse(500, "acl fetch broken");
      const uri = new URL("tailscale://tailnet/acl");
      const result = await tailnetAclResource(uri);
      assert.equal(result.contents[0].mimeType, "application/hujson");
      assert.ok(
        result.contents[0].text.startsWith("// Error:"),
        `expected '// Error:' prefix, got: ${result.contents[0].text}`,
      );
    });

    it("multi-line API error -> every line is // prefixed (HuJSON-safe)", async () => {
      // The Tailscale HuJSON validator returns multi-line errors. Without the
      // per-line // prefix, lines 2+ would land outside the comment and break
      // any downstream tailscale_update_acl that round-trips the rawBody.
      const multiLineMsg = "acl rule 0 invalid:\n  dst tag :foo not defined\n  src group :bar not defined";
      globalThis.fetch = async () => mockFetchResponse(400, { message: multiLineMsg });
      const uri = new URL("tailscale://tailnet/acl");
      const result = await tailnetAclResource(uri);
      const lines = result.contents[0].text.split("\n");
      // The body ends with a trailing newline, producing an empty final segment.
      // Every other line must be a HuJSON line-comment.
      const meaningfulLines = lines.filter((l) => l.length > 0);
      assert.ok(meaningfulLines.length >= 3, `expected >= 3 lines, got: ${JSON.stringify(lines)}`);
      for (const line of meaningfulLines) {
        assert.ok(line.startsWith("// "), `every non-empty line must start with '// ', got: ${JSON.stringify(line)}`);
      }
      // Spot-check the content survived the prefixing intact.
      assert.ok(result.contents[0].text.includes("dst tag :foo not defined"));
      assert.ok(result.contents[0].text.includes("src group :bar not defined"));
    });
  });

  describe("tailnetDnsResource", () => {
    it("all four sub-fetches ok -> all keys present, no errors", async () => {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/dns/nameservers")) return mockFetchResponse(200, { dns: ["1.1.1.1"] });
        if (url.includes("/dns/searchpaths")) return mockFetchResponse(200, { searchPaths: ["example.com"] });
        if (url.includes("/dns/split-dns")) return mockFetchResponse(200, { "internal.example": ["10.0.0.1"] });
        if (url.includes("/dns/preferences")) return mockFetchResponse(200, { magicDNS: true });
        return mockFetchResponse(404, "not found");
      };
      const uri = new URL("tailscale://tailnet/dns");
      const result = await tailnetDnsResource(uri);
      assert.equal(result.contents[0].uri, uri.href);
      assert.equal(result.contents[0].mimeType, "application/json");
      const data = JSON.parse(result.contents[0].text);
      assert.deepEqual(data.nameservers, { dns: ["1.1.1.1"] });
      assert.deepEqual(data.searchPaths, { searchPaths: ["example.com"] });
      assert.deepEqual(data.splitDns, { "internal.example": ["10.0.0.1"] });
      assert.deepEqual(data.preferences, { magicDNS: true });
      assert.equal(data.errors, undefined);
    });

    it("two of four fail -> failed slots null and errors composed for each failure", async () => {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/dns/nameservers")) return mockFetchResponse(200, { dns: ["1.1.1.1"] });
        if (url.includes("/dns/searchpaths")) return mockFetchResponse(500, "search broken");
        if (url.includes("/dns/split-dns")) return mockFetchResponse(200, { ok: true });
        if (url.includes("/dns/preferences")) return mockFetchResponse(500, "prefs broken");
        return mockFetchResponse(404, "not found");
      };
      const uri = new URL("tailscale://tailnet/dns");
      const result = await tailnetDnsResource(uri);
      const data = JSON.parse(result.contents[0].text);
      assert.deepEqual(data.nameservers, { dns: ["1.1.1.1"] });
      assert.equal(data.searchPaths, null);
      assert.deepEqual(data.splitDns, { ok: true });
      assert.equal(data.preferences, null);
      assert.ok(data.errors);
      assert.equal(typeof data.errors.searchPaths, "string");
      assert.equal(typeof data.errors.preferences, "string");
      assert.equal(data.errors.nameservers, undefined);
      assert.equal(data.errors.splitDns, undefined);
    });
  });

  describe("formatBannerFilterSuffix", () => {
    // The startup banner in index.ts is the operator's first signal when
    // debugging "why is my tool count different than I expected." Exercising
    // the four-case profile/tools matrix here (rather than spawning the
    // server) catches regressions to the precedence labelling without the
    // overhead of an integration harness.
    const base = {
      unknownProfile: undefined,
      explicitTools: undefined,
      profileWouldFilter: undefined,
      profileEnv: undefined,
      readonlyMode: false,
      localCliEnabled: false,
    } as const;

    it("returns the empty string when nothing is configured", () => {
      assert.equal(formatBannerFilterSuffix({ ...base }), "");
    });

    it("profile=core alone -> 'profile=core' (no overridden marker)", () => {
      assert.equal(formatBannerFilterSuffix({ ...base, profileEnv: "core", profileWouldFilter: true }), "profile=core");
    });

    it("profile=full alone -> 'profile=full' (substantive=false, no marker)", () => {
      // `full` is a valid profile with an empty preset; the banner should
      // confirm the env var was seen, but not pretend it's filtering.
      assert.equal(
        formatBannerFilterSuffix({ ...base, profileEnv: "full", profileWouldFilter: undefined }),
        "profile=full",
      );
    });

    it("tools=foo alone -> 'groups=foo' (uses the parsed explicitTools, not env)", () => {
      assert.equal(formatBannerFilterSuffix({ ...base, explicitTools: ["foo"] }), "groups=foo");
    });

    it("tools with multiple groups joins on ',' without raw whitespace", () => {
      // explicitTools is the post-trim form; verify the banner shows that
      // rather than echoing whatever spacing the user typed.
      assert.equal(formatBannerFilterSuffix({ ...base, explicitTools: ["devices", "acl"] }), "groups=devices,acl");
    });

    it("profile=core + tools=foo -> '(overridden by TAILSCALE_TOOLS)' on the substantive profile", () => {
      assert.equal(
        formatBannerFilterSuffix({
          ...base,
          profileEnv: "core",
          profileWouldFilter: true,
          explicitTools: ["foo"],
        }),
        "profile=core (overridden by TAILSCALE_TOOLS), groups=foo",
      );
    });

    it("profile=full + tools=foo -> NO overridden marker (nothing substantive was overridden)", () => {
      // The whole reason profileWouldFilter exists. Regressions here would
      // bring back the misleading 'profile=full (overridden)' wording.
      assert.equal(
        formatBannerFilterSuffix({
          ...base,
          profileEnv: "full",
          profileWouldFilter: undefined,
          explicitTools: ["foo"],
        }),
        "profile=full, groups=foo",
      );
    });

    it("invalid profile (unknownProfile set) -> profile segment omitted entirely", () => {
      assert.equal(
        formatBannerFilterSuffix({
          ...base,
          profileEnv: "bogus",
          unknownProfile: "bogus",
        }),
        "",
      );
      // The separate console.error in index.ts handles the user-facing
      // diagnostic for the invalid profile; the banner just stays quiet.
    });

    it("readonlyMode alone -> 'readonly'", () => {
      assert.equal(formatBannerFilterSuffix({ ...base, readonlyMode: true }), "readonly");
    });

    it("localCliEnabled alone -> 'local-cli=on'", () => {
      assert.equal(formatBannerFilterSuffix({ ...base, localCliEnabled: true }), "local-cli=on");
    });

    it("all toggles set together -> stable comma-separated order", () => {
      // Pin the segment order so a future refactor of the segment list can't
      // silently shuffle the banner.
      assert.equal(
        formatBannerFilterSuffix({
          profileEnv: "core",
          profileWouldFilter: true,
          unknownProfile: undefined,
          explicitTools: ["foo", "bar"],
          readonlyMode: true,
          localCliEnabled: true,
        }),
        "profile=core (overridden by TAILSCALE_TOOLS), groups=foo,bar, readonly, local-cli=on",
      );
    });

    it("does not show 'overridden' marker when profile is substantive but no explicit tools were set", () => {
      // Defensive: profileWouldFilter=true alone must NOT trigger the marker.
      assert.equal(
        formatBannerFilterSuffix({
          ...base,
          profileEnv: "minimal",
          profileWouldFilter: true,
          explicitTools: undefined,
        }),
        "profile=minimal",
      );
    });
  });

  describe("isLocalCliEnabled", () => {
    // index.ts gates the local-cli tool group on this predicate AND uses it
    // to drive the startup banner's `local-cli=on` suffix. Pinning the
    // contract here means a refactor that loosens or breaks the gate
    // (e.g. renaming the env var, accepting unrelated truthy values) gets
    // caught by tests instead of by a downstream user wondering why their
    // tool count dropped.
    it("returns true for '1'", () => {
      assert.equal(isLocalCliEnabled({ TAILSCALE_LOCAL_CLI: "1" }), true);
    });
    it("returns true for 'true'", () => {
      assert.equal(isLocalCliEnabled({ TAILSCALE_LOCAL_CLI: "true" }), true);
    });
    it("returns false when the env var is unset", () => {
      assert.equal(isLocalCliEnabled({}), false);
    });
    it("returns false for the empty string", () => {
      assert.equal(isLocalCliEnabled({ TAILSCALE_LOCAL_CLI: "" }), false);
    });
    it("returns false for '0'", () => {
      assert.equal(isLocalCliEnabled({ TAILSCALE_LOCAL_CLI: "0" }), false);
    });
    it("returns false for 'false'", () => {
      assert.equal(isLocalCliEnabled({ TAILSCALE_LOCAL_CLI: "false" }), false);
    });
    it("is case-sensitive: 'TRUE' / 'True' / 'YES' do not enable", () => {
      // Documenting the contract explicitly: matches TAILSCALE_READONLY's
      // exact-string handling, so users who set both follow the same rule.
      assert.equal(isLocalCliEnabled({ TAILSCALE_LOCAL_CLI: "TRUE" }), false);
      assert.equal(isLocalCliEnabled({ TAILSCALE_LOCAL_CLI: "True" }), false);
      assert.equal(isLocalCliEnabled({ TAILSCALE_LOCAL_CLI: "yes" }), false);
    });
    it("returns false for unrelated truthy-looking values", () => {
      assert.equal(isLocalCliEnabled({ TAILSCALE_LOCAL_CLI: "on" }), false);
      assert.equal(isLocalCliEnabled({ TAILSCALE_LOCAL_CLI: "enabled" }), false);
    });
  });
});
