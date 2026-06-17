/**
 * Tailscale API client with API key and OAuth authentication.
 */

const BASE_URL = "https://api.tailscale.com/api/v2";
const REQUEST_TIMEOUT_MS = 30_000;

// 429 retry tunables. Capped so retries can't dominate request latency budget;
// callers (agents) get the failure quickly enough to react.
const MAX_429_RETRIES = 3;
const DEFAULT_429_DELAY_MS = 1_000;
const MAX_429_DELAY_MS = 30_000;

// Total wall-clock budget per apiRequest, including retries and their sleeps.
// MCP clients usually have their own outer timeout in the 60-120s range; if
// retries push past this, the client gives up while we're still waiting on a
// retry that would arrive too late to be useful. Tunable via env var for
// operators who run with tighter latency budgets.
const MAX_REQUEST_BUDGET_MS = 90_000;

// Only retry 429 on RFC 7231 idempotent methods. POST/PATCH could double-create
// or double-mutate if the original request reached the server but the response
// was lost. Tailscale almost certainly responds 429 before processing, but the
// API contract is not explicit about that, so we play conservative.
//
// HEAD is omitted on purpose: no caller in this package emits HEAD requests
// (the convenience wrappers are GET/POST/PUT/PATCH/DELETE only), so keeping it
// in the set would be unreachable code. Add it back if a HEAD wrapper is ever
// introduced.
const RETRYABLE_METHODS = new Set(["GET", "PUT", "DELETE"]);

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
      const res = await fetch("https://api.tailscale.com/api/v2/oauth/token", {
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
            ? " Verify TAILSCALE_OAUTH_CLIENT_ID and TAILSCALE_OAUTH_CLIENT_SECRET, and that the client has the scopes your tools need (https://login.tailscale.com/admin/settings/oauth)."
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
        ? "  - OAuth client is missing a scope required for this endpoint"
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
      ? "Generate a new key at: https://login.tailscale.com/admin/settings/keys"
      : usingOAuth
        ? "Adjust the OAuth client scopes at: https://login.tailscale.com/admin/settings/oauth"
        : "Adjust the API key permissions at: https://login.tailscale.com/admin/settings/keys";
  lines.push("", link);

  if (apiBody) {
    lines.push("", `API response: ${apiBody}`);
  }

  return lines.join("\n");
}

/**
 * Extract a human-readable message from a JSON error body, falling back to the
 * raw text. Tailscale's v2 API returns shapes like `{"message": "..."}` for most
 * errors; surfacing the message verbatim is friendlier than dumping the JSON.
 *
 * Exported so callers that own their own response handling (e.g. cli.ts's ACL
 * deploy, where validate can return 200 with diagnostics in the body) can
 * normalize the same way apiRequest does.
 */
export function extractErrorMessage(body: string): string {
  if (!body) return body;
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.message === "string" && obj.message.length > 0) return obj.message;
      if (typeof obj.error === "string" && obj.error.length > 0) return obj.error;
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

async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  const limit = getConcurrencyLimit();
  if (limit === 0) return fn();
  if (inFlight >= limit) {
    // Wait for a slot to be handed off. The releasing caller does NOT decrement
    // inFlight when handing off, so our slot is already counted when we resume.
    await new Promise<void>((resolve) => concurrencyQueue.push(resolve));
  } else {
    inFlight++;
  }
  try {
    return await fn();
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
  const base = Math.min(DEFAULT_429_DELAY_MS * 2 ** attempt, MAX_429_DELAY_MS);
  return base + Math.floor(Math.random() * 250);
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
    headers["Content-Type"] = "application/json";
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

  return withConcurrencyLimit(async () => {
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
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      // Cap each attempt's fetch timeout to whatever's left of the total
      // budget. Default budget (90s) comfortably exceeds REQUEST_TIMEOUT_MS
      // (30s) so this is a no-op for typical users. Tight budgets (e.g.
      // TAILSCALE_REQUEST_BUDGET_MS=5000) used to be silently extended to 30s
      // on the first attempt; now they're honored.
      const remaining = requestBudgetMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        return {
          ok: false,
          status: 0,
          error: lastTransportError
            ? `${lastTransportError}; request budget of ${requestBudgetMs}ms exhausted before next attempt could begin.`
            : `Request budget of ${requestBudgetMs}ms exhausted before attempt could begin.`,
        };
      }
      const attemptTimeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining);

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
        if (requestBudgetMs - elapsed - delay <= 0) {
          return { ok: false, status: 0, error: `${desc}; request budget exhausted before retry.` };
        }
        debugLog(
          `  -> transport error (attempt ${attempt + 1}/${MAX_429_RETRIES + 1}): ${desc}, retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      res = attemptRes;
      if (res.status !== 429 || attempt === MAX_429_RETRIES || !isRetryable) break;
      const delay = compute429DelayMs(res.headers.get("retry-after"), attempt);
      // Bail when the backoff sleep alone would exhaust the budget, leaving
      // no positive wall-clock for the retry. The previous form added a flat
      // REQUEST_TIMEOUT_MS to the predicted cost, which spuriously bailed on
      // operator-set budgets in the REQUEST_TIMEOUT_MS .. REQUEST_TIMEOUT_MS
      // + max-delay range (e.g. a 35s budget with a 30s Retry-After never
      // retried). The next iteration's :488 will still cap the actual fetch
      // timeout to whatever's left of the budget; this check only gates
      // whether there's any positive headroom left to bother trying.
      const elapsed = Date.now() - startedAt;
      const nextAttemptBudgetMs = requestBudgetMs - elapsed - delay;
      if (nextAttemptBudgetMs <= 0) {
        debugLog(`  -> 429 (attempt ${attempt + 1}), giving up: budget exhausted (${elapsed}ms + ${delay}ms)`);
        break;
      }
      debugLog(`  -> 429 (attempt ${attempt + 1}/${MAX_429_RETRIES + 1}), retrying in ${delay}ms`);
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

    // Single outer catch covers the three remaining throw surfaces:
    //   - `response.text()` on the acceptRaw branches (rare: body-stream
    //     reset after headers were received)
    //   - `response.text()` on the non-acceptRaw error path
    //   - `response.json()` on a 2xx with an unparseable body (server bug
    //     or proxy injecting non-JSON)
    // All three previously rejected out of apiRequest; now they convert to
    // the envelope so wrapToolHandler renders a friendly message and the
    // contract "apiRequest never throws" holds end-to-end.
    try {
      if (options?.acceptRaw) {
        const rawBody = await response.text();
        if (!response.ok) {
          const error =
            response.status === 401 || response.status === 403
              ? formatAuthError(response.status as 401 | 403, rawBody)
              : extractErrorMessage(rawBody);
          return { ok: false, status: response.status, error, rawBody, etag };
        }
        return { ok: true, status: response.status, rawBody, etag };
      }

      if (!response.ok) {
        const errorBody = await response.text();
        const error =
          response.status === 401 || response.status === 403
            ? formatAuthError(response.status as 401 | 403, errorBody)
            : extractErrorMessage(errorBody);
        return { ok: false, status: response.status, error, etag };
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
