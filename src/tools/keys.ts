import { z } from "zod";
import { apiGet, apiPost, apiDelete, getTailnet } from "../api.js";

export const keyTools = [
  {
    name: "tailscale_list_keys",
    description: "List all auth keys in your tailnet.",
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/keys`);
    },
  },
  {
    name: "tailscale_get_key",
    description: "Get details for a specific auth key.",
    inputSchema: z.object({
      keyId: z.string().describe("The auth key ID"),
    }),
    handler: async (input: { keyId: string }) => {
      return apiGet(`/tailnet/${getTailnet()}/keys/${input.keyId}`);
    },
  },
  {
    name: "tailscale_create_key",
    description: "Create a new auth key for adding devices to your tailnet.",
    inputSchema: z.object({
      reusable: z.boolean().optional().describe("Whether the key can be used more than once (default: false)"),
      ephemeral: z.boolean().optional().describe("Whether devices using this key are ephemeral (default: false)"),
      preauthorized: z.boolean().optional().describe("Whether devices are pre-authorized (default: false)"),
      tags: z.array(z.string()).optional().describe("ACL tags to apply to devices using this key"),
      expirySeconds: z.number().optional().describe("Key expiry in seconds (default: 90 days)"),
      description: z.string().optional().describe("Description for this key"),
    }),
    handler: async (input: {
      reusable?: boolean;
      ephemeral?: boolean;
      preauthorized?: boolean;
      tags?: string[];
      expirySeconds?: number;
      description?: string;
    }) => {
      const body: Record<string, unknown> = {
        capabilities: {
          devices: {
            create: {
              reusable: input.reusable ?? false,
              ephemeral: input.ephemeral ?? false,
              preauthorized: input.preauthorized ?? false,
              tags: input.tags ?? [],
            },
          },
        },
      };
      if (input.expirySeconds) body.expirySeconds = input.expirySeconds;
      if (input.description) body.description = input.description;
      return apiPost(`/tailnet/${getTailnet()}/keys`, body);
    },
  },
  {
    name: "tailscale_delete_key",
    description: "Delete an auth key.",
    inputSchema: z.object({
      keyId: z.string().describe("The auth key ID to delete"),
    }),
    handler: async (input: { keyId: string }) => {
      return apiDelete(`/tailnet/${getTailnet()}/keys/${input.keyId}`);
    },
  },
] as const;
