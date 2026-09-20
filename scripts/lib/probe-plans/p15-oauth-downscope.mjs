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
  credentialNeeds:
    "One OAuth client whose scopes are a superset of everything asked for below. On the real tailnet this runs behind --allow-real-readonly and mints only read scopes.",
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
        form: { client_id: "<probe client>", client_secret: "<secret>", grant_type: "client_credentials" },
        expect: "200. Does the response carry `scope` at all when none was asked for?",
        note: "Harness-local raw POST. access_token redacted; scope/token_type/expires_in kept.",
      },
      {
        n: 2,
        arm: "spec",
        method: "POST",
        path: "/oauth/token",
        form: {
          client_id: "<probe client>",
          client_secret: "<secret>",
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
        expect: "200 under the step-2 token: the narrow scope really does grant this.",
      },
      {
        n: 4,
        arm: "spec",
        method: "GET",
        path: "/tailnet/{T}/acl",
        body: null,
        expect: "403 under the step-2 token: the narrow scope really does NOT grant this. A 200 means it is advisory.",
      },
      {
        n: 5,
        arm: "spec",
        method: "POST",
        path: "/oauth/token",
        form: {
          client_id: "<probe client>",
          client_secret: "<secret>",
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
          client_id: "<probe client>",
          client_secret: "<secret>",
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
          client_id: "<probe client>",
          client_secret: "<secret>",
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
          client_id: "<probe client>",
          client_secret: "<secret>",
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
          client_id: "<probe client>",
          client_secret: "<secret>",
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
