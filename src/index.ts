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
import { postureTools } from "./tools/posture.js";
import { serviceTools } from "./tools/services.js";
import { statusTools } from "./tools/status.js";
import { tailnetTools } from "./tools/tailnet.js";
import { userTools } from "./tools/users.js";
import { webhookTools } from "./tools/webhooks.js";

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

// Handler signature uses method shorthand (not arrow syntax) to get bivariant
// parameter checking. Without that, each tool file's narrowly-typed handler
// (e.g. `(input: {deviceId: string}) => ...`) can't be assigned to a wider
// `(input: unknown) => ...` slot, which is why the earlier version needed
// an `as unknown as ReadonlyArray<Tool>` cast on every group.
type Tool = {
  name: string;
  description: string;
  annotations: { readOnlyHint?: boolean };
  inputSchema: ZodObject<ZodRawShape>;
  handler(input: unknown): Promise<unknown>;
};
const toolGroups: Record<string, ReadonlyArray<Tool>> = {
  status: statusTools,
  devices: deviceTools,
  acl: aclTools,
  dns: dnsTools,
  keys: keyTools,
  users: userTools,
  tailnet: tailnetTools,
  webhooks: webhookTools,
  posture: postureTools,
  audit: auditTools,
  invites: inviteTools,
  services: serviceTools,
  "log-streaming": logStreamingTools,
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
// Error conventions, applied uniformly across all resources:
// - JSON atomic resources: success serializes the data object; failure serializes {error: message}.
// - JSON composite resources (status, dns): failed sub-requests yield null values in their slot,
//   with a parallel `errors` object listing each failed sub-request's message. Never emit a magic
//   string like "error" in a numeric slot.
// - HuJSON resource (acl): failure emits a `//` comment header so the body remains parseable as HuJSON.

server.resource(
  "tailnet-status",
  "tailscale://tailnet/status",
  { description: "Current tailnet status including device count and settings", mimeType: "application/json" },
  async (uri) => {
    const [devicesRes, settingsRes] = await Promise.all([
      apiGet<{ devices: unknown[] }>(`/tailnet/${getTailnet()}/devices?fields=id`),
      apiGet<Record<string, unknown>>(`/tailnet/${getTailnet()}/settings`),
    ]);
    const data: Record<string, unknown> = {
      tailnet: getTailnet(),
      deviceCount: devicesRes.ok ? (devicesRes.data?.devices?.length ?? 0) : null,
      settings: settingsRes.ok ? settingsRes.data : null,
    };
    const errors: Record<string, string> = {};
    if (!devicesRes.ok) errors.devices = devicesRes.error ?? `HTTP ${devicesRes.status}`;
    if (!settingsRes.ok) errors.settings = settingsRes.error ?? `HTTP ${settingsRes.status}`;
    if (Object.keys(errors).length > 0) data.errors = errors;
    return { contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
  },
);

server.resource(
  "tailnet-devices",
  "tailscale://tailnet/devices",
  { description: "List of all devices in the tailnet with their status", mimeType: "application/json" },
  async (uri) => {
    const res = await apiGet(`/tailnet/${getTailnet()}/devices`);
    const text = res.ok
      ? JSON.stringify(res.data, null, 2)
      : JSON.stringify({ error: res.error ?? `HTTP ${res.status}` }, null, 2);
    return { contents: [{ uri: uri.href, text, mimeType: "application/json" }] };
  },
);

server.resource(
  "tailnet-acl",
  "tailscale://tailnet/acl",
  { description: "Current ACL policy (HuJSON with comments preserved)", mimeType: "application/hujson" },
  async (uri) => {
    const res = await apiGet(`/tailnet/${getTailnet()}/acl`, { acceptRaw: true, accept: "application/hujson" });
    const text = res.ok ? (res.rawBody ?? "") : `// Error: ${res.error ?? `HTTP ${res.status}`}\n`;
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
    const data: Record<string, unknown> = {
      nameservers: nameservers.ok ? nameservers.data : null,
      searchPaths: searchPaths.ok ? searchPaths.data : null,
      splitDns: splitDns.ok ? splitDns.data : null,
      preferences: preferences.ok ? preferences.data : null,
    };
    const errors: Record<string, string> = {};
    if (!nameservers.ok) errors.nameservers = nameservers.error ?? `HTTP ${nameservers.status}`;
    if (!searchPaths.ok) errors.searchPaths = searchPaths.error ?? `HTTP ${searchPaths.status}`;
    if (!splitDns.ok) errors.splitDns = splitDns.error ?? `HTTP ${splitDns.status}`;
    if (!preferences.ok) errors.preferences = preferences.error ?? `HTTP ${preferences.status}`;
    if (Object.keys(errors).length > 0) data.errors = errors;
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
    "@yawlabs/tailscale-mcp: tip — set TAILSCALE_PROFILE=core (46 tools) or =minimal (19) to load a smaller tool surface. See README.",
  );
}
