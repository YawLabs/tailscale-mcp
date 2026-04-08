import { z } from "zod";
import { apiGet, apiPatch, getTailnet } from "../api.js";

export const tailnetTools = [
  {
    name: "tailscale_get_tailnet_settings",
    description: "Get your tailnet settings (device approval, key expiry, HTTPS certificates, etc.).",
    annotations: {
      title: "Get tailnet settings",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/settings`);
    },
  },
  {
    name: "tailscale_update_tailnet_settings",
    description:
      "Update tailnet settings (device approval, auto-updates, key expiry, HTTPS certificates, network flow logging, regional routing, posture identity collection).",
    annotations: {
      title: "Update tailnet settings",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      devicesApprovalOn: z.boolean().optional().describe("Whether device approval is required"),
      devicesAutoUpdatesOn: z.boolean().optional().describe("Whether auto-updates are enabled"),
      devicesKeyDurationDays: z.number().optional().describe("Key expiry duration in days"),
      usersApprovalOn: z.boolean().optional().describe("Whether user approval is required"),
      usersRoleAllowedToJoinExternalTailnets: z
        .enum(["none", "admin", "member"])
        .optional()
        .describe("Which user roles can join external tailnets"),
      networkFlowLoggingOn: z.boolean().optional().describe("Whether network flow logging is enabled"),
      regionalRoutingOn: z.boolean().optional().describe("Whether regional routing is enabled"),
      postureIdentityCollectionOn: z.boolean().optional().describe("Whether posture identity collection is enabled"),
      httpsEnabled: z
        .boolean()
        .optional()
        .describe("Whether HTTPS certificates are enabled (for tailscale serve/funnel)"),
    }),
    handler: async (input: {
      devicesApprovalOn?: boolean;
      devicesAutoUpdatesOn?: boolean;
      devicesKeyDurationDays?: number;
      usersApprovalOn?: boolean;
      usersRoleAllowedToJoinExternalTailnets?: string;
      networkFlowLoggingOn?: boolean;
      regionalRoutingOn?: boolean;
      postureIdentityCollectionOn?: boolean;
      httpsEnabled?: boolean;
    }) => {
      const body: Record<string, unknown> = {};
      if (input.devicesApprovalOn !== undefined) body.devicesApprovalOn = input.devicesApprovalOn;
      if (input.devicesAutoUpdatesOn !== undefined) body.devicesAutoUpdatesOn = input.devicesAutoUpdatesOn;
      if (input.devicesKeyDurationDays !== undefined) body.devicesKeyDurationDays = input.devicesKeyDurationDays;
      if (input.usersApprovalOn !== undefined) body.usersApprovalOn = input.usersApprovalOn;
      if (input.usersRoleAllowedToJoinExternalTailnets !== undefined)
        body.usersRoleAllowedToJoinExternalTailnets = input.usersRoleAllowedToJoinExternalTailnets;
      if (input.networkFlowLoggingOn !== undefined) body.networkFlowLoggingOn = input.networkFlowLoggingOn;
      if (input.regionalRoutingOn !== undefined) body.regionalRoutingOn = input.regionalRoutingOn;
      if (input.postureIdentityCollectionOn !== undefined)
        body.postureIdentityCollectionOn = input.postureIdentityCollectionOn;
      if (input.httpsEnabled !== undefined) body.httpsEnabled = input.httpsEnabled;
      return apiPatch(`/tailnet/${getTailnet()}/settings`, body);
    },
  },
  {
    name: "tailscale_get_contacts",
    description: "Get the tailnet contact information (security, support, admin emails).",
    annotations: {
      title: "Get contacts",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/contacts`);
    },
  },
  {
    name: "tailscale_set_contacts",
    description: "Update tailnet contact information.",
    annotations: {
      title: "Set contacts",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      account: z.object({ email: z.string() }).optional().describe("Account contact email"),
      support: z.object({ email: z.string() }).optional().describe("Support contact email"),
      security: z.object({ email: z.string() }).optional().describe("Security contact email"),
    }),
    handler: async (input: {
      account?: { email: string };
      support?: { email: string };
      security?: { email: string };
    }) => {
      const body: Record<string, unknown> = {};
      if (input.account !== undefined) body.account = input.account;
      if (input.support !== undefined) body.support = input.support;
      if (input.security !== undefined) body.security = input.security;
      return apiPatch(`/tailnet/${getTailnet()}/contacts`, body);
    },
  },
] as const;
