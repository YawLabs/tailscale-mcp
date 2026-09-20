import { get, minusHours, PATTERNS, rfc3339 } from "./_shared.mjs";

/**
 * P17 -- does the audit log take several values for one filter, and what does
 * it do with an event name it does not know?
 *
 * A reviewer addition, read-only, and gating PR38. Two questions:
 *
 *  - Can one query name two actors or two event types? If a repeated parameter
 *    means OR, PR38 is a real feature; if it means last-wins, PR38 would be
 *    quietly dropping half the caller's filter.
 *  - What does an unknown `eventType` do? A 400 is a usable error. An empty
 *    200 is the trap: an agent asking for an event Tailscale renamed gets "no
 *    audit entries" and reads it as "nothing happened".
 *
 * countsOnly, always. Audit entries carry actor emails, IPs and node names, and
 * on any tailnet worth querying those are real people.
 */
export default {
  probeId: "P17-audit-multivalue-filters",
  settles: ["C-audit-filters"],
  question:
    "Does /logging/configuration accept repeated filter parameters, and does an unknown eventType 400 or return an empty 200?",
  safetyClass: "safe-read-only",
  requiresTargetKind: null,
  methods: ["GET"],
  // `start`/`end` bound every arm; `eventType` and `actor` are the repeated
  // filter parameters the probe exists to ask about.
  allowedRequests: [get(PATTERNS.loggingConfiguration, ["start", "end", "eventType", "actor"])],
  countsOnly: true,
  credentialNeeds:
    "Any credential with logs:configuration:read. Safe on the real tailnet behind --allow-real-readonly, and worth running there: a disposable tailnet has almost no audit history to filter.",
  blastRadius: "None. GET only, and countsOnly is not optional here -- no audit entry reaches disk in any mode.",
  cleanup: "None.",
  outcomes: [
    {
      when: "a repeated eventType returns the union",
      ship: "PR38 ships multi-value filters, and the audit tool's schema takes string | string[].",
    },
    {
      when: "a repeated parameter is last-wins",
      ship: "PR38 must NOT accept arrays silently: half the caller's filter would vanish. Either reject arrays locally or fan out into several requests.",
    },
    { when: "a repeated parameter 400s", ship: "PR38 becomes a documentation change only." },
    {
      when: "an unknown eventType returns an empty 200",
      ship: 'The trap case. PR38 should validate the name locally, or the tool must say "no matching entries -- check the event name" rather than "no entries".',
    },
  ],
  steps(ctx) {
    const start = rfc3339(minusHours(ctx.now, 24));
    const end = rfc3339(ctx.now);
    const range = `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    return [
      {
        n: 1,
        arm: "control",
        method: "GET",
        path: `/tailnet/{T}/logging/configuration?${range}`,
        body: null,
        tool: { module: "tools/audit.js", name: "tailscale_get_audit_log", input: { start, end } },
        expect: "200 and a non-zero entry count. With zero entries every filter arm below is inconclusive.",
      },
      {
        n: 2,
        arm: "spec",
        method: "GET",
        path: `/tailnet/{T}/logging/configuration?${range}&eventType=DNS_CONFIG_UPDATED`,
        body: null,
        expect: "One filter value. The count must be <= step 1.",
        note: "Raw apiRequest: the audit tool models only start and end (audit.ts:72-75), so no filter can be sent through it today.",
      },
      {
        n: 3,
        arm: "spec",
        method: "GET",
        path: `/tailnet/{T}/logging/configuration?${range}&eventType=DNS_CONFIG_UPDATED&eventType=ACL_UPDATED`,
        body: null,
        expect: "Union, intersection, last-wins or 400? Compare the count against step 2 and against an ACL-only arm.",
      },
      {
        n: 4,
        arm: "spec",
        method: "GET",
        path: `/tailnet/{T}/logging/configuration?${range}&eventType=ACL_UPDATED`,
        body: null,
        expect: "The other half of the union, so step 3's count can actually be interpreted.",
      },
      {
        n: 5,
        arm: "spec",
        method: "GET",
        path: `/tailnet/{T}/logging/configuration?${range}&eventType=YAW_PROBE_NO_SUCH_EVENT`,
        body: null,
        expect: "400 with a message, or an empty 200? The empty 200 is the trap PR38 has to defend against.",
      },
      {
        n: 6,
        arm: "spec",
        method: "GET",
        path: `/tailnet/{T}/logging/configuration?${range}&actor=user%40example.com&actor=other%40example.com`,
        body: null,
        optional: true,
        expect: "The same repeated-parameter question on a different filter, in case the behaviour is per-field.",
      },
    ];
  },
};
