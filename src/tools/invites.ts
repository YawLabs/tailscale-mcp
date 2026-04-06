import { z } from "zod";
import { apiGet, apiPost, apiDelete, getTailnet, encPath } from "../api.js";

export const inviteTools = [
  // --- Device Invites ---
  {
    name: "tailscale_list_device_invites",
    description: "List all device invites for your tailnet.",
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/device-invites`);
    },
  },
  {
    name: "tailscale_create_device_invite",
    description:
      "Create a new device invite that allows someone to add a device to your tailnet.",
    inputSchema: z.object({
      multiUse: z.boolean().optional().describe("Whether the invite can be used more than once (default: false)"),
      allowExitNode: z
        .boolean()
        .optional()
        .describe("Whether the invited device can be used as an exit node (default: false)"),
      email: z
        .string()
        .optional()
        .describe("Email address to send the invite to"),
    }),
    handler: async (input: {
      multiUse?: boolean;
      allowExitNode?: boolean;
      email?: string;
    }) => {
      const body: Record<string, unknown> = {};
      if (input.multiUse !== undefined) body.multiUse = input.multiUse;
      if (input.allowExitNode !== undefined) body.allowExitNode = input.allowExitNode;
      if (input.email !== undefined) body.email = input.email;
      return apiPost(`/tailnet/${getTailnet()}/device-invites`, body);
    },
  },
  {
    name: "tailscale_get_device_invite",
    description: "Get details for a specific device invite.",
    inputSchema: z.object({
      inviteId: z.string().describe("The device invite ID"),
    }),
    handler: async (input: { inviteId: string }) => {
      return apiGet(`/device-invites/${encPath(input.inviteId)}`);
    },
  },
  {
    name: "tailscale_delete_device_invite",
    description:
      "Delete a device invite. This is irreversible — the invite link will stop working.",
    inputSchema: z.object({
      inviteId: z.string().describe("The device invite ID to delete"),
    }),
    handler: async (input: { inviteId: string }) => {
      return apiDelete(`/device-invites/${encPath(input.inviteId)}`);
    },
  },

  // --- User Invites ---
  {
    name: "tailscale_list_user_invites",
    description: "List all user invites for your tailnet.",
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/user-invites`);
    },
  },
  {
    name: "tailscale_create_user_invite",
    description:
      "Create a new user invite that allows someone to join your tailnet.",
    inputSchema: z.object({
      email: z
        .string()
        .optional()
        .describe("Email address to send the invite to"),
      role: z
        .enum(["member", "admin", "it-admin", "network-admin", "billing-admin", "auditor"])
        .optional()
        .describe("Role to assign to the invited user (default: member)"),
    }),
    handler: async (input: { email?: string; role?: string }) => {
      const body: Record<string, unknown> = {};
      if (input.email !== undefined) body.email = input.email;
      if (input.role !== undefined) body.role = input.role;
      return apiPost(`/tailnet/${getTailnet()}/user-invites`, body);
    },
  },
  {
    name: "tailscale_get_user_invite",
    description: "Get details for a specific user invite.",
    inputSchema: z.object({
      inviteId: z.string().describe("The user invite ID"),
    }),
    handler: async (input: { inviteId: string }) => {
      return apiGet(`/user-invites/${encPath(input.inviteId)}`);
    },
  },
  {
    name: "tailscale_delete_user_invite",
    description:
      "Delete a user invite. This is irreversible — the invite link will stop working.",
    inputSchema: z.object({
      inviteId: z.string().describe("The user invite ID to delete"),
    }),
    handler: async (input: { inviteId: string }) => {
      return apiDelete(`/user-invites/${encPath(input.inviteId)}`);
    },
  },
] as const;
