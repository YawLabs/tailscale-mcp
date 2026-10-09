import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterTools, PROFILES, parseGroupList, parseReadonlyFlag } from "./filter.js";

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

  it("withholds a tool whose readOnlyHint is missing when readonly is on (fail-closed)", () => {
    // filter.ts guards with `readOnlyHint !== true`, not `=== false`, so a tool
    // that forgot the annotation is treated as a write tool and withheld. The
    // shared `groups` fixture types the hint as REQUIRED, which makes that
    // branch unreachable from it -- hence the local fixture, mirroring the
    // `fullyRegistered` one below. This catches a `=== false` refactor, which
    // would start exposing un-annotated tools under TAILSCALE_READONLY with
    // every other assertion in this file still green.
    const missingHint: Record<string, ReadonlyArray<{ name: string; annotations: { readOnlyHint?: boolean } }>> = {
      devices: [{ name: "no_hint", annotations: {} }],
    };
    const readonlyNames = filterTools(missingHint, { readonly: "1" }).tools.map((t) => t.name);
    assert.deepEqual(readonlyNames, []);
    // ...and the same tool is still served when readonly is off, so a missing
    // hint costs visibility in readonly mode rather than hiding the tool always.
    const openNames = filterTools(missingHint, { readonly: undefined }).tools.map((t) => t.name);
    assert.deepEqual(openNames, ["no_hint"]);
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

  it("treats TAILSCALE_PROFILE=whitespace-only as no filter and reports no unknown profile", () => {
    // "   " is truthy, so it enters the profile branch and trims to "" -- which
    // is not a PROFILES key, so unknownProfile is set to "" and then dropped
    // again by the truthiness check that assembles the result. Pinning the
    // ABSENCE is the point: a refactor to `if (unknownProfile !== undefined)`
    // would start warning the operator about an empty profile name they never
    // typed, and nothing else in the suite would notice either way. Mirrors the
    // whitespace / commas-only TAILSCALE_TOOLS treatment pinned above.
    // `profile: ""` needs no case of its own: being falsy, it short-circuits
    // onto the exact `profile: undefined` path already pinned below.
    const { tools, unknownProfile, profileGroups, profileWouldFilter } = filterTools(groups, { profile: "   " });
    assert.equal(tools.length, 5);
    assert.equal(unknownProfile, undefined, "no phantom warning naming an empty profile");
    assert.equal(profileGroups, undefined);
    assert.equal(profileWouldFilter, undefined);
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

  // --- unknownGroups vs unknownProfileGroups provenance ---
  //
  // These two used to be one field. `unknownGroups` fell through to the
  // EFFECTIVE group set, so when a profile applied, unregistered preset names
  // landed in it -- and index.ts reports that field as
  // "TAILSCALE_TOOLS includes unknown group(s)". An operator who set only
  // TAILSCALE_PROFILE would be told to fix an env var they never touched.
  // The fixture below makes this concrete: it registers devices/acl/dns only,
  // so the `minimal` preset's "status" and "audit" are genuinely unregistered.

  it("does not attribute profile-preset groups to TAILSCALE_TOOLS", () => {
    const { unknownGroups } = filterTools(groups, { profile: "minimal" });
    assert.deepEqual(
      unknownGroups,
      [],
      "unknownGroups must stay empty when TAILSCALE_TOOLS was never set -- it is the operator-typo channel",
    );
  });

  it("reports unregistered profile-preset groups under unknownProfileGroups", () => {
    const { unknownProfileGroups } = filterTools(groups, { profile: "minimal" });
    // minimal = status,devices,audit; the fixture only registers devices.
    assert.deepEqual(unknownProfileGroups?.slice().sort(), ["audit", "status"]);
  });

  it("does not report unknownProfileGroups when every preset group is registered", () => {
    const fullyRegistered: Record<string, ReadonlyArray<TestTool>> = {
      ...groups,
      status: [{ name: "status", annotations: { readOnlyHint: true } }],
      audit: [{ name: "audit", annotations: { readOnlyHint: true } }],
    };
    const { unknownProfileGroups } = filterTools(fullyRegistered, { profile: "minimal" });
    assert.equal(unknownProfileGroups, undefined, "absent when the preset is fully satisfied (the production case)");
  });

  it("does not report unknownProfileGroups when TAILSCALE_TOOLS overrode the profile", () => {
    // The preset never affected the tool set, so warning about its contents
    // would be noise pointing at an inactive code path.
    const { unknownProfileGroups } = filterTools(groups, { profile: "minimal", tools: "acl" });
    assert.equal(unknownProfileGroups, undefined);
  });

  it("keeps both channels populated and separate when TOOLS has a partial typo and the profile is ignored", () => {
    // tools=["devices","nope"] wins precedence (partial typo still filters), so
    // the profile does not apply: TOOLS-typo reported, profile silent.
    const { unknownGroups, unknownProfileGroups } = filterTools(groups, { profile: "minimal", tools: "devices,nope" });
    assert.deepEqual(unknownGroups, ["nope"]);
    assert.equal(unknownProfileGroups, undefined);
  });

  it("reports profile drift when an all-unknown TAILSCALE_TOOLS falls back to the profile", () => {
    // The all-unknown TOOLS filter is ignored, so the profile DOES apply --
    // meaning its unregistered groups are now load-bearing and must surface.
    const { unknownGroups, unknownProfileGroups, toolsAllUnknown } = filterTools(groups, {
      profile: "minimal",
      tools: "nope,bad",
    });
    assert.equal(toolsAllUnknown, true);
    assert.deepEqual(unknownGroups, ["nope", "bad"], "the typos are still named");
    assert.deepEqual(
      unknownProfileGroups?.slice().sort(),
      ["audit", "status"],
      "and the now-active profile is checked",
    );
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

describe("TAILSCALE_WRITE_GROUPS", () => {
  const writeNames = (opts: Parameters<typeof filterTools>[1]) =>
    filterTools(groups, opts)
      .tools.filter((t) => t.annotations.readOnlyHint !== true)
      .map((t) => t.name)
      .sort();

  it("serves every write when the knob is unset, byte-identical to today", () => {
    assert.deepEqual(writeNames({ writeGroups: undefined }), ["delete_device", "update_acl"]);
  });

  it("serves writes only in the granted group, and reads everywhere", () => {
    const { tools, writeGroups } = filterTools(groups, { writeGroups: "devices" });
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["delete_device", "get_acl", "get_dns", "list_devices"],
      "an ungranted group keeps its READ tools -- this bounds writing, not loading",
    );
    assert.deepEqual(writeGroups, ["devices"]);
  });

  it("grants nothing on an all-unknown value, deliberately NOT falling back like TAILSCALE_TOOLS", () => {
    // The asymmetry is the point. A typo'd LOAD filter falls back to loading more,
    // whose worst case is a chatty server. A typo'd WRITE grant that fell back the
    // same way would hand over every write at the exact moment its operator was
    // restricting it -- fail-open, on the input a careless operator most likely types.
    const { tools, writeGroups, unknownWriteGroups } = filterTools(groups, { writeGroups: "devises" });
    assert.deepEqual(writeNames({ writeGroups: "devises" }), [], "a typo must grant nothing");
    assert.deepEqual(writeGroups, [], "configured-but-empty, distinct from unset");
    assert.deepEqual(unknownWriteGroups, ["devises"]);
    assert.ok(
      tools.length > 0,
      "the degraded state is a working read-only server, not an outage -- the agent can still explain the problem",
    );
  });

  it("grants the valid half of a partial typo and names the bad one", () => {
    assert.deepEqual(writeNames({ writeGroups: "devices,dnss" }), ["delete_device"]);
    assert.deepEqual(filterTools(groups, { writeGroups: "devices,dnss" }).unknownWriteGroups, ["dnss"]);
  });

  it("treats a sentinel-looking value as an unknown name, so a guess fails closed", () => {
    // The grammar reserves nothing: a reserved word could collide with a future group
    // name, which is the hazard the org-tailnets naming comment documents. `none`
    // lands on deny-all (what the operator meant) and `all` lands on deny-all too
    // (the safe direction for a wrong guess) -- index.ts adds a pointer for both.
    for (const value of ["none", "all", "off", "*"]) {
      assert.deepEqual(writeNames({ writeGroups: value }), [], `${value} must not grant writes`);
    }
  });

  it("treats whitespace-only and commas-only as unset rather than deny-all", () => {
    // `-e TAILSCALE_WRITE_GROUPS` in docker, or an unexpanded ${VAR}, produces exactly
    // this shape. Reading it as "revoke every write" would turn a config typo into a
    // silent outage on upgrade.
    for (const value of ["   ", ",,,", ""]) {
      assert.deepEqual(writeNames({ writeGroups: value }), ["delete_device", "update_acl"], JSON.stringify(value));
      assert.equal(filterTools(groups, { writeGroups: value }).writeGroups, undefined, "must read as unset");
    }
  });

  it("lets TAILSCALE_READONLY win over a grant, and says which knob did it", () => {
    const r = filterTools(groups, { readonly: "1", writeGroups: "devices" });
    assert.deepEqual(writeNames({ readonly: "1", writeGroups: "devices" }), []);
    assert.deepEqual(r.writeGroups, []);
    assert.equal(r.writeGroupsOverriddenByReadonly, true, "the banner must be able to name the cause");
  });

  it("does not blame readonly when the grant was empty anyway", () => {
    // READONLY=1 plus an all-typo grant yields no writes either way; flagging the
    // override would point the operator at the wrong knob.
    const r = filterTools(groups, { readonly: "1", writeGroups: "devises" });
    assert.equal(r.writeGroupsOverriddenByReadonly, undefined);
  });

  it("reports a grant the load filter never loaded, separately from a typo", () => {
    const r = filterTools(groups, { tools: "acl", writeGroups: "devices" });
    assert.deepEqual(r.writeGroupsNotLoaded, ["devices"]);
    assert.equal(r.unknownWriteGroups, undefined, "spelled correctly -- not a typo, a different fix");
    assert.deepEqual(r.writeGroups, [], "the grant had no effect");
  });

  it("intersects with the group filter rather than re-expanding it", () => {
    const { tools } = filterTools(groups, { tools: "devices", writeGroups: "devices,acl" });
    assert.deepEqual(tools.map((t) => t.name).sort(), ["delete_device", "list_devices"], "acl stays unloaded");
  });

  it("withholds a tool with a missing readOnlyHint unless its group is granted", () => {
    // The fail-closed guard at the write predicate is shared with TAILSCALE_READONLY,
    // so a tool that forgot its annotation is a write for BOTH knobs. Local fixture
    // because the shared one types the hint as required.
    const missingHint: Record<string, ReadonlyArray<{ name: string; annotations: { readOnlyHint?: boolean } }>> = {
      devices: [{ name: "no_hint", annotations: {} }],
      acl: [{ name: "also_no_hint", annotations: {} }],
    };
    assert.deepEqual(
      filterTools(missingHint, { writeGroups: "devices" }).tools.map((t) => t.name),
      ["no_hint"],
      "un-annotated tools are writes: served only where the group was granted",
    );
    assert.deepEqual(
      filterTools(missingHint, { writeGroups: "acl" }).tools.map((t) => t.name),
      ["also_no_hint"],
    );
  });

  it("is a silent no-op when the granted group holds no write tools", () => {
    const r = filterTools(groups, { writeGroups: "dns" });
    assert.deepEqual(writeNames({ writeGroups: "dns" }), [], "dns has no writes in the fixture");
    assert.deepEqual(r.writeGroups, ["dns"], "the grant is legal and applied; it just contains nothing");
    assert.equal(r.unknownWriteGroups, undefined);
  });

  it("is case-sensitive, matching TAILSCALE_TOOLS rather than diverging from it", () => {
    // Both knobs name the same groups. Folding case in one and not the other would
    // make `Devices` mean different things in two adjacent variables.
    assert.deepEqual(writeNames({ writeGroups: "Devices" }), []);
    assert.deepEqual(filterTools(groups, { writeGroups: "Devices" }).unknownWriteGroups, ["Devices"]);
  });
});

describe("parseGroupList", () => {
  it("is the one parse rule both group knobs share", () => {
    assert.deepEqual(parseGroupList("devices, acl"), ["devices", "acl"]);
    assert.deepEqual(parseGroupList(" devices , , acl "), ["devices", "acl"]);
    for (const empty of [undefined, "", "   ", ",,,"]) {
      assert.equal(parseGroupList(empty), null, JSON.stringify(empty));
    }
  });
});

describe("TAILSCALE_WRITE_GROUPS composition gaps", () => {
  it("reports a grant that TAILSCALE_PROFILE never loaded", () => {
    // Every other not-loaded test drives this branch through TAILSCALE_TOOLS, but
    // PROFILE is the knob a casual operator is far more likely to have set, and it
    // reaches the same branch by a different path. PROFILES.minimal is
    // status/devices/audit, so `acl` is a valid group the preset excludes.
    const r = filterTools(groups, { profile: "minimal", writeGroups: "acl" });
    assert.deepEqual(r.writeGroupsNotLoaded, ["acl"]);
    assert.deepEqual(r.writeGroups, [], "the grant had nothing to apply to");
    assert.equal(r.unknownWriteGroups, undefined, "spelled correctly -- the fix is the profile");
    assert.deepEqual(
      r.tools.map((t) => t.name),
      ["list_devices"],
      "the preset still decides what loads; the write grant cannot re-expand it",
    );
  });

  it("grants the loaded half of a grant and reports the rest as not loaded", () => {
    // Both arms of the same filter fire in one call. Existing tests exercise
    // fully-loaded or fully-unloaded grants only, and the mixed case is where a
    // wrong predicate silently drops the valid half.
    const r = filterTools(groups, { tools: "devices,acl", writeGroups: "devices,dns" });
    assert.deepEqual(r.writeGroups, ["devices"], "the loaded half is granted");
    assert.deepEqual(r.writeGroupsNotLoaded, ["dns"], "the unloaded half is reported");
    assert.deepEqual(
      r.tools.map((t) => t.name).sort(),
      ["delete_device", "get_acl", "list_devices"],
      "acl loads read-only (granted nothing), devices loads writable, dns never loads",
    );
  });

  it("dedupes and sorts the effective grant", () => {
    // The Set dedupes and .sort() normalizes, but nothing pinned either -- and the
    // rendered `write=` string is exactly what an operator diffs between two
    // environments to confirm they match.
    // Input order is deliberately NOT already sorted: "devices,acl,devices" dedupes to
    // ["devices","acl"] via insertion order alone, so it proves dedup and says nothing
    // about the sort. Leading with `devices` is what makes the sort observable.
    const r = filterTools(groups, { writeGroups: "devices,acl,devices" });
    assert.deepEqual(r.writeGroups, ["acl", "devices"], "deduped AND sorted, not insertion order");
  });
});
