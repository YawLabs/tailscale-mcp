#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodObject, ZodRawShape } from "zod";
import { apiGet, getTailnet } from "./api.js";
import { deployAcl } from "./cli.js";
import { filterTools } from "./filter.js";
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

type Tool = {
  name: string;
  description: string;
  annotations: { readOnlyHint?: boolean };
  inputSchema: ZodObject<ZodRawShape>;
  handler: (input: unknown) => Promise<unknown>;
};
const toolGroups: Record<string, ReadonlyArray<Tool>> = {
  status: statusTools as unknown as ReadonlyArray<Tool>,
  devices: deviceTools as unknown as ReadonlyArray<Tool>,
  acl: aclTools as unknown as ReadonlyArray<Tool>,
  dns: dnsTools as unknown as ReadonlyArray<Tool>,
  keys: keyTools as unknown as ReadonlyArray<Tool>,
  users: userTools as unknown as ReadonlyArray<Tool>,
  tailnet: tailnetTools as unknown as ReadonlyArray<Tool>,
  webhooks: webhookTools as unknown as ReadonlyArray<Tool>,
  "network-lock": networkLockTools as unknown as ReadonlyArray<Tool>,
  posture: postureTools as unknown as ReadonlyArray<Tool>,
  audit: auditTools as unknown as ReadonlyArray<Tool>,
  invites: inviteTools as unknown as ReadonlyArray<Tool>,
  services: serviceTools as unknown as ReadonlyArray<Tool>,
  "log-streaming": logStreamingTools as unknown as ReadonlyArray<Tool>,
  "workload-identity": workloadIdentityTools as unknown as ReadonlyArray<Tool>,
  "oauth-clients": oauthClientTools as unknown as ReadonlyArray<Tool>,
};

const {
  tools: allTools,
  unknownGroups,
  unknownProfile,
} = filterTools(toolGroups, {
  tools: process.env.TAILSCALE_TOOLS,
  readonly: process.env.TAILSCALE_READONLY,
  profile: process.env.TAILSCALE_PROFILE,
});

if (unknownGroups.length > 0) {
  const validNames = Object.keys(toolGroups);
  console.error(
    `@yawlabs/tailscale-mcp: TAILSCALE_TOOLS includes unknown group(s): ${unknownGroups.join(", ")}. Valid groups: ${validNames.join(", ")}`,
  );
}

if (unknownProfile) {
  console.error(
    `@yawlabs/tailscale-mcp: TAILSCALE_PROFILE="${unknownProfile}" is not a known profile. Valid profiles: minimal, core, full. Falling back to no profile filter.`,
  );
}

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
const readonlyMode = process.env.TAILSCALE_READONLY === "1" || process.env.TAILSCALE_READONLY === "true";
const profileApplied = process.env.TAILSCALE_PROFILE && !unknownProfile ? process.env.TAILSCALE_PROFILE : null;
const filterSuffix = [
  profileApplied ? `profile=${profileApplied}` : null,
  process.env.TAILSCALE_TOOLS ? `groups=${process.env.TAILSCALE_TOOLS}` : null,
  readonlyMode ? "readonly" : null,
]
  .filter(Boolean)
  .join(", ");
console.error(
  `@yawlabs/tailscale-mcp v${version} ready (${allTools.length} tools${filterSuffix ? `, ${filterSuffix}` : ""})`,
);
if (!filterSuffix) {
  console.error(
    "@yawlabs/tailscale-mcp: tip — set TAILSCALE_PROFILE=core (≈49 tools) or =minimal (≈22) to load a smaller tool surface. See README.",
  );
}
