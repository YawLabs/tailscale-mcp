/**
 * CLI subcommands for tailscale-mcp.
 * These run instead of the MCP server when a subcommand is passed.
 */

import { readFileSync } from "node:fs";
import { apiGet, apiPost, getTailnet } from "./api.js";

/**
 * Interpret a 2xx response body from POST /acl/validate.
 *
 * Tailscale returns HTTP 200 with `{}` (or an empty body) when the policy is
 * VALID, and a JSON object carrying a `message` -- e.g.
 * `{"message":"line 5, column 1: invalid literal: ..."}` -- when validation or
 * an ACL test fails. Returns the human-readable error string when the body
 * signals failure, or `undefined` when the policy validated cleanly.
 *
 * NOTE: an earlier version treated ANY non-empty body as a failure. That
 * rejected the `{}` success body and would have aborted every valid deploy with
 * "ACL validation failed: {}". The success contract is "empty or `{}`", not
 * "empty only" -- confirmed against Tailscale's documented validate behavior.
 */
function parseValidationError(rawBody: string | undefined): string | undefined {
  const trimmed = rawBody?.trim();
  if (!trimmed) return undefined; // empty body => valid
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON. validate's contract is JSON, so an unparseable non-empty body is
    // unexpected -- surface it verbatim rather than silently deploying.
    return trimmed;
  }
  // The expected shape is a plain JSON object: `{}` means valid; a `message` /
  // `error` field means invalid. Anything else -- array, string, number, null --
  // is an unexpected diagnostic, so fail closed and surface it rather than
  // deploying. (Note `typeof [] === "object"`, so arrays must be excluded
  // explicitly -- otherwise a JSON array would fall through as a fieldless
  // "object" and be mistaken for the `{}` success body.)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return trimmed;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.message === "string" && obj.message.length > 0) return obj.message;
  if (typeof obj.error === "string" && obj.error.length > 0) return obj.error;
  return undefined; // `{}` (the success body) or an object with no error field => valid
}

export async function deployAcl(filePath: string): Promise<void> {
  let policy: string;
  try {
    policy = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error(`Failed to read ${filePath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Fetch current ETag
  const getRes = await apiGet(`/tailnet/${getTailnet()}/acl`, { acceptRaw: true, accept: "application/hujson" });
  if (!getRes.ok || !getRes.etag) {
    console.error(`Failed to get current ACL: ${getRes.error || "no ETag returned"}`);
    process.exit(1);
  }

  // Validate before deploying
  const validateRes = await apiPost(`/tailnet/${getTailnet()}/acl/validate`, undefined, {
    rawBody: policy,
    contentType: "application/hujson",
    acceptRaw: true,
    accept: "application/hujson",
  });
  if (!validateRes.ok) {
    console.error(`ACL validation failed: ${validateRes.error}`);
    process.exit(1);
  }
  const validationError = parseValidationError(validateRes.rawBody);
  if (validationError) {
    console.error(`ACL validation failed: ${validationError}`);
    process.exit(1);
  }

  // Deploy with ETag
  const deployRes = await apiPost(`/tailnet/${getTailnet()}/acl`, undefined, {
    rawBody: policy,
    contentType: "application/hujson",
    ifMatch: getRes.etag,
    acceptRaw: true,
    accept: "application/hujson",
  });
  if (!deployRes.ok) {
    console.error(`ACL deploy failed: ${deployRes.error}`);
    process.exit(1);
  }

  console.log("ACL deployed successfully");
}
