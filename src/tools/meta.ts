import type { ZodObject, ZodRawShape } from "zod";
import { z } from "zod";

/**
 * The one tool that is ALWAYS registered, whatever the filters say.
 *
 * Every other diagnostic this server produces about its own configuration goes to
 * stderr -- which the operator reads and the model never does. So an agent asked to
 * delete a device under `TAILSCALE_WRITE_GROUPS=dns` simply finds no such tool, and
 * cannot tell the three cases apart:
 *
 *   1. the tool does not exist in this server at all (wrong expectation)
 *   2. it exists, but its group was never loaded (TAILSCALE_TOOLS / _PROFILE)
 *   3. it exists and loaded, but writes are withheld there (WRITE_GROUPS / READONLY)
 *
 * Only (1) means "find another way". Treating (2) and (3) as (1) is what makes an
 * agent invent a workaround -- shelling out to curl, or editing the ACL to achieve
 * what a withheld device call would have done -- which is worse than the call the
 * operator withheld. This tool makes the distinction answerable in-band.
 *
 * Deliberately NOT part of buildToolGroups: that registry is the Tailscale API
 * surface, every count in the README and in release-metadata.test.ts derives from
 * it, and the README's "N admin-API tools" must keep being true. index.ts
 * registers this one alongside the filtered set, so no filter can reach it.
 */

/** The shape this tool needs from each registry entry. */
interface RegistryTool {
  name: string;
  annotations: { readOnlyHint?: boolean };
}

/**
 * Everything the catalog reasons about, resolved by the caller.
 *
 * `registeredNames` is the ground truth for availability -- what the server actually
 * served -- rather than a re-derivation of the filter logic. The config fields are
 * used ONLY to phrase the remedy. That split matters: a bug in this file can then
 * produce a wrong SUGGESTION but never a wrong ANSWER about what is available, and
 * the status can never drift from what filterTools decided.
 */
export interface CatalogState {
  /** Every group that could exist, including opt-ins that are currently off. */
  fullRegistry: Record<string, ReadonlyArray<RegistryTool>>;
  /** Names actually registered on this server. */
  registeredNames: ReadonlySet<string>;
  /** Raw env, read only to phrase remedies. */
  toolsEnv: string | undefined;
  profileEnv: string | undefined;
  writeGroupsEnv: string | undefined;
  readonlyMode: boolean;
  localCliEnabled: boolean;
}

type GroupStatus = "full" | "read-only" | "unavailable";

interface GroupReport {
  group: string;
  status: GroupStatus;
  tools: number;
  available: number;
  writes: number;
  writesAvailable: number;
  /** Absent when status is "full". */
  reason?: string;
  /** Absent when status is "full". The exact env change, not a gesture at one. */
  toEnable?: string;
}

/** Why a group is not loaded at all, and what would load it. */
function explainNotLoaded(group: string, state: CatalogState): { reason: string; toEnable: string } {
  if (group === "local-cli" && !state.localCliEnabled) {
    return {
      reason: "the local-CLI group is opt-in and is not enabled in this process",
      toEnable: "set TAILSCALE_LOCAL_CLI=1",
    };
  }
  if (state.toolsEnv) {
    return {
      reason: `TAILSCALE_TOOLS is set to "${state.toolsEnv}", which does not include this group`,
      toEnable: `add "${group}" to TAILSCALE_TOOLS`,
    };
  }
  if (state.profileEnv) {
    return {
      reason: `TAILSCALE_PROFILE="${state.profileEnv}" does not include this group`,
      toEnable: `set TAILSCALE_PROFILE=full, or list the groups you want in TAILSCALE_TOOLS`,
    };
  }
  // No load filter is set and the group still did not register. Unreachable with
  // today's registry (local-cli is the only conditional group and is handled above),
  // so say so rather than inventing a remedy that would send the operator chasing a
  // variable they never set.
  return {
    reason: "this group did not register, and no load filter is configured to explain why",
    toEnable:
      "no env change is known to enable it -- please report this at https://github.com/YawLabs/tailscale-mcp/issues",
  };
}

/** Why a loaded group's writes are withheld, and what would restore them. */
function explainWritesWithheld(group: string, state: CatalogState): { reason: string; toEnable: string } {
  if (state.readonlyMode) {
    return {
      reason: "TAILSCALE_READONLY is enabled, so no group serves writes",
      toEnable: "unset TAILSCALE_READONLY",
    };
  }
  const current = state.writeGroupsEnv?.trim();
  return {
    reason: current
      ? `TAILSCALE_WRITE_GROUPS is set to "${current}", which does not grant writes here`
      : "writes are withheld in this group",
    toEnable: current
      ? `add "${group}" to TAILSCALE_WRITE_GROUPS (e.g. "${current},${group}")`
      : `add "${group}" to TAILSCALE_WRITE_GROUPS`,
  };
}

/** Per-group availability, derived from what actually registered. */
export function buildGroupReports(state: CatalogState): GroupReport[] {
  const reports: GroupReport[] = [];
  for (const [group, tools] of Object.entries(state.fullRegistry)) {
    const available = tools.filter((t) => state.registeredNames.has(t.name));
    // `!== true`, matching the filter's own fail-closed predicate, so a tool with a
    // missing annotation is counted as a write here too. Counting it as a read would
    // make this tool report a write surface the server does not actually serve.
    const writes = tools.filter((t) => t.annotations.readOnlyHint !== true);
    const writesAvailable = writes.filter((t) => state.registeredNames.has(t.name));

    const base = {
      group,
      tools: tools.length,
      available: available.length,
      writes: writes.length,
      writesAvailable: writesAvailable.length,
    };

    if (available.length === 0) {
      reports.push({ ...base, status: "unavailable", ...explainNotLoaded(group, state) });
      continue;
    }
    // A group with no write tools at all is "full" once loaded -- reporting it as
    // read-only would imply a grant could add something, and no grant can.
    if (writes.length > 0 && writesAvailable.length === 0) {
      reports.push({ ...base, status: "read-only", ...explainWritesWithheld(group, state) });
      continue;
    }
    reports.push({ ...base, status: "full" });
  }
  return reports;
}

