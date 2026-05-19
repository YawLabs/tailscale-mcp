#!/bin/bash
# =============================================================================
# Release Script — Build, tag, publish to npm, create GitHub release
# =============================================================================
# Usage:
#   ./release.sh <new-version>    — full release from local machine
#   ./release.sh                  — CI mode (derives version from git tag)
#
# If interrupted, re-run with the same version — each step is idempotent.
#
# Prerequisites:
#   - Node.js 18+ and npm installed
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

TOTAL_STEPS=7

# ---- Resolve version ----
VERSION="${1:-}"
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
  echo "  1. Run lint + tests"
  echo "  2. Build"
  echo "  3. Bump version in package.json"
  echo "  4. Commit, tag, and push"
  echo "  5. Publish to npm"
  echo "  6. Create GitHub release"
  echo "  7. Verify"
  echo ""
  read -p "Continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# =============================================================================
# Step 1: Lint
# =============================================================================
step 1 "Lint"

npm run lint || fail "Lint failed"
info "Lint passed"

# =============================================================================
# Step 2: Test
# =============================================================================
step 2 "Test"

npm run build || fail "Build failed"
npm test || fail "Tests failed"
info "All tests passed"

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

# server.json carries the version twice (top-level + packages[0]) and is what
# the Official MCP Registry reads at publish time. `npm version` doesn't touch
# it, so bump in lockstep here or the next release ships a desynced registry
# entry. Always re-run (cheap, idempotent) so a partial prior run that bumped
# package.json but not server.json gets cleaned up on resume.
node -e "
  const fs = require('node:fs');
  const file = 'server.json';
  const p = JSON.parse(fs.readFileSync(file, 'utf-8'));
  p.version = '$VERSION';
  if (Array.isArray(p.packages)) {
    for (const pkg of p.packages) pkg.version = '$VERSION';
  }
  fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
"
info "server.json synced to v${VERSION}"

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
  git push origin main --follow-tags
  info "Pushed to origin"
fi

# =============================================================================
# Step 5: Publish to npm
# =============================================================================
step 5 "Publish to npm"
# Three publish paths, picked by environment:
#   1. IS_CI=true                    -> WE are CI. Do the publish (NODE_AUTH_TOKEN
#                                       is set; --provenance for sigstore).
#   2. IS_CI=false + release.yml     -> CI will publish on the tag we just pushed.
#      exists with CI publish path      Watch `gh run watch` for that run and
#                                       verify via `npm view`. Workstation MUST
#                                       NOT also publish -- stale ~/.npmrc fails
#                                       E404, valid one races CI for the same
#                                       version. CI is authoritative.
#   3. IS_CI=false + no CI publish   -> Workstation IS the publisher. Try locally
#      path                             with EOTP retry for fresh WebAuthn sessions.
PUBLISHED_VERSION=$(npm view "@yawlabs/tailscale-mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "v${VERSION} already published on npm — skipping"
elif [ "$IS_CI" = "true" ]; then
  npm publish --access public --provenance
  info "Published @yawlabs/tailscale-mcp@${VERSION} to npm (with provenance)"
elif [ -f ".github/workflows/release.yml" ] && grep -q "npm publish\|NODE_AUTH_TOKEN\|release.sh" .github/workflows/release.yml; then
  info "CI release.yml fires on v* tag push -- workstation hands off to CI"
  TAG_SHA=$(git rev-parse "v${VERSION}^{}")
  RUN_ID=""
  for i in 1 2 3 4 5; do
    RUN_ID=$(gh run list --workflow=Release --event=push --commit="$TAG_SHA" --limit=1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || echo "")
    [ -n "$RUN_ID" ] && break
    sleep 2
  done
  if [ -z "$RUN_ID" ]; then
    fail "Could not find Release workflow run for tag v${VERSION} (commit $TAG_SHA). Push may have failed or CI is misconfigured. Check 'gh run list --limit 5'."
  fi
  info "Watching CI Release run $RUN_ID"
  gh run watch "$RUN_ID" --exit-status || fail "CI Release run $RUN_ID failed. See 'gh run view $RUN_ID --log-failed'."
  for i in 1 2 3 4 5; do
    NPM_NOW=$(npm view "@yawlabs/tailscale-mcp@${VERSION}" version 2>/dev/null || echo "")
    [ "$NPM_NOW" = "$VERSION" ] && break
    sleep 3
  done
  [ "$NPM_NOW" = "$VERSION" ] || fail "CI workflow succeeded but npm registry still shows '$NPM_NOW' for @yawlabs/tailscale-mcp@${VERSION}. Likely propagation lag -- retry verification in a minute."
  info "Published @yawlabs/tailscale-mcp@${VERSION} via CI Release run $RUN_ID"
else
  # Workstation IS the publisher (no CI fallback). Retry only on EOTP/EAUTH/OTP
  # for fresh WebAuthn sessions; fail fast on everything else.
  ATTEMPT=1
  MAX_ATTEMPTS=3
  while true; do
    PUBLISH_LOG=$(mktemp)
    if npm publish --access public 2>&1 | tee "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      break
    fi
    if ! grep -qE 'EOTP|EAUTH|one-time password|OTP' "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      fail "npm publish failed (non-OTP error -- see output above). If E401/E404, your ~/.npmrc session is stale: run 'npm login --auth-type=web' and retry."
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

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists — skipping"
else
  PREV_TAG=$(git tag --sort=-v:refname | grep -A1 "^v${VERSION}$" | tail -1)
  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "v${VERSION}" ]; then
    CHANGELOG=$(git log --oneline "${PREV_TAG}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /')
  else
    CHANGELOG="Initial release"
  fi

  gh release create "v${VERSION}" \
    --title "v${VERSION}" \
    --notes "$CHANGELOG"
  info "GitHub release created"
fi

# =============================================================================
# Step 7: Verify
# =============================================================================
step 7 "Verify"

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
