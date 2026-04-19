/**
 * Tool filtering driven by TAILSCALE_TOOLS and TAILSCALE_READONLY env vars.
 *
 * - TAILSCALE_TOOLS="devices,acl,dns"  → include only tools from those groups.
 * - TAILSCALE_READONLY="1" | "true"    → include only tools with readOnlyHint: true.
 * - Both combine (intersection).
 * - No env vars                        → all tools. Backward compatible.
 */

type Annotated = { annotations: { readOnlyHint?: boolean | undefined } };

export interface FilterOptions {
  tools?: string | undefined;
  readonly?: string | undefined;
}

export interface FilterResult<T> {
  tools: T[];
  unknownGroups: string[];
}

export function filterTools<T extends Annotated>(
  groups: Record<string, ReadonlyArray<T>>,
  options: FilterOptions,
): FilterResult<T> {
  const enabledGroups = options.tools
    ? new Set(
        options.tools
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;

  const readonly = options.readonly === "1" || options.readonly === "true";

  const validNames = new Set(Object.keys(groups));
  const unknownGroups = enabledGroups ? [...enabledGroups].filter((g) => !validNames.has(g)) : [];

  const out: T[] = [];
  for (const [name, tools] of Object.entries(groups)) {
    if (enabledGroups && !enabledGroups.has(name)) continue;
    for (const t of tools) {
      if (readonly && t.annotations.readOnlyHint !== true) continue;
      out.push(t);
    }
  }
  return { tools: out, unknownGroups };
}
