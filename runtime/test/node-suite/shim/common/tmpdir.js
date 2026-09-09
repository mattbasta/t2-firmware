// Node's test/common/tmpdir, reimplemented without worker_threads.
//
// The scratch directory the fs tests build in. Node's version keys it off the
// worker thread id; there are no workers here, so the pid is enough.
//
// SPDX-License-Identifier: MIT

'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const tmpPath = path.join('/tmp', `t2-node-suite.${process.pid}`);

function refresh() {
    fs.rmSync(tmpPath, { recursive: true, force: true });
    fs.mkdirSync(tmpPath, { recursive: true });
}

function resolve(...paths) {
    return path.resolve(tmpPath, ...paths);
}

function fileURL(...paths) {
    return pathToFileURL(resolve(...paths));
}

function hasEnoughSpace() {
    // statfs is on the not-yet-built list (runtime/docs/omissions.md); nothing
    // in this suite writes enough for the answer to matter.
    return true;
}

process.on('exit', () => {
    try {
        fs.rmSync(tmpPath, { recursive: true, force: true });
    } catch {
        // Best effort: the test may already have removed it.
    }
});

module.exports = { path: tmpPath, refresh, resolve, fileURL, hasEnoughSpace };
