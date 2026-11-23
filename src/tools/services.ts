import { z } from "zod";
import { apiDelete, apiGet, apiPost, apiPut, DEVICE_ID_HINT, encPath, getTailnet, validateTags } from "../api.js";

export const serviceTools = [
  {
    name: "tailscale_list_services",
    description:
      "List all Tailscale Services in your tailnet. Services provide stable MagicDNS names and virtual IPs, decoupled from individual devices. Note: this MCP has no create-service tool. The API documents its Service PUT as create-or-update, but tailscale_update_service sends only the fields you pass, so do not use it to create one. Use the update/delete/approval tools here once the service exists.",
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
      serviceName: z.string().trim().min(1).describe("The service name"),
    }),
    handler: async (input: { serviceName: string }) => {
      return apiGet(`/tailnet/${getTailnet()}/services/${encPath(input.serviceName)}`);
    },
  },
  {
    name: "tailscale_update_service",
    description:
      "Update a Tailscale Service's configuration. UNVERIFIED body shape: this sends only the fields you pass via PUT, and whether Tailscale treats that PUT as a replace -- clearing fields you omitted, such as the service's ports or tags -- is not yet confirmed. Read the service with tailscale_get_service first and pass every field you want kept.",
    annotations: {
      title: "Update service",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      serviceName: z.string().trim().min(1).describe("The service name to update"),
      ports: z
        .array(
          z.object({
            protocol: z.enum(["tcp", "udp"]).describe("Protocol (tcp or udp)"),
            port: z.number().int().min(1).max(65535).describe("Port number (1-65535)"),
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
      validateTags(input.tags);
      const { serviceName, ...body } = input;
      const cleanBody: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) cleanBody[key] = value;
      }
      if (Object.keys(cleanBody).length === 0) {
        throw new Error("No fields to update. Provide at least one of: ports, tags, autoApproveHosts.");
      }
      // The body shape is NOT verified upstream: object-shaped `ports`
      // ({protocol, port}) and `autoApproveHosts` are what this sends, the
      // repo's probe plan calls the latter a field the spec does not have, and
      // whether a sparse PUT clears the fields it omits is open. The tests pin
      // what the handler sends, not what the API wants. Tracked as finding C3,
      // gated on the live probe P6-C3-service-put
      // (scripts/lib/probe-plans/p6-c3-service-put.mjs).
      return apiPut(`/tailnet/${getTailnet()}/services/${encPath(serviceName)}`, cleanBody);
    },
  },
  {
    name: "tailscale_delete_service",
    description:
      "Delete a Tailscale Service. This is irreversible -- the service's MagicDNS name and virtual IP will be released.",
    annotations: {
      title: "Delete service",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      // `.trim().min(1)`, not a bare string: a whitespace-only service name
      // encodes to "%20" and this irreversible delete returns a 404 that reads
      // like the service is already gone (rationale: tailnets.ts delete_tailnet).
      serviceName: z.string().trim().min(1).describe("The service name to delete"),
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
      serviceName: z.string().trim().min(1).describe("The service name"),
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
      serviceName: z.string().trim().min(1).describe("The service name"),
      deviceId: z.string().trim().min(1).describe(`The device ID. ${DEVICE_ID_HINT}`),
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
      serviceName: z.string().trim().min(1).describe("The service name"),
      deviceId: z.string().trim().min(1).describe(`The device ID. ${DEVICE_ID_HINT}`),
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
