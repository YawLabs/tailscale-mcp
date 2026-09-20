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
