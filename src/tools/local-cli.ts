import * as net from "node:net";
import { z } from "zod";
import { runTailscaleCli } from "../local-cli.js";

// Validate a ping target client-side: hostname, IP, or MagicDNS name. The
// CLI is invoked via execFile (array-form args, no shell) so the validation
// is defense-in-depth -- but a clear server-side error message beats a
// confusing CLI exit, and rejecting malformed labels (leading hyphen,
// consecutive dots, empty labels) at the schema layer surfaces user mistakes
// faster than waiting for tailscale CLI to complain.
const HOSTNAME_LABEL = /^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/;

function isValidPingTarget(s: string): boolean {
  if (s.length === 0 || s.length > 253) return false;
  if (net.isIP(s)) return true;
  // Per-label rules: 1-63 chars, alphanumeric at start and end, hyphens or
  // underscores allowed in the middle. RFC 1123 strict on hyphens; we allow
  // underscores in the middle because MagicDNS occasionally uses them, but
  // a label of just `_` is never valid.
  const labels = s.split(".");
  return labels.every((label) => label.length >= 1 && label.length <= 63 && HOSTNAME_LABEL.test(label));
}

export const localCliTools = [
  {
    name: "tailscale_local_status",
    description:
      "Get this machine's view of its tailnet -- own connection state, peers it can see, DERP region, MagicDNS suffix, etc. Shells out to the local `tailscale` binary; distinct from `tailscale_status`, which queries the admin API for tailnet-wide info. Read a peer's path in decision order: direct when `CurAddr` is set, peer-relayed when `PeerRelay` is set, otherwise DERP via the region named in `Relay`. `Relay` is the peer's home DERP region and is populated either way, so a non-empty `Relay` on its own does not mean the traffic is relayed. The `Peer` map is what makes this response scale with the tailnet rather than with the request; `peers` and `activeOnly` narrow it. Requires the tailscale CLI installed locally and TAILSCALE_LOCAL_CLI=1.",
    annotations: {
      title: "Local tailscale status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      peers: z
        .boolean()
        .optional()
        .describe(
          "Set false to omit the `Peer` map (`--peers=false`), leaving this node's own state -- `Self`, `BackendState`, `Health`, `CurrentTailnet` and the rest of the top level. Omit it for the CLI's default, which includes peers.",
        ),
      activeOnly: z
        .boolean()
        .optional()
        .describe(
          "Set true to keep only peers with an active session (`--active`) -- upstream defines that as a packet sent to the peer in roughly the last two minutes. Omit it to get every peer.",
        ),
    }),
    handler: async (input: { peers?: boolean; activeOnly?: boolean } = {}) => {
      // Both flags apply in JSON mode: --peers=false swaps in the peerless
      // status call BEFORE the JSON branch, and --active deletes the inactive
      // peers inside it. --self is applied in text mode only, and --web /
      // --listen / --browser start a server, so none of those are exposed.
      // The `=` form is required -- Go's flag package does not read a separate
      // value for a boolean. The default parameter keeps a bare call (no input
      // object at all) producing the argv this tool has always sent.
      const args = ["status", "--json"];
      if (input.peers === false) args.push("--peers=false");
      if (input.activeOnly) args.push("--active");
      const result = await runTailscaleCli(args, { parseJson: true });
      // The runner's overflow message ends "narrow the query if the command
      // supports it". This one supports it, so name the inputs that do it
      // rather than leaving the caller to go find them.
      if (!result.ok && result.error?.includes("output limit")) {
        return { ...result, error: `${result.error} Retry with peers:false or activeOnly:true.` };
      }
      // A timeout gets the peers-only half. `--peers=false` swaps in the
      // peerless status call before any peer is serialized, so it cuts the work
      // as well as the output; `--active` filters peers that are already in
      // hand, so it cannot make a slow call finish. Naming both here would be
      // advice that half cannot help.
      if (!result.ok && result.error?.includes("timed out after")) {
        return {
          ...result,
          error: `${result.error}. On a large tailnet this is usually the peer map -- retry with peers:false.`,
        };
      }
      return result;
    },
  },
  {
    name: "tailscale_ping",
    description:
      "Probe latency to another tailnet node from this machine. Useful for connectivity debugging -- shows whether the path is direct or DERP-relayed, plus RTT. Returns the CLI's text output verbatim.",
    annotations: {
      title: "Tailscale ping",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      target: z
        .string()
        .describe(
          "Target hostname, IP, or MagicDNS name (e.g. 'my-laptop', '100.64.0.1', 'my-laptop.tail-scale.ts.net')",
        ),
      count: z
        .number()
        .int()
        .positive()
        .max(20)
        .optional()
        .describe(
          "Number of ping attempts (max 20). If omitted, no -c flag is passed and the tailscale CLI uses its built-in default (retries until a direct path is found, typically <10 attempts). Higher explicit counts give a more complete latency picture but block the tool call for longer.",
        ),
    }),
    handler: async (input: { target: string; count?: number }) => {
      if (!isValidPingTarget(input.target)) {
        throw new Error(
          `Invalid ping target ${JSON.stringify(input.target)}: must be a hostname, IP, or MagicDNS name (letters, digits, dots, hyphens, underscores; max 253 chars).`,
        );
      }
      const args = ["ping"];
      if (input.count !== undefined) args.push("-c", String(input.count));
      args.push(input.target);
      return runTailscaleCli(args);
    },
  },
  {
    name: "tailscale_netcheck",
    description:
      "Run Tailscale's network connectivity diagnostics from this machine: NAT type, DERP region latency map, IPv4/IPv6 support, UPnP/PMP/PCP status. Equivalent to `tailscale netcheck --format=json`. Useful when an agent reports flaky connectivity and you want to know whether to point fingers at the NAT, the upstream, or DERP.",
    annotations: {
      title: "Tailscale netcheck",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => runTailscaleCli(["netcheck", "--format=json"], { parseJson: true }),
  },
  {
    name: "tailscale_local_version",
    description:
      "Get the version of the local `tailscale` binary. Different from the control plane / admin API version. Use this when filing a bug to report the client version actually in use.",
    annotations: {
      title: "Tailscale CLI version",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => runTailscaleCli(["version"]),
  },
  // The two tools below need a tailscale client >= 1.102.1 (both subcommands
  // landed in that release). On an older binary the CLI exits non-zero with
  // "unknown subcommand", which runTailscaleCli surfaces verbatim as the error
  // -- an accurate, self-explaining failure, so there is no version pre-check
  // here. Deliberately NOT passing --json: neither subcommand's flag support is
  // verified across versions, and an unsupported flag would turn a working text
  // response into a hard failure. Text output is the safe contract.
  {
    name: "tailscale_local_whoami",
    description:
      "Show which Tailscale user and device this machine is currently authenticated as. Useful for confirming an agent host is enrolled under the identity you expect before trusting its access. Requires tailscale >= 1.102.1; returns the CLI's text output verbatim.",
    annotations: {
      title: "Tailscale whoami",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => runTailscaleCli(["whoami"]),
  },
  {
    name: "tailscale_local_service_list",
    description:
      "List the Tailscale Services visible to THIS node. Complements the admin-side service tools (tailscale_list_services etc.), which report what the tailnet has configured -- this reports what this machine can actually see and reach, which is the difference that matters when debugging a service that 'exists' but is unreachable. Requires tailscale >= 1.102.1; returns the CLI's text output verbatim.",
    annotations: {
      title: "Tailscale service list (local)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => runTailscaleCli(["service", "list"]),
  },
] as const;
