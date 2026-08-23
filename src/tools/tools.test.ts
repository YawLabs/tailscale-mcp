import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { aclTools } from "./acl.js";
import { auditTools } from "./audit.js";
import { deviceTools } from "./devices.js";
import { dnsTools } from "./dns.js";
import { inviteTools } from "./invites.js";
import { keyTools } from "./keys.js";
import { localCliTools } from "./local-cli.js";
import { logStreamingTools } from "./log-streaming.js";
import { postureTools } from "./posture.js";
import { serviceTools } from "./services.js";
import { statusTools } from "./status.js";
import { tailnetTools } from "./tailnet.js";
import { tailnetsTools } from "./tailnets.js";
import { userTools } from "./users.js";
import { webhookTools } from "./webhooks.js";

const allTools = [
  ...statusTools,
  ...deviceTools,
  ...aclTools,
  ...dnsTools,
  ...keyTools,
  ...userTools,
  ...tailnetTools,
  ...tailnetsTools,
  ...webhookTools,
  ...postureTools,
  ...auditTools,
  ...inviteTools,
  ...serviceTools,
  ...logStreamingTools,
  ...localCliTools,
];

// Single source of truth for per-module tool counts. The total is derived from
// these, so adding a tool only requires bumping the one module's number here --
// the per-module assertions below and the total assertion both read from this.
const EXPECTED_MODULE_COUNTS: Array<[string, ReadonlyArray<unknown>, number]> = [
  ["statusTools", statusTools, 1],
  ["deviceTools", deviceTools, 17],
  ["aclTools", aclTools, 4],
  ["dnsTools", dnsTools, 11],
  ["keyTools", keyTools, 7],
  ["userTools", userTools, 7],
  ["tailnetTools", tailnetTools, 5],
  ["tailnetsTools", tailnetsTools, 3],
  ["webhookTools", webhookTools, 7],
  ["postureTools", postureTools, 5],
  ["auditTools", auditTools, 2],
  ["inviteTools", inviteTools, 11],
  ["serviceTools", serviceTools, 7],
  ["logStreamingTools", logStreamingTools, 7],
  ["localCliTools", localCliTools, 6],
];

const EXPECTED_TOTAL = EXPECTED_MODULE_COUNTS.reduce((sum, [, , count]) => sum + count, 0);

describe("Tool definitions", () => {
  it("should have no duplicate tool names", () => {
    const names = allTools.map((t) => t.name);
    const unique = new Set(names);
    assert.equal(
      names.length,
      unique.size,
      `Duplicate tool names found: ${names.filter((n, i) => names.indexOf(n) !== i)}`,
    );
  });

  it("should have the expected total tool count", () => {
    // Derived from EXPECTED_MODULE_COUNTS so a new tool only needs one number bumped.
    assert.equal(allTools.length, EXPECTED_TOTAL);
  });

  for (const tool of allTools) {
    describe(tool.name, () => {
      it("should have a non-empty name", () => {
        assert.ok(tool.name.length > 0);
      });

      it("should have a name prefixed with tailscale_", () => {
        assert.ok(tool.name.startsWith("tailscale_"), `Tool name ${tool.name} should start with tailscale_`);
      });

      it("should have a non-empty description", () => {
        assert.ok(tool.description.length > 0);
      });

      it("should have a Zod input schema", () => {
        assert.ok(tool.inputSchema);
        assert.ok(typeof tool.inputSchema.shape === "object");
      });

      it("should have an async handler function", () => {
        assert.equal(typeof tool.handler, "function");
      });

      it("should have annotations with required hints", () => {
        assert.ok(tool.annotations, `Tool ${tool.name} is missing annotations`);
        assert.equal(typeof tool.annotations.readOnlyHint, "boolean", `Tool ${tool.name} missing readOnlyHint`);
        assert.equal(typeof tool.annotations.destructiveHint, "boolean", `Tool ${tool.name} missing destructiveHint`);
        assert.equal(typeof tool.annotations.idempotentHint, "boolean", `Tool ${tool.name} missing idempotentHint`);
        assert.equal(typeof tool.annotations.openWorldHint, "boolean", `Tool ${tool.name} missing openWorldHint`);
      });
    });
  }
});

