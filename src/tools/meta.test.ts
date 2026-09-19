import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildToolGroups } from "../server-wiring.js";
import { buildGroupReports, buildMetaTools, type CatalogState, explainTool } from "./meta.js";

/**
 * The catalog exists to make three cases distinguishable in-band, so most of what
 * matters here is that they do not collapse into each other. Every diagnostic this
 * server prints about its own configuration goes to stderr, which the model never
 * sees -- "no such tool" and "withheld by config" are the same observation to an
 * agent without this, and only one of them means "find another way".
 */

const registry: Record<string, ReadonlyArray<{ name: string; annotations: { readOnlyHint?: boolean } }>> = {
  devices: [
    { name: "list_devices", annotations: { readOnlyHint: true } },
    { name: "delete_device", annotations: { readOnlyHint: false } },
  ],
  dns: [
    { name: "get_dns", annotations: { readOnlyHint: true } },
    { name: "set_dns", annotations: { readOnlyHint: false } },
  ],
  audit: [{ name: "get_audit", annotations: { readOnlyHint: true } }],
  "local-cli": [{ name: "local_status", annotations: { readOnlyHint: true } }],
};

function state(over: Partial<CatalogState> = {}): CatalogState {
  return {
    fullRegistry: registry,
    registeredNames: new Set(["list_devices", "delete_device", "get_dns", "set_dns", "get_audit"]),
    toolsEnv: undefined,
    profileEnv: undefined,
    writeGroupsEnv: undefined,
    readonlyMode: false,
    localCliEnabled: false,
    ...over,
  };
}

describe("explainTool", () => {
  it("separates a nonexistent tool from a withheld one", () => {
    // THE distinction the whole tool exists for. Only this case means the agent
    // should stop asking and find another approach.
    const missing = explainTool("tailscale_reboot_device", state());
    assert.equal(missing.available, false);
    assert.equal("group" in missing, false, "a nonexistent tool belongs to no group");
    assert.match(missing.reason, /no tool by that name exists/);
    assert.equal("toEnable" in missing, false, "no env change can produce it");
  });

  it("reports an available tool as callable", () => {
    const r = explainTool("delete_device", state());
    assert.equal(r.available, true);
    assert.equal((r as { group: string }).group, "devices");
    assert.equal((r as { kind: string }).kind, "write");
  });

  it("blames the write gate when the group loaded but the tool did not", () => {
    const r = explainTool("delete_device", {
      ...state({ writeGroupsEnv: "dns" }),
      registeredNames: new Set(["list_devices", "get_dns", "set_dns", "get_audit"]),
    });
    assert.equal(r.available, false);
    assert.equal((r as { group: string }).group, "devices");
    assert.match((r as { reason: string }).reason, /TAILSCALE_WRITE_GROUPS is set to "dns"/);
    // The remedy must be pasteable, not a gesture: it carries the CURRENT value so
    // the operator does not have to reconstruct it.
    assert.equal((r as { toEnable: string }).toEnable, 'add "devices" to TAILSCALE_WRITE_GROUPS (e.g. "dns,devices")');
  });

  it("blames the load filter when nothing from the group registered", () => {
    const r = explainTool("delete_device", {
      ...state({ toolsEnv: "dns" }),
      registeredNames: new Set(["get_dns", "set_dns"]),
    });
    assert.match((r as { reason: string }).reason, /TAILSCALE_TOOLS is set to "dns"/);
    assert.equal((r as { toEnable: string }).toEnable, 'add "devices" to TAILSCALE_TOOLS');
  });

  it("blames readonly ahead of the write gate, since readonly wins", () => {
    // Both are "writes are withheld", but only one is the operative cause -- naming
    // the write gate here would send the operator to change a variable that would
    // still leave writes off.
    const r = explainTool("delete_device", {
      ...state({ readonlyMode: true, writeGroupsEnv: "devices" }),
      registeredNames: new Set(["list_devices", "get_dns", "get_audit"]),
    });
    assert.match((r as { reason: string }).reason, /TAILSCALE_READONLY is enabled/);
    assert.equal((r as { toEnable: string }).toEnable, "unset TAILSCALE_READONLY");
  });

  it("names the opt-in for a group that is off rather than a load filter", () => {
    const r = explainTool("local_status", state({ toolsEnv: "devices" }));
    assert.match((r as { reason: string }).reason, /opt-in and is not enabled/);
    assert.equal((r as { toEnable: string }).toEnable, "set TAILSCALE_LOCAL_CLI=1");
  });

  it("trims a padded tool name rather than reporting it nonexistent", () => {
    const r = explainTool("  delete_device  ", state());
    assert.equal(r.available, true);
  });
});

