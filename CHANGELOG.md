# Changelog

All notable changes to `@yawlabs/tailscale-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** this file starts at the entry below. Releases before it were shipped
> without changelog entries -- see the
> [tag list](https://github.com/YawLabs/tailscale-mcp/tags) and the GitHub release notes
> for those versions.
>
> This file is written for humans and is NOT read by any tooling. `release.sh`
> builds its GitHub release body from `git log --oneline <prev-tag>..<tag>`
> (release.sh:362) and never opens this file -- an earlier version of this note
> claimed the opposite, which is why the 0.16.0 entry was backfilled on the
> theory that its absence had degraded that release's notes. Keep entries here
> current for readers; it will not change what `gh release` shows.

## [Unreleased]

### Added
- **`tailscale_list_oauth_apps` and `tailscale_delete_oauth_app`** (`keys` group). `create` and `get` shipped in 0.17.0 with no way to enumerate or revoke what they made, so an app whose id was not saved at creation was both invisible and unrevokable through this server -- the wrong asymmetry for an object that grants a third party device-enrollment rights. Both endpoints were verified against a live tailnet rather than inferred from convention: this API answers an unrouted path with plain-text `404 page not found` but a routed-yet-missing resource with JSON `{"message":"not found"}`, and the `DELETE` probe returned the JSON form, byte-identical to the known-good `GET` by id. `delete_oauth_app` takes `trim().min(1)` on `appId`, not a bare `min(1)`: `" "` survives the bare form and `encPath` sends it as the literal segment `%20`, which on an irreversible revoke returns a 404 that reads like the app is already gone.
- **`npm run test:coverage`**, using Node's built-in reporter. Two rows in its output are artifacts rather than gaps: `tools.test.ts` imports `posture.js` and `webhooks.js` a second time under a cache-busting query specifier to test load-time env resolution, which registers a second script URL, and the reporter collapses each pair to the worse row. Both modules are at 100% when that file is excluded.

### Fixed
- **`tailscale_update_acl` accepted an empty `etag` and silently dropped the concurrency guard.** The field was a bare `z.string()`, and `apiRequest` sets `If-Match` behind a truthiness check -- so `""` passed validation, the header was omitted entirely, and the widest-blast-radius write in the package overwrote a concurrent admin edit instead of coming back 412. `cli.ts`'s 412 handling could never fire. The schema now trims and requires a non-empty value.
- **A revoked OAuth token left the server permanently unauthenticated.** The token was cached until its stated expiry and nothing cleared it on an auth failure, so a server-side revoke meant every subsequent call 401'd until the process restarted -- no recovery path in a long-lived stdio server. A 401 now evicts the cached token so the next call re-mints. A 403 deliberately does not: a fresh token carries the same scopes, so evicting there would burn an exchange per call forever. The eviction also compares the request's `Authorization` header against the cached token, so a straggler 401 carrying token N cannot evict token N+1.
- **An empty-body 5xx reported `{"error":""}` with the status code discarded.** Twelve error fallbacks used `??`, which only fires on null/undefined -- and `extractErrorMessage` returns `""` for an empty body, which is not nullish. An empty-body 502 from a proxy in front of `api.tailscale.com` therefore reached the client with no message *and* no status. All twelve now use `||`, so the floor is `HTTP <status>`.
- **`tailscale_get_acl`'s ETag footer accumulated without bound.** The tool appends a five-line `// ETag: ...` HuJSON comment block, and `tailscale_update_acl`'s own description tells the agent to pass the full text back -- so the footer became part of the live policy, and the next `get` appended another. The append is now idempotent: any previously-appended footer is stripped first.
- **`tailscale_update_acl` was `destructiveHint: false`**, telling MCP clients not to gate the one call that can lock every device out of the tailnet. It and five other replace-all writes (`set_device_routes`, `set_device_tags`, `set_nameservers`, `set_search_paths`, `set_split_dns`, `set_dns_configuration`) are now `destructiveHint: true`. The line drawn: can this call wipe configuration the caller never named? Scalar and merge writes stay out.
- **`bin/`, `scripts/` and `build.mjs` were never linted.** `npm run lint` was `biome check src/` while `biome.json` itself included `**`, so the 411-line shipped `bin` entry went unchecked -- and carried two dead variables. Lint now covers them.
- The `oam --permission` sandbox granted network to `login.tailscale.com`, which the bundle never contacts: every outbound request targets `api.tailscale.com`, and `console.tailscale.com` appears in error text only, never as a request target.
- The unknown-profile warning hard-coded "minimal, core, full" while the tip two lines below derived its counts from the live registry; adding a preset left the warning telling operators their new profile was invalid. It now derives from `PROFILES`.
- The startup tip wrote a U+2014 em-dash to stderr, which Windows ConPTY mangles into mojibake that then gets pasted into bug reports.
- `tailscale_delete_tailnet`'s description called its `confirmTailnet` check "a deliberate second look". It is a typo guard, and only on the omit-`tailnet` path: when the caller passes `tailnet` explicitly it writes both halves of the comparison, so the check proves only self-agreement. The description now says so.
- The budget-exhausted error now names queueing when the budget was spent waiting for a `TAILSCALE_MAX_CONCURRENT` slot, instead of reading like a network fault with no request ever sent.