describe("Tool modules export correct counts", () => {
  for (const [moduleName, tools, expected] of EXPECTED_MODULE_COUNTS) {
    it(`${moduleName} has ${expected} tool${expected === 1 ? "" : "s"}`, () => assert.equal(tools.length, expected));
  }

  it("per-module counts sum to the total tool count", () => {
    assert.equal(allTools.length, EXPECTED_TOTAL);
  });
});

describe("JSON Schema exposed to MCP clients", () => {
  // These fields use z.string().superRefine(...) rather than z.enum so the
  // allowed set can be extended at runtime via env. That swap silently DROPPED
  // the `enum` array from the generated JSON Schema, leaving `{"type":"string"}`
  // with the valid values only in prose -- losing constrained decoding and any
  // enum-rendering UI. `.meta({ enum })` puts it back; these pin that it stays.
  function schemaFor(tools: ReadonlyArray<{ name: string; inputSchema: unknown }>, name: string) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    const shape = (tool.inputSchema as { shape: z.ZodRawShape }).shape;
    return z.toJSONSchema(z.object(shape), { io: "input", unrepresentable: "any" }) as {
      properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
    };
  }

  it("advertises every posture provider as an enum, not just prose", () => {
    const provider = schemaFor(postureTools, "tailscale_create_posture_integration").properties.provider;
    assert.deepEqual(provider.enum, [
      "falcon",
      "fleet",
      "huntress",
      "intune",
      "jamfpro",
      "kandji",
      "kolide",
      "sentinelone",
    ]);
  });

  it("advertises the webhook event catalog as an enum on the array items", () => {
    const subs = schemaFor(webhookTools, "tailscale_create_webhook").properties.subscriptions;
    assert.ok(subs.items?.enum, "subscriptions items must carry an enum");
    assert.equal(subs.items.enum.length, 18);
    assert.ok(subs.items.enum.includes("nodeCreated"));
    // Always-on/undisableable events must stay OUT of the subscribable set.
    for (const excluded of ["test", "webhookDeleted", "webhookUpdated"]) {
      assert.ok(!subs.items.enum.includes(excluded), `${excluded} is not subscribable`);
    }
  });
});

describe("advertised enum vs runtime check", () => {
  // The JSON Schema enum is resolved at MODULE LOAD, while superRefine re-reads
  // env per call. A server started WITHOUT TAILSCALE_EXTRA_POSTURE_PROVIDERS
  // therefore advertises 8 providers but accepts 9 once the var appears -- a
  // strict client validating against the schema would refuse to send a request
  // the server would have honoured. Pinning the intended behaviour: the enum
  // must reflect the env as it stood at load, extras included.
  it("includes TAILSCALE_EXTRA_POSTURE_PROVIDERS in the advertised enum when set at load", async () => {
    const previous = process.env.TAILSCALE_EXTRA_POSTURE_PROVIDERS;
    process.env.TAILSCALE_EXTRA_POSTURE_PROVIDERS = "brandnewedr";
    try {
      // Cache-busting query so the module re-evaluates and re-reads env; a plain
      // import would return the instance already loaded by the suite above.
      // Built as a variable so TypeScript does not try to resolve the
      // query-suffixed specifier at compile time; the query is what busts
      // Node's ESM module cache at runtime.
      const specifier = "./posture.js?enumcase=1";
      const fresh = (await import(specifier)) as {
        postureTools: ReadonlyArray<{ name: string; inputSchema: { shape: z.ZodRawShape } }>;
      };
      const tool = fresh.postureTools.find((t) => t.name === "tailscale_create_posture_integration");
      assert.ok(tool, "tool not found in freshly-loaded module");
      const js = z.toJSONSchema(z.object(tool.inputSchema.shape), {
        io: "input",
        unrepresentable: "any",
      }) as unknown as { properties: { provider: { enum?: string[] } } };
      assert.ok(
        js.properties.provider.enum?.includes("brandnewedr"),
        `advertised enum must include the configured extra, got: ${JSON.stringify(js.properties.provider.enum)}`,
      );
      // The static set must still be there alongside the extra.
      assert.ok(js.properties.provider.enum?.includes("falcon"));
    } finally {
      if (previous === undefined) delete process.env.TAILSCALE_EXTRA_POSTURE_PROVIDERS;
      else process.env.TAILSCALE_EXTRA_POSTURE_PROVIDERS = previous;
    }
  });
});
