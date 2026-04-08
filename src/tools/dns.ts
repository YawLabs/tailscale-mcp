import { z } from "zod";
import { apiGet, apiPatch, apiPost, apiPut, getTailnet } from "../api.js";

export const dnsTools = [
  {
    name: "tailscale_get_nameservers",
    description: "Get the DNS nameservers configured for your tailnet.",
    annotations: {
      title: "Get nameservers",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/dns/nameservers`);
    },
  },
  {
    name: "tailscale_set_nameservers",
    description: "Set the DNS nameservers for your tailnet. Replaces all existing nameservers.",
    annotations: {
      title: "Set nameservers",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      dns: z.array(z.string()).describe("List of DNS server IP addresses (e.g. ['8.8.8.8', '1.1.1.1'])"),
    }),
    handler: async (input: { dns: string[] }) => {
      return apiPost(`/tailnet/${getTailnet()}/dns/nameservers`, { dns: input.dns });
    },
  },
  {
    name: "tailscale_get_search_paths",
    description: "Get the DNS search paths configured for your tailnet.",
    annotations: {
      title: "Get DNS search paths",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/dns/searchpaths`);
    },
  },
  {
    name: "tailscale_set_search_paths",
    description: "Set the DNS search paths for your tailnet. Replaces all existing search paths.",
    annotations: {
      title: "Set DNS search paths",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      searchPaths: z.array(z.string()).describe("List of DNS search domains (e.g. ['example.com', 'internal.corp'])"),
    }),
    handler: async (input: { searchPaths: string[] }) => {
      return apiPost(`/tailnet/${getTailnet()}/dns/searchpaths`, {
        searchPaths: input.searchPaths,
      });
    },
  },
  {
    name: "tailscale_get_split_dns",
    description: "Get the split DNS configuration for your tailnet.",
    annotations: {
      title: "Get split DNS",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/dns/split-dns`);
    },
  },
  {
    name: "tailscale_set_split_dns",
    description:
      "Set split DNS configuration. Maps domains to specific nameservers. Replaces the entire split DNS configuration.",
    annotations: {
      title: "Set split DNS",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      splitDns: z
        .record(z.string(), z.array(z.string()))
        .describe(
          'Map of domain to nameserver list (e.g. { "corp.example.com": ["10.0.0.1"], "internal.dev": ["10.0.0.2"] })',
        ),
    }),
    handler: async (input: { splitDns: Record<string, string[]> }) => {
      return apiPut(`/tailnet/${getTailnet()}/dns/split-dns`, input.splitDns);
    },
  },
  {
    name: "tailscale_get_dns_preferences",
    description: "Get DNS preferences for your tailnet, including whether MagicDNS is enabled.",
    annotations: {
      title: "Get DNS preferences",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/dns/preferences`);
    },
  },
  {
    name: "tailscale_set_dns_preferences",
    description: "Set DNS preferences for your tailnet, such as enabling or disabling MagicDNS.",
    annotations: {
      title: "Set DNS preferences",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      magicDNS: z.boolean().describe("Whether to enable MagicDNS"),
    }),
    handler: async (input: { magicDNS: boolean }) => {
      return apiPost(`/tailnet/${getTailnet()}/dns/preferences`, {
        magicDNS: input.magicDNS,
      });
    },
  },
  {
    name: "tailscale_update_split_dns",
    description:
      "Partially update split DNS configuration. Merges the provided domains with the existing config — only the specified domains are changed, others are untouched. Set a domain's nameservers to an empty array to remove it.",
    annotations: {
      title: "Update split DNS (partial)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      splitDns: z
        .record(z.string(), z.array(z.string()))
        .describe(
          'Map of domain to nameserver list to merge (e.g. { "new.example.com": ["10.0.0.3"] }). Only specified domains are changed.',
        ),
    }),
    handler: async (input: { splitDns: Record<string, string[]> }) => {
      return apiPatch(`/tailnet/${getTailnet()}/dns/split-dns`, input.splitDns);
    },
  },
  {
    name: "tailscale_get_dns_configuration",
    description:
      "Get the unified DNS configuration for your tailnet, including nameservers, search paths, split DNS, and MagicDNS preference in a single call.",
    annotations: {
      title: "Get DNS configuration (unified)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/dns/configuration`);
    },
  },
  {
    name: "tailscale_set_dns_configuration",
    description:
      "Set the unified DNS configuration for your tailnet in a single call. Replaces all DNS settings (nameservers, search paths, split DNS, MagicDNS preference).",
    annotations: {
      title: "Set DNS configuration (unified)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      dns: z.array(z.string()).optional().describe("List of DNS server IP addresses"),
      searchPaths: z.array(z.string()).optional().describe("List of DNS search domains"),
      splitDns: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe("Map of domain to nameserver list for split DNS"),
      magicDNS: z.boolean().optional().describe("Whether to enable MagicDNS"),
    }),
    handler: async (input: {
      dns?: string[];
      searchPaths?: string[];
      splitDns?: Record<string, string[]>;
      magicDNS?: boolean;
    }) => {
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) body[key] = value;
      }
      return apiPost(`/tailnet/${getTailnet()}/dns/configuration`, body);
    },
  },
] as const;
