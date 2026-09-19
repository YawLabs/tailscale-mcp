#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { deployAcl, validateAcl } from "./cli.js";
import { filterTools, PROFILES, parseReadonlyFlag } from "./filter.js";
import {
  buildToolGroups,
  buildToolMeta,
  formatBannerFilterSuffix,
  formatTailnetMismatchWarning,
  isLocalCliEnabled,
  isRequireApprovalEnabled,
  tailnetAclResource,
  tailnetDevicesResource,
  tailnetDnsResource,
  tailnetStatusResource,
  wrapToolHandler,
} from "./server-wiring.js";
import { buildMetaTools } from "./tools/meta.js";

// The oldest Node this package supports, matching package.json `engines.node`
// and NODE_MIN in bin/tailscale-mcp.mjs. The launcher refuses a sub-floor Node
// before it selects a runtime, but the README documents `node /path/to/dist/
// index.js` as the fast path and that never loads the launcher -- so the floor
// is enforced at both documented entry points. `engines` cannot do this job:
// npm only warns, nothing sets engine-strict, and a client that spawns `node`
// directly never reads it. src/node-floor.test.ts keeps the two copies and
// package.json in step, and fails the build on an API newer than this floor.
const NODE_MIN = [20, 11, 0];
function belowNodeFloor(reported: string): boolean {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(reported);
  // Unreadable (or a runtime that reports no version): not evidence of a
  // sub-floor Node, and refusing would break something that works today.
  if (!found) return false;
  for (const [i, min] of NODE_MIN.entries()) {
    const part = Number(found[i + 1]);
    if (part > min) return false;
    if (part < min) return true;
  }
  return false;
}
// `process.versions.oam` is absent on Node and present on oam, whose own floor
// the launcher checks; measuring it here would compare the wrong number.
if (process.versions.oam === undefined && belowNodeFloor(process.versions.node)) {
  process.stderr.write(
    `tailscale-mcp: needs Node ${NODE_MIN.join(".")} or newer, found ${process.versions.node}.\n` +
      `Install a newer Node (https://nodejs.org/en/download), or point your MCP client's "command" at one.\n`,
  );
  process.exit(1);
}

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

