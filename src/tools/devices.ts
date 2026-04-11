import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, encPath, getTailnet } from "../api.js";

export const deviceTools = [
  {
    name: "tailscale_list_devices",
    description: "List all devices in your tailnet with their status, IP addresses, OS, and last seen time.",
    annotations: {
      title: "List devices",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      fields: z
        .string()
        .optional()
        .describe(
          "Comma-separated list of fields to include. Omit for all fields. Valid fields: addresses, advertisedRoutes, authorized, blocksIncomingConnections, clientConnectivity, clientVersion, connectedToControl, created, distro, enabledRoutes, expires, hostname, id, isExternal, keyExpiryDisabled, lastSeen, machineKey, name, nodeId, nodeKey, os, sshEnabled, tags, tailnetLockError, tailnetLockKey, updateAvailable, user. Use 'all' for every field.",
        ),
      filters: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Server-side filters as key-value pairs. Filter by any top-level device property (e.g. { isEphemeral: 'true', os: 'linux', tags: 'tag:prod' }). Multiple filters are ANDed together.",
        ),
    }),
    handler: async (input: { fields?: string; filters?: Record<string, string> }) => {
      const params = new URLSearchParams();
      if (input.fields) params.set("fields", input.fields);
      if (input.filters) {
        for (const [key, value] of Object.entries(input.filters)) {
          params.set(key, value);
        }
      }
      const qs = params.toString();
      return apiGet(`/tailnet/${getTailnet()}/devices${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "tailscale_get_device",
    description: "Get detailed information about a specific device by its ID.",
    annotations: {
      title: "Get device",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID (numeric id or nodeId, NOT the nodeKey)"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiGet(`/device/${encPath(input.deviceId)}`);
    },
  },
  {
    name: "tailscale_authorize_device",
    description: "Authorize a device that is pending authorization.",
    annotations: {
      title: "Authorize device",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID to authorize"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiPost(`/device/${encPath(input.deviceId)}/authorized`, { authorized: true });
    },
  },
  {
    name: "tailscale_deauthorize_device",
    description:
      "Deauthorize a device, immediately removing its access to the tailnet. The device will need to be re-authorized to reconnect.",
    annotations: {
      title: "Deauthorize device",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID to deauthorize"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiPost(`/device/${encPath(input.deviceId)}/authorized`, { authorized: false });
    },
  },
  {
    name: "tailscale_delete_device",
    description:
      "Permanently remove a device from the tailnet. This is irreversible — the device must re-authenticate to rejoin.",
    annotations: {
      title: "Delete device",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
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
    annotations: {
      title: "Rename device",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
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
    annotations: {
      title: "Expire device key",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
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
    annotations: {
      title: "Get device routes",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiGet(`/device/${encPath(input.deviceId)}/routes`);
    },
  },
  {
    name: "tailscale_set_device_routes",
    description:
      "Set the enabled subnet routes for a device. Replaces all currently enabled routes — pass the full list of routes you want enabled.",
    annotations: {
      title: "Set device routes",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      routes: z
        .array(z.string())
        .describe(
          "Full list of CIDR routes to enable (e.g. ['10.0.0.0/24', '192.168.1.0/24']). Replaces existing enabled routes.",
        ),
    }),
    handler: async (input: { deviceId: string; routes: string[] }) => {
      return apiPost(`/device/${encPath(input.deviceId)}/routes`, { routes: input.routes });
    },
  },
  {
    name: "tailscale_get_device_posture_attributes",
    description: "Get all posture attributes for a device, including custom and system-managed attributes.",
    annotations: {
      title: "Get device posture attributes",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
    }),
    handler: async (input: { deviceId: string }) => {
      return apiGet(`/device/${encPath(input.deviceId)}/attributes`);
    },
  },
  {
    name: "tailscale_set_device_posture_attribute",
    description:
      "Set a custom posture attribute on a device. Creates or updates the attribute. Attribute keys must start with 'custom:'. Useful for compliance tracking, JIT access, and custom security policies.",
    annotations: {
      title: "Set device posture attribute",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      attributeKey: z.string().describe("The attribute key (must start with 'custom:', e.g. 'custom:lastAuditDate')"),
      value: z.string().describe("The attribute value"),
      expiry: z
        .string()
        .optional()
        .describe(
          "Optional expiry time in RFC3339 format (e.g. '2026-12-01T00:00:00Z'). Attribute is automatically removed after expiry.",
        ),
    }),
    handler: async (input: { deviceId: string; attributeKey: string; value: string; expiry?: string }) => {
      if (!input.attributeKey.startsWith("custom:")) {
        throw new Error(`attributeKey must start with 'custom:' prefix, got: '${input.attributeKey}'`);
      }
      const body: Record<string, unknown> = { value: input.value };
      if (input.expiry !== undefined) body.expiry = input.expiry;
      return apiPost(`/device/${encPath(input.deviceId)}/attributes/${encPath(input.attributeKey)}`, body);
    },
  },
  {
    name: "tailscale_delete_device_posture_attribute",
    description: "Delete a custom posture attribute from a device. This is irreversible.",
    annotations: {
      title: "Delete device posture attribute",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      attributeKey: z.string().describe("The attribute key to delete (e.g. 'custom:lastAuditDate')"),
    }),
    handler: async (input: { deviceId: string; attributeKey: string }) => {
      if (!input.attributeKey.startsWith("custom:")) {
        throw new Error(`attributeKey must start with 'custom:' prefix, got: '${input.attributeKey}'`);
      }
      return apiDelete(`/device/${encPath(input.deviceId)}/attributes/${encPath(input.attributeKey)}`);
    },
  },
  {
    name: "tailscale_set_device_tags",
    description: "Set ACL tags on a device. Replaces all existing tags — pass the full list of tags you want applied.",
    annotations: {
      title: "Set device tags",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      tags: z
        .array(z.string())
        .describe("Full list of ACL tags (e.g. ['tag:server', 'tag:production']). Replaces all existing tags."),
    }),
    handler: async (input: { deviceId: string; tags: string[] }) => {
      const invalid = input.tags.filter((t) => !t.startsWith("tag:"));
      if (invalid.length > 0) {
        throw new Error(`All tags must start with 'tag:' prefix. Invalid tags: ${invalid.join(", ")}`);
      }
      return apiPost(`/device/${encPath(input.deviceId)}/tags`, { tags: input.tags });
    },
  },
  {
    name: "tailscale_set_device_ip",
    description: "Set the Tailscale IPv4 address for a device.",
    annotations: {
      title: "Set device IP",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      ipv4: z.string().describe("The new Tailscale IPv4 address for the device (e.g. '100.64.0.1')"),
    }),
    handler: async (input: { deviceId: string; ipv4: string }) => {
      return apiPost(`/device/${encPath(input.deviceId)}/ip`, { ipv4: input.ipv4 });
    },
  },
  {
    name: "tailscale_update_device_key",
    description:
      "Update a device's key settings, such as disabling key expiry. Useful for servers that should never need to re-authenticate.",
    annotations: {
      title: "Update device key",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      keyExpiryDisabled: z.boolean().describe("Whether to disable key expiry for this device"),
    }),
    handler: async (input: { deviceId: string; keyExpiryDisabled: boolean }) => {
      return apiPost(`/device/${encPath(input.deviceId)}/key`, {
        keyExpiryDisabled: input.keyExpiryDisabled,
      });
    },
  },
  {
    name: "tailscale_batch_update_posture_attributes",
    description:
      "Batch update custom posture attributes across multiple devices. Each attribute key must start with 'custom:'.",
    annotations: {
      title: "Batch update posture attributes",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      attributes: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .describe(
          'Map of device ID to attribute map (e.g. { "12345": { "custom:compliant": "true" }, "67890": { "custom:compliant": "false" } })',
        ),
    }),
    handler: async (input: { attributes: Record<string, Record<string, unknown>> }) => {
      const invalidKeys: string[] = [];
      for (const attrs of Object.values(input.attributes)) {
        for (const key of Object.keys(attrs)) {
          if (!key.startsWith("custom:")) invalidKeys.push(key);
        }
      }
      if (invalidKeys.length > 0) {
        throw new Error(
          `All attribute keys must start with 'custom:' prefix. Invalid keys: ${[...new Set(invalidKeys)].join(", ")}`,
        );
      }
      return apiPatch(`/tailnet/${getTailnet()}/device-attributes`, input.attributes);
    },
  },
] as const;
