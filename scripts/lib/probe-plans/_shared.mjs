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
 *   allowedRequests      optional {method, pattern} allowlist, tighter than
 *                        `methods`, for probes whose only POST is harmless
 *   allowBareTailnetGet  only P9, and only for GET
 *   countsOnly           persist counts/key-sets/booleans instead of records
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

/** Path patterns used by the per-probe request allowlists. */
export const PATTERNS = {
  loggingConfiguration: /^\/tailnet\/[^/]+\/logging\/configuration(\?.*)?$/,
  loggingNetwork: /^\/tailnet\/[^/]+\/logging\/network(\?.*)?$/,
  userInvites: /^\/tailnet\/[^/]+\/user-invites$/,
  userInviteById: /^\/user-invites\/[^/]+$/,
  deviceInvites: /^\/device\/[^/]+\/device-invites$/,
  deviceInviteById: /^\/device-invites\/[^/]+$/,
  devices: /^\/tailnet\/[^/]+\/devices(\?.*)?$/,
  dnsAny: /^\/tailnet\/[^/]+\/dns\/.*$/,
  splitDns: /^\/tailnet\/[^/]+\/dns\/split-dns$/,
  services: /^\/tailnet\/[^/]+\/(services|vip-services)(\/.*)?$/,
  webhooks: /^\/tailnet\/[^/]+\/webhooks$/,
  webhookById: /^\/webhooks\/[^/]+$/,
  keys: /^\/tailnet\/[^/]+\/keys(\?.*)?$/,
  keyById: /^\/tailnet\/[^/]+\/keys\/[^/]+$/,
  oauthApps: /^\/tailnet\/[^/]+\/oauth-apps$/,
  oauthAppById: /^\/tailnet\/[^/]+\/oauth-apps\/[^/]+$/,
  acl: /^\/tailnet\/[^/]+\/acl(\?.*)?$/,
  aclValidate: /^\/tailnet\/[^/]+\/acl\/validate(\?.*)?$/,
  searchPaths: /^\/tailnet\/[^/]+\/dns\/searchpaths$/,
};

export function get(pattern) {
  return { method: "GET", pattern };
}

export function post(pattern) {
  return { method: "POST", pattern };
}

export function put(pattern) {
  return { method: "PUT", pattern };
}

export function patch(pattern) {
  return { method: "PATCH", pattern };
}

export function del(pattern) {
  return { method: "DELETE", pattern };
}
