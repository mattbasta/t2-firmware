// A stand-in for Node's own test/common, small enough to read.
//
// Node's version requires child_process, worker_threads, crypto, cluster and
// async_hooks before it does anything, so it cannot load here — and most of
// what it carries is for platforms and features this runtime will never have.
// This implements the surface its fs and net tests actually use, measured
// rather than guessed: mustCall and friends account for more than a thousand of
// the call sites, and the long tail is platform predicates.
//
// Deliberately NOT a harvest: it is a reimplementation of an interface, not a
// copy of an implementation, so it carries no provenance header. The tests it
// serves are the third-party artifact here.
//
// SPDX-License-Identifier: MIT

'use strict';

const assert = require('assert');
const path = require('path');
const { inspect } = require('util');

const noop = () => {};

// --- mustCall ----------------------------------------------------------------
//
// The heart of Node's harness: wrap a callback, record how many times it ran,
// and check the tally when the process exits. A test that never calls its
// callback fails, which is exactly the class of bug an event-driven runtime
// produces and an ordinary assertion cannot see.

const mustCallChecks = [];

function runCallChecks(exitCode) {
    if (exitCode !== 0) {
        return;
    }

    const failed = mustCallChecks.filter(context => {
        if ('minimum' in context) {
            context.messageSegment = `at least ${context.minimum}`;

            return context.actual < context.minimum;
        }

        context.messageSegment = `exactly ${context.exact}`;

        return context.actual !== context.exact;
    });

    for (const context of failed) {
        console.error(
            `Mismatched ${context.name} function calls. ` +
            `Expected ${context.messageSegment}, actual ${context.actual}.`
        );
        console.error(context.stack.split('\n').slice(2).join('\n'));
    }

    if (failed.length > 0) {
        process.exit(1);
    }
}

process.on('exit', runCallChecks);

function _mustCallInner(fn, criteria = 1, field) {
    if (typeof fn === 'number') {
        criteria = fn;
        fn = noop;
    } else if (fn === undefined) {
        fn = noop;
    }

    if (typeof criteria !== 'number') {
        throw new TypeError(`Invalid ${field} value: ${criteria}`);
    }

    const context = {
        [field]: criteria,
        actual: 0,
        stack: new Error().stack,
        name: fn.name || '<anonymous>'
    };

    mustCallChecks.push(context);

    const wrapped = function (...args) {
        context.actual++;

        return fn.apply(this, args);
    };

    Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true });

    return wrapped;
}

function mustCall(fn, exact) {
    return _mustCallInner(fn, exact, 'exact');
}

function mustCallAtLeast(fn, minimum) {
    return _mustCallInner(fn, minimum, 'minimum');
}

function mustSucceed(fn, exact) {
    return mustCall(function (err, ...args) {
        assert.ifError(err);

        if (typeof fn === 'function') {
            return fn.apply(this, args);
        }

        return undefined;
    }, exact);
}

function mustNotCall(message) {
    const from = new Error().stack.split('\n')[2] ?? '';

    return function mustNotCall(...args) {
        const argsInfo = args.length > 0 ? `\ncalled with arguments: ${args.map(a => inspect(a)).join(', ')}` : '';

        assert.fail(`${message || 'function should not have been called'} at${from}${argsInfo}`);
    };
}

// --- mustNotMutateObjectDeep -------------------------------------------------
//
// fs takes an options object and must not write to it. A proxy that refuses
// every mutation turns "it quietly mutated my argument" into a thrown error at
// the point it happened.

function mustNotMutateObjectDeep(original) {
    if (original === null || typeof original !== 'object') {
        return original;
    }

    const wrap = obj => {
        if (obj === null || typeof obj !== 'object') {
            return obj;
        }

        return new Proxy(obj, {
            get(target, property, receiver) {
                return wrap(Reflect.get(target, property, receiver));
            },
            set(target, property) {
                assert.fail(`Expected no mutation, got assignment to ${String(property)}`);
            },
            defineProperty(target, property) {
                assert.fail(`Expected no mutation, got defineProperty for ${String(property)}`);
            },
            deleteProperty(target, property) {
                assert.fail(`Expected no mutation, got delete of ${String(property)}`);
            },
            setPrototypeOf() {
                assert.fail('Expected no mutation, got setPrototypeOf');
            }
        });
    };

    return wrap(original);
}

// --- errors ------------------------------------------------------------------

