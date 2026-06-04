#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodObject, ZodRawShape } from "zod";
import { deployAcl } from "./cli.js";
import { filterTools, PROFILES, parseReadonlyFlag } from "./filter.js";
import {
  formatBannerFilterSuffix,
  isLocalCliEnabled,
  tailnetAclResource,
  tailnetDevicesResource,
  tailnetDnsResource,
  tailnetStatusResource,
  wrapToolHandler,
} from "./server-wiring.js";
import { aclTools } from "./tools/acl.js";
import { auditTools } from "./tools/audit.js";
import { deviceTools } from "./tools/devices.js";
import { dnsTools } from "./tools/dns.js";
import { inviteTools } from "./tools/invites.js";
import { keyTools } from "./tools/keys.js";
import { localCliTools } from "./tools/local-cli.js";
import { logStreamingTools } from "./tools/log-streaming.js";
import { postureTools } from "./tools/posture.js";
import { serviceTools } from "./tools/services.js";
import { statusTools } from "./tools/status.js";
import { tailnetTools } from "./tools/tailnet.js";
import { userTools } from "./tools/users.js";
import { webhookTools } from "./tools/webhooks.js";

// Injected at build time by esbuild. Falls back to reading package.json for
// tsc / run-from-source builds. The fallback probes a few candidate depths
// relative to the current module so it survives a change in build-output depth
// (dist/index.js, dist/foo/index.js, or src/index.ts when run via tsx) without
// needing a hand-edit -- the previous single hard-coded `../package.json` broke
// silently on any layout change.
declare const __VERSION__: string | undefined;
function resolveVersionFallback(): string {
  const require = createRequire(import.meta.url);
  for (const rel of ["../package.json", "../../package.json", "../../../package.json"]) {
    try {
      const pkg = require(rel) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // Not at this depth; try the next one.
    }
  }
  return "0.0.0-unknown";
}
const version = typeof __VERSION__ !== "undefined" ? __VERSION__ : resolveVersionFallback();

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

// Local CLI tools are opt-in: they shell out to a `tailscale` binary that
// may not exist (CI runners, containers without elevation, etc.). Setting
// TAILSCALE_LOCAL_CLI=1 adds the group to the registry; filters
// (TAILSCALE_PROFILE / TAILSCALE_TOOLS) then compose on top normally.
//
// Caveat worth knowing: "local-cli" is not part of any TAILSCALE_PROFILE preset
// (see PROFILES in filter.ts), so TAILSCALE_LOCAL_CLI=1 combined with
// TAILSCALE_PROFILE=core|minimal re-drops these tools -- the profile filter
// intersects them back out. To keep them, list them explicitly via
// TAILSCALE_TOOLS=local-cli,... or use TAILSCALE_PROFILE=full (no group filter).
const localCliEnabled = isLocalCliEnabled(process.env);
if (localCliEnabled) {
  toolGroups["local-cli"] = localCliTools;
}

const {
  tools: allTools,
  unknownGroups,
  unknownProfile,
  explicitTools,
  profileWouldFilter,
  toolsAllUnknown,
} = filterTools(toolGroups, {
  tools: process.env.TAILSCALE_TOOLS,
  readonly: process.env.TAILSCALE_READONLY,
  profile: process.env.TAILSCALE_PROFILE,
});

if (unknownGroups.length > 0) {
  const validNames = Object.keys(toolGroups);
  // When every requested group was unknown, filterTools ignores TAILSCALE_TOOLS
  // rather than starting a zero-tool server; say so explicitly so the operator
  // understands why the full/profile tool set loaded despite their filter.
  const fallbackNote = toolsAllUnknown
    ? " Every requested group was unknown, so TAILSCALE_TOOLS was ignored and the default tool set was loaded instead."
    : "";
  console.error(
    `@yawlabs/tailscale-mcp: TAILSCALE_TOOLS includes unknown group(s): ${unknownGroups.join(", ")}. Valid groups: ${validNames.join(", ")}.${fallbackNote}`,
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
  server.tool(tool.name, tool.description, tool.inputSchema.shape, tool.annotations, wrapToolHandler(tool));
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
  tailnetStatusResource,
);

server.resource(
  "tailnet-devices",
  "tailscale://tailnet/devices",
  { description: "List of all devices in the tailnet with their status", mimeType: "application/json" },
  tailnetDevicesResource,
);

server.resource(
  "tailnet-acl",
  "tailscale://tailnet/acl",
  { description: "Current ACL policy (HuJSON with comments preserved)", mimeType: "application/hujson" },
  tailnetAclResource,
);

server.resource(
  "tailnet-dns",
  "tailscale://tailnet/dns",
  {
    description: "DNS configuration including nameservers, search paths, split DNS, and MagicDNS status",
    mimeType: "application/json",
  },
  tailnetDnsResource,
);

const transport = new StdioServerTransport();
await server.connect(transport);
// Startup banner on stderr — stdio MCP protocol uses stdout, so stderr is free for logs.
// The suffix-construction logic lives in server-wiring.ts (see formatBannerFilterSuffix)
// so the four-case profile/tools matrix can be unit-tested without spawning the server.
const readonlyMode = parseReadonlyFlag(process.env.TAILSCALE_READONLY);
const filterSuffix = formatBannerFilterSuffix({
  unknownProfile,
  explicitTools,
  profileWouldFilter,
  profileEnv: process.env.TAILSCALE_PROFILE,
  readonlyMode,
  localCliEnabled,
});
console.error(
  `@yawlabs/tailscale-mcp v${version} ready (${allTools.length} tools${filterSuffix ? `, ${filterSuffix}` : ""})`,
);
// Only show the profile tip when the user already has working creds. On a fresh
// install with no creds set, the auth-error path will fire on the first tool
// call — and that message is the more useful first message to read.
const hasCreds =
  !!process.env.TAILSCALE_API_KEY ||
  (!!process.env.TAILSCALE_OAUTH_CLIENT_ID && !!process.env.TAILSCALE_OAUTH_CLIENT_SECRET);
if (!filterSuffix && hasCreds) {
  // Compute the per-profile counts from the actual registry rather than
  // hard-coding numbers in the banner string. The hard-coded form silently
  // went out of date whenever a group gained or lost a tool; this derives
  // both numbers from the same source of truth filterTools() uses.
  const profileCount = (groups: readonly string[]): number =>
    groups.reduce((n, g) => n + (toolGroups[g]?.length ?? 0), 0);
  const coreCount = profileCount(PROFILES.core);
  const minimalCount = profileCount(PROFILES.minimal);
  console.error(
    `@yawlabs/tailscale-mcp: tip — set TAILSCALE_PROFILE=core (${coreCount} tools) or =minimal (${minimalCount}) to load a smaller tool surface. See README.`,
  );
}
