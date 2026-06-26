#!/bin/bash
# =============================================================================
# Release Script — Build, tag, publish to npm, create GitHub release
# =============================================================================
# Usage:
#   ./release.sh <new-version>    — full release from local machine
#   ./release.sh                  — CI mode (derives version from git tag)
#   ./release.sh --self-test      — run the pure-helper self-tests and exit
#
# If interrupted, re-run with the same version — each step is idempotent.
#
# Prerequisites:
#   - Node.js 22+ and npm installed
#   - npm authenticated (npm whoami) or NODE_AUTH_TOKEN set
#   - gh CLI authenticated (or GITHUB_TOKEN set)
# =============================================================================

set -euo pipefail
trap 'echo -e "\n\033[0;31m  ✗ Release failed at line $LINENO (exit code $?)\033[0m"' ERR

# ---- Helpers ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

# SKIP_LINT=1 escape hatch -- wraps `npm`/`pnpm` so lint-related runs are
# no-ops. Workaround for the MINGW64-ARM64 npm-run-script wrapper that
# segfaults on exit-cleanup (platform-windows.md). Apply only when the
# lint runner is broken on the host; CI catches lint regressions anyway.
if [ "${SKIP_LINT:-}" = "1" ]; then
  npm() {
    if [ "$1" = "run" ] && [[ "$2" == lint* ]]; then
      warn "SKIP_LINT=1 -- noop 'npm run $2'"
      return 0
    fi
    command npm "$@"
  }
  pnpm() {
    if [ "$1" = "run" ] && [[ "$2" == lint* ]]; then
      warn "SKIP_LINT=1 -- noop 'pnpm run $2'"
      return 0
    fi
    command pnpm "$@"
  }
fi

TOTAL_STEPS=8

# ---- Pure helpers (testable via --self-test) ----

# Read a newline-separated tag list (sorted newest-first, as from
# `git tag --sort=-v:refname`) on stdin and emit the predecessor of v$1,
# considering stable X.Y.Z tags only -- rc/pre-release tags sort BEFORE their
# matching stable tag under -v:refname and would otherwise be picked as the
# predecessor. Contract: emits v$1 ITSELF when it is the oldest stable tag
# (the caller treats self as "initial release"), and nothing when v$1 is
# absent from the list.
compute_prev_tag() {
  grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | grep -A1 "^v$1$" | tail -1
}

# Classify an npm publish log: OTP/WebAuthn-propagation class (retryable)
# vs everything else (fail fast).
is_otp_error() {
  grep -qE 'EOTP|EAUTH|one-time password|OTP' "$1"
}

# ---- Self-test mode (no release actions, exits before version resolution) ----
if [ "${1:-}" = "--self-test" ]; then
  echo "release.sh self-test"
  FAILS=0
  expect() { # label expected actual
    if [ "$2" = "$3" ]; then
      info "$1"
    else
      warn "$1 -- expected '$2', got '$3'"
      FAILS=$((FAILS + 1))
    fi
  }
  TAGS=$'v0.13.0-rc.1\nv0.13.0\nv0.12.8\nv0.12.7'
  expect "prev of 0.13.0 skips the rc tag" "v0.12.8" "$(printf '%s\n' "$TAGS" | compute_prev_tag 0.13.0 || true)"
  expect "prev of 0.12.8" "v0.12.7" "$(printf '%s\n' "$TAGS" | compute_prev_tag 0.12.8 || true)"
  expect "oldest tag yields itself (caller treats self as initial release)" "v0.12.7" "$(printf '%s\n' "$TAGS" | compute_prev_tag 0.12.7 || true)"
  expect "absent version yields empty" "" "$(printf '%s\n' "$TAGS" | compute_prev_tag 9.9.9 || true)"
  OTP_LOG=$(mktemp)
  NON_OTP_LOG=$(mktemp)
  echo "npm ERR! code EOTP -- one-time password required" > "$OTP_LOG"
  echo "npm ERR! code E404 -- not found" > "$NON_OTP_LOG"
  R_OTP=$(is_otp_error "$OTP_LOG" && echo yes || echo no)
  R_NON=$(is_otp_error "$NON_OTP_LOG" && echo yes || echo no)
  rm -f "$OTP_LOG" "$NON_OTP_LOG"
  expect "EOTP log is OTP-class (retryable)" "yes" "$R_OTP"
  expect "E404 log is not OTP-class (fail fast)" "no" "$R_NON"
  if [ "$FAILS" -eq 0 ]; then
    info "self-test passed"
    exit 0
  fi
  fail "self-test: $FAILS assertion(s) failed"
