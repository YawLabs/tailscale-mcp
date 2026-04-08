# @yawlabs/tailscale-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/tailscale-mcp)](https://www.npmjs.com/package/@yawlabs/tailscale-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/tailscale-mcp)](https://github.com/YawLabs/tailscale-mcp/stargazers)
[![CI](https://github.com/YawLabs/tailscale-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/YawLabs/tailscale-mcp/actions/workflows/ci.yml)

**Manage your Tailscale tailnet from Claude Code, Cursor, and any MCP client.** 81 tools + 4 resources. One env var. Works on first try.

Built and maintained by [YawLabs](https://yaw.sh).

## Why this one?

Other Tailscale MCP servers were vibe-coded in a weekend and abandoned. This one was built for production use and tested against the real Tailscale API.

- **Preserves ACL formatting** — reads and writes HuJSON (comments, trailing commas, indentation). Others compact your carefully formatted policy into a single line.
- **Safe ACL updates** — uses ETags to prevent overwriting concurrent changes. No silent data loss.
- **Tool annotations** — every tool declares `readOnlyHint`, `destructiveHint`, and `idempotentHint`, so MCP clients skip confirmation dialogs for safe operations.
- **MCP Resources** — exposes tailnet status, device list, ACL policy, and DNS config as browsable resources.
- **Zero restarts** — the server always starts, even with missing credentials. Auth errors surface as clear tool-call errors, not silent crashes that force you to restart your AI assistant.
- **One env var setup** — no config files, no setup wizards, no multi-step flows.
- **Every tool verified** — no placeholder endpoints that 404. If it's in the tool list, it works.

## Quick start

**1. Set your API key**

Get an API key from [Tailscale Admin Console > Settings > Keys](https://login.tailscale.com/admin/settings/keys) and add it to your shell profile (`~/.bashrc`, `~/.zshrc`, or system environment variables):

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

> **Tip:** This file is safe to commit — it contains no secrets. Teammates who set their own `TAILSCALE_API_KEY` will get the MCP server automatically.

**3. Restart and approve**

Restart Claude Code (or your MCP client) and approve the Tailscale MCP server when prompted.

That's it. Now ask your AI assistant:

> "List my Tailscale devices"

```
┌────────────┬─────────┬────────────────┬──────────────────────┐
│  Hostname  │   OS    │  Tailscale IP  │      Last Seen       │
���────────────┼─────────┼────────────────┼──────────────────────┤
│ web-prod   │ Linux   │ 100.x.x.1     │ 2026-04-03 21:09 UTC │
├────────────┼─────────┼���───────────────┼──────────────────────┤
│ db-staging │ Linux   │ 100.x.x.2     │ 2026-04-03 21:09 UTC ��
���────────────┼──────���──┼────────────────┼──────────────────────┤
│ dev-laptop │ macOS   │ 100.x.x.3     │ 2026-04-03 21:09 UTC │
└────────────┴─────────┴──���─────────────┴──────────────────────┘
```

> "Show me the ACL policy"

Returns your full policy with formatting, comments, and structure intact — plus an ETag for safe updates.

> "Who changed the DNS settings yesterday?"

Pulls the audit log so you can see exactly who did what and when.

## Authentication

**API key (recommended):** Set `TAILSCALE_API_KEY` in your shell profile. Simplest option, works immediately. You can also pass it inline via the `"env"` field in your MCP config if you prefer a self-contained setup.

**OAuth (scoped access):** For fine-grained permissions, set `TAILSCALE_OAUTH_CLIENT_ID` and `TAILSCALE_OAUTH_CLIENT_SECRET` instead. Create an OAuth client at [Tailscale Admin Console > Settings > OAuth](https://login.tailscale.com/admin/settings/oauth).

The server checks for an API key first, then falls back to OAuth. If neither is set, tools return a clear error telling you what to configure.

**Tailnet:** Uses your default tailnet automatically. Set `TAILSCALE_TAILNET` to specify one explicitly.

## Resources (4)

MCP Resources expose read-only data that clients can browse without tool calls.

| Resource | URI | Description |
|----------|-----|-------------|
| Tailnet Status | `tailscale://tailnet/status` | Device count and tailnet settings |
| Devices | `tailscale://tailnet/devices` | All devices with status and IPs |
| ACL Policy | `tailscale://tailnet/acl` | Full ACL policy (HuJSON preserved) |
| DNS Config | `tailscale://tailnet/dns` | Nameservers, search paths, split DNS, MagicDNS |

## Tools (81)

<details>
<summary><strong>Status</strong> (1 tool)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_status` | Verify API connection, see tailnet info and device count |

</details>

<details>
<summary><strong>Devices</strong> (13 tools)</summary>

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
<summary><strong>DNS</strong> (8 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_get_nameservers` | Get DNS nameservers |
| `tailscale_set_nameservers` | Set DNS nameservers |
| `tailscale_get_search_paths` | Get DNS search paths |
| `tailscale_set_search_paths` | Set DNS search paths |
| `tailscale_get_split_dns` | Get split DNS configuration |
| `tailscale_set_split_dns` | Set split DNS configuration |
| `tailscale_get_dns_preferences` | Get DNS preferences (MagicDNS) |
| `tailscale_set_dns_preferences` | Set DNS preferences (MagicDNS) |

</details>

<details>
<summary><strong>Auth Keys</strong> (4 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_keys` | List auth keys |
| `tailscale_get_key` | Get details for an auth key |
| `tailscale_create_key` | Create a new auth key |
| `tailscale_delete_key` | Delete an auth key |

</details>

<details>
<summary><strong>Users</strong> (6 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_users` | List all users in the tailnet |
| `tailscale_get_user` | Get details for a specific user |
| `tailscale_approve_user` | Approve a pending user |
| `tailscale_suspend_user` | Suspend a user, revoking access |
| `tailscale_restore_user` | Restore a suspended user |
| `tailscale_update_user_role` | Update a user's role (owner, admin, member, etc.) |

</details>

<details>
<summary><strong>Tailnet Settings</strong> (4 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_get_tailnet_settings` | Get tailnet settings (HTTPS, device approval, key expiry, etc.) |
| `tailscale_update_tailnet_settings` | Update tailnet settings (HTTPS certificates, approval, auto-updates, key expiry, posture, regional routing, network flow logging) |
| `tailscale_get_contacts` | Get tailnet contacts |
| `tailscale_set_contacts` | Set tailnet contacts |

</details>

<details>
<summary><strong>Network Lock</strong> (1 tool)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_get_network_lock_status` | Get tailnet lock status and trusted signing keys |

</details>

<details>
<summary><strong>Webhooks</strong> (6 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_webhooks` | List webhooks |
| `tailscale_get_webhook` | Get a specific webhook |
| `tailscale_create_webhook` | Create a webhook |
| `tailscale_update_webhook` | Update a webhook's endpoint URL and/or subscriptions |
| `tailscale_delete_webhook` | Delete a webhook |
| `tailscale_rotate_webhook_secret` | Rotate a webhook's secret |

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
<summary><strong>Tailscale Services</strong> (5 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_services` | List all Tailscale Services in your tailnet |
| `tailscale_get_service` | Get details for a specific service |
| `tailscale_update_service` | Update a service's configuration |
| `tailscale_delete_service` | Delete a service |
| `tailscale_list_service_hosts` | List devices hosting a service |

</details>

<details>
<summary><strong>Log Streaming</strong> (4 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_log_stream_configs` | List log streaming configurations |
| `tailscale_get_log_stream_config` | Get log streaming config for a log type |
| `tailscale_set_log_stream_config` | Set where logs are sent (Axiom, Datadog, Splunk, etc.) |
| `tailscale_delete_log_stream_config` | Delete a log streaming configuration |

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
<summary><strong>Device Invites</strong> (4 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_device_invites` | List device invites |
| `tailscale_create_device_invite` | Create a device invite |
| `tailscale_get_device_invite` | Get a device invite |
| `tailscale_delete_device_invite` | Delete a device invite |

</details>

<details>
<summary><strong>User Invites</strong> (4 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_user_invites` | List user invites |
| `tailscale_create_user_invite` | Create a user invite |
| `tailscale_get_user_invite` | Get a user invite |
| `tailscale_delete_user_invite` | Delete a user invite |

</details>

<details>
<summary><strong>Logging</strong> (2 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_get_audit_log` | Get configuration audit log (who changed what, when) |
| `tailscale_get_network_flow_logs` | Get network traffic flow logs between devices |

</details>

## GitOps: deploy ACLs from CI

The recommended workflow for ACL management is to keep your policy in git and deploy it automatically on merge. This gives you code review, history, and no accidental overwrites from stale browser tabs.

The `deploy-acl` CLI subcommand handles everything — ETag fetching, validation, and deployment — in a single command:

```bash
npx @yawlabs/tailscale-mcp deploy-acl tailscale/acl.json
```

Works with any CI system — just set `TAILSCALE_API_KEY` and `TAILSCALE_TAILNET` as env vars.

**Optional:** Lock the Admin Console to prevent manual edits that drift from git:

```
> "Set aclsExternallyManagedOn to true and aclsExternalLink to our repo URL"
```

This shows a read-only banner in the Tailscale Admin Console pointing to your repo. Use the MCP for reads and one-off operations (audit logs, device management, investigations), and let CI handle ACL deployments.

## Requirements

- Node.js 18 or higher

## Contributing

Contributions are welcome. Please [open an issue](https://github.com/YawLabs/tailscale-mcp/issues) to discuss what you'd like to change before submitting a PR.

To develop locally:

```bash
git clone https://github.com/YawLabs/tailscale-mcp.git
cd tailscale-mcp
npm install
npm run build
npm run lint
npm test
```

Test against your own tailnet by setting `TAILSCALE_API_KEY` and running:

```bash
node dist/index.js
```

## License

MIT
