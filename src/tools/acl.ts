import { z } from "zod";
import { apiGet, apiPost, getTailnet } from "../api.js";

export const aclTools = [
  {
    name: "tailscale_get_acl",
    description:
      "Get the current ACL policy for your tailnet. Returns the raw policy text with original formatting preserved, including comments and trailing commas (HuJSON). Also returns an ETag — you must pass it to tailscale_update_acl to safely update the policy.",
    annotations: {
      title: "Get ACL policy",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    handler: async () => {
      const res = await apiGet(`/tailnet/${getTailnet()}/acl`, {
        acceptRaw: true,
        accept: "application/hujson",
      });
      if (res.ok && res.etag) {
        // Embed the ETag as a HuJSON `//` comment so the body remains valid HuJSON.
        // Earlier versions used a `---` separator + bare `ETag:` line, which 400'd
        // the API if an agent round-tripped rawBody verbatim into tailscale_update_acl.
        const footer = [
          "",
          `// ETag: ${res.etag}`,
          "// Pass this ETag to tailscale_update_acl when updating the policy.",
          "// (HuJSON treats // as a comment — safe to leave in or strip before re-submitting.)",
          "",
        ].join("\n");
        return { ...res, rawBody: `${res.rawBody ?? ""}${footer}` };
      }
      return res;
    },
  },
  {
    name: "tailscale_update_acl",
    description:
      "Update the ACL policy for your tailnet. Accepts the full policy as a string to preserve formatting, comments, and trailing commas (HuJSON). You MUST pass the ETag from tailscale_get_acl to prevent overwriting concurrent changes. Always get the current ACL first, make targeted edits to the text, and pass the full modified text back.",
    annotations: {
      title: "Update ACL policy",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      policy: z
        .string()
        .describe(
          "The full ACL policy text. Preserve existing formatting, comments, and structure. Only modify the specific parts that need to change.",
        ),
      etag: z.string().describe("The ETag from tailscale_get_acl. Required to prevent concurrent edit conflicts."),
    }),
    handler: async (input: { policy: string; etag: string }) => {
      return apiPost(`/tailnet/${getTailnet()}/acl`, undefined, {
        rawBody: input.policy,
        contentType: "application/hujson",
        ifMatch: input.etag,
        acceptRaw: true,
        accept: "application/hujson",
      });
    },
  },
  {
    name: "tailscale_validate_acl",
    description:
      "Validate an ACL policy without applying it. Returns any errors found, or confirms the policy is valid.",
    annotations: {
      title: "Validate ACL policy",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      policy: z.string().describe("The full ACL policy text to validate"),
    }),
    handler: async (input: { policy: string }) => {
      const res = await apiPost(`/tailnet/${getTailnet()}/acl/validate`, undefined, {
        rawBody: input.policy,
        contentType: "application/hujson",
        acceptRaw: true,
        accept: "application/hujson",
      });
      if (res.ok && !res.rawBody?.trim()) {
        return { ...res, rawBody: "ACL policy is valid." };
      }
      return res;
    },
  },
  {
    name: "tailscale_preview_acl",
    description:
      "Preview the ACL rules that would apply to a specific user or IP address if a proposed policy were applied.",
    annotations: {
      title: "Preview ACL rules",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      policy: z.string().describe("The proposed ACL policy text to preview"),
      type: z
        .enum(["user", "ipport"])
        .describe("Preview type: 'user' to see rules for a user, 'ipport' to see rules for an IP"),
      previewFor: z
        .string()
        .describe("The user email (for type 'user') or IP:port (for type 'ipport') to preview rules for"),
    }),
    handler: async (input: { policy: string; type: "user" | "ipport"; previewFor: string }) => {
      const params = new URLSearchParams({ type: input.type, previewFor: input.previewFor });
      return apiPost(`/tailnet/${getTailnet()}/acl/preview?${params}`, undefined, {
        rawBody: input.policy,
        contentType: "application/hujson",
        acceptRaw: true,
        accept: "application/hujson",
      });
    },
  },
] as const;
