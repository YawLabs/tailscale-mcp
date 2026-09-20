import type { ZodObject, ZodRawShape } from "zod";
import { apiGet, getTailnet } from "./api.js";
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
import { composeTailnetStatusData, statusTools } from "./tools/status.js";
import { tailnetTools } from "./tools/tailnet.js";
import { tailnetsTools } from "./tools/tailnets.js";
import { userTools } from "./tools/users.js";
import { webhookTools } from "./tools/webhooks.js";

/**
 * Pure predicate: is the local-CLI tool group enabled for the given env?
 * Lives here (not inline in index.ts) so it's unit-testable; index.ts uses
 * it both to decide whether to register the local-cli group and to drive
 * the `local-cli=on` startup-banner suffix. Single source of truth prevents
 * the two call sites from drifting apart.
 */
export function isLocalCliEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.TAILSCALE_LOCAL_CLI === "1" || env.TAILSCALE_LOCAL_CLI === "true";
}

/**
 * Pure predicate: is forced client-side approval enabled for the given env?
 *
 * Case-sensitive "1" | "true", matching TAILSCALE_LOCAL_CLI above and
 * TAILSCALE_READONLY in filter.ts -- an operator who sets several of these
 * follows one rule, not three.
 *
 * OPT-IN, and deliberately so. `anthropic/requiresUserInteraction` is enforced
 * client-side and cannot be routed around: it prompts even when an allow-rule
 * matches, and in a never-prompt mode the client DENIES the call rather than
 * running it. Defaulting this on would therefore break every unattended agent
 * that upgrades -- a silent behaviour change on the exact tools whose failure
 * is most disruptive. Operators opt in when a human is at the keyboard.
 */
export function isRequireApprovalEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.TAILSCALE_REQUIRE_APPROVAL === "1" || env.TAILSCALE_REQUIRE_APPROVAL === "true";
}

// Handler signature uses method shorthand (not arrow syntax) to get bivariant
// parameter checking. Without that, each tool file's narrowly-typed handler
// (e.g. `(input: {deviceId: string}) => ...`) can't be assigned to a wider
// `(input: unknown) => ...` slot, which is why an earlier version needed an
// `as unknown as ReadonlyArray<Tool>` cast on every group.
export type Tool = {
  name: string;
  description: string;
  // Widened from `{ readOnlyHint?: boolean }` when registration moved to
  // registerTool: every tool file already sets all five of these, but the
  // narrow type meant `annotations.title` was invisible at the registration
  // site, so the display name could never be hoisted to the top-level `title`
  // field the MCP spec defines. All optional, so no tool file changes.
  annotations: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  inputSchema: ZodObject<ZodRawShape>;
  handler(input: unknown): Promise<unknown>;
};

/**
 * Tools that must never be auto-approved, surfaced to the client as
 * `_meta["anthropic/requiresUserInteraction"]`.
 *
 * THE CRITERION, applied literally: this server cannot undo the call using
 * information the caller still holds. That is narrower than
 * `destructiveHint: true` on purpose -- a hint that fires on a large share of
 * the surface trains operators to click through it, which is how a real
 * confirmation gets ignored.
 *
 * Worked through the destructive set, the exclusions are the interesting half:
 * - `suspend_user` has `restore_user`, so it is reversible in-server. It was on
 *   the original shortlist for this list and is deliberately off it -- applying
 *   the stated criterion honestly matters more than the intuition that
 *   suspension feels severe.
 * - `deauthorize_device` / `set_devices_authorized` have `authorize_device`.
 * - `delete_device_posture_attribute` has `set_device_posture_attribute`.
 * - The replace-all writes (`update_acl` aside) -- `set_device_routes`,
 *   `set_device_tags`, the DNS ones -- each have a `get_*` counterpart,
 *   so a caller that read before writing can put the old value back. They are
 *   still destructive, and withholding them belongs to a graduated write gate,
 *   not to this list. That gate now exists: TAILSCALE_WRITE_GROUPS withholds
 *   every write outside the granted areas. (An earlier revision of this comment
 *   deliberately did not name it, because release-metadata.test.ts derives the
 *   sandbox allow-list by regexing src/ for TAILSCALE_* tokens and cannot tell a
 *   comment from a read -- naming it then would have demanded a launcher grant
 *   for a variable nothing read. The grant ships in the same commit as this
 *   sentence.)
 * - The invite deletes revoke a pending invite that can be re-issued from the
 *   same inputs.
 *
 * `update_acl` is the exception among replace-all writes and the reason this
 * list exists: it can lock every device out of the tailnet in one call, and the
 * previous HuJSON -- comments included -- is gone unless the caller happened to
 * capture it first.
 *
 * The `delete_*` entries carrying secrets (`delete_key`,
 * `delete_oauth_app`, `delete_webhook`, `delete_log_stream_config`,
 * `delete_posture_integration`) are irreversible in a second sense: the API
 * never returns the credential again, so even a caller who re-creates the
 * object cannot restore the value consumers were using.
 *
 * Alphabetised so an omission is easy to spot, and pinned by a name-literal
 * test rather than derived from annotations -- deriving it would make the test
 * agree with whatever the annotations happen to say, which is the bug the test
 * exists to catch.
 */
