# Changelog

All notable changes to `@yawlabs/tailscale-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** this file starts at the entry below. Releases before it were shipped
> without changelog entries -- see the
> [tag list](https://github.com/YawLabs/tailscale-mcp/tags) and the GitHub release notes
> for those versions. `release.sh` sources its release body from the matching
> `## [x.y.z]` heading here, so an absent entry silently falls back to raw
> commit subjects.

## [Unreleased]

### Added
- **`TAILSCALE_EXTRA_POSTURE_PROVIDERS`**: escape hatch for posture providers Tailscale ships between releases, mirroring `TAILSCALE_EXTRA_WEBHOOK_EVENTS`.

### Fixed
- **`tailscale_create_posture_integration` could not create Fleet or Huntress integrations at all.** The `provider` field was a closed `z.enum` of six values, so a provider Tailscale added later was rejected at the schema layer before a request was ever built -- uncreatable rather than merely unvalidated. Now validated against a static list of all eight current slugs with a runtime escape hatch. (Slugs, not display names: Kandji renamed to Iru and Kolide to 1Password XAM, but both slugs are unchanged.)

## [0.16.0] — 2026-08-08

### Added
- Opt-in `TAILSCALE_MCP_SANDBOX=1` runs the server under oam's `--permission` model: network limited to `api.tailscale.com` and `login.tailscale.com`, filesystem denied, child-process granted (the local-CLI tools shell out to the `tailscale` binary, which is also why `PATH` stays in the environment allow-list). Opt-in rather than default because a wrong grant does not fail loudly -- oam denies a non-granted environment variable by making it ABSENT from `process.env` rather than throwing, so an under-granted secret reads as "unauthenticated" rather than "denied".
- Binary builds cross-compile via `--carrier`.

### Changed
- Launchers probe `oam --version` and require >= 0.9.0. Below that, `auto` falls back to Node with a note on stderr and `TAILSCALE_MCP_RUNTIME=oam` is a hard error. Older oam ran `child_process.execFile` arguments through a shell, accepted an exec timeout and ignored it, truncated `spawnSync` at `maxBuffer` while reporting success, and treated stdio `inherit`/`ignore` as `pipe` -- the execFile-through-a-shell bug was reachable rather than theoretical here because of the local-CLI tools.

## [0.15.0] — 2026-08-07

### Added
- Runtime launcher at `bin/tailscale-mcp.mjs`: the published `tailscale-mcp` command now prefers the [oam](https://oamjs.org) runtime and falls back to Node. `TAILSCALE_MCP_RUNTIME` selects (`auto` / `oam` / `node`) and `OAM_BIN` overrides discovery. Both paths verified against the MCP surface — handshake plus all 89 tools — and behave identically. The fallback does **not** re-exec Node: npm has already started Node to run the launcher, so it is an in-process `import()` with no extra spawn.

### Changed
- Runtime discovery prefers an **installed** oam (`~/.oam/bin`, `%LOCALAPPDATA%\oam\bin`) over one found on `PATH`. Anyone developing oam itself has `oam/target/release` on PATH, and a build directory is the wrong thing for a user-facing launcher to bind to — cargo replaces the binary underneath running processes. `OAM_BIN` still wins outright and remains the way to point deliberately at a dev build.
- `.gitignore` excludes `bin/*` rather than `bin/`, so the launcher can be re-included with a negation. A negation cannot undo a directory-level exclusion — that trap shipped a broken `bin` in postgres-mcp, where the launcher was untracked and absent from every fresh clone.
- `scripts/build-binary.mjs` pins the CLI source entry instead of deriving it from `bin`'s value, which would have resolved to `bin/tailscale-mcp.ts` once `bin` moved to the launcher — the breakage postgres-mcp shipped in its 0.9.0.

### Fixed
- The in-process fallback sets `process.argv[1]` to the server before importing. A server may gate its bootstrap on being the process entry point so its own tests can import the module without opening a transport; without this the MCP handshake loads the module and then hangs forever. Found in aws-mcp, fixed across every server carrying this launcher.

## [0.14.0] — earlier

Released before this changelog existed.
