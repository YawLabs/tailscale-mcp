import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterTools, PROFILES, parseReadonlyFlag } from "./filter.js";

type TestTool = { name: string; annotations: { readOnlyHint: boolean } };
const groups: Record<string, ReadonlyArray<TestTool>> = {
  devices: [
    { name: "list_devices", annotations: { readOnlyHint: true } },
    { name: "delete_device", annotations: { readOnlyHint: false } },
  ],
  acl: [
    { name: "get_acl", annotations: { readOnlyHint: true } },
    { name: "update_acl", annotations: { readOnlyHint: false } },
  ],
  dns: [{ name: "get_dns", annotations: { readOnlyHint: true } }],
};

describe("filterTools", () => {
  it("returns every tool when no env vars are set", () => {
    const { tools, unknownGroups } = filterTools(groups, { tools: undefined, readonly: undefined });
    assert.equal(tools.length, 5);
    assert.deepEqual(unknownGroups, []);
  });

  it("restricts to named groups via TAILSCALE_TOOLS", () => {
    const { tools } = filterTools(groups, { tools: "devices,dns", readonly: undefined });
    const names = tools.map((t) => t.name);
    assert.deepEqual(names.sort(), ["delete_device", "get_dns", "list_devices"]);
  });

  it("drops write tools when TAILSCALE_READONLY=1", () => {
    const { tools } = filterTools(groups, { tools: undefined, readonly: "1" });
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["get_acl", "get_dns", "list_devices"]);
  });

  it("drops write tools when TAILSCALE_READONLY=true", () => {
    const { tools } = filterTools(groups, { tools: undefined, readonly: "true" });
    assert.equal(tools.length, 3);
  });

  it("ignores other truthy-looking values for readonly", () => {
    const { tools } = filterTools(groups, { tools: undefined, readonly: "yes" });
    assert.equal(tools.length, 5);
  });

  it("combines group + readonly filters as intersection", () => {
    const { tools } = filterTools(groups, { tools: "acl,dns", readonly: "1" });
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["get_acl", "get_dns"]);
  });

  it("reports unknown group names without throwing", () => {
    const { tools, unknownGroups } = filterTools(groups, { tools: "devices,nope,also-bad", readonly: undefined });
    assert.equal(tools.length, 2);
    assert.deepEqual(unknownGroups.sort(), ["also-bad", "nope"]);
  });

  it("handles whitespace and empty segments in TAILSCALE_TOOLS", () => {
    const { tools, unknownGroups } = filterTools(groups, { tools: " devices , , acl ", readonly: undefined });
    assert.equal(tools.length, 4);
    assert.deepEqual(unknownGroups, []);
  });

  it("falls back to ALL tools when TAILSCALE_TOOLS lists only unknown groups", () => {
    // An all-unknown TAILSCALE_TOOLS (e.g. a typo'd group name) must NOT yield a
    // zero-tool server -- it's ignored as a filter and we fall back to no-filter,
    // while still reporting the unknown names and the toolsAllUnknown flag.
    const { tools, unknownGroups, toolsAllUnknown, explicitTools } = filterTools(groups, {
      tools: "nope,bad",
      readonly: undefined,
    });
    assert.equal(tools.length, 5);
    assert.deepEqual(unknownGroups, ["nope", "bad"]);
    assert.equal(toolsAllUnknown, true);
    // The ignored filter must not be surfaced as if it applied.
    assert.equal(explicitTools, undefined);
  });

  it("falls back to the profile when TAILSCALE_TOOLS is all-unknown and a valid profile is set", () => {
    // The all-unknown tools filter is ignored; the core profile then applies.
    const { tools, toolsAllUnknown, profileGroups, explicitTools } = filterTools(groups, {
      tools: "nope,bad",
      profile: "core",
    });
    // core includes devices,acl,dns from the fixture -> all 5 tools.
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["delete_device", "get_acl", "get_dns", "list_devices", "update_acl"]);
    assert.equal(toolsAllUnknown, true);
    assert.ok(profileGroups?.includes("acl"));
    // explicitTools stays unset because the all-unknown filter was ignored.
    assert.equal(explicitTools, undefined);
  });

  it("a partial typo (one valid group) still filters and does not set toolsAllUnknown", () => {
    const { tools, unknownGroups, explicitTools, toolsAllUnknown } = filterTools(groups, {
      tools: "devices,nope",
      readonly: undefined,
    });
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["delete_device", "list_devices"]);
    assert.deepEqual(unknownGroups, ["nope"]);
    assert.deepEqual(explicitTools, ["devices", "nope"]);
    assert.equal(toolsAllUnknown, undefined);
  });

  it("treats TAILSCALE_TOOLS=all-whitespace as no filter instead of silently yielding zero tools", () => {
    const { tools, unknownGroups } = filterTools(groups, { tools: "   ", readonly: undefined });
    assert.equal(tools.length, 5);
    assert.deepEqual(unknownGroups, []);
  });

  it("treats TAILSCALE_TOOLS=commas-only as no filter", () => {
    const { tools, unknownGroups } = filterTools(groups, { tools: ",,,", readonly: undefined });
    assert.equal(tools.length, 5);
    assert.deepEqual(unknownGroups, []);
  });

  it("treats TAILSCALE_TOOLS=whitespace as no filter and falls back to profile if set", () => {
    const { tools } = filterTools(groups, { tools: "   ", profile: "minimal" });
    // Falls back to minimal profile (devices only in fixture)
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["delete_device", "list_devices"]);
  });

  it("applies TAILSCALE_PROFILE=minimal preset", () => {
    const { tools, profileGroups } = filterTools(groups, { profile: "minimal" });
    // "minimal" = status,devices,audit; only "devices" exists in test fixture
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["delete_device", "list_devices"]);
    assert.deepEqual(profileGroups, ["status", "devices", "audit"]);
  });

  it("applies TAILSCALE_PROFILE=core preset", () => {
    const { tools, profileGroups } = filterTools(groups, { profile: "core" });
    // "core" includes devices,acl,dns from fixture
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["delete_device", "get_acl", "get_dns", "list_devices", "update_acl"]);
    assert.ok(profileGroups?.includes("acl"));
  });

  it("treats TAILSCALE_PROFILE=full as no group filter", () => {
    const { tools, profileGroups } = filterTools(groups, { profile: "full" });
    assert.equal(tools.length, 5);
    assert.equal(profileGroups, undefined);
  });

  it("is case-insensitive and trims whitespace in TAILSCALE_PROFILE", () => {
    const { tools } = filterTools(groups, { profile: "  MINIMAL  " });
    assert.equal(tools.length, 2);
  });

  it("reports unknown profile without throwing and falls back to no filter", () => {
    const { tools, unknownProfile } = filterTools(groups, { profile: "strict-mode" });
    assert.equal(tools.length, 5);
    assert.equal(unknownProfile, "strict-mode");
  });

  it("does not match Object.prototype property names as profiles", () => {
    // `in` walks the prototype chain — `hasOwnProperty` would resolve to a
    // function, then crash at `[...preset]`. Object.hasOwn keeps us honest.
    const { tools, unknownProfile } = filterTools(groups, { profile: "hasOwnProperty" });
    assert.equal(tools.length, 5);
    assert.equal(unknownProfile, "hasownproperty");
  });

  it("does not silently accept Object.prototype.toString as a profile", () => {
    const { tools, unknownProfile } = filterTools(groups, { profile: "toString" });
    assert.equal(tools.length, 5);
    assert.equal(unknownProfile, "tostring");
  });

  it("TAILSCALE_TOOLS overrides TAILSCALE_PROFILE when both set", () => {
    const { tools, profileGroups } = filterTools(groups, { profile: "minimal", tools: "acl" });
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["get_acl", "update_acl"]);
    assert.equal(profileGroups, undefined);
  });

  it("exposes explicitTools when TAILSCALE_TOOLS has content", () => {
    // The startup banner uses this to mark a profile as (overridden by
    // TAILSCALE_TOOLS). Pinning the contract here means a refactor that
    // stops surfacing the parsed list would also flip the banner back to
    // claiming the profile applied when it didn't.
    const { explicitTools } = filterTools(groups, { tools: " devices , acl " });
    assert.deepEqual(explicitTools, ["devices", "acl"]);
  });

  it("does not expose explicitTools when TAILSCALE_TOOLS is whitespace-only", () => {
    // Whitespace TOOLS falls back to profile/no-filter, so the banner must
    // not show 'groups=' for it. The absent explicitTools is the signal.
    const { explicitTools } = filterTools(groups, { tools: "   " });
    assert.equal(explicitTools, undefined);
  });

  it("does not expose explicitTools when TAILSCALE_TOOLS is commas-only", () => {
    const { explicitTools } = filterTools(groups, { tools: ",,," });
    assert.equal(explicitTools, undefined);
  });

  it("does not expose explicitTools when TAILSCALE_TOOLS is unset", () => {
    const { explicitTools } = filterTools(groups, { tools: undefined });
    assert.equal(explicitTools, undefined);
  });

  it("exposes profileWouldFilter=true for substantive presets (minimal/core)", () => {
    // The banner uses this to gate the "(overridden by TAILSCALE_TOOLS)" marker:
    // a substantive profile that gets overridden is worth surfacing; a no-op
    // profile (full) being "overridden" would be a phantom interaction.
    assert.equal(filterTools(groups, { profile: "minimal" }).profileWouldFilter, true);
    assert.equal(filterTools(groups, { profile: "core" }).profileWouldFilter, true);
  });

  it("does not expose profileWouldFilter for profile=full (no-op preset)", () => {
    // `full` is a valid profile but contributes no filter -- so it should not
    // be reported as something that "would have filtered."
    assert.equal(filterTools(groups, { profile: "full" }).profileWouldFilter, undefined);
  });

  it("does not expose profileWouldFilter when profile is unset", () => {
    assert.equal(filterTools(groups, { profile: undefined }).profileWouldFilter, undefined);
  });

  it("does not expose profileWouldFilter for unknown profiles", () => {
    assert.equal(filterTools(groups, { profile: "strict-mode" }).profileWouldFilter, undefined);
  });

  it("reports profileWouldFilter=true even when TAILSCALE_TOOLS overrides the profile", () => {
    // Independence from precedence is the whole point: the banner needs to
    // know "the profile is substantive" even when tools won, so it can label
    // the override accurately.
    const result = filterTools(groups, { profile: "core", tools: "acl" });
    assert.equal(result.profileWouldFilter, true);
    // And profileGroups stays undefined (profile didn't apply), as before.
    assert.equal(result.profileGroups, undefined);
  });

  it("combines TAILSCALE_PROFILE with TAILSCALE_READONLY as intersection", () => {
    const { tools } = filterTools(groups, { profile: "core", readonly: "1" });
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["get_acl", "get_dns", "list_devices"]);
  });

  it("exposes PROFILES as a public constant", () => {
    assert.ok(Array.isArray(PROFILES.minimal));
    assert.ok(Array.isArray(PROFILES.core));
    assert.equal(PROFILES.full.length, 0);
  });
});