fi

# ---- Resolve version ----
VERSION="${1:-}"
# CI mode is dormant: all GitHub workflows were dropped in 1b18b85 (registry
# publish folded into this script). The IS_CI branches are kept so a future
# re-added tag workflow can reuse this script unchanged; until then every
# release is a workstation release -- which also means no npm provenance
# attestation (npm only attests from inside a supported CI environment).
IS_CI="${CI:-false}"

if [ -z "$VERSION" ]; then
  if [ "$IS_CI" = "true" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
    VERSION="${GITHUB_REF_NAME#v}"
    info "CI mode — version $VERSION from tag $GITHUB_REF_NAME"
  else
    echo "Usage: ./release.sh <version>"
    echo "  e.g. ./release.sh 0.3.0"
    exit 1
  fi
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

# ---- Pre-flight checks ----
echo -e "${CYAN}Pre-flight checks...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null || fail "node not installed"
command -v npm >/dev/null  || fail "npm not installed"
command -v gh >/dev/null   || fail "gh not installed (needed for step 6 release create and the step 7 registry-token fallback)"
gh auth status >/dev/null 2>&1 || fail "gh not authenticated. Workstation: 'gh auth login'. CI: GITHUB_TOKEN env var must be set."

CURRENT_VERSION=$(node -p "require('./package.json').version")
RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  info "Already at v${VERSION} — resuming"
else
  if [ "$IS_CI" != "true" ]; then
    if [ -n "$(git status --porcelain)" ]; then
      fail "Working directory not clean. Commit or stash changes first."
    fi
  fi
  info "Current: v${CURRENT_VERSION} → v${VERSION}"
fi

if [ "$IS_CI" != "true" ] && [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Lint"
  echo "  2. Build + Test"
  echo "  3. Bump version in package.json and server.json"
  echo "  4. Commit, tag, and push"
  echo "  5. Publish to npm"
  echo "  6. Create GitHub release"
  echo "  7. Publish to MCP Registry"
  echo "  8. Verify"
  echo ""
  if [ -t 0 ]; then
    read -p "Continue? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Aborted."
      exit 0
    fi
  else
    info "Non-interactive shell -- proceeding without confirmation"
  fi
fi

# =============================================================================
# Step 1: Lint
# =============================================================================
step 1 "Lint"

npm run lint || fail "Lint failed"
info "Lint passed"

# =============================================================================
# Step 2: Build + Test
# =============================================================================
step 2 "Build + Test"

# `npm test` is `npm run build && node --test ...` -- the build is included,
# so don't run `npm run build` separately above (was a redundant back-to-back
# build, ~5-10s wasted per release).
#
# Pipe through tee so node's test runner emits TAP (its non-TTY default), then
# floor-check the "# tests" total. A glob or discovery regression that runs
# only a subset of test files still exits 0 -- the shrunken total is the only
# visible signal (the unquoted-glob form of the test script had exactly this
# failure mode under POSIX sh). Bump the floor when the suite grows.
TEST_FLOOR=900
TEST_LOG=$(mktemp)
npm test 2>&1 | tee "$TEST_LOG" || { rm -f "$TEST_LOG"; fail "Tests failed"; }
TEST_COUNT=$(grep -E '^# tests [0-9]+' "$TEST_LOG" | tail -1 | awk '{print $3}' || true)
rm -f "$TEST_LOG"
if [ -z "$TEST_COUNT" ]; then
  fail "Could not find the TAP '# tests' summary in test output -- runner output format changed?"
fi
if [ "$TEST_COUNT" -lt "$TEST_FLOOR" ]; then
  fail "Test runner discovered only $TEST_COUNT tests (floor: $TEST_FLOOR) -- test-discovery regression, not a real pass"
fi
info "All tests passed ($TEST_COUNT tests)"

# =============================================================================
# Step 3: Bump version
# =============================================================================
step 3 "Bump version to $VERSION"

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Already at v${VERSION} — skipping"
else
  npm version "$VERSION" --no-git-tag-version
  info "Version bumped"
fi

# server.json is published to the MCP Registry in step 7 and must match the
# tag's version. This runs UNCONDITIONALLY (not inside the bump else above)
# so a resume run where package.json was bumped in a prior invocation still
# syncs server.json -- otherwise mcp-publisher tries to re-publish the
# previous version and gets 400 "cannot publish duplicate version".
# Idempotent: the inner if skips the write when server.json is already in
# sync, so a clean re-run produces no working-tree dirt.
if [ -f server.json ]; then
  CURRENT_SERVER_VERSION=$(jq -r '.version' server.json 2>/dev/null || echo "")
  if [ "$CURRENT_SERVER_VERSION" != "$VERSION" ]; then
    jq --arg v "$VERSION" '.version = $v | .packages[0].version = $v' server.json > server.tmp
    mv server.tmp server.json
    info "server.json synced to $VERSION"
  fi
fi

# =============================================================================
# Step 4: Commit, tag, and push
# =============================================================================
step 4 "Commit, tag, and push"

if [ "$IS_CI" = "true" ]; then
  info "CI mode — skipping commit/tag/push (already tagged)"
else
  if [ -n "$(git status --porcelain package.json package-lock.json server.json 2>/dev/null)" ]; then
    git add package.json package-lock.json server.json
    git commit -m "v${VERSION}"
    info "Committed version bump"
  else
    info "Nothing to commit"
  fi

  if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
    info "Tag v${VERSION} already exists"
  else
    # Annotated (-a) so `git push --follow-tags` below picks it up;
    # lightweight tags are ignored by --follow-tags and would silently
    # fail to publish (release commit lands but tag-push is a no-op).
    git tag -a "v${VERSION}" -m "v${VERSION}"
    info "Tag v${VERSION} created"
  fi

  # --follow-tags pushes only annotated tags reachable from the pushed
  # commits, not every local tag. Avoids accidentally publishing dangling
  # experimental tags that happen to be lying around.
  # Tag-drift safety: refuse to push if origin already has a tag at this name
  # pointing to a different commit (rewound tag elsewhere, parallel release race).
  # Without this check, `git push --follow-tags` SILENTLY skips updating the
  # tag on origin (the tag exists, no fast-forward happens). The main push
  # reports success, but origin's tag stays at the old SHA -- and the later
  # `gh release create` step then creates a GitHub release linked to that
  # stale commit while npm carries the new one.
  ORIGIN_TAG_SHA=$(git ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | awk '{print $1}')
  if [ -n "$ORIGIN_TAG_SHA" ]; then
    LOCAL_TAG_SHA=$(git rev-parse "v${VERSION}")
    if [ "$ORIGIN_TAG_SHA" != "$LOCAL_TAG_SHA" ]; then
      fail "Tag v${VERSION} exists on origin at $ORIGIN_TAG_SHA but local tag points to $LOCAL_TAG_SHA -- resolve the drift before re-running"
    fi
  fi

  git push origin main --follow-tags
  info "Pushed to origin"
fi

# =============================================================================
# Step 5: Publish to npm
# =============================================================================
step 5 "Publish to npm"
# Two publish paths, picked by environment:
#   1. IS_CI=true                    -> WE are CI. Do the publish (NODE_AUTH_TOKEN
#                                       is set; --provenance for sigstore).
#   2. IS_CI=false                   -> Workstation IS the publisher. Try locally
#                                       with EOTP retry for fresh WebAuthn sessions.
PUBLISHED_VERSION=$(npm view "@yawlabs/tailscale-mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "v${VERSION} already published on npm — skipping"
elif [ "$IS_CI" = "true" ]; then
  npm publish --access public --provenance
  info "Published @yawlabs/tailscale-mcp@${VERSION} to npm (with provenance)"
else
  # Workstation IS the publisher. Retry only on EOTP/EAUTH/OTP for fresh
  # WebAuthn sessions; fail fast on everything else.
  ATTEMPT=1
  MAX_ATTEMPTS=3
  while true; do
    PUBLISH_LOG=$(mktemp)
    # pipefail-safe: the `if` consumes the pipeline's exit code, so npm
    # publish failures don't trip `set -e` here. If you ever refactor this
    # away from `if ... | tee` (e.g. to a redirect), re-test that EOTP
    # detection still works -- pipefail will mask npm publish's exit code.
    if npm publish --access public 2>&1 | tee "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      break
    fi
    if ! is_otp_error "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      fail "npm publish failed (non-OTP error -- see output above). If E401/E404, the npm token in ~/.npmrc is missing or stale -- restore a valid automation token (npmjs.com > Access Tokens). Do NOT run 'npm login --auth-type=web' -- it replaces the automation token with a 2FA-bound web session that breaks scripted publishes."
    fi
    rm -f "$PUBLISH_LOG"
    if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
      fail "npm publish failed after $MAX_ATTEMPTS OTP-class attempts. WebAuthn session may not be propagating."
    fi
    warn "npm publish attempt $ATTEMPT EOTPed -- waiting 30s for WebAuthn session to propagate"
    ATTEMPT=$((ATTEMPT + 1))
    sleep 30
  done
  info "Published @yawlabs/tailscale-mcp@${VERSION} to npm (workstation)"
fi

# =============================================================================
# Step 6: Create GitHub release
# =============================================================================
step 6 "Create GitHub release"

# Predecessor via the compute_prev_tag helper (defined + self-tested near the
# top of this script): prefilters to strict X.Y.Z tags so a pre-release like
# v0.13.0-rc.1 can't be picked as the predecessor of a stable release. `|| true`
# keeps set -e happy on a first release, where the tag list has no match and
# the helper's grep exits non-zero.
PREV_TAG=$(git tag --sort=-v:refname | compute_prev_tag "$VERSION" || true)
if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "v${VERSION}" ]; then
  CHANGELOG=$(git log --oneline "${PREV_TAG}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /')
else
  CHANGELOG="Initial release"
fi

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  # Release already exists -- almost always because release.yml (which fires on
  # tag push and uses softprops/action-gh-release@v2) created an empty-body
  # release with the SEA binaries before step 4's `git push --follow-tags`
  # returned. Edit the notes onto it instead of skipping; otherwise every
  # release ships with an empty body until someone manually `gh release edit`s
  # it. Idempotent: re-running with the same CHANGELOG produces no diff.
  EXISTING_BODY=$(gh release view "v${VERSION}" --json body --jq '.body' 2>/dev/null || echo "")
  if [ "$EXISTING_BODY" = "$CHANGELOG" ]; then
    info "GitHub release v${VERSION} already has the current changelog -- skipping"
  else
    gh release edit "v${VERSION}" --notes "$CHANGELOG" >/dev/null
    info "GitHub release v${VERSION} body updated (release.yml created it first)"
  fi
else
  gh release create "v${VERSION}" \
    --title "v${VERSION}" \
    --notes "$CHANGELOG"
  info "GitHub release created"
fi

# =============================================================================
# Step 7: Publish to the Official MCP Registry
# =============================================================================
# Downstream catalogs (Glama, PulseMCP, mcpservers.org) auto-source from the
# Official MCP Registry; publishing here is what makes the new version visible
# to them. server.json was already bumped in step 3 so the version matches the
# tag.
step 7 "Publish to MCP Registry"

if [ ! -f server.json ]; then
  info "No server.json -- not an MCP server, skipping registry publish"
else
  # Post-publish smoke test: a fresh install via npx should be able to
  # execute the binary and respond to --version.
  # Catches packaging regressions (missing bin shebang, bad "files" entry,
  # broken esbuild output) before they hit real users. Run from a temp dir so
  # npx doesn't resolve our own (unbuilt) local path via the checkout's
  # package.json `bin` entry.
  SMOKE_DIR=$(mktemp -d)
  (
    cd "$SMOKE_DIR"
    # Registry propagation can lag well past a minute after publish succeeds,
    # and `npm view` and `npx` may hit different CDN paths. Retry the actual
    # smoke (the npx invocation itself) with a budget generous enough to
    # outlast realistic propagation. 30 * 10s = ~5min upper bound; typical
    # case completes in < 30s.
    ATTEMPTS=30
    SLEEP_SECONDS=10
    SMOKE_OUTPUT=""
    STARTED_AT=$(date +%s)
    for i in $(seq 1 $ATTEMPTS); do
      if SMOKE_OUTPUT=$(npx -y "@yawlabs/tailscale-mcp@${VERSION}" --version 2>/dev/null); then
        echo "  npx output: $SMOKE_OUTPUT (after $(( $(date +%s) - STARTED_AT ))s)"
        break
      fi
      echo "  Waiting for @yawlabs/tailscale-mcp@${VERSION} to be installable via npx (attempt $i/$ATTEMPTS, ${SLEEP_SECONDS}s)..."
      sleep $SLEEP_SECONDS
    done
    if [ "$SMOKE_OUTPUT" != "$VERSION" ]; then
      echo "Expected $VERSION, got '$SMOKE_OUTPUT' after $ATTEMPTS attempts ($(( $(date +%s) - STARTED_AT ))s)" >&2
      exit 1
    fi
  ) || fail "Smoke test failed -- published package does not respond to --version with $VERSION"
  rm -rf "$SMOKE_DIR"
  info "Smoke test passed"

  # mcp-publisher binary cached at ~/.local/bin. Pinned to "latest" upstream;
  # if the registry's CLI introduces a breaking change, the next release will
  # surface it. The OS/arch detection handles Linux, macOS, and Git Bash on
  # Windows (MINGW/MSYS uname -s starts with "mingw" / "msys").
  MP="${MCP_PUBLISHER:-$HOME/.local/bin/mcp-publisher}"
  if ! [ -x "$MP" ]; then
    info "mcp-publisher not found at $MP -- downloading"
    mkdir -p "$(dirname "$MP")"
    OS_RAW=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$OS_RAW" in mingw*|msys*|cygwin*) OS=windows ;; *) OS="$OS_RAW" ;; esac
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    TMP=$(mktemp -d)
    curl -sL -o "$TMP/mp.tar.gz" \
      "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${OS}_${ARCH}.tar.gz" \
      || fail "Failed to download mcp-publisher (${OS}/${ARCH})"
    tar xzf "$TMP/mp.tar.gz" -C "$TMP" || fail "Failed to extract mcp-publisher tarball"
    if [ -f "$TMP/mcp-publisher.exe" ]; then
      mv "$TMP/mcp-publisher.exe" "$MP"
    else
      mv "$TMP/mcp-publisher" "$MP"
    fi
    rm -rf "$TMP"
    chmod +x "$MP" 2>/dev/null || true
  fi

  # Locally we use a GitHub PAT via `login github -token <PAT>`. The PAT
  # needs read:org for YawLabs so the registry can verify org membership for the
  # io.github.YawLabs/* namespace.
  # Fall back to gh CLI's session token if MCP_REGISTRY_TOKEN is unset --
  # gh auth login (admin:org or read:org scope) covers the namespace claim.
  : "${MCP_REGISTRY_TOKEN:=$(gh auth token 2>/dev/null || true)}"
  if [ -z "${MCP_REGISTRY_TOKEN:-}" ]; then
    fail "MCP_REGISTRY_TOKEN unset -- set it to a GitHub PAT with read:org for YawLabs (or run '$MP login github' once interactively to cache the session)."
  fi
  "$MP" login github -token "$MCP_REGISTRY_TOKEN" >/dev/null 2>&1 \
    || fail "mcp-publisher login failed -- check MCP_REGISTRY_TOKEN scopes (needs read:org for YawLabs)"
  "$MP" publish \
    || fail "mcp-publisher publish failed -- npm + GitHub release succeeded, but the MCP Registry did not. Retry the step (re-run the script) once the cause is identified."
  info "Published to MCP Registry"
fi

# =============================================================================
# Step 8: Verify
# =============================================================================
step 8 "Verify"

sleep 3

NPM_VERSION=$(npm view "@yawlabs/tailscale-mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "npm: @yawlabs/tailscale-mcp@${NPM_VERSION}"
else
  warn "npm shows ${NPM_VERSION:-nothing} (expected $VERSION — may still be propagating)"
fi

PKG_VERSION=$(node -p "require('./package.json').version")
if [ "$PKG_VERSION" = "$VERSION" ]; then
  info "package.json: ${PKG_VERSION}"
else
  warn "package.json shows ${PKG_VERSION} (expected $VERSION)"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "git tag: v${VERSION}"
else
  warn "git tag v${VERSION} not found"
fi

# Provenance attestation check — npm attaches sigstore attestations when
# `npm publish --provenance` runs inside GitHub Actions (which is our CI path).
# A missing attestation is not fatal for local runs (we publish without
# --provenance there), but in CI it means something regressed.
if [ "$IS_CI" = "true" ]; then
  ATTEST=$(npm view "@yawlabs/tailscale-mcp@${VERSION}" dist.attestations.provenance.predicateType 2>/dev/null || echo "")
  if [ -n "$ATTEST" ]; then
    info "provenance attestation: $ATTEST"
  else
    warn "no provenance attestation found on v${VERSION} (expected in CI publish)"
  fi
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}  v${VERSION} released successfully!${NC}"
echo ""
echo -e "  npm: https://www.npmjs.com/package/@yawlabs/tailscale-mcp"
echo -e "  git: https://github.com/YawLabs/tailscale-mcp/releases/tag/v${VERSION}"
echo ""
