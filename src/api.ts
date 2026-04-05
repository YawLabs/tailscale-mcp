/**
 * Tailscale API client with API key and OAuth authentication.
 */

const BASE_URL = "https://api.tailscale.com/api/v2";
const REQUEST_TIMEOUT_MS = 30_000;

interface OAuthToken {
  access_token: string;
  expires_at: number;
}

let oauthToken: OAuthToken | null = null;
let oauthRefreshPromise: Promise<string> | null = null;

function getConfig() {
  const apiKey = process.env.TAILSCALE_API_KEY;
  const oauthClientId = process.env.TAILSCALE_OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.TAILSCALE_OAUTH_CLIENT_SECRET;
  const tailnet = process.env.TAILSCALE_TAILNET || "-";

  if (!apiKey && !(oauthClientId && oauthClientSecret)) {
    throw new Error(
      "No Tailscale credentials configured. " +
        "Set TAILSCALE_API_KEY, or set both TAILSCALE_OAUTH_CLIENT_ID and TAILSCALE_OAUTH_CLIENT_SECRET."
    );
  }

  if (apiKey && apiKey.trim() === "") {
    throw new Error("TAILSCALE_API_KEY is set but empty. Provide a valid API key.");
  }

  return { apiKey, oauthClientId, oauthClientSecret, tailnet };
}

async function getOAuthAccessToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
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
        throw new Error(`OAuth token exchange failed (${res.status}): ${body}`);
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
  const config = getConfig();

  if (config.apiKey) {
    return `Basic ${Buffer.from(config.apiKey + ":").toString("base64")}`;
  }

  const token = await getOAuthAccessToken(
    config.oauthClientId!,
    config.oauthClientSecret!
  );
  return `Bearer ${token}`;
}

export function getTailnet(): string {
  return process.env.TAILSCALE_TAILNET || "-";
}

/** URL-encode a path segment to prevent path traversal. */
export function encPath(segment: string): string {
  return encodeURIComponent(segment);
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  rawBody?: string;
  etag?: string;
}

export async function apiRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options?: { rawBody?: string; acceptRaw?: boolean; accept?: string; contentType?: string; ifMatch?: string }
): Promise<ApiResponse<T>> {
  const auth = await getAuthHeader();

  const headers: Record<string, string> = {
    Authorization: auth,
  };

  if (options?.accept) {
    headers["Accept"] = options.accept;
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

  const res = await fetch(url, {
    method,
    headers,
    body: fetchBody,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const etag = res.headers.get("etag") || undefined;

  if (options?.acceptRaw) {
    const rawBody = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: rawBody, rawBody, etag };
    }
    return { ok: true, status: res.status, rawBody, etag };
  }

  if (!res.ok) {
    const errorBody = await res.text();
    return { ok: false, status: res.status, error: errorBody, etag };
  }

  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return { ok: true, status: res.status, etag };
  }

  const data = (await res.json()) as T;
  return { ok: true, status: res.status, data, etag };
}

export async function apiGet<T = unknown>(
  path: string,
  options?: { acceptRaw?: boolean; accept?: string }
): Promise<ApiResponse<T>> {
  return apiRequest<T>("GET", path, undefined, options);
}

export async function apiPost<T = unknown>(
  path: string,
  body?: unknown,
  options?: { rawBody?: string; acceptRaw?: boolean; accept?: string; contentType?: string; ifMatch?: string }
): Promise<ApiResponse<T>> {
  return apiRequest<T>("POST", path, body, options);
}

export async function apiPatch<T = unknown>(
  path: string,
  body?: unknown
): Promise<ApiResponse<T>> {
  return apiRequest<T>("PATCH", path, body);
}

export async function apiDelete<T = unknown>(
  path: string
): Promise<ApiResponse<T>> {
  return apiRequest<T>("DELETE", path);
}