describe("parseReadonlyFlag", () => {
  // Shared between filterTools (drops write tools) and index.ts's banner
  // (renders the `readonly` suffix). Pinning the contract here means a
  // refactor that loosens or breaks the parse rule gets caught by tests
  // instead of by an operator seeing the banner disagree with the actual
  // filter result. Mirrors isLocalCliEnabled's coverage in server-wiring.test.ts.
  it("returns true for '1'", () => {
    assert.equal(parseReadonlyFlag("1"), true);
  });
  it("returns true for 'true'", () => {
    assert.equal(parseReadonlyFlag("true"), true);
  });
  it("returns false when undefined", () => {
    assert.equal(parseReadonlyFlag(undefined), false);
  });
  it("returns false for the empty string", () => {
    assert.equal(parseReadonlyFlag(""), false);
  });
  it("returns false for '0'", () => {
    assert.equal(parseReadonlyFlag("0"), false);
  });
  it("returns false for 'false'", () => {
    assert.equal(parseReadonlyFlag("false"), false);
  });
  it("is case-sensitive: 'TRUE' / 'True' / 'YES' do not enable", () => {
    assert.equal(parseReadonlyFlag("TRUE"), false);
    assert.equal(parseReadonlyFlag("True"), false);
    assert.equal(parseReadonlyFlag("yes"), false);
  });
  it("returns false for unrelated truthy-looking values", () => {
    assert.equal(parseReadonlyFlag("on"), false);
    assert.equal(parseReadonlyFlag("enabled"), false);
  });
});
