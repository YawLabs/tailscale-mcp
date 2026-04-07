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
      return apiGet(`/tailnet/${getTailnet()}/posture/integrations/${encPath(input.integrationId)}`);
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
      provider: z.string().describe("The posture provider (e.g. 'crowdstrike', 'sentinelone', 'intune')"),
      clientId: z.string().describe("The OAuth client ID for the provider"),
      clientSecret: z.string().describe("The OAuth client secret for the provider"),
      tenantId: z.string().optional().describe("The tenant ID (required for some providers)"),
      cloudEnvironment: z.string().optional().describe("Cloud environment (e.g. 'us-1', 'eu-1')"),
    }),
    handler: async (input: {
      provider: string;
      clientId: string;
      clientSecret: string;
      tenantId?: string;
      cloudEnvironment?: string;
    }) => {
      return apiPost(`/tailnet/${getTailnet()}/posture/integrations`, input);
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
      clientId: z.string().optional().describe("Updated OAuth client ID for the provider"),
      clientSecret: z.string().optional().describe("Updated OAuth client secret for the provider"),
      tenantId: z.string().optional().describe("Updated tenant ID"),
      cloudEnvironment: z.string().optional().describe("Updated cloud environment (e.g. 'us-1', 'eu-1')"),
    }),
    handler: async (input: {
      integrationId: string;
      clientId?: string;
      clientSecret?: string;
      tenantId?: string;
      cloudEnvironment?: string;
    }) => {
      const { integrationId, ...body } = input;
      // Remove undefined values so we only send fields the user wants to update
      const cleanBody: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) cleanBody[key] = value;
      }
      return apiPatch(`/tailnet/${getTailnet()}/posture/integrations/${encPath(integrationId)}`, cleanBody);
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
      return apiDelete(`/tailnet/${getTailnet()}/posture/integrations/${encPath(input.integrationId)}`);
    },
  },
] as const;
