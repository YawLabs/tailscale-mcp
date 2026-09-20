import { get, PATTERNS, post } from "./_shared.mjs";

const MARKER = "c7-marker.yaw-probe.example.com";

/** Only the boolean survives: under a mis-scoped token this read is the REAL tailnet's search paths. */
function markerPresent(parsed) {
  const paths = Array.isArray(parsed?.searchPaths) ? parsed.searchPaths : Array.isArray(parsed) ? parsed : [];
  return { markerPresent: paths.some((p) => String(p).toLowerCase() === MARKER), searchPathCount: paths.length };
}

/**
 * P9 -- does /oauth/token honour `tailnet` as a URL query param (what
 * api.ts:135-137 sends) or only as the documented form-body field, and if the
 * query form is ignored, is it ignored SILENTLY?
 *
 * TWO THINGS ABOUT THIS PROBE ARE UNUSUAL.
 *
 * 1. Every mint here is a harness-local raw POST to /api/v2/oauth/token, NEVER
 *    getOAuthAccessToken (critic amendment 3). Three reasons, all of them
 *    load-bearing: that function caches the token in a module-global
 *    (api.ts:41) so a token minted for one arm would ride onto the next; it
 *    throws away the raw response body, which is the fixture this probe exists
 *    to capture; and it cannot emit the spec's form-body shape at all. This is
 *    the ONE place in the harness where a CURRENT arm is a reconstruction
 *    rather than the shipped code path, and the reconstruction is byte-for-byte
 *    what api.ts:135-146 builds: the same three form fields, the tailnet only
 *    on the query string.
 *
 * 2. The discriminator GET /tailnet/-/dns/searchpaths is the one place the
 *    egress guard lets a bare "-" through, GET only. That is the question: if
 *    the mint was mis-scoped, this read lands on the REAL tailnet. Which is
 *    exactly why the recorder runs countsOnly here and the step derives a
 *    single boolean -- no search path from anyone's tailnet reaches disk.
 */
