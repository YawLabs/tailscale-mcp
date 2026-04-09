import { z } from "zod";
import { apiDelete, apiGet, apiPost, apiPut, encPath, getTailnet } from "../api.js";

export const serviceTools = [
  {
    name: "tailscale_list_services",
    description:
      "List all Tailscale Services in your tailnet. Services provide stable MagicDNS names and virtual IPs, decoupled from individual devices.",
    annotations: {
      title: "List services",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/services`);
    },
  },
  {
    name: "tailscale_get_service",
    description:
      "Get details for a specific Tailscale Service, including its MagicDNS name, virtual IP, and configuration.",
    annotations: {
      title: "Get service",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      serviceName: z.string().describe("The service name"),
    }),
    handler: async (input: { serviceName: string }) => {
      return apiGet(`/tailnet/${getTailnet()}/services/${encPath(input.serviceName)}`);
    },
  },
  {
    name: "tailscale_update_service",
    description: "Update a Tailscale Service's configuration.",
    annotations: {
      title: "Update service",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      serviceName: z.string().describe("The service name to update"),
      ports: z
        .array(
          z.object({
            protocol: z.enum(["tcp", "udp"]).describe("Protocol (tcp or udp)"),
            port: z.number().describe("Port number"),
          }),
        )
        .optional()
        .describe("Ports the service listens on"),
      tags: z.array(z.string()).optional().describe("ACL tags for the service"),
      autoApproveHosts: z
        .boolean()
        .optional()
        .describe("Whether to auto-approve devices that want to host this service"),
    }),
    handler: async (input: {
      serviceName: string;
      ports?: { protocol: string; port: number }[];
      tags?: string[];
      autoApproveHosts?: boolean;
    }) => {
      if (input.tags && input.tags.length > 0) {
        const invalid = input.tags.filter((t) => !t.startsWith("tag:"));
        if (invalid.length > 0) {
          throw new Error(`All tags must start with 'tag:' prefix. Invalid tags: ${invalid.join(", ")}`);
        }
      }
      const { serviceName, ...body } = input;
      const cleanBody: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) cleanBody[key] = value;
      }
      return apiPut(`/tailnet/${getTailnet()}/services/${encPath(serviceName)}`, cleanBody);
    },
  },
  {
    name: "tailscale_delete_service",
    description:
      "Delete a Tailscale Service. This is irreversible — the service's MagicDNS name and virtual IP will be released.",
    annotations: {
      title: "Delete service",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      serviceName: z.string().describe("The service name to delete"),
    }),
    handler: async (input: { serviceName: string }) => {
      return apiDelete(`/tailnet/${getTailnet()}/services/${encPath(input.serviceName)}`);
    },
  },
  {
    name: "tailscale_list_service_hosts",
    description: "List devices hosting a specific Tailscale Service.",
    annotations: {
      title: "List service hosts",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      serviceName: z.string().describe("The service name"),
    }),
    handler: async (input: { serviceName: string }) => {
      return apiGet(`/tailnet/${getTailnet()}/services/${encPath(input.serviceName)}/devices`);
    },
  },
  {
    name: "tailscale_get_service_device_approval",
    description: "Get the approval status of a specific device for a Tailscale Service.",
    annotations: {
      title: "Get service device approval",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      serviceName: z.string().describe("The service name"),
      deviceId: z.string().describe("The device ID"),
    }),
    handler: async (input: { serviceName: string; deviceId: string }) => {
      return apiGet(
        `/tailnet/${getTailnet()}/services/${encPath(input.serviceName)}/device/${encPath(input.deviceId)}/approved`,
      );
    },
  },
  {
    name: "tailscale_set_service_device_approval",
    description: "Approve or reject a device to host a Tailscale Service.",
    annotations: {
      title: "Set service device approval",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      serviceName: z.string().describe("The service name"),
      deviceId: z.string().describe("The device ID"),
      approved: z.boolean().describe("Whether to approve (true) or reject (false) the device"),
    }),
    handler: async (input: { serviceName: string; deviceId: string; approved: boolean }) => {
      return apiPost(
        `/tailnet/${getTailnet()}/services/${encPath(input.serviceName)}/device/${encPath(input.deviceId)}/approved`,
        { approved: input.approved },
      );
    },
  },
] as const;
