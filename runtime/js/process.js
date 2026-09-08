// process — Node's global, over txiki's primitives and our natives.
//
// In Node, process is an EventEmitter. node:events is step 4 of Phase 1, so this
// carries a small emitter of its own; when the real one lands, process should
// extend it and this goes away. Nothing here depends on that swap.

const VERSIONS = tjs.engine.versions;

// process.version is what era code feature-detects on, so it is not free to be
// arbitrary. Today it tracks txiki's version, which lands on v26 by coincidence
// rather than by decision — and a program reading that will assume a Node 26
// surface, including things this runtime does not have yet. What it should
// report is the Node compatibility level we actually implement, which is not
// settled until Phase 2 and 3 fill in fs, net and http. Recorded as an open
// question in runtime/docs/phase1-plan.md §7 rather than silently guessed at.
const NODE_COMPAT_VERSION = `v${VERSIONS.tjs}`;

// Some tjs surfaces are plain properties, others accessors or functions;
// resolve either shape rather than guessing.
function resolve(value) {
    return typeof value === 'function' ? value() : value;
}

function makeEmitter(target) {
    const listeners = Object.create(null);

    function on(event, fn) {
        (listeners[event] ??= []).push(fn);

        return target;
    }

    function off(event, fn) {
        const list = listeners[event];

        if (list) {
            const i = list.indexOf(fn);

            if (i !== -1) {
                list.splice(i, 1);
            }
        }

        return target;
    }

    function once(event, fn) {
        const wrapper = (...args) => {
            off(event, wrapper);
            fn(...args);
        };

        return on(event, wrapper);
    }

    function emit(event, ...args) {
        const list = listeners[event];

        if (!list || list.length === 0) {
            return false;
        }

        // Copy: a listener may remove itself, or others, while we iterate.
        for (const fn of list.slice()) {
            fn(...args);
        }

        return true;
    }

    function listenerCount(event) {
        return listeners[event]?.length ?? 0;
    }

    Object.assign(target, {
        on,
        off,
        once,
        emit,
        addListener: on,
        removeListener: off,
        listeners: event => (listeners[event] ?? []).slice(),
        listenerCount,
        removeAllListeners(event) {
            if (event === undefined) {
                for (const key of Object.keys(listeners)) {
                    delete listeners[key];
                }
            } else {
                delete listeners[event];
            }

            return target;
        }
    });

    return { emit, listenerCount };
}

// --- process.nextTick -------------------------------------------------------
//
// Node drains the whole nextTick queue before any promise job. We approximate
// with one microtask that drains to completion, including callbacks queued
// during the drain. The deviation: promise jobs queued *before* the first
// nextTick of a turn still run first. Era code does not depend on that ordering;
// note it if something ever does.

const tickQueue = [];
let tickIndex = 0;
let tickScheduled = false;

function drainTicks() {
    tickScheduled = false;

    while (tickIndex < tickQueue.length) {
        const entry = tickQueue[tickIndex++];

        try {
            entry.fn(...entry.args);
        } catch (err) {
            handleUncaught(err);
        }
    }

    // Index-based drain, then reset: shift() would make this quadratic.
    tickQueue.length = 0;
    tickIndex = 0;
}

function nextTick(fn, ...args) {
    if (typeof fn !== 'function') {
        const err = new TypeError('The "callback" argument must be of type function');

        err.code = 'ERR_INVALID_ARG_TYPE';

        throw err;
    }

    tickQueue.push({ fn, args });

    if (!tickScheduled) {
        tickScheduled = true;
        queueMicrotask(drainTicks);
    }
}

// --- stdio ------------------------------------------------------------------
//
// Not Writable streams yet — those arrive with node:stream in step 5. These
// cover the surface era code actually touches on process.stdout: write(), fd,
// isTTY, and enough of the EventEmitter shape not to throw.

function makeStdioWriter(native, fd) {
    const stream = {
        fd,
        writable: true,
        isTTY: native.isTTY(fd),

        write(chunk, encoding, callback) {
            const cb = typeof encoding === 'function' ? encoding : callback;

            native.writeSync(fd, typeof chunk === 'string' ? chunk : chunk);

            if (typeof cb === 'function') {
                cb();
            }

            return true;
        },

        end(chunk) {
            if (chunk !== undefined && chunk !== null) {
                stream.write(chunk);
            }

            return stream;
        },

        // Writes are synchronous, so there is never anything to flush.
        cork() {},
        uncork() {}
    };

    makeEmitter(stream);

    return stream;
}

// --- the object -------------------------------------------------------------

function handleUncaught(err) {
    if (process.listenerCount('uncaughtException') > 0) {
        process.emit('uncaughtException', err);

        return;
    }

    console.error(err);
    process.exit(1);
}

const process = Object.create(null);

const emitter = makeEmitter(process);

let exited = false;

function runExitHandlers(code) {
    if (exited) {
        return;
    }

    exited = true;
    emitter.emit('exit', code);
}

export function createProcess(native, argv) {
    Object.assign(process, {
        // Node's argv is [execPath, scriptPath, ...rest].
        argv,
        argv0: 'node',
        execPath: resolve(tjs.exePath),
        execArgv: [],
        env: tjs.env,
        pid: tjs.pid,
        ppid: tjs.ppid,
        platform: native.platform,
        arch: native.arch,
        title: 'node',
        exitCode: undefined,
        version: NODE_COMPAT_VERSION,
        versions: Object.freeze({ ...VERSIONS, node: VERSIONS.tjs }),
        release: Object.freeze({ name: 'node' }),

        cwd: () => resolve(tjs.cwd),
        chdir: dir => tjs.chdir(dir),
        uptime: () => resolve(tjs.system.uptime),
        nextTick,

        hrtime,

        exit(code) {
            const status = code ?? process.exitCode ?? 0;

            process.exitCode = status;
            runExitHandlers(status);
            tjs.exit(status);
        },

        // Enough of the shape that era code calling these does not crash.
        emitWarning(warning) {
            console.error(`(node) Warning: ${warning}`);
        },
        umask: () => 0,
        memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 })
    });

    process.stdout = makeStdioWriter(native, 1);
    process.stderr = makeStdioWriter(native, 2);

    // Natural termination: txiki fires beforeunload on the global when the loop
    // drains (deps/txiki.js/src/vm.c). It is cancelable, so we must not
    // preventDefault — we only want the notification. tessel-export.js relies on
    // process.on('exit'), so this is part of the device API floor.
    globalThis.addEventListener('beforeunload', () => {
        const code = process.exitCode ?? 0;

        runExitHandlers(code);

        // Node exits with process.exitCode when the loop drains, not just when
        // exit() is called explicitly. Nothing else consults it, so say so here.
        if (code !== 0) {
            tjs.exit(code);
        }
    });

    return process;
}

function hrtime(previous) {
    const ms = performance.now();
    let seconds = Math.floor(ms / 1000);
    let nanoseconds = Math.floor((ms - seconds * 1000) * 1e6);

    if (previous) {
        seconds -= previous[0];
        nanoseconds -= previous[1];

        if (nanoseconds < 0) {
            seconds -= 1;
            nanoseconds += 1e9;
        }
    }

    return [seconds, nanoseconds];
}

hrtime.bigint = () => BigInt(Math.round(performance.now() * 1e6));

export { process, handleUncaught, drainTicks };