export const FORCED_APPROVAL_TOOLS: readonly string[] = [
  "tailscale_delete_device",
  "tailscale_delete_key",
  "tailscale_delete_log_stream_config",
  "tailscale_delete_oauth_app",
  "tailscale_delete_posture_integration",
  "tailscale_delete_tailnet",
  "tailscale_delete_user",
  "tailscale_delete_webhook",
  "tailscale_update_acl",
];

/**
 * The client-side ceiling for `anthropic/maxResultSizeChars`. Values above it
 * are ignored, so this is the cap and not a preference.
 */
export const MAX_RESULT_SIZE_CHARS = 500_000;

/**
 * Tools whose response size scales with the tailnet rather than with the
 * request, declared so a large-but-legitimate result stays inline instead of
 * being truncated to a file reference the agent has to read back mid-task.
 *
 * Every entry gets the ceiling rather than a hand-tuned number. A per-tool
 * value would need to come from measuring real responses against a live tailnet
 * (`RUN_INTEGRATION_TESTS=1`), and an invented one is fake precision: the honest
 * claim here is only "this tool's output is bounded by tailnet size, not by the
 * request, so do not truncate it". Tuning below the ceiling is a follow-up that
 * needs measurement, not a guess.
 *
 * Deliberately NOT every read tool. The annotation exists to raise a limit that
 * a specific tool legitimately exceeds; spraying it across every read tool
 * would say nothing and cost bytes in every `tools/list`.
 */
export const LARGE_RESULT_TOOLS: readonly string[] = [
  // Scales with BOTH the number of principals checked and each one's grant
  // count, so for a given tailnet its payload is strictly larger than
  // list_users below.
  "tailscale_diff_acl_access",
  "tailscale_get_acl",
  "tailscale_get_audit_log",
  "tailscale_get_network_flow_logs",
  "tailscale_list_devices",
  "tailscale_list_users",
  // The one opt-in entry: it registers only under TAILSCALE_LOCAL_CLI=1, so a
  // test comparing this list against a session's `_meta` has to filter it to
  // the names that session registered. Its payload is the local client's whole
  // peer map, which scales with the tailnet exactly as the admin reads above
  // do -- the tool takes `peers` and `activeOnly` for callers who want less.
  "tailscale_local_status",
];

/**
 * Compose the `_meta` object a tool is registered with, or undefined when it
 * carries none. Centralised here rather than spelled out per tool file so the
 * whole policy is one readable list and one test, and so the env gate is
 * applied in exactly one place.
 *
 * Returns a fresh object per call: `_meta` reaches the SDK's registry by
 * reference and is echoed into every `tools/list`, so a shared literal would
 * let one mutation leak across tools.
 */
