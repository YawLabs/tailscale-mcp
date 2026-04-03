import { z } from "zod";
import { apiGet, apiPost, getTailnet } from "../api.js";

export const dnsTools = [
  {
    name: "tailscale_get_nameservers",
    description: "Get the DNS nameservers configured for your tailnet.",
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/dns/nameservers`);
    },
  },
  {
    name: "tailscale_set_nameservers",
    description: "Set the DNS nameservers for your tailnet.",
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
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/dns/searchpaths`);
    },
  },
  {
    name: "tailscale_set_search_paths",
    description: "Set the DNS search paths for your tailnet.",
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
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/dns/split-dns`);
    },
  },
  {
    name: "tailscale_set_split_dns",
    description: "Set split DNS configuration. Maps domains to specific nameservers.",
    inputSchema: z.object({
      splitDns: z
        .record(z.string(), z.array(z.string()))
        .describe(
          "Map of domain to nameserver list (e.g. { \"corp.example.com\": [\"10.0.0.1\"], \"internal.dev\": [\"10.0.0.2\"] })"
        ),
    }),
    handler: async (input: { splitDns: Record<string, string[]> }) => {
      return apiPost(`/tailnet/${getTailnet()}/dns/split-dns`, input.splitDns);
    },
  },
  {
    name: "tailscale_get_dns_preferences",
    description: "Get DNS preferences for your tailnet, including whether MagicDNS is enabled.",
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/dns/preferences`);
    },
  },
  {
    name: "tailscale_set_dns_preferences",
    description: "Set DNS preferences for your tailnet, such as enabling or disabling MagicDNS.",
    inputSchema: z.object({
      magicDNS: z.boolean().describe("Whether to enable MagicDNS"),
    }),
    handler: async (input: { magicDNS: boolean }) => {
      return apiPost(`/tailnet/${getTailnet()}/dns/preferences`, {
        magicDNS: input.magicDNS,
      });
    },
  },
] as const;
