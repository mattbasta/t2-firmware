// Tessel 2 runtime — JS bootstrap.
//
// This is the program the runtime starts in, in place of txiki's CLI bundle;
// runtime/src/main.c hands it to TJS_Run through the entrypoint override the
// fork adds. What lives here now is the node-shaped command line and the
// CommonJS wrapper. The loader, process, Buffer and the core modules arrive in
// the steps after this one — see runtime/docs/phase1-plan.md §4.

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

function runScript(scriptPath) {
    const filename = native.realpathSync(scriptPath);
    const dirname = dirnameOf(filename);
    const source = stripShebang(native.readFileSync(filename));

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

function main() {
    const args = tjs.args.slice(1);

    if (args.length === 0) {
        // The REPL is Phase 4; until then, no arguments is a usage error.
        console.error(HELP);
        tjs.exit(1);

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
                tjs.exit(1);

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
                tjs.exit(1);

                return;
            }

            runScript(arg === '--' ? args[1] : arg);
    }
}

try {
    main();
} catch (e) {
    // Until process.on('uncaughtException') exists, this is the backstop.
    console.error(e);
    tjs.exit(1);
}
