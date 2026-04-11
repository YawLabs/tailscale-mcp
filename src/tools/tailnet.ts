import { z } from "zod";
import { apiGet, apiPatch, apiPost, encPath, getTailnet } from "../api.js";

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
      aclsExternallyManagedOn: z.boolean().optional().describe("Whether ACLs are externally managed (e.g. via GitOps)"),
      aclsExternalLink: z
        .string()
        .optional()
        .describe("URL to the external ACL management system (shown in the admin console)"),
    }),
    handler: async (input: {
      devicesApprovalOn?: boolean;
      devicesAutoUpdatesOn?: boolean;
      devicesKeyDurationDays?: number;
      usersApprovalOn?: boolean;
      usersRoleAllowedToJoinExternalTailnets?: "none" | "admin" | "member";
      networkFlowLoggingOn?: boolean;
      regionalRoutingOn?: boolean;
      postureIdentityCollectionOn?: boolean;
      httpsEnabled?: boolean;
      aclsExternallyManagedOn?: boolean;
      aclsExternalLink?: string;
    }) => {
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) body[key] = value;
      }
      if (Object.keys(body).length === 0) {
        throw new Error("No fields to update. Provide at least one setting to change.");
      }
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
      const results: Record<string, unknown> = {};
      for (const contactType of ["account", "support", "security"] as const) {
        const value = input[contactType];
        if (value !== undefined) {
          const res = await apiPatch(`/tailnet/${getTailnet()}/contacts/${encPath(contactType)}`, value);
          if (!res.ok) return res;
          results[contactType] = res.data;
        }
      }
      return { ok: true, status: 200, data: results };
    },
  },
  {
    name: "tailscale_resend_contact_verification",
    description: "Resend the verification email for a tailnet contact.",
    annotations: {
      title: "Resend contact verification",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      contactType: z.enum(["account", "support", "security"]).describe("The contact type to resend verification for"),
    }),
    handler: async (input: { contactType: "account" | "support" | "security" }) => {
      return apiPost(`/tailnet/${getTailnet()}/contacts/${encPath(input.contactType)}/resend-verification-email`);
    },
  },
] as const;
