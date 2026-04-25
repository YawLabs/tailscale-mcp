import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, encPath, getTailnet, validateTags } from "../api.js";

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
      idempotentHint: true,
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
        .array(z.string().cidr())
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
      validateTags(input.tags);
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
      ipv4: z
        .string()
        .ip({ version: "v4" })
        .describe("The new Tailscale IPv4 address for the device (e.g. '100.64.0.1')"),
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
    name: "tailscale_set_devices_authorized",
    description:
      "Authorize or deauthorize multiple devices in one call. Each device's POST runs in parallel; per-device errors are returned alongside the successes so a partial failure doesn't lose the work that succeeded. Common use: authorize a batch of newly-enrolled CI hosts, or deauthorize a group of devices flagged by a security review.",
    annotations: {
      title: "Set devices authorized (bulk)",
      readOnlyHint: false,
      // Deauthorize is destructive; authorize is not. Mark destructive so MCP
      // clients gate the bulk call the safer way.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceIds: z.array(z.string().min(1)).min(1).describe("Device IDs to update"),
      authorized: z.boolean().describe("true to authorize, false to deauthorize"),
    }),
    handler: async (input: { deviceIds: string[]; authorized: boolean }) => {
      const unique = [...new Set(input.deviceIds)];
      const results = await Promise.all(
        unique.map(async (deviceId) => {
          const res = await apiPost(`/device/${encPath(deviceId)}/authorized`, { authorized: input.authorized });
          return { deviceId, res };
        }),
      );
      const succeeded: string[] = [];
      const failed: Record<string, { status: number; error: string }> = {};
      for (const { deviceId, res } of results) {
        if (res.ok) succeeded.push(deviceId);
        else failed[deviceId] = { status: res.status, error: res.error ?? `HTTP ${res.status}` };
      }
      const failedCount = Object.keys(failed).length;
      if (failedCount === unique.length) {
        const first = Object.values(failed)[0];
        return {
          ok: false,
          status: first.status,
          error: `All ${failedCount} device updates failed: ${JSON.stringify(failed)}`,
        };
      }
      return { ok: true, status: 200, data: { authorized: input.authorized, succeeded, failed } };
    },
  },
  {
    name: "tailscale_batch_update_posture_attributes",
    description:
      "Batch update custom posture attributes across multiple devices. Each attribute key must start with 'custom:'. Uses JSON Merge Patch semantics — pass null as the attribute config to delete.",
    annotations: {
      title: "Batch update posture attributes",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      nodes: z
        .record(
          z.string(),
          z.record(
            z.string(),
            z.union([
              z.object({
                value: z.union([z.string(), z.number(), z.boolean()]),
                expiry: z.string().optional(),
              }),
              z.null(),
            ]),
          ),
        )
        .describe(
          'Map of device ID to attribute config map (e.g. { "12345": { "custom:compliant": { "value": "true" } }, "67890": { "custom:compliant": { "value": false, "expiry": "2026-12-01T00:00:00Z" } } }). Pass null as the config to delete an attribute.',
        ),
      comment: z
        .string()
        .optional()
        .describe("Optional comment added to the audit log explaining why attributes are being set (max 200 chars)"),
    }),
    handler: async (input: {
      nodes: Record<string, Record<string, { value: string | number | boolean; expiry?: string } | null>>;
      comment?: string;
    }) => {
      const invalidKeys: string[] = [];
      for (const attrs of Object.values(input.nodes)) {
        for (const key of Object.keys(attrs)) {
          if (!key.startsWith("custom:")) invalidKeys.push(key);
        }
      }
      if (invalidKeys.length > 0) {
        throw new Error(
          `All attribute keys must start with 'custom:' prefix. Invalid keys: ${[...new Set(invalidKeys)].join(", ")}`,
        );
      }
      const body: Record<string, unknown> = { nodes: input.nodes };
      if (input.comment !== undefined) body.comment = input.comment;
      return apiPatch(`/tailnet/${getTailnet()}/device-attributes`, body);
    },
  },
] as const;