describe("buildGroupReports", () => {
  it("marks a fully-served group full and adds no remedy", () => {
    const devices = buildGroupReports(state()).find((g) => g.group === "devices");
    assert.equal(devices?.status, "full");
    assert.equal(devices?.toEnable, undefined, "nothing to enable");
    assert.equal(devices?.writesAvailable, 1);
  });

  it("marks a loaded group whose writes are withheld read-only", () => {
    const reports = buildGroupReports({
      ...state({ writeGroupsEnv: "dns" }),
      registeredNames: new Set(["list_devices", "get_dns", "set_dns", "get_audit"]),
    });
    const devices = reports.find((g) => g.group === "devices");
    assert.equal(devices?.status, "read-only");
    assert.equal(devices?.available, 1, "the read still serves");
    assert.equal(devices?.writesAvailable, 0);
    assert.match(devices?.toEnable ?? "", /add "devices" to TAILSCALE_WRITE_GROUPS/);
  });

  it("calls a write-free group full, not read-only", () => {
    // `audit` has no write tools, so no grant could ever add one. Reporting it as
    // read-only would imply an env change exists that does nothing.
    const audit = buildGroupReports(state()).find((g) => g.group === "audit");
    assert.equal(audit?.status, "full");
    assert.equal(audit?.writes, 0);
    assert.equal(audit?.toEnable, undefined);
  });

  it("marks an unregistered group unavailable with its own cause", () => {
    const localCli = buildGroupReports(state()).find((g) => g.group === "local-cli");
    assert.equal(localCli?.status, "unavailable");
    assert.equal(localCli?.available, 0);
    assert.equal(localCli?.toEnable, "set TAILSCALE_LOCAL_CLI=1");
  });

  it("counts a tool with a missing readOnlyHint as a write, matching the filter", () => {
    // filter.ts withholds on `readOnlyHint !== true`. If this file counted an
    // un-annotated tool as a read, the catalog would advertise a write surface the
    // server does not serve.
    const odd = { devices: [{ name: "no_hint", annotations: {} }] };
    const r = buildGroupReports(state({ fullRegistry: odd, registeredNames: new Set() }));
    assert.equal(r[0]?.writes, 1, "un-annotated counts as a write here too");
  });
});

describe("the catalog tool over the real registry", () => {
  const full = buildToolGroups({ TAILSCALE_LOCAL_CLI: "1" });

  it("is read-only and touches no network", () => {
    const [tool] = buildMetaTools(state());
    assert.equal(tool?.annotations.readOnlyHint, true);
    assert.equal(tool?.annotations.destructiveHint, false);
    // The only tool in this server that reports its own process rather than calling
    // the API, so it cannot fail on credentials, scope or connectivity.
    assert.equal(tool?.annotations.openWorldHint, false);
  });

  it("is not a member of the Tailscale API registry", () => {
    // Admitting it to buildToolGroups would make the README's "N admin-API tools"
    // false and shift every count derived from that registry.
    const names = Object.values(full)
      .flat()
      .map((t) => t.name);
    assert.ok(!names.includes("tailscale_tool_groups"), "the catalog is registered beside the registry, not inside it");
  });

  it("accounts for every registered tool with no unexplained gaps", async () => {
    // A whole-registry sweep: with no filters, every group must be `full` and the
    // per-group totals must sum to the registry. A group silently missing from the
    // report would be invisible to an agent exactly like the tool it is meant to
    // explain.
    const registeredNames = new Set(
      Object.values(full)
        .flat()
        .map((t) => t.name),
    );
    const reports = buildGroupReports(state({ fullRegistry: full, registeredNames, localCliEnabled: true }));
    assert.deepEqual(reports.map((r) => r.group).sort(), Object.keys(full).sort(), "every group is reported");
    assert.deepEqual(
      reports.filter((r) => r.status !== "full").map((r) => r.group),
      [],
      "nothing is withheld when nothing is configured",
    );
    assert.equal(
      reports.reduce((n, r) => n + r.tools, 0),
      registeredNames.size,
      "the reported totals sum to the registry",
    );
  });

  it("answers about a real withheld tool with a pasteable remedy", async () => {
    const registeredNames = new Set(
      Object.entries(full)
        .flatMap(([g, tools]) => tools.filter((t) => t.annotations.readOnlyHint === true || g === "dns"))
        .map((t) => t.name),
    );
    const [tool] = buildMetaTools(state({ fullRegistry: full, registeredNames, writeGroupsEnv: "dns" }));
    const res = (await tool?.handler({ toolName: "tailscale_update_acl" })) as {
      ok: boolean;
      data: { available: boolean; group: string; toEnable: string };
    };
    assert.equal(res.data.available, false);
    assert.equal(res.data.group, "acl");
    assert.match(res.data.toEnable, /add "acl" to TAILSCALE_WRITE_GROUPS/);
  });

  it("tells the agent not to work around a withheld tool", async () => {
    const [tool] = buildMetaTools(state());
    const res = (await tool?.handler({})) as { data: { guidance: string; activeFilters: string[] } };
    // The behavioural instruction is the point: an agent that treats "withheld" as
    // "impossible" is the failure this tool exists to prevent.
    assert.match(res.data.guidance, /Do not work around it/);
    assert.match(res.data.guidance, /report the `toEnable` value to the human/);
  });

  it("says plainly when nothing is filtered", async () => {
    const registeredNames = new Set(
      Object.values(full)
        .flat()
        .map((t) => t.name),
    );
    const [tool] = buildMetaTools(state({ fullRegistry: full, registeredNames, localCliEnabled: true }));
    const res = (await tool?.handler({})) as { data: { summary: string; activeFilters: string[] } };
    assert.match(res.data.summary, /nothing is withheld by configuration/);
    assert.deepEqual(res.data.activeFilters, ["TAILSCALE_LOCAL_CLI=1"]);
  });
});
