import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, encPath, getTailnet } from "../api.js";

// Static snapshot of Tailscale's supported posture-integration providers, using
// the API's slug (not the product's display name -- Kandji renamed to Iru but
// the slug is still `kandji`, and Kolide is now 1Password XAM but the slug is
// still `kolide`).
//
// This used to be a `z.enum`, which hard-BLOCKED any provider Tailscale added
// after a release: the schema rejected the value before a request was ever
// built, so a newly-supported integration was uncreatable rather than merely
// unvalidated. `fleet` and `huntress` were both supported upstream and both
// unreachable here for exactly that reason.
//
// Mirrors the TAILSCALE_EXTRA_WEBHOOK_EVENTS pattern in webhooks.ts: a strict
// list still catches typos at validation time, but operators can add a provider
// Tailscale ships before this package catches up via
// TAILSCALE_EXTRA_POSTURE_PROVIDERS=providerA,providerB. Please also open an
// issue so the static list catches up:
// https://github.com/YawLabs/tailscale-mcp/issues
//
// Refresh against https://tailscale.com/docs/features/device-posture (or the
// PostureIntegrationProvider constants in tailscale-client-go-v2).
const STATIC_POSTURE_PROVIDERS = [
  "falcon",
  "fleet",
  "huntress",
  "intune",
  "jamfpro",
  "kandji",
  "kolide",
  "sentinelone",
] as const;

/**
 * Resolve the runtime set of accepted posture providers. Per-call (not
 * memoized) for the same reasons as getAllowedWebhookEvents in webhooks.ts:
 * the test suite toggles the env var between cases, and an operator editing
 * their MCP config sees the change on the next tool call. The cost is one
 * env-var read, dwarfed by the network round-trip that follows.
 */
function getAllowedPostureProviders(): ReadonlySet<string> {
  const raw = process.env.TAILSCALE_EXTRA_POSTURE_PROVIDERS;
  if (!raw) return new Set(STATIC_POSTURE_PROVIDERS);
  const extras = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set<string>([...STATIC_POSTURE_PROVIDERS, ...extras]);
}

// superRefine rather than z.enum so the allowed set resolves at PARSE time,
// letting TAILSCALE_EXTRA_POSTURE_PROVIDERS take effect without a restart.
const postureProviderSchema = z.string().superRefine((value, ctx) => {
  const allowed = getAllowedPostureProviders();
  if (allowed.has(value)) return;
  ctx.addIssue({
    code: "custom",
    message:
      `Unknown posture provider ${JSON.stringify(value)}. ` +
      `Known providers: ${[...allowed].sort().join(", ")}. ` +
      `To allow a provider Tailscale has shipped before this package updates, ` +
      `set TAILSCALE_EXTRA_POSTURE_PROVIDERS=providerA,providerB in your MCP config.`,
  });
});

