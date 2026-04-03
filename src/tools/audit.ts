import { z } from "zod";
import { apiGet, getTailnet } from "../api.js";

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
      const params = new URLSearchParams({ start: input.start });
      if (input.end) params.set("end", input.end);
      return apiGet(
        `/tailnet/${getTailnet()}/logging/configuration?${params}`
      );
    },
  },
] as const;
