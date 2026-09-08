// util
//
// Written rather than harvested. The npm `util` package is a browserify shim
// frozen around Node 8 and missing most of what era code touches; modern Node's
// own util is built on internal/errors, internal/validators and primordials, so
// harvesting it would mean dragging in a private module tree. This targets the
// documented surface instead.
//
// Includes the is* family Node removed in v23. Era code calls those constantly
// and they cost a few lines, so restoring them is the cheapest compatibility
// win available (strategy §2.3).

'use strict';

const kCustomInspect = Symbol.for('nodejs.util.inspect.custom');
const kPromisify = Symbol.for('nodejs.util.promisify.custom');

function isObject(value) {
    return value !== null && typeof value === 'object';
}

// --- inspect ----------------------------------------------------------------

function quoteString(value) {
    const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t')
        .replace(/\r/g, '\\r');

    return escaped.includes("'") && !escaped.includes('"')
        ? `"${escaped}"`
        : `'${escaped.replace(/'/g, "\\'")}'`;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function inspect(value, options = {}) {
    const opts = typeof options === 'boolean' ? { showHidden: options } : options;
    const depth = opts.depth === undefined ? 2 : opts.depth;

    return format(value, depth, new Set());

    function format(val, remaining, seen) {
        if (typeof val === 'string') {
            return quoteString(val);
        }

        if (typeof val === 'bigint') {
            return `${val}n`;
        }

        if (typeof val === 'symbol' || typeof val === 'boolean' || typeof val === 'undefined') {
            return String(val);
        }

        if (typeof val === 'number') {
            // Node prints negative zero distinguishably; String() does not.
            return Object.is(val, -0) ? '-0' : String(val);
        }

        if (val === null) {
            return 'null';
        }

        if (typeof val === 'function') {
            const name = val.name ? `: ${val.name}` : ' (anonymous)';

            return `[Function${name}]`;
        }

        if (seen.has(val)) {
            return '[Circular *1]';
        }

        if (val instanceof Date) {
            return isNaN(val.getTime()) ? 'Invalid Date' : val.toISOString();
        }

        if (val instanceof RegExp) {
            return String(val);
        }

        if (val instanceof Error) {
            return val.stack || `${val.name}: ${val.message}`;
        }

        if (typeof val[kCustomInspect] === 'function') {
            return String(val[kCustomInspect](remaining, opts));
        }

        if (remaining < 0) {
            return Array.isArray(val) ? '[Array]' : '[Object]';
        }

        seen.add(val);

        try {
            return formatObject(val, remaining, seen);
        } finally {
            seen.delete(val);
        }
    }

    function formatObject(val, remaining, seen) {
        const next = remaining - 1;

        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(val)) {
            const shown = [...val.subarray(0, 50)].map(b => b.toString(16).padStart(2, '0'));
            const more = val.length > 50 ? ` ... ${val.length - 50} more bytes` : '';

            return `<Buffer ${shown.join(' ')}${more}>`;
        }

        if (Array.isArray(val)) {
            return `[ ${val.map(entry => format(entry, next, seen)).join(', ')} ]`
                .replace('[  ]', '[]');
        }

        if (ArrayBuffer.isView(val)) {
            return `${val.constructor.name}(${val.length}) [ ${[...val].join(', ')} ]`;
        }

        if (val instanceof Map) {
            const entries = [...val].map(([k, v]) => `${format(k, next, seen)} => ${format(v, next, seen)}`);

            return `Map(${val.size}) {${entries.length ? ` ${entries.join(', ')} ` : ''}}`;
        }

        if (val instanceof Set) {
            const entries = [...val].map(entry => format(entry, next, seen));

            return `Set(${val.size}) {${entries.length ? ` ${entries.join(', ')} ` : ''}}`;
        }

        if (typeof Promise !== 'undefined' && val instanceof Promise) {
            return 'Promise { <pending> }';
        }

        const keys = opts.showHidden ? Object.getOwnPropertyNames(val) : Object.keys(val);
        const parts = keys.map(key => {
            const shown = IDENTIFIER.test(key) ? key : quoteString(key);

            let entry;

            try {
                entry = format(val[key], next, seen);
            } catch {
                entry = '[Getter/Setter]';
            }

            return `${shown}: ${entry}`;
        });

        const prototype = Object.getPrototypeOf(val);
        const name = prototype === null
            ? '[Object: null prototype] '
            : (prototype.constructor && prototype.constructor.name !== 'Object'
                ? `${prototype.constructor.name} `
                : '');

        return parts.length === 0 ? `${name}{}` : `${name}{ ${parts.join(', ')} }`;
    }
}

inspect.custom = kCustomInspect;

// --- format -----------------------------------------------------------------

function format(...args) {
    if (typeof args[0] !== 'string') {
        return args.map(arg => (typeof arg === 'string' ? arg : inspect(arg))).join(' ');
    }

    const template = args[0];
    let index = 1;

    const formatted = template.replace(/%[sdifjoOc%]/g, token => {
        if (token === '%%') {
            return '%';
        }

        if (index >= args.length) {
            return token;
        }

        const arg = args[index++];

        switch (token) {
            case '%s':
                return typeof arg === 'object' && arg !== null ? inspect(arg, { depth: 0 }) : String(arg);
            case '%d':
                return typeof arg === 'bigint' ? `${arg}n` : String(Number(arg));
            case '%i':
                return typeof arg === 'bigint' ? `${arg}n` : String(parseInt(arg, 10));
            case '%f':
                return String(parseFloat(arg));
            case '%j':
                try {
                    return JSON.stringify(arg);
                } catch {
                    return '[Circular]';
                }
            case '%o':
                return inspect(arg, { showHidden: true, depth: 4 });
            case '%O':
                return inspect(arg);
            case '%c':
                // CSS directive: consumed and ignored, as it is off-browser.
                return '';
            default:
                return token;
        }
    });

    const rest = args.slice(index).map(arg => (typeof arg === 'string' ? arg : inspect(arg)));

    return rest.length ? `${formatted} ${rest.join(' ')}` : formatted;
}

