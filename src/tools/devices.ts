import * as net from "node:net";
import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, encPath, getTailnet, validateTags } from "../api.js";

// Validate that a string parses as `<ipv4>/<0-32>` or `<ipv6>/<0-128>`. The
// Tailscale API is the authoritative validator for tailnet-specific rules
// (e.g. "is this route advertised by the device"); this helper just rejects
// obvious typos client-side. The previous loose regex accepted nonsense like
// "1.2.3/8" or "100/8" -- using Node's `net.isIPv4` / `net.isIPv6` matches
// the comment's stated intent of "must look like an IPv4 quad-dotted or an
// IPv6 colon-form" and bounds-checks the prefix per family.
function isCidr(s: string): boolean {
  const slash = s.indexOf("/");
  if (slash < 0) return false;
  const addr = s.slice(0, slash);
  const prefix = s.slice(slash + 1);
  // Strict prefix: only ASCII digits. Number() coerces several non-numeric
  // forms to 0 -- "" (trailing-slash typo), " " (trailing whitespace), "+0"
  // (leading sign), "0.0" (decimal) all become 0 and would silently validate
  // as a /0 default-route advertisement. Number.isInteger accepts 0 in every
  // case, so the integer check below doesn't catch these. Anchored \d+ does.
  if (!/^\d+$/.test(prefix)) return false;
  const prefixN = Number(prefix);
  if (net.isIPv4(addr)) return prefixN <= 32;
  if (net.isIPv6(addr)) return prefixN <= 128;
  return false;
}

// Shared by tailscale_list_devices and tailscale_get_device, which reference the
// same `fields` query parameter in the spec. It spells out the default set
// because the whole point of the parameter is that omitting it returns LESS than
// everything -- the previous list-tool description said the opposite ("Omit for
// all fields"), so an agent asking for a routes or posture audit got a response
// with no routes and no posture identity in it and no way to tell.
const DEVICE_FIELDS_DESC =
  "Which device fields to return. Tailscale documents exactly two values. 'default' (also what you get when this is omitted) is the limited set: addresses, id, nodeId, user, name, hostname, clientVersion, updateAvailable, os, created, connectedToControl, lastSeen, keyExpiryDisabled, expires, authorized, isExternal, machineKey, nodeKey, blocksIncomingConnections, tailnetLockKey, tailnetLockError, tags, isEphemeral. 'all' adds advertisedRoutes, enabledRoutes, clientConnectivity (endpoints, DERP latency), sshEnabled, distro, multipleConnections and postureIdentity (serial numbers and, where a posture integration collects them, hardware/MAC addresses). Omitting it does NOT return everything.";

// Appended to both device-read tool descriptions. Tailscale stopped sending
// lastSeen for connected devices on 2025-10-08, so its absence now means two
// opposite things depending on connectedToControl.
const DEVICE_LAST_SEEN_NOTE =
  " 'lastSeen' is omitted while a device is connected (connectedToControl: true) and for devices that have never been online -- on a connected device a missing lastSeen means online now, not never seen.";

