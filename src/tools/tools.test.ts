import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aclTools } from "./acl.js";
import { auditTools } from "./audit.js";
import { deviceTools } from "./devices.js";
import { dnsTools } from "./dns.js";
import { inviteTools } from "./invites.js";
import { keyTools } from "./keys.js";
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
];

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
    assert.equal(allTools.length, 89);
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
  it("statusTools has 1 tool", () => assert.equal(statusTools.length, 1));
  it("deviceTools has 17 tools", () => assert.equal(deviceTools.length, 17));
  it("aclTools has 4 tools", () => assert.equal(aclTools.length, 4));
  it("dnsTools has 11 tools", () => assert.equal(dnsTools.length, 11));
  it("keyTools has 5 tools", () => assert.equal(keyTools.length, 5));
  it("userTools has 7 tools", () => assert.equal(userTools.length, 7));
  it("tailnetTools has 5 tools", () => assert.equal(tailnetTools.length, 5));
  it("webhookTools has 7 tools", () => assert.equal(webhookTools.length, 7));
  it("postureTools has 5 tools", () => assert.equal(postureTools.length, 5));
  it("auditTools has 2 tools", () => assert.equal(auditTools.length, 2));
  it("inviteTools has 11 tools", () => assert.equal(inviteTools.length, 11));
  it("serviceTools has 7 tools", () => assert.equal(serviceTools.length, 7));
  it("logStreamingTools has 7 tools", () => assert.equal(logStreamingTools.length, 7));
});
