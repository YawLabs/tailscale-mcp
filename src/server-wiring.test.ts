import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
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
});
