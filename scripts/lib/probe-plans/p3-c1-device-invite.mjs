import { del, get, PATTERNS, post } from "./_shared.mjs";

/**
 * P3 -- the same array-vs-object question for POST /device/{id}/device-invites,
 * which is a separate handler upstream and cannot be inferred from P2.
 *
 * Also routed to TARGET B (critic amendment 3): "device invites cannot be
 * created using an API access token generated from an OAuth client as the
 * shared device is scoped to a user" (openapi.yaml:831).
 *
 * The path is NOT tailnet-scoped, so the egress guard only permits a deviceId
 * an earlier GET /tailnet/{T}/devices in this run returned -- step 1 exists to
 * register it.
 */
export default {
  probeId: "P3-C1-device-invite",
  settles: ["C1"],
  question:
    "Does POST /device/{deviceId}/device-invites reject the bare object the tool sends, and does the array form succeed?",
  safetyClass: "safe-reversible-write",
  requiresTargetKind: "human",
  requiresTargetKindWhy:
    "a shared device is scoped to a user, so an OAuth-minted token cannot create the invite (openapi.yaml:831)",
  methods: ["GET", "POST", "DELETE"],
  allowedRequests: [
    get(PATTERNS.devices),
    get(PATTERNS.deviceInvites),
    post(PATTERNS.deviceInvites),
    del(PATTERNS.deviceInviteById),
  ],
  credentialNeeds:
    "User-owned API key only, plus one throwaway UNTAGGED node joined to tailnet B with an auth key minted by that same key. A container with userspace networking is enough. Tagged devices may not be shareable at all (openapi.yaml:831), so the node must be user-owned.",
  blastRadius:
    "If accepted, a share-invite link for the named device exists until deleted, and whoever holds the link could reach that device subject to ACLs. On a real tailnet that is a real device, which is why this runs on B against a throwaway node. The URL is redacted and never persisted.",
  cleanup:
    "DELETE /device-invites/{id} for every created id; GET /device/{deviceId}/device-invites must equal the baseline; afterwards the owner removes the throwaway node from tailnet B.",
  outcomes: [
    {
      when: "CURRENT 400 + SPEC 200 array",
      ship: "Ship `[body]` at invites.ts:44-48. The describe at handlers.test.ts:3299 pins `deepEqual(parsed, {})` and must move.",
    },
    { when: "CURRENT 200 + SPEC 200", ship: "The tool works today; record which shape came back." },
    { when: "CURRENT 200 + SPEC 400", ship: "The spec is wrong for this endpoint; do not ship." },
    {
      when: "P3 is not run at all",
      ship: 'The device-invite changelog line must be worded "per the OpenAPI spec and api.md; not observed", even if P2 proved the user-invite half broken. The two endpoints are separate handlers upstream.',
    },
  ],
  steps(ctx) {
    const deviceId = ctx.state?.deviceId ?? "{deviceId}";
    return [
      {
        n: 1,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/devices",
        body: null,
        tool: { module: "tools/devices.js", name: "tailscale_list_devices", input: {} },
        registers: "ids",
        expect: "200 with exactly one yaw-probe- node. Registering its id is what lets the guard permit step 2.",
      },
      {
        n: 2,
        arm: "observe",
        method: "GET",
        path: `/device/${deviceId}/device-invites`,
        body: null,
        tool: { module: "tools/invites.js", name: "tailscale_list_device_invites", input: { deviceId } },
        registers: "ids",
        expect: "200, the baseline.",
      },
      {
        n: 3,
        arm: "current",
        method: "POST",
        path: `/device/${deviceId}/device-invites`,
        body: {},
        undo: { method: "DELETE", path: "/device-invites/{id}" },
        tool: { module: "tools/invites.js", name: "tailscale_create_device_invite", input: { deviceId } },
        registers: "ids",
        expect: "400 if the endpoint wants an array (openapi.yaml:835-860).",
        note: "invites.ts:44-48 builds a bare object. No `email` in any variant (openapi.yaml:855-860).",
      },
      { n: 4, arm: "observe", method: "GET", path: `/device/${deviceId}/device-invites`, body: null, registers: "ids" },
      {
        n: 5,
        arm: "current",
        method: "POST",
        path: `/device/${deviceId}/device-invites`,
        body: { multiUse: false, allowExitNode: false },
        undo: { method: "DELETE", path: "/device-invites/{id}" },
        tool: {
          module: "tools/invites.js",
          name: "tailscale_create_device_invite",
          input: { deviceId, multiUse: false, allowExitNode: false },
        },
        registers: "ids",
      },
      { n: 6, arm: "observe", method: "GET", path: `/device/${deviceId}/device-invites`, body: null, registers: "ids" },
      {
        n: 7,
        arm: "spec",
        method: "POST",
        path: `/device/${deviceId}/device-invites`,
        body: [{}],
        undo: { method: "DELETE", path: "/device-invites/{id}" },
        registers: "ids",
        expect: "200 with an array (openapi.yaml:866-869).",
        note: "Raw apiRequest -- no tool emits this shape yet.",
      },
      { n: 8, arm: "observe", method: "GET", path: `/device/${deviceId}/device-invites`, body: null, registers: "ids" },
      {
        n: 9,
        arm: "spec",
        method: "POST",
        path: `/device/${deviceId}/device-invites`,
        body: [{ multiUse: false, allowExitNode: false }],
        undo: { method: "DELETE", path: "/device-invites/{id}" },
        registers: "ids",
      },
      {
        n: 10,
        arm: "observe",
        method: "GET",
        path: `/device/${deviceId}/device-invites`,
        body: null,
        registers: "ids",
      },
      {
        n: 11,
        arm: "cleanup",
        method: "DELETE",
        path: "/device-invites/{id}",
        body: null,
        expect: "Every created id deleted; the final GET equals the step-2 baseline.",
      },
    ];
  },
};
