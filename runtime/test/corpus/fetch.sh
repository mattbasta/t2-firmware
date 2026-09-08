#!/bin/sh
#
# Fetch the era-package corpus into build/corpus/node_modules/.
#
# Test-time only, never build-time: the release path fetches nothing but git
# submodules and the SDK tarball (runtime/DEPENDENCIES.md, prime directive).
# The install tree is gitignored; every tarball is pinned and sha256-verified,
# so a corpus run is reproducible even though it is not hermetic.
#
# Usage: runtime/test/corpus/fetch.sh [install-dir]
#
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
# Installs beside this script so bare specifiers resolve through the real
# node_modules walk from runtime/test/corpus/index.js. Gitignored.
DEST=${1:-$HERE}
MODULES="$DEST/node_modules"

mkdir -p "$MODULES"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

count=0

while read -r name version want; do
    case "$name" in ''|\#*) continue ;; esac

    target="$MODULES/$name"

    if [ -f "$target/package.json" ]; then
        count=$((count + 1))
        continue
    fi

    tgz="$DEST/$name-$version.tgz"

    curl -fsSL "https://registry.npmjs.org/$name/-/$name-$version.tgz" -o "$tgz"

    got=$(sha256_of "$tgz")

    if [ "$got" != "$want" ]; then
        echo "corpus: sha256 mismatch for $name@$version" >&2
        echo "  expected $want" >&2
        echo "  got      $got" >&2
        rm -f "$tgz"
        exit 1
    fi

    mkdir -p "$target"
    tar xzf "$tgz" -C "$target" --strip-components=1
    rm -f "$tgz"
    count=$((count + 1))
done < "$HERE/packages.txt"

echo "corpus: $count packages in $MODULES"
