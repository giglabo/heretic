#!/usr/bin/env bash
# Prepare (and optionally push) a heretic-cli release.
#
#   scripts/release.sh 0.2.0           # checks, bump cli/package.json, commit, tag v0.2.0
#   scripts/release.sh 0.2.0 --push    # ... and push the branch + tag → Release workflow
#
# What the tag triggers (.github/workflows/release.yml):
#   verify          tag == cli/package.json version
#   build-binaries  heretic-cli-{linux-x64,linux-arm64,macos-x64,macos-arm64,windows.exe}
#   exec-server     exec-server-{linux,darwin}-{amd64,arm64}
#   publish-release GitHub release with all binaries + SHA256SUMS
#   publish-npm     @giglabo/heretic-cli (needs the NPM_TOKEN secret)
# Users then get it with `heretic-cli update` (asset names must not change).
#
# Env: REMOTE (default origin). The push uses plain `git push`; with an https
# remote and the GitHub CLI, `gh auth setup-git` makes it use your gh login.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${REMOTE:-origin}"
VERSION="${1:-}"
PUSH="${2:-}"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] \
    || { echo "usage: scripts/release.sh <semver> [--push]" >&2; exit 2; }
TAG="v$VERSION"
cd "$ROOT"

[[ -z "$(git status --porcelain --untracked-files=no)" ]] \
    || { echo "working tree has uncommitted changes — commit or stash them first" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "tag $TAG already exists" >&2; exit 1; }

current=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' cli/package.json)
echo "release $current → $VERSION on $(git rev-parse --abbrev-ref HEAD)"

"$ROOT/scripts/test.sh"
"$ROOT/scripts/build.sh" all

if [[ "$current" != "$VERSION" ]]; then
    tmp=$(mktemp)
    sed "s/^  \"version\": \".*\",\$/  \"version\": \"$VERSION\",/" cli/package.json > "$tmp"
    cat "$tmp" > cli/package.json && rm -f "$tmp"
    git add cli/package.json
    git commit -m "Release $TAG"
fi
git tag -a "$TAG" -m "heretic-cli $TAG"
echo "tagged $TAG"

if [[ "$PUSH" == "--push" ]]; then
    git push "$REMOTE" HEAD "$TAG"
    echo "pushed — follow the run with: gh run watch \$(gh run list -w Release -L1 --json databaseId -q '.[0].databaseId')"
else
    echo "not pushed. To publish: git push $REMOTE HEAD $TAG"
fi
