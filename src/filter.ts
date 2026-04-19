/**
 * Tool filtering driven by TAILSCALE_PROFILE, TAILSCALE_TOOLS, and TAILSCALE_READONLY env vars.
 *
 * - TAILSCALE_PROFILE="minimal" | "core" | "full"  → preset group sets.
 * - TAILSCALE_TOOLS="devices,acl,dns"              → include only tools from those groups.
 *                                                    Overrides TAILSCALE_PROFILE when both are set.
 * - TAILSCALE_READONLY="1" | "true"                → include only tools with readOnlyHint: true.
 * - Filters combine as intersection.
 * - No env vars                                    → all tools. Backward compatible.
 */

type Annotated = { annotations: { readOnlyHint?: boolean | undefined } };

export interface FilterOptions {
  tools?: string | undefined;
  readonly?: string | undefined;
  profile?: string | undefined;
}

export interface FilterResult<T> {
  tools: T[];
  unknownGroups: string[];
  unknownProfile?: string;
  profileGroups?: string[];
}

export const PROFILES: Record<string, readonly string[]> = {
  minimal: ["status", "devices", "audit"],
  core: ["status", "devices", "acl", "dns", "keys", "users", "audit"],
  full: [], // empty = all groups
};

export function filterTools<T extends Annotated>(
  groups: Record<string, ReadonlyArray<T>>,
  options: FilterOptions,
): FilterResult<T> {
  const validNames = new Set(Object.keys(groups));

  let profileGroups: string[] | undefined;
  let unknownProfile: string | undefined;
  if (options.profile) {
    const profileKey = options.profile.trim().toLowerCase();
    if (profileKey in PROFILES) {
      const preset = PROFILES[profileKey] as readonly string[];
      profileGroups = preset.length > 0 ? [...preset] : undefined;
    } else {
      unknownProfile = profileKey;
    }
  }

  const explicitTools = options.tools
    ? options.tools
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  const effectiveGroups = explicitTools ?? profileGroups ?? null;
  const enabledGroups = effectiveGroups ? new Set(effectiveGroups) : null;

  const unknownGroups = enabledGroups ? [...enabledGroups].filter((g) => !validNames.has(g)) : [];

  const readonly = options.readonly === "1" || options.readonly === "true";

  const out: T[] = [];
  for (const [name, tools] of Object.entries(groups)) {
    if (enabledGroups && !enabledGroups.has(name)) continue;
    for (const t of tools) {
      if (readonly && t.annotations.readOnlyHint !== true) continue;
      out.push(t);
    }
  }

  const result: FilterResult<T> = { tools: out, unknownGroups };
  if (unknownProfile) result.unknownProfile = unknownProfile;
  if (profileGroups && !explicitTools) result.profileGroups = profileGroups;
  return result;
}
