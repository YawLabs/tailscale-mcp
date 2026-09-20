import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { filterTools, PROFILES } from "./filter.js";
import {
  buildToolGroups,
  buildToolMeta,
  FORCED_APPROVAL_TOOLS,
  formatBannerFilterSuffix,
  formatTailnetMismatchWarning,
  isLocalCliEnabled,
  isRequireApprovalEnabled,
  LARGE_RESULT_TOOLS,
  MAX_RESULT_SIZE_CHARS,
  tailnetAclResource,
  tailnetDevicesResource,
  tailnetDnsResource,
  tailnetStatusResource,
  wrapToolHandler,
} from "./server-wiring.js";
// composeTailnetStatusData lives next to tailscale_status (its primary caller);
// server-wiring's tailnetStatusResource imports it from there too.
import { composeTailnetStatusData } from "./tools/status.js";

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

    it("!ok response with an EMPTY error string -> 'Error: Unknown error'", async () => {
      // The case above ({ok: false} with no `error` key at all) is defensive:
      // ToolLike.handler returns Promise<unknown>, so nothing in the type system
      // stops a tool from omitting it. THIS is the shape apiGet actually
      // produces on an empty-body failure -- extractErrorMessage("") returns the
      // body verbatim, so `error` is "" rather than undefined. Only the `||` in
      // wrapToolHandler catches it; swapping to `??` would ship a bare
      // "Error: " with every other test still green, and would diverge from the
      // resource fallbacks below, which use `||` for this same reason.
      // Note the floor differs by surface: wrapToolHandler has no status in its
      // response shape, so "Unknown error" is the best it can do, while the
      // resources fall back to `HTTP <status>`.
      const fakeTool = { handler: async () => ({ ok: false, error: "" }) };
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

    it("failure path -> result text is JSON {error: <the API's own message>}", async () => {
      // Pinned by VALUE, not `typeof` + non-empty: this is the only assertion
      // in the suite that the API's own error body survives the trip to the
      // client through this arm. The mutation it catches is dropping
      // `res.error` from the expression so the resource always emits
      // `HTTP ${status}` -- a typeof/length check passes under that (and the
      // empty-body sibling below asserts that constant on purpose), leaving the
      // pass-through unpinned. The two tests are complementary: this one pins
      // the message, the next one pins the fallback.
      globalThis.fetch = async () => mockFetchResponse(500, "device list boom");
      const uri = new URL("tailscale://tailnet/devices");
      const result = await tailnetDevicesResource(uri);
      const parsed = JSON.parse(result.contents[0].text);
      assert.equal(parsed.error, "device list boom");
    });

    it("failure path with EMPTY body -> error falls back to 'HTTP 500'", async () => {
      // The realistic empty-body failure: a proxy in front of api.tailscale.com
      // returning a bodiless 502/503. extractErrorMessage("") returns the body
      // verbatim, i.e. "", which is NOT nullish -- so the fallback in
      // tailnetDevicesResource has to be `||` to fire at all. Under `??` the
      // client gets `{"error":""}` with the status code dropped entirely. This
      // is what catches a `||` -> `??` swap.
      globalThis.fetch = async () => mockFetchResponse(500, "");
      const uri = new URL("tailscale://tailnet/devices");
      const result = await tailnetDevicesResource(uri);
      const parsed = JSON.parse(result.contents[0].text);
      assert.equal(parsed.error, "HTTP 500");
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

    it("failure path -> '// Error: <the API's own message>' (HuJSON-safe comment)", async () => {
      // By value rather than a `startsWith("// Error:")` prefix check, for the
      // same reason as the devices arm above: the prefix is satisfied by the
      // `HTTP ${status}` fallback alone, so dropping `res.error` from the
      // expression would not redden it (only the multi-line test below would
      // notice). The exact text also pins the single-line render -- "// "
      // prefix, no status prefix, exactly one trailing newline.
      globalThis.fetch = async () => mockFetchResponse(500, "acl fetch broken");
      const uri = new URL("tailscale://tailnet/acl");
      const result = await tailnetAclResource(uri);
      assert.equal(result.contents[0].mimeType, "application/hujson");
      assert.equal(result.contents[0].text, "// Error: acl fetch broken\n");
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

    it("rendered `data` lines are // prefixed too (HuJSON-safe)", async () => {
      // The validator is no longer the only source of multi-line errors: an
      // error body carrying a `data` array now renders per-user lines under the
      // message. Those lines go through the same `res.error` slot, so the
      // per-line prefix has to cover them -- an unprefixed "For user ..." line
      // would break a downstream tailscale_update_acl that round-trips this
      // body.
      globalThis.fetch = async () =>
        mockFetchResponse(400, {
          message: "test(s) failed",
          data: [{ user: "user1@example.com", errors: ['address "2.2.2.2:22": want: Drop, got: Accept'] }],
        });
      const uri = new URL("tailscale://tailnet/acl");
      const result = await tailnetAclResource(uri);
      const meaningfulLines = result.contents[0].text.split("\n").filter((l) => l.length > 0);
      assert.equal(meaningfulLines[0], "// Error: test(s) failed");
      for (const line of meaningfulLines) {
        assert.ok(line.startsWith("// "), `every non-empty line must start with '// ', got: ${JSON.stringify(line)}`);
      }
      assert.ok(result.contents[0].text.includes("// For user user1@example.com:"));
      assert.ok(result.contents[0].text.includes('// - address "2.2.2.2:22": want: Drop, got: Accept'));
    });

    it("failure path with EMPTY body -> '// Error: HTTP 500'", async () => {
      // Companion to the devices empty-body test: the ACL arm shares the same
      // `res.error || \`HTTP ${status}\`` fallback. extractErrorMessage("")
      // returns "" for an empty body, so under `??` this would render a bare
      // "// Error: " -- syntactically fine HuJSON that tells the reader nothing
      // about what failed. Catches a `||` -> `??` swap on the ACL arm.
      globalThis.fetch = async () => mockFetchResponse(500, "");
      const uri = new URL("tailscale://tailnet/acl");
      const result = await tailnetAclResource(uri);
      assert.equal(result.contents[0].mimeType, "application/hujson");
      assert.equal(result.contents[0].text, "// Error: HTTP 500\n");
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
      // Exact text, not just `typeof === "string"`: each slot must carry the
      // error body from its own sub-fetch. A regression that crossed the two
      // slots, or replaced the body with a generic `HTTP 500`, would still pass
      // a typeof check.
      assert.equal(data.errors.searchPaths, "search broken");
      assert.equal(data.errors.preferences, "prefs broken");
      assert.equal(data.errors.nameservers, undefined);
      assert.equal(data.errors.splitDns, undefined);
    });

    // The other half of the four hand-written slots. The two-of-four test above
    // only drives searchPaths and preferences, so the nameservers and splitDns
    // failure arms (and their `: null` data fills) never ran. One failing slot
    // at a time, with a body only that sub-fetch could have produced: a crossed
    // assignment (`errors.splitDns = nameservers.error`) parks the message under
    // the wrong DNS setting and sends the operator to the wrong config, and a
    // dropped null fill leaves the failed slot missing from the payload instead
    // of explicitly empty.
    it("only nameservers fails -> that slot null, its own body in errors, other three absent", async () => {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/dns/nameservers")) return mockFetchResponse(502, "ns broken");
        if (url.includes("/dns/searchpaths")) return mockFetchResponse(200, { searchPaths: ["example.com"] });
        if (url.includes("/dns/split-dns")) return mockFetchResponse(200, { ok: true });
        if (url.includes("/dns/preferences")) return mockFetchResponse(200, { magicDNS: true });
        return mockFetchResponse(404, "not found");
      };
      const uri = new URL("tailscale://tailnet/dns");
      const result = await tailnetDnsResource(uri);
      const data = JSON.parse(result.contents[0].text);
      assert.equal(data.nameservers, null);
      assert.deepEqual(data.searchPaths, { searchPaths: ["example.com"] });
      assert.deepEqual(data.splitDns, { ok: true });
      assert.deepEqual(data.preferences, { magicDNS: true });
      assert.ok(data.errors);
      assert.equal(data.errors.nameservers, "ns broken");
      assert.equal(data.errors.searchPaths, undefined);
      assert.equal(data.errors.splitDns, undefined);
      assert.equal(data.errors.preferences, undefined);
    });

    it("only splitDns fails -> that slot null, its own body in errors, other three absent", async () => {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/dns/nameservers")) return mockFetchResponse(200, { dns: ["1.1.1.1"] });
        if (url.includes("/dns/searchpaths")) return mockFetchResponse(200, { searchPaths: ["example.com"] });
        if (url.includes("/dns/split-dns")) return mockFetchResponse(502, "split broken");
        if (url.includes("/dns/preferences")) return mockFetchResponse(200, { magicDNS: true });
        return mockFetchResponse(404, "not found");
      };
      const uri = new URL("tailscale://tailnet/dns");
      const result = await tailnetDnsResource(uri);
      const data = JSON.parse(result.contents[0].text);
      assert.deepEqual(data.nameservers, { dns: ["1.1.1.1"] });
      assert.deepEqual(data.searchPaths, { searchPaths: ["example.com"] });
      assert.equal(data.splitDns, null);
      assert.deepEqual(data.preferences, { magicDNS: true });
      assert.ok(data.errors);
      assert.equal(data.errors.splitDns, "split broken");
      assert.equal(data.errors.nameservers, undefined);
      assert.equal(data.errors.searchPaths, undefined);
      assert.equal(data.errors.preferences, undefined);
    });

    it("failed slot with EMPTY body -> errors slot falls back to 'HTTP 500'", async () => {
      // Same empty-body case as the devices/acl tests, on tailnetDnsResource's
      // per-slot errors bag (one `||` fallback per sub-fetch). extractErrorMessage("")
      // returns "" for an empty failure body and "" is not nullish, so only the
      // falsy check names the status; under `??` the slot would hold "", which
      // reads as "this slot failed for no reason". Catches a `||` -> `??` swap.
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/dns/nameservers")) return mockFetchResponse(200, { dns: ["1.1.1.1"] });
        if (url.includes("/dns/searchpaths")) return mockFetchResponse(500, "");
        if (url.includes("/dns/split-dns")) return mockFetchResponse(200, { ok: true });
        if (url.includes("/dns/preferences")) return mockFetchResponse(200, { magicDNS: true });
        return mockFetchResponse(404, "not found");
      };
      const uri = new URL("tailscale://tailnet/dns");
      const result = await tailnetDnsResource(uri);
      const data = JSON.parse(result.contents[0].text);
      assert.equal(data.searchPaths, null);
      assert.ok(data.errors);
      assert.equal(data.errors.searchPaths, "HTTP 500");
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

  describe("composeTailnetStatusData", () => {
    // The helper is exercised end-to-end through both callers (tools/status.ts
    // and tailnetStatusResource), but the extras-precedence contract is the
    // load-bearing implementation detail. The guard is the reserved-key strip
    // at the top of composeTailnetStatusData (tools/status.ts): it destructures
    // deviceCount / settings / errors OUT of `extras` before the spread, so
    // safeExtras can never carry any of the three. Spread-then-explicit-assign
    // order is NOT the guard -- with the strip in place an order swap leaks
    // nothing, and for `errors` order was never sufficient anyway: that key is
    // assigned only when there ARE errors, so on the both-fetches-green path a
    // spread-in extras.errors would survive to the client. Deleting the strip
    // as "redundant" is the regression this pins; no caller test would notice.
    it("internal keys win over extras (the reserved-key strip is load-bearing)", () => {
      const devicesRes = {
        ok: true as const,
        status: 200,
        data: { devices: [{ id: "a" }, { id: "b" }] },
      };
      const settingsRes = { ok: true as const, status: 200, data: { magicDNS: true } };
      const data = composeTailnetStatusData(devicesRes, settingsRes, {
        // Hostile extras: every key the helper writes is also in extras.
        deviceCount: 999,
        settings: "wrong",
        errors: { phantom: "should not appear" },
        // Plus a legit extras key that should flow through.
        tailnet: "test.ts.net",
      });
      assert.equal(data.deviceCount, 2, "internal deviceCount must win over extras");
      assert.deepEqual(data.settings, { magicDNS: true }, "internal settings must win over extras");
      // Both sub-fetches succeeded, so no errors key should be present at all
      // -- the extras.errors must NOT have leaked through.
      assert.equal(data.errors, undefined, "no errors key when both fetches succeed; extras.errors must not leak");
      // Keys the helper doesn't claim flow through unchanged.
      assert.equal(data.tailnet, "test.ts.net");
    });

    it("failed response with no error string -> errors slot falls back to 'HTTP <status>'", () => {
      // The `HTTP <status>` fallback in status.ts:36-37 (which also backs
      // tailnetStatusResource) is a `||`, so it fires on BOTH a nullish error
      // and an empty-string one. This test covers the error-key-absent arm only:
      // apiGet always sets `error` on a !ok response, so that shape is
      // unreachable through fetch and has to be hand-built here. The empty-body
      // arm (extractErrorMessage("") -> "") is covered end-to-end through the
      // fetch path in handlers.test.ts, "falls back to HTTP <status> when a
      // sub-fetch fails with an empty body". A `||` -> `??` swap stays green
      // here and goes red there.
      const devicesRes = { ok: false as const, status: 500 };
      const settingsRes = { ok: false as const, status: 503 };
      const data = composeTailnetStatusData(devicesRes, settingsRes, { tailnet: "test.ts.net" });
      assert.equal(data.deviceCount, null);
      assert.equal(data.settings, null);
      const errors = data.errors as Record<string, string>;
      assert.equal(errors.devices, "HTTP 500");
      assert.equal(errors.settings, "HTTP 503");
    });
  });

  describe("buildToolGroups", () => {
    // The registry used to live inside index.ts's module body, which starts the
    // MCP server on import -- so none of this was assertable without spawning a
    // process. These are the properties index.ts silently depended on.
    it("registers the 14 always-on groups and omits local-cli by default", () => {
      const groups = buildToolGroups({});
      // "org-tailnets" and "tailnet" are distinct groups and the near-collision
      // is the point: TAILSCALE_TOOLS matches names exactly with no near-miss
      // warning, so a group literally named "tailnets" would have been one
      // typo away from handing an operator an irreversible tailnet delete.
      assert.deepEqual(Object.keys(groups).sort(), [
        "acl",
        "audit",
        "devices",
        "dns",
        "invites",
        "keys",
        "log-streaming",
        "org-tailnets",
        "posture",
        "services",
        "status",
        "tailnet",
        "users",
        "webhooks",
      ]);
      assert.ok(!("local-cli" in groups), "local-cli must be opt-in");
    });

    it("adds the local-cli group when TAILSCALE_LOCAL_CLI is on", () => {
      const groups = buildToolGroups({ TAILSCALE_LOCAL_CLI: "1" });
      assert.ok(Array.isArray(groups["local-cli"]));
      assert.ok(groups["local-cli"].length > 0);
    });

    it("gates local-cli through isLocalCliEnabled (same exact-string contract)", () => {
      // Not a loose truthiness check -- pins that the registry and the banner
      // suffix can't disagree about whether local-cli is on.
      assert.ok(!("local-cli" in buildToolGroups({ TAILSCALE_LOCAL_CLI: "yes" })));
      assert.ok(!("local-cli" in buildToolGroups({ TAILSCALE_LOCAL_CLI: "TRUE" })));
      assert.ok("local-cli" in buildToolGroups({ TAILSCALE_LOCAL_CLI: "true" }));
    });

    it("every PROFILES preset names only registered groups", () => {
      // The invariant behind unknownProfileGroups always being empty in a
      // correct build. If someone adds a group to a preset without registering
      // it -- or registers it only conditionally, like local-cli -- this fails
      // here instead of degrading to a confusing runtime warning.
      const groups = buildToolGroups({});
      for (const [profileName, presetGroups] of Object.entries(PROFILES)) {
        for (const g of presetGroups) {
          assert.ok(
            g in groups,
            `PROFILES.${profileName} references "${g}", which buildToolGroups does not register unconditionally`,
          );
        }
      }
    });

    it("returns a fresh object each call (no shared mutable registry)", () => {
      // index.ts used to mutate the literal in place to add local-cli. If the
      // object were hoisted/shared, one caller enabling local-cli would leak
      // into every later caller.
      const withCli = buildToolGroups({ TAILSCALE_LOCAL_CLI: "1" });
      const withoutCli = buildToolGroups({});
      assert.ok("local-cli" in withCli);
      assert.ok(!("local-cli" in withoutCli), "a prior local-cli build must not leak into a later one");
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

describe("formatTailnetMismatchWarning", () => {
  // TAILSCALE_OAUTH_TAILNET scopes the token to one tailnet while every other
  // tool addresses `/tailnet/${getTailnet()}/...`. Set them differently and the
  // whole surface 403s while the error text blames credentials.
  it("returns null when TAILSCALE_OAUTH_TAILNET is unset", () => {
    assert.equal(formatTailnetMismatchWarning({}), null);
    assert.equal(formatTailnetMismatchWarning({ TAILSCALE_TAILNET: "example.com" }), null);
  });

  it("returns null when TAILSCALE_TAILNET is unset, blank, or the '-' self-reference", () => {
    for (const TAILSCALE_TAILNET of [undefined, "", "   ", "-"]) {
      assert.equal(
        formatTailnetMismatchWarning({ TAILSCALE_OAUTH_TAILNET: "api-only-1", TAILSCALE_TAILNET }),
        null,
        `"${String(TAILSCALE_TAILNET)}" must not be treated as a mismatch -- "-" follows the token`,
      );
    }
  });

  it("returns null when both name the same tailnet, including with stray whitespace", () => {
    assert.equal(
      formatTailnetMismatchWarning({ TAILSCALE_OAUTH_TAILNET: " api-only-1 ", TAILSCALE_TAILNET: "api-only-1" }),
      null,
    );
  });

  it("warns and names both values when they disagree", () => {
    const msg = formatTailnetMismatchWarning({
      TAILSCALE_OAUTH_TAILNET: "api-only-1",
      TAILSCALE_TAILNET: "example.com",
    });
    assert.ok(msg, "expected a warning");
    assert.match(msg, /api-only-1/);
    assert.match(msg, /example\.com/);
    assert.match(msg, /403/);
  });
});

describe("isRequireApprovalEnabled", () => {
  // Case-sensitive "1" | "true", the same contract as isLocalCliEnabled and
  // parseReadonlyFlag. Pinned because a third spelling rule here would be the
  // kind of inconsistency an operator only discovers when the gate silently
  // does nothing.
  it("accepts exactly the two documented truthy spellings", () => {
    assert.equal(isRequireApprovalEnabled({ TAILSCALE_REQUIRE_APPROVAL: "1" }), true);
    assert.equal(isRequireApprovalEnabled({ TAILSCALE_REQUIRE_APPROVAL: "true" }), true);
  });

  it("rejects everything else, including near-misses and casing variants", () => {
    for (const value of ["", " ", "0", "false", "yes", "TRUE", "True", "on", "1 "]) {
      assert.equal(
        isRequireApprovalEnabled({ TAILSCALE_REQUIRE_APPROVAL: value }),
        false,
        `${JSON.stringify(value)} must not enable forced approval`,
      );
    }
  });

  it("defaults to off when the variable is unset", () => {
    // The load-bearing default: a client in a never-prompt mode DENIES a tool
    // carrying requiresUserInteraction, so defaulting this on would break
    // unattended agents on upgrade.
    assert.equal(isRequireApprovalEnabled({}), false);
  });
});

describe("forced-approval and large-result tool sets", () => {
  const allTools = Object.values(buildToolGroups({ TAILSCALE_LOCAL_CLI: "1" })).flat();
  const byName = new Map(allTools.map((t) => [t.name, t]));

  it("names exactly the tools this server cannot undo", () => {
    // A NAME-PINNED literal, deliberately not derived from annotations. Deriving
    // it would make this test agree with whatever destructiveHint happens to
    // say, which is precisely the drift it exists to catch -- and once
    // TAILSCALE_WRITE_POLICY treats destructiveHint as a security boundary, a
    // new tool with a missing annotation must fail a test rather than silently
    // widen a gate.
    assert.deepEqual(
      [...FORCED_APPROVAL_TOOLS],
      [
        "tailscale_delete_device",
        "tailscale_delete_key",
        "tailscale_delete_log_stream_config",
        "tailscale_delete_oauth_app",
        "tailscale_delete_posture_integration",
        "tailscale_delete_tailnet",
        "tailscale_delete_user",
        "tailscale_delete_webhook",
        "tailscale_update_acl",
      ],
      "the forced-approval set changed -- removing an entry is a breaking change for operators relying on the prompt",
    );
  });

  it("keeps both lists alphabetised so an omission is easy to spot", () => {
    for (const [label, list] of [
      ["FORCED_APPROVAL_TOOLS", FORCED_APPROVAL_TOOLS],
      ["LARGE_RESULT_TOOLS", LARGE_RESULT_TOOLS],
    ] as const) {
      assert.deepEqual([...list].sort(), [...list], `${label} must stay sorted`);
    }
  });

  it("references only tools that actually exist in the registry", () => {
    // Guards the rename case: a tool renamed in its own file would otherwise
    // leave a dead string here, silently dropping it from the gate.
    for (const name of [...FORCED_APPROVAL_TOOLS, ...LARGE_RESULT_TOOLS]) {
      assert.ok(byName.has(name), `${name} is listed but not registered`);
    }
  });

  it("forces approval only on tools already annotated destructive", () => {
    // The set is a strict subset of destructiveHint:true. If an entry here is
    // not destructive, one of the two is wrong.
    for (const name of FORCED_APPROVAL_TOOLS) {
      assert.equal(
        byName.get(name)?.annotations.destructiveHint,
        true,
        `${name} is force-approved but not annotated destructive`,
      );
    }
  });

  it("excludes reversible destructive tools, suspend_user above all", () => {
    // suspend_user has restore_user, so it fails the stated criterion (this
    // server can undo it). It was on the original shortlist; this pins the
    // decision so a later edit has to argue with the criterion, not drift past
    // it. Same for the three whose inverse also ships here.
    for (const name of [
      "tailscale_suspend_user",
      "tailscale_deauthorize_device",
      "tailscale_set_devices_authorized",
      "tailscale_delete_device_posture_attribute",
    ]) {
      assert.ok(byName.has(name), `${name} should still exist -- update this test if it was renamed`);
      assert.ok(
        !FORCED_APPROVAL_TOOLS.includes(name),
        `${name} is reversible in-server and must not be force-approved`,
      );
    }
    assert.ok(byName.has("tailscale_restore_user"), "restore_user is why suspend_user is excluded");
  });

  it("declares large results only on read-only tools", () => {
    for (const name of LARGE_RESULT_TOOLS) {
      assert.equal(
        byName.get(name)?.annotations.readOnlyHint,
        true,
        `${name} raises a result-size cap but is not read-only`,
      );
    }
  });

  it("keeps the size cap a positive integer within the client ceiling", () => {
    assert.ok(Number.isInteger(MAX_RESULT_SIZE_CHARS), "must be an integer");
    assert.ok(MAX_RESULT_SIZE_CHARS > 0, "must be positive");
    assert.ok(MAX_RESULT_SIZE_CHARS <= 500_000, "values above the client ceiling are ignored");
  });
});

describe("buildToolMeta", () => {
  const APPROVAL_KEY = "anthropic/requiresUserInteraction";
  const SIZE_KEY = "anthropic/maxResultSizeChars";

  it("omits the approval flag entirely when the gate is off", () => {
    // Not `false` -- absent. A literal false is a value the client would have
    // to interpret, and the contract is "only true means anything".
    const meta = buildToolMeta("tailscale_update_acl", { requireApproval: false });
    assert.equal(meta, undefined, "update_acl carries no other meta, so the whole object should be omitted");
  });

  it("emits the JSON boolean true when the gate is on", () => {
    const meta = buildToolMeta("tailscale_update_acl", { requireApproval: true });
    assert.deepEqual(meta, { [APPROVAL_KEY]: true });
    // Any other value is ignored client-side, so the type matters as much as
    // the presence.
    assert.equal(typeof meta?.[APPROVAL_KEY], "boolean");
  });

  it("declares the size cap regardless of the approval gate", () => {
    for (const requireApproval of [false, true]) {
      assert.equal(
        buildToolMeta("tailscale_list_devices", { requireApproval })?.[SIZE_KEY],
        MAX_RESULT_SIZE_CHARS,
        `size cap must not depend on requireApproval=${requireApproval}`,
      );
    }
  });

  it("returns undefined for a tool in neither set", () => {
    assert.equal(buildToolMeta("tailscale_get_device", { requireApproval: true }), undefined);
  });

  it("returns a fresh object per call", () => {
    // _meta reaches the SDK registry by reference and is echoed into every
    // tools/list, so a shared literal would let one mutation leak across tools.
    const a = buildToolMeta("tailscale_list_devices", { requireApproval: true });
    const b = buildToolMeta("tailscale_list_devices", { requireApproval: true });
    assert.notEqual(a, b, "must not hand out the same object twice");
    assert.deepEqual(a, b);
  });
});

describe("the write surface each TAILSCALE_WRITE_GROUPS grant hands over", () => {
  it("matches this pinned literal, per group", () => {
    // A NAME LITERAL, not derived from the annotations. Deriving it would make the
    // test agree with whatever the annotations happen to say, which is the drift it
    // exists to catch -- and the annotations are demonstrably not a security
    // predicate (update_user_role is destructiveHint:false and its role enum includes
    // "owner"; authorize_device is false while deauthorize_device is true).
    //
    // WHY THIS TEST IS THE CONTROL: a group grant is a STANDING grant over the group's
    // FUTURE contents. Adding a write tool to devices.ts widens every deployment that
    // already set TAILSCALE_WRITE_GROUPS=devices, with no operator action and no
    // upgrade prompt. This converts that into one reviewed diff line. The cost -- a
    // line per new write tool -- IS the control; do not replace it with a count.
    const groups = buildToolGroups({ TAILSCALE_LOCAL_CLI: "1" });
    const writesByGroup: Record<string, string[]> = {};
    for (const [name, tools] of Object.entries(groups)) {
      const writes = tools
        .filter((t) => t.annotations.readOnlyHint !== true)
        .map((t) => t.name)
        .sort();
      if (writes.length > 0) writesByGroup[name] = writes;
    }

    assert.deepEqual(
      writesByGroup,
      {
        acl: ["tailscale_update_acl"],
        devices: [
          "tailscale_authorize_device",
          "tailscale_batch_update_posture_attributes",
          "tailscale_deauthorize_device",
          "tailscale_delete_device",
          "tailscale_delete_device_posture_attribute",
          "tailscale_expire_device",
          "tailscale_rename_device",
          "tailscale_set_device_ip",
          "tailscale_set_device_posture_attribute",
          "tailscale_set_device_routes",
          "tailscale_set_device_tags",
          "tailscale_set_devices_authorized",
          "tailscale_update_device_key",
        ],
        dns: [
          "tailscale_set_dns_configuration",
          "tailscale_set_dns_preferences",
          "tailscale_set_nameservers",
          "tailscale_set_search_paths",
          "tailscale_set_split_dns",
          "tailscale_update_split_dns",
        ],
        invites: [
          "tailscale_accept_device_invite",
          "tailscale_create_device_invite",
          "tailscale_create_user_invite",
          "tailscale_delete_device_invite",
          "tailscale_delete_user_invite",
          "tailscale_resend_device_invite",
          "tailscale_resend_user_invite",
        ],
        keys: [
          "tailscale_create_key",
          "tailscale_create_oauth_app",
          "tailscale_delete_key",
          "tailscale_delete_oauth_app",
          "tailscale_update_key",
        ],
        "log-streaming": [
          "tailscale_create_aws_external_id",
          "tailscale_delete_log_stream_config",
          "tailscale_set_log_stream_config",
        ],
        "org-tailnets": ["tailscale_create_org_tailnet", "tailscale_delete_tailnet"],
        posture: [
          "tailscale_create_posture_integration",
          "tailscale_delete_posture_integration",
          "tailscale_update_posture_integration",
        ],
        services: ["tailscale_delete_service", "tailscale_set_service_device_approval", "tailscale_update_service"],
        tailnet: [
          "tailscale_resend_contact_verification",
          "tailscale_set_contacts",
          "tailscale_update_tailnet_settings",
        ],
        users: [
          "tailscale_approve_user",
          "tailscale_delete_user",
          "tailscale_restore_user",
          "tailscale_suspend_user",
          "tailscale_update_user_role",
        ],
        webhooks: [
          "tailscale_create_webhook",
          "tailscale_delete_webhook",
          "tailscale_rotate_webhook_secret",
          "tailscale_test_webhook",
          "tailscale_update_webhook",
        ],
      },
      "the write surface a grant hands an agent changed -- adding a write tool to a group widens every deployment that already granted it",
    );
  });

  it("leaves the opt-in local-cli group with no writes, so it needs no grant", () => {
    const groups = buildToolGroups({ TAILSCALE_LOCAL_CLI: "1" });
    const localCliWrites = (groups["local-cli"] ?? []).filter((t) => t.annotations.readOnlyHint !== true);
    assert.deepEqual(
      localCliWrites,
      [],
      "every local-CLI diagnostic is a read; a write here would need a tier decision",
    );
  });

  it("names every admin-equivalent group in the registry", () => {
    // index.ts warns when a grant includes keys, users or acl. If a future group
    // becomes admin-equivalent, this is where that gets noticed: the three named
    // here are the ones whose writes mint credentials, promote to owner, or rewrite
    // policy for every principal.
    const groups = buildToolGroups({});
    for (const name of ["keys", "users", "acl"]) {
      assert.ok(groups[name], `${name} must exist for the admin-equivalence warning to fire`);
    }
  });
});

describe("formatBannerFilterSuffix write-gate rendering", () => {
  const base = {
    unknownProfile: undefined,
    explicitTools: undefined,
    profileWouldFilter: undefined,
    profileEnv: undefined,
    readonlyMode: false,
    localCliEnabled: false,
  };

  it("renders the granted groups", () => {
    assert.equal(formatBannerFilterSuffix({ ...base, writeGroups: ["devices", "keys"] }), "write=devices,keys");
  });

  it("distinguishes a configured-but-empty grant from an unset knob", () => {
    // `write=none` is a deliberate lockdown; no segment at all is today's default.
    // An operator debugging "why can it not write" needs to tell those apart.
    assert.equal(formatBannerFilterSuffix({ ...base, writeGroups: [] }), "write=none");
    assert.equal(formatBannerFilterSuffix({ ...base, writeGroups: undefined }), "");
  });

  it("names readonly as the cause when it overrode a grant", () => {
    assert.equal(
      formatBannerFilterSuffix({
        ...base,
        readonlyMode: true,
        writeGroups: [],
        writeGroupsOverriddenByReadonly: true,
      }),
      "readonly (TAILSCALE_WRITE_GROUPS ignored), write=none",
    );
  });

  it("keeps the bare readonly wording when no grant was overridden", () => {
    assert.equal(formatBannerFilterSuffix({ ...base, readonlyMode: true }), "readonly");
  });

  it("composes with the group and profile segments", () => {
    assert.equal(
      formatBannerFilterSuffix({
        ...base,
        profileEnv: "core",
        profileWouldFilter: true,
        writeGroups: ["devices"],
        localCliEnabled: true,
      }),
      "profile=core, write=devices, local-cli=on",
    );
  });
});

describe("conditionally-registered groups", () => {
  it("registers exactly one group behind an opt-in, so the not-enabled remedy stays correct", () => {
    // A TRIPWIRE, not a repair. index.ts DERIVES the not-enabled set (diff the default
    // registry against one built with every opt-in on) but its remedy sentence
    // hardcodes "Set TAILSCALE_LOCAL_CLI=1". A second conditional group would be
    // DETECTED correctly and then handed the WRONG FIX -- and the comment there claims
    // such a group is "covered without touching this branch", which is only half true.
    // If this goes red, that message needs to name the right variable per group.
    const withOptIns = Object.keys(buildToolGroups({ TAILSCALE_LOCAL_CLI: "1" }));
    const byDefault = Object.keys(buildToolGroups({}));
    assert.deepEqual(
      withOptIns.filter((g) => !byDefault.includes(g)),
      ["local-cli"],
      "a new opt-in group needs its own remedy text in index.ts's not-enabled warning",
    );
  });

  it("treats a granted local-cli as a legal no-op once the opt-in is on", () => {
    // The mirror of the not-enabled branch: same group name, opposite message. The
    // condition choosing between "not enabled" and "fine, nothing to do" is the only
    // thing separating a helpful diagnostic from a wrong one.
    const groups = buildToolGroups({ TAILSCALE_LOCAL_CLI: "1" });
    const r = filterTools(groups, { writeGroups: "local-cli" });
    assert.deepEqual(r.writeGroups, ["local-cli"], "a real, loaded group -- the grant applies");
    assert.equal(r.unknownWriteGroups, undefined, "not a typo once the opt-in is on");
    assert.equal(r.writeGroupsNotLoaded, undefined, "it loaded");
    assert.deepEqual(
      r.tools.filter((t) => t.annotations.readOnlyHint !== true),
      [],
      "every local-CLI diagnostic is a read, so the grant serves no writes",
    );
  });
});
