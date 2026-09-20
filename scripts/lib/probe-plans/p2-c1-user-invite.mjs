import { del, get, PATTERNS, post } from "./_shared.mjs";

/**
 * P2 -- does POST user-invites take the bare object the tool sends, or the
 * one-element array the spec documents?
 *
 * Routed to TARGET B explicitly (critic amendment 3). User invites are
 * "only permitted for user-owned keys, because invites require an inviting
 * user" (openapi.yaml:938), and target A is an API-only tailnet with no human
 * users at all, so this probe can never produce a usable answer there. The
 * routing refusal says that in one sentence instead of leaving the owner to
 * interpret a 403.
 *
 * No `email` in any variant: without it the endpoint returns a URL and sends
 * nothing (openapi.yaml:963-968).
 */
export default {
  probeId: "P2-C1-user-invite",
  settles: ["C1"],
  question:
    "Does POST user-invites reject the bare JSON object the tool sends today, and does the array form succeed and return an array?",
  safetyClass: "safe-reversible-write",
  requiresTargetKind: "human",
  requiresTargetKindWhy:
    "user invites need a user-owned API key (openapi.yaml:938) and an API-only tailnet has no human users",
  methods: ["GET", "POST", "DELETE"],
  allowedRequests: [get(PATTERNS.userInvites), post(PATTERNS.userInvites), del(PATTERNS.userInviteById)],
  credentialNeeds:
    "USER-OWNED API key (tskey-api-...) only. OAuth tokens cannot create invites. Needs throwaway human tailnet B.",
  blastRadius:
    "If the object shape is silently accepted, one member-role invite link to tailnet B exists until deleted. No email is sent. The inviteUrl is redacted before anything reaches disk, so a crash before cleanup leaves a link that exists server-side but whose code was never persisted; it is visible and deletable in the admin console. Not billable until accepted.",
  cleanup:
    "DELETE /user-invites/{id} for every id returned (journalled BEFORE the POST resolves), then GET /tailnet/{T}/user-invites must equal the baseline. `live-probe.mjs cleanup` replays the journal after a crash.",
  outcomes: [
    {
      when: "CURRENT 400 + SPEC 200 array",
      ship: "Ship `[body]` (invites.ts:141-144). The changelog may say the tool never worked, quoting the 400. The SPEC response replaces the hand-built `{id}` mocks at handlers.test.ts:2178.",
    },
    {
      when: "CURRENT 200 + SPEC 200",
      ship: "The tool works today; C1 drops from P0 to P3 conformance; NO breakage claim. Record whether CURRENT returned an object or an array -- the documented return shape and the mocks depend on it.",
    },
    {
      when: "CURRENT 200 + SPEC 400",
      ship: "The spec is wrong. Do NOT ship the fix; keep the tests; open an upstream docs issue.",
    },
    { when: "both 4xx (403)", ship: "Wrong credential type -- inconclusive, rerun with a user-owned key." },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/user-invites",
        body: null,
        tool: { module: "tools/invites.js", name: "tailscale_list_user_invites", input: {} },
        registers: "ids",
        expect: "200. This is the baseline every later GET is compared against.",
      },
      {
        n: 2,
        arm: "current",
        method: "POST",
        path: "/tailnet/{T}/user-invites",
        body: {},
        undo: { method: "DELETE", path: "/user-invites/{id}" },
        tool: { module: "tools/invites.js", name: "tailscale_create_user_invite", input: {} },
        registers: "ids",
        expect: "400 if the endpoint wants an array (openapi.yaml:942-968).",
        note: "invites.ts:141-144 builds a bare object and posts it.",
      },
      { n: 3, arm: "observe", method: "GET", path: "/tailnet/{T}/user-invites", body: null, registers: "ids" },
      {
        n: 4,
        arm: "current",
        method: "POST",
        path: "/tailnet/{T}/user-invites",
        body: { role: "member" },
        undo: { method: "DELETE", path: "/user-invites/{id}" },
        tool: { module: "tools/invites.js", name: "tailscale_create_user_invite", input: { role: "member" } },
        registers: "ids",
        expect: "Same as step 2, with a field set, in case an empty object is rejected for its own reasons.",
      },
      { n: 5, arm: "observe", method: "GET", path: "/tailnet/{T}/user-invites", body: null, registers: "ids" },
      {
        n: 6,
        arm: "spec",
        method: "POST",
        path: "/tailnet/{T}/user-invites",
        body: [{}],
        undo: { method: "DELETE", path: "/user-invites/{id}" },
        registers: "ids",
        expect: "200 with an ARRAY response (openapi.yaml:973-977).",
        note: "Raw apiRequest: no tool can emit this shape until the fix lands. This is the documented escape hatch.",
      },
      { n: 7, arm: "observe", method: "GET", path: "/tailnet/{T}/user-invites", body: null, registers: "ids" },
      {
        n: 8,
        arm: "spec",
        method: "POST",
        path: "/tailnet/{T}/user-invites",
        body: [{ role: "member" }],
        undo: { method: "DELETE", path: "/user-invites/{id}" },
        registers: "ids",
        expect: "200 with an array.",
      },
      { n: 9, arm: "observe", method: "GET", path: "/tailnet/{T}/user-invites", body: null, registers: "ids" },
      {
        n: 10,
        arm: "negative",
        method: "POST",
        path: "/tailnet/{T}/user-invites",
        body: [{}],
        undo: { method: "DELETE", path: "/user-invites/{id}" },
        optional: true,
        requires: { flag: "allow-oauth-negative-control" },
        expect: "403 with the exact rejection body, which becomes the tool's error hint.",
        note: "Runs with an OAuth bearer instead of the user-owned key, to capture how the API refuses it. Needs a second credential set, so the OAuth token cache is reset first.",
      },
      {
        n: 11,
        arm: "cleanup",
        method: "DELETE",
        path: "/user-invites/{id}",
        body: null,
        expect: "Every id created above is deleted and the final GET equals the step-1 baseline.",
        note: "Journalled before each create resolves. The egress guard only permits ids this run already saw.",
      },
    ];
  },
};
