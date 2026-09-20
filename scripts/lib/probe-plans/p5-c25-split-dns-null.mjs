import { get, PATTERNS, patch, put } from "./_shared.mjs";

/**
 * P5 -- does `[]` actually REMOVE a split-DNS domain, or leave a residue?
 *
 * dns.ts:150 tells agents that setting a domain's nameservers to an empty array
 * removes it; the spec's idiom is `null` (openapi.yaml:1737-1742, SplitDns
 * :5618-5634). The tool cannot even send null today -- zod rejects it locally
 * at dns.ts:159-160 -- so the spec arm is a raw apiRequest.
 *
 * The catch worth naming: removal is the very behaviour under test. If `[]`
 * leaves residue and `null` is rejected, the only remaining cleanup is a
 * replace-all PUT of the captured baseline, which is not a casual thing to do
 * to real DNS. So the PUT arm is attested-target-only and this probe is meant
 * to run on target A straight after P4.
 */
export default {
  probeId: "P5-C25-split-dns-null",
  settles: ["C25"],
  question:
    "Do `[]` (the tool's documented removal idiom) and `null` (the spec's) both actually remove a split-DNS domain?",
  safetyClass: "safe-reversible-write",
  requiresTargetKind: null,
  methods: ["GET", "PATCH", "PUT"],
  allowedRequests: [get(PATTERNS.splitDns), patch(PATTERNS.splitDns), put(PATTERNS.splitDns)],
  credentialNeeds: "OAuth `dns` scope or an API key; the create-tailnet `all` client is sufficient.",
  blastRadius:
    "PATCH arm: a split-DNS route for a probe-only domain under example.com is pushed to every device's netmap and removed again. The PUT arm is replace-all (openapi.yaml:1763-1768) and is never permitted on an unattested target.",
  cleanup:
    "GET must show no *.yaw-probe.example.com keys. Fallback: PUT the baseline map captured in step 1. On target A, teardown covers it.",
  outcomes: [
    {
      when: "`[]` leaves `domain: []` behind",
      ship: "The documented removal idiom is wrong. C25 rises to P1: add .nullable() at dns.ts:103-104 and :159-160 and rewrite the description at :150 to say null. The test at handlers.test.ts:4098-4140 that calls [] the documented removal idiom must change.",
    },
    { when: "both forms remove the key", ship: "nullable is a convenience (stays P2-low); document both forms." },
    { when: "`null` -> 400", ship: "The spec is wrong here; do NOT add nullable." },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/split-dns",
        body: null,
        tool: { module: "tools/dns.js", name: "tailscale_get_split_dns", input: {} },
        expect: "200. The baseline map, kept as the only restore path if removal turns out not to work.",
      },
      {
        n: 2,
        arm: "seed",
        method: "PATCH",
        path: "/tailnet/{T}/dns/split-dns",
        body: { "c25.yaw-probe.example.com": ["10.0.0.1"] },
        tool: {
          module: "tools/dns.js",
          name: "tailscale_update_split_dns",
          input: { splitDns: { "c25.yaw-probe.example.com": ["10.0.0.1"] } },
        },
      },
      { n: 3, arm: "observe", method: "GET", path: "/tailnet/{T}/dns/split-dns", body: null },
      {
        n: 4,
        arm: "current",
        method: "PATCH",
        path: "/tailnet/{T}/dns/split-dns",
        body: { "c25.yaw-probe.example.com": [] },
        tool: {
          module: "tools/dns.js",
          name: "tailscale_update_split_dns",
          input: { splitDns: { "c25.yaw-probe.example.com": [] } },
        },
        expect: "The documented removal idiom (dns.ts:165-167).",
      },
      {
        n: 5,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/split-dns",
        body: null,
        expect: "Key absent, or present with []? That is the finding.",
      },
      {
        n: 6,
        arm: "reseed",
        method: "PATCH",
        path: "/tailnet/{T}/dns/split-dns",
        body: { "c25.yaw-probe.example.com": ["10.0.0.1"] },
      },
      {
        n: 7,
        arm: "spec",
        method: "PATCH",
        path: "/tailnet/{T}/dns/split-dns",
        body: { "c25.yaw-probe.example.com": null },
        expect: "200 or 400.",
        note: "Raw apiRequest: zod rejects null locally at dns.ts:159-160, so no tool can emit this today.",
      },
      { n: 8, arm: "observe", method: "GET", path: "/tailnet/{T}/dns/split-dns", body: null },
      {
        n: 9,
        arm: "spec",
        method: "PUT",
        path: "/tailnet/{T}/dns/split-dns",
        body: { "a.yaw-probe.example.com": ["10.0.0.1"], "b.yaw-probe.example.com": null },
        requires: { attestedTarget: true },
        expect: "Does a null inside a replace-all PUT mean absent, or is it a 400?",
        note: "PUT is replace-all (openapi.yaml:1763-1768). Never on an unattested target.",
      },
      { n: 10, arm: "observe", method: "GET", path: "/tailnet/{T}/dns/split-dns", body: null },
      {
        n: 11,
        arm: "cleanup",
        method: "PUT",
        path: "/tailnet/{T}/dns/split-dns",
        bodyFromStep: 1,
        requires: { attestedTarget: true },
        expect: "GET must then show no *.yaw-probe.example.com keys.",
      },
    ];
  },
};
