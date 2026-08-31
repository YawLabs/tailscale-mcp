import { z } from "zod";
import { apiDelete, apiGet, apiPost, encPath, getTailnet } from "../api.js";

/**
 * Organization-scoped tailnet management ("API-only tailnets").
 *
 * These are the only endpoints in this package that live under /organizations
 * rather than /tailnet/{tailnet}, and they behave differently from the rest of
 * the admin API in two ways worth knowing:
 *
 *  1. They authenticate ONLY with an OAuth client (not an API key). Creating
 *     needs the `tailnets` scope; subsequently reaching the created tailnet
 *     needs an OAuth client with the `all` scope plus TAILSCALE_OAUTH_TAILNET
 *     set to the new tailnet (see getOAuthTailnet in api.ts).
 *  2. A tailnet created this way is not managed in the admin console -- it is
 *     intended for programmatic, ephemeral use (per-agent sandboxes, per-tenant
 *     isolation, CI).
 *
 * The organization is addressed as "-" by default, matching Tailscale's own Go
 * client, which hardcodes it. The parameter exists for callers who hold
 * credentials spanning more than one org.
 */

const organizationSchema = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe("Organization ID. Defaults to '-' (the organization owning the calling credentials).");

export const tailnetsTools = [
  {
    name: "tailscale_list_org_tailnets",
    description:
      "List the tailnets in your organization, including API-only tailnets created via the API. Paginated: returns at most `limit` results (Tailscale defaults to 100) plus a `cursor`. Pass that cursor back to fetch the next page; an empty cursor in the response means you have reached the end. Requires OAuth authentication.",
    annotations: {
      title: "List organization tailnets",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      organization: organizationSchema,
      // No client-side ceiling: Tailscale's documented maximum for `limit` is
      // unknown, so an invented cap would either reject values the API accepts
      // or wave through ones it does not. Let the API be the authority and
      // surface its 400 verbatim.
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max tailnets to return in this page. Omit to use Tailscale's default of 100."),
      cursor: z.string().optional().describe("Pagination cursor from a previous response. Omit for the first page."),
    }),
    handler: async (input: { organization?: string; limit?: number; cursor?: string }) => {
      const params = new URLSearchParams();
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      if (input.cursor !== undefined) params.set("cursor", input.cursor);
      const qs = params.toString();
      const org = encPath(input.organization ?? "-");
      return apiGet(`/organizations/${org}/tailnets${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "tailscale_create_org_tailnet",
    description:
      "Create a new API-only tailnet in your organization. Returns the tailnet (id, displayName, orgId, dnsName, createdAt) AND a freshly-minted OAuth client for it.\n\nSECURITY: the response body contains that OAuth client's secret verbatim, and it cannot be retrieved again. MCP clients commonly persist tool responses to logs and conversation transcripts; treat this response as sensitive.\n\nRequires an OAuth client with the 'tailnets' scope -- an API key will not work. To then operate on the new tailnet, set TAILSCALE_OAUTH_TAILNET to its id and use an OAuth client with the 'all' scope.",
    annotations: {
      title: "Create organization tailnet",
      readOnlyHint: false,
      destructiveHint: false,
      // Each call creates a distinct tailnet; there is no idempotency key.
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      displayName: z.string().trim().min(1).describe("Human-readable name for the new tailnet"),
      organization: organizationSchema,
    }),
    handler: async (input: { displayName: string; organization?: string }) => {
      const org = encPath(input.organization ?? "-");
      return apiPost(`/organizations/${org}/tailnets`, { displayName: input.displayName });
    },
  },
  {
    name: "tailscale_delete_tailnet",
    description:
      "Permanently delete a tailnet. This is IRREVERSIBLE and removes every device, user, ACL, and key in it.\n\nBy default it acts on the tailnet the current credentials point at (TAILSCALE_TAILNET, or TAILSCALE_OAUTH_TAILNET when targeting an API-only tailnet). Pass `tailnet` to name a different one -- e.g. an id returned by tailscale_list_org_tailnets -- which requires credentials scoped to reach it; UNVERIFIED against a live tailnet, so expect a 403/404 if your token cannot. You must always pass `confirmTailnet` matching the effective target exactly; the call is refused locally otherwise. That check is a typo guard, not an authorization gate: when you also pass `tailnet` you are supplying both halves of the comparison, so it proves only that they agree -- it is a genuine second look only on the omit-`tailnet` path, where the value has to match the operator's environment. Restricting who may delete at all is TAILSCALE_READONLY / TAILSCALE_TOOLS, which drop this tool from the server entirely. Intended for tearing down API-only tailnets created by tailscale_create_org_tailnet.",
    annotations: {
      title: "Delete tailnet",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      tailnet: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Tailnet to delete (e.g. an id from tailscale_list_org_tailnets). Omit to target the configured tailnet. Requires credentials scoped to reach it.",
        ),
      confirmTailnet: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Must exactly match the effective target -- `tailnet` when given, otherwise the configured tailnet (TAILSCALE_TAILNET / TAILSCALE_OAUTH_TAILNET). A typo guard, not an authorization gate: on the explicit-`tailnet` path the caller writes both halves of the comparison, so it proves only self-agreement. It is a real second look only when `tailnet` is omitted and the value has to match the operator's environment.",
        ),
    }),
    // `.trim().min(1)` on both fields, not just `.min(1)`: a bare min(1) accepts
    // " ", which then trims to "" in the handler, goes falsy, and silently falls
    // back to the CONFIGURED tailnet. The confirm guard still held, so it was
    // never a wrong-target delete -- but "delete the tailnet I named" quietly
    // becoming "delete the default one" is the wrong shape for an irreversible
    // operation. Trimming at the schema turns it into a validation error.
    handler: async (input: { tailnet?: string; confirmTailnet: string }) => {
      // Prefer the OAuth target when set: that is the tailnet the minted token
      // actually addresses, so it is what the DELETE will hit. Falling back to
      // getTailnet() keeps the check meaningful on the API-key path.
      const configured = process.env.TAILSCALE_OAUTH_TAILNET?.trim() || getTailnet();
      const target = input.tailnet?.trim() || configured;
      if (target === "-") {
        throw new Error(
          "Refusing to delete: the tailnet resolves to '-' (the default self-reference), so there is nothing " +
            "specific to confirm against. Set TAILSCALE_TAILNET (or TAILSCALE_OAUTH_TAILNET) to the tailnet's " +
            "explicit name or id first.",
        );
      }
      // `target` is derived from `input.tailnet` when that is given, so on the
      // explicit path this compares a caller's value against the same caller's
      // value -- it catches a typo, not a wrong intent. Say which source the
      // target came from: the single "configured tailnet" wording was emitted
      // for an explicitly-named target too, which reads as an env mismatch and
      // sends the caller off to fix TAILSCALE_TAILNET when nothing in the
      // environment was involved.
      if (input.confirmTailnet !== target) {
        const source = input.tailnet?.trim() ? "tailnet you named" : "configured tailnet";
        throw new Error(
          `confirmTailnet ${JSON.stringify(input.confirmTailnet)} does not match the ${source} ` +
            `${JSON.stringify(target)}. Refusing to delete.`,
        );
      }
      // encPath, unlike the raw interpolation of getTailnet() elsewhere in this
      // package: `target` can now come from tool input, not just operator env,
      // so the "trusted env, never caller input" rationale documented on
      // getTailnet no longer covers it. Encoding is a no-op for real tailnet
      // names ("-", "example.com", "tail1234.ts.net") either way.
      return apiDelete(`/tailnet/${encPath(target)}`);
    },
  },
] as const;
