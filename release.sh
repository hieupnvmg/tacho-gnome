#!/bin/bash
# Publish a new version of Tacho for GNOME.
#
#   ./release.sh 1.1.0 "What changed"          a normal release
#   ./release.sh 1.1.0 "What changed" --pre    a pre-release
#
# Sets version-name in metadata.json, builds both zips (make), commits,
# tags v<version>, pushes, and creates the GitHub release with the GitHub
# build and its .sha256 attached. Copies installed from GitHub releases
# find it within 6 hours and offer it in their menu.
#
# The extensions.gnome.org build is left in build/ego/ for uploading by hand
# at https://extensions.gnome.org/upload/ (needs your account there).
set -euo pipefail

cd "$(dirname "$0")"

VERSION="${1:?usage: ./release.sh <version> [notes] [--pre]}"
NOTES="${2:-}"
PRE="${3:-}"
TAG="v${VERSION}"
REPO="hieupnvmg/tacho-gnome"
UUID="tacho@hieupnvmg.github.io"
ZIP="build/github/${UUID}.shell-extension.zip"

if [[ ! "$VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
    echo "Version must look like 1.2.0" >&2
    exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
    echo "Commit or stash your changes first." >&2
    exit 1
fi
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
    echo "Tag ${TAG} already exists." >&2
    exit 1
fi

python3 - "$VERSION" <<'PY'
import json, sys
path = "metadata.json"
meta = json.load(open(path))
meta["version-name"] = sys.argv[1]
with open(path, "w") as f:
    json.dump(meta, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

make clean >/dev/null
make test
make

if ! git diff --quiet -- metadata.json; then
    git add metadata.json
    git commit -m "Release ${TAG}"
fi
git tag -a "$TAG" -m "Tacho for GNOME ${VERSION}"
git push origin HEAD "$TAG"

flags=()
[ "$PRE" = "--pre" ] && flags+=(--prerelease)
gh release create "$TAG" --repo "$REPO" --title "Tacho for GNOME ${VERSION}" \
    --notes "$NOTES" ${flags[@]+"${flags[@]}"} "$ZIP" "${ZIP}.sha256"
echo "==> Released ${TAG}"
echo "==> For extensions.gnome.org, upload build/ego/${UUID}.shell-extension.zip"
