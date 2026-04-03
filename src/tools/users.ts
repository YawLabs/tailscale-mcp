import { z } from "zod";
import { apiGet, getTailnet } from "../api.js";

export const userTools = [
  {
    name: "tailscale_list_users",
    description: "List all users in your tailnet.",
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/users`);
    },
  },
  {
    name: "tailscale_get_user",
    description: "Get details for a specific user.",
    inputSchema: z.object({
      userId: z.string().describe("The user ID"),
    }),
    handler: async (input: { userId: string }) => {
      return apiGet(`/users/${input.userId}`);
    },
  },
] as const;
