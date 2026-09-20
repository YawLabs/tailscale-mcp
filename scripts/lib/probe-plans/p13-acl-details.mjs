import { get, PATTERNS } from "./_shared.mjs";

/**
 * P13 -- does GET /acl support a details mode, and what turns it on?
 *
 * A reviewer addition, read-only, and deliberately ordered: `details=true`
 * first, then `details=1`, and only THEN the Accept header variations. Doing it
 * the other way round confounds two variables -- a 200 with a JSON body could
 * be the details mode or just content negotiation, and there would be no way to
 * tell which from the fixture.
 *
 * The ACL text is the tailnet's security policy, so this probe is countsOnly on
 * an unattested target: key sets and statuses, never the policy itself.
 */
export default {
  probeId: "P13-acl-details",
  settles: ["C-acl-details"],
  question:
    "Does GET /acl take a details parameter, which spelling turns it on, and how does it interact with the Accept header?",
  safetyClass: "safe-read-only",
  requiresTargetKind: null,
  methods: ["GET"],
  allowedRequests: [get(PATTERNS.acl)],
  countsOnly: "unattested",
  credentialNeeds: "Any credential with policy_file:read. Safe on the real tailnet behind --allow-real-readonly.",
  blastRadius: "None. GET only. The ACL text itself is never persisted on an unattested target.",
  cleanup: "None.",
  outcomes: [
    {
      when: "details=true returns lint diagnostics",
      ship: "PR35 adds a details mode to tailscale_get_acl, pinned to the observed response shape.",
    },
    {
      when: "details=true is ignored and details=1 works (or the reverse)",
      ship: "Record which spelling; PR35 sends that one and says the other is ignored.",
    },
    {
      when: "the parameter is ignored under application/hujson but honoured under application/json",
      ship: "The details mode is bound to content negotiation. PR35 must set Accept as well, and acl.ts:225-228 (which always asks for hujson) needs a branch.",
    },
    { when: "every arm returns the same body", ship: "There is no details mode here; drop that half of PR35." },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/acl",
        body: null,
        tool: { module: "tools/acl.js", name: "tailscale_get_acl", input: {} },
        expect: "The baseline: Accept: application/hujson, as acl.ts:225-228 always sends. Note the ETag.",
      },
      {
        n: 2,
        arm: "spec",
        method: "GET",
        path: "/tailnet/{T}/acl?details=true",
        body: null,
        headers: { accept: "application/hujson" },
        expect: "Same Accept as step 1, so the ONLY variable is the parameter.",
      },
      {
        n: 3,
        arm: "spec",
        method: "GET",
        path: "/tailnet/{T}/acl?details=1",
        body: null,
        headers: { accept: "application/hujson" },
        expect: "The other spelling, still with the Accept held constant.",
      },
      {
        n: 4,
        arm: "spec",
        method: "GET",
        path: "/tailnet/{T}/acl?details=true",
        body: null,
        headers: { accept: "application/json" },
        expect: "Only now does Accept vary. A difference here is content negotiation, not the parameter.",
      },
      {
        n: 5,
        arm: "spec",
        method: "GET",
        path: "/tailnet/{T}/acl",
        body: null,
        headers: { accept: "application/json" },
        expect: "The control for step 4: Accept varied with NO details parameter.",
      },
    ];
  },
};