// --- callbacks and promises -------------------------------------------------

function promisify(original) {
    if (typeof original !== 'function') {
        const err = new TypeError('The "original" argument must be of type function');

        err.code = 'ERR_INVALID_ARG_TYPE';

        throw err;
    }

    if (original[kPromisify]) {
        return original[kPromisify];
    }

    function promisified(...args) {
        return new Promise((resolve, reject) => {
            original.call(this, ...args, (err, ...values) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(values[0]);
                }
            });
        });
    }

    Object.setPrototypeOf(promisified, Object.getPrototypeOf(original));
    Object.defineProperty(promisified, 'name', { value: original.name, configurable: true });

    return promisified;
}

promisify.custom = kPromisify;

function callbackify(original) {
    if (typeof original !== 'function') {
        const err = new TypeError('The "original" argument must be of type function');

        err.code = 'ERR_INVALID_ARG_TYPE';

        throw err;
    }

    function callbackified(...args) {
        const callback = args.pop();

        Promise.resolve(original.apply(this, args)).then(
            value => process.nextTick(callback, null, value),
            // Node guarantees a falsy-safe reason, so null rejections still
            // reach the callback as an error.
            reason => process.nextTick(callback, reason || new Error('Promise was rejected with a falsy value'))
        );
    }

    Object.defineProperty(callbackified, 'name', { value: original.name, configurable: true });

    return callbackified;
}

function inherits(ctor, superCtor) {
    Object.defineProperty(ctor, 'super_', {
        value: superCtor,
        writable: true,
        configurable: true
    });
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

function deprecate(fn, message, code) {
    let warned = false;

    return function deprecated(...args) {
        if (!warned) {
            warned = true;

            if (typeof process !== 'undefined' && process.emitWarning) {
                process.emitWarning(code ? `[${code}] ${message}` : message);
            } else {
                console.error(message);
            }
        }

        return fn.apply(this, args);
    };
}

// --- types ------------------------------------------------------------------

const types = {
    isDate: value => value instanceof Date,
    isRegExp: value => value instanceof RegExp,
    isMap: value => value instanceof Map,
    isSet: value => value instanceof Set,
    isPromise: value => value instanceof Promise,
    isNativeError: value => value instanceof Error,
    isTypedArray: value => ArrayBuffer.isView(value) && !(value instanceof DataView),
    isArrayBuffer: value => value instanceof ArrayBuffer,
    isDataView: value => value instanceof DataView,
    isAsyncFunction: value => typeof value === 'function' &&
        value.constructor && value.constructor.name === 'AsyncFunction',
    isGeneratorFunction: value => typeof value === 'function' &&
        value.constructor && value.constructor.name === 'GeneratorFunction'
};

// --- the is* family Node removed in v23 -------------------------------------
//
// Deliberately restored. Era packages call these on every other line, and they
// are the single largest source of "modern Node broke my old dependency".

const legacyTypeChecks = {
    isArray: Array.isArray,
    isBoolean: value => typeof value === 'boolean',
    isBuffer: value => (typeof Buffer !== 'undefined' ? Buffer.isBuffer(value) : false),
    isDate: value => value instanceof Date,
    isError: value => value instanceof Error,
    isFunction: value => typeof value === 'function',
    isNull: value => value === null,
    isNullOrUndefined: value => value === null || value === undefined,
    isNumber: value => typeof value === 'number',
    isObject: value => isObject(value) && !Array.isArray(value),
    isPrimitive: value => value === null || (typeof value !== 'object' && typeof value !== 'function'),
    isRegExp: value => value instanceof RegExp,
    isString: value => typeof value === 'string',
    isSymbol: value => typeof value === 'symbol',
    isUndefined: value => value === undefined
};

// assert owns the comparison rules; requiring it lazily rather than at the top
// of the file keeps the two modules from forming a load-order cycle.
function isDeepStrictEqual(a, b) {
    try {
        require('assert').deepStrictEqual(a, b);

        return true;
    } catch {
        return false;
    }
}

module.exports = {
    format,
    // Options are accepted and ignored: the only ones that matter here are
    // inspect's, and format() already delegates to inspect for object arguments.
    formatWithOptions: (options, ...args) => format(...args),
    inspect,
    promisify,
    callbackify,
    inherits,
    deprecate,
    types,
    isDeepStrictEqual,
    TextEncoder,
    TextDecoder,
    ...legacyTypeChecks,

    // Removed from Node in v12-v14; harmless to keep, and old code calls them.
    print: (...args) => process.stdout.write(args.join('')),
    puts: (...args) => process.stdout.write(`${args.join('')}\n`),
    debug: message => process.stderr.write(`DEBUG: ${message}\n`),
    error: (...args) => process.stderr.write(`${args.join('')}\n`),
    log: message => console.log(message)
};
