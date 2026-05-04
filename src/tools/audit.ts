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
  const err = () =>
    new Error(`${label} must be a valid RFC3339 date-time (e.g. '2026-04-01T00:00:00Z'), got: '${value}'`);
  if (!rfc3339.test(value) || Number.isNaN(Date.parse(value))) {
    throw err();
  }
  // Date.parse silently coerces calendar-impossible dates (Feb 29 in non-leap years,
  // Apr 31, etc.) into the next valid day. Round-trip the literal date segment
  // and compare against the input's stated y/m/d so coercion is caught.
  //
  // Use the input's date text (slice 0..10) rather than the parsed Date's UTC
  // components so that values with non-UTC offsets (e.g. '...T00:00:00-05:00',
  // which parses to the previous UTC day) still validate against their stated
  // calendar date.
  //
  // Construct the round-trip Date from a string, NOT Date.UTC(y, m-1, d):
  // Date.UTC has a legacy quirk where 0..99 maps to 1900+y, which would
  // wrongly reject valid RFC3339 dates with small 4-digit years (e.g. '0099').
  const dateOnly = value.slice(0, 10);
  const [y, m, d] = dateOnly.split("-").map(Number);
  const utc = new Date(`${dateOnly}T00:00:00Z`);
  if (
    Number.isNaN(utc.getTime()) ||
    utc.getUTCFullYear() !== y ||
    utc.getUTCMonth() + 1 !== m ||
    utc.getUTCDate() !== d
  ) {
    throw err();
  }
}

// Tailscale's logging endpoints cap a single query at 30 days; pre-check so the
// agent gets a clear local error instead of a terse API 400.
const MAX_LOG_RANGE_MS = 30 * 24 * 60 * 60 * 1000;
function assertLogRange(start: string, end: string | undefined, label: string): void {
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : Date.now();
  if (endMs < startMs) {
    throw new Error(`${label}: end must be >= start. start=${start} end=${end ?? "<now>"}`);
  }
  if (endMs - startMs > MAX_LOG_RANGE_MS) {
    throw new Error(
      `${label}: range exceeds the 30-day Tailscale API limit. start=${start} end=${end ?? "<now>"}. Split the query into <=30-day windows.`,
    );
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
      assertLogRange(input.start, input.end, "tailscale_get_audit_log");
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
      assertLogRange(input.start, input.end, "tailscale_get_network_flow_logs");
      const params = new URLSearchParams({ start: input.start });
      if (input.end) params.set("end", input.end);
      return apiGet(`/tailnet/${getTailnet()}/logging/network?${params}`);
    },
  },
] as const;
