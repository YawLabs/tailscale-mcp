import { z } from "zod";
import { apiGet, apiPost, encPath, getTailnet } from "../api.js";

export const userTools = [
  {
    name: "tailscale_list_users",
    description: "List all users in your tailnet.",
    annotations: {
      title: "List users",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      type: z
        .enum(["member", "shared", "all"])
        .optional()
        .describe("Filter by user type: 'member' (direct members), 'shared' (shared-in users), or 'all' (default)"),
      role: z
        .enum(["owner", "admin", "it-admin", "network-admin", "billing-admin", "auditor", "member"])
        .optional()
        .describe("Filter by user role"),
    }),
    handler: async (input: {
      type?: "member" | "shared" | "all";
      role?: "owner" | "admin" | "it-admin" | "network-admin" | "billing-admin" | "auditor" | "member";
    }) => {
      const params = new URLSearchParams();
      if (input.type) params.set("type", input.type);
      if (input.role) params.set("role", input.role);
      const qs = params.toString();
      return apiGet(`/tailnet/${getTailnet()}/users${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "tailscale_get_user",
    description: "Get details for a specific user.",
    annotations: {
      title: "Get user",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      userId: z.string().describe("The user ID"),
    }),
    handler: async (input: { userId: string }) => {
      return apiGet(`/users/${encPath(input.userId)}`);
    },
  },
  {
    name: "tailscale_approve_user",
    description: "Approve a pending user, granting them access to the tailnet.",
    annotations: {
      title: "Approve user",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      userId: z.string().describe("The user ID to approve"),
    }),
    handler: async (input: { userId: string }) => {
      return apiPost(`/users/${encPath(input.userId)}/approve`);
    },
  },
  {
    name: "tailscale_suspend_user",
    description:
      "Suspend a user, immediately revoking their access to the tailnet. Their devices will be disconnected. Can be reversed with tailscale_restore_user.",
    annotations: {
      title: "Suspend user",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      userId: z.string().describe("The user ID to suspend"),
    }),
    handler: async (input: { userId: string }) => {
      return apiPost(`/users/${encPath(input.userId)}/suspend`);
    },
  },
  {
    name: "tailscale_restore_user",
    description: "Restore a previously suspended user, re-granting them access to the tailnet.",
    annotations: {
      title: "Restore user",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      userId: z.string().describe("The user ID to restore"),
    }),
    handler: async (input: { userId: string }) => {
      return apiPost(`/users/${encPath(input.userId)}/restore`);
    },
  },
  {
    name: "tailscale_update_user_role",
    description: "Update a user's role in the tailnet.",
    annotations: {
      title: "Update user role",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      userId: z.string().describe("The user ID"),
      role: z
        .enum(["owner", "admin", "it-admin", "network-admin", "billing-admin", "auditor", "member"])
        .describe("The new role to assign"),
    }),
    handler: async (input: {
      userId: string;
      role: "owner" | "admin" | "it-admin" | "network-admin" | "billing-admin" | "auditor" | "member";
    }) => {
      return apiPost(`/users/${encPath(input.userId)}/role`, { role: input.role });
    },
  },
  {
    name: "tailscale_delete_user",
    description:
      "Delete a user from the tailnet. This is irreversible — the user and all their devices will be removed.",
    annotations: {
      title: "Delete user",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      userId: z.string().describe("The user ID to delete"),
    }),
    handler: async (input: { userId: string }) => {
      return apiPost(`/users/${encPath(input.userId)}/delete`);
    },
  },
] as const;
