import { z } from "zod";
import { apiGet, getTailnet } from "../api.js";

export const networkLockTools = [
  {
    name: "tailscale_get_network_lock_status",
    description:
      "Get the tailnet lock (network lock) status, including whether it is enabled and the list of trusted signing keys.",
    annotations: {
      title: "Get network lock status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/network-lock/status`);
    },
  },
] as const;
