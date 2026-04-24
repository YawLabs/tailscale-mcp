import { z } from "zod";
import { apiGet, getTailnet } from "../api.js";

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

      const data: Record<string, unknown> = {
        connected: true,
        tailnet: getTailnet(),
        deviceCount: devicesRes.ok ? (devicesRes.data?.devices?.length ?? 0) : null,
        settings: settingsRes.ok ? settingsRes.data : null,
      };
      const errors: Record<string, string> = {};
      if (!devicesRes.ok) errors.devices = devicesRes.error ?? `HTTP ${devicesRes.status}`;
      if (!settingsRes.ok) errors.settings = settingsRes.error ?? `HTTP ${settingsRes.status}`;
      if (Object.keys(errors).length > 0) data.errors = errors;

      return { ok: true, status: 200, data };
    },
  },
] as const;
