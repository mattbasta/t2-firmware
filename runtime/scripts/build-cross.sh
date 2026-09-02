#!/bin/sh
# Cross-build the runtime for the Tessel 2 (mipsel_24kc, soft-float, musl)
# using the pinned OpenWrt SDK. Produces a stripped, fully static binary.
#
# Usage: runtime/scripts/build-cross.sh <sdk-dir> <build-dir> [cmake args...]
#   sdk-dir    where scripts/fetch-sdk.sh unpacked the SDK (contains openwrt-sdk-*/)
#   build-dir  CMake build directory; the binary lands at <build-dir>/tjs
#
# Needs no network: everything comes from the SDK and the git submodules
# (runtime/DEPENDENCIES.md, prime directive). CI runs this under `unshare --net`.

set -eu

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SDK_DIR="$(cd "${1:?sdk-dir required}" && pwd)"
mkdir -p "${2:?build-dir required}"
BUILD_DIR="$(cd "$2" && pwd)"
shift 2

SDK_ROOT="$(ls -d "$SDK_DIR"/openwrt-sdk-*/ 2>/dev/null | head -1)"
[ -n "$SDK_ROOT" ] || { echo "build-cross: no openwrt-sdk-*/ under $SDK_DIR (run scripts/fetch-sdk.sh)" >&2; exit 1; }
TOOLCHAIN_DIR="$(ls -d "$SDK_ROOT"staging_dir/toolchain-mipsel_24kc_gcc-*_musl 2>/dev/null | head -1)"
[ -n "$TOOLCHAIN_DIR" ] || { echo "build-cross: no mipsel_24kc musl toolchain in $SDK_ROOT" >&2; exit 1; }

# The OpenWrt gcc wrappers refuse to run without STAGING_DIR.
export STAGING_DIR="${SDK_ROOT}staging_dir"
export TOOLCHAIN_DIR
export PATH="$TOOLCHAIN_DIR/bin:$PATH"

echo "build-cross: toolchain $TOOLCHAIN_DIR"

cmake -S "$REPO/runtime/deps/txiki.js" -B "$BUILD_DIR" \
    -DCMAKE_TOOLCHAIN_FILE="$REPO/runtime/cmake/openwrt-mipsel.cmake" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_WITH_WASM=OFF \
    -DBUILD_WITH_FFI=OFF \
    -DBUILD_WITH_MIMALLOC=OFF \
    -DBUILD_WITH_SQLITE=ON \
    -DBUILD_WITH_STRIP=ON \
    -DBUILD_WITH_GC_SECTIONS=ON \
    "$@"

cmake --build "$BUILD_DIR" --target tjs-cli -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

echo "build-cross: $(ls -la "$BUILD_DIR/tjs")"
file "$BUILD_DIR/tjs" 2>/dev/null || true
