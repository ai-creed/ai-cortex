#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
	echo "Usage: pnpm run release <version>"
	echo "Example: pnpm run release 0.1.0-beta.2"
	exit 1
fi

TAG="v$VERSION"

# Must be on master
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "master" ]]; then
	echo "Error: must be on master branch (currently on '$BRANCH')"
	exit 1
fi

# Working tree must be clean
if [[ -n $(git status --porcelain) ]]; then
	echo "Error: working tree is not clean"
	git status --short
	exit 1
fi

# Tag must not already exist
if git rev-parse "$TAG" >/dev/null 2>&1; then
	echo "Error: tag $TAG already exists"
	exit 1
fi

# ─── Resolve the release headline FIRST (before any file mutation) ────────
# A failed read under `set -e` after we've mutated package.json would leave
# the tree dirty. We resolve NEW_HEADLINE up front so any failure exits
# clean. See docs/superpowers/specs/2026-05-20-update-notification-aggression-design.md §5.
PREV_HEADLINE=$(pnpm exec tsx scripts/lib/release-headline.ts read package.json)
PREV_DISPLAY="$PREV_HEADLINE"
if [[ -z "$PREV_DISPLAY" || "$PREV_DISPLAY" == "-" ]]; then
	PREV_DISPLAY="(none)"
fi

if [[ -n "${AI_CORTEX_RELEASE_HEADLINE-}" ]]; then
	# Non-interactive escape hatch (CI / unattended). Pass "-" to clear.
	INPUT="$AI_CORTEX_RELEASE_HEADLINE"
elif [[ -t 0 ]]; then
	echo "Previous release headline: $PREV_DISPLAY"
	echo "Enter new headline (<= 60 chars). Bare Enter = reuse. '-' = clear:"
	read -r INPUT
else
	echo "Error: release.sh needs an interactive TTY for the headline prompt." >&2
	echo "Set AI_CORTEX_RELEASE_HEADLINE='<value>' (use '-' to clear) for non-interactive use." >&2
	exit 1
fi

if [[ -z "$INPUT" ]]; then
	NEW_HEADLINE="$PREV_HEADLINE"
elif [[ "$INPUT" == "-" ]]; then
	NEW_HEADLINE=""
else
	NEW_HEADLINE="$INPUT"
fi

# ─── Release gate ────────────────────────────────────────────────────────
# Tagging must be impossible unless the full verification suite passes.
# CI=true is required, not optional: env-var-gated paths (e.g. update-notifier
# shouldCheck) diverge under CI, which is how v0.10.1 shipped broken.
# `pnpm format` is intentionally absent: 213 files have pre-existing drift;
# add it back once the tree is reformatted.
echo "Running release gate..."
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:web
pnpm lint
pnpm build
CI=true pnpm test

# ─── Now safe to mutate ──────────────────────────────────────────────────
echo "Releasing $TAG..."

# Bump version in package.json (no commit or tag — we do that ourselves)
npm version "$VERSION" --no-git-tag-version

# Keep src/version.ts in lockstep with package.json — there's a CI test
# (tests/unit/mcp/server.test.ts SERVER_VERSION) that asserts the two match.
# Forgetting this drift was the cause of the v0.5.0 ship-then-fix cycle.
sed -i.bak "s|export const VERSION = \".*\";|export const VERSION = \"$VERSION\";|" src/version.ts
rm -f src/version.ts.bak

# Rebuild dist so it embeds the bumped VERSION. cli.test.ts spawns dist and
# only rebuilds when the file is missing, so leaving a stale dist here makes
# the next local test run fail its --version assertions.
pnpm build

# Persist the resolved headline (npm version already bumped package.json above;
# this read-modify-write preserves the version bump and adds aiCortex.releaseHeadline).
pnpm exec tsx scripts/lib/release-headline.ts write package.json "$NEW_HEADLINE"

git add package.json src/version.ts
git commit -m "chore: bump to $TAG"
git tag "$TAG"
git push && git push origin "$TAG"

echo "Done. $TAG pushed."