### Changed
- **`Retry-After: 0` is still honored literally, and now says why.** The seconds branch accepts `0` as "retry now" (a legal delay-seconds value per RFC 7231) while the HTTP-date branch refuses a non-positive delta -- an asymmetry that reads as an oversight because only the date branch explained itself. An explicit numeric `0` is an instruction; a stale date is clock skew. Both arms are now pinned by tests, so tightening it has to redden one rather than pass as a cleanup.
- **The test suite went 1180 -> 1651.** An audit of the 12 test files found 42 verified defects plus 6 structural gaps, the largest being that every behavioral test ran against the `tsc` output while `files` publishes only the esbuild bundle -- a second, independent copy with no behavioral coverage and nothing joining the two. The bundle's banner count is now asserted against the registry, a real JSON-RPC session pins the four resource URI and mimeType bindings, and `bin/tailscale-mcp.mjs` is executed rather than read as text. Every assertion added was mutation-tested rather than trusted for being green.

## [0.17.1] — 2026-08-23

### Fixed
- **The launcher no longer dies with a raw stack trace when `spawn` fails.** Node throws synchronously rather than emitting `error` for some unexecutable targets — notably a `.cmd`/`.bat` on Windows — and the `error` listener is registered *after* the `spawn` call, so it could never observe that throw. Both failure modes now route through one handler.
- **Windows `PATH` discovery accepts `oam.exe` only**, instead of walking every `PATHEXT` entry and returning an `oam.cmd` Node cannot execute. A skipped shim is still **named** in the diagnostic, so an npm-style install no longer reports as "no oam binary was found".
- **A failing in-process fallback no longer escapes as an unhandled rejection.** `void runInProcess()` discarded the promise, replacing the launcher's own diagnostic with a raw stack trace.
- **Diagnostics that precede `process.exit` are written synchronously.** stderr is async for TTYs and pipes on Windows, so the exit could truncate them. They route through one helper that also handles short writes and macOS `EAGAIN` on a non-blocking piped stderr.
- Removed a literal backspace byte (`U+0008`) from the runtime-discovery comment, which made git treat the file as binary so its diff could not be reviewed.
- **An oam that cannot be *run* is no longer reported as an *outdated* one.** The version probe returns null for several distinct causes — not executable, wrong architecture, a shim Node refuses, deleted since the stat, unparseable `--version` output — and every one produced "older than oam 0.9.0 … run `oam self-update`", pointing at the single cause it definitely was not. The two cases now carry separate wording and remedies, and the outdated message reports the version actually detected.
- **Windows: the launcher no longer hard-kills the server on the first Ctrl-C.** There are no POSIX signals on Windows — `child.kill(sig)` ignores the name and calls `TerminateProcess`, an immediate hard kill (verified: a child with a `SIGTERM` handler never runs it and dies with `code=null`). The launcher forwarded anyway, on the stated assumption that this was a "no-op on Windows", so it aborted the graceful shutdown the console's own Ctrl-C had just started and skipped the server's `process.on("exit")` cleanup. The console already delivers the event to the whole process group, so on Windows the launcher now forwards nothing.
- **A wedged server no longer leaves the launcher hanging.** Forwarding was gated on `child.killed`, which records only that `kill()` was *called* — never that the child is gone — so every signal after the first was swallowed and there was no escape hatch. Escalation is now armed by a timer on the first signal: one press is enough, and a child still alive after a 2s grace window is killed. Using a timer rather than counting signals also stops the ordinary supervisor sequence (`SIGINT` then `SIGTERM` milliseconds apart) from being misread as impatience.
- **The test suite is bounded by `--test-timeout`, so a hang cannot wedge a release.** `node:test` has no default per-test timeout, so a test awaiting an event that never arrives runs forever -- and `npm test` runs unattended inside `release.sh`, which turns a wedged release rather than a failed one. 300000ms is deliberately generous (files measure ~7.5s worst case) and converts an infinite hang into a reported failure. Note the flag is per-FILE until Node 24, and requires Node >= 20.11.0.
- **`engines.node` now declares `>=20.11.0`**, matching what the test tooling actually requires (`--test-timeout` landed in Node 20.11.0). The previous `>=20` admitted 20.0-20.10, where the flag does not exist. README updated to match.


## [0.17.0] — 2026-08-23

