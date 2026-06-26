import { z } from "zod";
import { type ApiResponse, apiGet, getTailnet } from "../api.js";

/**
 * Build the data-shape returned by both the `tailscale_status` tool and the
 * `tailnet-status` resource (server-wiring.ts). The two surfaces wrap the
 * result differently (ApiResponse envelope vs MCP resource shape) but the
 * inner composition is identical -- centralising it here keeps the `?? null`
 * and errors-bag rules in one place so they can't drift between the surfaces.
 *
 * `?? null` (not `?? 0`): the request succeeded but the body was missing a
 * `devices` array (204 / empty content-length / unexpected shape). Reporting
 * `0` in that case would be confidently wrong; null signals "unknown" so the
 * caller doesn't conflate it with an actually-empty tailnet.
 *
 * Lives in tools/status.ts (not server-wiring.ts) so the dependency direction
 * is "wiring depends on tools", matching the rest of the codebase.
 */
export function composeTailnetStatusData(
  devicesRes: ApiResponse<{ devices?: unknown[] }>,
  settingsRes: ApiResponse<Record<string, unknown>>,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  // Strip reserved keys from extras up front: deviceCount / settings / errors
  // are the helper's contract, not the caller's. Without this, a caller passing
  // `errors: {...}` in extras would have it survive when both sub-fetches
  // succeed -- the conditional assignment below only runs when there ARE
  // errors, leaving the leaked extras.errors in place.
  const { deviceCount: _deviceCount, settings: _settings, errors: _errors, ...safeExtras } = extras;
  const data: Record<string, unknown> = {
    ...safeExtras,
    deviceCount: devicesRes.ok ? (devicesRes.data?.devices?.length ?? null) : null,
    settings: settingsRes.ok ? settingsRes.data : null,
  };
  const errors: Record<string, string> = {};
  if (!devicesRes.ok) errors.devices = devicesRes.error ?? `HTTP ${devicesRes.status}`;
  if (!settingsRes.ok) errors.settings = settingsRes.error ?? `HTTP ${settingsRes.status}`;
  if (Object.keys(errors).length > 0) data.errors = errors;
  return data;
}

export const statusTools = [
  {
    name: "tailscale_status",
    description:
      "Check that the Tailscale API connection is working. Returns your tailnet name, device count, and confirms authentication is valid. Use this to verify setup.",
    annotations: {
      title: "Check API status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      const [devicesRes, settingsRes] = await Promise.all([
        apiGet<{ devices: unknown[] }>(`/tailnet/${getTailnet()}/devices?fields=id`),
        apiGet<Record<string, unknown>>(`/tailnet/${getTailnet()}/settings`),
      ]);

      // If both calls fail, auth itself is likely broken — fast-fail so the caller
      // sees the underlying error verbatim (401s include the Windows env-var hint).
      if (!devicesRes.ok && !settingsRes.ok) {
        return devicesRes;
      }

      const data = composeTailnetStatusData(devicesRes, settingsRes, {
        connected: true,
        tailnet: getTailnet(),
      });

      return { ok: true, status: 200, data };
    },
  },
] as const;
