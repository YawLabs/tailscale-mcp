/**
 * Tool filtering driven by TAILSCALE_PROFILE, TAILSCALE_TOOLS, and TAILSCALE_READONLY env vars.
 *
 * - TAILSCALE_PROFILE="minimal" | "core" | "full"  → preset group sets.
 * - TAILSCALE_TOOLS="devices,acl,dns"              → include only tools from those groups.
 *                                                    Overrides TAILSCALE_PROFILE when both are set.
 * - TAILSCALE_READONLY="1" | "true"                → include only tools with readOnlyHint: true.
 * - TAILSCALE_WRITE_GROUPS="devices,keys"         → writes are served ONLY in those groups; every
 *                                                    other loaded group is served read-only.
 *                                                    Unset = no write gate (today's behaviour).
 * - Filters combine as intersection.
 * - No env vars                                    → all tools. Backward compatible.
 */

type Annotated = { annotations: { readOnlyHint?: boolean | undefined } };

export interface FilterOptions {
  tools?: string | undefined;
  readonly?: string | undefined;
  profile?: string | undefined;
  writeGroups?: string | undefined;
}

export interface FilterResult<T> {
  tools: T[];
  // Group names from an explicitly-set TAILSCALE_TOOLS that aren't registered.
  // Operator-fixable (a typo), so callers word the warning that way. Only ever
  // sourced from TAILSCALE_TOOLS -- see `unknownProfileGroups` for the other
  // provenance, which used to be conflated into this field and produced a
  // warning blaming TAILSCALE_TOOLS for a name the operator never typed.
  unknownGroups: string[];
  // Group names the APPLIED profile preset references that aren't registered.
  // Always empty in a correct build: every name in PROFILES is a group the
  // caller registers unconditionally. A non-empty value means PROFILES and the
  // tool registry have drifted -- a package bug, not operator error -- so
  // callers should word that warning differently. Absent when empty.
  unknownProfileGroups?: string[];
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
  // The write grant that ACTUALLY applied, after dropping unregistered names and
  // intersecting with the loaded set. An empty array means "configured, granted
  // nothing" (every write withheld); ABSENT means the knob was never set, which is
  // the no-gate default. Those two states render differently in the banner and must
  // not be conflated -- `write=none` is a deliberate lockdown, no `write=` segment
  // at all is today's unrestricted behaviour.
  writeGroups?: string[];
  // Names in TAILSCALE_WRITE_GROUPS that are not registered groups -- a typo.
  // Operator-fixable, and reported separately from `writeGroupsNotLoaded` because the
  // two have different fixes: this one means "you misspelled it", that one means
  // "spelled right, but your load filter excluded it".
  unknownWriteGroups?: string[];
  // Registered groups the operator granted writes to that their TAILSCALE_TOOLS /
  // TAILSCALE_PROFILE filter never loaded. The grant is a silent no-op without this.
  writeGroupsNotLoaded?: string[];
  // True iff TAILSCALE_READONLY won over a non-empty write grant. Reported so the
  // banner can say WHICH knob produced the lockdown; without it an operator who set
  // both sees no writes and cannot tell which one to change.
  writeGroupsOverriddenByReadonly?: boolean;
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
/**
 * Parse a comma-separated group list (TAILSCALE_TOOLS, TAILSCALE_WRITE_GROUPS).
 *
 * Returns null for unset, empty, whitespace-only and commas-only, all of which mean
 * "the operator did not configure this knob". That is deliberate and load-bearing for
 * TAILSCALE_WRITE_GROUPS in particular: `-e TAILSCALE_WRITE_GROUPS` in docker, or an
 * unexpanded `${VAR}` in a shell wrapper, both produce the empty string, and treating
 * that as "revoke every write" would turn a config typo into a silent outage on upgrade.
 *
 * Case-SENSITIVE, matching the registry keys exactly. Both knobs name the same groups,
 * so folding case in one and not the other would make `Devices` mean different things
 * in two adjacent variables.
 */
export function parseGroupList(value: string | undefined): string[] | null {
  if (!value) return null;
  const parsed = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : null;
}

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

