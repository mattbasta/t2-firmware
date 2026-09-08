#!/bin/sh
#
# Compile runtime/js/ to QuickJS bytecode, writing the generated C into
# runtime/src/bundles/.
#
# This is NOT part of the release build. The generated .c files are committed,
# exactly as txiki commits its own, so a cross-build needs no host toolchain, no
# npm, and not this script — see runtime/docs/phase1-plan.md §3. Run it when
# anything under runtime/js/ changes, and commit the result.
#
# Requires node/npx (for esbuild) and cmake (to build tjsc) on the same machine.
#
# Usage: runtime/scripts/build-js.sh [host-build-dir]
#
set -eu

ESBUILD_VERSION=0.25.10   # pinned; also recorded in runtime/deps/MANIFEST.toml

RUNTIME=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${1:-$RUNTIME/../build/host}
JOBS=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

command -v npx >/dev/null 2>&1 || {
    echo "build-js: needs node/npx to run esbuild" >&2
    exit 1
}

# tjsc derives the C symbol name from the *input* filename, so the bundle has to
# be called entry.js for the symbols to come out as t2__entry / t2__entry_size.
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

npx --yes "esbuild@$ESBUILD_VERSION" "$RUNTIME/js/entry.js" \
    --bundle \
    --format=esm \
    --platform=neutral \
    --target=es2022 \
    --outfile="$STAGE/entry.js"

# tjsc is EXCLUDE_FROM_ALL upstream and links only quickjs, so this configures
# txiki but builds little of it. It must be a *host* build: the bytecode is
# produced on the build machine and embedded for the target.
cmake -S "$RUNTIME/deps/txiki.js" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$BUILD" --target tjsc -j "$JOBS" >/dev/null

mkdir -p "$RUNTIME/src/bundles"

# -m compile as a module, -s strip source (debug info, and so line numbers,
# survive), -p sets the C symbol prefix.
"$BUILD/tjsc" -m -s \
    -o "$RUNTIME/src/bundles/entry.c" \
    -n "t2:entry" \
    -p t2__ \
    "$STAGE/entry.js"

echo "build-js: $(grep -m1 '_size = ' "$RUNTIME/src/bundles/entry.c" | tr -dc '0-9') bytes of bytecode"