### Added
- The server warns at startup when `TAILSCALE_OAUTH_TAILNET` and `TAILSCALE_TAILNET` name different tailnets -- a combination that makes every tailnet-scoped tool return 403 while the error text blames credentials.
- `tailscale_delete_tailnet` accepts an optional `tailnet` argument, so an id returned by `tailscale_list_org_tailnets` can be deleted without editing env and restarting. `confirmTailnet` must match the effective target, and the explicit value is percent-encoded since it is tool input rather than trusted env. Cross-tailnet deletion depends on token scope and is unverified against a live tailnet.
- **Two local-CLI diagnostics** (opt-in group): `tailscale_local_whoami` and `tailscale_local_service_list`, both landed in tailscale 1.102.1. `service list` reports what *this node* can see, which is the difference that matters when a service exists in the tailnet config but is unreachable. No client-version pre-check: an older binary's `unknown subcommand` error is already self-explaining and reaches the agent verbatim.
- **OAuth Apps for device provisioning** (Tailscale alpha, in the `keys` group): `tailscale_create_oauth_app` and `tailscale_get_oauth_app`. Distinct from an OAuth *client* -- this is the three-legged authorization-code app that lets a third party enroll one device, scoped `auth_keys:create:once`.
- **Organization tailnets** (`org-tailnets` group, 3 tools): `tailscale_list_org_tailnets` (paginated via `limit` / `cursor`), `tailscale_create_org_tailnet`, and `tailscale_delete_tailnet`. These are the only endpoints here under `/organizations`, they authenticate only with an OAuth client (`tailnets` scope to create, `all` to reach the result), and they cover the API-only-tailnet flow used for per-agent sandboxes and ephemeral CI. The group is named `org-tailnets`, not `tailnets`, because the latter sits one character from the existing `tailnet` group (settings/contacts) and `TAILSCALE_TOOLS` matches exactly with no near-miss warning -- a typo would have handed an operator an irreversible whole-tailnet delete.
- **`TAILSCALE_OAUTH_TAILNET`**: targets an API-only tailnet on the OAuth token exchange (`/oauth/token?tailnet=...`). Deliberately a separate variable from `TAILSCALE_TAILNET`, which is already set to an ordinary tailnet name by most existing OAuth users; the default token request is unchanged.
- **`TAILSCALE_EXTRA_POSTURE_PROVIDERS`**: escape hatch for posture providers Tailscale ships between releases, mirroring `TAILSCALE_EXTRA_WEBHOOK_EVENTS`.

### Fixed
- `tailscale_delete_tailnet`, `tailscale_create_org_tailnet` and the `organization` parameter now reject whitespace-only input. A bare `min(1)` accepted `" "`, which trimmed to `""` in the handler and fell back to the configured tailnet -- so "delete the tailnet I named" quietly became "delete the default one". The `confirmTailnet` guard still held, so it was never a wrong-target delete, but silent retargeting is the wrong shape for an irreversible operation.
- Removed an invented `max(1000)` ceiling on `tailscale_list_org_tailnets`'s `limit`. Tailscale's documented maximum is unknown, so the cap could only reject values the API accepts or wave through ones it does not.
- **The posture `provider` and webhook `subscriptions` fields no longer advertise their valid values to MCP clients.** Both use `superRefine` rather than `z.enum` so the allowed set can be extended at runtime, but that silently dropped the `enum` array from the generated JSON Schema, leaving `{"type":"string"}` with the values only in prose -- losing constrained decoding and enum-rendering UI. Both now carry `.meta({ enum })`, resolved at module load so a server started with the corresponding `TAILSCALE_EXTRA_*` variable advertises those extras too.
- Auth-error messages and README links pointed at `login.tailscale.com/admin/...`. Tailscale migrated the admin console to `console.tailscale.com` in July 2026; the old host now bounces through a login redirect. These strings are what a stuck operator reads, so they now cite the current host.
- **The sandbox silently disabled the local-CLI tools.** `TAILSCALE_LOCAL_CLI` was missing from the `--allow-env` list in `bin/tailscale-mcp.mjs`, so under `TAILSCALE_MCP_SANDBOX=1` the variable was absent from `process.env` and the group never registered -- despite `--allow-child-process` being granted specifically so those tools could shell out. The allow-list is derived from what the bundle reads, and the derivation missed this one because `isLocalCliEnabled` reads it off a passed-in `env` parameter rather than `process.env` directly.
- **`tailscale_create_posture_integration` could not create Fleet or Huntress integrations at all.** The `provider` field was a closed `z.enum` of six values, so a provider Tailscale added later was rejected at the schema layer before a request was ever built -- uncreatable rather than merely unvalidated. Now validated against a static list of all eight current slugs with a runtime escape hatch. (Slugs, not display names: Kandji renamed to Iru and Kolide to 1Password XAM, but both slugs are unchanged.)

### Changed
- README no longer claims coverage of "the full Tailscale v2 API" -- organization tailnets and OAuth apps were both absent when that was written. It now enumerates what is actually covered.

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
