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
      "Get this machine's view of its tailnet -- own connection state, peers it can see, DERP region, MagicDNS suffix, etc. Shells out to the local `tailscale` binary; distinct from `tailscale_status`, which queries the admin API for tailnet-wide info. Requires the tailscale CLI installed locally and TAILSCALE_LOCAL_CLI=1.",
    annotations: {
      title: "Local tailscale status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => runTailscaleCli(["status", "--json"], { parseJson: true }),
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
          "Number of ping attempts (default 1, max 20). Higher counts give a better latency picture but block the tool call for longer.",
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
] as const;
