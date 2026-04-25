import { z } from "zod";
import { apiDelete, apiGet, apiPost, apiPut, encPath, getTailnet } from "../api.js";

export const logStreamingTools = [
  {
    name: "tailscale_list_log_stream_configs",
    description:
      "List all log streaming configurations for your tailnet. Fetches both 'configuration' (audit) and 'network' (flow) log stream configs. Log streaming sends logs to external destinations like Axiom, Datadog, Splunk, Elasticsearch, or S3.",
    annotations: {
      title: "List log stream configs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      const [configuration, network] = await Promise.all([
        apiGet(`/tailnet/${getTailnet()}/logging/configuration/stream`),
        apiGet(`/tailnet/${getTailnet()}/logging/network/stream`),
      ]);
      const errors: Record<string, string> = {};
      if (!configuration.ok) errors.configuration = configuration.error ?? `HTTP ${configuration.status}`;
      if (!network.ok) errors.network = network.error ?? `HTTP ${network.status}`;
      if (!configuration.ok && !network.ok) {
        return {
          ok: false,
          status: configuration.status || network.status || 500,
          error: `Both log streams failed: ${JSON.stringify(errors)}`,
        };
      }
      const data: Record<string, unknown> = {
        configuration: configuration.ok ? configuration.data : null,
        network: network.ok ? network.data : null,
      };
      if (Object.keys(errors).length > 0) data.errors = errors;
      return { ok: true, status: 200, data };
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
    handler: async (input: { logType: "configuration" | "network" }) => {
      return apiGet(`/tailnet/${getTailnet()}/logging/${encPath(input.logType)}/stream`);
    },
  },
  {
    name: "tailscale_set_log_stream_config",
    description:
      "Set the log streaming configuration for a specific log type. Configures where logs are sent (e.g. Axiom, Datadog, Splunk, Elasticsearch, S3).\n\n" +
      "Per-destination required fields:\n" +
      "- splunk / elastic / panther / cribl / datadog / axiom: url + token (user optional)\n" +
      "- s3: s3Bucket + s3Region + s3AuthenticationType, plus either (s3AccessKeyId + s3SecretAccessKey) for 'accesskey' auth or s3RoleArn for 'rolearn' auth. Call tailscale_create_aws_external_id first when using 'rolearn'.",
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
        .enum(["splunk", "elastic", "panther", "cribl", "datadog", "axiom", "s3"])
        .describe("The log streaming destination type"),
      url: z.string().optional().describe("Destination URL (required for non-s3 destinations)"),
      token: z.string().optional().describe("Authentication token or API key for the destination"),
      user: z.string().optional().describe("Username for the destination (if required)"),
      uploadPeriodMinutes: z
        .number()
        .int()
        .positive()
        .max(1440)
        .optional()
        .describe("Minutes to wait between uploads (1-1440). Optional."),
      compressionFormat: z
        .enum(["zstd", "gzip", "none"])
        .optional()
        .describe("Compression algorithm for log uploads. Defaults to 'none'."),
      s3Bucket: z.string().optional().describe("(s3 only) S3 bucket name. Required when destinationType is 's3'."),
      s3Region: z
        .string()
        .optional()
        .describe("(s3 only) AWS region of the S3 bucket. Required when destinationType is 's3'."),
      s3KeyPrefix: z
        .string()
        .optional()
        .describe("(s3 only) Optional prefix prepended to the auto-generated S3 object key."),
      s3AuthenticationType: z
        .enum(["accesskey", "rolearn"])
        .optional()
        .describe(
          "(s3 only) Authentication mode. Required when destinationType is 's3'. Tailscale recommends 'rolearn'.",
        ),
      s3AccessKeyId: z
        .string()
        .optional()
        .describe("(s3 only) AWS access key id. Required when s3AuthenticationType is 'accesskey'."),
      s3SecretAccessKey: z
        .string()
        .optional()
        .describe("(s3 only) AWS secret access key. Required when s3AuthenticationType is 'accesskey'."),
      s3RoleArn: z
        .string()
        .optional()
        .describe(
          "(s3 only) IAM role ARN that Tailscale will assume. Required when s3AuthenticationType is 'rolearn'.",
        ),
    }),
    handler: async (input: {
      logType: "configuration" | "network";
      destinationType: "splunk" | "elastic" | "panther" | "cribl" | "datadog" | "axiom" | "s3";
      url?: string;
      token?: string;
      user?: string;
      uploadPeriodMinutes?: number;
      compressionFormat?: "zstd" | "gzip" | "none";
      s3Bucket?: string;
      s3Region?: string;
      s3KeyPrefix?: string;
      s3AuthenticationType?: "accesskey" | "rolearn";
      s3AccessKeyId?: string;
      s3SecretAccessKey?: string;
      s3RoleArn?: string;
    }) => {
      // Cross-field validation: Tailscale's API returns terse 400s on missing
      // per-destination fields. Pre-checking gives the agent an actionable error.
      if (input.destinationType === "s3") {
        const missing: string[] = [];
        if (!input.s3Bucket) missing.push("s3Bucket");
        if (!input.s3Region) missing.push("s3Region");
        if (!input.s3AuthenticationType) missing.push("s3AuthenticationType");
        if (input.s3AuthenticationType === "accesskey") {
          if (!input.s3AccessKeyId) missing.push("s3AccessKeyId");
          if (!input.s3SecretAccessKey) missing.push("s3SecretAccessKey");
        } else if (input.s3AuthenticationType === "rolearn") {
          if (!input.s3RoleArn) missing.push("s3RoleArn");
        }
        if (missing.length > 0) {
          throw new Error(
            `destinationType 's3' requires: ${missing.join(", ")}. For 'rolearn' auth, call tailscale_create_aws_external_id first to get the external ID for your IAM role trust policy.`,
          );
        }
      } else {
        // splunk / elastic / panther / cribl / datadog / axiom all need url + token.
        const missing: string[] = [];
        if (!input.url) missing.push("url");
        if (!input.token) missing.push("token");
        if (missing.length > 0) {
          throw new Error(`destinationType '${input.destinationType}' requires: ${missing.join(", ")}.`);
        }
      }

      const { logType, ...body } = input;
      const cleanBody: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) cleanBody[key] = value;
      }
      return apiPut(`/tailnet/${getTailnet()}/logging/${encPath(logType)}/stream`, cleanBody);
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
    handler: async (input: { logType: "configuration" | "network" }) => {
      return apiDelete(`/tailnet/${getTailnet()}/logging/${encPath(input.logType)}/stream`);
    },
  },
  {
    name: "tailscale_get_log_stream_status",
    description:
      "Get the status of log streaming for a specific log type. Shows whether logs are being delivered successfully.",
    annotations: {
      title: "Get log stream status",
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
    handler: async (input: { logType: "configuration" | "network" }) => {
      return apiGet(`/tailnet/${getTailnet()}/logging/${encPath(input.logType)}/stream/status`);
    },
  },
  {
    name: "tailscale_create_aws_external_id",
    description:
      "Create or get an AWS external ID for your tailnet. Used when configuring log streaming to S3 — the external ID is included in the IAM role trust policy.",
    annotations: {
      title: "Create AWS external ID",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiPost(`/tailnet/${getTailnet()}/aws-external-id`);
    },
  },
  {
    name: "tailscale_validate_aws_trust_policy",
    description:
      "Validate that an AWS IAM role trust policy is correctly configured with the Tailscale external ID. Use this after setting up the IAM role for S3 log streaming.",
    annotations: {
      title: "Validate AWS trust policy",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      externalId: z.string().describe("The AWS external ID to validate"),
      roleArn: z.string().describe("The AWS IAM role ARN to validate against"),
    }),
    handler: async (input: { externalId: string; roleArn: string }) => {
      return apiPost(
        `/tailnet/${getTailnet()}/aws-external-id/${encPath(input.externalId)}/validate-aws-trust-policy`,
        { roleArn: input.roleArn },
      );
    },
  },
] as const;
