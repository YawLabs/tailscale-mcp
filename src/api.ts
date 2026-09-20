/**
 * Tailscale API client with API key and OAuth authentication.
 */

const BASE_URL = "https://api.tailscale.com/api/v2";
const REQUEST_TIMEOUT_MS = 30_000;

// Retry tunables, shared by the 429 and gateway-5xx paths (the MAX_429_* names
// predate the 5xx statuses and are kept to limit churn). Capped so retries
// can't dominate request latency budget; callers (agents) get the failure
// quickly enough to react.
const MAX_429_RETRIES = 3;
const DEFAULT_429_DELAY_MS = 1_000;
const MAX_429_DELAY_MS = 30_000;
// Upper bound on the random jitter added to a backoff sleep. Jitter is also
// clamped to the backoff base itself (see compute429DelayMs) so a small base
// isn't swamped by a proportionally huge random component.
const MAX_429_JITTER_MS = 250;

// Total wall-clock budget per apiRequest, including retries and their sleeps.
// MCP clients usually have their own outer timeout in the 60-120s range; if
// retries push past this, the client gives up while we're still waiting on a
// retry that would arrive too late to be useful. Tunable via env var for
// operators who run with tighter latency budgets.
const MAX_REQUEST_BUDGET_MS = 90_000;

// Share of that budget a chain of gateway 5xx may spend, as a fraction so it
// tracks an operator-lowered TAILSCALE_REQUEST_BUDGET_MS instead of ignoring it.
//
// The two paths are not the same shape. A 429 answers immediately -- the
// limiter refuses before doing any work -- so the wall clock a 429 chain burns
// is its own backoff, which the Retry-After and the caps above bound. A 502,
// 503 or 504 arrives only after the gateway waited out the request behind it,
// so each attempt costs whatever that wait was, and four attempts against a
// gateway that answers 504 after 15s is a minute of silence on a call that
// could have surfaced the 504 at 15s. Half the default budget is 45s, under
// the 60s low end of the client-timeout range named above, so the error still
// reaches the client as an error. Raising TAILSCALE_REQUEST_BUDGET_MS raises
// this with it; the ceiling exists to stay under the CLIENT's timeout, so an
// operator who raises ours is the one who knows theirs.
const GATEWAY_5XX_BUDGET_FRACTION = 0.5;

// Only retry on RFC 7231 idempotent methods. POST/PATCH could double-create or
// double-mutate if the original request reached the server but the response was
// lost. Tailscale almost certainly responds 429 before processing, but the API
// contract is not explicit about that -- and a gateway 5xx says nothing at all
// about whether the request was processed -- so we play conservative.
//
// HEAD is omitted on purpose: no caller in this package emits HEAD requests
// (the convenience wrappers are GET/POST/PUT/PATCH/DELETE only), so keeping it
// in the set would be unreachable code. Add it back if a HEAD wrapper is ever
// introduced.
const RETRYABLE_METHODS = new Set(["GET", "PUT", "DELETE"]);

// Statuses worth another attempt. 429 is the rate limiter; the rest are gateway
// conditions the API documents as transient. Per the OpenAPI spec, 504 carries
// "request took too long to process, please try again later" and is attached to
// every Devices and Services operation, and 502 ("The system was unable to
// communicate with logging server") to the network-flow-log and log-streaming
// reads. 503 is not in the spec; it is included because it is the standard
// load-shed status a fronting proxy returns, and it is the one gateway status
// that commonly carries a Retry-After.
//
// 500 is deliberately excluded: it says the server failed to process the
// request rather than that something in front of it gave up, so a replay just
// re-runs the same failure -- and every 5xx fixture in the suite that is meant
// to fail once uses it.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

interface OAuthToken {
  access_token: string;
  expires_at: number;
}

let oauthToken: OAuthToken | null = null;
let oauthRefreshPromise: Promise<string> | null = null;

/**
 * Clear the in-memory OAuth token cache. Exists so tests can isolate their
 * assertions from each other — Node's ESM loader caches the module, so a
 * token refreshed in one test would otherwise leak into the next.
 *
 * @internal Not part of the public API. Do not rely on this from production code.
 */
export function __resetOAuthTokenCacheForTests(): void {
  oauthToken = null;
  oauthRefreshPromise = null;
}

type AuthConfig = { kind: "apiKey"; apiKey: string } | { kind: "oauth"; clientId: string; clientSecret: string };

function getAuthConfig(): AuthConfig {
  const apiKey = process.env.TAILSCALE_API_KEY;
  const oauthClientId = process.env.TAILSCALE_OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.TAILSCALE_OAUTH_CLIENT_SECRET;

  if (apiKey !== undefined) {
    // Trim surrounding whitespace before using the key. Copy-pasted keys often
    // arrive with a trailing newline; without trimming, the literal whitespace
    // flowed into the Authorization header and 401'd with a misleading
    // "expired/revoked" message.
    const trimmedKey = apiKey.trim();
    if (trimmedKey === "") {
      throw new Error("TAILSCALE_API_KEY is set but empty. Provide a valid API key.");
    }
    return { kind: "apiKey", apiKey: trimmedKey };
  }

  if (oauthClientId !== undefined || oauthClientSecret !== undefined) {
    // If either is set, diagnose precisely rather than falling through to the
    // generic "no credentials configured" message — that wording would suggest
    // the user did nothing, when in fact they set one half of the OAuth pair
    // (or set one or both to empty/whitespace).
    const trimmedId = (oauthClientId ?? "").trim();
    const trimmedSecret = (oauthClientSecret ?? "").trim();
    if (trimmedId === "" || trimmedSecret === "") {
      throw new Error("TAILSCALE_OAUTH_CLIENT_ID and TAILSCALE_OAUTH_CLIENT_SECRET must both be set and non-empty.");
    }
    return { kind: "oauth", clientId: trimmedId, clientSecret: trimmedSecret };
  }

  const hint =
    process.platform === "win32"
      ? " On Windows, env vars set in bash/WSL profiles are not visible to MCP servers launched via cmd." +
        ' Either add "env": {"TAILSCALE_API_KEY": "tskey-api-..."} to your .mcp.json,' +
        " or set it as a Windows user environment variable."
      : "";
  throw new Error(
    `No Tailscale credentials configured. Set TAILSCALE_API_KEY, or set both TAILSCALE_OAUTH_CLIENT_ID and TAILSCALE_OAUTH_CLIENT_SECRET.${hint}`,
  );
}

