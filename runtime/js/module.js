// The CommonJS loader.
//
// Node's resolution algorithm as specified, plus `exports` maps, because users
// will install packages published well after 2018. What it deliberately does not
// do is ESM: `import` is Phase 4, and the two loaders will meet there.
//
// `path` here is Node's own path module — txiki vendors it verbatim from Node
// (deps/txiki.js/src/js/core/path.js), so the loader gets the exact join,
// dirname and extname semantics the algorithm assumes, already in the binary.

import nodePath from 'tjs:path';

let native = null;

// name -> exports, for core modules that exist
const CORE = new Map();

// name -> message, for core modules that are coming but are not here yet. Worth
// separating from "not found": "fs is not implemented yet" is a very different
// thing for a user to read than "cannot find module fs".
const PENDING = new Map();

export function setNative(api) {
    native = api;
}

export function defineCore(name, exports) {
    CORE.set(name, exports);
}

export function definePending(name, message) {
    PENDING.set(name, message);
}

// Core modules that ship as their own bytecode blobs (runtime/js/node/). Only
// the names are known up front — nothing is deserialized until something
// actually requires the module, which is what keeps the standard library off
// the startup path.
const LAZY = new Set();
const LAZY_MODULES = new Map();

export function defineLazyCore(name) {
    LAZY.add(name);
}

export function coreModuleNames() {
    return [...CORE.keys(), ...LAZY].sort();
}

function isCore(name) {
    return CORE.has(name) || LAZY.has(name);
}

function loadCore(name) {
    if (CORE.has(name)) {
        return CORE.get(name);
    }

    const existing = LAZY_MODULES.get(name);

    if (existing) {
        return existing.exports;
    }

    const wrapper = native.loadCoreModule(name);

    if (!wrapper) {
        return undefined;
    }

    const module = new Module(name, null);

    module.filename = name;
    module.path = '';
    module.paths = [];

    // Registered before the body runs, so a cycle between core modules
    // terminates the same way one between files on disk does.
    LAZY_MODULES.set(name, module);

    // Core modules get one extra wrapper argument that user modules do not:
    // __native. node:fs and everything after it in Phase 2 is a thin JS shell
    // over the primitives in runtime/src, and the bootstrap deletes
    // globalThis.__t2native before any user code runs — so this is the only
    // channel, and it reaches nothing that did not ship inside the binary. The
    // matching signature is in runtime/scripts/build-js.sh; WRAPPER_HEAD below,
    // which is what files on disk get, deliberately stays at five.
    wrapper.call(module.exports, module.exports, makeRequire(module), module, name, '', native);
    module.loaded = true;

    return module.exports;
}

function stripShebang(source) {
    return source.startsWith('#!') ? source.replace(/^#![^\n]*/, '') : source;
}

const WRAPPER_HEAD = '(function (exports, require, module, __filename, __dirname) {';
const WRAPPER_TAIL = '\n});';

function moduleNotFound(request, parent) {
    let message = `Cannot find module '${request}'`;

    if (parent && parent.filename) {
        message += `\nRequire stack:\n- ${parent.filename}`;
    }

    const err = new Error(message);

    err.code = 'MODULE_NOT_FOUND';

    return err;
}

// --- resolution -------------------------------------------------------------

const FILE_EXTENSIONS = ['', '.js', '.json', '.node'];
const INDEX_EXTENSIONS = ['.js', '.json', '.node'];

function loadAsFile(base) {
    for (const ext of FILE_EXTENSIONS) {
        const candidate = base + ext;

        if (native.pathKind(candidate) === 'file') {
            return candidate;
        }
    }

    return null;
}

function loadIndex(dir) {
    for (const ext of INDEX_EXTENSIONS) {
        const candidate = nodePath.join(dir, `index${ext}`);

        if (native.pathKind(candidate) === 'file') {
            return candidate;
        }
    }

    return null;
}

function readPackage(dir) {
    const pkgPath = nodePath.join(dir, 'package.json');

    if (native.pathKind(pkgPath) !== 'file') {
        return null;
    }

    try {
        return JSON.parse(native.readFileSync(pkgPath));
    } catch (err) {
        err.message = `${pkgPath}: ${err.message}`;

        throw err;
    }
}

// We are always the "require" condition, never "import". "node" before
// "default" matches what every bundler and Node itself do.
const CONDITIONS = ['require', 'node', 'default'];

function resolveConditional(value) {
    if (typeof value === 'string') {
        return value;
    }

    if (Array.isArray(value)) {
        for (const entry of value) {
            const resolved = resolveConditional(entry);

            if (resolved) {
                return resolved;
            }
        }

        return null;
    }

    if (value && typeof value === 'object') {
        for (const condition of CONDITIONS) {
            if (condition in value) {
                const resolved = resolveConditional(value[condition]);

                if (resolved) {
                    return resolved;
                }
            }
        }
    }

    return null;
}

function resolveExports(exports, subpath) {
    if (typeof exports === 'string' || Array.isArray(exports)) {
        return subpath === '.' ? resolveConditional(exports) : null;
    }

    if (!exports || typeof exports !== 'object') {
        return null;
    }

    const keys = Object.keys(exports);
    const hasSubpaths = keys.some(key => key === '.' || key.startsWith('./'));

    // Sugar form: the whole object is a condition map for ".".
    if (!hasSubpaths) {
        return subpath === '.' ? resolveConditional(exports) : null;
    }

    if (Object.prototype.hasOwnProperty.call(exports, subpath)) {
        return resolveConditional(exports[subpath]);
    }

    // Pattern form: "./lib/*": "./src/*.js"
    for (const key of keys) {
        const star = key.indexOf('*');

        if (star === -1) {
            continue;
        }

        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);

        if (subpath.length >= prefix.length + suffix.length &&
            subpath.startsWith(prefix) &&
            subpath.endsWith(suffix)) {
            const match = subpath.slice(prefix.length, subpath.length - suffix.length);
            const target = resolveConditional(exports[key]);

            if (target) {
                return target.split('*').join(match);
            }
        }
    }

    return null;
}

