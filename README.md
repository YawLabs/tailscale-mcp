# @yawlabs/tailscale-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/tailscale-mcp)](https://www.npmjs.com/package/@yawlabs/tailscale-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/tailscale-mcp)](https://github.com/YawLabs/tailscale-mcp/stargazers)
[![CI](https://github.com/YawLabs/tailscale-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/YawLabs/tailscale-mcp/actions/workflows/ci.yml) [![Release](https://github.com/YawLabs/tailscale-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/YawLabs/tailscale-mcp/actions/workflows/release.yml) [![Integration](https://github.com/YawLabs/tailscale-mcp/actions/workflows/integration.yml/badge.svg)](https://github.com/YawLabs/tailscale-mcp/actions/workflows/integration.yml)

**Ask your agent questions about your tailnet and have it act on the answers.** 99 tools + 4 resources covering the full [Tailscale v2 API](https://tailscale.com/api). Backed by 735 tests and a nightly integration run against a real tailnet.

Built and maintained by [Yaw Labs](https://yaw.sh).

[![Add to mcp.hosting](https://mcp.hosting/install-button.svg)](https://mcp.hosting/install?name=Tailscale&command=npx&args=-y%2C%40yawlabs%2Ftailscale-mcp&env=TAILSCALE_API_KEY&description=Manage%20your%20Tailscale%20tailnet%20-%20devices%2C%20ACLs%2C%20DNS%2C%20keys&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Ftailscale-mcp)

One click adds this to your [mcp.hosting](https://mcp.hosting) account so it syncs to every MCP client you use. Or install manually below.

## What's the point if the API already exists?

You could `curl` the Tailscale API. The point isn't replacing `curl` — it's letting an agent compose multi-endpoint workflows in one turn without writing a script:

- **"Which devices haven't checked in for 30 days and have key expiry disabled?"** — lists devices, filters by `lastSeen`, filters by `keyExpiryDisabled`, returns a table. Three endpoints, one question.
- **"Someone broke DNS at 2am — who changed what in the last 24 hours?"** — pulls the audit log, filters by DNS-related actors and endpoints, reads each change's before/after, summarizes in English.
- **"Draft an ACL change that lets `tag:mobile` reach `tag:dashboard` but not `tag:db`, preserving my comments"** — reads the current HuJSON, proposes a minimal diff, validates it against the API, returns the diff for you to apply.
- **"Show me the OIDC workload identity for our GitHub Actions and confirm its allowed subjects still match `repo:Acme/*`"** — fetches the workload identity, parses the JWT claim patterns, tells you whether the claim still matches your repo naming.
- **"Rotate every auth key older than 90 days and print the new ones"** — iterates, creates new keys with matching tags, revokes the old ones.

A curl can do each step. The agent composes them. That's where the lift is, and that's what the tool surface is designed for — every read endpoint is first-class so the agent can synthesize, and every write endpoint is tagged `destructiveHint` or `idempotentHint` so your MCP client can gate mutations the way you configured it.

If all you need is one endpoint in a CI job, use `curl` — we even have a [CLI subcommand](#gitops-deploy-acls-from-ci) for the common ACL-from-git case. The MCP is for the interactive, exploratory, "I don't know what I need yet" work.

## Why MCP vs. a skill or the `tailscale` CLI?

Reasonable question. Both have their place. Where this MCP is better:

- **Full admin API coverage.** The `tailscale` CLI is scoped to the node it runs on. Admin concerns — ACLs, users, invites, webhooks, log streaming, workload identity, OAuth clients, posture — live in the v2 HTTP API. You'd be shelling out to `curl` anyway.
- **Typed tool surface, not string parsing.** Every tool has a Zod-validated input schema and a structured response. No brittle `tailscale status --json | jq` pipelines that break when the schema evolves.
- **Cross-client, no user rewriting.** A Claude Code skill is tied to Claude Code. An MCP server works in Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, and anything else that speaks MCP. Version bumps ship through `npx` — users don't re-author their skill when Tailscale adds an endpoint.
- **Safe-by-default writes.** Every tool declares `readOnlyHint` / `destructiveHint` / `idempotentHint` so clients can skip confirmation on reads and require it on mutations. A skill that shells out to the CLI can't express that.
- **Real tests.** 727 unit tests + an integration suite hitting a live tailnet on every tag. Most skills are short markdown prompts without their own test layer — if the vendor changes output format, nothing catches it for you.

If you already have a skill that covers your 10% of Tailscale workflows, great — keep it. The MCP is for the other 90%.

## Trust signals

Fair critique from Reddit: a week-old repo claiming "actively maintained" with no visible tests is worth exactly zero trust. Here's what's actually verifiable:

- **735 tests** (179 suites, `node --test`) covering every tool's input validation, API shape, and error handling. Run `npm test` to see them pass locally.
- **3 CI workflows** on GitHub Actions:
  - [`ci.yml`](.github/workflows/ci.yml) — lint + typecheck + build + unit tests on every push and PR.
  - [`integration.yml`](.github/workflows/integration.yml) — runs the full tool surface against a real tailnet.
  - [`release.yml`](.github/workflows/release.yml) — publishes to npm from a signed tag.
- **Dependabot alerts** surface on this repo and get fixed, not ignored.
- **Every tool verified against the live API.** If it's in the tool list, it calls a real endpoint that exists in the current v2 API. No placeholder 404 tools.

Issues and PRs are triaged. File one if something is off — [github.com/YawLabs/tailscale-mcp/issues](https://github.com/YawLabs/tailscale-mcp/issues).

## Quick start

**1. Set your API key**

Get an API key from [Tailscale Admin Console > Settings > Keys](https://login.tailscale.com/admin/settings/keys) and add it to your shell profile (`~/.bashrc`, `~/.zshrc`, or Windows system environment variables):

```bash
export TAILSCALE_API_KEY="tskey-api-..."
```

**2. Create `.mcp.json` in your project root**

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "tailscale": {
      "command": "npx",
      "args": ["-y", "@yawlabs/tailscale-mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "tailscale": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@yawlabs/tailscale-mcp"]
    }
  }
}
```

> **Why the extra step on Windows?** Since Node 20, `child_process.spawn` cannot directly execute `.cmd` files (that's what `npx` is on Windows). Wrapping with `cmd /c` is the standard workaround.

**3. Restart and approve**

Restart Claude Code (or your MCP client) and approve the Tailscale MCP server when prompted.

That's it. Now ask your agent:

> "List my Tailscale devices that haven't been seen in the last 7 days"
>
> "Summarize every ACL change in the audit log from yesterday"
>
> "Draft an ACL rule that lets `tag:ci` reach `tag:registry` on port 5000 only"

## Too many tools? Subset them.

99 tools is a lot. If you've already got a dozen MCP servers and your client is feeling heavy, trim what this one exposes. Three knobs, combinable:

### Option 1: `TAILSCALE_PROFILE` (preset, easiest)

```json
{
  "env": {
    "TAILSCALE_API_KEY": "tskey-api-...",
    "TAILSCALE_PROFILE": "core"
  }
}
```

- **`minimal`** (19 tools) — `status`, `devices`, `audit`. Observe the tailnet, read the audit log.
- **`core`** (46 tools) — adds `acl`, `dns`, `keys`, `users`. The day-to-day admin surface.
- **`full`** (99 tools, default) — everything. Same as omitting the env var.

### Option 2: `TAILSCALE_TOOLS` (explicit group list)

```json
{
  "env": {
    "TAILSCALE_API_KEY": "tskey-api-...",
    "TAILSCALE_TOOLS": "devices,acl,dns,audit"
  }
}
```

Comma-separated group names. Overrides `TAILSCALE_PROFILE` when both are set — use this when the presets aren't quite right.

Valid group names: `status`, `devices`, `acl`, `dns`, `keys`, `users`, `tailnet`, `webhooks`, `network-lock`, `posture`, `audit`, `invites`, `services`, `log-streaming`, `workload-identity`, `oauth-clients`.

### Option 3: `TAILSCALE_READONLY` (drop mutations)

```json
{
  "env": {
    "TAILSCALE_API_KEY": "tskey-api-...",
    "TAILSCALE_PROFILE": "core",
    "TAILSCALE_READONLY": "1"
  }
}
```

Set to `1` or `true` to drop every tool without `readOnlyHint: true`. Stacks with `TAILSCALE_PROFILE` or `TAILSCALE_TOOLS` as an intersection — combine for maximum minimalism.

### Confirming what loaded

The server logs the active filter to stderr on startup:

```
@yawlabs/tailscale-mcp v0.8.3 ready (19 tools, profile=core, readonly)
```

If you don't set any filter, startup prints a tip pointing you at the profiles.

## Using with mcp.hosting / mcph

If you run this server through [mcp.hosting](https://mcp.hosting) (via the `@yawlabs/mcph` local agent), the two filtering layers compose cleanly:

1. **Server-side** — `TAILSCALE_PROFILE` / `TAILSCALE_TOOLS` / `TAILSCALE_READONLY` reduce the tool surface *before* mcph sees it. The unloaded tools aren't registered at all.
2. **Client-side** — mcph's `mcp_connect_activate({ tools: [...] })` filters further for what appears in `tools/list`. Tools not in that list stay reachable via `mcp_connect_dispatch`, so you don't lose capability.

Recommended pattern for mcph users: set `TAILSCALE_PROFILE=core` (or narrower) in your mcp.hosting server config, then let mcph handle per-conversation activation on top. The server stays lean by default, and `mcp_connect_dispatch` covers the long-tail tools for ad-hoc needs.

## Authentication

**API key (simplest):** Set `TAILSCALE_API_KEY` in your shell or MCP config.

**OAuth (scoped access):** For fine-grained permissions, set `TAILSCALE_OAUTH_CLIENT_ID` and `TAILSCALE_OAUTH_CLIENT_SECRET` instead. Create an OAuth client at [Tailscale Admin Console > Settings > OAuth](https://login.tailscale.com/admin/settings/oauth).

The server checks for an API key first, then falls back to OAuth. If neither is set, tools return a clear error telling you what to configure — the server still starts, so your MCP client doesn't loop restarting.

**Tailnet:** Uses your default tailnet automatically. Set `TAILSCALE_TAILNET` to specify one explicitly.

## Resources (4)

MCP Resources expose read-only data clients can browse without a tool call.

| Resource | URI | Description |
|----------|-----|-------------|
| Tailnet Status | `tailscale://tailnet/status` | Device count and tailnet settings |
| Devices | `tailscale://tailnet/devices` | All devices with status and IPs |
| ACL Policy | `tailscale://tailnet/acl` | Full ACL policy (HuJSON preserved) |
| DNS Config | `tailscale://tailnet/dns` | Nameservers, search paths, split DNS, MagicDNS |

## Tools (99)

<details>
<summary><strong>Status</strong> (1 tool)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_status` | Verify API connection, see tailnet info and device count |

</details>

<details>
<summary><strong>Devices</strong> (16 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_devices` | List all devices with status, IPs, OS, and last seen |
| `tailscale_get_device` | Get detailed info for a specific device |
| `tailscale_authorize_device` | Authorize a pending device |
| `tailscale_deauthorize_device` | Deauthorize a device |
| `tailscale_delete_device` | Remove a device from the tailnet |
| `tailscale_rename_device` | Rename a device |
| `tailscale_expire_device` | Expire a device's key, forcing re-authentication |
| `tailscale_get_device_routes` | Get advertised and enabled subnet routes |
| `tailscale_set_device_routes` | Enable or disable subnet routes |
| `tailscale_get_device_posture_attributes` | Get all posture attributes for a device |
| `tailscale_set_device_posture_attribute` | Set a custom posture attribute (with optional expiry) |
| `tailscale_delete_device_posture_attribute` | Delete a custom posture attribute |
| `tailscale_set_device_tags` | Set ACL tags on a device |
| `tailscale_set_device_ip` | Set a device's Tailscale IPv4 address |
| `tailscale_update_device_key` | Update device key settings (e.g. disable key expiry) |
| `tailscale_batch_update_posture_attributes` | Batch update custom posture attributes across devices |

</details>

<details>
<summary><strong>ACL / Policy</strong> (4 tools) — with HuJSON formatting preservation and ETag safety</summary>

| Tool | Description |
|------|-------------|
| `tailscale_get_acl` | Get ACL policy with formatting preserved (HuJSON) + ETag |
| `tailscale_update_acl` | Update ACL policy (requires ETag for safe concurrent edits) |
| `tailscale_validate_acl` | Validate a policy without applying it |
| `tailscale_preview_acl` | Preview rules that would apply to a user or IP |

</details>

<details>
<summary><strong>DNS</strong> (11 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_get_nameservers` | Get DNS nameservers |
| `tailscale_set_nameservers` | Set DNS nameservers |
| `tailscale_get_search_paths` | Get DNS search paths |
| `tailscale_set_search_paths` | Set DNS search paths |
| `tailscale_get_split_dns` | Get split DNS configuration |
| `tailscale_set_split_dns` | Set split DNS configuration (full replace) |
| `tailscale_update_split_dns` | Update split DNS configuration (partial merge) |
| `tailscale_get_dns_preferences` | Get DNS preferences (MagicDNS) |
| `tailscale_set_dns_preferences` | Set DNS preferences (MagicDNS) |
| `tailscale_get_dns_configuration` | Get unified DNS configuration (all settings in one call) |
| `tailscale_set_dns_configuration` | Set unified DNS configuration (all settings in one call) |

</details>

<details>
<summary><strong>Auth Keys</strong> (5 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_keys` | List auth keys |
| `tailscale_get_key` | Get details for an auth key |
| `tailscale_create_key` | Create a new auth key |
| `tailscale_delete_key` | Delete an auth key |
| `tailscale_update_key` | Update an existing auth key |

</details>

<details>
<summary><strong>Users</strong> (7 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_users` | List all users in the tailnet |
| `tailscale_get_user` | Get details for a specific user |
| `tailscale_approve_user` | Approve a pending user |
| `tailscale_suspend_user` | Suspend a user, revoking access |
| `tailscale_restore_user` | Restore a suspended user |
| `tailscale_update_user_role` | Update a user's role (owner, admin, member, etc.) |
| `tailscale_delete_user` | Delete a user and all their devices |

</details>

<details>
<summary><strong>Tailnet Settings</strong> (5 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_get_tailnet_settings` | Get tailnet settings (HTTPS, device approval, key expiry, etc.) |
| `tailscale_update_tailnet_settings` | Update tailnet settings (HTTPS certificates, approval, auto-updates, key expiry, posture, regional routing, network flow logging, external ACL management) |
| `tailscale_get_contacts` | Get tailnet contacts |
| `tailscale_set_contacts` | Set tailnet contacts |
| `tailscale_resend_contact_verification` | Resend verification email for a contact |

</details>

<details>
<summary><strong>Network Lock</strong> (1 tool)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_get_network_lock_status` | Get tailnet lock status and trusted signing keys |

</details>

<details>
<summary><strong>Webhooks</strong> (7 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_webhooks` | List webhooks |
| `tailscale_get_webhook` | Get a specific webhook |
| `tailscale_create_webhook` | Create a webhook |
| `tailscale_update_webhook` | Update a webhook's endpoint URL and/or subscriptions |
| `tailscale_delete_webhook` | Delete a webhook |
| `tailscale_rotate_webhook_secret` | Rotate a webhook's secret |
| `tailscale_test_webhook` | Send a test event to verify webhook delivery |

</details>

<details>
<summary><strong>Posture Integrations</strong> (5 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_posture_integrations` | List posture integrations |
| `tailscale_get_posture_integration` | Get a posture integration |
| `tailscale_create_posture_integration` | Create a posture integration |
| `tailscale_update_posture_integration` | Update a posture integration |
| `tailscale_delete_posture_integration` | Delete a posture integration |

</details>

<details>
<summary><strong>Tailscale Services</strong> (7 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_services` | List all Tailscale Services in your tailnet |
| `tailscale_get_service` | Get details for a specific service |
| `tailscale_update_service` | Update a service's configuration |
| `tailscale_delete_service` | Delete a service |
| `tailscale_list_service_hosts` | List devices hosting a service |
| `tailscale_get_service_device_approval` | Get approval status of a device for a service |
| `tailscale_set_service_device_approval` | Approve or reject a device to host a service |

</details>

<details>
<summary><strong>Log Streaming</strong> (7 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_log_stream_configs` | List log streaming configurations (both audit and network) |
| `tailscale_get_log_stream_config` | Get log streaming config for a log type |
| `tailscale_set_log_stream_config` | Set where logs are sent (Axiom, Datadog, Splunk, etc.) |
| `tailscale_delete_log_stream_config` | Delete a log streaming configuration |
| `tailscale_get_log_stream_status` | Check if log streaming is delivering successfully |
| `tailscale_create_aws_external_id` | Create/get AWS external ID for S3 log streaming |
| `tailscale_validate_aws_trust_policy` | Validate AWS IAM role trust policy for S3 log streaming |

</details>

<details>
<summary><strong>Workload Identity</strong> (5 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_workload_identities` | List federated workload identity providers |
| `tailscale_get_workload_identity` | Get a workload identity provider |
| `tailscale_create_workload_identity` | Create an OIDC federation provider (GitHub Actions, GitLab CI, etc.) |
| `tailscale_update_workload_identity` | Update a workload identity provider |
| `tailscale_delete_workload_identity` | Delete a workload identity provider |

</details>

<details>
<summary><strong>OAuth Clients</strong> (5 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_oauth_clients` | List OAuth clients |
| `tailscale_get_oauth_client` | Get an OAuth client |
| `tailscale_create_oauth_client` | Create an OAuth client for programmatic API access |
| `tailscale_update_oauth_client` | Update an OAuth client |
| `tailscale_delete_oauth_client` | Delete an OAuth client |

</details>

<details>
<summary><strong>Device Invites</strong> (6 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_device_invites` | List device invites for a specific device |
| `tailscale_create_device_invite` | Create a device invite |
| `tailscale_get_device_invite` | Get a device invite |
| `tailscale_delete_device_invite` | Delete a device invite |
| `tailscale_accept_device_invite` | Accept a device share invitation |
| `tailscale_resend_device_invite` | Resend a device invite email |

</details>

<details>
<summary><strong>User Invites</strong> (5 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_user_invites` | List user invites |
| `tailscale_create_user_invite` | Create a user invite |
| `tailscale_get_user_invite` | Get a user invite |
| `tailscale_delete_user_invite` | Delete a user invite |
| `tailscale_resend_user_invite` | Resend a user invite email |

</details>

<details>
<summary><strong>Logging</strong> (2 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_get_audit_log` | Get configuration audit log (who changed what, when) |
| `tailscale_get_network_flow_logs` | Get network traffic flow logs between devices |

</details>

## GitOps: deploy ACLs from CI

For the simple "deploy ACL from git on merge" workflow, you don't need an MCP server or an agent — use the built-in CLI:

```bash
npx @yawlabs/tailscale-mcp deploy-acl tailscale/acl.json
```

Handles ETag fetching, validation, and deployment in one command. Works in any CI system. Set `TAILSCALE_API_KEY` and `TAILSCALE_TAILNET` as env vars.

**Optional:** Lock the Admin Console to prevent manual edits that drift from git. Ask your agent:

> "Set aclsExternallyManagedOn to true and aclsExternalLink to our repo URL"

This shows a read-only banner in the Tailscale Admin Console pointing to your repo. Use the MCP for reads and investigations, and let CI handle the deploy.

## Requirements

- Node.js 18+
- A Tailscale API key or OAuth client credentials

## Contributing

Contributions welcome. Please [open an issue](https://github.com/YawLabs/tailscale-mcp/issues) to discuss before a PR for anything beyond a typo fix.

```bash
git clone https://github.com/YawLabs/tailscale-mcp.git
cd tailscale-mcp
npm install
npm run lint       # Biome check
npm run lint:fix   # Auto-fix
npm run build      # tsc + esbuild bundle
npm test           # node --test (735 tests)
```

For integration testing against your own tailnet: set `TAILSCALE_API_KEY` and run `node dist/index.js`.

## License

MIT
