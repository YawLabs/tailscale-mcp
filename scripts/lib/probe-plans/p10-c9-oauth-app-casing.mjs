import { del, get, PATTERNS, post } from "./_shared.mjs";

/**
 * P10 -- does createOAuthApp accept the wire key `redirectUris` the tool sends
 * (and that Tailscale's own KB documents), or only the spec's `redirectURIs`,
 * and are the URIs actually STORED?
 *
 * Two official sources disagree on the casing, which is why C9 cannot ship
 * blind. The failure mode that matters is not the 400: it is a 200 whose stored
 * redirect list comes back EMPTY, which is why every create is followed by a
 * GET of the created app rather than being judged on its status.
 *
 * The reviewer added a description field to step 1 and a non-mutating step 0:
 * PUT a bogus app id first, so a routed-but-absent 404 can be told apart from
 * an unrouted 404 on a feature that is simply not enabled here.
 */
export default {
  probeId: "P10-C9-oauth-app-casing",
  settles: ["C9"],
  question: "Is the wire key `redirectUris` or `redirectURIs`, and are the URIs stored at all?",
  safetyClass: "safe-reversible-write",
  requiresTargetKind: null,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedRequests: [
    get(PATTERNS.oauthApps),
    post(PATTERNS.oauthApps),
    get(PATTERNS.oauthAppById),
    { method: "PUT", pattern: PATTERNS.oauthAppById },
    del(PATTERNS.oauthAppById),
  ],
  credentialNeeds:
    "OAuth `oauth_apps` scope (openapi.yaml:3814) or an API key; the create-tailnet `all` client is sufficient IF the alpha feature is on.",
  blastRadius:
    "Additive only: probe OAuth apps whose secrets are never persisted and which are useless without the secret plus a user's consent. Worst case after a crash is an inert leftover registration. Alpha feature; may simply be disabled on the target.",
  cleanup:
    "DELETE /tailnet/{T}/oauth-apps/{id} for each created id; GET /tailnet/{T}/oauth-apps must then list no yaw-probe-c9-* app.",
  outcomes: [
    {
      when: "CURRENT 200 and the URIs are stored",
      ship: "Casing is a non-issue (case-insensitive decoding). C9 stays P3 watch-only, no changelog claim; emitting `redirectURIs` becomes optional tidiness.",
    },
    {
      when: 'CURRENT 400 ("redirectURIs required"), or 200 with an EMPTY stored list',
      ship: "The tool never worked -> P0. Flip the wire key at keys.ts:306.",
    },
    { when: "SPEC 400 while CURRENT 200", ship: "The spec is wrong; leave the wire key alone." },
    {
      when: "RULES VARIANT 400",
      ship: "Tightening z.url() at keys.ts:285-288 is a friendlier-error nicety. A 200 means the documented rules are not enforced, so do not over-tighten locally.",
    },
    {
      when: "step 0 returns the SAME 404 body as a create",
      ship: "The endpoint is not routed on this target: the feature is off and every arm here is inconclusive, not a finding.",
    },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "precheck",
        method: "PUT",
        path: "/tailnet/{T}/oauth-apps/yaw-probe-does-not-exist",
        body: { name: "yaw-probe-c9-precheck" },
        expect:
          "A 404. Its BODY is the point: a routed-but-absent 404 reads differently from an unrouted one, and that tells us whether a later 404 means the feature is off.",
        note: "Reviewer addition: non-mutating, because the id cannot exist.",
      },
      {
        n: 2,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/oauth-apps",
        body: null,
        tool: { module: "tools/keys.js", name: "tailscale_list_oauth_apps", input: {} },
        registers: "ids",
        expect: "200 and the baseline list, or the 403/404 that makes this probe inconclusive.",
      },
      {
        n: 3,
        arm: "current",
        method: "POST",
        path: "/tailnet/{T}/oauth-apps",
        body: {
          name: "yaw-probe-c9-a",
          redirectUris: ["https://example.com/yaw-probe/callback"],
          scopes: ["auth_keys:create:once"],
        },
        tool: {
          module: "tools/keys.js",
          name: "tailscale_create_oauth_app",
          input: {
            name: "yaw-probe-c9-a",
            redirectUris: ["https://example.com/yaw-probe/callback"],
            scopes: ["auth_keys:create:once"],
          },
        },
        registers: "id",
        undo: { method: "DELETE", path: "/tailnet/{T}/oauth-apps/{id}" },
        expect: "keys.ts:304-310 sends the lowercase-i key. The client secret in the response is redacted.",
      },
      {
        n: 4,
        arm: "observe",
        method: "GET",
        path: "/tailnet/{T}/oauth-apps/{id}",
        body: null,
        tool: { module: "tools/keys.js", name: "tailscale_get_oauth_app", input: { appId: "{id}" } },
        expect: "Is the stored redirect list the one that was sent, or EMPTY? The empty case is the silent failure.",
      },
      {
        n: 5,
        arm: "spec",
        method: "POST",
        path: "/tailnet/{T}/oauth-apps",
        body: {
          name: "yaw-probe-c9-b",
          description: "yaw probe c9",
          redirectURIs: ["https://example.com/yaw-probe/callback"],
          scopes: ["auth_keys:create:once"],
        },
        registers: "id",
        undo: { method: "DELETE", path: "/tailnet/{T}/oauth-apps/{id}" },
        expect: "200 (openapi.yaml:3818-3837, `redirectURIs` required).",
        note: "Reviewer addition: carries `description`, which the tool does not model today -- PR26 adds it, and this says whether the API stores it.",
      },
      { n: 6, arm: "observe", method: "GET", path: "/tailnet/{T}/oauth-apps/{id}", body: null },
      {
        n: 7,
        arm: "spec",
        method: "POST",
        path: "/tailnet/{T}/oauth-apps",
        body: {
          name: "yaw-probe-c9-c",
          redirectURIs: ["http://example.com/cb"],
          scopes: ["auth_keys:create:once"],
        },
        registers: "id",
        undo: { method: "DELETE", path: "/tailnet/{T}/oauth-apps/{id}" },
        expect: "400 expected (non-https, non-localhost). Capture the message.",
      },
      {
        n: 8,
        arm: "spec",
        method: "PUT",
        path: "/tailnet/{T}/oauth-apps/{id}",
        body: { name: "yaw-probe-c9-b2", redirectURIs: ["https://example.com/yaw-probe/callback2"] },
        optional: true,
        expect: "Does an update endpoint exist at all, and is it PUT? PR34 (tailscale_update_oauth_app) depends on it.",
        note: "Mandatory http step with its own outcome row: if this 404s or 405s, PR34 cannot be a read-modify-write and must be dropped or redesigned.",
      },
      { n: 9, arm: "observe", method: "GET", path: "/tailnet/{T}/oauth-apps/{id}", body: null, optional: true },
      {
        n: 10,
        arm: "cleanup",
        method: "DELETE",
        path: "/tailnet/{T}/oauth-apps/{id}",
        body: null,
        tool: { module: "tools/keys.js", name: "tailscale_delete_oauth_app", input: { appId: "{id}" } },
        expect: "Every created id deleted; the list shows no yaw-probe-c9-* app.",
      },
    ];
  },
};
