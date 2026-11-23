import { z } from "zod";
import { apiDelete, apiGet, apiPost, DEVICE_ID_HINT, encPath, getTailnet } from "../api.js";
import { INVITABLE_ROLES, type InvitableRole } from "./users.js";

export const inviteTools = [
  // --- Device Invites ---
  {
    name: "tailscale_list_device_invites",
    description: "List all device invites for a specific device.",
    annotations: {
      title: "List device invites",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().trim().min(1).describe(`The device ID to list invites for. ${DEVICE_ID_HINT}`),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiGet(`/device/${encPath(input.deviceId)}/device-invites`);
    },
  },
  {
    name: "tailscale_create_device_invite",
    description:
      "Create a device share invitation that allows an external user to access a specific device in your tailnet.",
    annotations: {
      title: "Create device invite",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().trim().min(1).describe(`The device ID to create an invite for. ${DEVICE_ID_HINT}`),
      multiUse: z.boolean().optional().describe("Whether the invite can be used more than once (default: false)"),
      allowExitNode: z
        .boolean()
        .optional()
        .describe("Whether the invited device can be used as an exit node (default: false)"),
      email: z.email().optional().describe("Email address to send the invite to"),
    }),
    handler: async (input: { deviceId: string; multiUse?: boolean; allowExitNode?: boolean; email?: string }) => {
      const body: Record<string, unknown> = {};
      if (input.multiUse !== undefined) body.multiUse = input.multiUse;
      if (input.allowExitNode !== undefined) body.allowExitNode = input.allowExitNode;
      if (input.email !== undefined) body.email = input.email;
      // Every field above is optional, and a bare call ("give me an invite
      // link") is a legitimate create, not an empty update. Rather than POST {}
      // and let the API decide what "create with no parameters" means, send the
      // defaults this schema documents, so the request says what the caller
      // was told it would get.
      if (Object.keys(body).length === 0) {
        body.multiUse = false;
        body.allowExitNode = false;
      }
      // The body shape is NOT verified upstream: the OpenAPI spec documents a
      // one-element ARRAY of invite requests here, while this sends a bare
      // object. The tests pin what the handler sends, not what the API wants.
      // Tracked as finding C1, gated on the live probe P3-C1-device-invite
      // (scripts/lib/probe-plans/p3-c1-device-invite.mjs).
      return apiPost(`/device/${encPath(input.deviceId)}/device-invites`, body);
    },
  },
  {
    name: "tailscale_get_device_invite",
    description: "Get details for a specific device invite.",
    annotations: {
      title: "Get device invite",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      inviteId: z.string().trim().min(1).describe("The device invite ID"),
    }),
    handler: async (input: { inviteId: string }) => {
      return apiGet(`/device-invites/${encPath(input.inviteId)}`);
    },
  },
  {
    name: "tailscale_delete_device_invite",
    description: "Delete a device invite. This is irreversible -- the invite link will stop working.",
    annotations: {
      title: "Delete device invite",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      inviteId: z.string().trim().min(1).describe("The device invite ID to delete"),
      // `.trim().min(1)`, not a bare string: a whitespace-only inviteId encodes
      // to "%20" and this irreversible delete returns a 404 that reads like the
      // invite is already gone (rationale: tailnets.ts delete_tailnet).
    }),
    handler: async (input: { inviteId: string }) => {
      return apiDelete(`/device-invites/${encPath(input.inviteId)}`);
    },
  },

  {
    name: "tailscale_accept_device_invite",
    description: "Accept a device share invitation using the invite URL or code.",
    annotations: {
      title: "Accept device invite",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      invite: z.string().describe("The device invite URL or invite code"),
    }),
    handler: async (input: { invite: string }) => {
      return apiPost("/device-invites/-/accept", { invite: input.invite });
    },
  },

  // --- User Invites ---
  {
    name: "tailscale_list_user_invites",
    description: "List the open (not yet accepted) user invites for your tailnet. Accepted invites are not returned.",
    annotations: {
      title: "List user invites",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/user-invites`);
    },
  },
  {
    name: "tailscale_create_user_invite",
    description:
      "Create a new user invite that allows someone to join your tailnet. Without `email` nothing is sent: the response carries the invite URL to hand over yourself.",
    annotations: {
      title: "Create user invite",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      email: z.email().optional().describe("Email address to send the invite to"),
      role: z.enum(INVITABLE_ROLES).optional().describe("Role to assign to the invited user (default: member)"),
    }),
    handler: async (input: { email?: string; role?: InvitableRole }) => {
      const body: Record<string, unknown> = {};
      if (input.email !== undefined) body.email = input.email;
      if (input.role !== undefined) body.role = input.role;
      // Both fields optional, and passing neither is a real use: without
      // `email` the endpoint returns an invite URL and sends nothing. Send the
      // documented default role rather than POSTing {} and getting whatever
      // "invite with no fields" does upstream.
      if (Object.keys(body).length === 0) body.role = "member";
      // The body shape is NOT verified upstream: the OpenAPI spec documents a
      // one-element ARRAY of invite requests here, while this sends a bare
      // object. The tests pin what the handler sends, not what the API wants.
      // Tracked as finding C1, gated on the live probe P2-C1-user-invite
      // (scripts/lib/probe-plans/p2-c1-user-invite.mjs).
      return apiPost(`/tailnet/${getTailnet()}/user-invites`, body);
    },
  },
  {
    name: "tailscale_get_user_invite",
    description: "Get details for a specific user invite.",
    annotations: {
      title: "Get user invite",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      inviteId: z.string().trim().min(1).describe("The user invite ID"),
    }),
    handler: async (input: { inviteId: string }) => {
      return apiGet(`/user-invites/${encPath(input.inviteId)}`);
    },
  },
  {
    name: "tailscale_delete_user_invite",
    description: "Delete a user invite. This is irreversible -- the invite link will stop working.",
    annotations: {
      title: "Delete user invite",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      inviteId: z.string().trim().min(1).describe("The user invite ID to delete"),
      // `.trim().min(1)`, not a bare string: a whitespace-only inviteId encodes
      // to "%20" and this irreversible delete returns a 404 that reads like the
      // invite is already gone (rationale: tailnets.ts delete_tailnet).
    }),
    handler: async (input: { inviteId: string }) => {
      return apiDelete(`/user-invites/${encPath(input.inviteId)}`);
    },
  },
  {
    name: "tailscale_resend_device_invite",
    description: "Resend a device invite email.",
    annotations: {
      title: "Resend device invite",
      readOnlyHint: false,
      destructiveHint: false,
      // Each call delivers a separate email to the recipient.
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      inviteId: z.string().trim().min(1).describe("The device invite ID to resend"),
    }),
    handler: async (input: { inviteId: string }) => {
      return apiPost(`/device-invites/${encPath(input.inviteId)}/resend`);
    },
  },
  {
    name: "tailscale_resend_user_invite",
    description: "Resend a user invite email.",
    annotations: {
      title: "Resend user invite",
      readOnlyHint: false,
      destructiveHint: false,
      // Each call delivers a separate email to the recipient.
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      inviteId: z.string().trim().min(1).describe("The user invite ID to resend"),
    }),
    handler: async (input: { inviteId: string }) => {
      return apiPost(`/user-invites/${encPath(input.inviteId)}/resend`);
    },
  },
] as const;
