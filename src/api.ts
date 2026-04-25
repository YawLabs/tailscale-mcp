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

  if (apiKey) {
    if (apiKey.trim() === "") {
      throw new Error("TAILSCALE_API_KEY is set but empty. Provide a valid API key.");
    }
    return { kind: "apiKey", apiKey };
  }

  if (oauthClientId && oauthClientSecret) {
    return { kind: "oauth", clientId: oauthClientId, clientSecret: oauthClientSecret };
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

function formatAuthError(apiBody: string): string {
  const usingOAuth = !process.env.TAILSCALE_API_KEY && process.env.TAILSCALE_OAUTH_CLIENT_ID;

  const lines = [
    "Authentication failed (HTTP 401).",
    "",
    "Possible causes:",
    usingOAuth
      ? "  - OAuth client credentials are invalid or lack required scopes"
      : "  - API key has expired or been revoked",
  ];

  if (process.platform === "win32" && !usingOAuth) {
    lines.push(
      "  - On Windows, env vars set in bash/WSL profiles are not visible to MCP servers launched via cmd",
      "",
      "Fix options:",
      '  1. Add "env": {"TAILSCALE_API_KEY": "tskey-api-..."} to your .mcp.json',
      "  2. Set TAILSCALE_API_KEY as a Windows user environment variable (System Properties > Environment Variables)",
    );
  }

  lines.push("", "Generate a new key at: https://login.tailscale.com/admin/settings/keys");

  if (apiBody) {
    lines.push("", `API response: ${apiBody}`);
  }

  return lines.join("\n");
}

/**
 * Extract a human-readable message from a JSON error body, falling back to the
 * raw text. Tailscale's v2 API returns shapes like `{"message": "..."}` for most
 * errors; surfacing the message verbatim is friendlier than dumping the JSON.
 */
function extractErrorMessage(body: string): string {
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

function getConcurrencyLimit(): number {
  const raw = process.env.TAILSCALE_MAX_CONCURRENT;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  const limit = getConcurrencyLimit();
  if (limit === 0) return fn();
  if (inFlight >= limit) {
    await new Promise<void>((resolve) => concurrencyQueue.push(resolve));
  }
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    const next = concurrencyQueue.shift();
    if (next) next();
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
      return Math.max(0, Math.min(asDate - Date.now(), MAX_429_DELAY_MS));
    }
  }
  // Exponential backoff with light jitter so simultaneous retries don't lockstep.
  const base = Math.min(DEFAULT_429_DELAY_MS * 2 ** attempt, MAX_429_DELAY_MS);
  return base + Math.floor(Math.random() * 250);
}

async function executeFetch(method: string, url: string, headers: Record<string, string>, body: string | undefined) {
  return fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export async function apiRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options?: ApiRequestOptions,
): Promise<ApiResponse<T>> {
  const auth = await getAuthHeader();

  const headers: Record<string, string> = {
    Authorization: auth,
  };

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

  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;

  const startedAt = Date.now();
  debugLog(`${method} ${url}`);

  return withConcurrencyLimit(async () => {
    let res: Response | undefined;
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      res = await executeFetch(method, url, headers, fetchBody);
      if (res.status !== 429 || attempt === MAX_429_RETRIES) break;
      const delay = compute429DelayMs(res.headers.get("retry-after"), attempt);
      debugLog(`  -> 429 (attempt ${attempt + 1}/${MAX_429_RETRIES + 1}), retrying in ${delay}ms`);
      // Drain the body so the connection can be reused.
      await res.text().catch(() => undefined);
      await new Promise((r) => setTimeout(r, delay));
    }
    // res is always defined: the loop runs at least once.
    const response = res as Response;

    const etag = response.headers.get("etag") || undefined;
    const elapsed = Date.now() - startedAt;
    debugLog(`  <- ${response.status} (${elapsed}ms)`);

    if (options?.acceptRaw) {
      const rawBody = await response.text();
      if (!response.ok) {
        const error = response.status === 401 ? formatAuthError(rawBody) : extractErrorMessage(rawBody);
        return { ok: false, status: response.status, error, rawBody, etag };
      }
      return { ok: true, status: response.status, rawBody, etag };
    }

    if (!response.ok) {
      const errorBody = await response.text();
      const error = response.status === 401 ? formatAuthError(errorBody) : extractErrorMessage(errorBody);
      return { ok: false, status: response.status, error, etag };
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return { ok: true, status: response.status, etag };
    }

    const data = (await response.json()) as T;
    return { ok: true, status: response.status, data, etag };
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
