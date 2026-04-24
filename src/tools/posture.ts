import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, encPath, getTailnet } from "../api.js";

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
      provider: z
        .enum(["falcon", "intune", "jamfpro", "kandji", "kolide", "sentinelone"])
        .describe("The posture provider"),
      clientId: z
        .string()
        .optional()
        .describe(
          "Client ID for the provider (Intune: application UUID; Falcon/Jamf Pro: client id; Kandji/Kolide/Sentinel One: leave blank)",
        ),
      clientSecret: z.string().describe("The secret (auth key, token, etc.) used to authenticate with the provider"),
      tenantId: z.string().optional().describe("Microsoft Intune directory (tenant) ID. Other providers leave blank."),
      cloudId: z
        .string()
        .optional()
        .describe(
          "Identifies which of the provider's clouds to integrate with. Falcon: us-1|us-2|eu-1|us-gov; Intune: global|us-gov; Jamf Pro/Kandji/Sentinel One: FQDN of your subdomain; Kolide: leave blank.",
        ),
    }),
    handler: async (input: {
      provider: "falcon" | "intune" | "jamfpro" | "kandji" | "kolide" | "sentinelone";
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
        .describe("Updated client secret for the provider (omit to retain the existing secret)"),
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
      const { integrationId, ...body } = input;
      const cleanBody: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) cleanBody[key] = value;
      }
      if (Object.keys(cleanBody).length === 0) {
        throw new Error("No fields to update. Provide at least one of: clientId, clientSecret, tenantId, cloudId.");
      }
      return apiPatch(`/posture/integrations/${encPath(integrationId)}`, cleanBody);
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
