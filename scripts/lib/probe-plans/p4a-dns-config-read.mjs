import { get, PATTERNS } from "./_shared.mjs";

/**
 * P4a -- read the real DnsConfiguration document and nothing else.
 *
 * The reviewer split P4 into three because only this third is safe anywhere.
 * It is a GET, it is the gate for PR21/PR22/PR33, and it is what decides
 * whether P4b may touch a real tailnet at all.
 *
 * Critic amendment 4: record the FULL key set at every level (top-level,
 * preferences, each resolver object), not just the keys that went missing. The
 * recorder attaches `response.keySets` to every fixture for exactly this, so
 * the comparison is mechanical rather than a reading exercise.
 *
 * countsOnly is "unattested": on target A the values are harness-seeded and
 * worth keeping as the real-shape fixture; on the owner's real tailnet a
 * nameserver list and a split-DNS map are his network, so only key sets,
 * counts and the two booleans this probe is about are persisted.
 */
export default {
  probeId: "P4a-dns-config-read",
  settles: ["C2"],
  question:
    "What does GET /dns/configuration actually return -- which spelling of splitDNS, which preference keys, and is overrideLocalDNS or any useWithExitNode set?",
  safetyClass: "safe-read-only",
  requiresTargetKind: null,
  methods: ["GET"],
  allowedRequests: [get(PATTERNS.dnsAny)],
  countsOnly: "unattested",
  credentialNeeds: "OAuth `dns` scope or an API key. The create-tailnet `all` client is sufficient on target A.",
  blastRadius: "None. GET only, enforced by the method allowlist.",
  cleanup: "None.",
  outcomes: [
    {
      when: "overrideLocalDNS is false AND no resolver carries useWithExitNode:true",
      ship: "P4b's no-op round trip MAY be pointed at the real tailnet, but only with --allow-real-reversible=P4b-dns-config-noop-roundtrip on top. Anything else and P4b is target A only.",
    },
    {
      when: "the document spells the key `splitDNS`",
      ship: "PR21's reshape uses that spelling; the tool's `splitDns` (dns.ts:201) is confirmed as a key the server can only be matching case-insensitively, if at all.",
    },
    {
      when: "preferences carries keys the four-key schema does not model",
      ship: "PR21 must model them or PR33's read-merge-write will strip them: zod strips what the schema does not declare, and this endpoint is a replace-all.",
    },
    {
      when: "the GET 404s or 403s",
      ship: "The unified endpoint is not available on this target (the Go client marks it alpha) -- inconclusive, and PR21/PR22/PR33 stay blocked.",
    },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/configuration",
        body: null,
        tool: { module: "tools/dns.js", name: "tailscale_get_dns_configuration", input: {} },
        expect:
          "200. The fixture's keySets map is the answer: $ , $.preferences, $.nameservers[], $.splitDNS.<domain>[].",
        note: "Also the real-shape fixture replacing the mocked pin at handlers.test.ts:1539-1563.",
      },
      {
        n: 2,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/nameservers",
        body: null,
        tool: { module: "tools/dns.js", name: "tailscale_get_nameservers", input: {} },
        expect: "200. The legacy view of the same state, for the replace-vs-merge argument in P4b.",
      },
      {
        n: 3,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/searchpaths",
        body: null,
        tool: { module: "tools/dns.js", name: "tailscale_get_search_paths", input: {} },
      },
      {
        n: 4,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/split-dns",
        body: null,
        tool: { module: "tools/dns.js", name: "tailscale_get_split_dns", input: {} },
      },
      {
        n: 5,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/preferences",
        body: null,
        tool: { module: "tools/dns.js", name: "tailscale_get_dns_preferences", input: {} },
        expect:
          "200. Whether `overrideLocalDNS` appears here as well as under configuration.preferences decides how PR33 does its read-merge-write.",
      },
    ];
  },
};