function loadAsDirectory(dir, subpath) {
    const pkg = readPackage(dir);

    if (pkg) {
        if (pkg.exports !== undefined && pkg.exports !== null) {
            const target = resolveExports(pkg.exports, subpath ?? '.');

            // An "exports" map is a gate, not a hint: if it does not name the
            // subpath, the file is not reachable, even if it exists on disk.
            if (!target) {
                return null;
            }

            const resolved = nodePath.join(dir, target);

            return loadAsFile(resolved) ?? loadIndex(resolved);
        }

        if (subpath && subpath !== '.') {
            const resolved = nodePath.join(dir, subpath);

            return loadAsFile(resolved) ?? loadAsDirectory(resolved);
        }

        if (typeof pkg.main === 'string' && pkg.main) {
            const main = nodePath.join(dir, pkg.main);
            const found = loadAsFile(main) ?? loadIndex(main);

            if (found) {
                return found;
            }
        }
    } else if (subpath && subpath !== '.') {
        const resolved = nodePath.join(dir, subpath);

        return loadAsFile(resolved) ?? loadAsDirectory(resolved);
    }

    return loadIndex(dir);
}

function nodeModulePaths(from) {
    const paths = [];
    let dir = from;

    for (;;) {
        if (nodePath.basename(dir) !== 'node_modules') {
            paths.push(nodePath.join(dir, 'node_modules'));
        }

        const parent = nodePath.dirname(dir);

        if (parent === dir) {
            break;
        }

        dir = parent;
    }

    return paths;
}

function splitBareSpecifier(request) {
    if (request.startsWith('@')) {
        const parts = request.split('/');

        return { name: parts.slice(0, 2).join('/'), subpath: parts.slice(2).join('/') };
    }

    const slash = request.indexOf('/');

    if (slash === -1) {
        return { name: request, subpath: '' };
    }

    return { name: request.slice(0, slash), subpath: request.slice(slash + 1) };
}

function loadNodeModules(request, from) {
    const { name, subpath } = splitBareSpecifier(request);

    for (const base of nodeModulePaths(from)) {
        const dir = nodePath.join(base, name);

        if (native.pathKind(dir) !== 'dir') {
            continue;
        }

        const found = loadAsDirectory(dir, subpath ? `./${subpath}` : '.');

        if (found) {
            return found;
        }
    }

    return null;
}

function isPathRequest(request) {
    return request === '.' ||
        request === '..' ||
        request.startsWith('./') ||
        request.startsWith('../') ||
        request.startsWith('/');
}

// --- Module -----------------------------------------------------------------

class Module {
    constructor(id, parent) {
        this.id = id;
        this.filename = null;
        this.path = null;
        this.exports = {};
        this.parent = parent ?? null;
        this.loaded = false;
        this.children = [];
        this.paths = [];
    }

