#!/bin/bash
# =============================================================================
# Release Script — Test, bump, tag, publish to npm, create GitHub release
# =============================================================================
# Usage:
#   ./release.sh <new-version>
#   ./release.sh 0.3.0
#
# If interrupted, just re-run with the same version — each step is idempotent.
#
# Prerequisites:
#   - gh CLI authenticated (or GITHUB_TOKEN set)
#   - npm authenticated (or NPM_TOKEN set)
#   - Node.js + npm installed
#
# In CI, set the CI environment variable to skip the confirmation prompt.
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

# ---- Validate arguments ----
if [ $# -ne 1 ]; then
  echo "Usage: ./release.sh <version>"
  echo "  e.g. ./release.sh 0.3.0"
  exit 1
fi

VERSION="$1"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

# ---- Pre-flight checks ----
echo -e "${CYAN}Pre-flight checks...${NC}"

command -v gh >/dev/null   || fail "gh CLI not installed"
command -v node >/dev/null || fail "node not installed"
command -v npm >/dev/null  || fail "npm not installed"

CURRENT_VERSION=$(node -p "require('./package.json').version")

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Resuming release v${VERSION}"
else
  if [ -n "$(git status --porcelain)" ]; then
    fail "Working directory not clean. Commit or stash changes first."
  fi
  info "Current version: $CURRENT_VERSION → $VERSION"
fi

# ---- Confirmation (skip in CI) ----
if [ -z "${CI:-}" ] && [ "$CURRENT_VERSION" != "$VERSION" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Run tests and lint"
  echo "  2. Bump version in package.json"
  echo "  3. Commit, tag, and push"
  echo "  4. Publish to npm"
  echo "  5. Create GitHub release"
  echo ""
  read -p "Continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# =============================================================================
# Step 1: Test and lint
# =============================================================================
step 1 "Test and lint"

npm run build || fail "Build failed"
npm run lint || fail "Lint failed"
npm test || fail "Tests failed"
info "All checks passed"

# =============================================================================
# Step 2: Bump version
# =============================================================================
step 2 "Bump version to $VERSION"

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Already at v${VERSION} — skipping"
else
  npm version "$VERSION" --no-git-tag-version
  info "package.json updated"
fi

# =============================================================================
# Step 3: Commit and tag
# =============================================================================
step 3 "Commit and tag"

if [ -n "$(git status --porcelain package.json package-lock.json 2>/dev/null)" ]; then
  git add package.json package-lock.json
  git commit -m "v${VERSION}"
  info "Committed version bump"
else
  info "Already committed — skipping"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "Tag v${VERSION} already exists — skipping"
else
  git tag "v${VERSION}"
  info "Tag v${VERSION} created"
fi

# =============================================================================
# Step 4: Push
# =============================================================================
step 4 "Push to origin"

git push origin main --tags
info "Pushed commit and tag"

# =============================================================================
# Step 5: Publish to npm
# =============================================================================
step 5 "Publish to npm"

NPM_VERSION=$(npm view @yawlabs/tailscale-mcp version 2>/dev/null || echo "")
if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "Already published to npm — skipping"
else
  npm publish --access public
  info "Published @yawlabs/tailscale-mcp@${VERSION} to npm"
fi

# =============================================================================
# Step 6: Create GitHub release
# =============================================================================
step 6 "Create GitHub release"

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists — skipping"
else
  # Generate changelog from commits since previous tag
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

# npm can take a moment to propagate
sleep 3

LIVE_VERSION=$(npm view @yawlabs/tailscale-mcp version 2>/dev/null || echo "")
if [ "$LIVE_VERSION" = "$VERSION" ]; then
  info "npm: @yawlabs/tailscale-mcp@${LIVE_VERSION}"
else
  warn "npm: ${LIVE_VERSION} (expected ${VERSION} — may still be propagating)"
fi

GH_TAG=$(gh release view "v${VERSION}" --json tagName --jq '.tagName' 2>/dev/null || echo "")
if [ "$GH_TAG" = "v${VERSION}" ]; then
  info "GitHub release: ${GH_TAG}"
else
  warn "GitHub release: not found"
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     v${VERSION} released successfully!          ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  npm: npm i @yawlabs/tailscale-mcp@${VERSION}   ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
