import { z } from "zod";
import { apiGet, apiPost, getTailnet } from "../api.js";

// Default number of principals tailscale_diff_acl_access will preview. Each one
// costs TWO preview calls (baseline + proposed), so this is a request-count cap
// as much as a size cap: 25 principals is 50 requests, which is already enough
// to matter under TAILSCALE_MAX_CONCURRENT and the per-request budget.
const DEFAULT_PRINCIPAL_CAP = 25;

// Wall-clock ceiling for one tailscale_diff_acl_access call, across ALL of its
// requests.
//
// api.ts's own budget (TAILSCALE_REQUEST_BUDGET_MS, default 90s) is read fresh
// per apiRequest, which is the right shape for a one-request tool and no
// protection at all for this one: at the default cap it issues ~52 requests, so
// nothing bounded the call as a whole. The comment on that constant explains
// why that matters -- "MCP clients usually have their own outer timeout in the
// 60-120s range" -- and a tool that runs past it hands the client a timeout
// instead of the partial answer it already has in hand.
//
// 60s sits under the low end of that range. Deliberately NOT a new env var: it
// would need a sandbox --allow-env grant and a README entry to be real, and the
// useful knob for "check fewer users" already exists as maxPrincipals.
const DIFF_TIME_BUDGET_MS = 60_000;

/**
 * One rule match as the preview endpoint returns it (Go: UserRuleMatch).
 *
 * `postures` is `string[] | null`, not optional-undefined: a live tailnet returns an
 * explicit `null` on a match with no posture requirement (verified against the API,
 * not inferred from the struct). Every read here uses `?? []`, which handles both.
 */
interface UserRuleMatch {
  users?: string[];
  ports?: string[];
  lineNumber?: number;
  via?: string[];
  postures?: string[] | null;
}

/**
 * The preview response envelope.
 *
 * `postures` maps a posture NAME to the rule expressions that define it, taken from
 * the policy that was submitted. Verified against a live tailnet: previewing a policy
 * carrying `postures: {"posture:x": ["node:tsVersion >= '1.80'"]}` echoes exactly that
 * map back. The key is absent entirely when the submitted policy defines no postures.
 */
interface PreviewResponse {
  matches?: UserRuleMatch[];
  postures?: Record<string, string[]> | null;
}

/**
 * Reduce a preview response's matches to the set of things the principal can
 * actually REACH, as readable strings ("tag:prod:22", "10.0.0.1:443 via
 * tag:relay").
 *
 * Two fields present in the response are deliberately NOT part of the key, and
 * both would otherwise manufacture false positives on a tool whose entire job
 * is to be believed:
 *
 * - `lineNumber` is the rule's position in the policy text. Re-indenting a
 *   policy, or inserting a comment near the top, moves every subsequent rule
 *   and would report the whole tailnet as losing and re-gaining all access.
 * - `users` is the matched rule's SOURCE set. Narrowing `src: ["a", "b"]` to
 *   `src: ["a"]` leaves a's reachable destinations identical, but keying on it
 *   would show a as both losing and gaining the same access.
 *
 * What remains -- destination ports, plus the `via` and posture constraints
 * attached to reaching them -- is the answer to "what can this principal get
 * to, and under what conditions", which is the question being asked.
 *
 * POSTURES ARE RESOLVED TO THEIR DEFINITIONS, not keyed by name. Keying on the name
 * alone was a silent false-clean on the one tool whose entire value is being
 * believed: tightening `posture:corp` from `["node:os == 'macos'"]` to also require
 * a client version changes who can reach every posture-gated destination, while the
 * NAME on every match stays byte-identical, so the diff reported "unchanged" for the
 * whole tailnet. The response carries the submitted policy's definitions (verified
 * against a live tailnet), so folding them into the key makes that change visible.
 *
 * `definitionsAvailable` gates it: fold definitions only when BOTH previews supplied
 * a postures map. If one side omitted it -- an older API, or a policy that defines no
 * postures at all -- resolving one side and not the other would manufacture a change
 * on every posture-gated grant. Falling back to names-only there under-reports rather
 * than over-reports, which is the safe direction for a tool that must not cry wolf.
 *
 * A match carrying no ports contributes nothing: it grants no enumerable
 * destination, so there is nothing to gain or lose.
 */
