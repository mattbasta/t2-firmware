// Tessel 2 runtime — JS bootstrap.
//
// This is the program the runtime starts in, in place of txiki's CLI bundle;
// runtime/src/main.c hands it to TJS_Run through the entrypoint override the
// fork adds. It installs the Node globals and runs the command line. The
// CommonJS loader and the core modules arrive in the steps after this one —
// see runtime/docs/phase1-plan.md §4.

import { Buffer, SlowBuffer } from './buffer.js';
import { createProcess, drainTicks, handleUncaught } from './process.js';

const native = globalThis.__t2native;

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

// POSIX-only, and temporary: it goes away when the loader wires up node:path,
// which is Node's own implementation and already compiled into the binary.
function dirnameOf(p) {
    const i = p.lastIndexOf('/');

    if (i < 0) {
        return '.';
    }

    return i === 0 ? '/' : p.slice(0, i);
}

// Node strips a leading #! line. Blanking it in place rather than removing the
// line keeps every subsequent line number honest in stack traces.
function stripShebang(source) {
    return source.startsWith('#!') ? source.replace(/^#![^\n]*/, '') : source;
}

// The wrapper Node has used since 0.x. Compiling it as a classic script is the
// whole reason evalScript exists — the filename passed here is what shows up in
// stack traces.
const WRAPPER_HEAD = '(function (exports, require, module, __filename, __dirname) {';
const WRAPPER_TAIL = '\n});';

function require(specifier) {
    const err = new Error(
        `Cannot find module '${specifier}' — the CommonJS loader is not wired up yet ` +
        `(Phase 1, step 3; see runtime/docs/phase1-plan.md)`
    );

    err.code = 'MODULE_NOT_FOUND';

    throw err;
}

require.cache = Object.create(null);

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

    // GLOBAL and root were removed in Node 12; era code still reaches for them.
    globalThis.GLOBAL = globalThis;
    globalThis.root = globalThis;
}

function runScript(scriptPath, scriptArgs) {
    const filename = native.realpathSync(scriptPath);
    const dirname = dirnameOf(filename);
    const source = stripShebang(native.readFileSync(filename));

    // Node's argv for a script run: [execPath, resolvedScript, ...scriptArgs].
    process.argv = [process.execPath, filename, ...scriptArgs];

    const wrapper = native.evalScript(WRAPPER_HEAD + source + WRAPPER_TAIL, filename);

    const module = {
        id: '.',
        filename,
        path: dirname,
        exports: {},
        loaded: false,
        children: [],
        parent: null
    };

    wrapper.call(module.exports, module.exports, require, module, filename, dirname);
    module.loaded = true;

    return module;
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

function main() {
    const args = tjs.args.slice(1);

    installGlobals();
    installProcess([tjs.exePath, ...args]);

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

            const result = native.evalScript(args[1], '[eval]');

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
