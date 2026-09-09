#!/bin/sh
#
# Fetch Node's own test suite, pinned and sha256-verified.
#
# Test-time only, like runtime/test/corpus — the release path fetches nothing
# but git submodules and the SDK tarball (runtime/DEPENDENCIES.md). The extracted
# tree is gitignored: these are thousands of third-party files and vendoring them
# would swamp the repo, so they are pinned rather than committed.
#
# The version matters, and it is not the one this project harvests source from.
# fs and net here were written against Node 26's behavior — the differential
# suites in runtime/test/ are checked against exactly this release — so its
# tests are the oracle that matches. Running an older Node's tests produced a
# steady trickle of failures where we were right and the test was simply older
# (fs.rmdir's `recursive` option, removed in Node 16, was the clearest case),
# which points attention in the wrong direction.
#
# Keep this pinned to the same version used for differential runs.
#
# Usage: runtime/test/node-suite/fetch.sh [dest-dir]
#
set -eu

NODE_VERSION=v26.5.0
NODE_SHA256=b3db373d860129807d8e504eaad184f1f5cb0e970b7467c80595f7a4653cf977

HERE=$(cd "$(dirname "$0")" && pwd)
DEST=${1:-$HERE/node}

if [ -f "$DEST/.fetched" ]; then
    echo "node-suite: already present in $DEST"
    exit 0
fi

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

tgz="$tmp/node-$NODE_VERSION.tar.gz"

echo "node-suite: fetching Node $NODE_VERSION source" >&2
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION.tar.gz" -o "$tgz"

got=$(sha256_of "$tgz")

if [ "$got" != "$NODE_SHA256" ]; then
    echo "node-suite: sha256 mismatch for the Node source tarball" >&2
    echo "  expected $NODE_SHA256" >&2
    echo "  got      $got" >&2
    exit 1
fi

mkdir -p "$DEST"

# Only the test tree: the rest of Node is 90% of the tarball and none of it is
# useful here.
echo "node-suite: extracting the test tree" >&2
tar xzf "$tgz" -C "$DEST" --strip-components=2 \
    "node-$NODE_VERSION/test/common" \
    "node-$NODE_VERSION/test/fixtures" \
    "node-$NODE_VERSION/test/parallel"

# Overlay our stand-in for test/common. Node's own version requires
# child_process, worker_threads, crypto, cluster and async_hooks before it does
# anything, so it cannot load here. The originals are kept beside it so the
# difference stays visible.
echo "node-suite: overlaying the common shim" >&2

for f in index.js tmpdir.js; do
    if [ -f "$DEST/common/$f" ]; then
        mv "$DEST/common/$f" "$DEST/common/$f.node-original"
    fi

    cp "$HERE/shim/common/$f" "$DEST/common/$f"
done

touch "$DEST/.fetched"

echo "node-suite: $(find "$DEST/parallel" -name '*.js' | wc -l | tr -d ' ') parallel tests in $DEST"
