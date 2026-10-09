#!/bin/bash
# =============================================================================
# Release Script — Build, tag, publish to npm, create GitHub release
# =============================================================================
# Usage:
#   ./release.sh <new-version>    — full release from local machine
#   ./release.sh                  — CI mode (derives version from git tag)
#                                   dormant: no workflow in this repo calls it
#   ./release.sh --self-test      — run the pure-helper self-tests and exit
#
# If interrupted, re-run with the same version — each step is idempotent.
#
# Prerequisites:
#   - Node.js 22+ and npm installed
#   - npm automation token in ~/.npmrc (npmjs.com > Access Tokens > Generate >
#     Automation), or NODE_AUTH_TOKEN set. Verify with `npm whoami`.
#     Do NOT authenticate with `npm login --auth-type=web` -- it OVERWRITES the
#     automation token with a 2FA-bound web session and breaks scripted publishes.
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

# --- CHANGELOG promotion (ported from ctxlint) ---------------------------
# These scripts never promoted the [Unreleased] heading, so documented work
# accumulated there and shipped versions went out undocumented -- the cause of
# seven backfilled entries across this fleet on 2026-08-23. The promotion then
# skipped any release with nothing under [Unreleased], and step 6 took the
# GitHub release notes from commit subjects regardless, so ten versions shipped
# on 2026-09-13 with no changelog entry and subject-list release notes.
#
# Every release now gets a `## [<version>]` entry, and step 6 sources the
# release notes from it:
#   * [Unreleased] has content -> it becomes the version section, and a fresh,
#     empty [Unreleased] heading is left above it for the next change.
#   * [Unreleased] is empty or absent -> a version section is generated from
#     the commit subjects since the previous tag. Raw subjects are less than a
#     hand-written entry, but a version with no entry at all reads as a mistake.
#   * The Keep-a-Changelog link references at the bottom, when the file has
#     them, are moved along: [Unreleased] compares from the new tag, and the
#     version gets its own compare link.

changelog_section() {
  [ -f CHANGELOG.md ] || return 0
  awk -v heading="$1" '
    index($0, "## [" heading "]") == 1 { capture=1; next }
    capture && /^## \[/ { exit }
    capture { print }
  ' CHANGELOG.md
}

# True when a section body carries any non-whitespace content.
changelog_nonempty() { [ -n "$(echo "$1" | tr -d '[:space:]')" ]; }

# Reuse whatever separator this file already puts between version and date.
# The fleet mixes an em-dash and "--"; promoting with a hardcoded one would
# introduce a third style into whichever repos do not use it.
changelog_dash() {
  local d
  d=$(sed -nE 's/^## \[[0-9][^]]*\][[:space:]]+([^[:space:]]+)[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}.*/\1/p' CHANGELOG.md 2>/dev/null | head -1)
  if [ -n "$d" ]; then printf '%s' "$d"; else printf '%s' '--'; fi
}

# The tag this release is compared against: the newest STRICT X.Y.Z tag
# reachable from HEAD other than this release's own (a re-run after tagging
# must not compare the version with itself). Strict on purpose, the same rule
# compute_prev_tag below applies: the old v* glob here would return an -rc tag
# as predecessor while step 6's release-notes fallback skips it, so the
# changelog compare link and the notes would name different predecessors.
# Empty on a first release.
changelog_prev_tag() {
  # `|| true` for set -e: grep exits 1 when no strict tag matches (first
  # release), and head can close the pipe early under pipefail with several.
  git tag --merged HEAD --sort=-v:refname 2>/dev/null \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | grep -v "^v${VERSION}$" \
    | head -1 || true
}

# The body of a generated entry: one bullet per commit subject since the
# previous tag, newest first, with version-bump commits dropped.
changelog_generated_body() {
  local prev=$1 range subjects
  if [ -n "$prev" ]; then range="${prev}..HEAD"; else range="HEAD"; fi
  subjects=$(git log --no-merges --format='%s' "$range" 2>/dev/null \
    | grep -vE '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^/- /' || true)
  [ -n "$subjects" ] || subjects="- Maintenance release; no changes since ${prev:-the previous release}."
  printf '### Changed\n%s\n' "$subjects"
}

# Keep-a-Changelog link references, when the file uses them: [Unreleased]
# compares from the new tag, and the version gets its own compare link (or a
# tag link on a first release). A version link that already exists is kept.
changelog_update_links() {
  local prev=$1 tmp
  grep -qE '^\[Unreleased\]: .*/compare/.*\.\.\.HEAD' CHANGELOG.md || return 0
  tmp=$(mktemp)
  awk -v ver="$VERSION" -v prev="$prev" -v have_link="$(grep -c "^\[${VERSION}\]: " CHANGELOG.md || true)" '
    !done && /^\[Unreleased\]: .*\/compare\/.*\.\.\.HEAD/ {
      url=$0; sub(/^\[Unreleased\]: /, "", url); sub(/\/compare\/.*$/, "", url)
      print "[Unreleased]: " url "/compare/v" ver "...HEAD"
      if (have_link == 0) {
        if (prev != "") print "[" ver "]: " url "/compare/" prev "...v" ver
        else print "[" ver "]: " url "/releases/tag/v" ver
      }
      done=1; next
    }
    { print }
  ' CHANGELOG.md > "$tmp" || { rm -f "$tmp"; fail "CHANGELOG.md link update failed"; }
  mv "$tmp" CHANGELOG.md
}

