import { z } from "zod";
import { apiGet, apiPost, apiPatch, getTailnet } from "../api.js";

export const userTools = [
  {
    name: "tailscale_list_users",
    description: "List all users in your tailnet.",
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/users`);
    },
  },
  {
    name: "tailscale_get_user",
    description: "Get details for a specific user.",
    inputSchema: z.object({
      userId: z.string().describe("The user ID"),
    }),
    handler: async (input: { userId: string }) => {
      return apiGet(`/users/${input.userId}`);
    },
  },
  {
    name: "tailscale_approve_user",
    description: "Approve a pending user, granting them access to the tailnet.",
    inputSchema: z.object({
      userId: z.string().describe("The user ID to approve"),
    }),
    handler: async (input: { userId: string }) => {
      return apiPost(`/users/${input.userId}/approve`);
    },
  },
  {
    name: "tailscale_suspend_user",
    description: "Suspend a user, immediately revoking their access to the tailnet. Their devices will be disconnected.",
    inputSchema: z.object({
      userId: z.string().describe("The user ID to suspend"),
    }),
    handler: async (input: { userId: string }) => {
      return apiPost(`/users/${input.userId}/suspend`);
    },
  },
  {
    name: "tailscale_restore_user",
    description: "Restore a previously suspended user, re-granting them access to the tailnet.",
    inputSchema: z.object({
      userId: z.string().describe("The user ID to restore"),
    }),
    handler: async (input: { userId: string }) => {
      return apiPost(`/users/${input.userId}/restore`);
    },
  },
  {
    name: "tailscale_update_user_role",
    description: "Update a user's role in the tailnet.",
    inputSchema: z.object({
      userId: z.string().describe("The user ID"),
      role: z.enum(["owner", "admin", "it-admin", "network-admin", "billing-admin", "auditor", "member"])
        .describe("The new role to assign"),
    }),
    handler: async (input: { userId: string; role: string }) => {
      return apiPatch(`/users/${input.userId}/role`, { role: input.role });
    },
  },
] as const;
