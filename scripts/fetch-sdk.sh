#!/bin/sh
# Fetch the pinned OpenWrt SDK for cross-building the Tessel 2 runtime.
#
# The SDK url and sha256 live in runtime/deps/MANIFEST.toml (the openwrt-sdk
# entry). This download is the ONLY permitted network access in the release
# build path besides `git submodule update` — see runtime/DEPENDENCIES.md.
#
# Usage: scripts/fetch-sdk.sh [dest-dir]   (default: build/sdk)

set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$REPO/runtime/deps/MANIFEST.toml"
DEST="${1:-$REPO/build/sdk}"

read_sdk_field() {
    python3 - "$MANIFEST" "$1" <<'EOF'
import sys, tomllib
with open(sys.argv[1], "rb") as f:
    data = tomllib.load(f)
for d in data.get("dependency", []):
    if d.get("name") == "openwrt-sdk":
        print(d.get(sys.argv[2], ""))
        break
EOF
}

URL="$(read_sdk_field url)"
SHA256="$(read_sdk_field sha256)"
STATUS="$(read_sdk_field status)"

if [ "$STATUS" = "pending" ] || [ -z "$URL" ] || [ -z "$SHA256" ]; then
    echo "fetch-sdk: the openwrt-sdk manifest entry is not pinned yet (status:" \
         "${STATUS:-unset})." >&2
    echo "Phase 0 of the runtime plan selects the SDK; pin url + sha256 in" \
         "runtime/deps/MANIFEST.toml and set status = \"active\"." >&2
    exit 1
fi

TARBALL="$DEST/$(basename "$URL")"
STAMP="$DEST/.verified-$SHA256"

if [ -f "$STAMP" ]; then
    echo "fetch-sdk: SDK already present and verified: $TARBALL"
    exit 0
fi

mkdir -p "$DEST"
echo "fetch-sdk: downloading $URL"
curl -fL --retry 3 -o "$TARBALL" "$URL"

echo "$SHA256  $TARBALL" | shasum -a 256 -c - || {
    echo "fetch-sdk: sha256 MISMATCH — refusing to use this tarball." >&2
    rm -f "$TARBALL"
    exit 1
}

tar -xf "$TARBALL" -C "$DEST"
touch "$STAMP"
echo "fetch-sdk: verified and unpacked into $DEST"
