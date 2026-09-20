import { get, PATTERNS } from "./_shared.mjs";

/**
 * P15 -- can a token be minted with fewer scopes than the client holds, and
 * does the response echo what was granted?
 *
 * PR36 (TAILSCALE_OAUTH_SCOPES) rests on two assumptions that are each enough
 * to break every mint if wrong: that the token response echoes `scope`, and
 * that the echo is a plain subset of what was asked for. Neither is safe to
 * assume. A missing `scope` in a client_credentials response is RFC-legal, and
 * Tailscale documents IMPLIED scopes (policy_file:read pulls in
 * devices:core:read) and UMBRELLA scopes (all:read), so the echo can legally
 * come back LARGER than the request.
 *
 * Like P9, every mint here is a harness-local raw POST to /api/v2/oauth/token,
 * never getOAuthAccessToken (critic amendment 3): the shipped path caches the
 * token in a module-global and discards the body, which is the one thing this
 * probe needs to keep. access_token is redacted; `scope`, `token_type` and
 * `expires_in` are the fixture.
 *
 * TWO WIRING FACTS A READER SHOULD NOT HAVE TO INFER.
 *
 * 1. The mints use TS_PROBE_DOWNSCOPE_CLIENT_ID / _SECRET, declared below as
 *    `mintCredential: "downscope"`. That is this probe's OWN client, not P9's
 *    short-lived `all`-scope client in the real creating tailnet: step 8 asks
 *    for dns:write, and asking that of an `all`-scope production client is a
 *    different and much larger question than the one this probe is about. The
 *    runner refuses a mint whose client id or secret is unset rather than
 *    sending a placeholder, and runs the credential-isolation check over that
 *    secret too.
 * 2. Steps 3 and 4 are the whole thesis, so they carry
 *    `credentialTarget: "minted"`: the runner sends them with the bearer the
 *    LAST mint returned, not with the ordinary target credential. Without that
 *    they would have gone out under the target credential and recorded its
 *    answer -- a 200 that says nothing about the narrow token.
 */
