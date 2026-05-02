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

echo "Releasing $TAG..."

# Bump version in package.json (no commit or tag — we do that ourselves)
npm version "$VERSION" --no-git-tag-version

# Keep src/version.ts in lockstep with package.json — there's a CI test
# (tests/unit/mcp/server.test.ts SERVER_VERSION) that asserts the two match.
# Forgetting this drift was the cause of the v0.5.0 ship-then-fix cycle.
sed -i.bak "s|export const VERSION = \".*\";|export const VERSION = \"$VERSION\";|" src/version.ts
rm -f src/version.ts.bak

git add package.json src/version.ts
git commit -m "chore: bump to $TAG"
git tag "$TAG"
git push && git push origin "$TAG"

echo "Done. $TAG pushed."