    require(request) {
        return Module._load(request, this);
    }

    load(filename) {
        const ext = nodePath.extname(filename);
        const handler = Module._extensions[ext] ?? Module._extensions['.js'];

        handler(this, filename);
        this.loaded = true;
    }

    _compile(source, filename) {
        const wrapper = native.evalScript(WRAPPER_HEAD + stripShebang(source) + WRAPPER_TAIL, filename);

        wrapper.call(
            this.exports,
            this.exports,
            makeRequire(this),
            this,
            filename,
            nodePath.dirname(filename)
        );
    }

    static _resolveFilename(request, parent) {
        const bare = request.startsWith('node:') ? request.slice(5) : request;

        if (isCore(bare) || PENDING.has(bare)) {
            return bare;
        }

        const from = parent && parent.path ? parent.path : (native.cwd ? native.cwd() : '.');
        const found = isPathRequest(request)
            ? (() => {
                const base = nodePath.resolve(from, request);

                return loadAsFile(base) ?? loadAsDirectory(base);
            })()
            : loadNodeModules(request, from);

        if (!found) {
            throw moduleNotFound(request, parent);
        }

        // Node canonicalizes by default, and require.cache is keyed on the
        // result — without this a module reached through a symlink loads twice.
        try {
            return native.realpathSync(found);
        } catch {
            return found;
        }
    }

    static _load(request, parent) {
        const bare = request.startsWith('node:') ? request.slice(5) : request;

        if (isCore(bare)) {
            return loadCore(bare);
        }

        if (PENDING.has(bare)) {
            const err = new Error(PENDING.get(bare));

            err.code = 'ERR_MODULE_NOT_IMPLEMENTED';

            throw err;
        }

        const filename = Module._resolveFilename(request, parent);
        const cached = Module._cache[filename];

        if (cached) {
            return cached.exports;
        }

        const module = new Module(filename, parent);

        module.filename = filename;
        module.path = nodePath.dirname(filename);
        module.paths = nodeModulePaths(module.path);

        // Cached *before* evaluation. This one line is what makes circular
        // requires terminate: the cycle gets the partially-filled exports object
        // rather than recursing forever.
        Module._cache[filename] = module;

        if (parent) {
            parent.children.push(module);
        }

        let loaded = false;

        try {
            module.load(filename);
            loaded = true;
        } finally {
            if (!loaded) {
                delete Module._cache[filename];
            }
        }

        return module.exports;
    }
}

Module._cache = Object.create(null);
Module._main = null;

Module._extensions = {
    '.js'(module, filename) {
        module._compile(native.readFileSync(filename), filename);
    },

    '.json'(module, filename) {
        try {
            module.exports = JSON.parse(native.readFileSync(filename));
        } catch (err) {
            err.message = `${filename}: ${err.message}`;

            throw err;
        }
    },

    '.node'(module, filename) {
        // A stated non-goal, so it fails clearly rather than mysteriously.
        const err = new Error(
            `Cannot load native addon '${filename}': this runtime has no native addon support. ` +
            `Packages needing a .node binary must be replaced with a JavaScript implementation.`
        );

        err.code = 'ERR_DLOPEN_DISABLED';

        throw err;
    }
};

function makeRequire(module) {
    const require = request => Module._load(request, module);

    require.cache = Module._cache;
    require.extensions = Module._extensions;
    require.main = Module._main;

    require.resolve = request => Module._resolveFilename(request, module);
    require.resolve.paths = request =>
        (isPathRequest(request) ? null : nodeModulePaths(module.path));

    return require;
}

// Loads the program named on the command line as the main module.
//
// beforeLoad runs after the module exists and is registered but before its code
// executes, which is when Node has already published process.mainModule — a
// script that reads it at load time must see itself.
export function runMain(scriptPath, beforeLoad) {
    const filename = native.realpathSync(scriptPath);
    const module = new Module(filename, null);

    // Node names the entry module '.', not its path.
    module.id = '.';
    module.filename = filename;
    module.path = nodePath.dirname(filename);
    module.paths = nodeModulePaths(module.path);

    Module._main = module;
    Module._cache[filename] = module;

    if (beforeLoad) {
        beforeLoad(module);
    }

    module.load(filename);

    return module;
}

export { Module, makeRequire, nodeModulePaths };
