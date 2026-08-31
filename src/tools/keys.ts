import { z } from "zod";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  encPath,
  getTailnet,
  validateAndSanitizeDescription,
  validateTags,
} from "../api.js";

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
      "Create a new key in your tailnet. Supports auth keys (for adding devices), OAuth clients (for programmatic API access), and federated identities (for OIDC-based CI/CD access). Returns the key value — save it immediately, as it cannot be retrieved again.\n\nSECURITY: the response body contains a long-lived credential verbatim. MCP clients commonly persist tool responses to logs and conversation transcripts; treat this response as sensitive (do not commit it, avoid re-sharing it in unrelated chat history).\n\nExamples:\n- Auth key: {keyType:'auth', reusable:true, tags:['tag:ci']}\n- OAuth client: {keyType:'client', scopes:['devices:read','dns']}\n- Federated (GitHub Actions): {keyType:'federated', scopes:['devices:read'], issuer:'https://token.actions.githubusercontent.com', subject:'repo:my-org/my-repo:*'}",
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
      } else {
        // Symmetric guard: client/federated-only fields silently flowing into
        // an auth key used to be dropped on the floor (the auth branch below
        // never reads them), producing a key that didn't match the caller's
        // intent. Fail loudly so the caller either fixes keyType or drops the
        // irrelevant fields.
        const nonAuthFields = ["scopes", "issuer", "subject", "audience", "customClaimRules"] as const;
        const wrongFields = nonAuthFields.filter((f) => input[f] !== undefined);
        if (wrongFields.length > 0) {
          throw new Error(
            `${wrongFields.join(", ")} cannot be used with keyType 'auth'. Set keyType to 'client' or 'federated'.`,
          );
        }
      }

      const body: Record<string, unknown> = {};

      if (keyType !== "auth") body.keyType = keyType;
      // Empty/whitespace-only descriptions are silently treated as "no description"
      // and the field is omitted (the API may 400 on `""`). Non-empty input that
      // sanitizes to empty (e.g. "!!!") throws inside the helper so the caller
      // gets a specific error rather than the misleading "No fields to update".
      if (input.description !== undefined) {
        const sanitized = validateAndSanitizeDescription(input.description);
        if (sanitized !== undefined) body.description = sanitized;
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
        const sanitized = validateAndSanitizeDescription(input.description);
        if (sanitized !== undefined) body.description = sanitized;
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
  // --- OAuth Apps (device provisioning) ---
  //
  // ALPHA upstream. Distinct from the OAuth *clients* handled by
  // tailscale_create_key above: an OAuth client is a machine credential you
  // hold, whereas an OAuth App is a three-legged authorization-code app that
  // lets a THIRD PARTY enroll one device into your tailnet after a user
  // consents. The only scope it takes today is `auth_keys:create:once`, which
  // mints exactly one auth key per authorization and returns no refresh token
  // -- re-authorization is required per device by design.
  {
    name: "tailscale_create_oauth_app",
    description:
      "Create an OAuth App for device provisioning (Tailscale alpha). Lets a third-party application enroll a device into your tailnet via the authorization-code flow, after a user consents. Returns the app's client secret -- save it immediately, it cannot be retrieved again.\n\nSECURITY: the response body contains a long-lived credential verbatim. MCP clients commonly persist tool responses to logs and conversation transcripts; treat this response as sensitive.\n\nThe supported scope is 'auth_keys:create:once' (one auth key per authorization, no refresh token). Distinct from tailscale_create_key with keyType='client', which mints a machine-to-machine OAuth client instead.",
    annotations: {
      title: "Create OAuth app",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.object({
      name: z.string().min(1).describe("Human-readable name for the OAuth app, shown on the consent screen"),
      redirectUris: z
        .array(z.url())
        .min(1)
        .describe("Allowed redirect URIs for the authorization-code flow (e.g. ['https://example.com/callback'])"),
      scopes: z
        .array(z.string())
        .min(1)
        .describe("Scopes to grant. Currently 'auth_keys:create:once' is the supported value."),
      allowedNodeAttributes: z
        .array(z.string())
        .optional()
        .describe("Optional node attributes the app may request when provisioning a device"),
    }),
    handler: async (input: {
      name: string;
      redirectUris: string[];
      scopes: string[];
      allowedNodeAttributes?: string[];
    }) => {
      const body: Record<string, unknown> = {
        name: input.name,
        redirectUris: input.redirectUris,
        scopes: input.scopes,
      };
      if (input.allowedNodeAttributes !== undefined) body.allowedNodeAttributes = input.allowedNodeAttributes;
      return apiPost(`/tailnet/${getTailnet()}/oauth-apps`, body);
    },
  },
  {
    name: "tailscale_get_oauth_app",
    description:
      "Get an OAuth App's configuration (name, redirect URIs, scopes) by its app ID. Use this to verify an app was registered as intended. The client secret is not returned -- it is only available at creation time.",
    annotations: {
      title: "Get OAuth app",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      appId: z.string().min(1).describe("The OAuth app ID returned by tailscale_create_oauth_app"),
    }),
    handler: async (input: { appId: string }) => {
      return apiGet(`/tailnet/${getTailnet()}/oauth-apps/${encPath(input.appId)}`);
    },
  },
  {
    name: "tailscale_list_oauth_apps",
    description:
      "List the OAuth Apps registered in your tailnet (Tailscale alpha). Returns an `oauthApps` array describing each app (id, name, redirect URIs, scopes). Client secrets are NOT included -- a secret is only returned once, by tailscale_create_oauth_app at creation time. This is how you recover the id of an app you did not record; pass that id to tailscale_delete_oauth_app to revoke it.",
    annotations: {
      title: "List OAuth apps",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    // No limit/cursor: the live endpoint takes no parameters and returns the
    // whole collection. Advertising pagination the API ignores would let a
    // caller believe it had paged through the list when it had not.
    inputSchema: z.object({}),
    handler: async () => {
      return apiGet(`/tailnet/${getTailnet()}/oauth-apps`);
    },
  },
  {
    name: "tailscale_delete_oauth_app",
    description:
      "Delete an OAuth App (Tailscale alpha). This is irreversible: the app's client secret stops working immediately and any integration using it loses its device-enrollment path, so no further device can be authorized through it. Devices already enrolled stay in the tailnet, exactly as they do when the auth key that added them is deleted. Use tailscale_list_oauth_apps to find the id.",
    annotations: {
      title: "Delete OAuth app",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      // `.trim().min(1)` rather than the bare `.min(1)` on
      // tailscale_get_oauth_app's appId, for the reason tailnets.ts spells out
      // on tailscale_delete_tailnet: a bare min(1) accepts " ", which encPath
      // then sends as the literal segment "%20". On a read that costs a wasted
      // round-trip; on an irreversible revoke it returns a 404 that reads like
      // the app is already gone. Trimming at the schema makes it a validation
      // error instead.
      appId: z.string().trim().min(1).describe("The OAuth app ID to delete (see tailscale_list_oauth_apps)"),
    }),
    handler: async (input: { appId: string }) => {
      return apiDelete(`/tailnet/${getTailnet()}/oauth-apps/${encPath(input.appId)}`);
    },
  },
] as const;
