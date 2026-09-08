// assert
//
// Written rather than harvested. The npm `assert` package is a browserify port
// that trails Node by years and pulls in object-is/util shims; Node's own is
// built on internal/errors and internal/util/comparisons. This implements the
// documented behaviour directly, including the deep-comparison rules, which are
// the only genuinely subtle part.

'use strict';

const { inspect } = require('util');

class AssertionError extends Error {
    constructor(options) {
        const { actual, expected, operator, stackStartFn } = options;
        const message = options.message ||
            `${inspect(actual, { depth: 2 })} ${operator} ${inspect(expected, { depth: 2 })}`;

        super(message);

        this.name = 'AssertionError';
        this.code = 'ERR_ASSERTION';
        this.actual = actual;
        this.expected = expected;
        this.operator = operator;
        this.generatedMessage = !options.message;

        // Hide the assertion machinery so the first frame is the caller's.
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, stackStartFn || AssertionError);
        }
    }
}

function innerFail(options) {
    throw new AssertionError(options);
}

// --- deep comparison --------------------------------------------------------

function isPrimitiveEqual(a, b, strict) {
    return strict ? Object.is(a, b) : a == b; // eslint-disable-line eqeqeq
}

function deepEqualInternal(a, b, strict, memo) {
    if (strict ? Object.is(a, b) : a === b) {
        return true;
    }

    // Loose mode compares primitives with ==, which is the whole difference
    // between deepEqual and deepStrictEqual for leaf values.
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
        return isPrimitiveEqual(a, b, strict);
    }

    if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
        return false;
    }

    // Cycles: if we are already comparing this pair higher up the stack, treat
    // it as equal and let the rest of the structure decide.
    for (const [seenA, seenB] of memo) {
        if (seenA === a && seenB === b) {
            return true;
        }
    }

    memo.push([a, b]);

    try {
        return compareObjects(a, b, strict, memo);
    } finally {
        memo.pop();
    }
}

function compareObjects(a, b, strict, memo) {
    if (a instanceof Date || b instanceof Date) {
        return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
    }

    if (a instanceof RegExp || b instanceof RegExp) {
        return a instanceof RegExp && b instanceof RegExp &&
            a.source === b.source && a.flags === b.flags;
    }

    if (a instanceof Error || b instanceof Error) {
        if (!(a instanceof Error && b instanceof Error)) {
            return false;
        }

        if (a.name !== b.name || a.message !== b.message) {
            return false;
        }
    }

    if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
        if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.byteLength !== b.byteLength) {
            return false;
        }

        const viewA = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        const viewB = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

        for (let i = 0; i < viewA.length; i++) {
            if (viewA[i] !== viewB[i]) {
                return false;
            }
        }

        return true;
    }

    if (a instanceof Map || b instanceof Map) {
        if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) {
            return false;
        }

        for (const [key, value] of a) {
            // Keys may be objects, so a plain has() is not enough.
            let matched = false;

            for (const [otherKey, otherValue] of b) {
                if (deepEqualInternal(key, otherKey, strict, memo) &&
                    deepEqualInternal(value, otherValue, strict, memo)) {
                    matched = true;
                    break;
                }
            }

            if (!matched) {
                return false;
            }
        }

        return true;
    }

    if (a instanceof Set || b instanceof Set) {
        if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) {
            return false;
        }

        for (const value of a) {
            let matched = false;

            for (const other of b) {
                if (deepEqualInternal(value, other, strict, memo)) {
                    matched = true;
                    break;
                }
            }

            if (!matched) {
                return false;
            }
        }

        return true;
    }

    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return false;
        }
    }

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) {
        return false;
    }

    for (const key of keysA) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) {
            return false;
        }

        if (!deepEqualInternal(a[key], b[key], strict, memo)) {
            return false;
        }
    }

    const symbolsA = Object.getOwnPropertySymbols(a).filter(s => Object.prototype.propertyIsEnumerable.call(a, s));
    const symbolsB = Object.getOwnPropertySymbols(b).filter(s => Object.prototype.propertyIsEnumerable.call(b, s));

    if (symbolsA.length !== symbolsB.length) {
        return false;
    }

    for (const symbol of symbolsA) {
        if (!Object.prototype.propertyIsEnumerable.call(b, symbol) ||
            !deepEqualInternal(a[symbol], b[symbol], strict, memo)) {
            return false;
        }
    }

    return true;
}

// --- the assertions ---------------------------------------------------------

function ok(value, message) {
    if (!value) {
        innerFail({
            actual: value,
            expected: true,
            message,
            operator: '==',
            stackStartFn: ok
        });
    }
}

const assert = ok;

assert.AssertionError = AssertionError;
assert.ok = ok;

assert.fail = function fail(message) {
    innerFail({
        actual: undefined,
        expected: undefined,
        message: message === undefined ? 'Failed' : message,
        operator: 'fail',
        stackStartFn: fail
    });
};

assert.equal = function equal(actual, expected, message) {
    // eslint-disable-next-line eqeqeq
    if (actual != expected) {
        innerFail({ actual, expected, message, operator: '==', stackStartFn: equal });
    }
};

assert.notEqual = function notEqual(actual, expected, message) {
    // eslint-disable-next-line eqeqeq
    if (actual == expected) {
        innerFail({ actual, expected, message, operator: '!=', stackStartFn: notEqual });
    }
};

assert.strictEqual = function strictEqual(actual, expected, message) {
    if (!Object.is(actual, expected)) {
        innerFail({ actual, expected, message, operator: 'strictEqual', stackStartFn: strictEqual });
    }
};

assert.notStrictEqual = function notStrictEqual(actual, expected, message) {
    if (Object.is(actual, expected)) {
        innerFail({ actual, expected, message, operator: 'notStrictEqual', stackStartFn: notStrictEqual });
    }
};

