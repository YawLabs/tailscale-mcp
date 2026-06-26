import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
  ["keyTools", keyTools, 5],
  ["userTools", userTools, 7],
  ["tailnetTools", tailnetTools, 5],
  ["webhookTools", webhookTools, 7],
  ["postureTools", postureTools, 5],
  ["auditTools", auditTools, 2],
  ["inviteTools", inviteTools, 11],
  ["serviceTools", serviceTools, 7],
  ["logStreamingTools", logStreamingTools, 7],
  ["localCliTools", localCliTools, 4],
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
