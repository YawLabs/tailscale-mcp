import { del, get, PATTERNS, patch, post } from "./_shared.mjs";

/**
 * P7 -- when PATCH /webhooks/{id} carries endpointUrl, is it rejected, silently
 * ignored with a 200, or actually applied?
 *
 * The middle case is the harmful one and the reason C4 must not ship blind:
 * a 200 with the URL unchanged means the agent reports "endpoint updated" while
 * every event keeps flowing to the OLD sink. The opposite outcome is just as
 * decisive -- if the URL IS mutable, the spec and the Go client are merely
 * conservative, C4 is dropped, and the test at handlers.test.ts:1061-1077 stays
 * exactly as it is.
 *
 * The /webhooks/{id} path is not tailnet-scoped, so the egress guard only
 * permits the id returned by the CREATE in step 2.
 */
export default {
  probeId: "P7-C4-webhook-patch",
  settles: ["C4"],
  question: "Is endpointUrl on PATCH /webhooks/{id} rejected, silently ignored, or applied?",
  safetyClass: "safe-reversible-write",
  requiresTargetKind: null,
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedRequests: [
    get(PATTERNS.webhooks),
    post(PATTERNS.webhooks),
    get(PATTERNS.webhookById),
    patch(PATTERNS.webhookById),
    del(PATTERNS.webhookById),
  ],
  credentialNeeds:
    "OAuth `webhooks` scope (openapi.yaml:3287, :3358) or an API key; the create-tailnet `all` client is sufficient. Plus TWO owner-controlled HTTPS sink URLs.",
  blastRadius:
    "Creates and deletes only its own webhook and never touches an existing one. While it exists, subscribed events from the target tailnet -- plus webhookUpdated and test events -- are POSTed to the sink URL. On a real tailnet that is real event data leaving to that URL, which is why the sink must be owner-controlled and the disposable target (no events) is preferred. A leftover webhook after a crash keeps delivering until deleted, so the id is journalled before the create resolves.",
  cleanup: "DELETE /webhooks/{W}; GET /tailnet/{T}/webhooks must then contain no endpoint pointing at either sink URL.",
  outcomes: [
    {
      when: "CURRENT-1 400",
      ship: "Loud failure. Remove endpointUrl from update (webhooks.ts:176, :186, :193, :196 and the README line the finding cites); the changelog may say the API rejects it.",
    },
    {
      when: "CURRENT-1 200 and the URL is still A",
      ship: "SILENT IGNORE. The agent reports the URL updated while events keep flowing to the old endpoint. Raise the priority; the changelog leads with the correctness bug; CURRENT-2 then shows whether a mixed call half-applies.",
    },
    {
      when: "CURRENT-1 200 and the URL is now B",
      ship: "The URL IS mutable. Do NOT remove endpointUrl; drop C4; the test at handlers.test.ts:1061-1077 stays. PR24 is cancelled.",
    },
  ],
  steps() {
    // Placeholders, NOT values read here. The runner seeds ctx.ids.sinkA /
    // sinkB from TS_PROBE_SINK_A / TS_PROBE_SINK_B and resolves them into the
    // tool input before the handler sees it; if either is unset, resolvePath
    // refuses the step instead of sending a literal. (`ctx.state` is the state
    // FILE -- {targets, journal} -- and never held these.)
    const urlA = "{sinkA}";
    const urlB = "{sinkB}";
    return [
      {
        n: 1,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/webhooks",
        body: null,
        tool: { module: "tools/webhooks.js", name: "tailscale_list_webhooks", input: {} },
        registers: "ids",
        expect: "200. The baseline, and the list cleanup verifies against.",
      },
      {
        n: 2,
        arm: "seed",
        method: "POST",
        path: "/tailnet/{T}/webhooks",
        body: { endpointUrl: urlA, subscriptions: ["policyUpdate", "nodeCreated"] },
        tool: {
          module: "tools/webhooks.js",
          name: "tailscale_create_webhook",
          input: { endpointUrl: urlA, subscriptions: ["policyUpdate", "nodeCreated"] },
        },
        registers: "id",
        idKey: "W",
        undo: { method: "DELETE", path: "/webhooks/{id}" },
        expect: "200 -> id W. The `secret` in the response is redacted before anything is persisted.",
        note: "Reviewer addition: seeded with nodeCreated as well as policyUpdate, so a subscriptions change is observable in both directions.",
      },
      {
        n: 3,
        arm: "observe",
        method: "GET",
        path: "/webhooks/{W}",
        body: null,
        tool: { module: "tools/webhooks.js", name: "tailscale_get_webhook", input: { webhookId: "{W}" } },
      },
      {
        n: 4,
        arm: "current",
        method: "PATCH",
        path: "/webhooks/{W}",
        body: { endpointUrl: urlB },
        tool: {
          module: "tools/webhooks.js",
          name: "tailscale_update_webhook",
          input: { webhookId: "{W}", endpointUrl: urlB },
        },
        expect: "URL-only. webhooks.ts:191-199 will send exactly this.",
        note: "Reviewer addition: URL-only and URL+subscriptions are recorded as SEPARATE steps, because a mixed call that half-applies is its own finding.",
      },
      {
        n: 5,
        arm: "observe",
        method: "GET",
        path: "/webhooks/{W}",
        body: null,
        expect: "endpointUrl is A or B? That is the whole probe.",
      },
      {
        n: 6,
        arm: "current",
        method: "PATCH",
        path: "/webhooks/{W}",
        body: { endpointUrl: urlB, subscriptions: ["policyUpdate"] },
        tool: {
          module: "tools/webhooks.js",
          name: "tailscale_update_webhook",
          input: { webhookId: "{W}", endpointUrl: urlB, subscriptions: ["policyUpdate"] },
        },
        expect: "Did subscriptions change while the URL did not?",
      },
      { n: 7, arm: "observe", method: "GET", path: "/webhooks/{W}", body: null },
      {
        n: 8,
        arm: "spec",
        method: "PATCH",
        path: "/webhooks/{W}",
        body: { subscriptions: ["policyUpdate", "nodeCreated"] },
        expect: "200 (openapi.yaml:3353-3369 -- the body has only `subscriptions`; Go client webhooks.go:117-121).",
      },
      { n: 9, arm: "observe", method: "GET", path: "/webhooks/{W}", body: null },
      {
        n: 10,
        arm: "spec",
        method: "PATCH",
        path: "/webhooks/{W}",
        body: { subscriptions: ["categoryUpdate"] },
        optional: true,
        expect: "Does the API take a subscription CATEGORY where the tool's enum expects individual events?",
        note: "Reviewer addition: the category PATCH. If categories are accepted, the webhook subscription enum is under-specified and PR24 should say so.",
      },
      { n: 11, arm: "observe", method: "GET", path: "/webhooks/{W}", body: null },
      {
        n: 12,
        arm: "cleanup",
        method: "DELETE",
        path: "/webhooks/{W}",
        body: null,
        tool: { module: "tools/webhooks.js", name: "tailscale_delete_webhook", input: { webhookId: "{W}" } },
        expect: "Then GET /tailnet/{T}/webhooks must contain no endpoint pointing at either sink.",
      },
    ];
  },
};
