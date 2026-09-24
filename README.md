# @yawlabs/tailscale-mcp

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=Tailscale&command=npx&args=-y%2C%40yawlabs%2Ftailscale-mcp&description=Manage%20your%20Tailscale%20tailnet%20-%20devices%2C%20ACLs%2C%20DNS%2C%20keys&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Ftailscale-mcp)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Or install manually below.

[![npm version](https://img.shields.io/npm/v/@yawlabs/tailscale-mcp)](https://www.npmjs.com/package/@yawlabs/tailscale-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/tailscale-mcp)](https://github.com/YawLabs/tailscale-mcp/stargazers)
[![Release](https://img.shields.io/badge/release-local-blue)](./release.sh)

**Ask your agent questions about your tailnet and have it act on the answers.** 97 admin-API tools + 6 optional local-CLI diagnostics + 1 always-on catalog tool + 4 resources spanning the [Tailscale v2 API](https://tailscale.com/api) — devices, ACLs, DNS, keys and trust credentials, users, invites, webhooks, log streaming, posture, services, and organization tailnets. Backed by 1900+ unit tests and an opt-in live-tailnet integration suite.

Built and maintained by [Yaw Labs](https://yaw.sh).

## What's the point if the API already exists?

You could `curl` the Tailscale API. The point isn't replacing `curl` — it's letting an agent compose multi-endpoint workflows in one turn without writing a script:

- **"Which devices haven't checked in for 30 days and have key expiry disabled?"** — lists devices, filters by `lastSeen` (online devices carry none), filters by `keyExpiryDisabled`, returns a table. Three endpoints, one question.
- **"Someone broke DNS at 2am — who changed what in the last 24 hours?"** — pulls the audit log, filters by DNS-related actors and endpoints, reads each change's before/after, summarizes in English.
- **"Draft an ACL change that lets `tag:mobile` reach `tag:dashboard` but not `tag:db`, preserving my comments"** — reads the current HuJSON, proposes a minimal diff, validates it against the API, returns the diff for you to apply.
- **"Rotate every auth key older than 90 days and print the new ones"** — iterates, creates new keys with matching tags, revokes the old ones.
- **"Create an OAuth client for our CI pipeline scoped to `devices:core:read` and `dns:read`"** — creates a trust credential via `tailscale_create_key` with `keyType=client`, returns the credentials once (save them immediately).

A curl can do each step. The agent composes them. That's where the lift is, and that's what the tool surface is designed for — every read endpoint is first-class so the agent can synthesize, and every write endpoint is tagged `destructiveHint` or `idempotentHint` so your MCP client can gate mutations the way you configured it.

If all you need is one endpoint in a CI job, use `curl` — we even have a [CLI subcommand](#gitops-deploy-acls-from-ci) for the common ACL-from-git case. The MCP is for the interactive, exploratory, "I don't know what I need yet" work.

## Why MCP vs. a skill or the `tailscale` CLI?

Reasonable question. Both have their place. Where this MCP is better:

- **Broad admin API coverage.** The `tailscale` CLI is scoped to the node it runs on. Admin concerns — ACLs, users, invites, webhooks, log streaming, posture integrations, auth keys, OAuth clients, and federated identities — live in the v2 HTTP API. You'd be shelling out to `curl` anyway.
- **Typed tool surface, not string parsing.** Every tool has a Zod-validated input schema and a structured response. No brittle `tailscale status --json | jq` pipelines that break when the schema evolves.
- **Cross-client, and updates arrive as a version bump.** An MCP server works in Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, and anything else that speaks MCP; a skill written to the Agent Skills standard travels between agents too, but it is prose you maintain. Version bumps ship through `npx` — nobody rewrites a skill's instructions when Tailscale adds an endpoint.
- **Safe-by-default writes.** Every tool declares `readOnlyHint` / `destructiveHint` / `idempotentHint` so clients can skip confirmation on reads and require it on mutations. A skill that shells out to the CLI can't express that.
- **Real tests.** 1900+ unit tests covering every tool's input validation, API shape, and error handling. Plus an opt-in live-tailnet integration suite (`RUN_INTEGRATION_TESTS=1` + a tailnet API key) for shape-drift detection. Most skills are short markdown prompts without their own test layer — if the vendor changes output format, nothing catches it for you.

If you already have a skill that covers your 10% of Tailscale workflows, great — keep it. The MCP is for the other 90%.

**What about Tailscale's own MCP endpoints and skill?** As of 2026-09-19 they solve different problems, and nothing here duplicates them. Tailscale's official MCP tools are two alpha [built-in connectors](https://tailscale.com/docs/aperture/connectors/built-in-connectors) inside Aperture: *Tailnet*, whose `Tailnet_provision_node` returns a single-use auth key so an agent can join one new node after a person approves it, and *Tailscale SSH*, whose `TailnetSSH_list_machines` and `TailnetSSH_run_command` discover SSH-enabled machines and run one command on one of them. They require Aperture. [`tailscale/tailscale-skill`](https://github.com/tailscale/tailscale-skill) is an alpha, knowledge-only skill — reference material that teaches an agent to `curl` the v2 API, with no server of its own. Neither exposes the admin API as typed tools, so the overlap with this server is close to nil. Nor can Aperture front this one today: this server speaks stdio, and Aperture proxies only URL-addressable Streamable-HTTP or SSE servers. Both of those products are alpha, so treat the date on this paragraph as its expiry.

## Trust signals

Fair critique from Reddit: a new repo claiming "actively maintained" with no visible tests is worth exactly zero trust. Here's what's actually verifiable:

- **1900+ tests** (`node --test`) covering every tool's input validation, API shape, and error handling. Run `npm test` to see them pass locally.
- **Local release flow** via [`release.sh`](./release.sh): lint + test + bump + tag + push + npm publish + MCP Registry publish, all from the workstation. No CI workflow to babysit.
- **Dependabot alerts** surface on this repo and get fixed, not ignored.
- **Every tool verified against the live API.** If it's in the tool list, it calls a real endpoint that exists in the current v2 API. No placeholder 404 tools.

Issues and PRs are triaged. File one if something is off — [github.com/YawLabs/tailscale-mcp/issues](https://github.com/YawLabs/tailscale-mcp/issues).

## Quick start

**1. Set your API key**

Get an API key from [Tailscale Admin Console > Settings > Keys](https://console.tailscale.com/admin/settings/keys) and set it where your MCP client will see it. The `.mcp.json` `env` block in step 2 works identically on every platform and is the option to prefer; to export it from a shell profile instead (`~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish`):

macOS / Linux / WSL (bash, zsh):

```bash
export TAILSCALE_API_KEY="tskey-api-..."
```

fish:

```fish
set -Ux TAILSCALE_API_KEY tskey-api-...
```

Windows (PowerShell 5.1 and 7) — `[Environment]::SetEnvironmentVariable` persists it for the user, where `$env:` alone lasts only for the session:

```powershell
[Environment]::SetEnvironmentVariable('TAILSCALE_API_KEY', 'tskey-api-...', 'User')
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

97 tools is a lot. If you've already got a dozen MCP servers and your client is feeling heavy, trim what this one exposes. Three knobs, combinable:

> The `env` blocks below show only the variable under discussion. Your credentials come from the environment, as set in [Quick start](#quick-start) — keep them in your shell profile rather than in the client's JSON config, which is world-readable on most systems and easy to commit by accident.

### Option 1: `TAILSCALE_PROFILE` (preset, easiest)

```json
{
  "env": {
    "TAILSCALE_PROFILE": "core"
  }
}
```

- **`minimal`** (20 tools) — `status`, `devices`, `audit`. Observe the tailnet, read the audit log.
- **`core`** (52 tools) — adds `acl`, `dns`, `keys`, `users`. The day-to-day admin surface.
- **`full`** (97 tools, default) — everything. Same as omitting the env var.

### Option 2: `TAILSCALE_TOOLS` (explicit group list)

```json
{
  "env": {
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
@yawlabs/tailscale-mcp v0.12.0 ready (22 tools, profile=core (overridden by TAILSCALE_TOOLS), groups=devices,acl)
```

The "(overridden)" marker only fires for substantive profiles (`minimal` / `core`); `profile=full` is a no-op preset, so it's shown without the marker when `TAILSCALE_TOOLS` is also set.

If you don't set any filter, startup prints a tip pointing you at the profiles.

### And how the *agent* knows

Everything above is stderr -- your MCP client's log. The model never sees it, so a
withheld tool and a tool that was never built look identical from the agent's side.
That is how an agent ends up working around a restriction instead of reporting it.

`tailscale_tool_groups` closes that gap. It is **always registered**, whatever the
filters say, and answers the question in-band:

```
> "Why can't you delete that device?"

  tailscale_tool_groups({ toolName: "tailscale_delete_device" })

  {
    "tool": "tailscale_delete_device",
    "available": false,
    "group": "devices",
    "kind": "write",
    "reason": "TAILSCALE_WRITE_GROUPS is set to \"dns\", which does not grant writes here",
    "toEnable": "add \"devices\" to TAILSCALE_WRITE_GROUPS (e.g. \"dns,devices\")"
  }
```

It separates the three cases an agent otherwise cannot tell apart:

| Case | What the agent should do |
|---|---|
| No such tool exists, under any configuration | Find another approach -- no setting will produce it |
| Exists, but its group is not loaded | Report `toEnable` to you; do not work around it |
| Exists and loaded, but writes are withheld there | Same -- the fix is yours, not a workaround |

Called with no arguments it lists every group with its availability and, for anything
withheld, the exact environment change that would restore it. It reads no network and
needs no credentials, so it works even when the server is misconfigured.

## Scoping writes to areas

`TAILSCALE_WRITE_GROUPS` names the areas an agent may **write** to. Everything else stays readable:

```json
{
  "env": {
    "TAILSCALE_WRITE_GROUPS": "devices,keys"
  }
}
```

That serves all 41 read tools plus the 18 writes in `devices` and `keys`, and withholds the other 38 writes — the ACL, DNS, users, tailnet, webhooks, posture, services, invites, org-tailnets and log-streaming writes are simply not registered. Unset means no write gate, which is the shipped default.

> **Read this first: this filters the tool list, not your API token.** The server still holds one credential with full tailnet authority in every configuration. An agent that also has a shell can `curl api.tailscale.com` with that same token and do everything this knob withheld. Scope the Tailscale OAuth client itself to the areas you actually need ([scopes per tool group](#oauth-scopes-by-tool-group)) — that bound survives outside this process; this one does not. `TAILSCALE_WRITE_GROUPS` is the low-friction complement to credential scoping, not a replacement for it.

### What a grant actually contains

Group names are the same ones `TAILSCALE_TOOLS` uses. Writes per group:

| Group | Writes | Group | Writes |
|---|---|---|---|
| `devices` | 13 | `webhooks` | 5 |
| `invites` | 7 | `posture` | 3 |
| `dns` | 6 | `services` | 3 |
| `keys` | 5 | `tailnet` | 3 |
| `users` | 5 | `log-streaming` | 3 |
| `org-tailnets` | 2 | `acl` | 1 |

`status`, `audit` and the opt-in `local-cli` group contain no writes at all, so granting them does nothing.

**`devices` is the widest grant, and the one most likely to be set.** In a compose file `write=devices` reads like "device admin", but it hands over `delete_device`, `set_devices_authorized`, `expire_device`, `deauthorize_device`, `set_device_routes`, `set_device_tags` and `update_device_key` alongside `rename_device`. There is no finer setting: an honest "safe subset" of `devices` is `rename_device` alone, and a knob whose useful value is one tool is not a knob.

### Three grants are tailnet-admin-equivalent

`keys`, `users` and `acl` are not blocked — CI key rotation legitimately needs `keys` — but grant them knowing:

- **`keys`** — `tailscale_create_key` mints an OAuth client with whatever scopes the caller asks for, including `policy_file` and `all`. That credential outlives the agent's session and is not subject to this or any other setting here.
- **`users`** — `tailscale_update_user_role` accepts `owner`.
- **`acl`** — `tailscale_update_acl` rewrites policy for every principal in the tailnet.

The server prints this on startup when your grant includes one of them.

### What it does and does not bound

It bounds **where** an agent may write. It does not bound **severity within** a granted area: inside a granted group, writes run unattended, including the grant-direction ones. Pair it with `TAILSCALE_REQUIRE_APPROVAL=1` when a human is at the keyboard — but understand that for an unattended agent that pairing contributes nothing, because a never-prompt client *denies* those calls rather than prompting.

### Precedence, and what happens when you get it wrong

| Situation | Result |
|---|---|
| Unset, empty, whitespace, or commas-only | No write gate. `-e VAR` with no value must not silently revoke every write. |
| `TAILSCALE_READONLY=1` also set | Readonly wins; banner says `readonly (TAILSCALE_WRITE_GROUPS ignored)`. |
| A name is misspelled (`devises`) | **Grants nothing** and names the typo. Unlike `TAILSCALE_TOOLS`, there is no fallback — a typo'd write grant that fell back would hand over all 56 writes at the moment you were restricting them. |
| Partly misspelled (`devices,dnss`) | Grants the valid half, warns about the rest. |
| A granted group is not loaded by `TAILSCALE_TOOLS` / `TAILSCALE_PROFILE` | The grant has no effect; a separate warning says so, since the name is not a typo. |
| `none`, `all`, `off`, `*` | Not reserved words — they are unknown group names, so they grant nothing. Use `TAILSCALE_READONLY=1` for no writes, or leave this unset for all writes. The server points you at the right spelling. |

Names are case-sensitive, matching `TAILSCALE_TOOLS`.

**The upgrade contract:** upgrading this package can never widen the set of *areas* an agent may write to. A new group is in nobody's grant until a human types its name. It can, however, add tools inside an area you already granted — a pinned test makes that a reviewed line in the diff rather than a silent change.

The startup banner shows what applied:

```
@yawlabs/tailscale-mcp v0.19.0 ready (59 tools, write=devices,keys)
```

## Requiring approval on irreversible tools

`readOnlyHint` / `destructiveHint` are *advisory* — the MCP spec says clients MUST treat annotations as untrusted, and most don't gate on them. `TAILSCALE_REQUIRE_APPROVAL=1` adds a stronger signal that supported clients enforce:

```json
{
  "env": {
    "TAILSCALE_REQUIRE_APPROVAL": "1"
  }
}
```

Nine tools are then advertised with `_meta["anthropic/requiresUserInteraction"]`, which forces a confirmation prompt even when an allow-rule would otherwise auto-approve the call:

| Tool | Why it's on the list |
|---|---|
| `tailscale_update_acl` | Can lock every device out of the tailnet; the previous HuJSON (comments included) is gone unless you captured it |
| `tailscale_delete_device` | The device must re-enroll |
| `tailscale_delete_user` | No undelete |
| `tailscale_delete_tailnet` | Destroys an entire tailnet |
| `tailscale_delete_key` | The secret is never returned again |
| `tailscale_delete_oauth_app` | Same |
| `tailscale_delete_webhook` | Same |
| `tailscale_delete_log_stream_config` | Same |
| `tailscale_delete_posture_integration` | Same |

The line drawn is **"this server cannot undo it with information you still hold"**, which is narrower than the 23 tools annotated `destructiveHint: true`. `tailscale_suspend_user` is deliberately *excluded* — `tailscale_restore_user` reverses it. So are `tailscale_deauthorize_device` (reversed by `tailscale_authorize_device`) and the replace-all setters, which all have a `get_*` counterpart you can read before writing.

**Opt-in on purpose, and read this before turning it on.** In a client mode that never prompts (an unattended agent, a CI run), the flag causes those calls to be **denied** rather than run. That is the right default when a human is at the keyboard and the wrong one when nobody is, so it stays off unless you set it.

Requires a client that honors the annotation; Claude Code added support in v2.1.199. Clients that don't recognize it ignore it, so setting the variable is never worse than leaving it off.

Separately and always on, the tools whose response size scales with the tailnet rather than with the request — `tailscale_list_devices`, `tailscale_list_users`, `tailscale_get_acl`, `tailscale_diff_acl_access`, `tailscale_get_audit_log`, `tailscale_get_network_flow_logs`, `tailscale_local_status` — declare `_meta["anthropic/maxResultSizeChars"]`, so a large-but-legitimate result stays inline instead of being truncated into a file reference the agent has to read back mid-task. The last of those is the one entry behind an opt-in: it declares the cap whenever `TAILSCALE_LOCAL_CLI=1` registers it, and is absent entirely otherwise.

## Using with mcp.hosting / mcph

If you run this server through [mcp.hosting](https://mcp.hosting) (via the `@yawlabs/mcph` local agent), the two filtering layers compose cleanly:

1. **Server-side** — `TAILSCALE_PROFILE` / `TAILSCALE_TOOLS` / `TAILSCALE_READONLY` reduce the tool surface *before* mcph sees it. The unloaded tools aren't registered at all.
2. **Client-side** — mcph's `mcp_connect_activate({ tools: [...] })` filters further for what appears in `tools/list`. Tools not in that list stay reachable via `mcp_connect_dispatch`, so you don't lose capability.

Recommended pattern for mcph users: set `TAILSCALE_PROFILE=core` (or narrower) in your mcp.hosting server config, then let mcph handle per-conversation activation on top. The server stays lean by default, and `mcp_connect_dispatch` covers the long-tail tools for ad-hoc needs.

## Authentication

**API key (simplest):** Set `TAILSCALE_API_KEY` in your shell or MCP config.

**OAuth (scoped access):** For fine-grained permissions, set `TAILSCALE_OAUTH_CLIENT_ID` and `TAILSCALE_OAUTH_CLIENT_SECRET` instead. Create an OAuth client at [Tailscale Admin Console > Settings > Trust credentials](https://console.tailscale.com/admin/settings/trust-credentials), with the scopes [listed below](#oauth-scopes-by-tool-group) for the tool groups you load.

The server checks for an API key first, then falls back to OAuth. If neither is set, tools return a clear error telling you what to configure — the server still starts, so your MCP client doesn't loop restarting.

**Tailnet:** Uses the credential's own tailnet (`-`) automatically, which is what most setups want. To name one explicitly, set `TAILSCALE_TAILNET` to the **Tailnet ID** shown under [Settings > General](https://console.tailscale.com/admin/settings/general) in the admin console — it looks like `T1234CNTRL`. Tailnets created before October 2025 can still use their legacy organization name; newer ones have no such name to use. Per the OpenAPI spec, the Tailnet ID is the preferred identifier either way.

**`TAILSCALE_OAUTH_TAILNET`** — target an **API-only tailnet** (one created by `tailscale_create_org_tailnet`). Those tailnets are not reachable with a plain client-credentials exchange: you authenticate with an OAuth client belonging to the *creating* tailnet (`all` scope) and the target rides on the token request. Set this to the new tailnet's id. Deliberately separate from `TAILSCALE_TAILNET` so the default token exchange is unchanged for everyone else. If you set this, leave `TAILSCALE_TAILNET` unset (or `-`) so tool requests follow the token — pointing the two at different tailnets makes every tailnet-scoped tool return 403, and the server warns about it at startup.

### OAuth scopes by tool group

The scopes an OAuth client needs for each `TAILSCALE_TOOLS` group. Grant the Read column for the groups you load, and add the Write column for the ones you let it change; Notes lists what a group needs beyond that. `all:read` (every read scope) and `all` (everything) are the broadest grants there are.

| Group | Read | Write | Notes |
|---|---|---|---|
| `status` | `devices:core:read`, `feature_settings:read` | none | Reads the device list and the tailnet settings, and still returns one when the other is refused. |
| `devices` | `devices:core:read`, `devices:routes:read`, `devices:posture_attributes:read` | `devices:core`, `devices:routes`, `devices:posture_attributes` | The route tools use the `devices:routes` pair and the posture-attribute tools the `devices:posture_attributes` pair; the rest use `devices:core`. A credential holding `devices:core` must be created with at least one tag. |
| `acl` | `policy_file:read`, `devices:core:read`, `devices:posture_attributes:read` | `policy_file`, `devices:posture_attributes` | Tailscale requires the device scopes alongside `policy_file:read` and `policy_file`. `tailscale_diff_acl_access` also needs `users:read` when you omit `principals` and it lists the users itself. |
| `dns` | `dns:read` | `dns` | **Unverified.** The OpenAPI spec names no scope on any DNS operation, and the trust credentials doc these come from does not list `/dns/configuration`, the endpoint behind `tailscale_get_dns_configuration` and `tailscale_set_dns_configuration`. |
| `keys` | `auth_keys:read`, `oauth_keys:read`, `federated_keys:read`, `api_access_tokens:read`, `oauth_apps:read` | `auth_keys`, `oauth_keys`, `federated_keys`, `api_access_tokens`, `oauth_apps` | Key scopes go by key type: `auth_keys` for auth keys, `oauth_keys` for OAuth clients, `federated_keys` for federated identities, `api_access_tokens` for personal API access tokens (read and delete only). Grant only the types you manage; only `all:read` and `all` can list every access token in the tailnet. The OAuth-app tools use `oauth_apps`, and `tailscale_create_oauth_app` also needs `devices:posture_attributes` when it sends `allowedNodeAttributes`. |
| `users` | `users:read` | `users` | |
| `tailnet` | `feature_settings:read`, `account_settings:read` | `feature_settings`, `account_settings` | Settings are split by field: network flow logging needs `logs:network:read` / `logs:network`, HTTPS certificates `networking_settings:read` / `networking_settings`, and the two externally-managed-ACL fields `policy_file:read` / `policy_file`; `feature_settings` covers the rest. The contacts tools use `account_settings`. |
| `org-tailnets` | `tailnets:read` | `tailnets` | `tailscale_delete_tailnet` needs `all` (see `TAILSCALE_OAUTH_TAILNET` above). |
| `webhooks` | `webhooks:read` | `webhooks` | |
| `posture` | `feature_settings:read` | `feature_settings` | The same scope governs most tailnet settings, so a client that can manage posture integrations can change those too. |
| `audit` | `logs:configuration:read`, `logs:network:read` | none | `tailscale_get_audit_log` uses the first, `tailscale_get_network_flow_logs` the second. |
| `invites` | `device_invites:read` | `device_invites` (delete only) | Creating, resending and accepting a device invite (`tailscale_create_device_invite`, `tailscale_resend_device_invite`, `tailscale_accept_device_invite`) cannot be done with a token from an OAuth client at all, and creating, deleting and resending a user invite (`tailscale_create_user_invite`, `tailscale_delete_user_invite`, `tailscale_resend_user_invite`) is permitted only with a user-owned key. Use `TAILSCALE_API_KEY` for those. The spec names no scope for reading user invites. |
| `services` | `services:read` | `services` | `tailscale_list_service_hosts`, `tailscale_get_service_device_approval` and `tailscale_set_service_device_approval` need both `services` and `devices:core`, so the two reads among them do not work on a read-only client. |
| `log-streaming` | `log_streaming:read` | `log_streaming` | Streaming to a private endpoint also needs `device_invites` and `policy_file`. `tailscale_create_aws_external_id` and `tailscale_validate_aws_trust_policy` both need `log_streaming`, although the second is a read. |
| `local-cli` | none | none | Runs the local `tailscale` binary and makes no admin-API call. |

Scopes are taken from Tailscale's [OpenAPI spec](https://tailscale.com/api) as of 2026-09-19. The DNS row, which the spec omits, and the device scopes in the `acl` row come from the [trust credentials doc](https://tailscale.com/docs/reference/trust-credentials). All of it is read from the documentation, not observed against a tailnet.

## Reliability and debugging

**429 and gateway-error retry (built-in).** HTTP 429, 502, 503 and 504 are retried up to 3 times on the idempotent methods (GET, PUT, DELETE), honoring the `Retry-After` header (both seconds-integer and HTTP-date forms). Falls back to exponential backoff with jitter, capped at 30s per wait. No env var needed — this is on by default. Workflows like "rotate every key older than 90 days" no longer fail mid-loop on Tailscale's per-tenant rate limits, and a gateway blip no longer fails a whole tool call: per the OpenAPI spec, 504 is documented on every device and service operation with the message "request took too long to process, please try again later", and 502 on the log reads. HTTP 500 is *not* retried — it means the server failed to process the request, not that something in front of it gave up. POST and PATCH are never retried, on any status. A DELETE that retried past a gateway error and then got a 404 says so in its error, because the attempt that timed out may already have deleted the resource.

**`TAILSCALE_DEBUG=1`** — log every HTTP method, URL, status, and elapsed time to stderr. Authorization headers are never logged. Use this when a tool returns an unexpected error and you want to see the actual request that went out. Example:

```
[tailscale-mcp] GET https://api.tailscale.com/api/v2/tailnet/-/devices
[tailscale-mcp]   <- 200 (148ms)
```

**`TAILSCALE_MAX_CONCURRENT=N`** — cap in-flight API requests at `N`. Default is unlimited (no behavior change for users who don't opt in). Useful when an agent fans out aggressively against a tailnet that has stricter limits than the per-call retry can absorb.

**`TAILSCALE_REQUEST_BUDGET_MS=N`** — total wall-clock budget per request, including retries and their sleeps. Default `90000` (90s). When the next retry's predicted wall time would exceed the budget, the call surfaces the error immediately instead of holding the line. For a gateway 5xx that prediction also charges the duration of the attempt that just failed: a 504 arrives only after the gateway has already waited, so the retry most likely costs the same again, and spending the rest of the budget on it would leave your client with silence instead of the 504. A call that retries past a gateway 5xx is also held to **half** this budget from that point on — 45s by default, under the 60s low end of the usual MCP client timeout — since those attempts cost gateway wait time rather than backoff, and a chain of them can outlast the client while a 429 chain cannot. Raising this value raises that ceiling with it; a 429 chain keeps the whole budget either way. Tune lower if your MCP client has a tighter outer timeout. Non-idempotent methods (POST, PATCH) are never retried — those return immediately regardless of budget.

**`TAILSCALE_RETRY_BASE_DELAY_MS=N`** — base delay for the exponential backoff between retries; attempt `N` waits `base * 2^N` (capped at 30s, plus jitter). Default `1000` (1s), so a fully-exhausted retry chain spends roughly 1s + 2s + 4s sleeping. Pairs with `TAILSCALE_REQUEST_BUDGET_MS`: lowering the budget on its own doesn't get you more retries, it just makes the default backoff exhaust the budget sooner and give up. Shrink both if you want "retry hard, fail fast". A server-supplied `Retry-After` header always wins over this value.

**`TAILSCALE_EXTRA_WEBHOOK_EVENTS=eventA,eventB`** — opt-in escape hatch for webhook event types Tailscale ships after the latest release of this package. The webhook tools validate `subscriptions` against a strict static catalog so typos and stale event names fail fast with a clear error; if you need a brand-new event before the catalog catches up, list it here (comma-separated) and the schema will accept it. The two category subscriptions (`categoryTailnetManagement`, `categoryDeviceMisconfigurations`) are in the catalog, so they need no entry here. Please also [open an issue](https://github.com/YawLabs/tailscale-mcp/issues) so the static list catches up.

**`TAILSCALE_EXTRA_POSTURE_PROVIDERS=providerA,providerB`** — the same escape hatch for device-posture integration providers. `tailscale_create_posture_integration` validates `provider` against a static list (`falcon`, `fleet`, `huntress`, `intune`, `jamfpro`, `kandji`, `kolide`, `sentinelone`); if Tailscale adds one before this package catches up, list it here rather than waiting for a release. This field used to be a closed enum, which made a newly-supported provider *uncreatable* rather than merely unvalidated.

**Friendlier error messages.** JSON error bodies of the form `{"message":"..."}` or `{"error":"..."}` are unwrapped before display, so you see the prose explanation instead of raw JSON. When the body also carries a `data` array — which the ACL endpoints use to report a failing policy test — it is rendered under the message, so a rejected policy says which user and which assertion failed instead of just `test(s) failed`. 401s still get the full multi-line auth-error formatter (with the Windows env-var hint when applicable).

## Local CLI integration (opt-in)

Most tools talk to the Tailscale v2 admin API — they describe **the tailnet**. Sometimes you want to ask about **this machine's** view: is it actually connected? What DERP region is it on? How far is `my-laptop` from here? Those answers come from the local `tailscale` binary, not the admin API.

Set `TAILSCALE_LOCAL_CLI=1` (in your shell or `.mcp.json` `env` block) to add 6 read-only diagnostic tools:

| Tool | Equivalent CLI command | Use it for |
|---|---|---|
| `tailscale_local_status` | `tailscale status --json [--peers=false] [--active]` | This machine's connection state + peers it can see; `peers: false` and `activeOnly: true` narrow the peer map |
| `tailscale_ping` | `tailscale ping <target>` | Latency probe to another tailnet node (direct vs DERP-relayed) |
| `tailscale_netcheck` | `tailscale netcheck --format=json` | NAT type, DERP latency map, IPv4/IPv6 support |
| `tailscale_local_version` | `tailscale version` | Which client version is actually running |
| `tailscale_local_whoami` | `tailscale whoami` | Which user and device this machine is authenticated as (needs tailscale >= 1.102.1) |
| `tailscale_local_service_list` | `tailscale service list` | Tailscale Services visible to *this* node (needs tailscale >= 1.102.1) |

Requirements: the `tailscale` binary has to be findable. It's looked up on `PATH` first, then at the default install paths below, and `TAILSCALE_BINARY` overrides both with an absolute path of your choosing.

| Platform | Where it looks beyond `PATH` | Notes |
|---|---|---|
| macOS | `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `/opt/homebrew/bin/tailscale`, `/usr/local/bin/tailscale` | The standard install keeps the CLI **inside the app bundle** and adds nothing to `PATH`. An MCP client launched from the Dock or Spotlight also inherits a minimal `PATH`, not your shell's — so a bare lookup can fail even when `tailscale` works in your terminal. |
| Linux | `/usr/bin/tailscale`, `/snap/bin/tailscale` | The snap wrapper is outside some minimal `PATH`s. |
| Windows | — | The installer puts `tailscale.exe` on the machine `PATH`. If you set `TAILSCALE_BINARY`, use a Windows path (`C:/Program Files/Tailscale/tailscale.exe`), not a Git Bash one (`/c/...`) — that spelling is translated when you type it at an MSYS prompt, but not when it's read from a JSON config or a `.env`. |
| WSL | `/usr/bin/tailscale`, `/snap/bin/tailscale` | **These tools report the Linux node, and need Tailscale installed inside the distro with `tailscaled` running there.** In a fresh WSL install the only `tailscale` in reach is the Windows one; a Linux process can't exec `tailscale.exe`, and pointing `TAILSCALE_BINARY` at `/mnt/c/.../tailscale.exe` would report the **Windows** host's `Self`, peers, `whoami` identity and netcheck results while every tool here says "this machine's". `tailscale.exe` is deliberately never picked up automatically. |

The MCP server doesn't need root to run these — they're all diagnostic, not state-mutating. Operations that would need elevation (`tailscale up`, `set --advertise-routes`, `lock sign`) are deliberately not exposed.

When opt-in is on, the startup banner reflects it: `@yawlabs/tailscale-mcp v0.13.3 ready (103 tools, local-cli=on)` — the 6 local CLI tools are additive on top of the default 97.

## Resources (4)

MCP Resources expose read-only data clients can browse without a tool call.

| Resource | URI | Description |
|----------|-----|-------------|
| Tailnet Status | `tailscale://tailnet/status` | Device count and tailnet settings |
| Devices | `tailscale://tailnet/devices` | All devices with status and IPs |
| ACL Policy | `tailscale://tailnet/acl` | Full ACL policy (HuJSON preserved) |
| DNS Config | `tailscale://tailnet/dns` | Nameservers, search paths, split DNS, MagicDNS |

## Tools (97 + 6 opt-in)

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
| `tailscale_list_devices` | List devices (default field subset; `fields: "all"` adds routes, connectivity, SSH, distro, posture identity). `lastSeen` is absent while a device is online |
| `tailscale_get_device` | Get one device (`fields: "all"` for the full record) |
| `tailscale_authorize_device` | Authorize a pending device |
| `tailscale_deauthorize_device` | Deauthorize a device |
| `tailscale_set_devices_authorized` | Authorize/deauthorize many devices in one call (parallel, per-id error reporting) |
| `tailscale_delete_device` | Remove a device from the tailnet |
| `tailscale_rename_device` | Rename a device (FQDN or base name; empty string resets to the OS hostname) |
| `tailscale_expire_device` | Expire a device's key, forcing re-authentication |
| `tailscale_get_device_routes` | Get advertised and enabled subnet routes |
| `tailscale_set_device_routes` | Enable or disable subnet routes |
| `tailscale_get_device_posture_attributes` | Get all posture attributes for a device |
| `tailscale_set_device_posture_attribute` | Set a custom posture attribute (optional expiry and audit-log comment) |
| `tailscale_delete_device_posture_attribute` | Delete a custom posture attribute |
| `tailscale_set_device_tags` | Set ACL tags on a device |
| `tailscale_set_device_ip` | Set a device's Tailscale IPv4 address |
| `tailscale_update_device_key` | Update device key settings (e.g. disable key expiry) |
| `tailscale_batch_update_posture_attributes` | Batch update custom posture attributes across devices |

</details>

<details>
<summary><strong>ACL / Policy</strong> (5 tools) — with HuJSON formatting preservation and ETag safety</summary>

| Tool | Description |
|------|-------------|
| `tailscale_get_acl` | Get ACL policy with formatting preserved (HuJSON) + ETag |
| `tailscale_update_acl` | Update ACL policy (requires ETag for safe concurrent edits; `ts-default` for a first write) |
| `tailscale_validate_acl` | Validate a policy without applying it |
| `tailscale_preview_acl` | Preview rules that would apply to a user or IP |
| `tailscale_diff_acl_access` | Compare a proposed policy against the live one — who gains and loses access |

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
| `tailscale_set_split_dns` | Set split DNS configuration (full replace; `null` clears a domain) |
| `tailscale_update_split_dns` | Update split DNS configuration (partial merge; `null` removes a domain) |
| `tailscale_get_dns_preferences` | Get DNS preferences (MagicDNS) |
| `tailscale_set_dns_preferences` | Set DNS preferences (MagicDNS) |
| `tailscale_get_dns_configuration` | Get unified DNS configuration (all settings in one call) |
| `tailscale_set_dns_configuration` | Set unified DNS configuration (all settings in one call) |

</details>

<details>
<summary><strong>Keys / Trust Credentials</strong> (9 tools) — covers auth keys, OAuth clients, federated identities, and OAuth apps</summary>

| Tool | Description |
|------|-------------|
| `tailscale_list_keys` | List keys (default set depends on the credential; `all=true` for tailnet-wide: auth keys, API access tokens, OAuth clients, federated identities) |
| `tailscale_get_key` | Get details for a key of any type |
| `tailscale_create_key` | Create an auth key, OAuth client (`keyType=client`), or federated identity (`keyType=federated`) |
| `tailscale_delete_key` | Delete a key of any type, including the API access token this server runs on |
| `tailscale_update_key` | Update a key's description, scopes, tags, or federated claim settings |
| `tailscale_create_oauth_app` | Create an OAuth App for third-party device provisioning (Tailscale alpha) |
| `tailscale_get_oauth_app` | Get an OAuth App's name, redirect URIs, and scopes |
| `tailscale_list_oauth_apps` | List every OAuth App registered in the tailnet |
| `tailscale_delete_oauth_app` | Delete an OAuth App, revoking its ability to provision devices |

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
| `tailscale_create_webhook` | Create a webhook (raw JSON, or formatted for Slack / Mattermost / Google Chat / Discord via `providerType`) |
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
per-tenant isolation, and ephemeral CI environments. Organizations get 10 tailnets
including the original by default. Unlike every other group here these endpoints live
under `/organizations`, authenticate **only** with an OAuth client (the `tailnets` scope
to create, `all` to then reach the tailnet), and produce tailnets that are not managed in
the admin console. Set `TAILSCALE_OAUTH_TAILNET` to operate on one.

| Tool | Description |
|------|-------------|
| `tailscale_list_org_tailnets` | List the organization's tailnets (paginated via `limit` / `cursor`) |
| `tailscale_create_org_tailnet` | Create an API-only tailnet; returns its OAuth client secret **once** |
| `tailscale_delete_tailnet` | Delete a tailnet (the configured one, or an explicit `tailnet`) — irreversible; requires `confirmTailnet` to match |

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
| `tailscale_create_aws_external_id` | Create/get the AWS external ID for S3 role-based log streaming (`reusable`, default true, returns the same ID until it is linked) |
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
| `tailscale_list_user_invites` | List open (not yet accepted) user invites |
| `tailscale_create_user_invite` | Create a user invite |
| `tailscale_get_user_invite` | Get a user invite |
| `tailscale_delete_user_invite` | Delete a user invite |
| `tailscale_resend_user_invite` | Resend a user invite email |

</details>

<details>
<summary><strong>Logging</strong> (2 tools)</summary>

| Tool | Description |
|------|-------------|
| `tailscale_get_audit_log` | Get configuration audit log (who changed what, when); optional server-side actor / target / event filter |
| `tailscale_get_network_flow_logs` | Get network traffic flow logs between devices |

</details>

<details>
<summary><strong>Local CLI</strong> (6 tools, opt-in) — see <a href="#local-cli-integration-opt-in">Local CLI integration</a></summary>

| Tool | Description |
|------|-------------|
| `tailscale_local_status` | This machine's view of the tailnet (own connection state, peers, DERP region); narrow with `peers: false` or `activeOnly: true` |
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

Works in any CI system. Set `TAILSCALE_API_KEY` as an env var; `TAILSCALE_TAILNET` is optional — leave it unset to act on the key's own tailnet, or set it to the [Tailnet ID](#authentication) to name one explicitly. Both commands exit non-zero on any failure; `deploy-acl` refuses to deploy without an ETag (so a concurrent Admin Console edit can never be silently clobbered) and reports a 412 as a concurrent-edit conflict you resolve by re-running.

When validation reports a failing policy test, the CI log names the user and the assertion (`For user user1@example.com:` / `Errors found:`), the same detail upstream's `gitops-pusher` prints. Validation *warnings* — a SCIM group that is not syncing, for instance — fail the run too, matching `gitops-pusher` and Tailscale's own Go client; their text is printed alongside so you can see what was flagged.

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
      TAILSCALE_TAILNET: T1234CNTRL # Tailnet ID from Settings > General; or omit: defaults to the key's tailnet
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

- Node.js 20.11+ to run the server (22+ to develop — the test script passes a glob to `node --test`, supported from Node 21)
- A Tailscale API key or OAuth client credentials

## Running on oam.js (optional)

[oam.js](https://oamjs.org) runs this server unmodified, and the `tailscale-mcp` command only ever uses the **latest oam release, currently 0.15.2**. Verified against oam 0.15.2: full MCP handshake, all 97 admin-API tools plus `tailscale_tool_groups`, all 4 resources, identical error responses, and a clean stdout protocol stream — from the shipped bundle *and* straight from the TypeScript source with no build step.

**oam 0.15.2 is the minimum.** A floor matters here: releases before 0.9.0 ran `child_process.execFile` arguments through a shell, re-splitting them on whitespace and executing shell metacharacters inside an argument, and this server shells out to the `tailscale` binary across its local-CLI tools, so that was a reachable bug rather than a theoretical one.

How the `tailscale-mcp` command (`bin/tailscale-mcp.mjs`) picks a runtime:

- **`TAILSCALE_MCP_RUNTIME=auto`** (the default) — if a client already launched it with `oam run` on oam 0.15.2 or newer, the server runs in that process. Otherwise it uses `OAM_BIN` when that is 0.15.2 or newer, else asks every oam binary it can find — `%LOCALAPPDATA%\oam\bin` then `~/.oam/bin` on Windows, `~/.oam/bin` elsewhere, then `PATH` — for its version and uses the newest at or above the floor (on a tie the installed copy wins). With none, it runs on Node. An oam host older than 0.15.2 never serves the server itself: it hands off to the newest usable oam, or to Node on `PATH`, or exits with an error when there is neither. Whenever it looks for an oam, stderr names an `OAM_BIN` that was passed over and why; the oam binaries it found and passed over are named, each with its reason, only when no usable oam turns up.
- **`TAILSCALE_MCP_RUNTIME=oam`** — the same, but exit with an error instead of falling back to Node.
- **`TAILSCALE_MCP_RUNTIME=node`** — always Node: in-process under `npx`, handed off to Node on `PATH` when a client launches the command with `oam run`.

The value is case-insensitive; anything else is warned about on stderr and treated as `auto`. On Windows only `oam.exe` counts: an `oam.cmd` / `oam.bat` shim is never run, and it is named on stderr only when no usable oam turns up.

### Sandboxing (opt-in)

Set `TAILSCALE_MCP_SANDBOX=1` to run under oam's `--permission` model: network restricted to `api.tailscale.com` -- the only host the bundle contacts, including the OAuth token exchange -- and filesystem denied. Child-process stays granted because the local-CLI tools shell out to the `tailscale` binary, which is also why `PATH` remains in the environment allow-list.

It is opt-in rather than default because a wrong grant does not fail loudly. oam denies a non-granted environment variable by making it **absent** from `process.env` rather than throwing, so an under-granted `TAILSCALE_API_KEY` reads as "unauthenticated" rather than "denied". The env allow-list in the launcher is derived from what the shipped bundle actually reads -- if you add a new `process.env` lookup, extend that list with it.

The sandbox is applied by the `tailscale-mcp` command, which spawns a fresh oam for it -- even when a client launched the command with `oam run` -- because `--permission` is a process-level flag. If it finds no usable oam to spawn, `TAILSCALE_MCP_RUNTIME=auto` still starts the server, without the sandbox; set `TAILSCALE_MCP_RUNTIME=oam` to make that an error. `TAILSCALE_MCP_RUNTIME=node` runs on Node, so it never applies the sandbox.

```jsonc
{
  "mcpServers": {
    "tailscale": {
      "command": "oam",
      "args": ["run", "/path/to/tailscale-mcp/dist/index.js"]
    }
  }
}
```

**Measure startup on your own hardware.** An MCP client cold-starts this server once per session, so startup is the cost that actually gets paid, and on the machine this was measured on node won it — 437ms vs 1554ms for `oam run` over 10 warmed runs (an earlier 5-run round showed 326ms vs 427ms; the box was busy, so treat the magnitude as noisy and the direction as the finding). Those runs used an oam that predates the 0.15.2 floor and have not been repeated since, so do not read them as a current ranking.

The published `tailscale-mcp` command prefers the newest usable oam it finds (see above). Without oam that costs almost nothing: discovery is file-existence checks only, never a subprocess, and the fallback runs the server inside the Node process npm already started. With oam installed, though, the command boots Node, runs `--version` on every oam binary it found to pick the newest, and only then boots oam, so it is always slower than pointing your client at a runtime directly — the config above for oam, `node /path/to/tailscale-mcp/dist/index.js` for Node. `TAILSCALE_MCP_RUNTIME=node` skips oam entirely.

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

[![Follow @YawLabs on X](https://img.shields.io/badge/follow-%40YawLabs-000000?logo=x&logoColor=white)](https://x.com/YawLabs)
