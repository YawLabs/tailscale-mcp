import { get, minusHours, PATTERNS, plusSeconds, rfc3339, rfc3339Fractional } from "./_shared.mjs";

/**
 * P1 -- does the logging API reject a query that omits `end`?
 *
 * The only probe that is safe to point at the real tailnet as-is, and even then
 * the recorder runs counts-only: audit and flow logs carry actor emails, IPs
 * and node names, so the fixture keeps status, top-level keys, logs.length and
 * the key set of the first element, never a log entry.
 */
export default {
  probeId: "P1-C6-log-end",
  settles: ["C6"],
  question:
    'Does the API reject a logging query that omits `end`, or does it default leniently as the tool text claims ("Defaults to now", audit.ts:74 and :98)?',
  safetyClass: "safe-read-only",
  requiresTargetKind: null,
  methods: ["GET"],
  allowedRequests: [get(PATTERNS.loggingConfiguration), get(PATTERNS.loggingNetwork)],
  countsOnly: true,
  credentialNeeds:
    "Any admin API key, or an OAuth client with logs:configuration:read (+ logs:network:read for the network arm; openapi.yaml:1268, :1313). No org requirement. This is the only probe that may use the real tailnet, behind --allow-real-readonly.",
  blastRadius:
    "None to tailnet state: GET only, enforced by the method allowlist. The only exposure is data, which is why this probe is countsOnly -- no log entry reaches disk.",
  cleanup: "None.",
  outcomes: [
    {
      when: "start-only -> 400",
      ship: "C6 rises to P0. Always send `end` (audit.ts:80-81, :104-105) and reword :74/:98. The changelog may state the default call shape of both tools was rejected with HTTP 400, quoting the observed message. The 400 body becomes the error-path fixture for handlers.test.ts:721 and :989.",
    },
    {
      when: "start-only -> 200",
      ship: 'The server defaults leniently (undocumented). Ship the fix anyway, but the changelog says "now always sends `end`, which the API documents as required" with NO never-worked claim; priority stays P1/P2.',
    },
    {
      when: "CONTROL fails on /logging/network with 403/404",
      ship: 'Flow logs are Premium/Enterprise. The network half is unobserved and must be worded "per spec".',
    },
    {
      when: "the now+60s arm 400s",
      ship: "PR6 must clamp `end` to the host clock rather than trusting it; a fast clock would otherwise turn a working audit call into a 400 in a patch release.",
    },
  ],
  steps(ctx) {
    const now = ctx.now;
    const start = rfc3339(minusHours(now, 1));
    const end = rfc3339(now);
    const endFractional = rfc3339Fractional(now);
    const endFuture = rfc3339(plusSeconds(now, 60));
    const rows = [];
    let n = 0;

    for (const [label, path, toolName] of [
      ["configuration", "/tailnet/{T}/logging/configuration", "tailscale_get_audit_log"],
      ["network", "/tailnet/{T}/logging/network", "tailscale_get_network_flow_logs"],
    ]) {
      rows.push({
        n: ++n,
        arm: "control",
        method: "GET",
        path: `${path}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
        body: null,
        expect: "200. If this fails the whole arm is inconclusive -- credential or plan, not shape.",
        note: `${label}: the paired control. A current-shape failure only counts when this succeeded in the same run.`,
      });
      rows.push({
        n: ++n,
        arm: "current",
        method: "GET",
        path: `${path}?start=${encodeURIComponent(start)}`,
        body: null,
        tool: { module: "tools/audit.js", name: toolName, input: { start } },
        expect: "400 if `end` is required (openapi.yaml:4177-4184, referenced at :1259 and :1307); 200 if lenient.",
        note: `${label}: emitted by the shipped handler, which only sets \`end\` when supplied (audit.ts:80-82, :104-106).`,
      });
      rows.push({
        n: ++n,
        arm: "spec",
        method: "GET",
        path: `${path}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
        body: null,
        tool: { module: "tools/audit.js", name: toolName, input: { start, end } },
        expect: "200, identical to the control.",
        note: `${label}: the shape the fix will always send.`,
      });
      rows.push({
        n: ++n,
        arm: "spec",
        method: "GET",
        path: `${path}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(endFractional)}`,
        body: null,
        tool: { module: "tools/audit.js", name: toolName, input: { start, end: endFractional } },
        expect: "200 or 400.",
        note: `${label}: reviewer addition. new Date().toISOString() carries milliseconds, so the fix's generated \`end\` has a fractional second. If the API rejects that, the fix has to truncate.`,
      });
      rows.push({
        n: ++n,
        arm: "spec",
        method: "GET",
        path: `${path}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(endFuture)}`,
        body: null,
        tool: { module: "tools/audit.js", name: toolName, input: { start, end: endFuture } },
        optional: true,
        expect: "200 or 400.",
        note: `${label}: reviewer addition. PR6 fills \`end\` from the HOST clock; on a host running fast that lands in the server's future. This says whether that 400s.`,
      });
    }
    return rows;
  },
};
