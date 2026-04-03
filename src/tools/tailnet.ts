import { z } from "zod";
import { apiGet, apiPatch, getTailnet } from "../api.js";

export const tailnetTools = [
  {
    name: "tailscale_get_tailnet_settings",
    description: "Get your tailnet settings (device approval, key expiry, etc.).",
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/settings`);
    },
  },
  {
    name: "tailscale_update_tailnet_settings",
    description: "Update tailnet settings.",
    inputSchema: z.object({
      devicesApprovalOn: z.boolean().optional().describe("Whether device approval is required"),
      devicesAutoUpdatesOn: z.boolean().optional().describe("Whether auto-updates are enabled"),
      devicesKeyDurationDays: z.number().optional().describe("Key expiry duration in days"),
      usersApprovalOn: z.boolean().optional().describe("Whether user approval is required"),
      networkFlowLoggingOn: z.boolean().optional().describe("Whether network flow logging is enabled"),
      regionalRoutingOn: z.boolean().optional().describe("Whether regional routing is enabled"),
    }),
    handler: async (input: Record<string, unknown>) => {
      return apiPatch(`/tailnet/${getTailnet()}/settings`, input);
    },
  },
  {
    name: "tailscale_get_contacts",
    description: "Get the tailnet contact information (security, support, admin emails).",
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/contacts`);
    },
  },
  {
    name: "tailscale_set_contacts",
    description: "Update tailnet contact information.",
    inputSchema: z.object({
      account: z.object({ email: z.string() }).optional().describe("Account contact email"),
      support: z.object({ email: z.string() }).optional().describe("Support contact email"),
      security: z.object({ email: z.string() }).optional().describe("Security contact email"),
    }),
    handler: async (input: Record<string, unknown>) => {
      return apiPatch(`/tailnet/${getTailnet()}/contacts`, input);
    },
  },
] as const;
