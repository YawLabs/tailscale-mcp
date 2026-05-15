import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, encPath, getTailnet } from "../api.js";

// Static snapshot of Tailscale's webhook event-type catalog. New event types
// shipped by Tailscale will be rejected at the schema layer until this list
// is updated and a release goes out -- the trade-off is intentional: a strict
// catalog catches typos and stale event names at validation time, which is
// friendlier than a terse 400 from the API.
//
// Operators who need a new event before a release ships can set
// TAILSCALE_EXTRA_WEBHOOK_EVENTS=eventA,eventB to add events to the allowed
// set at runtime. Please also open an issue so the static list catches up:
// https://github.com/YawLabs/tailscale-mcp/issues
//
// Refresh the static list against https://tailscale.com/api when Tailscale
// announces new events.
const STATIC_WEBHOOK_EVENT_TYPES = [
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

/**
 * Resolve the runtime set of webhook events accepted by the schema. Per-call
 * (not memoized) so the test suite can set/unset TAILSCALE_EXTRA_WEBHOOK_EVENTS
 * between cases without a reset hook, and so operators editing their MCP
 * config see the change on the next tool call. The per-call cost is a single
 * env-var read + a small split, dwarfed by the network round-trip that follows.
 */
function getAllowedWebhookEvents(): ReadonlySet<string> {
  const raw = process.env.TAILSCALE_EXTRA_WEBHOOK_EVENTS;
  if (!raw) return new Set(STATIC_WEBHOOK_EVENT_TYPES);
  const extras = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set<string>([...STATIC_WEBHOOK_EVENT_TYPES, ...extras]);
}

// Array-level superRefine so the allowed set is resolved at parse time (vs at
// module load via z.enum), letting TAILSCALE_EXTRA_WEBHOOK_EVENTS take effect
// without a process restart, AND so a subscriptions array of N events only
// builds the allowed set once (not N times). The "Known events: ..." string
// is built lazily on the first rejection and reused across subsequent ones in
// the same parse, so the formatting cost is paid at most once per call.
//
// We use superRefine rather than refine + function-message because Zod 4
// dropped the function-form second arg on refine.
const webhookSubscriptionsSchema = z
  .array(z.string())
  .min(1)
  .superRefine((arr, ctx) => {
    const allowed = getAllowedWebhookEvents();
    let knownEventsList: string | null = null;
    for (let i = 0; i < arr.length; i++) {
      const value = arr[i];
      if (!allowed.has(value)) {
        // Lazy + memoized within this parse: build once on first miss, reuse
        // for any further misses in the same call.
        knownEventsList ??= [...allowed].sort().join(", ");
        ctx.addIssue({
          code: "custom",
          // `path: [i]` so the issue locates the bad element. Zod prepends the
          // parent path (e.g. "subscriptions") when reporting through the
          // surrounding object schema, producing a final path of
          // ["subscriptions", i] in error.issues.
          path: [i],
          message:
            `Unknown webhook event ${JSON.stringify(value)}. ` +
            `Known events: ${knownEventsList}. ` +
            `To allow a new event Tailscale has shipped before this package updates, ` +
            `set TAILSCALE_EXTRA_WEBHOOK_EVENTS=eventName1,eventName2 in your MCP config.`,
        });
      }
    }
  });

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
      subscriptions: webhookSubscriptionsSchema.describe("Event types to subscribe to (at least one)"),
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
      subscriptions: webhookSubscriptionsSchema
        .optional()
        .describe("Updated list of event types to subscribe to (at least one)"),
    }),
    handler: async (input: { webhookId: string; endpointUrl?: string; subscriptions?: string[] }) => {
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