/**
 * Optional target tailnet for the OAuth token exchange.
 *
 * API-only tailnets (created via POST /organizations/{org}/tailnets) are not
 * reachable with a plain client_credentials exchange: you authenticate with an
 * OAuth client belonging to the CREATING tailnet and pass the target tailnet on
 * the token request, which mints a token scoped to that tailnet.
 *
 * Deliberately a SEPARATE env var rather than reusing TAILSCALE_TAILNET.
 * TAILSCALE_TAILNET is already set to an ordinary tailnet name by most existing
 * OAuth users, and appending `?tailnet=` unconditionally would change the token
 * request for every one of them against an endpoint whose behavior for
 * non-API-only tailnets we have not verified. Opt-in keeps the default path
 * byte-identical.
 */
function getOAuthTailnet(): string | undefined {
  const raw = process.env.TAILSCALE_OAUTH_TAILNET?.trim();
  return raw ? raw : undefined;
}

async function getOAuthAccessToken(clientId: string, clientSecret: string): Promise<string> {
  if (oauthToken && Date.now() < oauthToken.expires_at - 60_000) {
    return oauthToken.access_token;
  }

  // Deduplicate concurrent refresh requests
  if (oauthRefreshPromise) {
    return oauthRefreshPromise;
  }

  oauthRefreshPromise = (async () => {
    try {
      // The tailnet target rides as a query param, not a form field -- the body
      // is the standard client_credentials grant and Tailscale reads `tailnet`
      // off the URL.
      const oauthTailnet = getOAuthTailnet();
      const tokenUrl = oauthTailnet
        ? `https://api.tailscale.com/api/v2/oauth/token?tailnet=${encodeURIComponent(oauthTailnet)}`
        : "https://api.tailscale.com/api/v2/oauth/token";
      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "client_credentials",
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = await res.text();
        // Friendlier guidance specific to the OAuth exchange path. The downstream
        // formatAuthError covers per-call 401s; this catches "wrong client id /
        // secret / scopes from the start" before any tool call runs.
        const guidance =
          res.status === 401 || res.status === 403
            ? " Verify TAILSCALE_OAUTH_CLIENT_ID and TAILSCALE_OAUTH_CLIENT_SECRET, and that the client has the scopes your tools need (https://console.tailscale.com/admin/settings/trust-credentials)." +
              (oauthTailnet
                ? ` Targeting tailnet "${oauthTailnet}" via TAILSCALE_OAUTH_TAILNET -- that requires an OAuth client from the CREATING tailnet with the 'all' scope.`
                : "")
            : "";
        throw new Error(`OAuth token exchange failed (${res.status}): ${body}.${guidance}`);
      }

      const data = (await res.json()) as { access_token: string; expires_in: number };
      oauthToken = {
        access_token: data.access_token,
        expires_at: Date.now() + data.expires_in * 1000,
      };
      return oauthToken.access_token;
    } finally {
      oauthRefreshPromise = null;
    }
  })();

  return oauthRefreshPromise;
}

/**
 * Drop the cached OAuth token after a request made WITH it came back 401.
 *
 * The cache is otherwise invalidated only by wall-clock expiry (the skew check
 * in getOAuthAccessToken), so a token revoked server-side -- or orphaned by an
 * OAuth client rotation -- left this process replaying a dead bearer token on
 * every subsequent call. A stdio MCP server lives for the whole session, so the
 * only recovery was for the operator to restart it.
 *
 * Two deliberate limits keep this from turning into a request amplifier:
 *
 *  - 401 only. A 403 is a SCOPE problem, and a freshly minted token carries the
 *    same scopes as the one just refused, so re-minting on 403 would burn an
 *    extra token exchange on every call and still never recover.
 *  - The header that produced the 401 must still match the cached token. Under
 *    concurrency a slow request can 401 with token N well after token N+1 was
 *    minted; without this check that straggler evicts a perfectly good token and
 *    forces another exchange. The comparison also makes the API-key path a
 *    no-op for free, since a Basic header can never match a Bearer one.
 *
 * Clearing the cache is the entire fix. The failed request is still returned to
 * the caller as a 401 -- retrying it here would double the request rate against
 * a tailnet that is already refusing us, to salvage only the narrow case where
 * the token died mid-flight.
 */
function invalidateOAuthTokenOnUnauthorized(authorizationHeader: string | undefined): void {
  if (!oauthToken) return;
  if (authorizationHeader !== `Bearer ${oauthToken.access_token}`) return;
  oauthToken = null;
}