  // Treat all-whitespace / comma-only inputs as "not set" rather than "zero groups",
  // so a misconfigured TAILSCALE_TOOLS=" " doesn't silently yield an empty server.
  // Shared with TAILSCALE_WRITE_GROUPS below rather than duplicated: the two knobs
  // speak the same vocabulary, and an operator who learns one parse rule should not
  // discover the other spells it differently.
  const explicitTools = parseGroupList(options.tools);

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
  // fell back above, so the warning can name the typos. Scoped to TAILSCALE_TOOLS
  // ONLY: the previous form fell through to the effective group set, so a profile
  // preset naming an unregistered group surfaced here and the caller reported it
  // as "TAILSCALE_TOOLS includes unknown group(s)" even when TAILSCALE_TOOLS was
  // never set. Unreachable with today's PROFILES, but the moment a preset names a
  // conditionally-registered group (e.g. "local-cli", which is only added when
  // TAILSCALE_LOCAL_CLI is on) the misattribution goes live.
  const unknownGroups = explicitTools ? explicitTools.filter((g) => !validNames.has(g)) : [];
  // Only report profile drift when the profile ACTUALLY applied -- if explicit
  // tools won precedence, the preset's contents never affected the tool set and
  // warning about them would be noise.
  const unknownProfileGroups =
    profileGroups && !effectiveExplicitTools ? profileGroups.filter((g) => !validNames.has(g)) : [];

  const readonly = parseReadonlyFlag(options.readonly);

  // Write scope. NOTE the deliberate inversion of the all-unknown fallback that
  // TAILSCALE_TOOLS gets above: a typo'd LOAD filter falls back to loading more, whose
  // worst case is a chatty server, while a typo'd WRITE grant that fell back the same
  // way would hand an agent every write at the moment its operator was restricting
  // it -- fail-open, triggered by the input a careless operator is most likely to
  // produce. So there is no fallback here: anything this gate does not positively
  // recognise is not writable. Same direction as `readOnlyHint !== true` below.
  // The degraded state is also survivable rather than an outage: every read tool still
  // registers, so the agent can still explain the problem.
  const requestedWriteGroups = parseGroupList(options.writeGroups);
  const unknownWriteGroups = requestedWriteGroups ? requestedWriteGroups.filter((g) => !validNames.has(g)) : [];
  // null = knob unset = no gate. A Set (possibly empty) = configured.
  const writeScope = requestedWriteGroups ? new Set(requestedWriteGroups.filter((g) => validNames.has(g))) : null;

  const out: T[] = [];
  for (const [name, tools] of Object.entries(groups)) {
    if (enabledGroups && !enabledGroups.has(name)) continue;
    // ONE write predicate for both knobs, so readonly is simply the strongest input to
    // the same question rather than a second code path that could drift from it.
    const writesAllowed = !readonly && (writeScope === null || writeScope.has(name));
    for (const t of tools) {
      // `!== true`, not `=== false`: a tool that forgot its annotation is treated as a
      // write and withheld unless its group was granted. Adding the write gate here
      // rather than beside it means that fail-closed guard now covers both knobs.
      if (t.annotations.readOnlyHint !== true && !writesAllowed) continue;
      out.push(t);
    }
  }

  const result: FilterResult<T> = { tools: out, unknownGroups };
  if (unknownProfileGroups.length > 0) result.unknownProfileGroups = unknownProfileGroups;
  if (unknownProfile) result.unknownProfile = unknownProfile;
  // Report against the EFFECTIVE filter: when an all-unknown TAILSCALE_TOOLS was
  // ignored, the profile (if any) actually applied, so surface profileGroups and
  // not a spurious explicitTools "override".
  if (profileGroups && !effectiveExplicitTools) result.profileGroups = profileGroups;
  if (effectiveExplicitTools) result.explicitTools = effectiveExplicitTools;
  if (profileWouldFilter) result.profileWouldFilter = true;
  if (explicitToolsAllUnknown) result.toolsAllUnknown = true;
  // Write-gate provenance is resolved HERE and returned, never re-derived by the
  // banner. filter.ts already carries one bug of that shape in its history -- the
  // unknownGroups / unknownProfileGroups split above exists because a warning blamed
  // TAILSCALE_TOOLS for a name the operator had never typed. One resolver, one truth.
  if (writeScope) {
    const loaded = [...writeScope].filter((g) => !enabledGroups || enabledGroups.has(g));
    result.writeGroups = readonly ? [] : loaded.sort();
    // Only flag the override when a grant was actually overridden: READONLY=1 with an
    // all-typo grant already yields nothing, and blaming readonly there would point the
    // operator at the wrong knob.
    const overridden = readonly && writeScope.size > 0;
    if (overridden) result.writeGroupsOverriddenByReadonly = true;
    // Exactly ONE cause is reported. Under readonly the grant was void before the load
    // filter could matter, so also saying "you named an unloaded group" would hand the
    // operator two fixes for a config where neither name is the operative problem.
    const notLoaded = overridden ? [] : [...writeScope].filter((g) => enabledGroups && !enabledGroups.has(g));
    if (notLoaded.length > 0) result.writeGroupsNotLoaded = notLoaded.sort();
  }
  if (unknownWriteGroups.length > 0) result.unknownWriteGroups = unknownWriteGroups;
  return result;
}