function accessSet(
  matches: UserRuleMatch[],
  postureDefs: Record<string, string[]> | null | undefined,
  definitionsAvailable: boolean,
): Set<string> {
  const out = new Set<string>();
  for (const match of matches) {
    const via = [...(match.via ?? [])].sort();
    const postures = [...(match.postures ?? [])].sort();
    const posturePart =
      postures.length > 0
        ? ` posture ${postures
            .map((name) => {
              if (!definitionsAvailable) return name;
              // Sorted so a reordered definition is not read as a redefinition.
              const rules = [...(postureDefs?.[name] ?? [])].sort();
              // A name the map does not resolve keeps its bare form rather than
              // rendering an empty `name()`, which would collide with a genuinely
              // empty definition.
              return rules.length > 0 ? `${name}(${rules.join(";")})` : name;
            })
            .join(",")}`
        : "";
    const qualifier = `${via.length > 0 ? ` via ${via.join(",")}` : ""}${posturePart}`;
    for (const port of match.ports ?? []) out.add(`${port}${qualifier}`);
  }
  return out;
}

/**
 * Run the preview endpoint for one principal against one policy and return its
 * access set, or an error string.
 *
 * Request headers deliberately mirror tailscale_preview_acl exactly (raw HuJSON
 * body, `Accept: application/hujson`, acceptRaw) rather than letting apiRequest
 * JSON-parse the response. The body still IS json, so it is parsed here -- but
 * owning the parse means a malformed or unexpected response surfaces as a named
 * failure for that principal instead of an empty match list, which on this tool
 * would render as "loses all access" and is the single worst way it could lie.
 */
async function previewAccess(
  policy: string,
  principal: string,
): Promise<
  | {
      ok: true;
      access: Set<string>;
      hasPostureDefs: boolean;
      matches: UserRuleMatch[];
      postureDefs: Record<string, string[]> | null | undefined;
    }
  | { ok: false; error: string; status: number }
> {
  const params = new URLSearchParams({ type: "user", previewFor: principal });
  const res = await apiPost(`/tailnet/${getTailnet()}/acl/preview?${params}`, undefined, {
    rawBody: policy,
    contentType: "application/hujson",
    acceptRaw: true,
    accept: "application/hujson",
  });
  // `status` is carried out so the caller can tell a principal-specific failure
  // from a blanket one: a 401/403 will refuse every remaining principal too, and
  // continuing would fire 2N doomed requests and stack one full multi-line auth
  // diagnostic per principal into the payload.
  if (!res.ok) return { ok: false, error: res.error || `HTTP ${res.status}`, status: res.status };

  let parsed: PreviewResponse;
  try {
    parsed = JSON.parse(res.rawBody ?? "") as PreviewResponse;
  } catch {
    return {
      ok: false,
      error: "the preview response was not valid JSON, so its rules could not be compared",
      status: res.status,
    };
  }
  // An absent `matches` key is NOT an empty rule set. A response shape change
  // would otherwise read as "this principal can reach nothing", i.e. a fake
  // total-revocation finding on every principal at once.
  if (!Array.isArray(parsed.matches)) {
    return {
      ok: false,
      error: "the preview response contained no `matches` array, so its rules could not be compared",
      status: res.status,
    };
  }
  // The access set is computed by the CALLER, once it knows whether both sides
  // supplied posture definitions -- that is a cross-request fact this function
  // cannot see. Raw matches are carried out for exactly that reason.
  return {
    ok: true,
    access: accessSet(parsed.matches, parsed.postures, false),
    hasPostureDefs: !!parsed.postures,
    matches: parsed.matches,
    postureDefs: parsed.postures,
  };
}

