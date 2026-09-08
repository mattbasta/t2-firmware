#!/bin/sh
#
# Compile runtime/js/ to QuickJS bytecode, writing the generated C into
# runtime/src/bundles/.
#
# This is NOT part of the release build. The generated .c files are committed,
# exactly as txiki commits its own, so a cross-build needs no host toolchain and
# not this script — see runtime/docs/phase1-plan.md §3. Run it when anything under
# runtime/js/ changes, and commit the result.
#
# Needs cmake (for tjsc) and curl. It does NOT need npm: esbuild is fetched as a
# pinned, sha256-verified binary and cached in the build directory. That is both
# one less thing to install and a better match for how this repo pins everything
# else — a resolved-at-build-time `npx esbuild@x` is not a reproducible artifact.
#
# Usage: runtime/scripts/build-js.sh [host-build-dir]
#
set -eu

# Pinned; also recorded in runtime/deps/MANIFEST.toml.
ESBUILD_VERSION=0.25.10
ESBUILD_SHA256_linux_x64=25a7b968b8e5172baaa8f44f91b71c1d2d7e760042c691f22ab59527d870d145
ESBUILD_SHA256_darwin_arm64=dd339e37292a711b2eba546fb1df36dd9f846a849ac3edfd3ac5271b5022f323

RUNTIME=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${1:-$RUNTIME/../build/host}
JOBS=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

mkdir -p "$BUILD"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

esbuild_path() {
    bin="$BUILD/esbuild-$ESBUILD_VERSION"

    if [ -x "$bin" ]; then
        echo "$bin"
        return
    fi

    case "$(uname -s)-$(uname -m)" in
        Linux-x86_64)   pkg=linux-x64;    want=$ESBUILD_SHA256_linux_x64 ;;
        Darwin-arm64)   pkg=darwin-arm64; want=$ESBUILD_SHA256_darwin_arm64 ;;
        *)
            echo "build-js: no pinned esbuild for $(uname -s)-$(uname -m)." >&2
            echo "  Add its sha256 to this script (registry.npmjs.org/@esbuild/<pkg>)." >&2
            exit 1
            ;;
    esac

    tgz="$BUILD/esbuild-$ESBUILD_VERSION-$pkg.tgz"

    echo "build-js: fetching esbuild $ESBUILD_VERSION ($pkg)" >&2
    curl -fsSL "https://registry.npmjs.org/@esbuild/$pkg/-/$pkg-$ESBUILD_VERSION.tgz" -o "$tgz"

    got=$(sha256_of "$tgz")

    if [ "$got" != "$want" ]; then
        echo "build-js: esbuild sha256 mismatch" >&2
        echo "  expected $want" >&2
        echo "  got      $got" >&2
        rm -f "$tgz"
        exit 1
    fi

    unpack="$BUILD/esbuild-unpack.$$"
    mkdir -p "$unpack"
    tar xzf "$tgz" -C "$unpack" package/bin/esbuild
    mv "$unpack/package/bin/esbuild" "$bin"
    chmod +x "$bin"
    rm -rf "$unpack"

    echo "$bin"
}

ESBUILD=$(esbuild_path)

# tjsc derives the C symbol name from the *input* filename, so the bundle has to
# be called entry.js for the symbols to come out as t2__entry / t2__entry_size.
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

"$ESBUILD" "$RUNTIME/js/entry.js" \
    --bundle \
    --format=esm \
    --platform=neutral \
    --target=es2022 \
    --external:tjs:path \
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

# --- the standard library ---------------------------------------------------
#
# Each core module compiles to its own bytecode blob, wrapped in the CommonJS
# wrapper and compiled as a *script*, so evaluating the blob yields the wrapper
# function. That is what makes the standard library lazy: the kernel bundle above
# is deserialized at every startup, but a module here costs nothing until
# something requires it (runtime/docs/phase1-plan.md §3).
#
# These are CommonJS files with no static imports, so esbuild is not involved.

CORE_C="$RUNTIME/src/bundles/core_modules.c"
names=""

: > "$STAGE/blobs.c"

for source in "$RUNTIME"/js/node/*.js; do
    name=$(basename "$source" .js)

    case $name in
        *[!a-z0-9_]*)
            echo "build-js: '$name' is not a C identifier; core module names must be [a-z0-9_]" >&2
            exit 1
            ;;
    esac

    # The wrapper opens on line 1 with no newline before the source, exactly as
    # Node does it, so reported line numbers match the file.
    {
        printf '(function (exports, require, module, __filename, __dirname) {'
        cat "$source"
        printf '\n})'
    } > "$STAGE/$name.js"

    # -S forces script mode (fork patch 0003). Autodetect cannot get here:
    # JS_DetectModule answers "module" for anything that parses as one, and a
    # module is strict — CommonJS must stay sloppy unless the file opts in.
    "$BUILD/tjsc" -S -s -o "$STAGE/$name.c" -p t2__core_ "$STAGE/$name.js"

    grep -v -e '^#include' -e 'File generated automatically' "$STAGE/$name.c" >> "$STAGE/blobs.c"
    names="$names $name"
done

{
    echo '/* Generated by runtime/scripts/build-js.sh from runtime/js/node/. Do not edit. */'
    echo
    echo '#include "t2.h"'
    cat "$STAGE/blobs.c"
    echo 'const t2_builtin_t t2_core_modules[] = {'

    for name in $names; do
        printf '    { "%s", t2__core_%s, sizeof(t2__core_%s) },\n' "$name" "$name" "$name"
    done

    echo '    { NULL, NULL, 0 }'
    echo '};'
} > "$CORE_C"

kernel=$(sed -n 's/.*_size = \([0-9]*\);.*/\1/p' "$RUNTIME/src/bundles/entry.c" | head -1)
library=$(sed -n 's/.*_size = \([0-9]*\);.*/\1/p' "$CORE_C" | paste -sd+ - | bc)

echo "build-js: kernel $kernel bytes (eager), core modules ${library:-0} bytes across$names (lazy)"