# Make sure `## [<version>] <dash> <today>` exists: promote [Unreleased] when it
# has content, otherwise generate the section from the commit subjects.
promote_changelog() {
  [ -f CHANGELOG.md ] || return 0
  local prev
  prev=$(changelog_prev_tag)
  if changelog_nonempty "$(changelog_section "$VERSION")"; then
    info "CHANGELOG.md already has an entry for v${VERSION}"
    changelog_update_links "$prev"
    return 0
  fi
  local today tmp dash heading body
  today=$(date +%F)
  dash=$(changelog_dash)
  heading="## [${VERSION}] ${dash} ${today}"
  tmp=$(mktemp)
  if changelog_nonempty "$(changelog_section "Unreleased")"; then
    # Rewrite only the FIRST [Unreleased] heading: a stray later mention (a link
    # reference, a quoted example) must not become a second, bogus heading.
    awk -v repl="$heading" '
      !promoted && index($0, "## [Unreleased]") == 1 { print "## [Unreleased]"; print ""; print repl; promoted=1; next }
      { print }
    ' CHANGELOG.md > "$tmp" || { rm -f "$tmp"; fail "CHANGELOG.md promotion failed"; }
    info "CHANGELOG.md: promoted [Unreleased] -> [${VERSION}] ${dash} ${today}"
  else
    body=$(changelog_generated_body "$prev")
    warn "CHANGELOG.md has no [Unreleased] content -- writing [${VERSION}] from the commit subjects since ${prev:-the first commit}; edit it if they undersell the release"
    # Insert below an empty [Unreleased] heading, else above the first version
    # heading, else at the end of the file.
    awk -v heading="$heading" -v body="$body" '
      !done && index($0, "## [Unreleased]") == 1 { print; print ""; print heading; print ""; print body; done=1; next }
      !done && /^## \[/ { print heading; print ""; print body; print ""; done=1 }
      { print }
      END { if (!done) { print ""; print heading; print ""; print body } }
    ' CHANGELOG.md > "$tmp" || { rm -f "$tmp"; fail "CHANGELOG.md entry generation failed"; }
    info "CHANGELOG.md: added [${VERSION}] ${dash} ${today} from commit subjects"
  fi
  mv "$tmp" CHANGELOG.md
  changelog_update_links "$prev"
}

# Backstop for the promotion above: every release has an entry now, so a
# missing one means promote_changelog did not run or did not land, and the
# release notes in step 6 would silently fall back to commit subjects.
assert_changelog_promoted() {
  [ -f CHANGELOG.md ] || return 0
  changelog_nonempty "$(changelog_section "$VERSION")" && return 0
  fail "CHANGELOG.md has no '## [${VERSION}]' entry -- promote_changelog did not run or did not land."
}

# Release notes for step 6: the version's changelog section, trimmed of the
# blank lines around it; commit subjects only when there is no changelog.
release_notes() {
  local notes
  notes=$(changelog_section "$VERSION" | sed -e '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')
  if changelog_nonempty "$notes"; then
    printf '%s\n' "$notes"
  elif [ -n "${1:-}" ] && [ "$1" != "v${VERSION}" ]; then
    git log --oneline "${1}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /'
  else
    printf 'Initial release\n'
  fi
}

# SKIP_LINT=1 escape hatch -- wraps `npm`/`pnpm` so lint-related runs are
# no-ops.
#
# THIS SHOULD NOW BE UNNECESSARY, and reaching for it is a signal something
# regressed. `npm run lint` routes through scripts/lint.mjs, which runs biome
# from a binary that works on this host: on Windows ARM64 it provisions the x64
# build of the SAME version package-lock.json installs -- 2.5.4 -- and runs
# that under emulation.
#
# The earlier text here blamed "the MINGW64-ARM64 npm-run-script wrapper that
# segfaults on exit-cleanup". That was wrong. `npm run` is fine on that host (a
# plain node script through the same wrapper exits 0); the SIGSEGV comes from
# the arm64 biome executable itself. Measured here on 2026-09-11 with the
# 2.5.4 build this repo's lockfile installs: `npm run lint` exited 139, and
# `node_modules/@biomejs/cli-win32-arm64/biome.exe` invoked directly, with no
# npm in the picture, exited 139 too.
#
# That is a per-version defect, not a permanent arm64 one: on the same host
# arm64 2.4.16 and 2.5.13 check a tree and report normally. The wrapper routes
# around the arm64 build regardless of version so that a later bump onto a bad
# build cannot turn this gate into a crash mid-release.
#
# There is still nothing downstream to catch what a skip misses: this repo has
# no .github/workflows and GitHub Actions is disabled on it, so the lint step
# in this script is the ONLY lint gate a release passes through.
#
# So: only set SKIP_LINT=1 if scripts/lint.mjs cannot produce a result at all,
# and treat that as a bug to fix rather than a step to routinely skip.
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
# CI mode is dormant: this repo currently has no GitHub workflows at all
# (.github/ holds only CODEOWNERS). The IS_CI branches are kept so a future
# re-added tag workflow can reuse this script unchanged; until then every
# release is a workstation release -- which also means no npm provenance
# attestation (npm only attests from inside a supported CI environment).
#
# "Kept for a future re-added workflow" is not hypothetical -- it already
# happened once, and the history is easy to misread:
#   1f157c0  dropped the non-release workflows
#   1b18b85  dropped release.yml, folding the registry publish into this script
#   3754cf8  RE-ADDED release.yml for the scoop/homebrew binary pipeline
#   14ef069  removed release.yml + dependabot.yml again  <- current state
# An earlier version of this comment cited only 1b18b85, which was accurate
# when written and stale from 3754cf8 onward. Both SHAs are real; cite 14ef069
# for why there is no CI today. `git log --grep` finds only the most recent
# removal and makes the older SHA look bogus -- use
# `git log --diff-filter=D -- .github/workflows` instead.
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
TEST_FLOOR=1600
TEST_LOG=$(mktemp)
npm test 2>&1 | tee "$TEST_LOG" || { rm -f "$TEST_LOG"; fail "Tests failed"; }
TEST_COUNT=$(grep -E '^# tests [0-9]+' "$TEST_LOG" | tail -1 | awk '{print $3}' || true)
rm -f "$TEST_LOG"
if [ -z "$TEST_COUNT" ]; then
  fail "Could not find the TAP '# tests' summary in test output -- runner output format changed?"
