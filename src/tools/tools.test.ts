import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aclTools } from "./acl.js";
import { auditTools } from "./audit.js";
import { deviceTools } from "./devices.js";
import { dnsTools } from "./dns.js";
import { inviteTools } from "./invites.js";
import { keyTools } from "./keys.js";
import { logStreamingTools } from "./log-streaming.js";
import { networkLockTools } from "./network-lock.js";
import { oauthClientTools } from "./oauth-clients.js";
import { postureTools } from "./posture.js";
import { serviceTools } from "./services.js";
import { statusTools } from "./status.js";
import { tailnetTools } from "./tailnet.js";
import { userTools } from "./users.js";
import { webhookTools } from "./webhooks.js";
import { workloadIdentityTools } from "./workload-identity.js";

const allTools = [
  ...statusTools,
  ...deviceTools,
  ...aclTools,
  ...dnsTools,
  ...keyTools,
  ...userTools,
  ...tailnetTools,
  ...webhookTools,
  ...networkLockTools,
  ...postureTools,
  ...auditTools,
  ...inviteTools,
  ...serviceTools,
  ...logStreamingTools,
  ...workloadIdentityTools,
  ...oauthClientTools,
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
    assert.equal(allTools.length, 81);
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
  it("deviceTools has 13 tools", () => assert.equal(deviceTools.length, 13));
  it("aclTools has 4 tools", () => assert.equal(aclTools.length, 4));
  it("dnsTools has 8 tools", () => assert.equal(dnsTools.length, 8));
  it("keyTools has 4 tools", () => assert.equal(keyTools.length, 4));
  it("userTools has 6 tools", () => assert.equal(userTools.length, 6));
  it("tailnetTools has 4 tools", () => assert.equal(tailnetTools.length, 4));
  it("webhookTools has 6 tools", () => assert.equal(webhookTools.length, 6));
  it("networkLockTools has 1 tool", () => assert.equal(networkLockTools.length, 1));
  it("postureTools has 5 tools", () => assert.equal(postureTools.length, 5));
  it("auditTools has 2 tools", () => assert.equal(auditTools.length, 2));
  it("inviteTools has 8 tools", () => assert.equal(inviteTools.length, 8));
  it("serviceTools has 5 tools", () => assert.equal(serviceTools.length, 5));
  it("logStreamingTools has 4 tools", () => assert.equal(logStreamingTools.length, 4));
  it("workloadIdentityTools has 5 tools", () => assert.equal(workloadIdentityTools.length, 5));
  it("oauthClientTools has 5 tools", () => assert.equal(oauthClientTools.length, 5));
});