function expectsError(validator, exact) {
    return mustCall((...args) => {
        if (args.length !== 1) {
            assert.strictEqual(args.length, 2, `Expected one or two arguments, got ${inspect(args)}`);
        }

        const error = args.pop();

        assert.throws(() => {
            throw error;
        }, validator);
    }, exact);
}

function invalidArgTypeHelper(input) {
    if (input == null) {
        return ` Received ${input}`;
    }

    if (typeof input === 'function') {
        return ` Received function ${input.name}`;
    }

    if (typeof input === 'object') {
        if (input.constructor?.name) {
            return ` Received an instance of ${input.constructor.name}`;
        }

        return ` Received ${inspect(input, { depth: -1 })}`;
    }

    let inspected = inspect(input, { colors: false });

    if (inspected.length > 25) {
        inspected = `${inspected.slice(0, 25)}...`;
    }

    return ` Received type ${typeof input} (${inspected})`;
}

// Node's warning machinery is not implemented here, and a test that needs it
// should fail rather than pass vacuously — so record the expectation and let
// the missing warning be the failure.
const expectedWarnings = [];

function expectWarning(nameOrMap, expected) {
    expectedWarnings.push(typeof nameOrMap === 'string' ? [nameOrMap, expected] : nameOrMap);
}

process.on('exit', code => {
    if (code === 0 && expectedWarnings.length > 0 && !process.__sawWarning) {
        console.error('Expected a process warning; this runtime does not implement process.emitWarning.');
        process.exit(1);
    }
});

// --- platform predicates -----------------------------------------------------

const isWindows = process.platform === 'win32';
const isOSX = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

function platformTimeout(ms) {
    // Emulated MIPS is slow enough that a timing-sensitive test written for a
    // developer laptop will flake at its original numbers.
    return process.arch === 'mipsel' || process.arch === 'mips' ? ms * 4 : ms;
}

// --- skipping ----------------------------------------------------------------

function printSkipMessage(msg) {
    console.log(`1..0 # Skipped: ${msg}`);
}

function skip(msg) {
    printSkipMessage(msg);
    process.exit(0);
}

// --- odds and ends the tests reach for ---------------------------------------

function runWithInvalidFD(func) {
    let fd = 1 << 30;

    // Find a descriptor that is definitely not open.
    while (fd > 0) {
        try {
            require('fs').fstatSync(fd);
        } catch {
            return func(fd);
        }

        fd >>>= 1;
    }

    printSkipMessage('Could not find an invalid file descriptor');

    return undefined;
}

function getArrayBufferViews(buf) {
    const { buffer, byteOffset, byteLength } = buf;
    const views = [];
    const constructors = [
        Int8Array, Uint8Array, Uint8ClampedArray,
        Int16Array, Uint16Array,
        Int32Array, Uint32Array,
        Float32Array, Float64Array,
        DataView
    ];

    for (const Ctor of constructors) {
        const { BYTES_PER_ELEMENT = 1 } = Ctor;

        if (byteLength % BYTES_PER_ELEMENT === 0) {
            views.push(new Ctor(buffer, byteOffset, byteLength / BYTES_PER_ELEMENT));
        }
    }

    return views;
}

const tmpdir = require('./tmpdir');

module.exports = {
    mustCall,
    mustCallAtLeast,
    mustSucceed,
    mustNotCall,
    mustNotMutateObjectDeep,
    expectsError,
    expectWarning,
    invalidArgTypeHelper,
    getArrayBufferViews,
    runWithInvalidFD,
    platformTimeout,
    printSkipMessage,
    skip,

    isWindows,
    isOSX,
    isLinux,
    isAIX: false,
    isIBMi: false,
    isSunOS: false,
    isFreeBSD: false,
    isOpenBSD: false,
    inFreeBSDJail: false,
    isMainThread: true,
    isDumbTerminal: process.env.TERM === 'dumb',

    hasCrypto: false,
    hasIPv6: true,
    hasMultiLocalhost: false,
    hasFipsCrypto: false,
    enoughTestMem: true,
    rootDir: '/',

    localhostIPv4: '127.0.0.1',
    localhostIPv6: '::1',

    // A Unix socket path, in the same scratch directory the tests clean up.
    PIPE: path.join(tmpdir.path, 'test.sock'),

    canCreateSymLink: () => true,
    allowGlobals: () => {},
    skipIfInspectorDisabled: () => skip('inspector is not supported'),
    skipIfWorker: () => {},
    skipIfDumbTerminal: () => {},
    mustNotMutateObjectDeepStrict: mustNotMutateObjectDeep
};
