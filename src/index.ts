#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { apiGet, getTailnet } from "./api.js";
import { deployAcl } from "./cli.js";
import { aclTools } from "./tools/acl.js";
import { auditTools } from "./tools/audit.js";
import { deviceTools } from "./tools/devices.js";
import { dnsTools } from "./tools/dns.js";
import { inviteTools } from "./tools/invites.js";
import { keyTools } from "./tools/keys.js";
import { logStreamingTools } from "./tools/log-streaming.js";
import { networkLockTools } from "./tools/network-lock.js";
import { oauthClientTools } from "./tools/oauth-clients.js";
import { postureTools } from "./tools/posture.js";
import { serviceTools } from "./tools/services.js";
import { statusTools } from "./tools/status.js";
import { tailnetTools } from "./tools/tailnet.js";
import { userTools } from "./tools/users.js";
import { webhookTools } from "./tools/webhooks.js";
import { workloadIdentityTools } from "./tools/workload-identity.js";

// Injected at build time by esbuild; falls back to reading package.json for tsc builds.
declare const __VERSION__: string | undefined;
const version =
  typeof __VERSION__ !== "undefined"
    ? __VERSION__
    : ((await import("node:module")).createRequire(import.meta.url)("../package.json") as { version: string }).version;

// ─── CLI subcommands (run instead of MCP server) ───

const subcommand = process.argv[2];

if (subcommand === "deploy-acl") {
  const filePath = process.argv[3];
  if (!filePath) {
    console.error("Usage: tailscale-mcp deploy-acl <path-to-acl.json>");
    process.exit(1);
  }
  await deployAcl(filePath).catch((err: unknown) => {
    console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
  process.exit(0);
} else if (subcommand === "version" || subcommand === "--version") {
  console.log(version);
  process.exit(0);
}

// ─── No subcommand — start the MCP server ───

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

const server = new McpServer({
  name: "@yawlabs/tailscale-mcp",
  version,
});

// Register all tools with annotations
for (const tool of allTools) {
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema.shape,
    tool.annotations,
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
    },
  );
}

// Register MCP Resources
server.resource(
  "tailnet-status",
  "tailscale://tailnet/status",
  { description: "Current tailnet status including device count and settings", mimeType: "application/json" },
  async (uri) => {
    const [devicesRes, settingsRes] = await Promise.all([
      apiGet<{ devices: unknown[] }>(`/tailnet/${getTailnet()}/devices?fields=id`),
      apiGet<Record<string, unknown>>(`/tailnet/${getTailnet()}/settings`),
    ]);
    const data = {
      tailnet: getTailnet(),
      deviceCount: devicesRes.ok ? (devicesRes.data?.devices?.length ?? 0) : "error",
      settings: settingsRes.ok ? settingsRes.data : undefined,
    };
    return { contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
  },
);

server.resource(
  "tailnet-devices",
  "tailscale://tailnet/devices",
  { description: "List of all devices in the tailnet with their status", mimeType: "application/json" },
  async (uri) => {
    const res = await apiGet(`/tailnet/${getTailnet()}/devices`);
    const text = res.ok ? JSON.stringify(res.data, null, 2) : JSON.stringify({ error: res.error });
    return { contents: [{ uri: uri.href, text, mimeType: "application/json" }] };
  },
);

server.resource(
  "tailnet-acl",
  "tailscale://tailnet/acl",
  { description: "Current ACL policy (HuJSON with comments preserved)", mimeType: "application/hujson" },
  async (uri) => {
    const res = await apiGet(`/tailnet/${getTailnet()}/acl`, { acceptRaw: true, accept: "application/hujson" });
    const text = res.ok ? (res.rawBody ?? "") : `Error: ${res.error}`;
    return { contents: [{ uri: uri.href, text, mimeType: "application/hujson" }] };
  },
);

server.resource(
  "tailnet-dns",
  "tailscale://tailnet/dns",
  {
    description: "DNS configuration including nameservers, search paths, split DNS, and MagicDNS status",
    mimeType: "application/json",
  },
  async (uri) => {
    const [nameservers, searchPaths, splitDns, preferences] = await Promise.all([
      apiGet(`/tailnet/${getTailnet()}/dns/nameservers`),
      apiGet(`/tailnet/${getTailnet()}/dns/searchpaths`),
      apiGet(`/tailnet/${getTailnet()}/dns/split-dns`),
      apiGet(`/tailnet/${getTailnet()}/dns/preferences`),
    ]);
    const data = {
      nameservers: nameservers.ok ? nameservers.data : undefined,
      searchPaths: searchPaths.ok ? searchPaths.data : undefined,
      splitDns: splitDns.ok ? splitDns.data : undefined,
      preferences: preferences.ok ? preferences.data : undefined,
    };
    return { contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// Startup banner on stderr — stdio MCP protocol uses stdout, so stderr is free for logs.
console.error(`@yawlabs/tailscale-mcp v${version} ready (${allTools.length} tools)`);