fi
# Guard before -lt: a non-numeric field (format drift the empty check above
# didn't catch) would die as a shell arithmetic error with a cryptic message.
case "$TEST_COUNT" in
  ''|*[!0-9]*) fail "TAP '# tests' summary is not a number: '$TEST_COUNT' -- runner output format changed?" ;;
esac
if [ "$TEST_COUNT" -lt "$TEST_FLOOR" ]; then
  fail "Test runner discovered only $TEST_COUNT tests (floor: $TEST_FLOOR) -- test-discovery regression, not a real pass"
fi
info "All tests passed ($TEST_COUNT tests)"

# =============================================================================
# Step 3: Bump version
# =============================================================================
step 3 "Bump version to $VERSION"

# Re-read package.json at this step boundary instead of reusing the pre-flight
# read from before lint/tests: those steps (and anything else that ran in
# between) may have rewritten package.json, and the bump decision must rest on
# what the file says NOW, not on ~8 minutes-old state. Resume semantics are
# unchanged -- equal still means "bumped in a prior run, skip".
CURRENT_VERSION=$(node -p "require('./package.json').version")
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
# Promote the heading BEFORE the bump commit, so the rewrite is committed
# with the version bump rather than left dirty in the working tree.
promote_changelog
assert_changelog_promoted

step 4 "Commit, tag, and push"

if [ "$IS_CI" = "true" ]; then
  info "CI mode — skipping commit/tag/push (already tagged)"
else
  # CHANGELOG.md is in BOTH lists: promote_changelog above (and only above)
  # dirties it, so a changelog-only tree that the guard below did not see would
  # never be committed -- and the next run's clean check at the pre-flight step
  # would then fail on it.
  if [ -n "$(git status --porcelain package.json package-lock.json server.json CHANGELOG.md 2>/dev/null)" ]; then
    git add package.json package-lock.json server.json CHANGELOG.md
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

# True when npm itself serves @yawlabs/tailscale-mcp@${VERSION}: a 200 from the
# per-version document, the exact URL the MCP Registry's validator fetches. NOT
# `npm view`: that reads the whole packument, which registry.npmjs.org serves
# from Cloudflare's edge for up to 300 s (Cache-Control: public, max-age=300;
# measured 2026-09-28 still HIT with no-cache request headers), so right after
# a publish it can keep saying the version is absent. The per-version document
# is served uncached (CF-Cache-Status DYNAMIC). The `_` query is
# belt-and-braces against that changing; npm ignores it. Probe-only: any
# failure reads as "not served". registry.npmjs.org is hardcoded on purpose:
# server.json declares registryType npm with no registryBaseUrl, so public npm
# is what the MCP Registry reads.
npm_version_live() {
  local code
  if command -v curl >/dev/null 2>&1; then
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
      -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
      "https://registry.npmjs.org/@yawlabs%2Ftailscale-mcp/${VERSION}?_=$(date +%s)${RANDOM}" 2>/dev/null || true)
    [ "$code" = "200" ]
  else
    [ "$(npm view "@yawlabs/tailscale-mcp@${VERSION}" version --prefer-online 2>/dev/null || echo "")" = "$VERSION" ]
  fi
}

# =============================================================================
# Step 5: Publish to npm
# =============================================================================
step 5 "Publish to npm"
# Two publish paths, picked by environment. Path 1 is dormant -- there are no
# workflows here (see the CI-mode note above), so every release today is a
# workstation release taking path 2:
#   1. IS_CI=true                    -> WE are CI. Do the publish (NODE_AUTH_TOKEN
#                                       is set; --provenance for sigstore).
#   2. IS_CI=false                   -> Workstation IS the publisher. Try locally
#                                       with EOTP retry for fresh WebAuthn sessions.
if npm_version_live; then PUBLISHED_VERSION="$VERSION"; else PUBLISHED_VERSION=""; fi
if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "v${VERSION} already published on npm — skipping"
elif [ "$IS_CI" = "true" ]; then
  npm publish --access public --provenance
  info "Published @yawlabs/tailscale-mcp@${VERSION} to npm (with provenance)"
