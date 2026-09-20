/**
 * Vocabulary shared by every probe plan.
 *
 * A PLAN IS DATA. Nothing here sends a request; a plan is the list the owner
 * reads in the dry run before deciding to type --execute. Each plan exports:
 *
 *   probeId              stable id, also the fixtures/live/<probeId>/ directory
 *   settles              the finding ids this probe decides
 *   question             the one sentence it answers
 *   safetyClass          safe-read-only | safe-reversible-write |
 *                        unsafe-needs-disposable-tailnet   (drives G6)
 *   requiresTargetKind   "api-only" | "human" | null       (drives the routing
 *                        refusal; P2/P3 are "human" because invites need a
 *                        user-owned key, openapi.yaml:831, :938)
 *   methods              the egress method allowlist for this probe
 *   allowedRequests      optional {method, pattern, query} allowlist, tighter
 *                        than `methods`, for probes whose only POST is harmless.
 *                        `pattern` is a PATHNAME and is what the egress guard
 *                        enforces; `query` names the parameters a step may
 *                        declare on it, and is what the offline plan gate
 *                        enforces. See the note above `get()`.
 *   allowBareTailnetGet  only P9, and only for GET
 *   countsOnly           `true` | "unattested" | omitted. Counts-only
 *                        recording -- counts, key sets and booleans instead of
 *                        records -- is a property of the TARGET: every probe
 *                        gets it on a tailnet this harness did not provision
 *                        and attest, which is what "unattested" and an omitted
 *                        field both mean. `true` ESCALATES: counts-only even on
 *                        a disposable target, for a probe that reads something
 *                        it did not seed (a log, an audit entry, a token
 *                        response). `false` is refused by the plan gate,
 *                        because the recorder cannot honour it.
 *   credentialNeeds      what the owner has to supply
 *   blastRadius          what goes wrong if this is pointed somewhere real
 *   cleanup              what has to be undone, and how `cleanup` replays it
 *   outcomes             [{ when, ship }] -- observation -> what ships, as
 *                        reviewable rows. The key is `ship`, not `then`: an
 *                        object with a `then` property is a thenable, and
 *                        `await import()` of a module whose default export had
 *                        one would try to resolve it.
 *   steps(ctx)           the ordered step list
 *
 * A STEP is:
 *   n         1-based ordinal, also the fixture's filename prefix
 *   arm       control | current | spec | observe | seed | reseed | precheck |
 *             cleanup | negative
 *   method    the HTTP method that will cross the wire
 *   path      the path, with {T} standing in for the target tailnet id
 *   body      the JSON body, or null
 *   form      a urlencoded form body (the token exchange only)
 *   tool      { module, name, input } when the request is produced by the
 *             SHIPPED handler rather than by the harness. `method`/`path`/`body`
 *             are then a PREVIEW of what that handler should emit; the recorder
 *             captures what it actually emitted and the runner flags a mismatch.
 *   requires  { attestedTarget?, targetKind?, flag? } -- a step the runner skips
 *             (and says it skipped) rather than running on the wrong target
 *   registers "id" | "ids" -- pull ids out of the response so a later
 *             non-tailnet-scoped path may name them
 *   expect    what the step is looking for, in words
 *   note      anything a reviewer needs before approving this line
 */

/** Every domain a probe writes lives under a name nobody can resolve. */
export const PROBE_DOMAIN = "yaw-probe.example.com";

/** Every object a probe creates is named so a sweep can find it. */
export const PROBE_PREFIX = "yaw-probe-";

export function rfc3339(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** RFC3339 WITH a fractional second -- audit.ts:13 accepts `(\.\d+)?`. */
export function rfc3339Fractional(date) {
  return new Date(date).toISOString();
}

export function minusHours(now, hours) {
  return new Date(now.getTime() - hours * 3_600_000);
}

export function plusSeconds(now, seconds) {
  return new Date(now.getTime() + seconds * 1000);
}

/**
 * Path patterns used by the per-probe request allowlists.
 *
 * These match a PATHNAME, never a query string: the egress guard tests them
 * against `parsed.pathname` (probe-guard.mjs), which has no `?` in it. The
 * offline allowlist test strips the query off a declared step path before
 * matching for the same reason, so one regex means one thing in both places.
 *
 * The query is not thrown away, it is declared separately -- see `get()`.
 */
export const PATTERNS = {
  loggingConfiguration: /^\/tailnet\/[^/]+\/logging\/configuration$/,
  loggingNetwork: /^\/tailnet\/[^/]+\/logging\/network$/,
  userInvites: /^\/tailnet\/[^/]+\/user-invites$/,
  userInviteById: /^\/user-invites\/[^/]+$/,
  deviceInvites: /^\/device\/[^/]+\/device-invites$/,
  deviceInviteById: /^\/device-invites\/[^/]+$/,
  devices: /^\/tailnet\/[^/]+\/devices$/,
  dnsAny: /^\/tailnet\/[^/]+\/dns\/.*$/,
  splitDns: /^\/tailnet\/[^/]+\/dns\/split-dns$/,
  services: /^\/tailnet\/[^/]+\/(services|vip-services)(\/.*)?$/,
  webhooks: /^\/tailnet\/[^/]+\/webhooks$/,
  webhookById: /^\/webhooks\/[^/]+$/,
  keys: /^\/tailnet\/[^/]+\/keys$/,
  keyById: /^\/tailnet\/[^/]+\/keys\/[^/]+$/,
  oauthApps: /^\/tailnet\/[^/]+\/oauth-apps$/,
  oauthAppById: /^\/tailnet\/[^/]+\/oauth-apps\/[^/]+$/,
  acl: /^\/tailnet\/[^/]+\/acl$/,
  aclValidate: /^\/tailnet\/[^/]+\/acl\/validate$/,
  searchPaths: /^\/tailnet\/[^/]+\/dns\/searchpaths$/,
};

/**
 * One allowlist entry: a method, a PATHNAME pattern, and the query parameter
 * names that pathname is allowed to carry.
 *
 * Two readers, two jobs, and neither one guesses at the other's:
 *
 *  - The EGRESS GUARD matches `method` + `pattern` against `parsed.pathname`
 *    inside the fetch wrapper. It is the wire gate, and it deliberately says
 *    nothing about the query: a CURRENT arm exists precisely to find out what
 *    the shipped handler emits, and turning a query difference into a refusal
 *    would stop the run the probe was written to complete. The runner reports
 *    that difference as a NOTE instead (comparePlannedRequest).
 *  - The OFFLINE PLAN GATE (src/live-fixtures.test.ts) matches the same
 *    pathname and then requires every query parameter a step DECLARES to be
 *    named in `query`. That is a review gate on the plan text, not on the wire:
 *    a step that quietly starts filtering an audit log by actor, or asking for
 *    `fields=all`, has to say so in the allowlist where a reviewer reads it.
 *
 * The regexes used to end in `(\?.*)?` so that the one place a query string
 * appeared -- a declared step path -- would match. That made the same pattern
 * mean "pathname" to the guard and "pathname plus anything" to the test, and a
 * declared query was waved through unread. Now the pattern means pathname in
 * both places and the query is declared where it can be reviewed.
 */
function entry(method, pattern, query) {
  return { method, pattern, query: query ?? [] };
}

export function get(pattern, query) {
  return entry("GET", pattern, query);
}

export function post(pattern, query) {
  return entry("POST", pattern, query);
}

export function put(pattern, query) {
  return entry("PUT", pattern, query);
}

export function patch(pattern, query) {
  return entry("PATCH", pattern, query);
}

export function del(pattern, query) {
  return entry("DELETE", pattern, query);
}
