import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, encPath, getTailnet } from "../api.js";

const webhookEventTypes = [
  "nodeCreated",
  "nodeNeedsApproval",
  "nodeApproved",
  "nodeKeyExpiringInOneDay",
  "nodeKeyExpired",
  "nodeDeleted",
  "nodeSigned",
  "nodeNeedsSignature",
  "policyUpdate",
  "userCreated",
  "userNeedsApproval",
  "userSuspended",
  "userRestored",
  "userDeleted",
  "userApproved",
  "userRoleUpdated",
  "subnetIPForwardingNotEnabled",
  "exitNodeIPForwardingNotEnabled",
] as const;

type WebhookEvent = (typeof webhookEventTypes)[number];

export const webhookTools = [
  {
    name: "tailscale_list_webhooks",
    description: "List all webhooks configured for your tailnet.",
    annotations: {
      title: "List webhooks",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/webhooks`);
    },
  },
  {
    name: "tailscale_get_webhook",
    description: "Get details for a specific webhook.",
    annotations: {
      title: "Get webhook",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      webhookId: z.string().describe("The webhook ID"),
    }),
    handler: async (input: { webhookId: string }) => {
      return apiGet(`/webhooks/${encPath(input.webhookId)}`);
    },
  },
  {
    name: "tailscale_create_webhook",
    description: "Create a new webhook.",
    annotations: {
      title: "Create webhook",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      endpointUrl: z
        .string()
        .url()
        .refine((u) => u.startsWith("https://"), "endpointUrl must use https://")
        .describe("The HTTPS URL to send webhook events to"),
      subscriptions: z.array(z.enum(webhookEventTypes)).describe("Event types to subscribe to"),
    }),
    handler: async (input: { endpointUrl: string; subscriptions: WebhookEvent[] }) => {
      return apiPost(`/tailnet/${getTailnet()}/webhooks`, {
        endpointUrl: input.endpointUrl,
        subscriptions: input.subscriptions,
      });
    },
  },
  {
    name: "tailscale_update_webhook",
    description: "Update an existing webhook's endpoint URL and/or subscriptions.",
    annotations: {
      title: "Update webhook",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      webhookId: z.string().describe("The webhook ID to update"),
      endpointUrl: z
        .string()
        .url()
        .refine((u) => u.startsWith("https://"), "endpointUrl must use https://")
        .optional()
        .describe("New HTTPS URL to send webhook events to"),
      subscriptions: z
        .array(z.enum(webhookEventTypes))
        .optional()
        .describe("Updated list of event types to subscribe to"),
    }),
    handler: async (input: { webhookId: string; endpointUrl?: string; subscriptions?: WebhookEvent[] }) => {
      const body: Record<string, unknown> = {};
      if (input.endpointUrl !== undefined) body.endpointUrl = input.endpointUrl;
      if (input.subscriptions !== undefined) body.subscriptions = input.subscriptions;
      if (Object.keys(body).length === 0) {
        throw new Error("No fields to update. Provide at least one of: endpointUrl, subscriptions.");
      }
      return apiPatch(`/webhooks/${encPath(input.webhookId)}`, body);
    },
  },
  {
    name: "tailscale_delete_webhook",
    description: "Delete a webhook. This is irreversible — the webhook secret cannot be recovered.",
    annotations: {
      title: "Delete webhook",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      webhookId: z.string().describe("The webhook ID to delete"),
    }),
    handler: async (input: { webhookId: string }) => {
      return apiDelete(`/webhooks/${encPath(input.webhookId)}`);
    },
  },
  {
    name: "tailscale_rotate_webhook_secret",
    description:
      "Rotate a webhook's secret. Returns the new secret — save it immediately, as it cannot be retrieved again. The old secret is immediately invalidated.",
    annotations: {
      title: "Rotate webhook secret",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      webhookId: z.string().describe("The webhook ID whose secret to rotate"),
    }),
    handler: async (input: { webhookId: string }) => {
      return apiPost(`/webhooks/${encPath(input.webhookId)}/rotate`);
    },
  },
  {
    name: "tailscale_test_webhook",
    description: "Send a test event to a webhook endpoint to verify it is configured correctly and receiving events.",
    annotations: {
      title: "Test webhook",
      readOnlyHint: false,
      destructiveHint: false,
      // Each invocation delivers a separate test event to the endpoint —
      // not idempotent in the strict sense.
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      webhookId: z.string().describe("The webhook ID to test"),
    }),
    handler: async (input: { webhookId: string }) => {
      return apiPost(`/webhooks/${encPath(input.webhookId)}/test`);
    },
  },
] as const;
