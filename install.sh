#!/bin/bash
# Installs the newest Tacho for GNOME from its GitHub releases:
#
#   curl -fsSL https://raw.githubusercontent.com/hieupnvmg/tacho-gnome/main/install.sh | bash
#
# Pre-releases are included; pass --stable to skip them. Once installed,
# Tacho updates itself from the same releases (see its menu and settings).
set -euo pipefail

REPO="hieupnvmg/tacho-gnome"
UUID="tacho@hieupnvmg.github.io"
ASSET="${UUID}.shell-extension.zip"
STABLE=0
[ "${1:-}" = "--stable" ] && STABLE=1

for tool in curl python3 gnome-extensions; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "Needs $tool." >&2
        [ "$tool" = gnome-extensions ] && echo "Is this a GNOME desktop (Ubuntu 23.10 or later)?" >&2
        exit 1
    fi
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${REPO}/releases?per_page=20" -o "$work/releases.json"

read -r tag zip_url sha_url < <(python3 - "$work/releases.json" "$ASSET" "$STABLE" <<'PY'
import json, sys
releases = json.load(open(sys.argv[1]))
asset, stable = sys.argv[2], sys.argv[3] == "1"
def key(r):
    try:
        return [int(x) for x in r["tag_name"].lstrip("v").split(".")]
    except ValueError:
        return []
for r in sorted(releases, key=key, reverse=True):
    if r.get("draft") or (stable and r.get("prerelease")):
        continue
    files = {a["name"]: a["browser_download_url"] for a in r.get("assets", [])}
    if asset in files:
        print(r["tag_name"], files[asset], files.get(asset + ".sha256", "-"))
        break
PY
)

if [ -z "${tag:-}" ]; then
    echo "No release with ${ASSET} found." >&2
    exit 1
fi

echo "==> Downloading Tacho for GNOME ${tag}"
curl -fsSL "$zip_url" -o "$work/$ASSET"
if [ "$sha_url" != "-" ]; then
    curl -fsSL "$sha_url" -o "$work/$ASSET.sha256"
    (cd "$work" && sha256sum -c "$ASSET.sha256" >/dev/null) || { echo "Checksum mismatch." >&2; exit 1; }
fi

gnome-extensions install --force "$work/$ASSET"
echo "==> Installed ${tag}."
if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    gnome-extensions enable "$UUID" && echo "==> Enabled."
else
    # GNOME Shell on Wayland only sees new extensions at login. Put it in
    # the enabled list now, so it starts at the next login by itself.
    current=$(gsettings get org.gnome.shell enabled-extensions)
    case "$current" in
        *"'${UUID}'"*) ;;
        "@as []"|"[]") gsettings set org.gnome.shell enabled-extensions "['${UUID}']" ;;
        *) gsettings set org.gnome.shell enabled-extensions "${current%]}, '${UUID}']" ;;
    esac
    echo "==> Enabled for your next login. Log out and back in to see Tacho in the top bar."
fi
