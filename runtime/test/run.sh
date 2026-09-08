#!/bin/sh
#
# Runs the Phase 1 suites against a built runtime.
#
# Usage: runtime/test/run.sh [path-to-node]
#   defaults to build/host-node/node; pass a qemu wrapper or a device path to
#   run the same suites elsewhere.
#
set -eu

TEST=$(cd "$(dirname "$0")" && pwd)
NODE=${1:-$TEST/../../build/host-node/node}

[ -x "${NODE%% *}" ] || { echo "run.sh: no runtime at $NODE" >&2; exit 1; }

status=0

for suite in buffer.js process.js core-modules.js stream.js loader/index.js; do
    if ! $NODE "$TEST/$suite" one two; then
        status=1
    fi
done

[ "$status" = 0 ] && echo "all suites passed"

exit "$status"
