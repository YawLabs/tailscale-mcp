import { z } from "zod";
import { apiGet, apiPost, apiDelete, getTailnet, encPath } from "../api.js";

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
      return apiGet(`/device/${encPath(input.deviceId)}`);
    },
  },
  {
    name: "tailscale_authorize_device",
    description: "Authorize a device that is pending authorization.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID to authorize"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiPost(`/device/${encPath(input.deviceId)}/authorized`, { authorized: true });
    },
  },
  {
    name: "tailscale_deauthorize_device",
    description: "Deauthorize a device, immediately removing its access to the tailnet. The device will need to be re-authorized to reconnect.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID to deauthorize"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiPost(`/device/${encPath(input.deviceId)}/authorized`, { authorized: false });
    },
  },
  {
    name: "tailscale_delete_device",
    description: "Permanently remove a device from the tailnet. This is irreversible — the device must re-authenticate to rejoin.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID to delete"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiDelete(`/device/${encPath(input.deviceId)}`);
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
      return apiPost(`/device/${encPath(input.deviceId)}/name`, { name: input.name });
    },
  },
  {
    name: "tailscale_expire_device",
    description: "Expire a device's key, forcing it to re-authenticate.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID to expire"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiPost(`/device/${encPath(input.deviceId)}/expire`);
    },
  },
  {
    name: "tailscale_get_device_routes",
    description: "Get the subnet routes a device advertises and which are enabled.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiGet(`/device/${encPath(input.deviceId)}/routes`);
    },
  },
  {
    name: "tailscale_set_device_routes",
    description: "Set the enabled subnet routes for a device. Replaces all currently enabled routes — pass the full list of routes you want enabled.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      routes: z.array(z.string()).describe("Full list of CIDR routes to enable (e.g. ['10.0.0.0/24', '192.168.1.0/24']). Replaces existing enabled routes."),
    }),
    handler: async (input: { deviceId: string; routes: string[] }) => {
      return apiPost(`/device/${encPath(input.deviceId)}/routes`, { routes: input.routes });
    },
  },
  {
    name: "tailscale_get_device_posture_attributes",
    description: "Get all posture attributes for a device, including custom and system-managed attributes.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiGet(`/device/${encPath(input.deviceId)}/attributes`);
    },
  },
  {
    name: "tailscale_set_device_posture_attribute",
    description: "Set a custom posture attribute on a device. Creates or updates the attribute. Attribute keys must start with 'custom:'. Useful for compliance tracking, JIT access, and custom security policies.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      attributeKey: z.string().describe("The attribute key (must start with 'custom:', e.g. 'custom:lastAuditDate')"),
      value: z.string().describe("The attribute value"),
      expiry: z.string().optional().describe("Optional expiry time in RFC3339 format (e.g. '2026-12-01T00:00:00Z'). Attribute is automatically removed after expiry."),
    }),
    handler: async (input: { deviceId: string; attributeKey: string; value: string; expiry?: string }) => {
      const body: Record<string, unknown> = { value: input.value };
      if (input.expiry !== undefined) body.expiry = input.expiry;
      return apiPost(`/device/${encPath(input.deviceId)}/attributes/${encPath(input.attributeKey)}`, body);
    },
  },
  {
    name: "tailscale_delete_device_posture_attribute",
    description: "Delete a custom posture attribute from a device. This is irreversible.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      attributeKey: z.string().describe("The attribute key to delete (e.g. 'custom:lastAuditDate')"),
    }),
    handler: async (input: { deviceId: string; attributeKey: string }) => {
      return apiDelete(`/device/${encPath(input.deviceId)}/attributes/${encPath(input.attributeKey)}`);
    },
  },
  {
    name: "tailscale_set_device_tags",
    description: "Set ACL tags on a device. Replaces all existing tags — pass the full list of tags you want applied.",
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      tags: z.array(z.string()).describe("Full list of ACL tags (e.g. ['tag:server', 'tag:production']). Replaces all existing tags."),
    }),
    handler: async (input: { deviceId: string; tags: string[] }) => {
      return apiPost(`/device/${encPath(input.deviceId)}/tags`, { tags: input.tags });
    },
  },
] as const;