export default {
  probeId: "P9-C7-oauth-tailnet-param",
  settles: ["C7"],
  question:
    "Does /oauth/token honour `tailnet` as a query param, as a form field, or both -- and if the query form is ignored, is it ignored silently?",
  safetyClass: "safe-read-only",
  requiresTargetKind: "api-only",
  requiresTargetKindWhy:
    "the whole question is about reaching an API-only tailnet from a creating-tailnet client, which needs one to exist",
  methods: ["GET", "POST"],
  allowedRequests: [get(PATTERNS.searchPaths), post(PATTERNS.searchPaths), get(/^\/tailnet\/-\/dns\/searchpaths$/)],
  allowBareTailnetGet: true,
  countsOnly: true,
  // Which client the mint steps authenticate with. The runner refuses the mint
  // outright if TS_PROBE_CREATING_CLIENT_ID / _SECRET are unset, rather than
  // sending the display placeholders below as if they were credentials.
  mintCredential: "creating",
  credentialNeeds:
    "OAuth only -- API keys cannot do this. (1) an OAuth client in the CREATING tailnet with the `all` scope (critic_tcapi.html.txt:596-598), short-lived and revoked immediately afterwards; (2) the API-only tailnet and its OWN returned client, used for the marker write.",
  blastRadius:
    "To tailnet state: none beyond one probe search path on target A. The exposure is the CREDENTIAL: an `all`-scope OAuth client on the real tailnet is the most powerful secret this harness ever holds. Supply it for this probe only and revoke it straight after. The discriminator GET may read the real tailnet's search paths, so only a boolean and a count are persisted.",
  cleanup:
    "Remove the marker (or tear down target A); the owner revokes the `all`-scope client in the admin console; `scrub-check` confirms no token or secret reached disk.",
  outcomes: [
    {
      when: "CURRENT markerPresent = true",
      ship: "The query form works; C7 is docs-conformance only. Move `tailnet` into the URLSearchParams body (api.ts:141-145) keeping the query too, fix the comment at :131-133 and the wording at CHANGELOG.md:189, and say the query form also worked (observed).",
    },
    {
      when: "CURRENT 200 but markerPresent = false",
      ship: 'SILENT WRONG TARGET. With TAILSCALE_OAUTH_TAILNET set and TAILSCALE_TAILNET unset or "-" -- which server-wiring.ts:257-261 treats as the correct config -- every tool call hit the CREATING tailnet. P0, leads the changelog, and consider addressing /tailnet/<TAILSCALE_OAUTH_TAILNET>/ explicitly so a mis-scoped token 403s instead of retargeting.',
    },
    { when: "CURRENT 400", ship: "Loud failure: the feature never worked, and the body form is the fix." },
    { when: "SPEC fails while CURRENT works", ship: "The docs are wrong. Keep the query form; do not ship." },
    { when: "BOTH fails", ship: "Send the body form only." },
  ],
  steps() {
    return [
      {
        n: 1,
        arm: "seed",
        method: "POST",
        path: "/tailnet/{T}/dns/searchpaths",
        body: { searchPaths: [MARKER] },
        requires: { attestedTarget: true },
        credentialTarget: "A",
        undo: { method: "POST", path: "/tailnet/{T}/dns/searchpaths", body: { searchPaths: [] } },
        expect: `200. Written to target A with target A's OWN client, never the creating-tailnet one.`,
        note: "If this used the creating-tailnet client the marker would prove nothing -- it has to be a fact about target A that only a correctly scoped token can see.",
      },
      {
        n: 2,
        arm: "control",
        method: "POST",
        path: "/oauth/token",
        form: {
          client_id: "<TS_PROBE_CREATING_CLIENT_ID>",
          client_secret: "<TS_PROBE_CREATING_CLIENT_SECRET>",
          grant_type: "client_credentials",
        },
        credentialTarget: "creating",
        expect: "200. A plain client_credentials exchange with no tailnet named at all.",
        note: "Harness-local raw POST. access_token is redacted; token_type / expires_in / scope are kept as the real-shape fixture for the OAuth mocks in src/api.test.ts.",
      },
      {
        n: 3,
        arm: "control",
        method: "GET",
        path: "/tailnet/-/dns/searchpaths",
        body: null,
        credentialTarget: "creating",
        derive: markerPresent,
        expect: "markerPresent must be FALSE here -- an untargeted token addresses the creating tailnet.",
      },
      {
        n: 4,
        arm: "current",
        method: "POST",
        path: "/oauth/token?tailnet={T}",
        form: {
          client_id: "<TS_PROBE_CREATING_CLIENT_ID>",
          client_secret: "<TS_PROBE_CREATING_CLIENT_SECRET>",
          grant_type: "client_credentials",
        },
        credentialTarget: "creating",
        expect: "Byte-for-byte what api.ts:135-146 builds when TAILSCALE_OAUTH_TAILNET is set.",
      },
      {
        n: 5,
        arm: "current",
        method: "GET",
        path: "/tailnet/-/dns/searchpaths",
        body: null,
        credentialTarget: "creating",
        derive: markerPresent,
        expect: "markerPresent TRUE means the query param works. FALSE with a 200 is the silent-wrong-target finding.",
      },
      {
        n: 6,
        arm: "current",
        method: "GET",
        path: "/tailnet/{T}/dns/searchpaths",
        body: null,
        credentialTarget: "creating",
        derive: markerPresent,
        expect: "200 confirms the token reaches target A by name; 403/404 confirms it does not.",
      },
      {
        n: 7,
        arm: "spec",
        method: "POST",
        path: "/oauth/token",
        form: {
          client_id: "<TS_PROBE_CREATING_CLIENT_ID>",
          client_secret: "<TS_PROBE_CREATING_CLIENT_SECRET>",
          grant_type: "client_credentials",
          tailnet: "{T}",
        },
        credentialTarget: "creating",
        expect: "The documented form: `the tailnet parameter of the request body` (critic_tcapi.html.txt:592-612).",
      },
      {
        n: 8,
        arm: "spec",
        method: "GET",
        path: "/tailnet/-/dns/searchpaths",
        body: null,
        credentialTarget: "creating",
        derive: markerPresent,
      },
      {
        n: 9,
        arm: "spec",
        method: "GET",
        path: "/tailnet/{T}/dns/searchpaths",
        body: null,
        credentialTarget: "creating",
        derive: markerPresent,
      },
      {
        n: 10,
        arm: "spec",
        method: "POST",
        path: "/oauth/token?tailnet={T}",
        form: {
          client_id: "<TS_PROBE_CREATING_CLIENT_ID>",
          client_secret: "<TS_PROBE_CREATING_CLIENT_SECRET>",
          grant_type: "client_credentials",
          tailnet: "{T}",
        },
        credentialTarget: "creating",
        expect: "Belt and braces: query AND body. This is the shape PR27 would ship if both are accepted.",
      },
      {
        n: 11,
        arm: "spec",
        method: "GET",
        path: "/tailnet/-/dns/searchpaths",
        body: null,
        credentialTarget: "creating",
        derive: markerPresent,
      },
      {
        n: 12,
        arm: "cleanup",
        method: "POST",
        path: "/tailnet/{T}/dns/searchpaths",
        body: { searchPaths: [] },
        requires: { attestedTarget: true },
        credentialTarget: "A",
        expect: "Marker removed, or teardown of target A covers it.",
      },
    ];
  },
};
