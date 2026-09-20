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
// nowMs is a parameter so the guard and the `end` the handler puts on the wire
// read the SAME value -- both handlers pass `Date.parse(wireEnd)`, the parsed
// form of the exact string they are about to send. With two Date reads, a
// range of exactly 30 days could pass the guard here and then exceed the cap by
// the milliseconds between them; with a millisecond-precision read against a
// second-precision wire value, a start inside the current second passed here
// and inverted on the wire.
//
// `end` stays the caller's own input so the message names `<now>` for an
// omitted one, rather than a timestamp they never typed.
function assertLogRange(start: string, end: string | undefined, label: string, nowMs: number = Date.now()): void {
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : nowMs;
  if (endMs < startMs) {
    throw new Error(`${label}: end must be >= start. start=${start} end=${end ?? "<now>"}`);
  }
  if (endMs - startMs > MAX_LOG_RANGE_MS) {
    throw new Error(
      `${label}: range exceeds the 30-day Tailscale API limit. start=${start} end=${end ?? "<now>"}. Split the query into <=30-day windows.`,
    );
  }
}

/**
 * The `end` to send when the caller omits it.
 *
 * Both logging endpoints mark `end` required in the OpenAPI spec, the KB pages
 * say "Required.", and the Go client's comment on the network-flow read says
 * "Both start and end parameters are required by the server" -- while nothing
 * upstream documents a server-side default. So fill it in rather than leave it
 * off and hope.
 *
 * Second precision, matching the Go client's `params.End.Format(time.RFC3339)`:
 * no upstream example carries a fractional second.
 *
 * Dropping the milliseconds only moves `end` EARLIER, which is why the 30-day
 * cap still clears on the wire -- but the same property inverts the end >=
 * start check when `start` lands inside the second the handler runs in ("tail
 * the audit log from now"): the guard compared a millisecond-precision `new
 * Date()` and passed, while the wire carried an `end` up to 999ms before
 * `start` and drew a terse API 400. So both handlers compute this value FIRST
 * and hand it to the guard, which measures the value that actually goes on the
 * wire rather than the instant it was derived from.
 *
 * Built from the UTC getters rather than by stripping `\.\d{3}Z$` off
 * toISOString(). The strip assumed exactly three fractional digits, and a
 * pattern that does not match is a silent no-op: on any runtime that formatted
 * a different precision the millisecond-bearing value would flow straight
 * through to the wire, where the difference between this function working and
 * not working is a terse API 400 rather than a local error. Constructing the
 * string cannot miss -- there is no pattern to fail to match -- and it is also
 * immune to the expanded-year form (`+275760-09-13T...`), which a fixed-offset
 * slice would have cut in the wrong place. For every value `new Date()` can
 * produce, the output is character-for-character what the strip produced.
 */
function isoSecond(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${pad(now.getUTCFullYear(), 4)}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}Z`
  );
}

export const auditTools = [
  {
    name: "tailscale_get_audit_log",
    description:
      "Get the tailnet audit/configuration log. Shows who changed what and when -- useful for troubleshooting and compliance. Optional actor, target and event filters narrow the query server-side, so a targeted question doesn't have to pull the whole window.",
    annotations: {
      title: "Get audit log",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    // The three filters are free strings rather than the spec's 138-value event
    // enum: that list is still growing (the PAM_* entries are recent), and a
    // hard enum would make a new event type unqueryable rather than merely
    // unvalidated. `.trim().min(1)` is the house idiom -- a bare min(1) admits
    // " ", which goes on the wire as `event=+...` and comes back empty with no
    // error.
    //
    // `.max(1)` for now. The spec declares no style/explode on these array
    // parameters, so repeated keys are inferred from the OpenAPI default and
    // nothing upstream corroborates it: neither the Go client nor Terraform
    // implements this endpoint, and the KB page documents only start and end. A
    // single value is wire-identical whether the server wants repeated keys or a
    // comma-joined list, so it cannot under-report; two values under the wrong
    // guess would return a subset with no error, which in a compliance query
    // reads as "that change never happened". Lift the cap once a live call
    // settles it.
    inputSchema: z.object({
      start: z.string().describe("Start time in RFC3339 format (e.g. '2026-04-01T00:00:00Z'). Required."),
      end: z
        .string()
        .optional()
        .describe(
          "End time in RFC3339 format. Optional: when omitted the tool sends the current time, which Tailscale's API requires.",
        ),
      actor: z
        .array(z.string().trim().min(1))
        .max(1)
        .optional()
        .describe(
          "Server-side filter: one exact actor ID, or '~text' to wildcard-match a login or display name (e.g. '~bob'). One value per call -- how the API reads a repeated filter key is not verified yet.",
        ),
      target: z
        .array(z.string().trim().min(1))
        .max(1)
        .optional()
        .describe(
          "Server-side filter: one string, matched against any part of any of an entry's targets (ID or name). One value per call, as for actor.",
        ),
      event: z
        .array(z.string().trim().min(1))
        .max(1)
        .optional()
        .describe(
          "Server-side filter: one event type from Tailscale's audit event list, e.g. 'TAILNET.UPDATE.ACL', 'TAILNET.UPDATE.DNS_CONFIG', 'NODE.CREATE', 'NODE.DELETE', 'API_KEY.CREATE', 'USER.UPDATE.USER_ROLE', 'WEBHOOK_ENDPOINT.CREATE'. Not a closed set -- the list keeps growing. One value per call, as for actor.",
        ),
    }),
    handler: async (input: { start: string; end?: string; actor?: string[]; target?: string[]; event?: string[] }) => {
      assertRFC3339(input.start, "start");
      if (input.end) assertRFC3339(input.end, "end");
      // Truthiness, not `??`: assertLogRange treats "" as <now>, and a `??` here
      // would disagree with it and put a bare `end=` on the wire.
      const wireEnd = input.end ? input.end : isoSecond(new Date());
      // The guard reads the value the request carries, not the instant it came
      // from -- see isoSecond. `input.end` is still what it reports, so an
      // omitted end is named as `<now>` rather than as a timestamp the caller
      // never typed.
      assertLogRange(input.start, input.end, "tailscale_get_audit_log", Date.parse(wireEnd));
      const params = new URLSearchParams({ start: input.start, end: wireEnd });
      for (const actor of input.actor ?? []) params.append("actor", actor);
      for (const target of input.target ?? []) params.append("target", target);
      for (const event of input.event ?? []) params.append("event", event);
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
    // The spec gives this endpoint no actor/target/event filters -- they are on
    // the configuration log only.
    inputSchema: z.object({
      start: z.string().describe("Start time in RFC3339 format (e.g. '2026-04-01T00:00:00Z'). Required."),
      end: z
        .string()
        .optional()
        .describe(
          "End time in RFC3339 format. Optional: when omitted the tool sends the current time, which Tailscale's API requires.",
        ),
    }),
    handler: async (input: { start: string; end?: string }) => {
      assertRFC3339(input.start, "start");
      if (input.end) assertRFC3339(input.end, "end");
      // Same three lines as tailscale_get_audit_log above, and deliberately not
      // shared: each handler calls the guard independently so a refactor that
      // drops one cannot leave the other's tests green.
      const wireEnd = input.end ? input.end : isoSecond(new Date());
      assertLogRange(input.start, input.end, "tailscale_get_network_flow_logs", Date.parse(wireEnd));
      const params = new URLSearchParams({ start: input.start, end: wireEnd });
      return apiGet(`/tailnet/${getTailnet()}/logging/network?${params}`);
    },
  },
] as const;
