// node:timers/promises.
//
// Reached as require('timers/promises'); the file cannot carry that name
// because runtime/scripts/build-js.sh derives a C identifier from it, so the
// alias lives in runtime/js/entry.js.

'use strict';

function setTimeoutPromise(delay = 1, value, options = {}) {
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(abortError(options.signal));

            return;
        }

        const handle = setTimeout(() => {
            options.signal?.removeEventListener('abort', onAbort);
            resolve(value);
        }, delay);

        const onAbort = () => {
            clearTimeout(handle);
            reject(abortError(options.signal));
        };

        options.signal?.addEventListener('abort', onAbort, { once: true });

        // Node's ref: false leaves the timer from holding the loop open.
        if (options.ref === false && handle && typeof handle.unref === 'function') {
            handle.unref();
        }
    });
}

function setImmediatePromise(value, options = {}) {
    return setTimeoutPromise(0, value, options);
}

// An async iterator that yields every `delay` ms until aborted, which is what
// Node's setInterval here is for.
async function* setIntervalIterator(delay = 1, value, options = {}) {
    while (!options.signal?.aborted) {
        await setTimeoutPromise(delay, undefined, options);

        if (options.signal?.aborted) {
            return;
        }

        yield value;
    }
}

function abortError(signal) {
    const err = new Error(signal?.reason?.message ?? 'The operation was aborted');

    err.name = 'AbortError';
    err.code = 'ABORT_ERR';

    return err;
}

module.exports = {
    setTimeout: setTimeoutPromise,
    setImmediate: setImmediatePromise,
    setInterval: setIntervalIterator,
    scheduler: {
        wait: (delay, options) => setTimeoutPromise(delay, undefined, options),
        yield: () => setImmediatePromise()
    }
};
