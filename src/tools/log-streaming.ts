import { z } from "zod";
import { apiDelete, apiGet, apiPost, apiPut, encPath, getTailnet } from "../api.js";

export const logStreamingTools = [
  {
    name: "tailscale_list_log_stream_configs",
    description:
      "List all log streaming configurations for your tailnet. Log streaming sends logs to external destinations like Axiom, Datadog, Splunk, Elasticsearch, S3, or GCS.",
    annotations: {
      title: "List log stream configs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/logging/stream`);
    },
  },
  {
    name: "tailscale_get_log_stream_config",
    description: "Get the log streaming configuration for a specific log type.",
    annotations: {
      title: "Get log stream config",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      logType: z
        .enum(["configuration", "network"])
        .describe("The log type: 'configuration' for audit logs, 'network' for network flow logs"),
    }),
    handler: async (input: { logType: string }) => {
      return apiGet(`/tailnet/${getTailnet()}/logging/stream/${encPath(input.logType)}`);
    },
  },
  {
    name: "tailscale_set_log_stream_config",
    description:
      "Set the log streaming configuration for a specific log type. Configures where logs are sent (e.g. Axiom, Datadog, Splunk, Elasticsearch, S3, GCS).",
    annotations: {
      title: "Set log stream config",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      logType: z
        .enum(["configuration", "network"])
        .describe("The log type: 'configuration' for audit logs, 'network' for network flow logs"),
      destinationType: z
        .string()
        .describe(
          "The destination type (e.g. 'axiom', 'datadog', 'splunk', 'elasticsearch', 'panther', 's3', 'gcs', 'cribl')",
        ),
      url: z.string().optional().describe("Destination URL (required for most destination types)"),
      token: z.string().optional().describe("Authentication token or API key for the destination"),
      user: z.string().optional().describe("Username for the destination (if required)"),
    }),
    handler: async (input: {
      logType: string;
      destinationType: string;
      url?: string;
      token?: string;
      user?: string;
    }) => {
      const { logType, ...body } = input;
      const cleanBody: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) cleanBody[key] = value;
      }
      return apiPut(`/tailnet/${getTailnet()}/logging/stream/${encPath(logType)}`, cleanBody);
    },
  },
  {
    name: "tailscale_delete_log_stream_config",
    description: "Delete a log streaming configuration. Logs will stop being sent to the configured destination.",
    annotations: {
      title: "Delete log stream config",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      logType: z
        .enum(["configuration", "network"])
        .describe("The log type to stop streaming: 'configuration' or 'network'"),
    }),
    handler: async (input: { logType: string }) => {
      return apiDelete(`/tailnet/${getTailnet()}/logging/stream/${encPath(input.logType)}`);
    },
  },
] as const;