async function getAuthHeader(): Promise<string> {
  const config = getAuthConfig();

  if (config.kind === "apiKey") {
    return `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
  }

  const token = await getOAuthAccessToken(config.clientId, config.clientSecret);
  return `Bearer ${token}`;
}

/**
 * The tailnet name used in `/tailnet/{name}/...` paths (and surfaced verbatim
 * in some tool responses, e.g. tailscale_status).
 *
 * Intentionally NOT `encPath`'d: this is operator-controlled trusted env
 * (TAILSCALE_TAILNET, default "-"), never caller/tool input, so it is not a
 * path-traversal surface the way deviceId/attributeKey are. Tailnet names are
 * org slugs / "-" with no URL-significant characters, so encoding would be a
 * no-op for real values while corrupting the human-readable display value.
 * Callers interpolate the result raw.
 */
export function getTailnet(): string {
  return process.env.TAILSCALE_TAILNET || "-";
}

/** URL-encode a path segment to prevent path traversal. */
export function encPath(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Validate that all ACL tags use the required `tag:` prefix. Accepts undefined/empty
 * so callers with optional `tags` fields can invoke unconditionally.
 */
export function validateTags(tags: string[] | undefined): void {
  if (!tags || tags.length === 0) return;
  const invalid = tags.filter((t) => !t.startsWith("tag:"));
  if (invalid.length > 0) {
    throw new Error(`All tags must start with 'tag:' prefix. Invalid tags: ${invalid.join(", ")}`);
  }
}

/**
 * Sanitize a human-readable description for the Tailscale API.
 * Per the API spec: max 50 alphanumeric characters, hyphens and spaces allowed.
 * Common substitutions are applied before stripping (e.g. `/` and `_` become `-`).
 */
export function sanitizeDescription(value: string): string {
  return value
    .replace(/[/_]/g, "-")
    .replace(/[^a-zA-Z0-9 -]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, 50);
}

/**
 * Sanitize a caller-supplied description and validate that the result is usable.
 * Returns the sanitized string, or `undefined` when the caller passed empty or
 * whitespace-only input (those are treated as "no description" -- match the
 * historical comment in keys.ts and let callers omit the field).
 *
 * Throws when the input had visible content but every character was stripped
 * by the alphanumeric/space/hyphen rule (e.g. "!!!"). This used to fall through
 * to a misleading `No fields to update` error -- now the user gets a specific
 * message naming the offending input.
 */
export function validateAndSanitizeDescription(value: string): string | undefined {
  const sanitized = sanitizeDescription(value);
  if (sanitized.length > 0) return sanitized;
  if (value.trim().length === 0) return undefined;
  throw new Error(
    `description ${JSON.stringify(value)} contains no valid characters after sanitization. ` +
      "Allowed characters: alphanumeric, spaces, and hyphens (max 50 chars).",
  );
}

/**
 * The README heading of the per-group OAuth scope table, which the OAuth 403
 * hint quotes. release-metadata.test.ts fails when README.md has no heading by
 * this name, so the hint cannot be left pointing at a renamed section.
 */
export const OAUTH_SCOPE_TABLE_HEADING = "OAuth scopes by tool group";

function formatAuthError(status: 401 | 403, apiBody: string): string {
  // Derive the auth mode from the same source the request path uses
  // (getAuthConfig) so the wording can't drift from the actual selection. By
  // the time a 401/403 reaches here a request was already sent, so getAuthConfig
  // resolved cleanly; the catch only guards the unlikely case of env mutating
  // mid-process, in which case the API-key wording is the safer default.
  let usingOAuth = false;
  try {
    usingOAuth = getAuthConfig().kind === "oauth";
  } catch {
    usingOAuth = false;
  }

  const headline =
    status === 401
      ? "Authentication failed (HTTP 401)."
      : "Authorization failed (HTTP 403): the request was authenticated but not permitted for this resource.";

  const cause =
    status === 401
      ? usingOAuth
        ? "  - OAuth client credentials are invalid or lack required scopes"
        : "  - API key has expired or been revoked"
      : usingOAuth
        ? `  - OAuth client is missing a scope required for this endpoint (scopes per tool group: README, "${OAUTH_SCOPE_TABLE_HEADING}")`
        : "  - API key lacks the permission required for this endpoint";

  const lines = [headline, "", "Possible causes:", cause];

  if (status === 401 && process.platform === "win32" && !usingOAuth) {
    lines.push(
      "  - On Windows, env vars set in bash/WSL profiles are not visible to MCP servers launched via cmd",
      "",
      "Fix options:",
      '  1. Add "env": {"TAILSCALE_API_KEY": "tskey-api-..."} to your .mcp.json',
      "  2. Set TAILSCALE_API_KEY as a Windows user environment variable (System Properties > Environment Variables)",
    );
  }

  const link =
    status === 401
      ? "Generate a new key at: https://console.tailscale.com/admin/settings/keys"
      : usingOAuth
        ? "Adjust the credential's scopes at: https://console.tailscale.com/admin/settings/trust-credentials"
        : "Adjust the API key permissions at: https://console.tailscale.com/admin/settings/keys";
  lines.push("", link);

  if (apiBody) {
    lines.push("", `API response: ${apiBody}`);
  }

  return lines.join("\n");
}

/**
 * Budgets for a rendered `data` array. A policy with hundreds of failing tests
 * would otherwise bury the message it hangs under in a wall of text.
 *
 * Three numbers rather than one, because the spec types the array's items as a
 * bare `object` and each shape spends a different budget. A structured entry is
 * many short lines, so the line cap binds. An entry that falls to the JSON
 * fallback is ONE line of arbitrary length, which a line cap cannot trim at
 * all -- hence a per-entry character cap on that path, and a total character
 * cap so a hundred such lines cannot add up to a megabyte either.
 */
const ERROR_DATA_MAX_LINES = 100;
const ERROR_DATA_MAX_CHARS = 8000;
const ERROR_DATA_MAX_JSON_CHARS = 1000;

/**
 * Keys whose values are replaced with `[redacted]` in the JSON fallback below.
 * The fallback exists so nothing is dropped, which means it prints keys nobody
 * has documented -- into CI logs and agent transcripts. Matching on the key
 * name is coarse on purpose: over-redacting an unknown field costs nothing,
 * echoing a credential costs a rotation.
 */
const SENSITIVE_DATA_KEY = /secret|token|password|credential|key/i;

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_DATA_KEY.test(key) ? "[redacted]" : redactSensitive(inner);
  }
  return out;
}

/** An array of strings, or undefined when the value is any other shape. */
function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

/**
 * The JSON fallback for one entry, as a single bounded line.
 *
 * Trimmed rather than dropped: the fallback exists so no diagnostic is
 * summarised away, and the start of a 200KB line still names the keys the
 * entry carried. The cut leaves the line unparseable, which costs nothing --
 * nothing downstream parses it, and a reader could not have read 200KB on one
 * line either. The character count is printed so the trim is visible rather
 * than silent.
 *
 * `?? String(value)`: JSON.stringify returns undefined for `undefined` (and
 * for a function), which would otherwise put the literal string "undefined"
 * into the render through the template below -- or, before this, push
 * `undefined` into a string[] and have join() render it as an empty line.
 */
function renderJsonEntry(value: unknown): string {
  const json = JSON.stringify(redactSensitive(value)) ?? String(value);
  if (json.length <= ERROR_DATA_MAX_JSON_CHARS) return json;
  return `${json.slice(0, ERROR_DATA_MAX_JSON_CHARS)}... (${json.length - ERROR_DATA_MAX_JSON_CHARS} more characters)`;
}

/**
 * Join per-entry blocks, stopping at an ENTRY boundary once either budget is
 * spent, and saying how many entries were left out.
 *
 * Entry-aware rather than line-aware. The previous form flattened every entry
 * into one list and cut at line 100, so a single entry carrying 300 errors was
 * truncated mid-list under its own `Errors found:` heading -- an operator read
 * the tail as "that is all of them for this user" -- and the "... and N more"
 * counted LINES while reading as entries. Both are fixed by cutting between
 * entries and naming the unit.
 *
 * One case still cuts inside an entry: a FIRST entry that alone exceeds the
 * budget. Dropping it whole would leave a tail and nothing else, so it is cut
 * at a line boundary and says so in its own words. That entry is allowed to
 * overrun the character budget as well -- the floor is "always render
 * something", and the line cap already bounds it.
 */
function joinErrorDataBlocks(blocks: string[][]): string {
  const out: string[] = [];
  let lines = 0;
  let chars = 0;
  let shown = 0;
  for (const block of blocks) {
    // +1 per line for the newline that joins it, so the cap measures the
    // rendered string rather than its content.
    const blockChars = block.reduce((n, line) => n + line.length + 1, 0);
    if (lines + block.length <= ERROR_DATA_MAX_LINES && chars + blockChars <= ERROR_DATA_MAX_CHARS) {
      out.push(...block);
      lines += block.length;
      chars += blockChars;
      shown++;
      continue;
    }
    if (shown === 0) {
      const kept = block.slice(0, ERROR_DATA_MAX_LINES);
      out.push(...kept);
      if (kept.length < block.length) out.push(`... and ${block.length - kept.length} more lines in this entry`);
      shown++;
    }
    break;
  }
  const dropped = blocks.length - shown;
  if (dropped > 0) out.push(`... and ${dropped} more ${dropped === 1 ? "entry" : "entries"}`);
  return out.join("\n");
}

/**
 * Render the `data` array Tailscale attaches to an ACL validation or test
 * failure, in the shape upstream's gitops-pusher prints: `For user <u>:`, then
 * `Errors found:` / `Warnings found:` with one `- ` line each. Returns "" for
 * anything that is not a non-empty array.
 *
 * The OpenAPI spec types the array's items as a bare `object`, so `user`,
 * `errors` and `warnings` are the documented keys rather than the only possible
 * ones. An entry whose keys were not all consumed by the structured render --
 * an unknown key, or a known key holding an unexpected type -- renders as its
 * JSON instead, so a diagnostic never gets summarised away. Values under
 * secret-shaped keys are redacted on that path.
 *
 * Each entry is rendered into its own block so the budgets below can cut
 * between entries rather than through one -- see joinErrorDataBlocks.
 */
export function formatApiErrorData(data: unknown): string {
  if (!Array.isArray(data) || data.length === 0) return "";

  const blocks: string[][] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      blocks.push([renderJsonEntry(entry)]);
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const consumed = new Set<string>();
    const rendered: string[] = [];

    if (typeof obj.user === "string") {
      consumed.add("user");
      // Empty user => no heading, as gitops-pusher does; the errors still print.
      if (obj.user.length > 0) rendered.push(`For user ${obj.user}:`);
    }
    for (const [key, heading] of [
      ["errors", "Errors found:"],
      ["warnings", "Warnings found:"],
    ] as const) {
      const items = asStringArray(obj[key]);
      if (!items) continue;
      consumed.add(key);
      if (items.length > 0) rendered.push(heading, ...items.map((item) => `- ${item}`));
    }

    if (rendered.length > 0 && Object.keys(obj).every((key) => consumed.has(key))) blocks.push(rendered);
    else blocks.push([renderJsonEntry(obj)]);
  }

  return joinErrorDataBlocks(blocks);
}

/**
 * Extract a human-readable message from a JSON error body, falling back to the
 * raw text. Tailscale's v2 API returns shapes like `{"message": "..."}` for most
 * errors; surfacing the message verbatim is friendlier than dumping the JSON.
 * When the body also carries a `data` array -- which the ACL endpoints use to
 * say WHICH test failed and for which user -- the rendered array follows the
 * message on its own lines.
 *
 * Every other path is unchanged, and deliberately so: an empty body still
 * returns "", which is the value twelve `||` fallbacks across server-wiring.ts
 * and tools/status.ts rely on to fall through to `HTTP <status>`. A body with a
 * `data` array and no message is NOT given one here.
 *
 * (An earlier version of this comment said cli.ts calls this to normalize its
 * own 200-with-diagnostics validate body. It does not -- cli.ts has its own
 * parser, because validate's success contract is "empty or `{}`" rather than
 * "no message". The two share formatApiErrorData above, not this function.)
 */
export function extractErrorMessage(body: string): string {
  if (!body) return body;
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const message =
        typeof obj.message === "string" && obj.message.length > 0
          ? obj.message
          : typeof obj.error === "string" && obj.error.length > 0
            ? obj.error
            : undefined;
      if (message !== undefined) {
        const details = formatApiErrorData(obj.data);
        return details ? `${message}\n${details}` : message;
      }
    }
  } catch {
    // Not valid JSON — fall through.
  }
  return body;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  rawBody?: string;
  etag?: string;
}

export interface ApiRequestOptions {
  rawBody?: string;
  acceptRaw?: boolean;
  accept?: string;
  contentType?: string;
  ifMatch?: string;
}

/**
 * Optional in-flight concurrency cap. When TAILSCALE_MAX_CONCURRENT is set to a
 * positive integer, no more than that many apiRequest() calls run in parallel —
 * additional callers queue. Default is unlimited (no behavior change for users
 * who don't opt in). Useful for agents that fan out aggressively against a
 * tailnet with strict per-tenant rate limits.
 */
let inFlight = 0;
const concurrencyQueue: Array<() => void> = [];

// Use Number() rather than Number.parseInt(): parseInt("3abc", 10) silently
// returns 3, which would let typos in TAILSCALE_MAX_CONCURRENT through as a
// partial parse. Number("3abc") is NaN, which fails the isInteger check.
//
// Read on each call (vs caching at module load) on purpose: test cases set
// TAILSCALE_MAX_CONCURRENT mid-suite to exercise the cap/uncap/parse-failure
// branches, and module-load caching would force every test to drive the env
// before the first import of api.ts — brittle and a worse DX than the
// negligible cost of a per-call env lookup. Real-world processes don't mutate
// env vars at runtime, so there's no production downside.
function getConcurrencyLimit(): number {
  const raw = process.env.TAILSCALE_MAX_CONCURRENT;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Total wall-clock budget for an apiRequest, including retries. Tunable via
 * TAILSCALE_REQUEST_BUDGET_MS for operators with tight latency requirements.
 * Bad/zero/negative values fall back to the default.
 *
 * Per-call read for the same reason as `getConcurrencyLimit` above: it keeps
 * the test suite ergonomic without changing observed behavior in production.
 */
function getRequestBudgetMs(): number {
  const raw = process.env.TAILSCALE_REQUEST_BUDGET_MS;
  if (!raw) return MAX_REQUEST_BUDGET_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : MAX_REQUEST_BUDGET_MS;
}

/**
 * Base delay for the exponential backoff between retries: attempt N sleeps
 * `base * 2**N` (capped at MAX_429_DELAY_MS, plus jitter). Tunable via
 * TAILSCALE_RETRY_BASE_DELAY_MS. Bad/zero/negative values fall back to the
 * default.
 *
 * Pairs with TAILSCALE_REQUEST_BUDGET_MS: lowering the budget alone doesn't buy
 * you more retries, it just makes the backoff exhaust it sooner and bail. An
 * operator who wants "retry hard but fail fast" has to shrink the backoff too,
 * and previously couldn't. Same per-call read rationale as `getConcurrencyLimit`.
 *
 * It also makes the retry loop testable without real multi-second sleeps -- at
 * the default base, exercising all MAX_429_RETRIES attempts costs ~7s of
 * wall-clock, which is most of the test suite's runtime for one assertion.
 */
function getRetryBaseDelayMs(): number {
  const raw = process.env.TAILSCALE_RETRY_BASE_DELAY_MS;
  if (!raw) return DEFAULT_429_DELAY_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_429_DELAY_MS;
}

async function withConcurrencyLimit<T>(fn: (queuedForMs: number) => Promise<T>): Promise<T> {
  const limit = getConcurrencyLimit();
  if (limit === 0) return fn(0);
  let queuedForMs = 0;
  if (inFlight >= limit) {
    // Wait for a slot to be handed off. The releasing caller does NOT decrement
    // inFlight when handing off, so our slot is already counted when we resume.
    const queueStartedAt = Date.now();
    await new Promise<void>((resolve) => concurrencyQueue.push(resolve));
    // Handed to `fn` so a budget bail can name the queue as the cause. Measured
    // here rather than inferred from a Date.now() delta at the call site: with
    // no contention the two stamps land in the same millisecond, and a spurious
    // 1ms would blame the queue for an unrelated timeout.
    queuedForMs = Date.now() - queueStartedAt;
  } else {
    inFlight++;
  }
  try {
    return await fn(queuedForMs);
  } finally {
    const next = concurrencyQueue.shift();
    if (next) {
      // Direct slot hand-off: do not inFlight-- here. If we decremented and
      // then the resumed waiter inFlight++'d, a fresh arrival could see the
      // lower count in the microtask gap between decrement and resume, take
      // the slot, then the waiter would also increment -- pushing total
      // concurrent calls past `limit`. Handing the slot off atomically (no
      // counter change across the await boundary) keeps the cap exact.
      next();
    } else {
      inFlight--;
    }
  }
}

/**
 * Reset internal concurrency state. Test-only. The semaphore counters are
 * module-level closures, so a test that injects a slow fetch and never resolves
 * it would otherwise leak `inFlight` and queue entries into the next test.
 *
 * @internal
 */
export function __resetConcurrencyStateForTests(): void {
  inFlight = 0;
  concurrencyQueue.length = 0;
}

function debugLog(...parts: unknown[]): void {
  if (process.env.TAILSCALE_DEBUG === "1" || process.env.TAILSCALE_DEBUG === "true") {
    console.error("[tailscale-mcp]", ...parts);
  }
}

/**
 * Compute milliseconds to wait before retrying a 429. Honors a `Retry-After`
 * header in either the seconds-integer form or the HTTP-date form. Falls back
 * to exponential backoff capped at MAX_429_DELAY_MS.
 */
function compute429DelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const asInt = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(asInt) && asInt >= 0) {
      // `>= 0`, not `> 0`: zero is a legal delay-seconds value (RFC 7231) and
      // reads as "retry now", so honor it literally -- no floor. Deliberately
      // NOT symmetric with the date branch below, which refuses a non-positive
      // delta: an explicit numeric 0 is an instruction from the server, while a
      // past or equal date is clock skew -- a broken input, not an instruction.
      // See that branch's comment for the skew reasoning; both arms are pinned
      // by tests, so "fixing" the asymmetry has to redden one.
      return Math.min(asInt * 1000, MAX_429_DELAY_MS);
    }
    const asDate = Date.parse(retryAfter);
    if (Number.isFinite(asDate)) {
      const delta = asDate - Date.now();
      // Only honor a Retry-After date that is still in the future. A past or
      // clock-skewed date yields delta <= 0; returning 0 here would retry
      // immediately against a server that just said 429 (and under skew all
      // attempts could fire back-to-back, defeating the backoff). Fall through
      // to the exponential-backoff floor below instead.
      if (delta > 0) return Math.min(delta, MAX_429_DELAY_MS);
    }
  }
  // Exponential backoff with light jitter so simultaneous retries don't lockstep.
  // Jitter is clamped to the base as well as to MAX_429_JITTER_MS: at the default
  // base (1000ms) that clamp is inert, but with a small configured base a flat
  // 250ms would dominate the delay it is supposed to only perturb.
  const base = Math.min(getRetryBaseDelayMs() * 2 ** attempt, MAX_429_DELAY_MS);
  return base + Math.floor(Math.random() * Math.min(MAX_429_JITTER_MS, base));
}

/**
 * Test-only accessor for `compute429DelayMs`.
 *
 * The MAX_429_DELAY_MS cap is not observable through apiRequest without a real
 * 30s sleep: a Retry-After above the cap only changes the outcome when the
 * request budget exceeds 30s, and at that point the retry actually waits the
 * capped 30s. Below that budget, capped and uncapped both bail identically, so
 * a black-box test cannot tell the cap from its absence. Exposing the pure
 * function lets the cap, the negative/past-date arms, and the jitter bounds be
 * asserted in microseconds.
 *
 * @internal Not part of the public API. Do not rely on this from production code.
 */
export function __computeRetryDelayMsForTests(retryAfter: string | null, attempt: number): number {
  return compute429DelayMs(retryAfter, attempt);
}

async function executeFetch(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
) {
  return fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Render a fetch / response-body failure as a stable, operator-friendly string.
 * Used wherever a transport-level error needs to land in the `error` slot of
 * an ApiResponse envelope instead of being thrown out of apiRequest (which
 * would surface to the agent as the raw "fetch failed" / "Unexpected end of
 * JSON input" string via wrapToolHandler's generic catch).
 *
 * AbortSignal.timeout(ms) rejects with DOMException name="TimeoutError" on
 * modern Node; older runtimes / some undici versions surface "AbortError".
 * Treat both as a timeout so the message is accurate either way.
 *
 * undici wraps the underlying SystemError on `cause`; we surface both layers
 * so an operator sees "fetch failed (getaddrinfo ENOTFOUND ...)" rather than
 * the opaque outer message.
 */
function describeTransportError(err: unknown, method: string, attemptTimeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `${method} request timed out after ${attemptTimeoutMs}ms`;
    }
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) {
      return `${method} request failed: ${err.message} (${cause.message})`;
    }
    return `${method} request failed: ${err.message}`;
  }
  return `${method} request failed: ${String(err)}`;
}

/**
 * Message for the top-of-loop bail when the total request budget is gone.
 *
 * The queue clause exists because `startedAt` is stamped BEFORE
 * withConcurrencyLimit, so time spent waiting for a TAILSCALE_MAX_CONCURRENT
 * slot is billed to the budget. That accounting is deliberate -- the caller
 * really did wait that long -- but the message read like a plain timeout, so an
 * operator whose own concurrency cap was starving the queue went looking for a
 * network fault that was never there. Naming the queue is the fix; the
 * accounting stays as it was.
 */
function describeBudgetExhaustion(budgetMs: number, queuedForMs: number, lastTransportError?: string): string {
  if (lastTransportError) {
    return `${lastTransportError}; request budget of ${budgetMs}ms exhausted before next attempt could begin.`;
  }
  if (queuedForMs > 0) {
    return (
      `Request budget of ${budgetMs}ms exhausted before attempt could begin: ${queuedForMs}ms of it was spent ` +
      "waiting for a free slot under TAILSCALE_MAX_CONCURRENT, so no request was ever sent. Raise " +
      "TAILSCALE_MAX_CONCURRENT or TAILSCALE_REQUEST_BUDGET_MS -- this is queueing, not a network fault."
    );
  }
  return `Request budget of ${budgetMs}ms exhausted before attempt could begin.`;
}

/**
 * Annotate the final error of a DELETE that retried past an ambiguous attempt
 * and then saw a 404.
 *
 * Retrying a DELETE is the one case where the retry itself can manufacture a
 * misleading answer: the attempt that drew the 502/503/504 may have reached the
 * server and deleted the resource, in which case a 404 on the retry is what
 * SUCCESS looks like. Handing an agent a bare "not found" sends it looking for
 * an id it has already removed, or retrying the delete forever. Saying what
 * preceded the 404 lets the caller decide.
 *
 * A retried transport failure is the same hazard and, if anything, the worse
 * half of it. A gateway at least answered, so the 502/503/504 is evidence the
 * request reached something; a reset socket or a client-side timeout leaves no
 * evidence either way about whether the server ran the delete before the
 * response went missing. It carried no annotation at all until now, so the
 * shape with LESS to go on was the one reported as a flat "not found".
 *
 * Both can precede the same 404 -- a 504, a retry, then a timeout -- so the
 * causes are collected rather than ranked, and the sentence names every one.
 *
 * `error || HTTP <status>` rather than a bare append: a bodiless 404 yields ""
 * from extractErrorMessage, and the twelve `||` fallbacks downstream would see
 * a truthy annotation with no status in it.
 */
function annotateAmbiguousDelete(
  error: string,
  status: number,
  method: string,
  priorGatewayStatus: number | undefined,
  priorTransportError: string | undefined,
): string {
  if (status !== 404 || method.toUpperCase() !== "DELETE") return error;
  const causes: string[] = [];
  if (priorGatewayStatus !== undefined) causes.push(`returned HTTP ${priorGatewayStatus}`);
  if (priorTransportError !== undefined) causes.push(`never returned a response (${priorTransportError})`);
  if (causes.length === 0) return error;
  const subject = causes.length > 1 ? "earlier attempts" : "an earlier attempt";
  return `${error || `HTTP ${status}`} (${subject} ${causes.join(" and ")}; the delete may already have succeeded)`;
}

export async function apiRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options?: ApiRequestOptions,
): Promise<ApiResponse<T>> {
  // Build the request shape up front (cheap, sync). Auth resolution is
  // deferred to inside the concurrency wrapper below so an OAuth token
  // refresh consumes a slot rather than racing against in-flight apiRequest
  // fetches under TAILSCALE_MAX_CONCURRENT.
  const headers: Record<string, string> = {};

  if (options?.accept) {
    headers.Accept = options.accept;
  }

  if (options?.ifMatch) {
    headers["If-Match"] = options.ifMatch;
  }

  let fetchBody: string | undefined;

  if (options?.rawBody !== undefined) {
    headers["Content-Type"] = options.contentType || "application/json";
    fetchBody = options.rawBody;
  } else if (body !== undefined) {
    // Honor an explicit contentType here too. Previously only the rawBody
    // branch read it, so `apiPost(path, body, { contentType: "..." })` silently
    // sent application/json and dropped the caller's choice on the floor. No
    // caller passes that combination today -- every contentType call site pairs
    // it with rawBody -- so this changes no live behavior, it just removes a
    // footgun where the option is accepted and ignored.
    headers["Content-Type"] = options?.contentType || "application/json";
    fetchBody = JSON.stringify(body);
  }

  // Strict prefix check: `startsWith("http")` would mis-classify a typoed
  // path like "httpapi.tailscale.com/..." as absolute and skip the base-URL
  // prepend, sending the request to a nonsense URL. All real absolute URLs
  // a caller would pass start with "http://" or "https://", so reject the
  // ambiguous middle ground.
  const isAbsolute = path.startsWith("http://") || path.startsWith("https://");
  // Defense-in-depth allowlist: if a caller passes an absolute URL, it MUST
  // be on api.tailscale.com. No production caller does today (every tool
  // module builds paths from `/tailnet/...` / `/device/...` templates), but
  // a future caller that forwards user input as `path` would otherwise emit
  // the Authorization header to an attacker-controlled host -- SSRF +
  // credential exfiltration in one step. Restricting to the Tailscale API
  // origin keeps the absolute-URL path useful for the OAuth-style "full URL
  // returned by a prior response" case while sealing the exfiltration shape.
  if (isAbsolute && !path.startsWith("https://api.tailscale.com/")) {
    return {
      ok: false,
      status: 0,
      error: `Absolute URL ${JSON.stringify(path)} is not on api.tailscale.com -- refusing to send an authenticated request elsewhere.`,
    };
  }
  const url = isAbsolute ? path : `${BASE_URL}${path}`;

  const startedAt = Date.now();
  debugLog(`${method} ${url}`);

  const isRetryable = RETRYABLE_METHODS.has(method.toUpperCase());
  const requestBudgetMs = getRequestBudgetMs();

  return withConcurrencyLimit(async (queuedForMs) => {
    // Resolve auth inside the slot. An OAuth refresh that fires here counts
    // against TAILSCALE_MAX_CONCURRENT (otherwise it could race a concurrent
    // apiRequest fetch and bypass the cap). The refresh is dedup'd in
    // getOAuthAccessToken so multiple waiters share the same exchange.
    headers.Authorization = await getAuthHeader();

    let res: Response | undefined;
    // Tracks the most recent transport-level failure so the "budget exhausted"
    // bail can surface what was failing (timeout? DNS? reset?) instead of a
    // generic "exhausted before attempt could begin" message.
    let lastTransportError: string | undefined;
    // The gateway 5xx an earlier attempt of THIS call drew, kept so a DELETE
    // that ends on a 404 can say the delete may already have landed. Set only
    // when we actually retried past that status, not merely on seeing it.
    let priorGatewayStatus: number | undefined;
    // Same purpose for the transport path: the description of a failure THIS
    // call retried past. Distinct from lastTransportError above, which records
    // every transport failure including the final one -- this is set only when
    // another attempt followed, which is the condition that makes a later 404
    // ambiguous rather than final.
    let priorTransportError: string | undefined;
    // The ceiling this call is measured against. It starts at the operator's
    // budget and tightens to the gateway share for good once this call decides
    // to retry past a 502/503/504 -- from that point the whole chain, including
    // a later attempt that ends in a transport timeout, is bounded by it. A
    // call that never sees a gateway 5xx keeps the full budget.
    let budgetMs = requestBudgetMs;
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      // Cap each attempt's fetch timeout to whatever's left of the total
      // budget. Default budget (90s) comfortably exceeds REQUEST_TIMEOUT_MS
      // (30s) so this is a no-op for typical users. Tight budgets (e.g.
      // TAILSCALE_REQUEST_BUDGET_MS=5000) used to be silently extended to 30s
      // on the first attempt; now they're honored.
      const remaining = budgetMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        return {
          ok: false,
          status: 0,
          error: describeBudgetExhaustion(budgetMs, queuedForMs, lastTransportError),
        };
      }
      const attemptTimeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining);

      // Stamped per attempt so the gateway-5xx bail below can charge the retry
      // with what the attempt that just failed actually cost.
      const attemptStartedAt = Date.now();
      let attemptRes: Response | undefined;
      try {
        attemptRes = await executeFetch(method, url, headers, fetchBody, attemptTimeoutMs);
      } catch (err) {
        // Transport-level failure (network error, AbortSignal.timeout, undici
        // socket reset). No Response was produced -- there is no status to
        // map and no body to read. Pre-fix this rejection escaped apiRequest
        // and was caught by wrapToolHandler's generic envelope, surfacing as
        // a raw "Error: fetch failed" / "This operation was aborted" string.
        // Now we return the structured envelope ourselves AND, for idempotent
        // methods (same RETRYABLE_METHODS set the 429 path uses), retry once
        // per remaining attempt with the same exponential backoff -- network
        // blips are exactly what the retry budget exists for.
        const desc = describeTransportError(err, method, attemptTimeoutMs);
        lastTransportError = desc;
        if (!isRetryable || attempt === MAX_429_RETRIES) {
          return { ok: false, status: 0, error: desc };
        }
        const delay = compute429DelayMs(null, attempt);
        const elapsed = Date.now() - startedAt;
        if (budgetMs - elapsed - delay <= 0) {
          return { ok: false, status: 0, error: `${desc}; request budget exhausted before retry.` };
        }
        debugLog(
          `  -> transport error (attempt ${attempt + 1}/${MAX_429_RETRIES + 1}): ${desc}, retrying in ${delay}ms`,
        );
        // Recorded here, past every bail above, so it means "we retried past
        // this" rather than "we saw this". A failure that ends the call is the
        // call's own error and needs no annotation on a later status.
        priorTransportError = desc;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      res = attemptRes;
      if (!RETRYABLE_STATUSES.has(res.status) || attempt === MAX_429_RETRIES || !isRetryable) break;
      // Retry-After is legal on a 503 as well as a 429, and the backoff,
      // jitter and caps are the same for both, so the 429 helper is reused
      // verbatim.
      const delay = compute429DelayMs(res.headers.get("retry-after"), attempt);
      // On 429, bail when the backoff sleep alone would exhaust the budget,
      // leaving no positive wall-clock for the retry. The previous form added a
      // flat REQUEST_TIMEOUT_MS to the predicted cost, which spuriously bailed
      // on operator-set budgets in the REQUEST_TIMEOUT_MS .. REQUEST_TIMEOUT_MS
      // + max-delay range (e.g. a 35s budget with a 30s Retry-After never
      // retried). The next iteration's `attemptTimeoutMs` clamp will still cap
      // the actual fetch timeout to whatever's left of the budget; this check
      // only gates whether there's any positive headroom left to bother trying.
      //
      // A gateway 5xx also charges the duration of the attempt that just
      // failed. A 429 comes back immediately -- the limiter answers before
      // doing any work -- but a 504 arrives only after the gateway has waited
      // out the slow request behind it, so the next attempt most likely costs
      // the same again. Betting the remaining budget on a retry that cannot
      // land in time hands the client silence where it could have had the 504.
      //
      // And it is measured against the tighter ceiling, computed BEFORE the
      // decision rather than after it, so no attempt is started that the
      // ceiling would not have room for. Four 15s gateway timeouts inside the
      // 90s budget is ~67s of silence against a client that gives up at 60;
      // the same chain now surfaces the 504 at ~31s. The 429 arm is untouched.
      // Off requestBudgetMs, not budgetMs: taking the fraction of an already
      // tightened ceiling would shrink it again on every gateway status in the
      // same chain, so the second 504 would be held to a quarter of the budget
      // for no stated reason. `min` keeps an operator's tighter budget winning.
      const gatewayCeilingMs = Math.min(budgetMs, Math.floor(requestBudgetMs * GATEWAY_5XX_BUDGET_FRACTION));
      const retryCeilingMs = res.status === 429 ? budgetMs : gatewayCeilingMs;
      const elapsed = Date.now() - startedAt;
      const predictedCostMs = res.status === 429 ? delay : delay + (Date.now() - attemptStartedAt);
      const nextAttemptBudgetMs = retryCeilingMs - elapsed - predictedCostMs;
      if (nextAttemptBudgetMs <= 0) {
        debugLog(
          `  -> ${res.status} (attempt ${attempt + 1}), giving up: budget exhausted (${elapsed}ms + ${predictedCostMs}ms of ${retryCeilingMs}ms)`,
        );
        break;
      }
      debugLog(`  -> ${res.status} (attempt ${attempt + 1}/${MAX_429_RETRIES + 1}), retrying in ${delay}ms`);
      if (res.status !== 429) {
        priorGatewayStatus = res.status;
        budgetMs = retryCeilingMs;
      }
      // Drain the body so the connection can be reused.
      await res.text().catch(() => undefined);
      await new Promise((r) => setTimeout(r, delay));
    }
    // res is always defined here: the loop only exits via break (which sets
    // res from the most recent attemptRes) or via early return inside the
    // transport-error catch (which never falls through to this point).
    const response = res as Response;

    const etag = response.headers.get("etag") || undefined;
    const elapsed = Date.now() - startedAt;
    debugLog(`  <- ${response.status} (${elapsed}ms)`);

    // Ahead of the body-read branches on purpose: both the acceptRaw and the
    // JSON path return a 401 through formatAuthError, and a body-stream failure
    // would otherwise skip the invalidation entirely.
    if (response.status === 401) {
      invalidateOAuthTokenOnUnauthorized(headers.Authorization);
    }

    // Single outer catch covers the three remaining throw surfaces:
    //   - `response.text()` on the acceptRaw branches (rare: body-stream
    //     reset after headers were received)
    //   - `response.text()` on the non-acceptRaw error path
    //   - `response.json()` on a 2xx with an unparseable body (server bug
    //     or proxy injecting non-JSON)
    // All three previously rejected out of apiRequest; now they convert to
    // the envelope so wrapToolHandler renders a friendly message.
    //
    // Scope of that guarantee: every failure that happens AFTER a request is
    // dispatched lands in the envelope. Auth RESOLUTION is the deliberate
    // exception -- the `await getAuthHeader()` that opens this concurrency-slot
    // callback still throws (missing or empty credentials, or a failed OAuth
    // token exchange), and callers rely on that: those messages carry the setup
    // guidance (Windows env-var hint, OAuth scope link) and are surfaced by
    // wrapToolHandler's generic catch.
    // So the contract is "apiRequest never throws once auth resolved", NOT
    // "apiRequest never throws".
    try {
      if (options?.acceptRaw) {
        const rawBody = await response.text();
        if (!response.ok) {
          const error =
            response.status === 401 || response.status === 403
              ? formatAuthError(response.status as 401 | 403, rawBody)
              : extractErrorMessage(rawBody);
          return {
            ok: false,
            status: response.status,
            error: annotateAmbiguousDelete(error, response.status, method, priorGatewayStatus, priorTransportError),
            rawBody,
            etag,
          };
        }
        return { ok: true, status: response.status, rawBody, etag };
      }

      if (!response.ok) {
        const errorBody = await response.text();
        const error =
          response.status === 401 || response.status === 403
            ? formatAuthError(response.status as 401 | 403, errorBody)
            : extractErrorMessage(errorBody);
        return {
          ok: false,
          status: response.status,
          error: annotateAmbiguousDelete(error, response.status, method, priorGatewayStatus, priorTransportError),
          etag,
        };
      }

      if (response.status === 204 || response.headers.get("content-length") === "0") {
        return { ok: true, status: response.status, etag };
      }

      const data = (await response.json()) as T;
      return { ok: true, status: response.status, data, etag };
    } catch (err) {
      return {
        ok: false,
        status: response.status,
        error: `Failed to read response body from ${method} ${url} (HTTP ${response.status}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        etag,
      };
    }
  });
}

export async function apiGet<T = unknown>(
  path: string,
  options?: { acceptRaw?: boolean; accept?: string },
): Promise<ApiResponse<T>> {
  return apiRequest<T>("GET", path, undefined, options);
}

export async function apiPost<T = unknown>(
  path: string,
  body?: unknown,
  options?: ApiRequestOptions,
): Promise<ApiResponse<T>> {
  return apiRequest<T>("POST", path, body, options);
}

export async function apiPut<T = unknown>(
  path: string,
  body?: unknown,
  options?: ApiRequestOptions,
): Promise<ApiResponse<T>> {
  return apiRequest<T>("PUT", path, body, options);
}

export async function apiPatch<T = unknown>(
  path: string,
  body?: unknown,
  options?: ApiRequestOptions,
): Promise<ApiResponse<T>> {
  return apiRequest<T>("PATCH", path, body, options);
}

export async function apiDelete<T = unknown>(path: string, options?: ApiRequestOptions): Promise<ApiResponse<T>> {
  return apiRequest<T>("DELETE", path, undefined, options);
}
