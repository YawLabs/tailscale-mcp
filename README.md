# @yawlabs/tailscale-mcp

A Tailscale MCP server for managing your tailnet from AI assistants. 43 tools covering devices, ACLs, DNS, auth keys, users, webhooks, and more.

Built and maintained by [YawLabs](https://yaw.sh).

## Why this one?

- **Preserves ACL formatting** — reads and writes HuJSON (comments, trailing commas, indentation). Other MCP servers compact your carefully formatted policy into a single line.
- **Safe ACL updates** — uses ETags to prevent overwriting concurrent changes. Get the ACL, edit it, pass the ETag back. No silent data loss.
- **Zero restarts** — the server always starts, even with missing or invalid credentials. Auth errors surface as clear tool-call errors, not silent crashes.
- **One env var setup** — no config files, no setup wizards, no multi-step flows.
- **Every tool verified** — tested against the real Tailscale API. No placeholder endpoints that 404.

## Setup

Add to your Claude Code, Cursor, or MCP client config:

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

That's it. Works on first try.

### Getting an API key

1. Go to [Tailscale Admin Console > Settings > Keys](https://login.tailscale.com/admin/settings/keys)
2. Generate an API key
3. Paste it into the config above

### OAuth (optional, for scoped access)

For fine-grained permissions, use OAuth instead of an API key:

```json
{
  "mcpServers": {
    "tailscale": {
      "command": "npx",
      "args": ["-y", "@yawlabs/tailscale-mcp"],
      "env": {
        "TAILSCALE_OAUTH_CLIENT_ID": "...",
        "TAILSCALE_OAUTH_CLIENT_SECRET": "..."
      }
    }
  }
}
```

Create an OAuth client at [Tailscale Admin Console > Settings > OAuth](https://login.tailscale.com/admin/settings/oauth).

### Tailnet

By default, the server uses your default tailnet. To specify one explicitly, set `TAILSCALE_TAILNET` in env.

## Tools

### Status

| Tool | Description |
|------|-------------|
| `tailscale_status` | Verify API connection, see tailnet info and device count |

### Devices

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
| `tailscale_set_device_tags` | Set ACL tags on a device |

### ACL / Policy

| Tool | Description |
|------|-------------|
| `tailscale_get_acl` | Get ACL policy with formatting preserved (HuJSON) + ETag |
| `tailscale_update_acl` | Update ACL policy (requires ETag for safe concurrent edits) |
| `tailscale_validate_acl` | Validate a policy without applying it |
| `tailscale_preview_acl` | Preview rules that would apply to a user or IP |

### DNS

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

### Auth Keys

| Tool | Description |
|------|-------------|
| `tailscale_list_keys` | List auth keys |
| `tailscale_get_key` | Get details for an auth key |
| `tailscale_create_key` | Create a new auth key |
| `tailscale_delete_key` | Delete an auth key |

### Users

| Tool | Description |
|------|-------------|
| `tailscale_list_users` | List all users in the tailnet |
| `tailscale_get_user` | Get details for a specific user |

### Tailnet Settings

| Tool | Description |
|------|-------------|
| `tailscale_get_tailnet_settings` | Get tailnet settings |
| `tailscale_update_tailnet_settings` | Update tailnet settings |
| `tailscale_get_contacts` | Get tailnet contacts |
| `tailscale_set_contacts` | Set tailnet contacts |
| `tailscale_get_tailnet_keys` | Get auth keys and tailnet lock signing key info |

### Webhooks

| Tool | Description |
|------|-------------|
| `tailscale_list_webhooks` | List webhooks |
| `tailscale_get_webhook` | Get a specific webhook |
| `tailscale_create_webhook` | Create a webhook |
| `tailscale_delete_webhook` | Delete a webhook |

### Posture Integrations

| Tool | Description |
|------|-------------|
| `tailscale_list_posture_integrations` | List posture integrations |
| `tailscale_get_posture_integration` | Get a posture integration |
| `tailscale_create_posture_integration` | Create a posture integration |
| `tailscale_delete_posture_integration` | Delete a posture integration |

### Audit Log

| Tool | Description |
|------|-------------|
| `tailscale_get_audit_log` | Get configuration audit log (who changed what, when) |

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

## License

MIT