export const postureTools = [
  {
    name: "tailscale_list_posture_integrations",
    description: "List all device posture integrations configured for your tailnet.",
    annotations: {
      title: "List posture integrations",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/posture/integrations`);
    },
  },
  {
    name: "tailscale_get_posture_integration",
    description: "Get details for a specific device posture integration.",
    annotations: {
      title: "Get posture integration",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      integrationId: z.string().describe("The posture integration ID"),
    }),
    handler: async (input: { integrationId: string }) => {
      return apiGet(`/posture/integrations/${encPath(input.integrationId)}`);
    },
  },
  {
    name: "tailscale_create_posture_integration",
    description: "Create a new device posture integration.",
    annotations: {
      title: "Create posture integration",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      provider: postureProviderSchema.describe(
        "The posture provider slug: falcon (CrowdStrike Falcon), fleet, huntress, intune (Microsoft Intune), " +
          "jamfpro (Jamf Pro), kandji (Iru, formerly Kandji), kolide (1Password XAM, formerly Kolide), sentinelone",
      ),
      clientId: z
        .string()
        .optional()
        .describe(
          "Client ID for the provider (Intune: application UUID; Falcon/Jamf Pro: client id; Fleet/Huntress/Kandji/Kolide/Sentinel One: leave blank)",
        ),
      clientSecret: z
        .string()
        .describe(
          "The secret (auth key, token, etc.) used to authenticate with the provider. SENSITIVE: passed straight to Tailscale and not echoed back, but MCP clients may log the input value you supply.",
        ),
      tenantId: z.string().optional().describe("Microsoft Intune directory (tenant) ID. Other providers leave blank."),
      cloudId: z
        .string()
        .optional()
        .describe(
          "Identifies which of the provider's clouds to integrate with. Falcon: us-1|us-2|eu-1|us-gov; Intune: global|us-gov; Jamf Pro/Kandji/Sentinel One: FQDN of your subdomain; Kolide: leave blank.",
        ),
    }),
    handler: async (input: {
      provider: string;
      clientId?: string;
      clientSecret: string;
      tenantId?: string;
      cloudId?: string;
    }) => {
      const body: Record<string, unknown> = {
        provider: input.provider,
        clientSecret: input.clientSecret,
      };
      if (input.clientId !== undefined) body.clientId = input.clientId;
      if (input.tenantId !== undefined) body.tenantId = input.tenantId;
      if (input.cloudId !== undefined) body.cloudId = input.cloudId;
      return apiPost(`/tailnet/${getTailnet()}/posture/integrations`, body);
    },
  },
  {
    name: "tailscale_update_posture_integration",
    description: "Update an existing posture integration's credentials or configuration.",
    annotations: {
      title: "Update posture integration",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      integrationId: z.string().describe("The posture integration ID to update"),
      clientId: z.string().optional().describe("Updated client ID for the provider"),
      clientSecret: z
        .string()
        .optional()
        .describe(
          "Updated client secret for the provider (omit to retain the existing secret). SENSITIVE: passed straight to Tailscale and not echoed back, but MCP clients may log the input value you supply.",
        ),
      tenantId: z.string().optional().describe("Updated tenant ID"),
      cloudId: z.string().optional().describe("Updated cloud identifier (e.g. 'us-1', 'global', or provider FQDN)"),
    }),
    handler: async (input: {
      integrationId: string;
      clientId?: string;
      clientSecret?: string;
      tenantId?: string;
      cloudId?: string;
    }) => {
      // Copy fields explicitly (rather than spread-rest of input) so a future
      // schema/type addition can't silently flow an unintended field to the API.
      //
      // Note this is the OUTLIER, not the house style: services.ts,
      // log-streaming.ts, tailnet.ts and dns.ts all spread-rest and then drop
      // undefined values. Both are safe today -- handlers are reached through a
      // Zod object schema, which strips unknown keys before the handler runs --
      // so the difference only matters for a field ADDED to the schema and then
      // forgotten here. Kept explicit because this handler carries provider
      // credentials and the blast radius of an accidentally-forwarded field is
      // higher. Don't "normalize" the others to match without weighing that.
      const cleanBody: Record<string, unknown> = {};
      if (input.clientId !== undefined) cleanBody.clientId = input.clientId;
      if (input.clientSecret !== undefined) cleanBody.clientSecret = input.clientSecret;
      if (input.tenantId !== undefined) cleanBody.tenantId = input.tenantId;
      if (input.cloudId !== undefined) cleanBody.cloudId = input.cloudId;
      if (Object.keys(cleanBody).length === 0) {
        throw new Error("No fields to update. Provide at least one of: clientId, clientSecret, tenantId, cloudId.");
      }
      return apiPatch(`/posture/integrations/${encPath(input.integrationId)}`, cleanBody);
    },
  },
  {
    name: "tailscale_delete_posture_integration",
    description: "Delete a posture integration. This is irreversible.",
    annotations: {
      title: "Delete posture integration",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      integrationId: z.string().describe("The posture integration ID to delete"),
    }),
    handler: async (input: { integrationId: string }) => {
      return apiDelete(`/posture/integrations/${encPath(input.integrationId)}`);
    },
  },
] as const;
