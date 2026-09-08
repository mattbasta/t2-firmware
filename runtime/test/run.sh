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

# NODE may be a path ("build/host-node/node") or a wrapper command whose first
# word is resolved through PATH ("qemu-mipsel-static build/mipsel/node"), so
# check with command -v rather than a plain -x on the first word.
command -v "${NODE%% *}" >/dev/null 2>&1 \
    || { echo "run.sh: cannot run '${NODE%% *}'" >&2; exit 1; }

status=0

# corpus/index.js self-skips when runtime/test/corpus/fetch.sh has not been run.
for suite in buffer.js process.js core-modules.js stream.js loader/index.js corpus/index.js; do
    if ! $NODE "$TEST/$suite" one two; then
        status=1
    fi
done

[ "$status" = 0 ] && echo "all suites passed"

exit "$status"
