import { z } from "zod";
import { apiGet, getTailnet } from "../api.js";

/**
 * Validate that a string is a valid RFC3339 date-time.
 *
 * Requires full shape: date 'T' time, optional fractional seconds, and a timezone
 * designator (Z or +hh:mm / -hh:mm). We also cross-check with Date.parse so malformed
 * but regex-passing strings (e.g. month=13) still fail client-side rather than at
 * the Tailscale API.
 */
function assertRFC3339(value: string, label: string): void {
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  if (!rfc3339.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be a valid RFC3339 date-time (e.g. '2026-04-01T00:00:00Z'), got: '${value}'`);
  }
}

export const auditTools = [
  {
    name: "tailscale_get_audit_log",
    description:
      "Get the tailnet audit/configuration log. Shows who changed what and when — useful for troubleshooting and compliance.",
    annotations: {
      title: "Get audit log",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      start: z.string().describe("Start time in RFC3339 format (e.g. '2026-04-01T00:00:00Z'). Required."),
      end: z.string().optional().describe("End time in RFC3339 format. Defaults to now."),
    }),
    handler: async (input: { start: string; end?: string }) => {
      assertRFC3339(input.start, "start");
      if (input.end) assertRFC3339(input.end, "end");
      const params = new URLSearchParams({ start: input.start });
      if (input.end) params.set("end", input.end);
      return apiGet(`/tailnet/${getTailnet()}/logging/configuration?${params}`);
    },
  },
  {
    name: "tailscale_get_network_flow_logs",
    description:
      "Get network traffic flow logs showing connections between devices. Shows source/destination nodes, timestamps, and traffic metadata — useful for security monitoring and debugging connectivity.",
    annotations: {
      title: "Get network flow logs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      start: z.string().describe("Start time in RFC3339 format (e.g. '2026-04-01T00:00:00Z'). Required."),
      end: z.string().optional().describe("End time in RFC3339 format. Defaults to now."),
    }),
    handler: async (input: { start: string; end?: string }) => {
      assertRFC3339(input.start, "start");
      if (input.end) assertRFC3339(input.end, "end");
      const params = new URLSearchParams({ start: input.start });
      if (input.end) params.set("end", input.end);
      return apiGet(`/tailnet/${getTailnet()}/logging/network?${params}`);
    },
  },
] as const;