assert.deepEqual = function deepEqual(actual, expected, message) {
    if (!deepEqualInternal(actual, expected, false, [])) {
        innerFail({ actual, expected, message, operator: 'deepEqual', stackStartFn: deepEqual });
    }
};

assert.notDeepEqual = function notDeepEqual(actual, expected, message) {
    if (deepEqualInternal(actual, expected, false, [])) {
        innerFail({ actual, expected, message, operator: 'notDeepEqual', stackStartFn: notDeepEqual });
    }
};

assert.deepStrictEqual = function deepStrictEqual(actual, expected, message) {
    if (!deepEqualInternal(actual, expected, true, [])) {
        innerFail({ actual, expected, message, operator: 'deepStrictEqual', stackStartFn: deepStrictEqual });
    }
};

assert.notDeepStrictEqual = function notDeepStrictEqual(actual, expected, message) {
    if (deepEqualInternal(actual, expected, true, [])) {
        innerFail({ actual, expected, message, operator: 'notDeepStrictEqual', stackStartFn: notDeepStrictEqual });
    }
};

function expectedMatches(err, expected) {
    if (expected === undefined) {
        return true;
    }

    if (typeof expected === 'function') {
        // A constructor, or a predicate returning true.
        if (expected.prototype !== undefined && err instanceof expected) {
            return true;
        }

        return expected(err) === true;
    }

    if (expected instanceof RegExp) {
        return expected.test(String(err));
    }

    if (typeof expected === 'object' && expected !== null) {
        return Object.keys(expected).every(key =>
            deepEqualInternal(err[key], expected[key], true, []));
    }

    return false;
}

// assert.throws(fn[, error][, message]) — when the second argument is a string
// it is the *message*, not a matcher. Node has always read it that way, and era
// code leans on it: `assert.throws(fn, 'Error: boom')` asserts only that fn
// throws. Treating the string as a matcher would fail to match and rethrow the
// caller's error, which looks exactly like the assertion having no effect.
function normalizeThrowsArgs(expected, message) {
    if (typeof expected === 'string' && message === undefined) {
        return { expected: undefined, message: expected };
    }

    return { expected, message };
}

assert.throws = function throws(fn, expectedArg, messageArg) {
    const { expected, message } = normalizeThrowsArgs(expectedArg, messageArg);
    let threw = false;
    let caught;

    try {
        fn();
    } catch (err) {
        threw = true;
        caught = err;
    }

    if (!threw) {
        innerFail({
            actual: undefined,
            expected,
            message: message || 'Missing expected exception.',
            operator: 'throws',
            stackStartFn: throws
        });
    }

    if (!expectedMatches(caught, expected)) {
        throw caught;
    }
};

assert.doesNotThrow = function doesNotThrow(fn, expectedArg, messageArg) {
    const { expected, message } = normalizeThrowsArgs(expectedArg, messageArg);

    try {
        fn();
    } catch (err) {
        if (expectedMatches(err, expected)) {
            innerFail({
                actual: err,
                expected,
                message: message || `Got unwanted exception.\n${err && err.message}`,
                operator: 'doesNotThrow',
                stackStartFn: doesNotThrow
            });
        }

        throw err;
    }
};

assert.rejects = async function rejects(promiseOrFn, expectedArg, messageArg) {
    const { expected, message } = normalizeThrowsArgs(expectedArg, messageArg);
    let threw = false;
    let caught;

    try {
        await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
    } catch (err) {
        threw = true;
        caught = err;
    }

    if (!threw) {
        innerFail({
            actual: undefined,
            expected,
            message: message || 'Missing expected rejection.',
            operator: 'rejects',
            stackStartFn: rejects
        });
    }

    if (!expectedMatches(caught, expected)) {
        throw caught;
    }
};

assert.doesNotReject = async function doesNotReject(promiseOrFn, expectedArg, messageArg) {
    const { expected, message } = normalizeThrowsArgs(expectedArg, messageArg);

    try {
        await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
    } catch (err) {
        innerFail({
            actual: err,
            expected,
            message: message || `Got unwanted rejection.\n${err && err.message}`,
            operator: 'doesNotReject',
            stackStartFn: doesNotReject
        });
    }
};

assert.ifError = function ifError(value) {
    if (value !== null && value !== undefined) {
        innerFail({
            actual: value,
            expected: null,
            message: `ifError got unwanted exception: ${value && value.message ? value.message : value}`,
            operator: 'ifError',
            stackStartFn: ifError
        });
    }
};

assert.match = function match(string, regexp, message) {
    if (!regexp.test(string)) {
        innerFail({
            actual: string,
            expected: regexp,
            message: message || `The input did not match the regular expression ${regexp}.`,
            operator: 'match',
            stackStartFn: match
        });
    }
};

assert.doesNotMatch = function doesNotMatch(string, regexp, message) {
    if (regexp.test(string)) {
        innerFail({
            actual: string,
            expected: regexp,
            message: message || `The input was expected to not match the regular expression ${regexp}.`,
            operator: 'doesNotMatch',
            stackStartFn: doesNotMatch
        });
    }
};

// assert.strict: the same namespace with the loose comparisons aliased to the
// strict ones, so `require('assert').strict.equal` is strictEqual.
const strict = Object.assign(function strictAssert(value, message) {
    ok(value, message);
}, assert, {
    equal: assert.strictEqual,
    notEqual: assert.notStrictEqual,
    deepEqual: assert.deepStrictEqual,
    notDeepEqual: assert.notDeepStrictEqual
});

strict.strict = strict;
assert.strict = strict;

module.exports = assert;