// The usage block, and the one place that lists what the dispatch chain below
// accepts. Every accepted spelling appears here -- both ACL subcommands, the
// `version` / `help` barewords, and their flag aliases -- so a new branch added
// without a matching line here is the drift to watch for. `help` and `version`
// are listed as commands with flag aliases rather than as flags alone, because
// the bareword forms are what a user reaches for first (`tailscale-mcp help`)
// and both are dispatched identically.
const USAGE = `Usage: tailscale-mcp [command]

Commands:
  deploy-acl <path-to-acl.json>    Deploy an ACL policy
  validate-acl <path-to-acl.json>  Validate an ACL policy
  version                          Print the installed version
  help                             Print this message

Flags:
  --version, -V                    Print the installed version
  --help, -h                       Print this message

Run without a command to start the MCP server on stdio.`;

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
  // A help flag in the path position is a help request, not a policy file.
  // Without this it reaches readFile and exits 1 on "Failed to read --help:
  // ENOENT ... open '<cwd>/--help'", which reads as a broken package rather
  // than a mis-typed command. Flags only, deliberately: a bareword `help` is
  // indistinguishable from a file actually named `help`, while `--help` / `-h`
  // are never a path anyone means.
  if (filePath === "--help" || filePath === "-h") {
    console.log(`Usage: tailscale-mcp ${subcommand} <path-to-acl.json>`);
    process.exit(0);
  }
  if (!filePath) {
    // Same line, stderr and exit 1: this is a malformed invocation, not a
    // request for help, so it must stay diagnosable by a CI step's exit code.
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
} else if (subcommand === "version" || subcommand === "--version" || subcommand === "-V") {
  console.log(version);
  process.exit(0);
} else if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
  // `help` as a bareword, not just the flags: it is the first thing a user
  // types at a CLI that has subcommands, and without it the invocation hits the
  // unknown-arg fall-through and hangs on stdio -- the same failure the flags
  // above were added to fix.
  console.log(USAGE);
  process.exit(0);
} else if (subcommand !== undefined) {
  // Unknown args fall through to server startup on purpose (MCP clients may
  // pass extra flags), but say so on stderr -- a typo'd subcommand (e.g.
  // "deployacl") would otherwise look like a hang while the server waits on
  // stdio.
  console.error(
    `@yawlabs/tailscale-mcp: unrecognized argument "${subcommand}" -- known subcommands: deploy-acl, validate-acl, version, help (or --help). Starting the MCP server.`,
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
    writeGroups,
    unknownWriteGroups,
    writeGroupsNotLoaded,
    writeGroupsOverriddenByReadonly,
  } = filterTools(toolGroups, {
    tools: process.env.TAILSCALE_TOOLS,
    readonly: process.env.TAILSCALE_READONLY,
    profile: process.env.TAILSCALE_PROFILE,
    writeGroups: process.env.TAILSCALE_WRITE_GROUPS,
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

  if (unknownWriteGroups && unknownWriteGroups.length > 0) {
    const validNames = Object.keys(toolGroups);
    // A group that EXISTS but is not registered in this process is not a typo, and
    // telling the operator to check their spelling sends them hunting a mistake that
    // is not there -- the same misattribution the unknownGroups / unknownProfileGroups
    // split above exists to prevent. The conditional set is DERIVED (build the registry
    // with every opt-in on and diff it) rather than hard-coding "local-cli", so a
    // second conditional group is covered without touching this branch.
    const everyPossibleGroup = Object.keys(buildToolGroups({ ...process.env, TAILSCALE_LOCAL_CLI: "1" }));
    const notEnabled = unknownWriteGroups.filter((g) => everyPossibleGroup.includes(g));
    const realTypos = unknownWriteGroups.filter((g) => !everyPossibleGroup.includes(g));
    if (notEnabled.length > 0) {
      console.error(
        `@yawlabs/tailscale-mcp: TAILSCALE_WRITE_GROUPS names group(s) that exist but are not enabled in this process: ${notEnabled.join(", ")}. Set TAILSCALE_LOCAL_CLI=1 to register the local-cli group. Not a typo -- the grant simply had nothing to apply to.`,
      );
    }
    // Only the names the branch above did NOT account for are typos. Reporting the
    // full list here as "unknown" would contradict the message just printed.
    if (realTypos.length > 0) {
      // No fallback here, unlike TAILSCALE_TOOLS: an unrecognised name grants nothing.
      // Say so explicitly, because the safe outcome and a broken config look identical
      // from the agent's side -- it just sees fewer tools.
      const sentinels = new Set(["none", "off", "false", "0", "all", "*"]);
      const guessed = realTypos.filter((g) => sentinels.has(g.toLowerCase()));
      // Nothing is reserved in the grammar (a reserved word could collide with a future
      // group name), so a plausible-looking sentinel lands here as an unknown name.
      // Point at the spelling that does what they meant rather than adding grammar.
      const hint = guessed.some((g) => ["all", "*"].includes(g.toLowerCase()))
        ? ' Note: "all" is not a group name -- leave TAILSCALE_WRITE_GROUPS unset to allow writes in every loaded group.'
        : guessed.length > 0
          ? " Note: to disable writes entirely, TAILSCALE_READONLY=1 is the shipped spelling."
          : "";
      console.error(
        `@yawlabs/tailscale-mcp: TAILSCALE_WRITE_GROUPS includes unknown group(s): ${realTypos.join(", ")}. Valid groups: ${validNames.join(", ")}. Those names granted no write access; tools outside the granted groups are served read-only.${hint}`,
      );
    }
  }

  // A separate warning from the typo case on purpose: these names are spelled
  // correctly, so telling the operator to check their spelling would send them
  // looking for a mistake that is not there. The fix is the load filter, not this one.
  if (writeGroupsNotLoaded && writeGroupsNotLoaded.length > 0) {
    console.error(
      `@yawlabs/tailscale-mcp: TAILSCALE_WRITE_GROUPS names group(s) that your TAILSCALE_TOOLS / TAILSCALE_PROFILE filter does not load: ${writeGroupsNotLoaded.join(", ")}. Those grants had no effect.`,
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
    // Names come from PROFILES rather than a hand-written list: the hard-coded
    // "minimal, core, full" string had no link to the presets it described, so
    // adding a preset left the warning telling operators their new profile was
    // invalid. Same reason the tip below derives its counts from the registry.
    console.error(
      `@yawlabs/tailscale-mcp: TAILSCALE_PROFILE="${unknownProfile}" is not a known profile. Valid profiles: ${Object.keys(PROFILES).join(", ")}. Falling back to no profile filter.`,
    );
  }

  const server = new McpServer({
    name: "@yawlabs/tailscale-mcp",
    version,
  });

  const requireApproval = isRequireApprovalEnabled(process.env);
  // The catalog tool, registered BEFORE the filtered set and outside it: no filter
  // can reach it, because it never enters filterTools. Every other diagnostic this
  // server prints about its own configuration goes to stderr, which the model never
  // sees -- so without this, a withheld tool and a nonexistent one are the same
  // observation to an agent, and the roadmap's "invents a workaround" failure follows.
  //
  // It is NOT in buildToolGroups on purpose: that registry is the Tailscale API
  // surface, every count in the README and release-metadata.test.ts derives from it,
  // and the README's "N admin-API tools" has to keep being true.
  const metaTools = buildMetaTools({
    // The FULL registry, with opt-ins forced on, so the catalog can report on a group
    // that is currently disabled -- which is exactly the group an agent needs
    // explained. Reporting only what loaded would make local-cli invisible rather
    // than explained.
    fullRegistry: buildToolGroups({ ...process.env, TAILSCALE_LOCAL_CLI: "1" }),
    // Ground truth for availability: what this server actually serves. Deliberately
    // not a re-derivation of the filter logic, so the catalog cannot disagree with
    // the server about what exists.
    registeredNames: new Set(allTools.map((t) => t.name)),
    toolsEnv: process.env.TAILSCALE_TOOLS,
    profileEnv: process.env.TAILSCALE_PROFILE,
    writeGroupsEnv: process.env.TAILSCALE_WRITE_GROUPS,
    readonlyMode: parseReadonlyFlag(process.env.TAILSCALE_READONLY),
    localCliEnabled,
  });
  for (const tool of metaTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.annotations.title,
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
        annotations: tool.annotations,
        _meta: buildToolMeta(tool.name, { requireApproval }),
      },
      wrapToolHandler(tool),
    );
  }

  // Register all tools with annotations.
  //
  // registerTool, NOT the legacy server.tool(): all six tool() overloads are
  // @deprecated in SDK 1.29, and the implementation hardcodes both `title` and
  // `_meta` to undefined when it builds the registry entry -- so neither can
  // reach tools/list through that path, no matter what is passed in.
  // registerTool destructures both from its config and forwards them, and the
  // tools/list handler emits `_meta: tool._meta`. The SDK says as much in its
  // own comment on tool(): "Support for this style is frozen as of protocol
  // version 2025-03-26. Future additions to tool definition should *NOT* be
  // added."
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        // Hoisted out of annotations.title, which every tool file already sets.
        // The annotations copy deliberately stays where it is: clients reading
        // the legacy location keep working, so this is purely additive on the
        // wire rather than a move.
        title: tool.annotations.title,
        description: tool.description,
        inputSchema: tool.inputSchema.shape,
        annotations: tool.annotations,
        _meta: buildToolMeta(tool.name, { requireApproval }),
      },
      wrapToolHandler(tool),
    );
  }

  // Register MCP Resources
  // Error conventions, applied uniformly across all resources:
  // - JSON atomic resources: success serializes the data object; failure serializes {error: message}.
  // - JSON composite resources (status, dns): failed sub-requests yield null values in their slot,
  //   with a parallel `errors` object listing each failed sub-request's message. Never emit a magic
  //   string like "error" in a numeric slot.
  // - HuJSON resource (acl): failure emits a `//` comment header so the body remains parseable as HuJSON.

  server.registerResource(
    "tailnet-status",
    "tailscale://tailnet/status",
    { description: "Current tailnet status including device count and settings", mimeType: "application/json" },
    tailnetStatusResource,
  );

  server.registerResource(
    "tailnet-devices",
    "tailscale://tailnet/devices",
    { description: "List of all devices in the tailnet with their status", mimeType: "application/json" },
    tailnetDevicesResource,
  );

  server.registerResource(
    "tailnet-acl",
    "tailscale://tailnet/acl",
    { description: "Current ACL policy (HuJSON with comments preserved)", mimeType: "application/hujson" },
    tailnetAclResource,
  );

  server.registerResource(
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
    writeGroups,
    writeGroupsOverriddenByReadonly,
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

  // Not folded into the one-line banner: formatBannerFilterSuffix stays a small pure
  // function, and this needs room to be specific.
  //
  // Derived from what ACTUALLY REGISTERED, not from the write grant. An earlier
  // revision read `writeGroups`, which inverted the warning relative to the risk: it
  // fired on a NARROWED grant (`TAILSCALE_WRITE_GROUPS=keys`) and stayed silent on the
  // default, where keys AND users AND acl are all writable because no gate is set. The
  // operator in the more permissive state heard less. Asking the registered tool list
  // "which admin-equivalent areas can this server write to right now" answers the same
  // question in every configuration, and cannot drift from the config logic above
  // because it does not re-derive it.
  //
  // The framing it exists to deliver: TAILSCALE_WRITE_GROUPS filters the TOOL LIST, not
  // the credential. Writing in any of these three is tailnet-admin-equivalent.
  const ADMIN_EQUIVALENT = ["keys", "users", "acl"];
  const registeredNames = new Set(allTools.map((t) => t.name));
  const adminWritable = ADMIN_EQUIVALENT.filter((g) =>
    (toolGroups[g] ?? []).some((t) => t.annotations.readOnlyHint !== true && registeredNames.has(t.name)),
  );
  // Gated on hasCreds for the same reason as the profile tip: a fresh install with no
  // credentials has a more useful first message to read than a security note.
  if (adminWritable.length > 0 && hasCreds) {
    console.error(
      `@yawlabs/tailscale-mcp: note -- this server can write to ${adminWritable.join(", ")}, which is tailnet-admin-equivalent. ` +
        "tailscale_create_key mints an OAuth client with any scopes the caller asks for, " +
        'tailscale_update_user_role accepts "owner", and tailscale_update_acl rewrites policy for every principal. ' +
        "Scope the Tailscale OAuth client itself to the areas you need -- that bound survives outside this process; this one does not. " +
        "TAILSCALE_WRITE_GROUPS narrows what this server exposes.",
    );
  }
  if (!filterSuffix && hasCreds) {
    // Compute the per-profile counts from the actual registry rather than
    // hard-coding numbers in the banner string. The hard-coded form silently
    // went out of date whenever a group gained or lost a tool; this derives
    // both numbers from the same source of truth filterTools() uses.
    const profileCount = (groups: readonly string[]): number =>
      groups.reduce((n, g) => n + (toolGroups[g]?.length ?? 0), 0);
    const coreCount = profileCount(PROFILES.core);
    const minimalCount = profileCount(PROFILES.minimal);
    // ASCII "--" rather than an em-dash: this line is terminal output, and on
    // Windows a UTF-8 write racing the console codepage renders it as mojibake
    // that then travels into bug reports verbatim.
    console.error(
      `@yawlabs/tailscale-mcp: tip -- set TAILSCALE_PROFILE=core (${coreCount} tools) or =minimal (${minimalCount}) to load a smaller tool surface. See README.`,
    );
  }
}
