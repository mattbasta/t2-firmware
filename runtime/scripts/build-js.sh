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
# Usage: runtime/scripts/build-js.sh [host-build-dir]
#
set -eu

RUNTIME=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${1:-$RUNTIME/../build/host}
JOBS=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

# tjsc is EXCLUDE_FROM_ALL upstream and links only quickjs, so this configures
# txiki but builds little of it. It must be a *host* build: the bytecode is
# produced on the build machine and embedded for the target.
cmake -S "$RUNTIME/deps/txiki.js" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$BUILD" --target tjsc -j "$JOBS" >/dev/null

mkdir -p "$RUNTIME/src/bundles"

# -m compile as a module, -s strip source (debug info, and so line numbers,
# survive), -p sets the C symbol prefix, so entry.js becomes t2__entry.
"$BUILD/tjsc" -m -s \
    -o "$RUNTIME/src/bundles/entry.c" \
    -n "t2:entry" \
    -p t2__ \
    "$RUNTIME/js/entry.js"

echo "build-js: $(wc -c < "$RUNTIME/src/bundles/entry.c") bytes of C from runtime/js/entry.js"