// First-line marker of the ETag footer tailscale_get_acl appends. The appender
// and stripEtagFooter both key off this one constant, so rewording the guidance
// lines cannot orphan a footer block an earlier release already wrote into a
// stored policy.
const ETAG_FOOTER_MARKER = "// ETag: ";

// Remove any ETag footer a previous tailscale_get_acl appended to an ACL body.
// Walks back over the trailing run of blank and `//` lines only -- the footer
// is only ever appended at the very end -- so comments belonging to the policy
// itself are left alone, and several stacked blocks come off in one pass.
function stripEtagFooter(body: string): string {
  const lines = body.split("\n");
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (!line.startsWith("//")) break;
    if (line.startsWith(ETAG_FOOTER_MARKER)) cut = i;
  }
  return lines.slice(0, cut).join("\n");
}

// Put an ETag into the quoted form every upstream client sends, whatever
// quoting the caller supplied.
//
// The value reaches the agent inside the `// ETag: "..."` footer above, i.e. as
// part of a comment line it retypes rather than a field it passes through, so
// the quotes are easy to lose on the way back -- and an unquoted If-Match is a
// precondition that may simply not match, which on this tool surfaces as a
// bare 412 with nothing to say why. Tailscale's own clients both normalize:
// tailscale-client-go-v2's policyfile.go trims the quotes off and formats the
// value with %q to put them back, and gitops-pusher concatenates them on. The
// OpenAPI spec's examples are quoted too, for the sentinel below as much as for
// a real ETag.
//
// A `W/` value is returned untouched: a weak validator carries its own quoting,
// and stripping it would produce `"W/abc"` -- a different validator, not a
// requoted one. Backslash-escaped quotes are deliberately left alone as well,
// since `\` is a legal ETag character and Go's `%q` escaping of it has no
// counterpart on the read side here.
function normalizeIfMatch(etag: string): string {
  const trimmed = etag.trim();
  if (trimmed.startsWith("W/")) return trimmed;
  const inner = trimmed.replace(/^"+|"+$/g, "");
  if (!inner) {
    throw new Error("etag is empty once its quotes are removed -- an empty If-Match cannot guard this overwrite.");
  }
  return `"${inner}"`;
}

