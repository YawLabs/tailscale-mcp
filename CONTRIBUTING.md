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

## Submitting a Pull Request

1. **One PR per change.** Keep PRs focused — a bug fix, a new feature, or a refactor, not all three.
2. **Branch from `main`** (or `master` if that's the default branch).
3. **Run `npm run lint:fix`** before committing — CI will reject formatting issues.
4. **Run `npm test`** and confirm all tests pass.
5. **Write a clear PR title and description** — explain *what* changed and *why*.
6. **All PRs require approval** from a maintainer before merging.

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

`src/integration.test.ts` exercises a handful of read-only tool handlers against a **live Tailscale API** to catch shape drift that fetch mocks cannot. It is gated behind `RUN_INTEGRATION_TESTS=1` + live credentials, so `npm test` in normal development stays fully offline.

Run locally:

```bash
RUN_INTEGRATION_TESTS=1 TAILSCALE_API_KEY=tskey-api-... npm test
```

In CI, the `.github/workflows/integration.yml` workflow runs **nightly on a schedule**, **on every tag push** (gating publish via `release.yml`), and **on manual dispatch**. It requires a `TAILSCALE_TEST_API_KEY` repository secret. The suite is read-only (no mutations), so it is safe to point at any tailnet — though a dedicated test tailnet is recommended.

## Code Style

- TypeScript, strict mode
- Formatting and linting are enforced by the project's linter — run `lint:fix` and let the tooling handle it
- No unnecessary abstractions — keep code simple and direct
- Add tests for new functionality

## For AI Coding Agents

If you're an AI agent (Claude Code, Copilot, Cursor, etc.) submitting a PR:

1. **Fork the repo** and work on a branch — direct pushes to the default branch are blocked.
2. **Always run `npm run lint:fix && npm run build && npm test`** before committing. Do not skip this.
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
