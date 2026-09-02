#!/bin/sh
# Run the cross-built mipsel runtime under qemu-user and gate on what can be
# checked without hardware: the binary starts, IEEE numerics behave, and the
# number-related slice of test262 passes on the 32-bit soft-float build.
#
# Usage: runtime/scripts/test-qemu.sh <build-dir> [sdk-dir]
#   build-dir   output of runtime/scripts/build-cross.sh (contains tjs)
#   sdk-dir     where the SDK was unpacked (default: build/sdk); needed to
#               cross-build quickjs-ng's run-test262 for the test262 stage
#
# Environment:
#   QEMU_MIPSEL     qemu binary (default: qemu-mipsel-static on PATH)
#   TEST262_QUICK   set to 1 to skip the test262 stage (per-PR mode)
#   TEST262_THREADS run-test262 -t value (default: nproc)
#
# On real hardware the same numerics must be re-checked: QEMU may not model the
# 24KEc's pre-NaN2008 NaN encoding exactly (strategy risk R1).

set -eu

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD_DIR="$(cd "${1:?build-dir required}" && pwd)"
SDK_DIR="$(cd "${2:-$REPO/build/sdk}" 2>/dev/null && pwd || true)"
QEMU="${QEMU_MIPSEL:-qemu-mipsel-static}"
TJS="$BUILD_DIR/tjs"
QJS="$REPO/runtime/deps/txiki.js/deps/quickjs"

command -v "$QEMU" >/dev/null || { echo "test-qemu: $QEMU not found (set QEMU_MIPSEL)" >&2; exit 1; }
[ -x "$TJS" ] || { echo "test-qemu: $TJS missing — run build-cross.sh first" >&2; exit 1; }

echo "== smoke"
"$QEMU" "$TJS" eval 'console.log("tjs", tjs.version)'

echo "== numerics probe"
EXPECT='[0.30000000000000004,31415926535.89793,9007199254740992,true,true,false,null,0.0000314,"123456789.123457",[2,3,0],"NaN","9007199254740994",57,1.100000023841858,null,9007199254740991,null,5,1788307200000]'
GOT="$("$QEMU" "$TJS" eval 'console.log(JSON.stringify([0.1+0.2, Math.PI*1e10, 2**53+1, (0/0)!==(0/0), Number.isNaN(NaN), Object.is(-0,0), 1e308*10, parseFloat("3.14e-5"), (123456789.123456789).toFixed(6), [1.5,2.5,-0.5].map(Math.round), NaN.toString(), String(9007199254740993n+1n), (0.1).toString(2).length, Math.fround(1.1), new Float64Array([NaN])[0], Number.MAX_SAFE_INTEGER, (-1)**0.5, Math.hypot(3,4), Date.UTC(2026,8,2)]))')"
if [ "$GOT" != "$EXPECT" ]; then
    echo "numerics probe MISMATCH" >&2
    echo "  expected: $EXPECT" >&2
    echo "  got:      $GOT" >&2
    exit 1
fi
echo "ok"

if [ "${TEST262_QUICK:-0}" = "1" ]; then
    echo "== test262 skipped (TEST262_QUICK=1)"
    exit 0
fi

echo "== test262 numerics slice"
[ -n "$SDK_DIR" ] || { echo "test-qemu: sdk-dir required for the test262 stage" >&2; exit 1; }
SDK_ROOT="$(ls -d "$SDK_DIR"/openwrt-sdk-*/ | head -1)"
export STAGING_DIR="${SDK_ROOT}staging_dir"
export TOOLCHAIN_DIR="$(ls -d "$STAGING_DIR"/toolchain-mipsel_24kc_gcc-*_musl | head -1)"

if [ ! -f "$QJS/test262/package.json" ]; then
    # quickjs-ng pins the corpus but marks the submodule update=none.
    git -C "$QJS" -c submodule.test262.update=checkout submodule update --init --depth 1 test262 \
        || git -C "$QJS" -c submodule.test262.update=checkout submodule update --init test262
fi

T262_BUILD="$BUILD_DIR/run-test262"
cmake -S "$QJS" -B "$T262_BUILD" \
    -DCMAKE_TOOLCHAIN_FILE="$REPO/runtime/cmake/openwrt-mipsel.cmake" \
    -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$T262_BUILD" --target run-test262 -j"$(nproc 2>/dev/null || echo 4)" >/dev/null

THREADS="${TEST262_THREADS:-$(nproc 2>/dev/null || echo 4)}"
fail=0
cd "$QJS"
for d in built-ins/Number built-ins/Math built-ins/parseFloat built-ins/parseInt \
         built-ins/DataView built-ins/TypedArray built-ins/TypedArrayConstructors \
         built-ins/ArrayBuffer built-ins/BigInt built-ins/Date \
         language/types/number language/literals/numeric; do
    out="$("$QEMU" "$T262_BUILD/run-test262" -c test262.conf -t "$THREADS" -d "test262/test/$d" 2>&1 | grep -E '^Result' || true)"
    printf '%-36s %s\n' "$d" "$out"
    case "$out" in "Result: 0/"*) ;; *) fail=1 ;; esac
done
[ "$fail" = 0 ] || { echo "test262 numerics slice FAILED" >&2; exit 1; }
echo "ok"
