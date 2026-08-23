#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { deployAcl, validateAcl } from "./cli.js";
import { filterTools, PROFILES, parseReadonlyFlag } from "./filter.js";
import {
  buildToolGroups,
  formatBannerFilterSuffix,
  formatTailnetMismatchWarning,
  isLocalCliEnabled,
  tailnetAclResource,
  tailnetDevicesResource,
  tailnetDnsResource,
  tailnetStatusResource,
  wrapToolHandler,
} from "./server-wiring.js";

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

// Tracks whether a CLI subcommand fully handled this invocation. The deploy-acl
// / validate-acl path used to block on `await run(...)` then `process.exit(0)`,
// which prevented the module body below from ever reaching server startup.
// Converting that await to a non-TLA `.then(() => process.exit(0))` chain (for
// CJS esbuild bundling) makes the module body keep executing synchronously
// while the promise is pending, so we must explicitly skip server startup here
// instead of relying on the now-removed top-level await to halt the body.
let cliSubcommandHandled = false;

if (subcommand === "deploy-acl" || subcommand === "validate-acl") {
  cliSubcommandHandled = true;
  const filePath = process.argv[3];
  if (!filePath) {
    console.error(`Usage: tailscale-mcp ${subcommand} <path-to-acl.json>`);
    process.exit(1);
  }
  const run = subcommand === "deploy-acl" ? deployAcl : validateAcl;
  // Non-TLA subcommand runner: the binary build bundles to CJS via esbuild,
  // which cannot emit top-level await. Behavior preserved -- exit 0 on success,
  // exit 1 on failure -- by moving the original trailing `process.exit(0)` into
  // a .then() so it still runs only after the promise resolves.
  run(filePath)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
} else if (subcommand === "version" || subcommand === "--version") {
  console.log(version);
  process.exit(0);
} else if (subcommand !== undefined) {
  // Unknown args fall through to server startup on purpose (MCP clients may
  // pass extra flags), but say so on stderr -- a typo'd subcommand (e.g.
  // "deployacl") would otherwise look like a hang while the server waits on
  // stdio.
  console.error(
    `@yawlabs/tailscale-mcp: unrecognized argument "${subcommand}" -- known subcommands: deploy-acl, validate-acl, version. Starting the MCP server.`,
  );
}

// ─── No subcommand — start the MCP server ───

// Gate all MCP server startup behind the CLI-subcommand check. The deploy-acl
// / validate-acl branch above used to halt the module body via top-level await
// (await run(...) then process.exit(0)); that await is gone for CJS esbuild
// bundling, so without this guard a deploy-acl invocation would ALSO spin up
// the MCP server while its promise was pending. The flag preserves the original
// "run a subcommand XOR start the server" behavior.
if (!cliSubcommandHandled) {
  // Registry + local-cli gating live in server-wiring.ts so they're importable
  // without starting a server -- see buildToolGroups there for the profile
  // interaction caveat.
  const localCliEnabled = isLocalCliEnabled(process.env);
  const toolGroups = buildToolGroups(process.env);

  const {
    tools: allTools,
    unknownGroups,
    unknownProfileGroups,
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

  // Distinct provenance from the warning above: these names came from a
  // PROFILES preset, not from anything the operator typed, so blaming
  // TAILSCALE_TOOLS would send them chasing an env var they never set.
  // Unreachable unless PROFILES and the tool registry drift -- which is a bug
  // in this package, so say so and name the repo.
  if (unknownProfileGroups && unknownProfileGroups.length > 0) {
    console.error(
      `@yawlabs/tailscale-mcp: internal inconsistency -- TAILSCALE_PROFILE="${process.env.TAILSCALE_PROFILE}" references group(s) that are not registered: ${unknownProfileGroups.join(", ")}. Those groups contributed no tools. This is a bug in @yawlabs/tailscale-mcp, not your configuration -- please report it at https://github.com/YawLabs/tailscale-mcp/issues.`,
    );
  }

  // Surfaced before the profile/tools warnings because it breaks every tool
  // rather than trimming the set, and its symptom (blanket 403s) otherwise
  // reads as bad credentials.
  const tailnetMismatch = formatTailnetMismatchWarning(process.env);
  if (tailnetMismatch) {
    console.error(`@yawlabs/tailscale-mcp: ${tailnetMismatch}`);
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
  // Non-TLA connect: the binary build bundles to CJS via esbuild, which cannot
  // emit top-level await. The original `await server.connect(transport)` is
  // converted to a .catch() chain so the module body stays TLA-free.
  server.connect(transport).catch((err: unknown) => {
    process.stderr.write(`tailscale-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
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
}
