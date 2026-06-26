import { apiGet, getTailnet } from "./api.js";
import { composeTailnetStatusData } from "./tools/status.js";

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

export interface BannerFilterInputs {
  // Pulled from the filterTools() result:
  unknownProfile: string | undefined;
  explicitTools: string[] | undefined;
  profileWouldFilter: boolean | undefined;
  // Pulled from env (resolved by the caller so this stays a pure function):
  profileEnv: string | undefined;
  readonlyMode: boolean;
  localCliEnabled: boolean;
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
    inputs.readonlyMode ? "readonly" : null,
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

export async function tailnetDevicesResource(uri: URL) {
  const res = await apiGet(`/tailnet/${getTailnet()}/devices`);
  const text = res.ok
    ? JSON.stringify(res.data, null, 2)
    : JSON.stringify({ error: res.error ?? `HTTP ${res.status}` }, null, 2);
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
  const lines = `Error: ${res.error ?? `HTTP ${res.status}`}`.split("\n");
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
  if (!nameservers.ok) errors.nameservers = nameservers.error ?? `HTTP ${nameservers.status}`;
  if (!searchPaths.ok) errors.searchPaths = searchPaths.error ?? `HTTP ${searchPaths.status}`;
  if (!splitDns.ok) errors.splitDns = splitDns.error ?? `HTTP ${splitDns.status}`;
  if (!preferences.ok) errors.preferences = preferences.error ?? `HTTP ${preferences.status}`;
  if (Object.keys(errors).length > 0) data.errors = errors;
  return { contents: [{ uri: uri.href, text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
}
