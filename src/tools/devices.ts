import { z } from "zod";
import { apiGet, apiPost, apiDelete, getTailnet } from "../api.js";

export const deviceTools = [
  {
    name: "tailscale_list_devices",
    description: "List all devices in your tailnet with their status, IP addresses, OS, and last seen time.",
    inputSchema: z.object({
      fields: z
        .string()
        .optional()
        .describe(
          "Comma-separated list of fields to include. Omit for all fields. Valid fields: addresses, advertisedRoutes, authorized, blocksIncomingConnections, clientConnectivity, clientVersion, connectedToControl, created, distro, enabledRoutes, expires, hostname, id, isExternal, keyExpiryDisabled, lastSeen, machineKey, name, nodeId, nodeKey, os, sshEnabled, tags, tailnetLockError, tailnetLockKey, updateAvailable, user. Use 'all' for every field."
        ),
    }),
    handler: async (input: { fields?: string }) => {
      const params = input.fields ? `?fields=${encodeURIComponent(input.fields)}` : "";
      return apiGet(`/tailnet/${getTailnet()}/devices${params}`);
    },
  },
  {
    name: "tailscale_get_device",
    description: "Get detailed information about a specific device by its ID.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID (numeric or nodekey format)"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiGet(`/device/${input.deviceId}`);
    },
  },
  {
    name: "tailscale_authorize_device",
    description: "Authorize a device that is pending authorization.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID to authorize"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiPost(`/device/${input.deviceId}/authorized`, { authorized: true });
    },
  },
  {
    name: "tailscale_deauthorize_device",
    description: "Deauthorize a device, immediately removing its access to the tailnet. The device will need to be re-authorized to reconnect.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID to deauthorize"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiPost(`/device/${input.deviceId}/authorized`, { authorized: false });
    },
  },
  {
    name: "tailscale_delete_device",
    description: "Permanently remove a device from the tailnet. This is irreversible — the device must re-authenticate to rejoin.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID to delete"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiDelete(`/device/${input.deviceId}`);
    },
  },
  {
    name: "tailscale_rename_device",
    description: "Set the name of a device in the tailnet.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID to rename"),
      name: z.string().describe("The new name for the device (FQDN within your tailnet)"),
    }),
    handler: async (input: { deviceId: string; name: string }) => {
      return apiPost(`/device/${input.deviceId}/name`, { name: input.name });
    },
  },
  {
    name: "tailscale_expire_device",
    description: "Expire a device's key, forcing it to re-authenticate.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID to expire"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiPost(`/device/${input.deviceId}/expire`);
    },
  },
  {
    name: "tailscale_get_device_routes",
    description: "Get the subnet routes a device advertises and which are enabled.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiGet(`/device/${input.deviceId}/routes`);
    },
  },
  {
    name: "tailscale_set_device_routes",
    description: "Enable or disable subnet routes for a device.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      routes: z.array(z.string()).describe("List of CIDR routes to enable (e.g. ['10.0.0.0/24', '192.168.1.0/24'])"),
    }),
    handler: async (input: { deviceId: string; routes: string[] }) => {
      return apiPost(`/device/${input.deviceId}/routes`, { routes: input.routes });
    },
  },
  {
    name: "tailscale_set_device_tags",
    description: "Set ACL tags on a device. Replaces all existing tags.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      tags: z.array(z.string()).describe("List of ACL tags (e.g. ['tag:server', 'tag:production'])"),
    }),
    handler: async (input: { deviceId: string; tags: string[] }) => {
      return apiPost(`/device/${input.deviceId}/tags`, { tags: input.tags });
    },
  },
] as const;
