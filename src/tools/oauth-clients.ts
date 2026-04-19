import { z } from "zod";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  encPath,
  getTailnet,
  sanitizeDescription,
  validateTags,
} from "../api.js";

export const oauthClientTools = [
  {
    name: "tailscale_list_oauth_clients",
    description: "List all OAuth clients configured for your tailnet.",
    annotations: {
      title: "List OAuth clients",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/oauth-clients`);
    },
  },
  {
    name: "tailscale_get_oauth_client",
    description: "Get details for a specific OAuth client.",
    annotations: {
      title: "Get OAuth client",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      clientId: z.string().describe("The OAuth client ID"),
    }),
    handler: async (input: { clientId: string }) => {
      return apiGet(`/tailnet/${getTailnet()}/oauth-clients/${encPath(input.clientId)}`);
    },
  },
  {
    name: "tailscale_create_oauth_client",
    description:
      "Create a new OAuth client for programmatic API access. Returns the client secret — save it immediately, as it cannot be retrieved again.",
    annotations: {
      title: "Create OAuth client",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z
        .string()
        .describe("A human-readable name for this OAuth client (max 50 chars, alphanumeric/hyphens/spaces)"),
      scopes: z
        .array(z.string())
        .describe(
          "OAuth scopes to grant (e.g. ['devices:read', 'dns', 'acl']). See Tailscale docs for available scopes.",
        ),
      tags: z.array(z.string()).optional().describe("ACL tags to assign to the OAuth client"),
      description: z
        .string()
        .optional()
        .describe("Description for this OAuth client (max 50 chars, alphanumeric/hyphens/spaces)"),
    }),
    handler: async (input: { name: string; scopes: string[]; tags?: string[]; description?: string }) => {
      validateTags(input.tags);
      const body: Record<string, unknown> = { ...input };
      body.name = sanitizeDescription(input.name);
      if (input.description !== undefined) body.description = sanitizeDescription(input.description);
      return apiPost(`/tailnet/${getTailnet()}/oauth-clients`, body);
    },
  },
  {
    name: "tailscale_update_oauth_client",
    description: "Update an OAuth client's name, description, or scopes.",
    annotations: {
      title: "Update OAuth client",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      clientId: z.string().describe("The OAuth client ID to update"),
      name: z.string().optional().describe("Updated name"),
      scopes: z.array(z.string()).optional().describe("Updated OAuth scopes"),
      description: z.string().optional().describe("Updated description"),
    }),
    handler: async (input: { clientId: string; name?: string; scopes?: string[]; description?: string }) => {
      const { clientId, ...body } = input;
      const cleanBody: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) cleanBody[key] = value;
      }
      if (cleanBody.name !== undefined) cleanBody.name = sanitizeDescription(cleanBody.name as string);
      if (cleanBody.description !== undefined)
        cleanBody.description = sanitizeDescription(cleanBody.description as string);
      if (Object.keys(cleanBody).length === 0) {
        throw new Error("No fields to update. Provide at least one of: name, scopes, description.");
      }
      return apiPatch(`/tailnet/${getTailnet()}/oauth-clients/${encPath(clientId)}`, cleanBody);
    },
  },
  {
    name: "tailscale_delete_oauth_client",
    description:
      "Delete an OAuth client. This is irreversible — any integrations using this client will lose access immediately.",
    annotations: {
      title: "Delete OAuth client",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      clientId: z.string().describe("The OAuth client ID to delete"),
    }),
    handler: async (input: { clientId: string }) => {
      return apiDelete(`/tailnet/${getTailnet()}/oauth-clients/${encPath(input.clientId)}`);
    },
  },
] as const;