export function buildToolMeta(
  toolName: string,
  options: { requireApproval: boolean },
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (options.requireApproval && FORCED_APPROVAL_TOOLS.includes(toolName)) {
    // Must be the JSON boolean true; the client ignores any other value.
    meta["anthropic/requiresUserInteraction"] = true;
  }
  if (LARGE_RESULT_TOOLS.includes(toolName)) {
    meta["anthropic/maxResultSizeChars"] = MAX_RESULT_SIZE_CHARS;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Build the group -> tools registry the server registers and `filterTools`
 * filters. Takes env rather than reading `process.env` so it stays pure and
 * testable.
 *
 * Lives here rather than inline in index.ts because index.ts's module body has
 * a side effect (it starts the MCP server on import), which made the registry
 * impossible to import from a test or from the README-count consistency check.
 * Everything about the registry that can drift -- the group names, the tool
 * counts, the local-cli gating -- is now assertable without spawning a server.
 *
 * Local CLI tools are opt-in: they shell out to a `tailscale` binary that may
 * not exist (CI runners, containers without elevation, etc.). TAILSCALE_LOCAL_CLI=1
 * adds the group; filters (TAILSCALE_PROFILE / TAILSCALE_TOOLS) then compose on
 * top normally.
 *
 * Caveat worth knowing: "local-cli" is not part of any TAILSCALE_PROFILE preset
 * (see PROFILES in filter.ts), so TAILSCALE_LOCAL_CLI=1 combined with
 * TAILSCALE_PROFILE=core|minimal re-drops these tools -- the profile filter
 * intersects them back out. To keep them, list them explicitly via
 * TAILSCALE_TOOLS=local-cli,... or use TAILSCALE_PROFILE=full (no group filter).
 */
export function buildToolGroups(env: NodeJS.ProcessEnv): Record<string, ReadonlyArray<Tool>> {
  const toolGroups: Record<string, ReadonlyArray<Tool>> = {
    status: statusTools,
    devices: deviceTools,
    acl: aclTools,
    dns: dnsTools,
    keys: keyTools,
    users: userTools,
    tailnet: tailnetTools,
    // Named "org-tailnets", NOT "tailnets": a group called "tailnets" sits one
    // character from the existing "tailnet" group (settings/contacts), and
    // TAILSCALE_TOOLS matches names exactly with no near-miss warning. An
    // operator who typo'd one would silently be handed the other -- and this
    // group contains an irreversible whole-tailnet delete.
    "org-tailnets": tailnetsTools,
    webhooks: webhookTools,
    posture: postureTools,
    audit: auditTools,
    invites: inviteTools,
    services: serviceTools,
    "log-streaming": logStreamingTools,
  };
  if (isLocalCliEnabled(env)) {
    toolGroups["local-cli"] = localCliTools;
  }
  return toolGroups;
}

/**
 * Warn when TAILSCALE_OAUTH_TAILNET and TAILSCALE_TAILNET name different
 * tailnets. Returns the warning text, or null when the configuration is fine.
 *
 * Why this needs saying out loud: TAILSCALE_OAUTH_TAILNET scopes the minted
 * OAuth token to one tailnet, while every non-org-tailnets tool builds its path
 * from `/tailnet/${getTailnet()}/...`. Set them to different values and the
 * token is valid but addresses the wrong tailnet, so the ENTIRE tool surface
 * returns 403 with nothing in the error pointing at the real cause -- the
 * failure looks like broken credentials rather than a two-variable mismatch.
 *
 * Unset or "-" is NOT a mismatch: "-" is the API's self-reference, so it
 * resolves to whatever tailnet the token is scoped to, which is exactly right.
 *
 * Pure over an env argument (not process.env) so it stays unit-testable,
 * mirroring isLocalCliEnabled and formatBannerFilterSuffix above.
 */
export function formatTailnetMismatchWarning(env: NodeJS.ProcessEnv): string | null {
  const oauthTailnet = env.TAILSCALE_OAUTH_TAILNET?.trim();
  if (!oauthTailnet) return null;
  const explicit = env.TAILSCALE_TAILNET?.trim();
  if (!explicit || explicit === "-" || explicit === oauthTailnet) return null;
  return (
    `TAILSCALE_OAUTH_TAILNET="${oauthTailnet}" but TAILSCALE_TAILNET="${explicit}". ` +
    "The OAuth token will be scoped to the former while tool requests are addressed to the latter, " +
    "so every tailnet-scoped tool will fail with HTTP 403. " +
    `Either unset TAILSCALE_TAILNET (or set it to "-") to follow the token, or set both to the same tailnet.`
  );
}

export interface BannerFilterInputs {
  // Pulled from the filterTools() result:
  unknownProfile: string | undefined;
  explicitTools: string[] | undefined;
  profileWouldFilter: boolean | undefined;
  // Pulled from env (resolved by the caller so this stays a pure function):
  profileEnv: string | undefined;
  readonlyMode: boolean;
  localCliEnabled: boolean;
  // Optional rather than required-but-undefined: fourteen existing call sites in
  // server-wiring.test.ts would otherwise need mechanical edits that assert nothing.
  // The risk optionality creates -- index.ts forgetting to pass them -- is covered by
  // an index-level test that drives a real startup and asserts the `write=` segment.
  // Absent means the knob was never set; an empty array means "granted nothing".
  writeGroups?: string[] | undefined;
  writeGroupsOverriddenByReadonly?: boolean | undefined;
}

/**
 * Compose the comma-separated filter-suffix segment of the startup banner.
 * Pure function over already-resolved inputs so the four-case matrix
 * (profile=core/full x with/without explicit tools) plus the readonly /
 * local-cli toggles can be unit-tested without spawning the server.
 *
 * Returns the empty string when nothing is configured -- index.ts uses that
 * to decide whether to render the trailing parenthesized chunk and the
 * follow-up profile-tip line.
 *
 * The "(overridden by TAILSCALE_TOOLS)" marker is gated on
 * `profileWouldFilter`: profile=full is a valid no-op preset, so calling it
 * overridden would suggest a substantive filter was lost when none existed.
 */
export function formatBannerFilterSuffix(inputs: BannerFilterInputs): string {
  const profileValid = !!inputs.profileEnv && !inputs.unknownProfile;
  const profileLabel = profileValid
    ? inputs.explicitTools && inputs.profileWouldFilter
      ? `profile=${inputs.profileEnv} (overridden by TAILSCALE_TOOLS)`
      : `profile=${inputs.profileEnv}`
    : null;
  const groupsLabel = inputs.explicitTools ? `groups=${inputs.explicitTools.join(",")}` : null;
  return [
    profileLabel,
    groupsLabel,
    inputs.readonlyMode
      ? inputs.writeGroupsOverriddenByReadonly
        ? "readonly (TAILSCALE_WRITE_GROUPS ignored)"
        : "readonly"
      : null,
    // `write=none` (configured, granted nothing) is a different state from no segment
    // at all (knob unset, every write served), and an operator debugging "why can it
    // not write" needs to tell them apart at a glance.
    inputs.writeGroups
      ? inputs.writeGroups.length > 0
        ? `write=${inputs.writeGroups.join(",")}`
        : "write=none"
      : null,
    inputs.localCliEnabled ? "local-cli=on" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

// Loose tool shape: matches every entry in `toolGroups` without forcing the
// caller to import the full Tool type from index.ts.
export type ToolLike = {
  handler: (input: unknown) => Promise<unknown>;
};

export type MCPToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Wraps a tool's `.handler` to convert its `{ok, data, error, rawBody}` return
 * shape into the MCP `{content, isError?}` shape. Behaviour is byte-identical
 * to the inline closure that lived in `index.ts` — same try/catch envelope,
 * same `Error: ...` formatting, same precedence (rawBody beats data), same
 * `{success: true}` default when neither is present.
 */
export function wrapToolHandler(tool: ToolLike): (input: Record<string, unknown>) => Promise<MCPToolResponse> {
  return async (input: Record<string, unknown>) => {
    try {
      const result = await tool.handler(input);
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
  };
}

export async function tailnetStatusResource(uri: URL) {
  const [devicesRes, settingsRes] = await Promise.all([
    apiGet<{ devices: unknown[] }>(`/tailnet/${getTailnet()}/devices?fields=id`),
    apiGet<Record<string, unknown>>(`/tailnet/${getTailnet()}/settings`),
  ]);
  const data = composeTailnetStatusData(devicesRes, settingsRes, { tailnet: getTailnet() });
  return { contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
}

// `||`, NOT `??`, on the error fallback here and in the two resources below.
// extractErrorMessage() returns the body verbatim when it is empty (api.ts),
// so an empty-body failure yields error:"" -- a string, and therefore not
// nullish. Under `??` a bodiless 502/503 from a proxy in front of
// api.tailscale.com would ship `{"error":""}` to the client with the status
// code dropped, i.e. the last piece of diagnostic it still had. The falsy
// check keeps `HTTP <status>` as the floor. (tools/status.ts's
// composeTailnetStatusData, which backs tailnetStatusResource, uses the same
// `||` on its own errors bag for the same reason.)
export async function tailnetDevicesResource(uri: URL) {
  const res = await apiGet(`/tailnet/${getTailnet()}/devices`);
  const text = res.ok
    ? JSON.stringify(res.data, null, 2)
    : JSON.stringify({ error: res.error || `HTTP ${res.status}` }, null, 2);
  return { contents: [{ uri: uri.href, text, mimeType: "application/json" }] };
}

export async function tailnetAclResource(uri: URL) {
  const res = await apiGet(`/tailnet/${getTailnet()}/acl`, { acceptRaw: true, accept: "application/hujson" });
  if (res.ok) {
    return { contents: [{ uri: uri.href, text: res.rawBody ?? "", mimeType: "application/hujson" }] };
  }
  // The Tailscale HuJSON validator returns multi-line errors. Prefix every
  // line so the failure body stays HuJSON-parseable -- otherwise lines 2+
  // would land outside the // comment and a downstream tailscale_update_acl
  // that round-trips this rawBody would 400.
  // `||` not `??` -- see tailnetDevicesResource above. An empty body must not
  // render a bare `// Error: ` comment that names nothing.
  const lines = `Error: ${res.error || `HTTP ${res.status}`}`.split("\n");
  const text = `${lines.map((l) => `// ${l}`).join("\n")}\n`;
  return { contents: [{ uri: uri.href, text, mimeType: "application/hujson" }] };
}

export async function tailnetDnsResource(uri: URL) {
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
  // `||` not `??` on all four slots -- see tailnetDevicesResource above. An
  // empty-body failure would otherwise park "" in the bag, which reads as
  // "this slot failed for no reason" instead of naming the status.
  if (!nameservers.ok) errors.nameservers = nameservers.error || `HTTP ${nameservers.status}`;
  if (!searchPaths.ok) errors.searchPaths = searchPaths.error || `HTTP ${searchPaths.status}`;
  if (!splitDns.ok) errors.splitDns = splitDns.error || `HTTP ${splitDns.status}`;
  if (!preferences.ok) errors.preferences = preferences.error || `HTTP ${preferences.status}`;
  if (Object.keys(errors).length > 0) data.errors = errors;
  return { contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
}
