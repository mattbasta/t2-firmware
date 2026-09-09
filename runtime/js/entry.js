// Tessel 2 runtime — JS bootstrap.
//
// This is the program the runtime starts in, in place of txiki's CLI bundle;
// runtime/src/main.c hands it to TJS_Run through the entrypoint override the
// fork adds. It installs the Node globals and runs the command line. The
// CommonJS loader and the core modules arrive in the steps after this one —
// see runtime/docs/phase1-plan.md §4.

import nodePath from 'tjs:path';

import { Buffer, SlowBuffer, kMaxLength } from './buffer.js';
import { Module, coreModuleNames, defineCore, defineLazyCore, definePending, makeRequire, runMain, setNative } from './module.js';
import { createProcess, drainTicks, handleUncaught } from './process.js';

const native = globalThis.__t2native;

function resolveValue(value) {
    return typeof value === 'function' ? value() : value;
}

// Bootstrap-only. User code must never reach the raw primitives.
delete globalThis.__t2native;

const VERSION = '0.1.0-dev';

const HELP = `Usage: node [options] [script.js] [arguments]

Options:
  -e, --eval SCRIPT     evaluate SCRIPT
  -p, --print SCRIPT    evaluate SCRIPT and print the result
  -v, --version         print version information
  -h, --help            print this message
`;

// Core modules that exist today. Everything else the era expects is registered
// below as pending, so `require('fs')` says when it is coming rather than
// claiming the module does not exist.
function registerCoreModules() {
    defineCore('path', nodePath);
    defineCore('buffer', { Buffer, SlowBuffer, kMaxLength, constants: { MAX_LENGTH: kMaxLength } });
    defineCore('module', Module);
    defineCore('console', console);
    defineCore('timers', {
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        setImmediate,
        clearImmediate
    });

    // Everything under runtime/js/node/ is available by name, but stays as
    // undeserialized bytecode until required.
    for (const name of native.coreModuleNames()) {
        defineLazyCore(name);
    }

    Module.builtinModules = coreModuleNames();

    const implemented = new Set(Module.builtinModules);

    const pending = [
        { phase: 'Phase 1', doc: 'runtime/docs/phase1-plan.md',
            names: ['events', 'util', 'assert', 'querystring', 'string_decoder', 'url', 'stream'] },
        { phase: 'Phase 2', doc: 'runtime/docs/phase2-plan.md',
            names: ['fs', 'net', 'child_process', 'os', 'tty', 'dns', 'constants'] },
        { phase: 'Phase 3', doc: 'the strategy document',
            names: ['http', 'https', 'crypto', 'zlib', 'dgram', 'tls'] }
    ];

    for (const { phase, doc, names } of pending) {
        for (const name of names) {
            if (implemented.has(name)) {
                continue;
            }

            definePending(
                name,
                `Cannot find module '${name}': it is a core module this runtime has not ` +
                `implemented yet — planned for ${phase}. See ${doc}.`
            );
        }
    }
}

// Omissions are stubs, not absences. A library that reaches for something this
// runtime does not implement should be told what it hit and where it is written
// down — "fs.watch is not a function" sends the reader looking for a typo.
//
// The throw is the signal; the one-time log exists because code that swallows
// the error would otherwise leave no trace at all. Once per name, not per call,
// so a retry loop cannot turn it into a flood.
const reportedOmissions = new Set();

function omitted(subject, reason) {
    return function () {
        const err = new Error(
            `${subject} is not implemented by this runtime` +
            (reason ? `: ${reason}` : '') +
            '. See runtime/docs/omissions.md.'
        );

        err.code = 'ERR_NOT_IMPLEMENTED';

        if (!reportedOmissions.has(subject)) {
            reportedOmissions.add(subject);
            console.error(err.stack);
        }

        throw err;
    };
}

