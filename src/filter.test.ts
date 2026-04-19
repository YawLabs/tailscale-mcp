import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterTools, PROFILES } from "./filter.js";

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

  it("returns no tools if TAILSCALE_TOOLS lists only unknown groups", () => {
    const { tools, unknownGroups } = filterTools(groups, { tools: "nothing-real", readonly: undefined });
    assert.equal(tools.length, 0);
    assert.deepEqual(unknownGroups, ["nothing-real"]);
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

  it("TAILSCALE_TOOLS overrides TAILSCALE_PROFILE when both set", () => {
    const { tools, profileGroups } = filterTools(groups, { profile: "minimal", tools: "acl" });
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["get_acl", "update_acl"]);
    assert.equal(profileGroups, undefined);
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