export default {
  probeId: "P15-oauth-downscope",
  settles: ["C-oauth-downscope"],
  question:
    "Does /oauth/token accept a `scope` parameter, and does the response echo the granted scopes -- as a subset, or expanded by implied and umbrella scopes?",
  safetyClass: "safe-read-only",
  requiresTargetKind: null,
  methods: ["GET"],
  allowedRequests: [get(PATTERNS.devices), get(PATTERNS.acl)],
  countsOnly: true,
  mintCredential: "downscope",
  credentialNeeds:
    "TS_PROBE_DOWNSCOPE_CLIENT_ID / _SECRET: one OAuth client whose scopes are a superset of everything asked for below, EXCEPT dns:write, which step 8 asks for on purpose. On the real tailnet this runs behind --allow-real-readonly and every scope it asks for is a read scope.",
  blastRadius:
    "Token mints plus two GETs, enforced by the method allowlist: GET on devices and acl, and POST only on the token endpoint. The exposure is the mints themselves, so every requested scope here is a read scope and the recorder runs countsOnly.",
  cleanup: "None. Minted tokens expire on their own; the owner may revoke the client afterwards.",
  outcomes: [
    {
      when: "`scope` is rejected",
      ship: "PR36 cannot be built this way at all. Drop it, or restrict it to choosing among several clients.",
    },
    {
      when: "the response omits `scope`",
      ship: "PR36 must not verify the grant from the response. It can send the request and say plainly that the server does not confirm what it granted.",
    },
    {
      when: "the echo is LARGER than the request (implied or umbrella scopes)",
      ship: "A subset check would reject a perfectly good token. PR36 must compare against the documented implication graph, or not compare at all.",
    },
    {
      when: "asking for a scope the client does not hold succeeds anyway",
      ship: "Down-scoping is advisory, not enforced. PR36's description must not promise least privilege.",
    },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "control",
        method: "POST",
        path: "/oauth/token",
        form: {
          client_id: "<TS_PROBE_DOWNSCOPE_CLIENT_ID>",
          client_secret: "<TS_PROBE_DOWNSCOPE_CLIENT_SECRET>",
          grant_type: "client_credentials",
        },
        expect: "200. Does the response carry `scope` at all when none was asked for?",
        note: "Harness-local raw POST. access_token redacted; scope/token_type/expires_in kept.",
      },
      {
        n: 2,
        arm: "spec",
        method: "POST",
        path: "/oauth/token",
        form: {
          client_id: "<TS_PROBE_DOWNSCOPE_CLIENT_ID>",
          client_secret: "<TS_PROBE_DOWNSCOPE_CLIENT_SECRET>",
          grant_type: "client_credentials",
          scope: "devices:core:read",
        },
        expect: "One narrow scope. Echoed back verbatim?",
      },
      {
        n: 3,
        arm: "spec",
        method: "GET",
        path: "/tailnet/{T}/devices",
        body: null,
        credentialTarget: "minted",
        expect: "200 under the step-2 token: the narrow scope really does grant this.",
        note: "Sent with the step-2 bearer, not the target credential -- see the header. A harness-local raw GET, because apiRequest builds its own Authorization header from the environment.",
      },
      {
        n: 4,
        arm: "spec",
        method: "GET",
        path: "/tailnet/{T}/acl",
        body: null,
        credentialTarget: "minted",
        expect: "403 under the step-2 token: the narrow scope really does NOT grant this. A 200 means it is advisory.",
      },
      {
        n: 5,
        arm: "spec",
        method: "POST",
        path: "/oauth/token",
        form: {
          client_id: "<TS_PROBE_DOWNSCOPE_CLIENT_ID>",
          client_secret: "<TS_PROBE_DOWNSCOPE_CLIENT_SECRET>",
          grant_type: "client_credentials",
          scope: "policy_file:read",
        },
        expect:
          "The IMPLIED-scope case: policy_file:read is documented to require devices:core:read. Does the echo come back with both?",
      },
      {
        n: 6,
        arm: "spec",
        method: "POST",
        path: "/oauth/token",
        form: {
          client_id: "<TS_PROBE_DOWNSCOPE_CLIENT_ID>",
          client_secret: "<TS_PROBE_DOWNSCOPE_CLIENT_SECRET>",
          grant_type: "client_credentials",
          scope: "all:read",
        },
        expect: "The UMBRELLA case: does all:read echo as itself, or expand into a list?",
      },
      {
        n: 7,
        arm: "spec",
        method: "POST",
        path: "/oauth/token",
        form: {
          client_id: "<TS_PROBE_DOWNSCOPE_CLIENT_ID>",
          client_secret: "<TS_PROBE_DOWNSCOPE_CLIENT_SECRET>",
          grant_type: "client_credentials",
          scope: "devices:core:read policy_file:read",
        },
        expect: "Two scopes, space-separated per RFC 6749. Is the separator accepted?",
      },
      {
        n: 8,
        arm: "spec",
        method: "POST",
        path: "/oauth/token",
        form: {
          client_id: "<TS_PROBE_DOWNSCOPE_CLIENT_ID>",
          client_secret: "<TS_PROBE_DOWNSCOPE_CLIENT_SECRET>",
          grant_type: "client_credentials",
          scope: "dns:write",
        },
        expect:
          "A scope the probe client does NOT hold. A 400 means down-scoping is enforced; a 200 means it is advisory and PR36 must say so.",
      },
      {
        n: 9,
        arm: "spec",
        method: "POST",
        path: "/oauth/token?tailnet={T}",
        form: {
          client_id: "<TS_PROBE_DOWNSCOPE_CLIENT_ID>",
          client_secret: "<TS_PROBE_DOWNSCOPE_CLIENT_SECRET>",
          grant_type: "client_credentials",
          tailnet: "{T}",
          scope: "devices:core:read",
        },
        optional: true,
        requires: { targetKind: "api-only" },
        expect: "tailnet targeting AND a narrow scope together, since PR27 and PR36 would otherwise interact blind.",
      },
    ];
  },
};