export const deviceTools = [
  {
    name: "tailscale_list_devices",
    description: `List all devices in your tailnet with their status, IP addresses, OS, and last seen time.${DEVICE_LAST_SEEN_NOTE}`,
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
        .describe(`${DEVICE_FIELDS_DESC} Any other value is forwarded unvalidated; Tailscale documents none.`),
      filters: z
        .record(z.string(), z.union([z.string(), z.array(z.string()).min(1)]))
        .optional()
        .describe(
          "Server-side filters on top-level device properties, exact match only (e.g. { isEphemeral: 'true', os: 'linux' }). All filters are ANDed. Pass an array to repeat a key: { tags: ['tag:prod', 'tag:subnetrouter'] } sends tags=..&tags=.. and matches devices whose tags contain BOTH. Properties that are complex objects (e.g. clientConnectivity) cannot be filtered; repeating a key on a non-list property is undocumented upstream.",
        ),
    }),
    handler: async (input: { fields?: string; filters?: Record<string, string | string[]> }) => {
      const params = new URLSearchParams();
      if (input.fields) params.set("fields", input.fields);
      if (input.filters) {
        for (const [key, value] of Object.entries(input.filters)) {
          // Reject `fields` as a filter key: the top-level `fields` parameter
          // is what selects which device columns come back. Filter values are
          // appended, so a filters.fields entry no longer overwrites it -- it
          // sends a second fields= and leaves the server to pick one, which is
          // ambiguous rather than silent but still not what the caller asked
          // for. Surface the conflict either way.
          if (key === "fields") {
            throw new Error(
              "filters.fields is not allowed -- use the top-level 'fields' parameter to select which device fields to return.",
            );
          }
          // append, not set: the API expresses multi-value AND by repeating a
          // key (the spec's own example is tags=tag:prod&tags=tag:subnetrouter),
          // and `set` would have kept only the last value.
          for (const one of Array.isArray(value) ? value : [value]) params.append(key, one);
        }
      }
      const qs = params.toString();
      return apiGet(`/tailnet/${getTailnet()}/devices${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "tailscale_get_device",
    description: `Get detailed information about a specific device by its ID. Returns the default field subset unless fields: 'all'.${DEVICE_LAST_SEEN_NOTE}`,
    annotations: {
      title: "Get device",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID (numeric id or nodeId, NOT the nodeKey)"),
      fields: z.enum(["all", "default"]).optional().describe(DEVICE_FIELDS_DESC),
    }),
    handler: async (input: { deviceId: string; fields?: "all" | "default" }) => {
      // Omitted stays omitted: no query string at all rather than a default of
      // 'all'. Flipping it would start returning serial numbers, endpoints and
      // MAC addresses to every caller who asked for none of them.
      const params = new URLSearchParams();
      if (input.fields) params.set("fields", input.fields);
      const qs = params.toString();
      return apiGet(`/device/${encPath(input.deviceId)}${qs ? `?${qs}` : ""}`);
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
      // Replace-all: the routes array is the new enabled set, so `[]` silently
      // withdraws every subnet the device currently routes.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      deviceId: z.string().describe("The device ID"),
      routes: z
        .array(z.string().refine(isCidr, { message: "must be a CIDR (e.g. '10.0.0.0/24' or 'fd7a:115c::/48')" }))
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
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .describe("The attribute value (string, number, or boolean)"),
      expiry: z
        .string()
        .optional()
        .describe(
          "Optional expiry time in RFC3339 format (e.g. '2026-12-01T00:00:00Z'). Attribute is automatically removed after expiry.",
        ),
    }),
    handler: async (input: {
      deviceId: string;
      attributeKey: string;
      value: string | number | boolean;
      expiry?: string;
    }) => {
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
      // Replace-all: `[]` strips every ACL tag, which can drop the device out of
      // the policy rules that grant it access.
      destructiveHint: true,
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
      ipv4: z.ipv4().describe("The new Tailscale IPv4 address for the device (e.g. '100.64.0.1')"),
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
      "Authorize or deauthorize multiple devices in one call. Each device's POST runs in parallel; per-device errors are returned alongside the successes so a partial failure doesn't lose the work that succeeded. On partial failure the call still returns success (ok) with data: { authorized, succeeded, failed } -- inspect data.failed for the per-device errors. Common use: authorize a batch of newly-enrolled CI hosts, or deauthorize a group of devices flagged by a security review.",
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
        else failed[deviceId] = { status: res.status, error: res.error || `HTTP ${res.status}` };
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
      // Shape note: returns {authorized, succeeded, failed} -- deliberately
      // differs from set_contacts's {applied, failed} in tailnet.ts. Here every
      // device gets the IDENTICAL authorize/deauthorize action so the response
      // body per device is uninformative; we surface a flat ID list under
      // `succeeded`. set_contacts, in contrast, returns distinct per-type
      // response data, so it uses a Record<type, data> map under `applied`.
      // Don't "normalize" these without losing information.
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
        .max(200)
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
