#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { deviceTools } from "./tools/devices.js";
import { aclTools } from "./tools/acl.js";
import { dnsTools } from "./tools/dns.js";
import { keyTools } from "./tools/keys.js";
import { userTools } from "./tools/users.js";
import { tailnetTools } from "./tools/tailnet.js";
import { webhookTools } from "./tools/webhooks.js";
import { networkLockTools } from "./tools/network-lock.js";
import { postureTools } from "./tools/posture.js";
import { auditTools } from "./tools/audit.js";
import { statusTools } from "./tools/status.js";

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
];

const server = new McpServer({
  name: "@yawlabs/tailscale-mcp",
  version: "0.1.3",
});

for (const tool of allTools) {
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema.shape,
    async (input: Record<string, unknown>) => {
      try {
        const result = await (tool.handler as (input: unknown) => Promise<unknown>)(input);
        const response = result as { ok: boolean; data?: unknown; error?: string; rawBody?: string };

        if (!response.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${response.error || "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }

        const text = response.rawBody ?? JSON.stringify(response.data ?? { success: true }, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
