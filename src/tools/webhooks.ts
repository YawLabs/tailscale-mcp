import { z } from "zod";
import { apiGet, apiPost, apiPatch, apiDelete, getTailnet } from "../api.js";

export const webhookTools = [
  {
    name: "tailscale_list_webhooks",
    description: "List all webhooks configured for your tailnet.",
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/webhooks`);
    },
  },
  {
    name: "tailscale_get_webhook",
    description: "Get details for a specific webhook.",
    inputSchema: z.object({
      webhookId: z.string().describe("The webhook ID"),
    }),
    handler: async (input: { webhookId: string }) => {
      return apiGet(`/webhooks/${input.webhookId}`);
    },
  },
  {
    name: "tailscale_create_webhook",
    description: "Create a new webhook.",
    inputSchema: z.object({
      endpointUrl: z.string().describe("The URL to send webhook events to"),
      subscriptions: z
        .array(z.string())
        .describe(
          "Event types to subscribe to (e.g. ['nodeCreated', 'nodeDeleted', 'nodeApproved', 'policyUpdate', 'userCreated', 'userDeleted'])"
        ),
    }),
    handler: async (input: { endpointUrl: string; subscriptions: string[] }) => {
      return apiPost(`/tailnet/${getTailnet()}/webhooks`, {
        endpointUrl: input.endpointUrl,
        subscriptions: input.subscriptions,
      });
    },
  },
  {
    name: "tailscale_update_webhook",
    description: "Update an existing webhook's subscriptions.",
    inputSchema: z.object({
      webhookId: z.string().describe("The webhook ID to update"),
      subscriptions: z
        .array(z.string())
        .describe(
          "Updated list of event types to subscribe to (e.g. ['nodeCreated', 'nodeDeleted', 'nodeApproved', 'policyUpdate', 'userCreated', 'userDeleted'])"
        ),
    }),
    handler: async (input: { webhookId: string; subscriptions: string[] }) => {
      return apiPatch(`/webhooks/${input.webhookId}`, {
        subscriptions: input.subscriptions,
      });
    },
  },
  {
    name: "tailscale_delete_webhook",
    description: "Delete a webhook. This is irreversible — the webhook secret cannot be recovered.",
    inputSchema: z.object({
      webhookId: z.string().describe("The webhook ID to delete"),
    }),
    handler: async (input: { webhookId: string }) => {
      return apiDelete(`/webhooks/${input.webhookId}`);
    },
  },
] as const;