export const aclTools = [
  {
    name: "tailscale_get_acl",
    description:
      "Get the current ACL policy for your tailnet. Returns the raw policy text with original formatting preserved, including comments and trailing commas (HuJSON). Also returns an ETag — you must pass it to tailscale_update_acl to safely update the policy.",
    annotations: {
      title: "Get ACL policy",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      const res = await apiGet(`/tailnet/${getTailnet()}/acl`, {
        acceptRaw: true,
        accept: "application/hujson",
      });
      if (res.ok && res.etag) {
        // Embed the ETag as a HuJSON `//` comment so the body remains valid HuJSON.
        // Earlier versions used a `---` separator + bare `ETag:` line, which 400'd
        // the API if an agent round-tripped rawBody verbatim into tailscale_update_acl.
        const footer = [
          "",
          `${ETAG_FOOTER_MARKER}${res.etag}`,
          "// Pass this ETag to tailscale_update_acl when updating the policy.",
          "// (HuJSON treats // as a comment — safe to leave in or strip before re-submitting.)",
          "",
        ].join("\n");
        // Strip the footer from an earlier get before stamping the current one.
        // tailscale_update_acl tells the agent to pass the full text back, so the
        // stored policy returns carrying the last footer; appending unconditionally
        // stacked one more block per edit cycle and grew the live ACL without bound.
        return { ...res, rawBody: `${stripEtagFooter(res.rawBody ?? "")}${footer}` };
      }
      return res;
    },
  },
  {
    name: "tailscale_update_acl",
    description:
      "Update the ACL policy for your tailnet. Accepts the full policy as a string to preserve formatting, comments, and trailing commas (HuJSON). You MUST pass the ETag from tailscale_get_acl to prevent overwriting concurrent changes. Always get the current ACL first, make targeted edits to the text, and pass the full modified text back.",
    annotations: {
      title: "Update ACL policy",
      readOnlyHint: false,
      // Overwrites the whole policy file in one call, and a bad push can lock
      // every device out of the tailnet -- the widest blast radius of any write
      // here, so clients must gate it rather than auto-approve it.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      policy: z
        .string()
        .describe(
          "The full ACL policy text. Preserve existing formatting, comments, and structure. Only modify the specific parts that need to change.",
        ),
      etag: z
        .string()
        .trim()
        .min(1, "etag must not be empty -- an empty ETag would send this overwrite with no concurrency guard.")
        .describe(
          "The ETag from tailscale_get_acl (quotes optional -- they are normalized). Required to prevent concurrent edit conflicts. For the FIRST write to a fresh tailnet you may pass `ts-default` instead: the update then succeeds only if the policy file is still Tailscale's untouched default.",
        ),
    }),
    // `.trim().min(1)`, not a bare `z.string()`: apiRequest sets If-Match behind
    // `if (options?.ifMatch)`, so an empty etag is falsy there and the header is
    // omitted entirely -- the write then overwrites a concurrent admin edit instead
    // of coming back 412, on the widest-blast-radius write in the package, with
    // no diagnostic anywhere. `.trim()` is load-bearing for the same reason it is
    // on tailnets.ts's ids: a bare `.min(1)` accepts " ", which is truthy, so the
    // header goes out carrying a precondition that cannot match any real ETag --
    // a confusing 412 instead of a local validation error naming the field.
    // Quote normalization lives in the handler rather than in the schema because
    // this is the code that builds the header, and because the handlers are what
    // the tests call directly -- a transform on the schema would be invisible to
    // every assertion made at the header.
    handler: async (input: { policy: string; etag: string }) => {
      return apiPost(`/tailnet/${getTailnet()}/acl`, undefined, {
        rawBody: input.policy,
        contentType: "application/hujson",
        ifMatch: normalizeIfMatch(input.etag),
        acceptRaw: true,
        accept: "application/hujson",
      });
    },
  },
  {
    name: "tailscale_validate_acl",
    description:
      "Validate an ACL policy without applying it. Returns any errors found, or confirms the policy is valid.",
    annotations: {
      title: "Validate ACL policy",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      policy: z.string().describe("The full ACL policy text to validate"),
    }),
    handler: async (input: { policy: string }) => {
      const res = await apiPost(`/tailnet/${getTailnet()}/acl/validate`, undefined, {
        rawBody: input.policy,
        contentType: "application/hujson",
        acceptRaw: true,
        accept: "application/hujson",
      });
      // Tailscale's validate endpoint returns 200 with either an empty body
      // or `{}` for a VALID policy; an object with a `message` / `error`
      // field for an INVALID one. Previously only the empty-body case was
      // normalized to "ACL policy is valid.", so a `{}` response leaked
      // through verbatim and looked like a diagnostic to the agent. Matches
      // cli.ts's parseValidationError treatment.
      if (res.ok) {
        const trimmed = res.rawBody?.trim();
        if (!trimmed || trimmed === "{}") {
          return { ...res, rawBody: "ACL policy is valid." };
        }
      }
      return res;
    },
  },
  {
    name: "tailscale_preview_acl",
    description:
      "Preview the ACL rules that would apply to a specific user or IP address if a proposed policy were applied.",
    annotations: {
      title: "Preview ACL rules",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      policy: z.string().describe("The proposed ACL policy text to preview"),
      type: z
        .enum(["user", "ipport"])
        .describe("Preview type: 'user' to see rules for a user, 'ipport' to see rules for an IP"),
      previewFor: z
        .string()
        .describe("The user email (for type 'user') or IP:port (for type 'ipport') to preview rules for"),
    }),
    handler: async (input: { policy: string; type: "user" | "ipport"; previewFor: string }) => {
      const params = new URLSearchParams({ type: input.type, previewFor: input.previewFor });
      return apiPost(`/tailnet/${getTailnet()}/acl/preview?${params}`, undefined, {
        rawBody: input.policy,
        contentType: "application/hujson",
        acceptRaw: true,
        accept: "application/hujson",
      });
    },
  },
  {
    name: "tailscale_diff_acl_access",
    description:
      "Answer 'who loses access?' before applying an ACL change. Compares the CURRENT policy against a proposed one and reports, per user, which destinations they gain and lose. Run this before tailscale_update_acl -- validate_acl only checks syntax and the policy's own tests block, so a policy with no tests validates clean while revoking everyone. " +
      "LIMITS, all reported in the response rather than left to be discovered. It compares USER principals only, so a revocation that runs through a tag or group can show a clean diff, and an empty result is never proof a change is safe. Posture DEFINITION changes ARE detected: posture names are resolved to their rules, so tightening `posture:corp` shows as a change -- except when a preview omits the definitions map, where it falls back to comparing names. It costs two preview requests per user, so it checks the first 25 by default and stops after 60 seconds regardless; either way it sets `truncated`, reports how many were skipped, and says which limit stopped it. Users whose preview fails are listed in `failed` and excluded from the compared count -- a failure is never reported as lost access, and if nothing could be compared the call fails rather than returning an empty diff.",
    annotations: {
      title: "Diff ACL access",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      policy: z.string().describe("The proposed ACL policy text to compare against the current live policy"),
      principals: z
        .array(z.string().trim().min(1))
        .optional()
        .describe(
          "Principals to check, as they appear in `loginName` from tailscale_list_users. That is often an email, but on a GitHub or SSO tailnet it is not (e.g. 'alice@github') -- pass the loginName verbatim rather than an address you assume. Omit to enumerate the tailnet's users automatically. Pass an explicit list to bound the request count, or to check specific users beyond the cap.",
        ),
      maxPrincipals: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Maximum users to check (default ${DEFAULT_PRINCIPAL_CAP}). Each costs two preview requests. Raising this on a large tailnet can be slow and may hit rate limits.`,
        ),
    }),
    handler: async (input: { policy: string; principals?: string[]; maxPrincipals?: number }) => {
      // Clock starts before the two setup GETs, not at the principal loop: they
      // are part of the same call, and a slow pair of them is exactly when the
      // remaining budget matters most.
      const startedAt = Date.now();
      // Baseline is fetched directly rather than through tailscale_get_acl so it
      // arrives without that tool's appended ETag footer. (Comments are inert to
      // the preview endpoint either way, but the baseline should be the policy
      // as stored, not as decorated for an agent.)
      const current = await apiGet<unknown>(`/tailnet/${getTailnet()}/acl`, {
        acceptRaw: true,
        accept: "application/hujson",
      });
      if (!current.ok) {
        return {
          ok: false,
          error: `could not read the current ACL to diff against: ${current.error || `HTTP ${current.status}`}`,
        };
      }
      const baselinePolicy = current.rawBody ?? "";

      let principals: string[];
      let availableTotal: number;
      if (input.principals !== undefined) {
        principals = [...new Set(input.principals)];
        // An explicitly-passed empty array used to fall through to the
        // auto-enumeration branch, so a caller asking for zero principals got a
        // scan of the entire tailnet and up to 50 requests instead. Naming the
        // contradiction beats silently doing the opposite of what was asked.
        if (principals.length === 0) {
          return {
            ok: false,
            error:
              "`principals` was passed as an empty list, so no users were named to compare. Omit the argument entirely to enumerate the tailnet's users, or name at least one email.",
          };
        }
        availableTotal = principals.length;
      } else {
        const usersRes = await apiGet<{ users?: Array<Record<string, unknown>> }>(`/tailnet/${getTailnet()}/users`);
        if (!usersRes.ok) {
          return { ok: false, error: `could not list users to diff: ${usersRes.error || `HTTP ${usersRes.status}`}` };
        }
        // `loginName` is the principal the preview endpoint expects -- NOT
        // necessarily an email. Verified against a live tailnet: a GitHub-auth
        // tailnet returns loginName "alice@github" and carries no `email` key at
        // all, and preview accepts that value. The fallbacks are still deliberate:
        // this tool is useless if a field rename empties the principal list, and an
        // empty list would read as "nobody is affected". If none resolve, the error
        // below says to pass `principals` explicitly rather than returning a falsely
        // clean diff.
        const emails = (usersRes.data?.users ?? [])
          .map((u) => u.loginName ?? u.email ?? u.name)
          .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
        principals = [...new Set(emails)];
        availableTotal = principals.length;
        if (principals.length === 0) {
          return {
            ok: false,
            error:
              "no user emails could be read from the tailnet's user list, so there is nothing to compare. Pass `principals` explicitly with the emails to check -- an empty diff here would wrongly suggest the change affects nobody.",
          };
        }
      }

      const cap = input.maxPrincipals ?? DEFAULT_PRINCIPAL_CAP;
      const checked = principals.slice(0, cap);

      const changed: Array<{ principal: string; lost: string[]; gained: string[] }> = [];
      const unchanged: string[] = [];
      const failed: Array<{ principal: string; error: string }> = [];

      // One principal at a time, its two previews in parallel. Fanning all of
      // them out at once would put 2N requests in flight (50 at the default
      // cap) against a tailnet whose TAILSCALE_MAX_CONCURRENT is unset by
      // default -- a read-only diagnostic should not be the thing that trips
      // rate limiting on a tailnet its caller is about to reconfigure.
      // Counted rather than derived from `checked.length`: an early stop leaves
      // principals in `checked` that were never touched, and using the planned
      // length as the denominator would count them as successfully compared --
      // reintroducing, in a new place, the exact overstatement the compared/
      // attempted split exists to prevent.
      let attempted = 0;
      let stoppedOnTime = false;
      for (const principal of checked) {
        if (Date.now() - startedAt > DIFF_TIME_BUDGET_MS) {
          stoppedOnTime = true;
          break;
        }
        attempted++;
        const [before, after] = await Promise.all([
          previewAccess(baselinePolicy, principal),
          previewAccess(input.policy, principal),
        ]);
        // Both halves must succeed. With only one, the comparison is undefined
        // -- treating a failed proposed-preview as "reaches nothing" would
        // invent a total revocation, and the reverse would hide a real one.
        if (!before.ok || !after.ok) {
          // The outer guard is what narrows before/after to successes below it;
          // the ternary chain narrows each arm to the failing side, so its error
          // and status are readable without a cast. The trailing `undefined` arm
          // is unreachable given the guard, hence the `?.` rather than a
          // non-null assertion.
          const failure = !before.ok ? before : !after.ok ? after : undefined;
          const which = !before.ok ? "current" : "proposed";
          failed.push({
            principal,
            error: `preview against the ${which} policy failed: ${failure?.error ?? "unknown"}`,
          });
          // A 401/403 is not principal-specific: the credential has been refused
          // and every remaining preview will be refused too. Continuing would
          // fire the rest of the 2N requests against an API that has already
          // said no, and stack one full multi-line auth diagnostic per
          // principal into the payload. Stop and report the auth failure once.
          if (failure?.status === 401 || failure?.status === 403) {
            return {
              ok: false,
              error: `authentication failed while previewing ${principal}, so the diff was abandoned rather than continued against a credential the API has already refused: ${failure?.error ?? "unknown"}`,
            };
          }
          continue;
        }
        // Recompute both sides together, because whether posture DEFINITIONS can be
        // folded into the key is a fact about the PAIR: resolving one side and not
        // the other would manufacture a change on every posture-gated grant. Only
        // when both previews carried a postures map is the comparison apples to
        // apples; otherwise both fall back to names-only, which under-reports a
        // redefinition rather than inventing one.
        const definitionsAvailable = before.hasPostureDefs && after.hasPostureDefs;
        const beforeAccess = accessSet(before.matches, before.postureDefs, definitionsAvailable);
        const afterAccess = accessSet(after.matches, after.postureDefs, definitionsAvailable);
        const lost = [...beforeAccess].filter((a) => !afterAccess.has(a)).sort();
        const gained = [...afterAccess].filter((a) => !beforeAccess.has(a)).sort();
        if (lost.length === 0 && gained.length === 0) unchanged.push(principal);
        else changed.push({ principal, lost, gained });
      }

      // The denominator is the number actually COMPARED, not attempted. Using
      // the attempted count meant a run where previews failed still opened with
      // "0 of 25 users checked lose access" -- the clause a reader is most
      // likely to quote -- while asserting coverage of users the tool never
      // compared. The tool's own description promised failures were excluded
      // from the counts; this is what makes that true.
      const compared = attempted - failed.length;
      // Comparing nobody is not a clean diff. Every other zero-information
      // outcome here is already a hard error (unreadable ACL, unresolvable
      // emails); this is the same shape and the most reassuring-looking one.
      // Covers the time-budget case too: if the setup GETs alone burned the
      // budget, `attempted` is 0 and there is nothing to report.
      if (compared === 0) {
        return {
          ok: false,
          error: stoppedOnTime
            ? `no users could be compared: the ${DIFF_TIME_BUDGET_MS / 1000}s budget for this call was spent before any comparison finished. Narrow the run with \`principals\`, or lower \`maxPrincipals\`.`
            : `no users could be compared: all ${attempted} preview attempts failed. First failure: ${failed[0]?.error ?? "unknown"}`,
        };
      }

      const losing = changed.filter((c) => c.lost.length > 0).length;
      const gaining = changed.filter((c) => c.gained.length > 0).length;
      const notChecked = principals.length - attempted;
      const truncated = notChecked > 0;
      const summary = [
        // Failures lead when present, so the headline cannot read as an
        // all-clear over a partially-compared run.
        failed.length > 0 ? `${failed.length} of ${attempted} users could not be checked` : null,
        `${losing} of ${compared} users compared lose access`,
        `${gaining} gain access`,
        `${unchanged.length} unchanged`,
        // Names WHICH limit stopped the run: "cap 25" tells the caller to raise
        // maxPrincipals, and the time budget tells them the opposite -- that
        // raising it would make things worse, and the run needs narrowing.
        truncated
          ? `${notChecked} not checked (${stoppedOnTime ? `${DIFF_TIME_BUDGET_MS / 1000}s time budget` : `cap ${cap}`})`
          : null,
      ]
        .filter(Boolean)
        .join(", ");

      return {
        ok: true,
        data: {
          tailnet: getTailnet(),
          summary,
          // Three numbers, because two of them were being conflated. `Compared`
          // is the only one that describes work actually done.
          principalsCompared: compared,
          principalsFailed: failed.length,
          principalsAvailable: availableTotal,
          truncated,
          // Distinguishes the two truncation causes for a machine reader, which
          // the summary string does only in prose. They call for opposite
          // responses: a cap stop means raise maxPrincipals, a time stop means
          // narrow the run.
          stoppedOnTimeBudget: stoppedOnTime,
          // Restated in the payload, not just the tool description: whoever
          // reads this output is deciding whether to apply the change, and may
          // never have read the description. Each clause names a way this diff
          // can come back empty while real access changed.
          scope: [
            "User principals only.",
            "Not compared: access granted via tags or groups.",
            "Posture definition changes ARE compared -- names are resolved to their rules -- unless a preview omitted the definitions map, in which case names alone are compared and a redefinition would not show.",
            "An empty diff is not proof the change is safe.",
          ].join(" "),
          changed,
          unchanged,
          failed,
        },
      };
    },
  },
] as const;
