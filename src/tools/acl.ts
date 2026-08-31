import { z } from "zod";
import { apiGet, apiPost, getTailnet } from "../api.js";

// First-line marker of the ETag footer tailscale_get_acl appends. The appender
// and stripEtagFooter both key off this one constant, so rewording the guidance
// lines cannot orphan a footer block an earlier release already wrote into a
// stored policy.
const ETAG_FOOTER_MARKER = "// ETag: ";

// Remove any ETag footer a previous tailscale_get_acl appended to an ACL body.
// Walks back over the trailing run of blank and `//` lines only -- the footer
// is only ever appended at the very end -- so comments belonging to the policy
// itself are left alone, and several stacked blocks come off in one pass.
function stripEtagFooter(body: string): string {
  const lines = body.split("\n");
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (!line.startsWith("//")) break;
    if (line.startsWith(ETAG_FOOTER_MARKER)) cut = i;
  }
  return lines.slice(0, cut).join("\n");
}

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
          `${ETAG_FOOTER_MARKER}${res.etag}`,
          "// Pass this ETag to tailscale_update_acl when updating the policy.",
          "// (HuJSON treats // as a comment — safe to leave in or strip before re-submitting.)",
          "",
        ].join("\n");
        // Strip the footer from an earlier get before stamping the current one.
        // tailscale_update_acl tells the agent to pass the full text back, so the
        // stored policy returns carrying the last footer; appending unconditionally
        // stacked one more block per edit cycle and grew the live ACL without bound.
        return { ...res, rawBody: `${stripEtagFooter(res.rawBody ?? "")}${footer}` };
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
      // Overwrites the whole policy file in one call, and a bad push can lock
      // every device out of the tailnet -- the widest blast radius of any write
      // here, so clients must gate it rather than auto-approve it.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({
      policy: z
        .string()
        .describe(
          "The full ACL policy text. Preserve existing formatting, comments, and structure. Only modify the specific parts that need to change.",
        ),
      etag: z
        .string()
        .trim()
        .min(1, "etag must not be empty -- an empty ETag would send this overwrite with no concurrency guard.")
        .describe("The ETag from tailscale_get_acl. Required to prevent concurrent edit conflicts."),
    }),
    // `.trim().min(1)`, not a bare `z.string()`: apiRequest sets If-Match behind
    // `if (options?.ifMatch)`, so an empty etag is falsy there and the header is
    // omitted entirely -- the write then overwrites a concurrent admin edit instead
    // of coming back 412, on the widest-blast-radius write in the package, with
    // no diagnostic anywhere. `.trim()` is load-bearing for the same reason it is
    // on tailnets.ts's ids: a bare `.min(1)` accepts " ", which is truthy, so the
    // header goes out carrying a precondition that cannot match any real ETag --
    // a confusing 412 instead of a local validation error naming the field.
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
      // Tailscale's validate endpoint returns 200 with either an empty body
      // or `{}` for a VALID policy; an object with a `message` / `error`
      // field for an INVALID one. Previously only the empty-body case was
      // normalized to "ACL policy is valid.", so a `{}` response leaked
      // through verbatim and looked like a diagnostic to the agent. Matches
      // cli.ts's parseValidationError treatment.
      if (res.ok) {
        const trimmed = res.rawBody?.trim();
        if (!trimmed || trimmed === "{}") {
          return { ...res, rawBody: "ACL policy is valid." };
        }
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
