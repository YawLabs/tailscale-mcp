# Contributing

Thanks for your interest in contributing! This guide covers the workflow for both human contributors and AI coding agents.

## Quick Start

```bash
# 1. Fork this repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/<repo-name>.git
cd <repo-name>

# 2. Install dependencies
npm install

# 3. Create a branch
git checkout -b your-branch-name

# 4. Make your changes, then verify everything passes
npm run lint:fix
npm run build
npm test
```

Development requires **Node.js 22+** (the test script passes a glob to `node --test`, supported from Node 21). `devEngines` in package.json enforces this at install time on npm 10.7+; older npm ignores the field, and the failure surfaces in `npm test` instead (the runner finds no test files). The published package itself runs on Node 20+.

## Submitting a Pull Request

1. **One PR per change.** Keep PRs focused — a bug fix, a new feature, or a refactor, not all three.
2. **Branch from `main`** (or `master` if that's the default branch).
3. **Run `npm run lint:fix`** before committing — the release gate (`release.sh`) runs the same lint and fails on formatting issues.
4. **Run `npm test`** and confirm all tests pass.
5. **Write a clear PR title and description** — explain *what* changed and *why*.
6. **All PRs require approval** from a maintainer before merging.

> **Note:** this repo intentionally runs no CI on pull requests (all workflows were removed; releases are gated locally by `release.sh`). Maintainers run `npm run lint && npm test` locally before merging any PR — including Dependabot PRs, which arrive with no automated checks.

## Development Workflow

| Command | What it does |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript |
| `npm run dev` | Run in development mode |
| `npm test` | Run the test suite |
| `npm run lint` | Check for lint errors |
| `npm run lint:fix` | Auto-fix lint and formatting |

## Integration Tests

`src/integration.test.ts` exercises a handful of tool handlers against a **live Tailscale API** to catch shape drift that fetch mocks cannot. It is gated behind `RUN_INTEGRATION_TESTS=1` + live credentials, so `npm test` in normal development stays fully offline.

Run locally.

macOS / Linux / WSL / Git Bash (bash, zsh) — the inline `VAR=value cmd` prefix applies to that one command:

```bash
# read-only describes only
RUN_INTEGRATION_TESTS=1 TAILSCALE_API_KEY=tskey-api-... npm test

# plus the two key round-trips, which mint real credentials
RUN_INTEGRATION_TESTS=1 RUN_MUTATING_INTEGRATION_TESTS=1 TAILSCALE_API_KEY=tskey-api-... npm test
```

fish (no inline prefix; `env` does the same job):

```fish
# read-only describes only
env RUN_INTEGRATION_TESTS=1 TAILSCALE_API_KEY=tskey-api-... npm test

# plus the two key round-trips, which mint real credentials
env RUN_INTEGRATION_TESTS=1 RUN_MUTATING_INTEGRATION_TESTS=1 TAILSCALE_API_KEY=tskey-api-... npm test
```

Windows (PowerShell 5.1 and 7) — the variables are set for the session, so `Remove-Item` them when you are done:

```powershell
# read-only describes only
$env:RUN_INTEGRATION_TESTS = '1'; $env:TAILSCALE_API_KEY = 'tskey-api-...'
npm test

# plus the two key round-trips, which mint real credentials
$env:RUN_MUTATING_INTEGRATION_TESTS = '1'
npm test
```

Windows (cmd.exe):

```bat
set RUN_INTEGRATION_TESTS=1
set TAILSCALE_API_KEY=tskey-api-...
npm test
```

**The mutating cases need a second flag.** The `Integration: real Tailscale API (read-only)` describe issues GETs only (plus `/acl/preview`, which evaluates and applies nothing) and is safe to point at any tailnet, production included. The two `tailscale_create_key` round-trips mint a real OAuth client and a real federated identity in the target tailnet (`POST /tailnet/{tailnet}/keys`) and delete them again in a `finally` -- they need `RUN_MUTATING_INTEGRATION_TESTS=1` on top of the base flag, so asking for shape-drift coverage no longer mints credentials as a side effect. If the process dies between create and delete, or the delete call fails, a live credential is left behind, so **run those against a dedicated test tailnet, not production.**

To run one describe, build first and pass the pattern to `node` directly, with the flag **before** `--test` -- `npm test -- --test-name-pattern=...` puts it after the file glob, where node ignores it:

macOS / Linux / WSL / Git Bash (bash, zsh):

```bash
npm run build && RUN_INTEGRATION_TESTS=1 node --test-name-pattern="read-only" --test dist/integration.test.js
```

fish:

```fish
npm run build; and env RUN_INTEGRATION_TESTS=1 node --test-name-pattern="read-only" --test dist/integration.test.js
```

Windows (PowerShell 5.1 and 7) — `;` rather than `&&`, which 5.1 rejects at parse time, so nothing in the line runs:

```powershell
$env:RUN_INTEGRATION_TESTS = '1'
npm run build; node --test-name-pattern="read-only" --test dist/integration.test.js
```

The read-only describes need a populated tailnet: at least one device, at least one key, and at least one configuration audit entry in the last 29 days (the element-shape assertions, and the audit-log event filter, fail rather than pass silently on an empty one). `RUN_INTEGRATION_TESTS=1` set without credentials fails with the names of the unset variables instead of skipping green, and `RUN_MUTATING_INTEGRATION_TESTS=1` set without the base flag does the same rather than running nothing. There is no CI workflow that runs the suite on a schedule today; run it manually when you need API-drift coverage.

## Live shape probes

`scripts/live-probe.mjs` is contributor tooling, not part of the published
package. It answers questions the OpenAPI spec cannot: what the API actually
*does* with a request shape this server sends. A 200 does not prove a write took
effect, and a 400 does not say which part was wrong, so each probe sends the
shape the shipped tool emits and the shape the spec documents, against the same
target in the same run, with a GET before and after, and records both.

**Nothing here has been run against a live tailnet. `fixtures/live/` is empty on
purpose, and no changelog entry may claim otherwise until a fixture exists.**

### Dry run is the default

```bash
node scripts/live-probe.mjs list          # every probe, and the ones deliberately not implemented
node scripts/live-probe.mjs run --all     # prints every request that WOULD be sent, and exits
```

`run` without `--execute` makes no network call at all. Read the printed list
first -- that is what it is for.

### Two targets, because one cannot host every probe

* **Target A**, an API-only tailnet created through the org tailnets API by
  `live-probe.mjs provision`, reached with the OAuth client that call returns.
  Hosts the DNS, services, webhooks, keys, OAuth-app and C7 probes.
* **Target B**, a throwaway *human* tailnet with a user-owned API key. The
  invite probes (`P2`, `P3`) and the auth-key arm of `P8` can only run here:
  those endpoints refuse an OAuth-minted token because an invite needs an
  inviting user, and an API-only tailnet has no human users. The harness
  refuses to run them anywhere else rather than leaving you to interpret a 403.

Do **not** reach target A by setting `TAILSCALE_OAUTH_TAILNET`. Whether
`?tailnet=` on the token exchange is honoured is itself one of the open
questions (`P9`); if it is silently ignored, the minted token addresses the
*creating* tailnet. The harness refuses to start with that variable set.

### How it refuses

The harness reads `TS_PROBE_*` variables only, and deletes every `TAILSCALE_*`
name from its own environment at startup -- `getAuthConfig` prefers an ambient
`TAILSCALE_API_KEY` over the OAuth pair, and `getTailnet` defaults the tailnet
to `-`, so without the strip every request would carry your real key and address
your real tailnet. On top of that:

| | |
|---|---|
| Credential isolation | Refuses a probe credential whose SHA-256 equals the ambient key's. |
| Explicit target | `-` is refused, and `TS_PROBE_FORBIDDEN_TAILNETS` (the real tailnet's id **and** name) is mandatory and non-empty. |
| Provenance | An unsafe probe runs only against a tailnet this harness provisioned, under 7 days old, named `yaw-probe-*`. |
| Server-attested emptiness | `preflight` refuses a target with an unexpected user, a non-`yaw-probe-` device, or DNS the harness did not seed. |
| Typed confirmation | `teardown` needs `--destroy-tailnet=<id>` matching byte for byte. |
| Egress guard | Inside the fetch wrapper, so a blocked request never leaves the process: one origin, one tailnet id, `/tailnet/-/` refused outright, a per-probe method and path allowlist, and the `Authorization` credential bound to the arm's declared target. |
| Dry run | `--execute` has to be typed. |

`P11` (S3 log-stream external id) is **not implemented**, deliberately: the PUT
replaces any existing configuration-log stream and the old destination's token
cannot be read back, so there is no restore. `live-probe.mjs list` prints the
reason and what to ship instead.

### Pinned build

`--execute` requires `TS_PROBE_PINNED_DIST` pointing at a `dist/` built from tag
`v0.20.2` **outside this working tree**, and refuses a path inside it. The
working tree's `dist/` contains the fixes these probes exist to gate, so a
"current shape" arm taken from it would record the *fixed* request and prove
nothing:

```bash
git worktree add ../tailscale-mcp-v0.20.2 v0.20.2
(cd ../tailscale-mcp-v0.20.2 && npm ci && npm run build)
export TS_PROBE_PINNED_DIST=$(cd ../tailscale-mcp-v0.20.2/dist && pwd)
```

### State and cleanup

The state file -- provisioning provenance, the target's OAuth client secret and
the cleanup journal -- lives **outside the repo** (`%LOCALAPPDATA%` /
`$XDG_STATE_HOME`), because `0600` is a no-op on Windows. Every create is
journalled before it resolves, so `live-probe.mjs cleanup` can replay it after a
crash. Run `cleanup` and then `scrub-check` before committing any fixture;
`scrub-check` compares the fixtures against the literal credentials in your
shell, which the committed test cannot do.

## Code Style

- TypeScript, strict mode
- Formatting and linting are enforced by the project's linter — run `lint:fix` and let the tooling handle it
- No unnecessary abstractions — keep code simple and direct
- Add tests for new functionality

## For AI Coding Agents

If you're an AI agent (Claude Code, Copilot, Cursor, etc.) submitting a PR:

1. **Fork the repo** and work on a branch — direct pushes to the default branch are blocked.
2. **Always run `npm run lint:fix && npm run build && npm test`** before committing. Do not skip this. (Windows PowerShell 5.1 has no `&&` — run the three as separate lines there, stopping at the first failure, or use PowerShell 7.)
3. **Do not add unrelated changes** — no drive-by refactors, no extra comments, no unrelated formatting fixes.
4. **PR description must explain the change clearly** — what problem does it solve, how does it work, how was it tested.
5. **One logical change per PR.** If you're fixing a bug and adding a feature, that's two PRs.

## Reporting Issues

Open an issue on GitHub. Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Environment details (OS, Node version, etc.)

## Dependency Notes

The `overrides` block in `package.json` pins `hono` and `@hono/node-server` to patched versions. These are *transitive* dependencies pulled in by `@modelcontextprotocol/sdk`, not direct dependencies of this project. The overrides exist to resolve Dependabot security alerts on the SDK's `^4` / `^1` ranges without forking the SDK. Leave them in place until the MCP SDK updates its hono dependency range to include the patched versions; at that point the overrides can be removed.

## License

By contributing, you agree that your contributions will be licensed under the same license as this project.
