import { z } from "zod";
import { apiGet, getTailnet } from "../api.js";

/** Validate that a string is a valid RFC3339 date-time. */
function assertRFC3339(value: string, label: string): void {
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new Error(`${label} must be a valid RFC3339 date-time (e.g. '2026-04-01T00:00:00Z'), got: '${value}'`);
  }
}

export const auditTools = [
  {
    name: "tailscale_get_audit_log",
    description:
      "Get the tailnet audit/configuration log. Shows who changed what and when — useful for troubleshooting and compliance.",
    inputSchema: z.object({
      start: z
        .string()
        .describe("Start time in RFC3339 format (e.g. '2026-04-01T00:00:00Z'). Required."),
      end: z
        .string()
        .optional()
        .describe("End time in RFC3339 format. Defaults to now."),
    }),
    handler: async (input: { start: string; end?: string }) => {
      assertRFC3339(input.start, "start");
      if (input.end) assertRFC3339(input.end, "end");
      const params = new URLSearchParams({ start: input.start });
      if (input.end) params.set("end", input.end);
      return apiGet(
        `/tailnet/${getTailnet()}/logging/configuration?${params}`
      );
    },
  },
  {
    name: "tailscale_get_network_flow_logs",
    description:
      "Get network traffic flow logs showing connections between devices. Shows source/destination nodes, timestamps, and traffic metadata — useful for security monitoring and debugging connectivity.",
    inputSchema: z.object({
      start: z
        .string()
        .describe("Start time in RFC3339 format (e.g. '2026-04-01T00:00:00Z'). Required."),
      end: z
        .string()
        .optional()
        .describe("End time in RFC3339 format. Defaults to now."),
    }),
    handler: async (input: { start: string; end?: string }) => {
      assertRFC3339(input.start, "start");
      if (input.end) assertRFC3339(input.end, "end");
      const params = new URLSearchParams({ start: input.start });
      if (input.end) params.set("end", input.end);
      return apiGet(
        `/tailnet/${getTailnet()}/logging/network?${params}`
      );
    },
  },
] as const;
