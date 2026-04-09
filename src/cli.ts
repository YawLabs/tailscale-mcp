/**
 * CLI subcommands for tailscale-mcp.
 * These run instead of the MCP server when a subcommand is passed.
 */

import { readFileSync } from "node:fs";
import { apiGet, apiPost, getTailnet } from "./api.js";

export async function deployAcl(filePath: string): Promise<void> {
  let policy: string;
  try {
    policy = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error(`Failed to read ${filePath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Fetch current ETag
  const getRes = await apiGet(`/tailnet/${getTailnet()}/acl`, { acceptRaw: true, accept: "application/hujson" });
  if (!getRes.ok || !getRes.etag) {
    console.error(`Failed to get current ACL: ${getRes.error || "no ETag returned"}`);
    process.exit(1);
  }

  // Validate before deploying
  const validateRes = await apiPost(`/tailnet/${getTailnet()}/acl/validate`, undefined, {
    rawBody: policy,
    contentType: "application/hujson",
    acceptRaw: true,
    accept: "application/hujson",
  });
  if (!validateRes.ok) {
    console.error(`ACL validation failed: ${validateRes.error}`);
    process.exit(1);
  }

  // Deploy with ETag
  const deployRes = await apiPost(`/tailnet/${getTailnet()}/acl`, undefined, {
    rawBody: policy,
    contentType: "application/hujson",
    ifMatch: getRes.etag,
    acceptRaw: true,
    accept: "application/hujson",
  });
  if (!deployRes.ok) {
    console.error(`ACL deploy failed: ${deployRes.error}`);
    process.exit(1);
  }

  console.log("ACL deployed successfully");
}
