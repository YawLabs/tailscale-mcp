import { z } from "zod";
import { apiGet, getTailnet } from "../api.js";

export const statusTools = [
  {
    name: "tailscale_status",
    description:
      "Check that the Tailscale API connection is working. Returns your tailnet name, device count, and confirms authentication is valid. Use this to verify setup.",
    inputSchema: z.object({}),
    handler: async () => {
      const devicesRes = await apiGet<{ devices: unknown[] }>(
        `/tailnet/${getTailnet()}/devices?fields=id`
      );
      if (!devicesRes.ok) {
        return devicesRes;
      }
      const deviceCount = devicesRes.data?.devices?.length ?? 0;

      const settingsRes = await apiGet<Record<string, unknown>>(
        `/tailnet/${getTailnet()}/settings`
      );

      return {
        ok: true,
        status: 200,
        data: {
          connected: true,
          tailnet: getTailnet(),
          deviceCount,
          settings: settingsRes.ok ? settingsRes.data : undefined,
        },
      };
    },
  },
] as const;