else
  # Workstation IS the publisher. Retry only on EOTP/EAUTH/OTP for fresh
  # WebAuthn sessions; take npm's E403 "cannot publish over" as already
  # published; fail fast on everything else.
  ATTEMPT=1
  MAX_ATTEMPTS=3
  NPM_ALREADY_THERE=false
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
    # npm's own word that the version is already there: the E403 "You
    # cannot publish over the previously published versions". Reachable
    # when the skip check above missed a version npm holds -- its read
    # path lagging the write, or this host unable to read it -- which is
    # the state an immediate re-run after a failed later step starts from.
    # Treated as the skip it should have been, not as a token problem.
    if grep -q 'cannot publish over the previously published versions' "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      NPM_ALREADY_THERE=true
      break
    fi
    if ! is_otp_error "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      fail "npm publish failed (non-OTP error -- see output above).

  If the error was E401 or E404, the automation token in ~/.npmrc is dead.
  npm answers an UNAUTHORIZED PUT with 404, not 401, so 'could not be found
  or you do not have permission' here almost always means 'not authorized'
  -- the package is fine. Confirm which it is:

      npm whoami          # E401 => the token is dead

  Fix: mint a NEW automation token (npmjs.com -> Access Tokens -> Generate
  -> Automation), then write these two lines to ~/.npmrc:

      @yawlabs:registry=https://registry.npmjs.org/
      //registry.npmjs.org/:_authToken=npm_YOURTOKEN

  Do NOT run 'npm login --auth-type=web'. It OVERWRITES the automation token
  with a 2FA-bound web session; the next publish then EOTPs on a WebAuthn
  challenge, and any CI sharing that token starts failing too."
    fi
    rm -f "$PUBLISH_LOG"
    if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
      fail "npm publish failed after $MAX_ATTEMPTS OTP-class attempts. WebAuthn session may not be propagating."
    fi
    warn "npm publish attempt $ATTEMPT EOTPed -- waiting 30s for WebAuthn session to propagate"
    ATTEMPT=$((ATTEMPT + 1))
    sleep 30
  done
  if [ "$NPM_ALREADY_THERE" = "true" ]; then
    warn "npm already holds @yawlabs/tailscale-mcp@${VERSION} (its E403 said so) though the pre-publish read did not show it -- treating the publish as done"
  else
    info "Published @yawlabs/tailscale-mcp@${VERSION} to npm (workstation)"
  fi
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
NOTES=$(release_notes "$PREV_TAG")

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  # Release already exists. Nothing creates one on its own here: a bare tag
  # push leaves the tag under /tags with no release attached, and there is no
  # workflow left to build one (14ef069 -- see the CI-mode note above). So this
  # branch is reached two ways:
  #   1. A RESUMED RUN. An earlier invocation got past this step and then died
  #      later -- step 7's npx smoke test or the mcp-publisher login/publish are
  #      the usual spots -- and the operator re-ran the script per the
  #      "each step is idempotent" contract at the top.
  #   2. A HAND-MADE RELEASE. Someone ran `gh release create` or used the web
  #      UI's "Draft a new release" on the pushed tag.
  # Case 1 recomputes the identical body and takes the skip below. Case 2
  # usually carries an empty or hand-written body, which is why this EDITS the
  # notes on rather than skipping outright -- otherwise that release keeps its
  # empty body until someone manually `gh release edit`s it.
  # Idempotent: re-running with the same NOTES produces no diff.
  EXISTING_BODY=$(gh release view "v${VERSION}" --json body --jq '.body' 2>/dev/null || echo "")
  if [ "$EXISTING_BODY" = "$NOTES" ]; then
    info "GitHub release v${VERSION} already has the current notes -- skipping"
  else
    NOTES_FILE=$(mktemp)
    printf '%s
' "$NOTES" > "$NOTES_FILE"
    gh release edit "v${VERSION}" --notes-file "$NOTES_FILE" >/dev/null
    rm -f "$NOTES_FILE"
    info "GitHub release v${VERSION} body updated (release already existed -- resumed run, or created by hand)"
  fi
else
  # --notes-file, not --notes: the body is a whole CHANGELOG section (42kB for
  # v0.21.0), and passing that as a command-line ARGUMENT exceeds the ~32kB
  # CreateProcess limit on Windows -- `gh: Argument list too long`, exit 126.
  # That killed step 6 on the v0.21.0 release and blocked steps 7-8 behind it,
  # after npm had already published. A file has no such limit on any platform.
  NOTES_FILE=$(mktemp)
  printf '%s\n' "$NOTES" > "$NOTES_FILE"
  gh release create "v${VERSION}" \
    --title "v${VERSION}" \
    --notes-file "$NOTES_FILE"
  rm -f "$NOTES_FILE"
  info "GitHub release created (notes from CHANGELOG.md [${VERSION}])"
fi

