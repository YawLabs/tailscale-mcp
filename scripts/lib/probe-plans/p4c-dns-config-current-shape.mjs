import { get, PATTERNS, post, put } from "./_shared.mjs";

/**
 * P4c -- what the SHIPPED tool actually does to a tailnet's DNS.
 *
 * tailscale_set_dns_configuration sends `dns` / `splitDns` / `magicDNS`
 * (dns.ts:198-220), three keys the API does not define, alongside a correctly
 * named `searchPaths`. If the server decodes the body into its DnsConfiguration
 * struct and the unknown keys bind to nothing, a 200 here means the tool has
 * been writing an EMPTY configuration over live DNS -- the Go client's
 * omitempty structs (go-dns.go:151-166) are what make that the plausible case.
 *
 * TARGET A ONLY. There is no flag that makes this acceptable on a real tailnet,
 * which is why it carries the unsafe class and no per-probe override is wired.
 *
 * This probe also drives a remediation note, not just changelog wording: if the
 * wipe is real, past users' DNS settings were reset and they need telling.
 */
export default {
  probeId: "P4c-dns-config-current-shape",
  settles: ["C2"],
  question:
    "What does POST dns/configuration do with the keys the tool sends today (dns / splitDns / magicDNS): 400, silent no-op, or decode as an EMPTY config and wipe tailnet DNS?",
  safetyClass: "unsafe-needs-disposable-tailnet",
  requiresTargetKind: null,
  methods: ["GET", "POST", "PUT"],
  allowedRequests: [get(PATTERNS.dnsAny), post(PATTERNS.dnsAny), put(PATTERNS.splitDns)],
  credentialNeeds: "OAuth `dns` scope or an API key; the create-tailnet `all` client is sufficient.",
  blastRadius:
    "Tailnet-wide DNS outage. If the current body decodes as an empty replace-all config, every device loses global nameservers, split-DNS routes and search paths, and MagicDNS switches off -- and MagicDNS off can break the very name-based access needed to fix it. Never on a tailnet with real devices.",
  cleanup:
    "Teardown of target A. If the tailnet is kept for later probes, POST the captured baseline back and GET to confirm.",
  outcomes: [
    {
      when: "CURRENT-A 400",
      ship: "The tool never worked. Reshape per PR21; call out the breaking input change; the changelog may quote the 400.",
    },
    {
      when: "CURRENT-A 200 and the baseline is WIPED",
      ship: 'Data-loss bug, top of the release, worded as a safety fix ("could silently erase tailnet DNS"). Consider disabling the tool ahead of the full reshape, and ship a remediation note telling users to check their DNS settings.',
    },
    {
      when: "CURRENT-A 200 and the baseline is unchanged",
      ship: "Silent no-op: the tool reported success and did nothing. The changelog says exactly that.",
    },
    {
      when: "CURRENT-A 200 and the values were applied",
      ship: "The server still accepts the legacy keys. The fix becomes ADDITIVE (overrideLocalDNS, useWithExitNode) rather than breaking.",
    },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "seed",
        method: "POST",
        path: "/tailnet/{T}/dns/nameservers",
        body: { dns: ["8.8.8.8"] },
        requires: { attestedTarget: true },
        tool: { module: "tools/dns.js", name: "tailscale_set_nameservers", input: { dns: ["8.8.8.8"] } },
        expect: "200. A wipe is only observable against non-empty state.",
      },
      {
        n: 2,
        arm: "seed",
        method: "POST",
        path: "/tailnet/{T}/dns/searchpaths",
        body: { searchPaths: ["c2.yaw-probe.example.com"] },
        requires: { attestedTarget: true },
        tool: {
          module: "tools/dns.js",
          name: "tailscale_set_search_paths",
          input: { searchPaths: ["c2.yaw-probe.example.com"] },
        },
      },
      {
        n: 3,
        arm: "seed",
        method: "PUT",
        path: "/tailnet/{T}/dns/split-dns",
        body: { "corp.yaw-probe.example.com": ["10.0.0.1"] },
        requires: { attestedTarget: true },
        tool: {
          module: "tools/dns.js",
          name: "tailscale_set_split_dns",
          input: { splitDns: { "corp.yaw-probe.example.com": ["10.0.0.1"] } },
        },
      },
      {
        n: 4,
        arm: "seed",
        method: "POST",
        path: "/tailnet/{T}/dns/preferences",
        body: { magicDNS: true },
        requires: { attestedTarget: true },
        tool: { module: "tools/dns.js", name: "tailscale_set_dns_preferences", input: { magicDNS: true } },
      },
      {
        n: 5,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/configuration",
        body: null,
        tool: { module: "tools/dns.js", name: "tailscale_get_dns_configuration", input: {} },
        expect: "200 with all four seeds visible. This is the baseline a wipe would erase.",
      },
      {
        n: 6,
        arm: "current",
        method: "POST",
        path: "/tailnet/{T}/dns/configuration",
        body: { dns: ["1.1.1.1"], magicDNS: false },
        requires: { attestedTarget: true },
        tool: {
          module: "tools/dns.js",
          name: "tailscale_set_dns_configuration",
          input: { dns: ["1.1.1.1"], magicDNS: false },
        },
        expect: "The worst-case body: keys that bind to nothing even under case-insensitive decoding.",
      },
      {
        n: 7,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/configuration",
        body: null,
        expect: "Diff against step 5. Unchanged = no-op; empty = wipe; 1.1.1.1 present = legacy keys still accepted.",
      },
      {
        n: 8,
        arm: "reseed",
        method: "POST",
        path: "/tailnet/{T}/dns/configuration",
        bodyFromStep: 5,
        requires: { attestedTarget: true },
        expect: "Restore the baseline before the next arm, so CURRENT-B is measured against the same state.",
      },
      {
        n: 9,
        arm: "current",
        method: "POST",
        path: "/tailnet/{T}/dns/configuration",
        body: { splitDns: { "corp.yaw-probe.example.com": ["10.0.0.2"] } },
        requires: { attestedTarget: true },
        tool: {
          module: "tools/dns.js",
          name: "tailscale_set_dns_configuration",
          input: { splitDns: { "corp.yaw-probe.example.com": ["10.0.0.2"] } },
        },
        expect:
          "A key that case-insensitively matches splitDNS but carries string[] where resolver objects are expected.",
      },
      {
        n: 10,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/configuration",
        body: null,
        expect: "Diff against step 5 again.",
      },
      {
        n: 11,
        arm: "spec",
        method: "POST",
        path: "/tailnet/{T}/dns/configuration",
        body: {
          nameservers: [{ address: "1.1.1.1" }],
          splitDNS: { "corp.yaw-probe.example.com": [{ address: "10.0.0.2" }] },
          searchPaths: ["c2.yaw-probe.example.com"],
          preferences: { magicDNS: true, overrideLocalDNS: false },
        },
        requires: { attestedTarget: true },
        expect:
          "200 (openapi.yaml:1811-1828, DnsConfiguration :5661-5705). The paired control: a CURRENT failure only counts if this succeeded in the same run.",
      },
      {
        n: 12,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/dns/configuration",
        body: null,
        expect: "The spec shape's effect, and the fixture replacing the mocked pin at handlers.test.ts:4164-4188.",
      },
    ];
  },
};
