import { get, PATTERNS } from "./_shared.mjs";

/**
 * P12 -- what does `fields` actually project, and what happens to a repeated
 * query parameter?
 *
 * A reviewer addition, and read-only. Two separate questions:
 *
 *  - devices.ts:45 advertises `fields=id` and a 26-name list. The spec documents
 *    only `all` and `default`. PR28 drops the undocumented value, which is a
 *    breaking change to a tool description, so it should not ship on a reading
 *    of the docs alone.
 *  - the tool builds filters with URLSearchParams.set (devices.ts:69), which
 *    REPLACES. An agent asking for two tags therefore silently sends one. If
 *    the API takes a repeated parameter, that is a real bug and not a doc fix.
 */
export default {
  probeId: "P12-devices-fields-projection",
  settles: ["C-devices-fields"],
  question:
    "Does GET /devices accept `fields=id` and an arbitrary field list, and does it take a repeated filter parameter that the tool's URLSearchParams.set collapses to one?",
  safetyClass: "safe-read-only",
  requiresTargetKind: null,
  methods: ["GET"],
  allowedRequests: [get(PATTERNS.devices)],
  countsOnly: "unattested",
  credentialNeeds: "Any credential with devices:core:read. Safe on the real tailnet behind --allow-real-readonly.",
  blastRadius: "None. GET only.",
  cleanup: "None.",
  outcomes: [
    {
      when: "fields=id returns 400, or returns every field",
      ship: "devices.ts:45's advertised value is wrong and PR28 removes it, with the observed status quoted.",
    },
    {
      when: "fields=id genuinely projects one field",
      ship: "The undocumented value works. PR28 keeps it and marks it undocumented rather than dropping it.",
    },
    {
      when: "a repeated `tags` parameter returns a union or an intersection",
      ship: "The set-based filter builder is losing caller intent. PR28 must append rather than set, and say which semantics the API gives.",
    },
    {
      when: "a repeated parameter is rejected or last-wins",
      ship: "The current builder matches the API and only the tool description needs to say so.",
    },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/devices",
        body: null,
        tool: { module: "tools/devices.js", name: "tailscale_list_devices", input: {} },
        expect: "The default projection. Its keySets map is the baseline every other arm is compared against.",
      },
      {
        n: 2,
        arm: "current",
        method: "GET",
        path: "/tailnet/{T}/devices?fields=all",
        body: null,
        tool: { module: "tools/devices.js", name: "tailscale_list_devices", input: { fields: "all" } },
        expect: "The documented value. Which keys does it add over the default?",
      },
      {
        n: 3,
        arm: "current",
        method: "GET",
        path: "/tailnet/{T}/devices?fields=id",
        body: null,
        tool: { module: "tools/devices.js", name: "tailscale_list_devices", input: { fields: "id" } },
        expect: "400, one field, or every field? This decides PR28.",
      },
      {
        n: 4,
        arm: "current",
        method: "GET",
        path: "/tailnet/{T}/devices?fields=id%2Chostname%2Ctags",
        body: null,
        tool: { module: "tools/devices.js", name: "tailscale_list_devices", input: { fields: "id,hostname,tags" } },
        expect: "Is a comma-separated list projected at all, as devices.ts:45 promises?",
      },
      {
        n: 5,
        arm: "spec",
        method: "GET",
        path: "/tailnet/{T}/devices?fields=default",
        body: null,
        expect: "The other documented value. Identical to step 1?",
      },
      {
        n: 6,
        arm: "spec",
        method: "GET",
        path: "/tailnet/{T}/devices?tags=tag%3Aa&tags=tag%3Ab",
        body: null,
        expect: "A repeated parameter -- union, intersection, 400, or last-wins?",
        note: "Raw apiRequest: the tool CANNOT emit this. devices.ts:69 uses URLSearchParams.set, so the second value replaces the first.",
      },
      {
        n: 7,
        arm: "current",
        method: "GET",
        path: "/tailnet/{T}/devices?tags=tag%3Ab",
        body: null,
        tool: { module: "tools/devices.js", name: "tailscale_list_devices", input: { filters: { tags: "tag:b" } } },
        expect: "What the tool actually sends when an agent asks for two tags: only the last one.",
      },
    ];
  },
};
