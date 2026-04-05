# @yawlabs/tailscale-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/tailscale-mcp)](https://www.npmjs.com/package/@yawlabs/tailscale-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/tailscale-mcp)](https://github.com/YawLabs/tailscale-mcp/stargazers)

**Manage your Tailscale tailnet from Claude Code, Cursor, and any MCP client.** 52 tools. One env var. Works on first try.

Built and maintained by [YawLabs](https://yaw.sh).

## Why this one?

Other Tailscale MCP servers were vibe-coded in a weekend and abandoned. This one was built for production use and tested against the real Tailscale API — every single endpoint.

- **Preserves ACL formatting** — reads and writes HuJSON (comments, trailing commas, indentation). Others compact your carefully formatted policy into a single line.
- **Safe ACL updates** — uses ETags to prevent overwriting concurrent changes. No silent data loss.
- **Zero restarts** — the server always starts, even with missing credentials. Auth errors surface as clear tool-call errors, not silent crashes that force you to restart your AI assistant.
- **One env var setup** — no config files, no setup wizards, no multi-step flows.
- **Every tool verified** — no placeholder endpoints that 404. If it's in the tool list, it works.

## Quick start

Add to your MCP client config:

```json
{
  "mcpServers": {
    "tailscale": {
      "command": "npx",
      "args": ["-y", "@yawlabs/tailscale-mcp"],
      "env": {
        "TAILSCALE_API_KEY": "tskey-api-..."
      }
    }
  }
}
```

Get your API key from [Tailscale Admin Console > Settings > Keys](https://login.tailscale.com/admin/settings/keys).

That's it. Now ask your AI assistant:

> "List my Tailscale devices"

```
┌────────────┬─────────┬────────────────┬──────────────────────┐
│  Hostname  │   OS    │  Tailscale IP  │      Last Seen       │
├────────────┼─────────┼────────────────┼──────────────────────┤
│ web-prod   │ Linux   │ 100.x.x.1     │ 2026-04-03 21:09 UTC │
├────────────┼─────────┼────────────────┼──────────────────────┤
│ db-staging │ Linux   │ 100.x.x.2     │ 2026-04-03 21:09 UTC │
├────────────┼─────────┼────────────────┼──────────────────────┤
│ dev-laptop │ macOS   │ 100.x.x.3     │ 2026-04-03 21:09 UTC │
└────────────┴─────────┴────────────────┴──────────────────────┘
```

> "Show me the ACL policy"

Returns your full policy with formatting, comments, and structure intact — plus an ETag for safe updates.

> "Who changed the DNS settings yesterday?"

Pulls the audit log so you can see exactly who did what and when.

## Authentication

**API key (recommended):** Set `TAILSCALE_API_KEY`. Simplest option, works immediately.

**OAuth (scoped access):** For fine-grained permissions, set `TAILSCALE_OAUTH_CLIENT_ID` and `TAILSCALE_OAUTH_CLIENT_SECRET` instead. Create an OAuth client at [Tailscale Admin Console > Settings > OAuth](https://login.tailscale.com/admin/settings/oauth).

The server checks for an API key first, then falls back to OAuth. If neither is set, tools return a clear error telling you what to configure.

**Tailnet:** Uses your default tailnet automatically. Set `TAILSCALE_TAILNET` to specify one explicitly.

## Tools (52)

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
| `tailscale_get_tailnet_settings` | Get tailnet settings |
| `tailscale_update_tailnet_settings` | Update tailnet settings |
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
<summary><strong>Webhooks</strong> (5 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_webhooks` | List webhooks |
| `tailscale_get_webhook` | Get a specific webhook |
| `tailscale_create_webhook` | Create a webhook |
| `tailscale_update_webhook` | Update a webhook's endpoint URL and/or subscriptions |
| `tailscale_delete_webhook` | Delete a webhook |

</details>

<details>
<summary><strong>Posture Integrations</strong> (4 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_posture_integrations` | List posture integrations |
| `tailscale_get_posture_integration` | Get a posture integration |
| `tailscale_create_posture_integration` | Create a posture integration |
| `tailscale_delete_posture_integration` | Delete a posture integration |

</details>

<details>
<summary><strong>Logging</strong> (2 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_get_audit_log` | Get configuration audit log (who changed what, when) |
| `tailscale_get_network_flow_logs` | Get network traffic flow logs between devices |

</details>

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
npm test
```

Test against your own tailnet by setting `TAILSCALE_API_KEY` and running:

```bash
node dist/index.js
```

## License

MIT
