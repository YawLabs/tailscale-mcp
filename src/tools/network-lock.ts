import { z } from "zod";
import { apiGet, getTailnet } from "../api.js";

export const networkLockTools = [
  {
    name: "tailscale_get_tailnet_keys",
    description:
      "Get the tailnet's auth keys and their capabilities, including tailnet lock signing key information if tailnet lock is enabled.",
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/keys`);
    },
  },
] as const;
