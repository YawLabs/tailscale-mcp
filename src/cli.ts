/**
 * CLI subcommands for tailscale-mcp.
 * These run instead of the MCP server when a subcommand is passed.
 */

import { readFileSync } from "node:fs";
import { apiGet, apiPost, formatApiErrorData, getTailnet } from "./api.js";

/**
 * What a 2xx body from POST /acl/validate means.
 *
 * `warnings` and `failure` both abort today -- upstream's gitops-pusher and the
 * official Go client both fail on a warning, and this CLI keeps that default.
 * They are told apart anyway so the distinction is decided by the parser, in
 * one place with tests on it, rather than by whoever later adds an opt-in
 * override.
 */
interface ValidationResult {
  kind: "valid" | "warnings" | "failure";
  /** The API's own diagnostic. Absent only when `kind` is "valid". */
  message?: string;
  /** The rendered `data` array, when the body carried a non-empty one. */
  details?: string;
}

/**
 * True only for the shape openapi.yaml's validateSCIMGroupsNotSynced example
 * documents: every entry an object carrying nothing but `user` and a non-empty
 * `warnings` string array, under a message that starts with "warning".
 *
 * Deliberately narrow. The spec types the `data` items as a bare `object`, so
 * an entry could report a real failure under a key this code has never seen --
 * and such an entry has no `errors` field, so a "no errors anywhere" test would
 * wave it through. Anything that is not exactly the documented warnings shape
 * is a failure.
 */
function isWarningsOnly(message: string, data: unknown): boolean {
  if (!/^warning/i.test(message)) return false;
  if (!Array.isArray(data) || data.length === 0) return false;
  return data.every((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const obj = entry as Record<string, unknown>;
    if (!Object.keys(obj).every((key) => key === "user" || key === "warnings")) return false;
    if (obj.user !== undefined && typeof obj.user !== "string") return false;
    return Array.isArray(obj.warnings) && obj.warnings.length > 0 && obj.warnings.every((w) => typeof w === "string");
  });
}

/**
 * Interpret a 2xx response body from POST /acl/validate.
 *
 * Tailscale returns HTTP 200 with `{}` (or an empty body) when the policy is
 * VALID, and a JSON object carrying a `message` -- e.g.
 * `{"message":"line 5, column 1: invalid literal: ..."}` -- when validation or
 * an ACL test fails. A failing `tests` block or a SCIM warning also attaches a
 * `data` array naming the user and the assertion (openapi.yaml, the
 * testsOrValidationFailed and validateSCIMGroupsNotSynced examples); it is
 * rendered into `details` by the same helper api.ts uses for error bodies.
 *
 * NOTE: an earlier version treated ANY non-empty body as a failure. That
 * rejected the `{}` success body and would have aborted every valid deploy with
 * "ACL validation failed: {}". The success contract is "empty or `{}`", not
 * "empty only" -- confirmed against Tailscale's documented validate behavior.
 */
function parseValidationError(rawBody: string | undefined): ValidationResult {
  const trimmed = rawBody?.trim();
  if (!trimmed) return { kind: "valid" }; // empty body => valid
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON. validate's contract is JSON, so an unparseable non-empty body is
    // unexpected -- surface it verbatim rather than silently deploying.
    return { kind: "failure", message: trimmed };
  }
  // The expected shape is a plain JSON object: `{}` means valid; a `message` /
  // `error` field means invalid. Anything else -- array, string, number, null --
  // is an unexpected diagnostic, so fail closed and surface it rather than
  // deploying. (Note `typeof [] === "object"`, so arrays must be excluded
  // explicitly -- otherwise a JSON array would fall through as a fieldless
  // "object" and be mistaken for the `{}` success body.)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "failure", message: trimmed };
  }
  const obj = parsed as Record<string, unknown>;
  const message =
    typeof obj.message === "string" && obj.message.length > 0
      ? obj.message
      : typeof obj.error === "string" && obj.error.length > 0
        ? obj.error
        : undefined;
  // `{}` (the success body), or an object with no error field, => valid. The
  // message is still what decides it, so a body carrying only `data` deploys --
  // matching the official Go client (policyfile.go returns nil when Message is
  // empty). No primary source shows the API emitting that shape; tightening it
  // is a behaviour change, held for the release that adds an override flag.
  if (message === undefined) return { kind: "valid" };
  const details = formatApiErrorData(obj.data);
  return {
    kind: isWarningsOnly(message, obj.data) ? "warnings" : "failure",
    message,
    ...(details ? { details } : {}),
  };
}

function readPolicyFile(filePath: string): string {
  try {
    const text = readFileSync(filePath, "utf-8");
    // Strip a leading U+FEFF. Every PowerShell redirect writes one --
    // `Out-File`, `Set-Content -Encoding utf8` and plain `>` all emit EF BB BF
    // on 5.1 -- as do several Windows editors, so a policy file produced on
    // Windows carries it more often than not. The byte goes on the wire ahead
    // of the first `{`, and the API's diagnostic for the rejection does not
    // name it, which leaves a policy that looks correct in every editor
    // failing for a reason nothing on screen shows. Nothing else changes: a
    // BOM-free file is returned as read, and the bytes after the BOM are still
    // sent verbatim, comments and trailing commas included.
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (err) {
    console.error(`Failed to read ${filePath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

/** POST the policy to /acl/validate; exits 1 with the diagnostic on failure. */
async function validatePolicy(policy: string): Promise<void> {
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
  const validation = parseValidationError(validateRes.rawBody);
  if (validation.kind !== "valid") {
    // One write, not two: CI log viewers interleave stderr lines from
    // concurrent steps, and the per-user detail is unreadable detached from
    // the message it explains.
    console.error(`ACL validation failed: ${validation.message}${validation.details ? `\n${validation.details}` : ""}`);
    process.exit(1);
  }
}

export async function validateAcl(filePath: string): Promise<void> {
  const policy = readPolicyFile(filePath);
  await validatePolicy(policy);
  console.log("ACL policy is valid");
}

export async function deployAcl(filePath: string): Promise<void> {
  const policy = readPolicyFile(filePath);

  // Fetch current ETag
  const getRes = await apiGet(`/tailnet/${getTailnet()}/acl`, { acceptRaw: true, accept: "application/hujson" });
  if (!getRes.ok || !getRes.etag) {
    console.error(`Failed to get current ACL: ${getRes.error || "no ETag returned"}`);
    process.exit(1);
  }

  // Validate before deploying
  await validatePolicy(policy);

  // Deploy with ETag
  const deployRes = await apiPost(`/tailnet/${getTailnet()}/acl`, undefined, {
    rawBody: policy,
    contentType: "application/hujson",
    ifMatch: getRes.etag,
    acceptRaw: true,
    accept: "application/hujson",
  });
  if (!deployRes.ok) {
    if (deployRes.status === 412) {
      // If-Match rejected: someone (or something) changed the ACL between our
      // ETag fetch and this deploy. Deliberately no auto-retry -- refetching
      // and retrying would overwrite the concurrent edit, which is exactly
      // what the guard exists to prevent.
      console.error(
        "ACL deploy failed: the tailnet ACL changed between the ETag fetch and the deploy (concurrent edit). " +
          `Re-run to retry against the current version. (${deployRes.error})`,
      );
    } else {
      console.error(`ACL deploy failed: ${deployRes.error}`);
    }
    process.exit(1);
  }

  console.log("ACL deployed successfully");
}
