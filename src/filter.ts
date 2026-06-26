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
  // Parsed, non-empty TAILSCALE_TOOLS list when it actually filtered. Absent
  // when TOOLS was unset, whitespace-only, or commas-only (all of which fall
  // back to profile/no-filter). Exposed so the startup banner can tell
  // "profile was overridden by tools" from "profile applied normally" --
  // without it, callers would have to re-implement the parse/empty handling
  // below and stay in sync with future tweaks.
  explicitTools?: string[];
  // True iff TAILSCALE_PROFILE resolved to a preset that would actively reduce
  // the tool surface (i.e. the preset is non-empty). Lets the banner say
  // "profile=core (overridden by TAILSCALE_TOOLS)" while NOT saying the same
  // about profile=full -- "full" is a no-op preset, so calling it overridden
  // would suggest something substantive was lost when nothing was. Set
  // regardless of whether explicit tools won precedence.
  profileWouldFilter?: boolean;
  // True iff TAILSCALE_TOOLS was set but EVERY name was unknown, so it was
  // ignored as a group filter (falling back to profile / no-filter) rather
  // than yielding a zero-tool server. Lets the banner / startup warning report
  // the fallback. `unknownGroups` still names the offending entries.
  toolsAllUnknown?: boolean;
}

export const PROFILES: Record<string, readonly string[]> = {
  minimal: ["status", "devices", "audit"],
  core: ["status", "devices", "acl", "dns", "keys", "users", "audit"],
  full: [], // empty = all groups
};

/**
 * Predicate: is the readonly-mode flag enabled for the given env value?
 * Shared between `filterTools` (which drops write tools when true) and the
 * startup banner in index.ts (which renders the `readonly` suffix). Keeping
 * the parse rule in one place prevents the two call sites from drifting --
 * mirrors the `isLocalCliEnabled` pattern in server-wiring.ts.
 *
 * Case-sensitive on purpose: matches TAILSCALE_LOCAL_CLI's exact-string
 * contract, so an operator who sets both follows the same rule.
 */
export function parseReadonlyFlag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function filterTools<T extends Annotated>(
  groups: Record<string, ReadonlyArray<T>>,
  options: FilterOptions,
): FilterResult<T> {
  const validNames = new Set(Object.keys(groups));

  let profileGroups: string[] | undefined;
  let unknownProfile: string | undefined;
  let profileWouldFilter = false;
  if (options.profile) {
    const profileKey = options.profile.trim().toLowerCase();
    // Use Object.hasOwn rather than `in` so prototype-chain names like
    // `toString` / `hasOwnProperty` don't accidentally resolve to inherited
    // members (the latter would crash at `[...preset]` because functions
    // aren't iterable).
    if (Object.hasOwn(PROFILES, profileKey)) {
      const preset = PROFILES[profileKey] as readonly string[];
      // `profileWouldFilter` records "is this preset substantive?" independent
      // of whether explicit tools wins below. `full` is a valid profile but
      // has an empty preset (no filter), so it should not be labelled
      // "overridden" -- there is nothing to override.
      profileWouldFilter = preset.length > 0;
      profileGroups = profileWouldFilter ? [...preset] : undefined;
    } else {
      unknownProfile = profileKey;
    }
  }

  const parsedTools = options.tools
    ? options.tools
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  // Treat all-whitespace / comma-only inputs as "no filter" rather than "zero tools",
  // so a misconfigured TAILSCALE_TOOLS=" " doesn't silently yield an empty server.
  const explicitTools = parsedTools && parsedTools.length > 0 ? parsedTools : null;

  // If TAILSCALE_TOOLS was set but EVERY name is unknown (e.g. a typo'd
  // "devises"), using it as the group filter would yield a zero-tool server.
  // Mirror the whitespace/comma-only guard above: ignore the broken filter and
  // fall back to the profile / no-filter group set, while still reporting the
  // unknown names below so the operator sees (and can fix) the typo. A partial
  // typo (one valid name + one unknown) still filters on the valid name.
  const explicitToolsAllUnknown = explicitTools?.every((g) => !validNames.has(g)) ?? false;
  const effectiveExplicitTools = explicitToolsAllUnknown ? null : explicitTools;

  const effectiveGroups = effectiveExplicitTools ?? profileGroups ?? null;
  const enabledGroups = effectiveGroups ? new Set(effectiveGroups) : null;

  // Report unknown group names from the original explicit request even when we
  // fell back above, so the warning can name the typos.
  const unknownGroups = explicitTools
    ? explicitTools.filter((g) => !validNames.has(g))
    : enabledGroups
      ? [...enabledGroups].filter((g) => !validNames.has(g))
      : [];

  const readonly = parseReadonlyFlag(options.readonly);

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
  // Report against the EFFECTIVE filter: when an all-unknown TAILSCALE_TOOLS was
  // ignored, the profile (if any) actually applied, so surface profileGroups and
  // not a spurious explicitTools "override".
  if (profileGroups && !effectiveExplicitTools) result.profileGroups = profileGroups;
  if (effectiveExplicitTools) result.explicitTools = effectiveExplicitTools;
  if (profileWouldFilter) result.profileWouldFilter = true;
  if (explicitToolsAllUnknown) result.toolsAllUnknown = true;
  return result;
}
