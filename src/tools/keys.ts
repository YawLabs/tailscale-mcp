import { z } from "zod";
import { apiDelete, apiGet, apiPost, apiPut, encPath, getTailnet, sanitizeDescription, validateTags } from "../api.js";

export const keyTools = [
  {
    name: "tailscale_list_keys",
    description:
      "List keys in your tailnet. By default lists auth keys only. Set 'all' to true to include OAuth clients and federated identities.",
    annotations: {
      title: "List keys",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      all: z
        .boolean()
        .optional()
        .describe("When true, returns all key types (auth keys, OAuth clients, federated identities). Default: false"),
    }),
    handler: async (input: { all?: boolean }) => {
      const qs = input.all ? "?all=true" : "";
      return apiGet(`/tailnet/${getTailnet()}/keys${qs}`);
    },
  },
  {
    name: "tailscale_get_key",
    description: "Get details for a specific key (auth key, OAuth client, or federated identity).",
    annotations: {
      title: "Get key",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      keyId: z.string().describe("The key ID (auth key, OAuth client, or federated identity)"),
    }),
    handler: async (input: { keyId: string }) => {
      return apiGet(`/tailnet/${getTailnet()}/keys/${encPath(input.keyId)}`);
    },
  },
  {
    name: "tailscale_create_key",
    description:
      "Create a new key in your tailnet. Supports auth keys (for adding devices), OAuth clients (for programmatic API access), and federated identities (for OIDC-based CI/CD access). Returns the key value — save it immediately, as it cannot be retrieved again.\n\nExamples:\n- Auth key: {keyType:'auth', reusable:true, tags:['tag:ci']}\n- OAuth client: {keyType:'client', scopes:['devices:read','dns']}\n- Federated (GitHub Actions): {keyType:'federated', scopes:['devices:read'], issuer:'https://token.actions.githubusercontent.com', subject:'repo:my-org/my-repo:*'}",
    annotations: {
      title: "Create key",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      keyType: z
        .enum(["auth", "client", "federated"])
        .optional()
        .describe(
          "Key type: 'auth' (default) for device auth keys, 'client' for OAuth clients, 'federated' for OIDC federation",
        ),
      description: z
        .string()
        .optional()
        .describe("Description for this key (max 50 chars, alphanumeric/hyphens/spaces)"),
      // Auth key fields
      reusable: z
        .boolean()
        .optional()
        .describe("(auth only) Whether the key can be used more than once (default: false)"),
      ephemeral: z
        .boolean()
        .optional()
        .describe("(auth only) Whether devices using this key are ephemeral (default: false)"),
      preauthorized: z.boolean().optional().describe("(auth only) Whether devices are pre-authorized (default: false)"),
      expirySeconds: z.number().optional().describe("(auth only) Key expiry in seconds (default: 90 days)"),
      // Shared fields
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "ACL tags (must start with 'tag:'). Required for client/federated if scopes include 'devices:core' or 'auth_keys'",
        ),
      // Client + Federated fields
      scopes: z
        .array(z.string())
        .optional()
        .describe("(client/federated) OAuth scopes to grant (e.g. ['devices:read', 'dns', 'acl'])"),
      // Federated-only fields
      issuer: z
        .string()
        .optional()
        .describe("(federated only) OIDC issuer URL (e.g. 'https://token.actions.githubusercontent.com')"),
      subject: z.string().optional().describe("(federated only) Expected subject claim, supports * wildcards"),
      audience: z.string().optional().describe("(federated only) Expected audience claim"),
      customClaimRules: z
        .record(z.string(), z.string())
        .optional()
        .describe("(federated only) Custom claim mapping rules"),
    }),
    handler: async (input: {
      keyType?: "auth" | "client" | "federated";
      description?: string;
      reusable?: boolean;
      ephemeral?: boolean;
      preauthorized?: boolean;
      expirySeconds?: number;
      tags?: string[];
      scopes?: string[];
      issuer?: string;
      subject?: string;
      audience?: string;
      customClaimRules?: Record<string, string>;
    }) => {
      validateTags(input.tags);

      const keyType = input.keyType ?? "auth";

      if (keyType !== "auth") {
        const authOnlyFields = ["reusable", "ephemeral", "preauthorized", "expirySeconds"] as const;
        const wrongFields = authOnlyFields.filter((f) => input[f] !== undefined);
        if (wrongFields.length > 0) {
          throw new Error(`${wrongFields.join(", ")} can only be used with keyType 'auth', not '${keyType}'`);
        }
      }

      const body: Record<string, unknown> = {};

      if (keyType !== "auth") body.keyType = keyType;
      // Skip empty/whitespace-only descriptions: the API may 400 on `""` and the
      // intent of a blank description is "no description," which the API treats
      // identically to omitting the field.
      if (input.description !== undefined) {
        const sanitized = sanitizeDescription(input.description);
        if (sanitized.length > 0) body.description = sanitized;
      }

      if (keyType === "auth") {
        body.capabilities = {
          devices: {
            create: {
              reusable: input.reusable ?? false,
              ephemeral: input.ephemeral ?? false,
              preauthorized: input.preauthorized ?? false,
              tags: input.tags ?? [],
            },
          },
        };
        if (input.expirySeconds !== undefined) body.expirySeconds = input.expirySeconds;
      } else {
        if (!input.scopes || input.scopes.length === 0) {
          throw new Error(`scopes are required for keyType '${keyType}'`);
        }
        body.scopes = input.scopes;
        if (input.tags) body.tags = input.tags;

        if (keyType === "federated") {
          if (!input.issuer) throw new Error("issuer is required for federated keys");
          if (!input.subject) throw new Error("subject is required for federated keys");
          body.issuer = input.issuer;
          body.subject = input.subject;
          if (input.audience !== undefined) body.audience = input.audience;
          if (input.customClaimRules !== undefined) body.customClaimRules = input.customClaimRules;
        }
      }

      return apiPost(`/tailnet/${getTailnet()}/keys`, body);
    },
  },
  {
    name: "tailscale_delete_key",
    description:
      "Delete a key (auth key, OAuth client, or federated identity). This is irreversible. For auth keys, devices already authenticated are unaffected but no new devices can use it. For OAuth clients and federated identities, any integrations using them lose access immediately.",
    annotations: {
      title: "Delete key",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      keyId: z.string().describe("The key ID to delete (auth key, OAuth client, or federated identity)"),
    }),
    handler: async (input: { keyId: string }) => {
      return apiDelete(`/tailnet/${getTailnet()}/keys/${encPath(input.keyId)}`);
    },
  },
  {
    name: "tailscale_update_key",
    description:
      "Update an existing key. Supported fields depend on the key type: all key types accept 'description'; OAuth clients and federated identities additionally accept 'scopes' and 'tags'; federated identities additionally accept 'issuer', 'subject', 'audience', and 'customClaimRules'. For auth keys, pass only 'description' — the Tailscale API will reject other fields.",
    annotations: {
      title: "Update key",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      keyId: z.string().describe("The key ID to update"),
      description: z.string().optional().describe("Updated description (max 50 chars, alphanumeric/hyphens/spaces)"),
      scopes: z.array(z.string()).optional().describe("(client/federated) Updated OAuth scopes"),
      tags: z.array(z.string()).optional().describe("Updated ACL tags (must start with 'tag:')"),
      issuer: z.string().optional().describe("(federated only) Updated OIDC issuer URL"),
      subject: z.string().optional().describe("(federated only) Updated subject claim pattern"),
      audience: z.string().optional().describe("(federated only) Updated audience claim"),
      customClaimRules: z
        .record(z.string(), z.string())
        .optional()
        .describe("(federated only) Updated custom claim rules"),
    }),
    handler: async (input: {
      keyId: string;
      description?: string;
      scopes?: string[];
      tags?: string[];
      issuer?: string;
      subject?: string;
      audience?: string;
      customClaimRules?: Record<string, string>;
    }) => {
      validateTags(input.tags);
      const body: Record<string, unknown> = {};
      if (input.description !== undefined) {
        const sanitized = sanitizeDescription(input.description);
        if (sanitized.length > 0) body.description = sanitized;
      }
      if (input.scopes !== undefined) body.scopes = input.scopes;
      if (input.tags !== undefined) body.tags = input.tags;
      if (input.issuer !== undefined) body.issuer = input.issuer;
      if (input.subject !== undefined) body.subject = input.subject;
      if (input.audience !== undefined) body.audience = input.audience;
      if (input.customClaimRules !== undefined) body.customClaimRules = input.customClaimRules;
      if (Object.keys(body).length === 0) {
        throw new Error("No fields to update. Provide at least one field (description, scopes, tags, etc.).");
      }
      return apiPut(`/tailnet/${getTailnet()}/keys/${encPath(input.keyId)}`, body);
    },
  },
] as const;