# --- npm propagation gate (part of step 7, deliberately not a step of its own) ---
#
# `npm publish` returns as soon as the registry ACCEPTS the tarball, but the
# version is not immediately readable from the CDN-backed read path. The MCP
# Registry validates by READING the package, so a registry publish that runs
# straight after `npm publish` can fail with "version 'X' was not found
# (status: 404)". ssh-mcp v0.15.3 failed exactly that way, and aws-mcp did on
# three consecutive releases (2.2.0, 2.2.1, 2.2.2). Each recovered only by
# waiting and re-running, i.e. the release cost two invocations and a human
# in the loop.
#
# Polling here makes one invocation enough (ported from aws-mcp's release.sh).
# Three deliberate choices:
#
#   * npm_version_live (curl), not `npm view`. `npm view` reads the whole
#     packument, which Cloudflare's edge caches for up to 5 min (npm's own view
#     already revalidates; the staleness is the CDN), so a poll through it can
#     keep reporting the pre-publish answer well after the version is live --
#     the loop would then outlast the condition it is waiting on.
#   * The EXACT path the MCP Registry fetches (plus npm_version_live's ignored
#     cache-busting query). Its npm validator requests
#     <base>/url.PathEscape(name)/<version>, and Go's PathEscape turns the scope
#     slash into %2F (`@yawlabs%2Fpkg`, the `@` left bare). A literal-slash URL
#     reaches the same origin but can be a different CDN cache entry, so success
#     there would be a proxy rather than evidence about the path that fails.
#   * WARN, never fail, on timeout. If propagation is genuinely stuck, letting
#     mcp-publisher run produces its own precise error naming the version and
#     status; a timeout message from this loop would replace that with something
#     strictly less informative. This gate can only make the release faster,
#     never worse than it was before it existed.
# Derived once, before the wait branches below: the npx smoke test further down
# also needs the package name, and it runs even when SKIP_NPM_WAIT=1 skips the
# branch that used to be the only place this was read.
PKG_NAME=$(node -p "require('./package.json').name")
if [ "${SKIP_NPM_WAIT:-}" = "1" ]; then
  warn "SKIP_NPM_WAIT=1 -- not waiting for npm to serve v${VERSION}"
elif ! command -v curl >/dev/null 2>&1; then
  warn "curl not found -- skipping the npm propagation wait; step 7 may 404 on a fresh publish"
else
  # 600 s: the @yawlabs/fetch-mcp 0.8.2 release (2026-09-29) spent 295 s of
  # the 300 s this used to be waiting for npm to serve its new version.
  NPM_WAIT_TIMEOUT_S=${NPM_WAIT_TIMEOUT_S:-600}
  NPM_WAITED_S=0
  # 5s: this is a remote read on a minutes-scale wait, so a tighter spin buys
  # nothing. (Under MSYS every `sleep` forks a process -- ~0.1s each -- which is
  # noise at this interval but the reason not to poll sub-second.)
  while [ "$NPM_WAITED_S" -lt "$NPM_WAIT_TIMEOUT_S" ]; do
    if npm_version_live; then
      break
    fi
    sleep 5
    NPM_WAITED_S=$((NPM_WAITED_S + 5))
  done
  if [ "$NPM_WAITED_S" -ge "$NPM_WAIT_TIMEOUT_S" ]; then
    warn "npm still does not serve ${PKG_NAME}@${VERSION} after ${NPM_WAIT_TIMEOUT_S}s -- continuing anyway so the registry step can report the precise error"
  elif [ "$NPM_WAITED_S" -gt 0 ]; then
    info "npm is serving v${VERSION} (waited ${NPM_WAITED_S}s for propagation)"
  else
    info "npm is already serving v${VERSION}"
  fi
fi