/** Diagnose one specific tool name. */
export function explainTool(toolName: string, state: CatalogState) {
  const query = toolName.trim();
  for (const [group, tools] of Object.entries(state.fullRegistry)) {
    const tool = tools.find((t) => t.name === query);
    if (!tool) continue;

    const isWrite = tool.annotations.readOnlyHint !== true;
    if (state.registeredNames.has(query)) {
      return {
        tool: query,
        available: true,
        group,
        kind: isWrite ? ("write" as const) : ("read" as const),
        reason: "this tool is registered and callable right now",
      };
    }
    // Registered nothing from this group at all -> a load problem. Otherwise the
    // group loaded and this specific tool was dropped, which only the write gate
    // does. Distinguishing them is the whole point: they have different fixes.
    const groupHasAny = tools.some((t) => state.registeredNames.has(t.name));
    const explain = groupHasAny ? explainWritesWithheld(group, state) : explainNotLoaded(group, state);
    return {
      tool: query,
      available: false,
      group,
      kind: isWrite ? ("write" as const) : ("read" as const),
      ...explain,
    };
  }

  return {
    tool: query,
    available: false,
    // The case an agent most needs separated from the others: no configuration
    // change will produce this tool, so retrying or asking the operator is wasted.
    // Only here is "find another way" the right conclusion.
    reason:
      "no tool by that name exists in this server, under any configuration. Check the spelling, or call this tool with no arguments to see what is available.",
  };
}

/**
 * Mirrors server-wiring.ts's `Tool` shape, declared locally rather than imported:
 * server-wiring.ts imports every tools/* module, so importing it back here would be
 * a cycle. The handler uses METHOD SHORTHAND for the same reason `Tool` does -- it
 * gets bivariant parameter checking, so a narrowly-typed handler is assignable to
 * the `(input: unknown)` slot wrapToolHandler expects, with no cast at the call site.
 */
export type MetaTool = {
  name: string;
  description: string;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  inputSchema: ZodObject<ZodRawShape>;
  handler(input: unknown): Promise<unknown>;
};

export function buildMetaTools(state: CatalogState): ReadonlyArray<MetaTool> {
  return [
    {
      name: "tailscale_tool_groups",
      description:
        "Explain which of this server's tools are available and why. Call this FIRST when a Tailscale tool you expected is missing, instead of assuming the capability does not exist -- tools can be withheld by configuration, and the fix is usually one environment variable. " +
        "Pass `toolName` to ask about one specific tool (e.g. 'tailscale_delete_device'): the answer distinguishes 'no such tool exists' -- where you should find another approach -- from 'it exists but its group is not loaded' and 'it exists and loaded but writes are withheld there', both of which the operator can enable and neither of which you should work around. " +
        "With no arguments it lists every group with its availability and, where something is withheld, the exact environment change that would restore it. Always available regardless of filters.",
      annotations: {
        title: "Explain available tools",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // The only tool here that touches no network: it reports this process's own
        // configuration, so it cannot fail on credentials, scope or connectivity.
        openWorldHint: false,
      },
      inputSchema: z.object({
        toolName: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("A specific tool to ask about, e.g. 'tailscale_delete_device'. Omit to list every group."),
      }),
      handler: async (input: { toolName?: string }) => {
        if (input.toolName) {
          return { ok: true, data: explainTool(input.toolName, state) };
        }
        const groups = buildGroupReports(state);
        const withheld = groups.filter((g) => g.status !== "full");
        const totalTools = groups.reduce((n, g) => n + g.tools, 0);
        const totalAvailable = groups.reduce((n, g) => n + g.available, 0);
        const activeFilters = [
          state.profileEnv ? `TAILSCALE_PROFILE=${state.profileEnv}` : null,
          state.toolsEnv ? `TAILSCALE_TOOLS=${state.toolsEnv}` : null,
          state.readonlyMode ? "TAILSCALE_READONLY=1" : null,
          state.writeGroupsEnv?.trim() ? `TAILSCALE_WRITE_GROUPS=${state.writeGroupsEnv.trim()}` : null,
          state.localCliEnabled ? "TAILSCALE_LOCAL_CLI=1" : null,
        ].filter(Boolean);

        return {
          ok: true,
          data: {
            summary:
              withheld.length === 0
                ? `All ${totalAvailable} tools are available; nothing is withheld by configuration.`
                : `${totalAvailable} of ${totalTools} tools are available. ${withheld.length} group(s) are limited by configuration -- see \`groups\` for the exact environment change for each.`,
            activeFilters: activeFilters.length > 0 ? activeFilters : ["none -- no filters are configured"],
            groups,
            // Addressed to the model, because it is the model that has to decide
            // what to do next when a tool is absent.
            guidance:
              "A tool listed as unavailable here EXISTS -- it is withheld by this server's configuration, not missing from the API. Do not work around it by using a different tool to achieve the same effect; report the `toEnable` value to the human instead, since only they can change it.",
          },
        };
      },
    },
  ];
}
