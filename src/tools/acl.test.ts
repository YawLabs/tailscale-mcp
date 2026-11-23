import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { aclTools } from "./acl.js";

/**
 * tailscale_diff_acl_access's auth-stop path. A 401/403 used to return a bare
 * error, discarding every comparison already finished -- and a 401 was assumed
 * to doom the rest of the run, which does not hold under OAuth: api.ts drops
 * the cached token on a 401, so the next request mints a fresh one.
 */

interface DiffResult {
  ok: boolean;
  error?: string;
  data?: {
    summary: string;
    principalsCompared: number;
    truncated: boolean;
    stoppedOnAuthFailure: boolean;
    unchanged: string[];
    failed: Array<{ principal: string; error: string }>;
  };
}

const POLICY = '{"acls":[{"action":"accept","src":["*"],"dst":["tag:prod:22"]}]}';

function runDiff(extra: Record<string, unknown> = {}): Promise<DiffResult> {
  const tool = aclTools.find((t) => t.name === "tailscale_diff_acl_access");
  if (!tool) throw new Error("tool not found");
  return (tool.handler as (i: unknown) => Promise<DiffResult>)({ policy: POLICY, ...extra });
}

/**
 * Route GET /acl, GET /users and POST /acl/preview. `previewStatus` picks the
 * HTTP status for each preview request, given the principal and how many
 * previews that principal has already had; every call is counted per principal.
 */
function installFetch(users: string[], previewStatus: (principal: string, nth: number) => number) {
  const calls = new Map<string, number>();
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname.endsWith("/acl/preview")) {
      const principal = url.searchParams.get("previewFor") ?? "";
      const nth = calls.get(principal) ?? 0;
      calls.set(principal, nth + 1);
      const status = previewStatus(principal, nth);
      if (status !== 200) return new Response(JSON.stringify({ message: "refused" }), { status });
      return new Response(
        JSON.stringify({ matches: [{ users: ["*"], ports: ["tag:prod:22"] }], type: "user", previewFor: principal }),
        { status: 200 },
      );
    }
    if (url.pathname.endsWith("/acl")) return new Response(POLICY, { status: 200 });
    if (url.pathname.endsWith("/users")) {
      return new Response(JSON.stringify({ users: users.map((loginName) => ({ loginName })) }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  return calls;
}

describe("tailscale_diff_acl_access auth stop", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TAILSCALE_API_KEY = "tskey-api-test";
    process.env.TAILSCALE_TAILNET = "test.ts.net";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("keeps the comparisons already finished when a later principal is refused", async () => {
    const calls = installFetch(["a@example.com", "b@example.com", "c@example.com"], (p) =>
      p === "b@example.com" ? 401 : 200,
    );
    const res = await runDiff();
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data?.principalsCompared, 1);
    assert.deepEqual(res.data?.unchanged, ["a@example.com"]);
    assert.equal(res.data?.failed[0]?.principal, "b@example.com");
    assert.equal(res.data?.stoppedOnAuthFailure, true);
    assert.equal(res.data?.truncated, true);
    assert.match(res.data?.summary ?? "", /1 not checked \(authentication refused\)/);
    // One retry of the refused pair, then stop: c is never previewed.
    assert.equal(calls.get("b@example.com"), 4);
    assert.equal(calls.get("c@example.com"), undefined);
  });

  it("names the cap, not the auth stop, when only the cap skipped users", async () => {
    // Cap 2 of 4 users, and b (the last inside the cap) is refused: c and d were
    // cut by the cap, not by the credential, so fixing the credential alone
    // would still leave them unchecked.
    installFetch(["a@example.com", "b@example.com", "c@example.com", "d@example.com"], (p) =>
      p === "b@example.com" ? 401 : 200,
    );
    const res = await runDiff({ maxPrincipals: 2 });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.match(res.data?.summary ?? "", /2 not checked \(cap 2\)/);
    assert.doesNotMatch(res.data?.summary ?? "", /authentication refused/);
  });

  it("splits the count when the auth stop and the cap each skipped users", async () => {
    // Cap 3: b is refused, so c (inside the cap) is skipped by the auth stop
    // and d (past the cap) by the cap.
    installFetch(["a@example.com", "b@example.com", "c@example.com", "d@example.com"], (p) =>
      p === "b@example.com" ? 401 : 200,
    );
    const res = await runDiff({ maxPrincipals: 3 });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.match(res.data?.summary ?? "", /2 not checked \(1 authentication refused; 1 cap 3\)/);
  });

  it("retries a 401 once and continues when the retry succeeds", async () => {
    const calls = installFetch(["a@example.com", "b@example.com"], (p, nth) =>
      p === "a@example.com" && nth === 0 ? 401 : 200,
    );
    const res = await runDiff();
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data?.principalsCompared, 2);
    assert.deepEqual(res.data?.failed, []);
    assert.equal(res.data?.stoppedOnAuthFailure, false);
    assert.equal(calls.get("a@example.com"), 4);
  });

  it("does not retry a 403, which a fresh token would get too", async () => {
    const calls = installFetch(["a@example.com", "b@example.com"], () => 403);
    const res = await runDiff();
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /authentication failed while previewing a@example\.com/);
    assert.equal(calls.get("a@example.com"), 2);
    assert.equal(calls.get("b@example.com"), undefined);
  });
});