function installGlobals() {
    Object.defineProperty(globalThis, 'Buffer', {
        value: Buffer,
        writable: true,
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(globalThis, 'SlowBuffer', {
        value: SlowBuffer,
        writable: true,
        enumerable: false,
        configurable: true
    });

    // txiki has no setImmediate. Node runs it in the loop's check phase; a zero
    // timeout is the nearest thing available here, which means it lands after
    // pending I/O callbacks rather than before some of them. Revisit if the
    // difference ever bites — a uv_check handle would be exact.
    if (typeof globalThis.setImmediate !== 'function') {
        globalThis.setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
        globalThis.clearImmediate = handle => clearTimeout(handle);
    }

    // `global` is current Node and used everywhere; GLOBAL and root were removed
    // in Node 12 and era code still reaches for them.
    globalThis.global = globalThis;
    globalThis.GLOBAL = globalThis;
    globalThis.root = globalThis;
}

function runScript(scriptPath, scriptArgs) {
    // Node's argv for a script run: [execPath, resolvedScript, ...scriptArgs].
    const filename = native.realpathSync(scriptPath);

    process.argv = [process.execPath, filename, ...scriptArgs];

    return runMain(filename, main => {
        process.mainModule = main;
    });
}

let process;

function installProcess(argv) {
    process = createProcess(native, argv);

    Object.defineProperty(globalThis, 'process', {
        value: process,
        writable: true,
        enumerable: false,
        configurable: true
    });

    return process;
}

// Node gives -e/-p a `require` resolved against the working directory. These go
// on the global rather than through the CommonJS wrapper on purpose: a wrapper
// function's body has no completion value, and the completion value is the
// entire point of -p.
function evalWithRequire(code) {
    const dir = process.cwd();
    const filename = nodePath.join(dir, '[eval]');
    const module = new Module(filename, null);

    module.filename = filename;
    module.path = dir;

    globalThis.require = makeRequire(module);
    globalThis.module = module;
    globalThis.exports = module.exports;
    globalThis.__filename = filename;
    globalThis.__dirname = dir;

    return native.evalScript(code, '[eval]');
}

function main() {
    const args = tjs.args.slice(1);

    installGlobals();
    installProcess([resolveValue(tjs.exePath), ...args]);

    // An allowlist, not the raw __t2native: this object is also what core
    // modules receive as their sixth wrapper argument (runtime/js/module.js),
    // so anything added here becomes reachable from node:fs and its successors.
    setNative({
        evalScript: native.evalScript,
        readFileSync: native.readFileSync,
        realpathSync: native.realpathSync,
        pathKind: native.pathKind,
        loadCoreModule: native.loadCoreModule,
        fs: native.fs,
        net: native.net,
        constants: native.constants,
        handleUncaught,
        omitted,
        cwd: () => process.cwd()
    });
    registerCoreModules();

    if (args.length === 0) {
        // The REPL is Phase 4; until then, no arguments is a usage error.
        console.error(HELP);
        process.exit(1);

        return;
    }

    const arg = args[0];

    switch (arg) {
        case '-v':
        case '--version':
            console.log(`v${VERSION} (quickjs-ng via txiki ${tjs.version})`);

            return;

        case '-h':
        case '--help':
            console.log(HELP);

            return;

        case '-e':
        case '--eval':
        case '-p':
        case '--print': {
            if (args.length < 2) {
                console.error(`node: ${arg} requires an argument`);
                process.exit(1);

                return;
            }

            const result = evalWithRequire(args[1]);

            if (arg === '-p' || arg === '--print') {
                console.log(result);
            }

            return;
        }

        default:
            if (arg.startsWith('-') && arg !== '--') {
                console.error(`node: bad option: ${arg}`);
                process.exit(1);

                return;
            }

            if (arg === '--') {
                runScript(args[1], args.slice(2));
            } else {
                runScript(arg, args.slice(1));
            }
    }
}

try {
    main();

    // Node drains microtasks when the main script returns, before the first
    // timer; libuv would run an already-due timer first. Ticks go before promise
    // jobs because Node's nextTick queue always does, whatever order they were
    // registered in.
    drainTicks();
    native.runMicrotasks();
} catch (err) {
    handleUncaught(err);
}
