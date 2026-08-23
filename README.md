# @yawlabs/tailscale-mcp

[![npm version](https://img.shields.io/npm/v/@yawlabs/tailscale-mcp)](https://www.npmjs.com/package/@yawlabs/tailscale-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/tailscale-mcp)](https://github.com/YawLabs/tailscale-mcp/stargazers)
[![Release](https://img.shields.io/badge/release-local-blue)](./release.sh)

**Ask your agent questions about your tailnet and have it act on the answers.** 94 admin-API tools + 6 optional local-CLI diagnostics + 4 resources spanning the [Tailscale v2 API](https://tailscale.com/api) — devices, ACLs, DNS, keys and trust credentials, users, invites, webhooks, log streaming, posture, services, and organization tailnets. Backed by 1100+ unit tests and an opt-in live-tailnet integration suite.

Built and maintained by [Yaw Labs](https://yaw.sh).

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=Tailscale&command=npx&args=-y%2C%40yawlabs%2Ftailscale-mcp&description=Manage%20your%20Tailscale%20tailnet%20-%20devices%2C%20ACLs%2C%20DNS%2C%20keys&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Ftailscale-mcp)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Or install manually below.

## What's the point if the API already exists?

You could `curl` the Tailscale API. The point isn't replacing `curl` — it's letting an agent compose multi-endpoint workflows in one turn without writing a script:

- **"Which devices haven't checked in for 30 days and have key expiry disabled?"** — lists devices, filters by `lastSeen`, filters by `keyExpiryDisabled`, returns a table. Three endpoints, one question.
- **"Someone broke DNS at 2am — who changed what in the last 24 hours?"** — pulls the audit log, filters by DNS-related actors and endpoints, reads each change's before/after, summarizes in English.
- **"Draft an ACL change that lets `tag:mobile` reach `tag:dashboard` but not `tag:db`, preserving my comments"** — reads the current HuJSON, proposes a minimal diff, validates it against the API, returns the diff for you to apply.
- **"Rotate every auth key older than 90 days and print the new ones"** — iterates, creates new keys with matching tags, revokes the old ones.
- **"Create an OAuth client for our CI pipeline scoped to `devices:read` and `dns`"** — creates a trust credential via `tailscale_create_key` with `keyType=client`, returns the credentials once (save them immediately).

A curl can do each step. The agent composes them. That's where the lift is, and that's what the tool surface is designed for — every read endpoint is first-class so the agent can synthesize, and every write endpoint is tagged `destructiveHint` or `idempotentHint` so your MCP client can gate mutations the way you configured it.

If all you need is one endpoint in a CI job, use `curl` — we even have a [CLI subcommand](#gitops-deploy-acls-from-ci) for the common ACL-from-git case. The MCP is for the interactive, exploratory, "I don't know what I need yet" work.

## Why MCP vs. a skill or the `tailscale` CLI?

Reasonable question. Both have their place. Where this MCP is better:

- **Broad admin API coverage.** The `tailscale` CLI is scoped to the node it runs on. Admin concerns — ACLs, users, invites, webhooks, log streaming, posture integrations, auth keys, OAuth clients, and federated identities — live in the v2 HTTP API. You'd be shelling out to `curl` anyway.
- **Typed tool surface, not string parsing.** Every tool has a Zod-validated input schema and a structured response. No brittle `tailscale status --json | jq` pipelines that break when the schema evolves.
- **Cross-client, no user rewriting.** A Claude Code skill only loads in Claude Code. An MCP server works in Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, and anything else that speaks MCP. Version bumps ship through `npx` — users don't re-author their skill when Tailscale adds an endpoint.
- **Safe-by-default writes.** Every tool declares `readOnlyHint` / `destructiveHint` / `idempotentHint` so clients can skip confirmation on reads and require it on mutations. A skill that shells out to the CLI can't express that.
- **Real tests.** 700+ unit tests covering every tool's input validation, API shape, and error handling. Plus an opt-in live-tailnet integration suite (`RUN_INTEGRATION_TESTS=1` + a tailnet API key) for shape-drift detection. Most skills are short markdown prompts without their own test layer — if the vendor changes output format, nothing catches it for you.

If you already have a skill that covers your 10% of Tailscale workflows, great — keep it. The MCP is for the other 90%.

## Trust signals

Fair critique from Reddit: a new repo claiming "actively maintained" with no visible tests is worth exactly zero trust. Here's what's actually verifiable:

- **700+ tests** (`node --test`) covering every tool's input validation, API shape, and error handling. Run `npm test` to see them pass locally.
- **Local release flow** via [`release.sh`](./release.sh): lint + test + bump + tag + push + npm publish + MCP Registry publish, all from the workstation. No CI workflow to babysit.
- **Dependabot alerts** surface on this repo and get fixed, not ignored.
- **Every tool verified against the live API.** If it's in the tool list, it calls a real endpoint that exists in the current v2 API. No placeholder 404 tools.

Issues and PRs are triaged. File one if something is off — [github.com/YawLabs/tailscale-mcp/issues](https://github.com/YawLabs/tailscale-mcp/issues).

## Quick start

**1. Set your API key**

Get an API key from [Tailscale Admin Console > Settings > Keys](https://console.tailscale.com/admin/settings/keys) and add it to your shell profile (`~/.bashrc`, `~/.zshrc`, or Windows system environment variables):

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
      "args": ["-y", "@yawlabs/tailscale-mcp@latest"]
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
      "args": ["/c", "npx", "-y", "@yawlabs/tailscale-mcp@latest"]
    }
  }
}
```

> **Why the extra step on Windows?** On Windows, `npx` is a `.cmd` file, and Node 20+ refuses to spawn `.cmd` files directly. Wrapping with `cmd /c` is the standard workaround.

**3. Restart and approve**

Restart Claude Code (or your MCP client) and approve the Tailscale MCP server when prompted.

That's it. Now ask your agent:

> "List my Tailscale devices that haven't been seen in the last 7 days"
>
> "Summarize every ACL change in the audit log from yesterday"
>
> "Draft an ACL rule that lets `tag:ci` reach `tag:registry` on port 5000 only"

## Too many tools? Subset them.

94 tools is a lot. If you've already got a dozen MCP servers and your client is feeling heavy, trim what this one exposes. Three knobs, combinable:

### Option 1: `TAILSCALE_PROFILE` (preset, easiest)

```json
{
  "env": {
    "TAILSCALE_API_KEY": "tskey-api-...",
    "TAILSCALE_PROFILE": "core"
  }
}
```

- **`minimal`** (20 tools) — `status`, `devices`, `audit`. Observe the tailnet, read the audit log.
- **`core`** (49 tools) — adds `acl`, `dns`, `keys`, `users`. The day-to-day admin surface.
- **`full`** (94 tools, default) — everything. Same as omitting the env var.

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

Valid group names: `status`, `devices`, `acl`, `dns`, `keys`, `users`, `tailnet`, `webhooks`, `posture`, `audit`, `invites`, `services`, `log-streaming`. The `local-cli` group is also available, but only when `TAILSCALE_LOCAL_CLI=1` is set — see [Local CLI integration](#local-cli-integration-opt-in).

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
@yawlabs/tailscale-mcp v0.12.0 ready (20 tools, profile=minimal, readonly)
```

When both `TAILSCALE_PROFILE` and `TAILSCALE_TOOLS` are set, `TAILSCALE_TOOLS` wins. The banner marks the profile as overridden so the precedence is obvious at a glance — no need to guess which filter actually applied:

```
@yawlabs/tailscale-mcp v0.12.0 ready (21 tools, profile=core (overridden by TAILSCALE_TOOLS), groups=devices,acl)
```

The "(overridden)" marker only fires for substantive profiles (`minimal` / `core`); `profile=full` is a no-op preset, so it's shown without the marker when `TAILSCALE_TOOLS` is also set.

If you don't set any filter, startup prints a tip pointing you at the profiles.

## Using with mcp.hosting / mcph

If you run this server through [mcp.hosting](https://mcp.hosting) (via the `@yawlabs/mcph` local agent), the two filtering layers compose cleanly:

1. **Server-side** — `TAILSCALE_PROFILE` / `TAILSCALE_TOOLS` / `TAILSCALE_READONLY` reduce the tool surface *before* mcph sees it. The unloaded tools aren't registered at all.
2. **Client-side** — mcph's `mcp_connect_activate({ tools: [...] })` filters further for what appears in `tools/list`. Tools not in that list stay reachable via `mcp_connect_dispatch`, so you don't lose capability.

Recommended pattern for mcph users: set `TAILSCALE_PROFILE=core` (or narrower) in your mcp.hosting server config, then let mcph handle per-conversation activation on top. The server stays lean by default, and `mcp_connect_dispatch` covers the long-tail tools for ad-hoc needs.

## Authentication

**API key (simplest):** Set `TAILSCALE_API_KEY` in your shell or MCP config.

**OAuth (scoped access):** For fine-grained permissions, set `TAILSCALE_OAUTH_CLIENT_ID` and `TAILSCALE_OAUTH_CLIENT_SECRET` instead. Create an OAuth client at [Tailscale Admin Console > Settings > OAuth](https://console.tailscale.com/admin/settings/oauth).

The server checks for an API key first, then falls back to OAuth. If neither is set, tools return a clear error telling you what to configure — the server still starts, so your MCP client doesn't loop restarting.

**Tailnet:** Uses your default tailnet automatically. Set `TAILSCALE_TAILNET` to specify one explicitly.

**`TAILSCALE_OAUTH_TAILNET`** — target an **API-only tailnet** (one created by `tailscale_create_org_tailnet`). Those tailnets are not reachable with a plain client-credentials exchange: you authenticate with an OAuth client belonging to the *creating* tailnet (`all` scope) and the target rides on the token request. Set this to the new tailnet's id. Deliberately separate from `TAILSCALE_TAILNET` so the default token exchange is unchanged for everyone else.

## Reliability and debugging

**429 retry (built-in).** API responses with HTTP 429 are retried up to 3 times, honoring the `Retry-After` header (both seconds-integer and HTTP-date forms). Falls back to exponential backoff with jitter, capped at 30s per wait. No env var needed — this is on by default. Workflows like "rotate every key older than 90 days" no longer fail mid-loop on Tailscale's per-tenant rate limits.

**`TAILSCALE_DEBUG=1`** — log every HTTP method, URL, status, and elapsed time to stderr. Authorization headers are never logged. Use this when a tool returns an unexpected error and you want to see the actual request that went out. Example:

```
[tailscale-mcp] GET https://api.tailscale.com/api/v2/tailnet/-/devices
[tailscale-mcp]   <- 200 (148ms)
```

**`TAILSCALE_MAX_CONCURRENT=N`** — cap in-flight API requests at `N`. Default is unlimited (no behavior change for users who don't opt in). Useful when an agent fans out aggressively against a tailnet that has stricter limits than the per-call retry can absorb.

**`TAILSCALE_REQUEST_BUDGET_MS=N`** — total wall-clock budget per request, including 429 retries and their sleeps. Default `90000` (90s). When the next retry's predicted wall time would exceed the budget, the call surfaces the 429 immediately instead of holding the line. Tune lower if your MCP client has a tighter outer timeout. 429s on non-idempotent methods (POST, PATCH) are never retried — those return immediately regardless of budget.

**`TAILSCALE_RETRY_BASE_DELAY_MS=N`** — base delay for the exponential backoff between retries; attempt `N` waits `base * 2^N` (capped at 30s, plus jitter). Default `1000` (1s), so a fully-exhausted retry chain spends roughly 1s + 2s + 4s sleeping. Pairs with `TAILSCALE_REQUEST_BUDGET_MS`: lowering the budget on its own doesn't get you more retries, it just makes the default backoff exhaust the budget sooner and give up. Shrink both if you want "retry hard, fail fast". A server-supplied `Retry-After` header always wins over this value.

**`TAILSCALE_EXTRA_WEBHOOK_EVENTS=eventA,eventB`** — opt-in escape hatch for webhook event types Tailscale ships after the latest release of this package. The webhook tools validate `subscriptions` against a strict static catalog so typos and stale event names fail fast with a clear error; if you need a brand-new event before the catalog catches up, list it here (comma-separated) and the schema will accept it. Please also [open an issue](https://github.com/YawLabs/tailscale-mcp/issues) so the static list catches up.

**`TAILSCALE_EXTRA_POSTURE_PROVIDERS=providerA,providerB`** — the same escape hatch for device-posture integration providers. `tailscale_create_posture_integration` validates `provider` against a static list (`falcon`, `fleet`, `huntress`, `intune`, `jamfpro`, `kandji`, `kolide`, `sentinelone`); if Tailscale adds one before this package catches up, list it here rather than waiting for a release. This field used to be a closed enum, which made a newly-supported provider *uncreatable* rather than merely unvalidated.

**Friendlier error messages.** JSON error bodies of the form `{"message":"..."}` or `{"error":"..."}` are unwrapped before display, so you see the prose explanation instead of raw JSON. 401s still get the full multi-line auth-error formatter (with the Windows env-var hint when applicable).

## Local CLI integration (opt-in)

Most tools talk to the Tailscale v2 admin API — they describe **the tailnet**. Sometimes you want to ask about **this machine's** view: is it actually connected? What DERP region is it on? How far is `my-laptop` from here? Those answers come from the local `tailscale` binary, not the admin API.

Set `TAILSCALE_LOCAL_CLI=1` (in your shell or `.mcp.json` `env` block) to add six read-only diagnostic tools:

| Tool | Equivalent CLI command | Use it for |
|---|---|---|
| `tailscale_local_status` | `tailscale status --json` | This machine's connection state + peers it can see |
| `tailscale_ping` | `tailscale ping <target>` | Latency probe to another tailnet node (direct vs DERP-relayed) |
| `tailscale_netcheck` | `tailscale netcheck --format=json` | NAT type, DERP latency map, IPv4/IPv6 support |
| `tailscale_local_version` | `tailscale version` | Which client version is actually running |

Requirements: the `tailscale` binary must be in `PATH`. If it's installed somewhere unusual, set `TAILSCALE_BINARY` to its absolute path. The MCP server doesn't need root to run these — they're all diagnostic, not state-mutating. Operations that would need elevation (`tailscale up`, `set --advertise-routes`, `lock sign`) are deliberately not exposed.

When opt-in is on, the startup banner reflects it: `@yawlabs/tailscale-mcp v0.13.3 ready (100 tools, local-cli=on)` — the 6 local CLI tools are additive on top of the default 94.

## Resources (4)

MCP Resources expose read-only data clients can browse without a tool call.

| Resource | URI | Description |
|----------|-----|-------------|
| Tailnet Status | `tailscale://tailnet/status` | Device count and tailnet settings |
| Devices | `tailscale://tailnet/devices` | All devices with status and IPs |
| ACL Policy | `tailscale://tailnet/acl` | Full ACL policy (HuJSON preserved) |
| DNS Config | `tailscale://tailnet/dns` | Nameservers, search paths, split DNS, MagicDNS |

## Tools (94 + 6 opt-in)

<details>
<summary><strong>Status</strong> (1 tool)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_status` | Verify API connection, see tailnet info and device count |

</details>

<details>
<summary><strong>Devices</strong> (17 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_devices` | List all devices with status, IPs, OS, and last seen |
| `tailscale_get_device` | Get detailed info for a specific device |
| `tailscale_authorize_device` | Authorize a pending device |
| `tailscale_deauthorize_device` | Deauthorize a device |
| `tailscale_set_devices_authorized` | Authorize/deauthorize many devices in one call (parallel, per-id error reporting) |
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
<summary><strong>Keys / Trust Credentials</strong> (7 tools) — covers auth keys, OAuth clients, federated identities, and OAuth apps</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_keys` | List keys (auth keys; pass `all=true` to include OAuth clients and federated identities) |
| `tailscale_get_key` | Get details for a key |
| `tailscale_create_key` | Create an auth key, OAuth client (`keyType=client`), or federated identity (`keyType=federated`) |
| `tailscale_delete_key` | Delete a key |
| `tailscale_update_key` | Update a key's description, scopes, tags, or federated claim settings |
| `tailscale_create_oauth_app` | Create an OAuth App for third-party device provisioning (Tailscale alpha) |
| `tailscale_get_oauth_app` | Get an OAuth App's name, redirect URIs, and scopes |

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
<summary><strong>Organization Tailnets</strong> (3 tools) — API-only tailnets; OAuth authentication required</summary>

Create and tear down whole tailnets programmatically — useful for per-agent sandboxes,
per-tenant isolation, and ephemeral CI environments. Unlike every other group here these
endpoints live under `/organizations`, authenticate **only** with an OAuth client (the
`tailnets` scope to create, `all` to then reach the tailnet), and produce tailnets that are
not managed in the admin console. Set `TAILSCALE_OAUTH_TAILNET` to operate on one.

| Tool | Description |
|------|-------------|
| `tailscale_list_org_tailnets` | List the organization's tailnets (paginated via `limit` / `cursor`) |
| `tailscale_create_org_tailnet` | Create an API-only tailnet; returns its OAuth client secret **once** |
| `tailscale_delete_tailnet` | Delete the configured tailnet — irreversible; requires `confirmTailnet` to match |

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

<details>
<summary><strong>Local CLI</strong> (6 tools, opt-in) — see <a href="#local-cli-integration-opt-in">Local CLI integration</a></summary>

| Tool | Description |
|------|-------------|
| `tailscale_local_status` | This machine's view of the tailnet (own connection state, peers, DERP region) |
| `tailscale_ping` | Latency probe to another tailnet node from this machine |
| `tailscale_netcheck` | NAT type, DERP latency map, IPv4/IPv6 support diagnostics |
| `tailscale_local_version` | Local `tailscale` binary version |
| `tailscale_local_whoami` | Which user and device this machine is authenticated as (needs tailscale >= 1.102.1) |
| `tailscale_local_service_list` | Tailscale Services visible to *this* node (needs tailscale >= 1.102.1) |

</details>

## GitOps: deploy ACLs from CI

For the simple "deploy ACL from git on merge" workflow, you don't need an MCP server or an agent — use the built-in CLI:

```bash
# PR check: validate the proposed policy without touching the tailnet
npx -y @yawlabs/tailscale-mcp@latest validate-acl tailscale/acl.json

# On merge: ETag fetch + validate + deploy with If-Match, fail-closed at every step
npx -y @yawlabs/tailscale-mcp@latest deploy-acl tailscale/acl.json
```

Works in any CI system. Set `TAILSCALE_API_KEY` and `TAILSCALE_TAILNET` as env vars. Both commands exit non-zero on any failure; `deploy-acl` refuses to deploy without an ETag (so a concurrent Admin Console edit can never be silently clobbered) and reports a 412 as a concurrent-edit conflict you resolve by re-running.

A complete GitHub Actions workflow — validate on PR, deploy on merge:

```yaml
name: tailscale-acl
on:
  pull_request:
    paths: ["tailscale/acl.json"]
  push:
    branches: [main]
    paths: ["tailscale/acl.json"]

jobs:
  acl:
    runs-on: ubuntu-latest
    env:
      TAILSCALE_API_KEY: ${{ secrets.TAILSCALE_API_KEY }}
      TAILSCALE_TAILNET: your-tailnet.ts.net # or omit: defaults to the key's tailnet
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: Validate ACL
        if: github.event_name == 'pull_request'
        run: npx -y @yawlabs/tailscale-mcp@latest validate-acl tailscale/acl.json
      - name: Deploy ACL
        if: github.event_name == 'push'
        run: npx -y @yawlabs/tailscale-mcp@latest deploy-acl tailscale/acl.json
```

For reproducible deploys, replace `@latest` with a pinned version.

> **If you hand-roll this with `curl` instead:** Tailscale's ACL endpoint only returns the `ETag` header on **GET**, not HEAD. A `curl -I` (HEAD) ETag fetch silently yields an empty value — and an empty `If-Match` either deploys unguarded (clobbering concurrent edits) or trips your guard and fails the deploy. Fetch the ETag with a GET (`curl -fsS -D - -o /dev/null ...`), and fail the job if it comes back empty. The CLI above does all of this for you.

**Optional:** Lock the Admin Console to prevent manual edits that drift from git. Ask your agent:

> "Set aclsExternallyManagedOn to true and aclsExternalLink to our repo URL"

This shows a read-only banner in the Tailscale Admin Console pointing to your repo. Use the MCP for reads and investigations, and let CI handle the deploy.

## Requirements

- Node.js 20+ to run the server (22+ to develop — the test script passes a glob to `node --test`, supported from Node 21)
- A Tailscale API key or OAuth client credentials

## Running on oam.js (optional)

[oam.js](https://oamjs.org) runs this server unmodified. Verified against oam 0.9.0: full MCP handshake, all 94 tools, all 4 resources, identical error messages, and a clean stdout protocol stream — from the shipped bundle *and* straight from the TypeScript source with no build step.

**oam 0.9.0 is the minimum.** Older releases ran `child_process.execFile` arguments through a shell, re-splitting them on whitespace and executing shell metacharacters inside an argument. This server shells out to the `tailscale` binary across its local-CLI tools, so that was a reachable bug rather than a theoretical one. The launcher enforces the floor: given an older oam it falls back to Node and says so on stderr, and `TAILSCALE_MCP_RUNTIME=oam` turns that into a hard error.

### Sandboxing (opt-in)

Set `TAILSCALE_MCP_SANDBOX=1` to run under oam's `--permission` model: network restricted to `api.tailscale.com` and `login.tailscale.com`, filesystem denied. Child-process stays granted because the local-CLI tools shell out to the `tailscale` binary, which is also why `PATH` remains in the environment allow-list.

It is opt-in rather than default because a wrong grant does not fail loudly. oam denies a non-granted environment variable by making it **absent** from `process.env` rather than throwing, so an under-granted `TAILSCALE_API_KEY` reads as "unauthenticated" rather than "denied". The env allow-list in the launcher is derived from what the shipped bundle actually reads -- if you add a new `process.env` lookup, extend that list with it.

```jsonc
{
  "mcpServers": {
    "tailscale": {
      "command": "oam",
      "args": ["run", "/path/to/tailscale-mcp/dist/index.js"],
      "env": { "TAILSCALE_API_KEY": "tskey-api-..." }
    }
  }
}
```

**Node stays the default, deliberately.** An MCP client cold-starts this server once per session, so startup is the cost that actually gets paid, and on the machine this was measured on node won it — 437ms vs 1554ms for `oam run` over 10 warmed runs (an earlier 5-run round showed 326ms vs 427ms; the box was busy, so treat the magnitude as noisy and the direction as the finding). Preferring oam automatically would mean either a launcher that probes for it on every start — a cost paid by everyone, including the majority who do not have oam — or making oam a hard requirement. Neither is worth it to reach a runtime that is not faster here. Measure on your own hardware before concluding anything; if oam wins on yours, the config above is all you need.

Two places oam *does* win for this repo, both opt-in and neither touching the npm package:

- **`npm run check:oam`** — type-checks via `oam check` (tsgo, TypeScript 7 native). Measured 4015ms against 7680ms for `tsc --noEmit`, same clean result. `npx tsc --noEmit` remains the portable default.
- **`npm run build:binary:oam`** — builds the standalone binary via `oam compile` instead of Node SEA. Measured ~57.7 MB against ~73.6 MB for the Node SEA carrier *before* its blob is injected. Writes to the same `bin/<platform>-<arch>/` path as `npm run build:binary`, so the release staging script consumes either unchanged — run one or the other. If you redistribute that binary it embeds oam's runtime, so ship oam's `LICENSE`, `NOTICE` and `THIRD_PARTY_LICENSES.md` with it.

The source stays runtime-agnostic on purpose: no `oam:` imports anywhere, and tests stay on `node:test`. That is what keeps the Node fallback real rather than nominal. Note that any `oam` invocation writes a bytecode cache to `oam/` in the working directory — already in `.gitignore`.

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow and AI-agent guidelines. Please [open an issue](https://github.com/YawLabs/tailscale-mcp/issues) to discuss before a PR for anything beyond a typo fix.

```bash
git clone https://github.com/YawLabs/tailscale-mcp.git
cd tailscale-mcp
npm install
npm run lint       # Biome check
npm run lint:fix   # Auto-fix
npm run build      # tsc + esbuild bundle
npm test           # node --test (full suite)
```

For integration testing against your own tailnet: set `TAILSCALE_API_KEY` and run `node dist/index.js`.

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md) — please use GitHub's private vulnerability reporting, not a public issue.

## License

MIT
