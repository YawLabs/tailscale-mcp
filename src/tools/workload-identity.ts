import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost, encPath, getTailnet, sanitizeDescription } from "../api.js";

export const workloadIdentityTools = [
  {
    name: "tailscale_list_workload_identities",
    description:
      "List all federated workload identity providers configured for your tailnet. Workload identities allow CI/CD pipelines and automated systems to authenticate using OIDC federation.",
    annotations: {
      title: "List workload identities",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/workload-identity/providers`);
    },
  },
  {
    name: "tailscale_get_workload_identity",
    description: "Get details for a specific workload identity provider.",
    annotations: {
      title: "Get workload identity",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      providerId: z.string().describe("The workload identity provider ID"),
    }),
    handler: async (input: { providerId: string }) => {
      return apiGet(`/tailnet/${getTailnet()}/workload-identity/providers/${encPath(input.providerId)}`);
    },
  },
  {
    name: "tailscale_create_workload_identity",
    description:
      "Create a new workload identity provider for OIDC federation. Enables CI/CD systems (GitHub Actions, GitLab CI, etc.) to authenticate to your tailnet without static credentials.",
    annotations: {
      title: "Create workload identity",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().describe("A human-readable name for this provider (max 50 chars, alphanumeric/hyphens/spaces)"),
      issuerUrl: z
        .string()
        .describe("The OIDC issuer URL (e.g. 'https://token.actions.githubusercontent.com' for GitHub Actions)"),
      audience: z.string().optional().describe("Expected audience claim in the OIDC token"),
      claimMappings: z
        .record(z.string(), z.string())
        .optional()
        .describe("Map of Tailscale attributes to OIDC token claims (e.g. { 'tag': 'repository' })"),
    }),
    handler: async (input: {
      name: string;
      issuerUrl: string;
      audience?: string;
      claimMappings?: Record<string, string>;
    }) => {
      const body: Record<string, unknown> = { ...input };
      body.name = sanitizeDescription(input.name);
      return apiPost(`/tailnet/${getTailnet()}/workload-identity/providers`, body);
    },
  },
  {
    name: "tailscale_update_workload_identity",
    description: "Update an existing workload identity provider's configuration.",
    annotations: {
      title: "Update workload identity",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      providerId: z.string().describe("The workload identity provider ID to update"),
      name: z.string().optional().describe("Updated human-readable name"),
      audience: z.string().optional().describe("Updated expected audience claim"),
      claimMappings: z.record(z.string(), z.string()).optional().describe("Updated claim mappings"),
    }),
    handler: async (input: {
      providerId: string;
      name?: string;
      audience?: string;
      claimMappings?: Record<string, string>;
    }) => {
      const { providerId, ...body } = input;
      const cleanBody: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) cleanBody[key] = value;
      }
      if (cleanBody.name !== undefined) cleanBody.name = sanitizeDescription(cleanBody.name as string);
      if (Object.keys(cleanBody).length === 0) {
        throw new Error("No fields to update. Provide at least one of: name, audience, claimMappings.");
      }
      return apiPatch(`/tailnet/${getTailnet()}/workload-identity/providers/${encPath(providerId)}`, cleanBody);
    },
  },
  {
    name: "tailscale_delete_workload_identity",
    description:
      "Delete a workload identity provider. This is irreversible — any CI/CD pipelines using this provider will lose access.",
    annotations: {
      title: "Delete workload identity",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      providerId: z.string().describe("The workload identity provider ID to delete"),
    }),
    handler: async (input: { providerId: string }) => {
      return apiDelete(`/tailnet/${getTailnet()}/workload-identity/providers/${encPath(input.providerId)}`);
    },
  },
] as const;
