import { z } from "zod";
import { apiGet, apiPost, encPath, getTailnet } from "../api.js";

// Every tailnet user role, in the order the tools have always listed them.
export const USER_ROLES = [
  "owner",
  "admin",
  "it-admin",
  "network-admin",
  "billing-admin",
  "auditor",
  "member",
] as const;
export type UserRole = (typeof USER_ROLES)[number];

// The roles an invite can grant: the spec's createUserInvites role enum omits
// "owner". `satisfies` keeps it a subset of USER_ROLES, so a role renamed or
// dropped there fails to compile here.
export const INVITABLE_ROLES = [
  "member",
  "admin",
  "it-admin",
  "network-admin",
  "billing-admin",
  "auditor",
] as const satisfies readonly UserRole[];
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

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
      role: z.enum(USER_ROLES).optional().describe("Filter by user role"),
    }),
    handler: async (input: { type?: "member" | "shared" | "all"; role?: UserRole }) => {
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
      role: z.enum(USER_ROLES).describe("The new role to assign"),
    }),
    handler: async (input: { userId: string; role: UserRole }) => {
      return apiPost(`/users/${encPath(input.userId)}/role`, { role: input.role });
    },
  },
  {
    name: "tailscale_delete_user",
    description:
      "Delete a user from the tailnet. This is irreversible -- the user and all their devices will be removed.",
    annotations: {
      title: "Delete user",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      // `.trim().min(1)`, not a bare string: a whitespace-only user id encodes
      // to "%20" and this irreversible delete returns a 404 that reads like the
      // user is already gone (rationale: tailnets.ts delete_tailnet).
      userId: z.string().trim().min(1).describe("The user ID to delete"),
    }),
    handler: async (input: { userId: string }) => {
      return apiPost(`/users/${encPath(input.userId)}/delete`);
    },
  },
] as const;