# =============================================================================
# Step 7: Publish to the Official MCP Registry
# =============================================================================
# Downstream catalogs (Glama, PulseMCP, mcpservers.org) auto-source from the
# Official MCP Registry; publishing here is what makes the new version visible
# to them. server.json was already bumped in step 3 so the version matches the
# tag.
# mcp_bounded <command...>: run one mcp-publisher call -- a login or a publish
# -- with a time limit, so a registry that never answers cannot hang the
# release. mcp-publisher sends with a bare Go http.Client: Go's default
# transport gives up on a dial after 30 s and on a TLS handshake after 10 s,
# but waits for the answer with no limit at all. The limit here is
# MCP_PUBLISH_TIMEOUT_S seconds (default 90; 0 turns it off), then TERM, then
# KILL MCP_PUBLISH_KILL_AFTER_S seconds later (default 10; at least 1, since
# timeout(1) reads 0 as never), through coreutils timeout(1). --foreground
# keeps mcp-publisher in the terminal's process group, so Ctrl-C still reaches
# it. Git Bash and most glibc distributions ship GNU timeout, Ubuntu 26.04 LTS
# ships uutils' compatible one (its banner also says coreutils), and macOS
# gets it as gtimeout from Homebrew coreutils. BusyBox (Alpine) and Windows'
# own timeout.exe are different programs, which is why the version banner is
# checked. Without a coreutils timeout the call runs unbounded, and a warning
# says so. A call the limit stopped exits 124 -- or 137 when the KILL was
# needed, on newer coreutils such as GNU 9.4 (Git Bash's 8.32 exits 124 even
# then) -- prints a line on stderr saying so, and sets MCP_BOUNDED_STOPPED.
mcp_timeout_setup() {
  MCP_TIMEOUT_READY=1
  MCP_PUBLISH_TIMEOUT_S="${MCP_PUBLISH_TIMEOUT_S:-90}"
  case "$MCP_PUBLISH_TIMEOUT_S" in
    '' | *[!0-9]*)
      warn "MCP_PUBLISH_TIMEOUT_S='${MCP_PUBLISH_TIMEOUT_S}' is not whole seconds -- using 90" >&2
      MCP_PUBLISH_TIMEOUT_S=90
      ;;
  esac
  local kill_after="${MCP_PUBLISH_KILL_AFTER_S:-10}"
  case "$kill_after" in
    '' | *[!0-9]*) kill_after=0 ;;
  esac
  if [ "$kill_after" -eq 0 ]; then
    warn "MCP_PUBLISH_KILL_AFTER_S='${MCP_PUBLISH_KILL_AFTER_S}' is not whole seconds above 0 -- using 10" >&2
    kill_after=10
  fi
  MCP_PUBLISH_KILL_AFTER_S="$kill_after"
  MCP_TIMEOUT_BIN=""
  local t
  for t in timeout gtimeout; do
    command -v "$t" >/dev/null 2>&1 || continue
    case "$("$t" --version 2>/dev/null || true)" in
      *coreutils*)
        MCP_TIMEOUT_BIN="$t"
        break
        ;;
    esac
  done
  if [ -z "$MCP_TIMEOUT_BIN" ]; then
    warn "Neither timeout nor gtimeout on PATH is the coreutils one -- a registry that never answers would hang the MCP Registry step" >&2
  fi
}
mcp_bounded() {
  [ -n "${MCP_TIMEOUT_READY:-}" ] || mcp_timeout_setup
  MCP_BOUNDED_STOPPED=""
  if [ -z "$MCP_TIMEOUT_BIN" ]; then
    "$@"
    return
  fi
  local rc=0
  "$MCP_TIMEOUT_BIN" --foreground -k "$MCP_PUBLISH_KILL_AFTER_S" "$MCP_PUBLISH_TIMEOUT_S" "$@" || rc=$?
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    MCP_BOUNDED_STOPPED=1
    echo "mcp-publisher did not answer within ${MCP_PUBLISH_TIMEOUT_S}s -- stopped it" >&2
  fi
  return "$rc"
}
# mcp_login_fail <message>: fail on a login that did not go through, with
# <message> -- unless the time limit stopped it. That is the registry not
# answering, not a bad credential, and the failure says so instead.
mcp_login_fail() {
  if [ -n "${MCP_BOUNDED_STOPPED:-}" ]; then
    fail "The MCP Registry did not answer the mcp-publisher login within ${MCP_PUBLISH_TIMEOUT_S}s -- npm + GitHub release succeeded, but the MCP Registry step did not. Retry the step (re-run the script) once the registry answers."
  fi
  fail "$1"
}
# The first mcp_bounded call sets the limit up; a value inherited from the
# environment must not stand in for that.
MCP_TIMEOUT_READY=""

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
    # outlast realistic propagation: 60 attempts 10s apart, so 10min of sleeps
    # plus each npx run. Typical case completes in < 30s.
    ATTEMPTS=60
    SLEEP_SECONDS=10
    SMOKE_OUTPUT=""
    STARTED_AT=$(date +%s)
    for i in $(seq 1 $ATTEMPTS); do
      # PKG_NAME (derived from package.json above, not hardcoded) so renaming
      # the package doesn't leave this smoke test probing the old name.
      if SMOKE_OUTPUT=$(npx -y "${PKG_NAME}@${VERSION}" --version 2>/dev/null); then
        echo "  npx output: $SMOKE_OUTPUT (after $(( $(date +%s) - STARTED_AT ))s)"
        break
      fi
      echo "  Waiting for ${PKG_NAME}@${VERSION} to be installable via npx (attempt $i/$ATTEMPTS, ${SLEEP_SECONDS}s)..."
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

  # This is the only auth path -- there is no OIDC branch here (the workflow
  # that used one went away with 14ef069). Log in with a GitHub PAT via
  # `login github -token <PAT>`. At login the registry reads the org roles
  # this token can see, and grants io.github.YawLabs/* only to a YawLabs org
  # Owner (read:org lets it read them; so do repo, user, write:org and
  # admin:org). It enforces the grant only at publish: a token that cannot
  # read the roles still logs in, and the publish gets a 403.
  # Fall back to gh CLI's session token if MCP_REGISTRY_TOKEN is unset --
  # gh auth login (admin:org or read:org scope) covers the namespace claim.
  # Record where the token came from BEFORE the fallback fills it in: an
  # operator-exported PAT is static and must win on every retry below (the
  # same env-first rule this first capture applies), while only a gh-derived
  # token is worth re-reading once it may have gone stale.
  if [ -n "${MCP_REGISTRY_TOKEN:-}" ]; then MCP_REGISTRY_TOKEN_FROM_ENV=true; else MCP_REGISTRY_TOKEN_FROM_ENV=false; fi
  : "${MCP_REGISTRY_TOKEN:=$(gh auth token 2>/dev/null || true)}"
  if [ -z "${MCP_REGISTRY_TOKEN:-}" ]; then
    fail "MCP_REGISTRY_TOKEN unset -- set it to a GitHub PAT with read:org for YawLabs (or run '$MP login github' once interactively to cache the session)."
  fi
  mcp_bounded "$MP" login github -token "$MCP_REGISTRY_TOKEN" >/dev/null \
    || mcp_login_fail "mcp-publisher login failed -- its output is above. A 401 there is the registry refusing the token exchange: most often MCP_REGISTRY_TOKEN, or the gh CLI token it fell back to, is invalid or expired, though the registry answers 401 when GitHub's own API fails too. A 429, a 5xx or a connection error is the registry or the network. npm + GitHub release succeeded: retry the step (re-run the script) once the cause is fixed."
  # Up to four attempts, 30 s, 60 s, then 90 s apart, and ONLY for the
  # shape waiting cures. The npm gate above reads npm from THIS machine's
  # CDN edge, so it can go green while the MCP Registry's own read still
  # lags (ctxlint v0.27.0 needed the 3rd of 3 retries, ~150 s after the
  # publish). The live registry (v1.8.1; wording from registry PR #1411)
  # answers that lag with "exists, but version '<v>' was not found
  # (status: 404)", and a bad moment on npm's side with "... Likely
  # transient, retry later" (429, 5xx, an inconclusive 404) or "failed to
  # fetch package metadata from NPM" (no status at all). Every other
  # failure -- bad server.json, namespace not owned, auth -- fails the same
  # after any wait, so it stops on the first attempt,
  # the retried cases here and below aside. A duplicate version means an
  # earlier run, or an earlier attempt of this run, already registered it:
  # the state this step wants.
  # The registry's OWN transient answers are retried on the same clock too:
  # HTTP 429, 502, 503 or 504 on the publish call. Cutting @yawlabs/mcp 1.0.17
  # (2026-09-29) met a 504 from the registry's nginx gateway while its search
  # requests were timing out -- the registry was slow, not saying no. A retry
  # is safe even when the timed-out attempt landed: it then meets the
  # duplicate-version branch below.
  # An attempt that gets no answer at all is retried on the same clock:
  # mcp_bounded (above) stops one the registry never answers, and the client
  # reports a connection that drops before or while answering as "error
  # sending request" or "error reading response". The request may have landed
  # then, so a duplicate on the retry means it did. A connection the client
  # reports as never opened -- a dial, DNS, proxy or certificate error, a TLS
  # handshake that timed out, a proxy that refused the tunnel -- is retried as
  # well, but cannot have landed, and neither can an attempt the registry
  # refused with a 429. A handshake the far end cut off reads like any other
  # drop (EOF, a reset), and is treated as one.
  MCP_PUBLISH_LOG=$(mktemp)
  MCP_DONE=false
  MCP_ATTEMPT=1
  MCP_MAX_ATTEMPTS=4
  MCP_GATEWAY_RETRIED=false
  # Already set up by the first login above; repeated here as a no-op so the
  # checks after the pipeline never depend on that login having run: the
  # attempt below runs in a pipeline's subshell, which cannot set it for them.
  [ -n "${MCP_TIMEOUT_READY:-}" ] || mcp_timeout_setup
  while true; do
    # `|| MCP_PUBLISH_RC=$?` rather than `if`: the exit code is what tells an
    # attempt the limit stopped (124, or 137 where the KILL was needed) from
    # the rest, and under pipefail it is the publisher's, not tee's.
    MCP_PUBLISH_RC=0
    mcp_bounded "$MP" publish 2>&1 | tee "$MCP_PUBLISH_LOG" || MCP_PUBLISH_RC=$?
    if [ "$MCP_PUBLISH_RC" -eq 0 ]; then
      MCP_DONE=true
      break
    fi
    if grep -qiE 'duplicate version|already exists' "$MCP_PUBLISH_LOG"; then
      if [ "$MCP_GATEWAY_RETRIED" = "true" ]; then
        info "MCP Registry refused the retry of ${VERSION} as a duplicate: an attempt of this run that got no clear answer landed"
      else
        info "MCP Registry already has ${VERSION} -- nothing to publish"
      fi
      MCP_DONE=true
      break
    fi
    # The registry's own 429/502/503/504 on the publish call, if that is what
    # this attempt got: empty otherwise. `|| true` because no match is the
    # normal case, and the failing grep would then make the assignment fail,
    # which `set -e` turns into the end of the script.
    MCP_GATEWAY_STATUS=$(grep -oE 'server returned status (429|502|503|504)([^0-9]|$)' "$MCP_PUBLISH_LOG" | head -n 1 | grep -oE '[0-9]{3}' || true)
    # No answer at all, if that is what this attempt got: empty otherwise. A
    # proxy that refuses the tunnel leaves only the rest of its status line
    # right after the quoted URL: a reason phrase that starts with a capital
    # (Go's own errors there start lower case, or are EOF), nothing at all, or
    # "unknown status code" when the line stops at the code. Matching it right
    # after the URL keeps bytes a server echoes back inside Go's own quoted
    # error text from passing for one. A refusal of any other shape reads as a
    # drop, which changes only how a later duplicate is reported.
    MCP_NO_ANSWER=""
    MCP_MAY_HAVE_LANDED=false
    if [ -n "${MCP_TIMEOUT_BIN:-}" ] && { [ "$MCP_PUBLISH_RC" -eq 124 ] || [ "$MCP_PUBLISH_RC" -eq 137 ]; }; then
      MCP_NO_ANSWER="did not answer within ${MCP_PUBLISH_TIMEOUT_S}s"
      MCP_MAY_HAVE_LANDED=true
    elif grep -q 'error sending request' "$MCP_PUBLISH_LOG" \
      && grep -qE 'dial tcp|proxyconnect|tls:|x509:|TLS handshake timeout|error sending request: [A-Z][a-z]+ "[^"]*": ( *|unknown status code|[A-Z]([a-z]|[A-Z]+[ a-z(-]).*)$' "$MCP_PUBLISH_LOG"; then
      MCP_NO_ANSWER="could not be reached"
    elif grep -qE 'error sending request|error reading response' "$MCP_PUBLISH_LOG"; then
      MCP_NO_ANSWER="dropped the connection without an answer"
      MCP_MAY_HAVE_LANDED=true
    fi
    # The not-found shape counts only when the validator's own "version '<v>'"
    # names this version. A bare version match is not enough: the registry's
    # publisher after v1.8.1 (registry main) prints "Publishing <name>@<v> to"
    # before any error, and this script downloads the latest release, so a
    # missing-package 404 would then buy all the waits.
    if ! { { grep -qE 'not found \(status: *[0-9]+\)' "$MCP_PUBLISH_LOG" && grep -qF "version '${VERSION}'" "$MCP_PUBLISH_LOG"; } \
        || grep -qE 'Likely transient, retry later|failed to fetch package metadata from NPM' "$MCP_PUBLISH_LOG" \
        || [ -n "$MCP_GATEWAY_STATUS" ] \
        || [ -n "$MCP_NO_ANSWER" ]; }; then
      break
    fi
    if [ "$MCP_ATTEMPT" -ge "$MCP_MAX_ATTEMPTS" ]; then break; fi
    MCP_WAIT=$((MCP_ATTEMPT * 30))
    if [ -n "$MCP_GATEWAY_STATUS" ]; then
      # A 502-504 can come after the attempt landed; a 429 refused it.
      if [ "$MCP_GATEWAY_STATUS" != 429 ]; then MCP_GATEWAY_RETRIED=true; fi
      warn "MCP Registry answered HTTP ${MCP_GATEWAY_STATUS} itself -- busy or timing out, not a verdict -- waiting ${MCP_WAIT}s, then attempt $((MCP_ATTEMPT + 1)) of ${MCP_MAX_ATTEMPTS}"
    elif [ -n "$MCP_NO_ANSWER" ]; then
      if [ "$MCP_MAY_HAVE_LANDED" = true ]; then MCP_GATEWAY_RETRIED=true; fi
      warn "MCP Registry ${MCP_NO_ANSWER} -- waiting ${MCP_WAIT}s, then attempt $((MCP_ATTEMPT + 1)) of ${MCP_MAX_ATTEMPTS}"
    else
      warn "MCP Registry cannot see @yawlabs/tailscale-mcp@${VERSION} on npm yet -- waiting ${MCP_WAIT}s, then attempt $((MCP_ATTEMPT + 1)) of ${MCP_MAX_ATTEMPTS}"
    fi
    sleep "$MCP_WAIT"
    # A fresh registry token before every retry: tokens last 5 minutes, and an
    # attempt that meets a timing-out gateway spends the gateway's own timeout
    # before its 504 arrives, so the waits plus four slow attempts can outlast
    # the token the login above issued -- and an expired token is a 401 that
    # fails the step. Re-derive it here rather than reusing the capture from
    # the top of this step: by now even a token fetched there is minutes old,
    # so logging in again with it would refresh nothing. An operator-supplied
    # PAT (the env-var path recorded above) is static and keeps winning; only
    # the gh-derived one is re-read.
    if [ "$MCP_REGISTRY_TOKEN_FROM_ENV" != "true" ]; then
      MCP_REGISTRY_TOKEN=$(gh auth token 2>/dev/null || true)
      if [ -z "$MCP_REGISTRY_TOKEN" ]; then
        warn "could not re-derive a registry token from 'gh auth token' -- retrying with the token from the top of this step"
      fi
    fi
    mcp_bounded "$MP" login github -token "${MCP_REGISTRY_TOKEN:-}" >/dev/null \
      || warn "mcp-publisher login refresh failed -- the next attempt may be refused as unauthorized"
    MCP_ATTEMPT=$((MCP_ATTEMPT + 1))
  done
  # The registry decides the namespace grant at login, from the org roles the
  # token can read, but enforces it only at publish: a token that cannot read
  # YawLabs org roles, or whose owner is not a YawLabs org Owner, logs in fine
  # and is refused here with a 403.
  MCP_REFUSED_NAMESPACE=false
  if grep -q 'server returned status 403' "$MCP_PUBLISH_LOG"; then MCP_REFUSED_NAMESPACE=true; fi
  rm -f "$MCP_PUBLISH_LOG"
  if [ "$MCP_DONE" = "true" ]; then
    info "Published to MCP Registry"
  else
    if [ "$MCP_REFUSED_NAMESPACE" = true ]; then
      warn "A 403 on publish is the registry refusing the io.github.YawLabs namespace. It grants that namespace only to a YawLabs org Owner whose token can read org roles: a classic PAT with the repo, user, read:org, write:org or admin:org scope, or a fine-grained PAT with read access to the organization's Members. The membership does not have to be public, whatever the registry's own message says."
    fi
    fail "mcp-publisher publish failed -- npm + GitHub release succeeded, but the MCP Registry did not. Retry the step (re-run the script) once the cause is identified."
  fi
fi

# =============================================================================
# Step 8: Verify
# =============================================================================
step 8 "Verify"

# Poll up to 120 times 5s apart (about 600s of sleeps, plus each read) rather
# than read once after 3s: the @yawlabs/fetch-mcp 0.8.2 release (2026-09-29)
# spent 295 s of its 300 s gate waiting for npm to serve its new version, and
# the npm gate before the MCP Registry step only warns when it runs out.
NPM_VERSION=""
for i in $(seq 1 120); do
  if npm_version_live; then NPM_VERSION="$VERSION"; break; fi
  if [ "$i" -lt 120 ]; then sleep 5; fi
done
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

# Provenance attestation check -- npm attaches sigstore attestations only when
# `npm publish --provenance` runs inside a supported CI environment. That path
# is dormant here (no workflows since 14ef069), so this block never runs today
# and every shipped version is unattested by design; it is kept in step with
# the IS_CI branches so a future re-added tag workflow gets the check for free.
# Workstation releases publish without --provenance, so a missing attestation
# there is expected, not a regression.
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
