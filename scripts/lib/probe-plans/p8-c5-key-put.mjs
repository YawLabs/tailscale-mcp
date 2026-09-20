import { del, get, PATTERNS, post, put } from "./_shared.mjs";

/**
 * P8 -- does PUT keys/{id} need keyType, and does a sparse body merge or
 * replace?
 *
 * The scopes mirror the repo's own live round trip (integration.test.ts:205-206,
 * :253-254), so this probe stays inside behaviour the repo already exercises
 * against a real tailnet. The `key` secret in every create response is redacted
 * and never persisted.
 *
 * The auth-key arm needs its own target: an OAuth-minted auth key must be
 * tagged, which needs a tagOwners ACL edit, so that arm is routed to tailnet B
 * and its user-owned key instead. It is marked `requires.targetKind: "human"`
 * rather than split into a separate probe, because it answers the same
 * question about the same endpoint.
 */
export default {
  probeId: "P8-C5-key-put",
  settles: ["C5"],
  question:
    "Does PUT keys/{id} need keyType, does a sparse body merge or replace (strip scopes/tags), and can an auth key's description really be updated as keys.ts:214 claims?",
  safetyClass: "safe-reversible-write",
  requiresTargetKind: null,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedRequests: [
    get(PATTERNS.keys),
    post(PATTERNS.keys),
    get(PATTERNS.keyById),
    put(PATTERNS.keyById),
    del(PATTERNS.keyById),
  ],
  credentialNeeds:
    "A user-owned API key works for every arm. With OAuth: oauth_keys for clients, federated_keys for federated identities (openapi.yaml:2115-2117), auth_keys for the auth-key arm -- and an OAuth-minted auth key must be tagged, which needs a tagOwners ACL edit, hence the auth-key arm goes to tailnet B.",
  blastRadius:
    "Touches only credentials the harness itself mints -- exactly what integration.test.ts:184-229 already does. If a sparse PUT strips scopes, it strips them from a probe key. Worst case after a crash is a leftover devices:read credential whose secret was never written anywhere. It never PUTs to a pre-existing key: the egress guard only permits key ids this run created.",
  cleanup:
    "DELETE /tailnet/{T}/keys/{id} for every created id (journalled before each create resolves); GET /tailnet/{T}/keys?all=true must then show no description starting yaw-probe-c5.",
  outcomes: [
    {
      when: "CURRENT 200 and scopes intact",
      ship: "The rename works today: the server infers the type and merges. The fix shrinks to an optional keyType pass-through plus correcting the description text. No GET-merge-PUT, no breakage claim.",
    },
    {
      when: "CURRENT 200 and scopes cleared or changed",
      ship: "Data-loss bug -> P0. The handler must GET-merge-PUT or require the full config, and the changelog states that a description-only update stripped the credential's scopes (observed).",
    },
    {
      when: "CURRENT 400",
      ship: 'Never worked for OAuth clients. The KEYTYPE-SPARSE step says which part was missing: keyType, or "at least one scope is required" (openapi.yaml:2144).',
    },
    {
      when: "AUTH-KEY arm 4xx",
      ship: "Drop the auth-key claim at keys.ts:214. A 200 with the description changed means the claim is true and the spec is incomplete -- keep it and mark it undocumented.",
    },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "seed",
        method: "POST",
        path: "/tailnet/{T}/keys",
        body: { keyType: "client", description: "yaw-probe-c5", scopes: ["devices:read"] },
        tool: {
          module: "tools/keys.js",
          name: "tailscale_create_key",
          input: { keyType: "client", description: "yaw-probe-c5", scopes: ["devices:read"] },
        },
        registers: "id",
        idKey: "K",
        undo: { method: "DELETE", path: "/tailnet/{T}/keys/{id}" },
        expect: "200 -> id K. The `key` secret is redacted before anything is persisted.",
      },
      {
        n: 2,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/keys/{K}",
        body: null,
        tool: { module: "tools/keys.js", name: "tailscale_get_key", input: { keyId: "{K}" } },
        expect: "200. The baseline every later diff is against.",
      },
      {
        n: 3,
        arm: "current",
        method: "PUT",
        path: "/tailnet/{T}/keys/{K}",
        body: { description: "yaw-probe-c5-r1" },
        tool: {
          module: "tools/keys.js",
          name: "tailscale_update_key",
          input: { keyId: "{K}", description: "yaw-probe-c5-r1" },
        },
        expect: "keys.ts:245-260 sends no keyType and a sparse body. Description changed? Scopes intact?",
      },
      { n: 4, arm: "observe", method: "GET", path: "/tailnet/{T}/keys/{K}", body: null },
      {
        n: 5,
        arm: "spec",
        method: "PUT",
        path: "/tailnet/{T}/keys/{K}",
        body: { keyType: "client", description: "yaw-probe-c5-r2" },
        expect: "KEYTYPE-SPARSE: does adding keyType alone fix a 400 from step 3?",
      },
      { n: 6, arm: "observe", method: "GET", path: "/tailnet/{T}/keys/{K}", body: null },
      {
        n: 7,
        arm: "spec",
        method: "PUT",
        path: "/tailnet/{T}/keys/{K}",
        body: { keyType: "client", description: "yaw-probe-c5-r3", scopes: ["devices:read"] },
        expect:
          "The full Go-client shape (openapi.yaml:2110-2194; keys_client.go:145-149 always sends keyType plus the whole config).",
      },
      { n: 8, arm: "observe", method: "GET", path: "/tailnet/{T}/keys/{K}", body: null },
      {
        n: 9,
        arm: "spec",
        method: "PUT",
        path: "/tailnet/{T}/keys/{K}",
        body: { keyType: "client", scopes: ["dns:read"] },
        expect: "REPLACE CHECK: with no description in the body, is the description cleared?",
      },
      { n: 10, arm: "observe", method: "GET", path: "/tailnet/{T}/keys/{K}", body: null },
      {
        n: 11,
        arm: "seed",
        method: "POST",
        path: "/tailnet/{T}/keys",
        body: { description: "yaw-probe-c5-auth", expirySeconds: 3600 },
        requires: { targetKind: "human" },
        tool: {
          module: "tools/keys.js",
          name: "tailscale_create_key",
          input: { description: "yaw-probe-c5-auth", expirySeconds: 3600 },
        },
        registers: "id",
        idKey: "A",
        undo: { method: "DELETE", path: "/tailnet/{T}/keys/{id}" },
        expect: "200 -> id A. Auth-key arm, tailnet B with the user-owned key so no tagOwners edit is needed.",
      },
      {
        n: 12,
        arm: "current",
        method: "PUT",
        path: "/tailnet/{T}/keys/{A}",
        body: { description: "yaw-probe-c5-auth-r1" },
        requires: { targetKind: "human" },
        tool: {
          module: "tools/keys.js",
          name: "tailscale_update_key",
          input: { keyId: "{A}", description: "yaw-probe-c5-auth-r1" },
        },
        expect: "Tests the claim at keys.ts:214 that an auth key's description can be updated.",
      },
      {
        n: 13,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/keys/{A}",
        body: null,
        requires: { targetKind: "human" },
      },
      {
        n: 14,
        arm: "seed",
        method: "POST",
        path: "/tailnet/{T}/keys",
        body: {
          keyType: "federated",
          scopes: ["devices:read"],
          issuer: "https://token.actions.githubusercontent.com",
          subject: "repo:yaw-probe/none:*",
        },
        optional: true,
        tool: {
          module: "tools/keys.js",
          name: "tailscale_create_key",
          input: {
            keyType: "federated",
            scopes: ["devices:read"],
            issuer: "https://token.actions.githubusercontent.com",
            subject: "repo:yaw-probe/none:*",
          },
        },
        registers: "id",
        idKey: "F",
        undo: { method: "DELETE", path: "/tailnet/{T}/keys/{id}" },
        expect: "Optional federated arm -> id F.",
      },
      {
        n: 15,
        arm: "current",
        method: "PUT",
        path: "/tailnet/{T}/keys/{F}",
        body: { description: "yaw-probe-c5-fed-r1" },
        optional: true,
        expect: "Sparse PUT on a federated identity: are issuer and subject intact afterwards?",
      },
      { n: 16, arm: "observe", method: "GET", path: "/tailnet/{T}/keys/{F}", body: null, optional: true },
      {
        n: 17,
        arm: "cleanup",
        method: "DELETE",
        path: "/tailnet/{T}/keys/{id}",
        sweep: "journal",
        body: null,
        expect: "Every created id deleted; GET /tailnet/{T}/keys?all=true shows no yaw-probe-c5 description.",
        note: "A journal sweep, because this probe creates up to THREE keys under distinct placeholders (K, A, F) and no single `{id}` names them all.",
      },
    ];
  },
};
