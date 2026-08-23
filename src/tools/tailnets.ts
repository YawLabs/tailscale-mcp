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
      limit: z
        .number()
        .int()
        .positive()
        .max(1000)
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
      displayName: z.string().min(1).describe("Human-readable name for the new tailnet"),
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
      "Permanently delete a tailnet. This is IRREVERSIBLE and removes every device, user, ACL, and key in it.\n\nThe endpoint acts on the tailnet the current credentials point at (TAILSCALE_TAILNET, or TAILSCALE_OAUTH_TAILNET when targeting an API-only tailnet) -- it does NOT take a tailnet argument. To prevent an agent from destroying the wrong tailnet, you must pass `confirmTailnet` matching the configured value exactly; the call is refused locally otherwise. Intended for tearing down API-only tailnets created by tailscale_create_org_tailnet.",
    annotations: {
      title: "Delete tailnet",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      confirmTailnet: z
        .string()
        .min(1)
        .describe(
          "Must exactly match the configured tailnet (TAILSCALE_TAILNET / TAILSCALE_OAUTH_TAILNET). A deliberate second look before an irreversible org-wide delete.",
        ),
    }),
    handler: async (input: { confirmTailnet: string }) => {
      // Prefer the OAuth target when set: that is the tailnet the minted token
      // actually addresses, so it is what the DELETE will hit. Falling back to
      // getTailnet() keeps the check meaningful on the API-key path.
      const target = process.env.TAILSCALE_OAUTH_TAILNET?.trim() || getTailnet();
      if (target === "-") {
        throw new Error(
          "Refusing to delete: the tailnet resolves to '-' (the default self-reference), so there is nothing " +
            "specific to confirm against. Set TAILSCALE_TAILNET (or TAILSCALE_OAUTH_TAILNET) to the tailnet's " +
            "explicit name or id first.",
        );
      }
      if (input.confirmTailnet !== target) {
        throw new Error(
          `confirmTailnet ${JSON.stringify(input.confirmTailnet)} does not match the configured tailnet ` +
            `${JSON.stringify(target)}. Refusing to delete.`,
        );
      }
      return apiDelete(`/tailnet/${target}`);
    },
  },
] as const;
