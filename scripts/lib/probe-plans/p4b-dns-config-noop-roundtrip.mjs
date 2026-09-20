import { get, PATTERNS, post, put } from "./_shared.mjs";

/**
 * P4b -- write back exactly what was read, and see whether anything is lost.
 *
 * This is the probe that decides PR33's whole design: if POST
 * /dns/configuration is replace-all, then "change one DNS setting" has to be a
 * read-merge-write over the FULL document, and the "No fields to update" guard
 * at dns.ts:217-219 is the wrong model -- a partial body there is a destructive
 * wipe, not a no-op.
 *
 * Critic amendment 4: SEED target A first, with a document that has something
 * in every slot the round trip could drop -- overrideLocalDNS:true,
 * magicDNS:true, a nameserver and a split resolver each carrying
 * useWithExitNode:true, and two search paths. A no-op round trip over an empty
 * document proves nothing. Then compare FULL key sets, not just values.
 *
 * NO FLAG PUTS THIS ON A REAL TAILNET. The design left room for a conditional
 * real-tailnet path (allowed if P4a showed overrideLocalDNS false and no
 * useWithExitNode, plus an explicit go-ahead); it was deliberately NOT wired.
 * The probe declares `unsafe-needs-disposable-tailnet`, and that class has no
 * override: assertSafetyClassWiring refuses an unattested target even when
 * BOTH --allow-real-readonly and --allow-real-reversible=P4b... are passed
 * (asserted in src/live-fixtures.test.ts). Every step here is a replace-all
 * write against a tailnet-wide document, the restore path on a real tailnet is
 * the admin console rather than anything automated, and a conditional that has
 * to be reasoned about is a worse interlock than one that cannot be reached.
 * If the observation is ever wanted on a real tailnet, it needs its own plan
 * and its own review, not a flag.
 */
export default {
  probeId: "P4b-dns-config-noop-roundtrip",
  settles: ["C2"],
  question:
    "Is POST /dns/configuration replace-all or merge -- does writing the document back unchanged preserve every key, and does a preferences-only body keep the rest?",
  safetyClass: "unsafe-needs-disposable-tailnet",
  requiresTargetKind: null,
  methods: ["GET", "POST"],
  allowedRequests: [get(PATTERNS.dnsAny), post(PATTERNS.dnsAny), put(PATTERNS.splitDns)],
  credentialNeeds:
    "OAuth `dns` scope or an API key. The create-tailnet `all` client (openapi.yaml:6567-6579) is sufficient.",
  blastRadius:
    "Tailnet-wide DNS. Every step here is a replace-all write against the unified endpoint. On a tailnet with real devices a dropped nameserver list or a MagicDNS flip breaks name resolution for every node -- including the host running this server, which reaches api.tailscale.com by name, so the server could not undo its own change. Target A only, with no flag that says otherwise.",
  cleanup:
    "Teardown of target A covers it. If the tailnet is kept, POST the step-1 document back and GET to confirm. There is no real-tailnet case to restore: this probe cannot run on one.",
  outcomes: [
    {
      when: "the round trip drops keys",
      ship: "Replace-all confirmed and the server does not echo what it stores. PR33 must GET, merge and POST the whole document, and PR21 must model every key P4a saw or the merge will strip it.",
    },
    {
      when: "the preferences-only body clears nameservers/splitDNS/searchPaths",
      ship: 'Replace-all confirmed loudly. dns.ts:217-219\'s "No fields to update" guard is the wrong model; the handler must require the full config or do GET-merge-POST.',
    },
    {
      when: "the preferences-only body leaves the rest intact",
      ship: "Merge semantics: partial updates are fine and PR33 becomes a thin passthrough.",
    },
    {
      when: "the round trip 400s on a document the server itself just returned",
      ship: "GET and POST use different shapes. Record both; PR21 cannot ship until that is reconciled.",
    },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "seed",
        method: "POST",
        path: "/tailnet/{T}/dns/configuration",
        body: {
          nameservers: [{ address: "1.1.1.1", useWithExitNode: true }],
          splitDNS: { "c2.yaw-probe.example.com": [{ address: "10.0.0.1", useWithExitNode: true }] },
          searchPaths: ["a.yaw-probe.example.com", "b.yaw-probe.example.com"],
          preferences: { magicDNS: true, overrideLocalDNS: true },
        },
        requires: { attestedTarget: true },
        expect: "200. A no-op round trip over an empty document proves nothing, so every slot is filled first.",
        note: "Critic amendment 4. Never runs on a real tailnet: this is a replace-all write.",
      },
      {
        n: 2,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/configuration",
        body: null,
        tool: { module: "tools/dns.js", name: "tailscale_get_dns_configuration", input: {} },
        expect: "200. Call this document D. Its keySets map is the thing every later step is compared against.",
      },
      {
        n: 3,
        arm: "spec",
        method: "POST",
        path: "/tailnet/{T}/dns/configuration",
        bodyFromStep: 2,
        requires: { attestedTarget: true },
        expect: "200 -- writing back what was just read must not be a change.",
        note: "The body IS step 2's response, threaded through memory unredacted. Raw apiRequest: no tool emits the spec shape yet. Carries the same step-level attested-target requirement as steps 1, 5 and 7: writing a document back is still a replace-all write, and defence in depth costs nothing here.",
      },
      {
        n: 4,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/configuration",
        body: null,
        expect: "200, and BOTH the values and the full keySets map must equal step 2's. Any difference is the finding.",
      },
      {
        n: 5,
        arm: "spec",
        method: "POST",
        path: "/tailnet/{T}/dns/configuration",
        body: { preferences: { magicDNS: true } },
        requires: { attestedTarget: true },
        expect: "200.",
        note: "The semantics step. Never on a real tailnet -- if this is replace-all it has just wiped DNS.",
      },
      {
        n: 6,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/configuration",
        body: null,
        expect: "Did nameservers, splitDNS and searchPaths survive? That is replace-vs-merge.",
      },
      {
        n: 7,
        arm: "spec",
        method: "POST",
        path: "/tailnet/{T}/dns/configuration",
        body: { nameservers: ["1.1.1.1"] },
        requires: { attestedTarget: true },
        expect: "400 or accepted. The LIFT CHECK: must friendly plain-IP input be lifted to {address}?",
      },
      {
        n: 8,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/configuration",
        body: null,
        expect: "The final state, recorded so the teardown diff is complete.",
      },
    ];
  },
};
