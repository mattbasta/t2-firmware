// node:fs — all three surfaces.
//
// A thin shell over the uv_fs_* primitives in runtime/src/fs.c. Everything that
// is shaping rather than syscall lives here: flag strings, encodings, Stats and
// Dirent, recursive mkdir and rm, and the argument coercions Node performs
// before it reaches the kernel.
//
// All three halves land on one set of primitives, because uv_fs_* is one API
// with a switch: hand it a callback and the work runs on libuv's threadpool,
// hand it none and it runs inline. So the callback layer here is genuinely
// asynchronous rather than a synchronous call hidden behind setImmediate, which
// on a 580 MHz core with slow flash would stall the loop on every read; and
// fs.promises is a wrapper over the callback layer, as it is in Node.

'use strict';

const { Buffer } = require('buffer');
const pathModule = require('path');

const binding = __native.fs;
const constants = binding.constants;

// --- errors -----------------------------------------------------------------

// The primitives throw Node-shaped errors already (code, errno, syscall, path).
// These are the ones raised before we reach a syscall at all.
function invalidArg(name, expected, actual) {
    const err = new TypeError(
        `The "${name}" argument must be of type ${expected}. Received ${typeof actual}`
    );

    err.code = 'ERR_INVALID_ARG_TYPE';

    return err;
}

function nodeError(code, message, syscall, path) {
    const err = new Error(`${code}: ${message}, ${syscall} '${path}'`);

    err.code = code;
    err.syscall = syscall;
    err.path = path;

    return err;
}

// --- argument coercion ------------------------------------------------------

function getPath(value, name = 'path') {
    if (typeof value === 'string') {
        return value;
    }

    // Node accepts a file: URL here too.
    if (typeof URL !== 'undefined' && value instanceof URL) {
        if (value.protocol !== 'file:') {
            const err = new TypeError('The URL must be of scheme file');

            err.code = 'ERR_INVALID_URL_SCHEME';

            throw err;
        }

        return decodeURIComponent(value.pathname);
    }

    if (Buffer.isBuffer(value)) {
        return value.toString('utf8');
    }

    throw invalidArg(name, 'string, Buffer, or URL', value);
}

function getOptions(options, defaults) {
    if (options === undefined || options === null) {
        return defaults;
    }

    if (typeof options === 'string') {
        return { ...defaults, encoding: options };
    }

    if (typeof options === 'object') {
        return { ...defaults, ...options };
    }

    throw invalidArg('options', 'string or Object', options);
}

// Node's stringToFlags. 'x' is O_EXCL, 's' is O_SYNC, '+' widens to read-write.
const FLAG_MAP = {
    r: constants.O_RDONLY,
    rs: constants.O_RDONLY | constants.O_SYNC,
    sr: constants.O_RDONLY | constants.O_SYNC,
    'r+': constants.O_RDWR,
    'rs+': constants.O_RDWR | constants.O_SYNC,
    'sr+': constants.O_RDWR | constants.O_SYNC,

    w: constants.O_TRUNC | constants.O_CREAT | constants.O_WRONLY,
    wx: constants.O_TRUNC | constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL,
    xw: constants.O_TRUNC | constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL,
    'w+': constants.O_TRUNC | constants.O_CREAT | constants.O_RDWR,
    'wx+': constants.O_TRUNC | constants.O_CREAT | constants.O_RDWR | constants.O_EXCL,
    'xw+': constants.O_TRUNC | constants.O_CREAT | constants.O_RDWR | constants.O_EXCL,

    a: constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
    ax: constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL,
    xa: constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL,
    'a+': constants.O_APPEND | constants.O_CREAT | constants.O_RDWR,
    'ax+': constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_EXCL,
    'xa+': constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_EXCL
};

function stringToFlags(flags) {
    if (typeof flags === 'number') {
        return flags;
    }

    if (flags === undefined) {
        return constants.O_RDONLY;
    }

    const value = FLAG_MAP[flags];

    if (value === undefined) {
        const err = new TypeError(`Unknown file open flag: ${flags}`);

        err.code = 'ERR_INVALID_ARG_VALUE';

        throw err;
    }

    return value;
}

function getFd(value) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw invalidArg('fd', 'number', value);
    }

    return value;
}

// --- callback plumbing ------------------------------------------------------

// Every callback handed to the binding is wrapped. An exception thrown inside a
// user callback is an uncaught exception in Node — it reaches
// process.on('uncaughtException') and otherwise ends the process — and C has no
// business deciding that, so the policy stays here and reuses the bootstrap's
// own handler.
function guard(callback) {
    return function (...args) {
        try {
            callback(...args);
        } catch (err) {
            __native.handleUncaught(err);
        }
    };
}

function getCallback(callback) {
    if (typeof callback !== 'function') {
        throw invalidArg('cb', 'function', callback);
    }

    return callback;
}

// Node lets the options argument be omitted in favour of the callback.
function optionsAndCallback(options, callback, defaults) {
    if (typeof options === 'function') {
        return [defaults, getCallback(options)];
    }

    return [getOptions(options, defaults), getCallback(callback)];
}

// --- Stats ------------------------------------------------------------------

// The *Ms fields come from C; the Date mirrors are built on demand. Node makes
// four Dates per stat eagerly, which the module loader would pay for on every
// probe — and almost nothing reads them.
function defineDate(target, name, msField) {
    let cached;

    Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        get() {
            if (cached === undefined) {
                // Rounded, not truncated: Node's dateFromMs rounds, so a
                // timestamp ending .5 or above lands on the next millisecond.
                // Truncating here puts our Dates 1 ms behind Node's.
                cached = new Date(Math.round(this[msField]));
            }

            return cached;
        }
    });
}

class Stats {
    constructor(raw) {
        Object.assign(this, raw);
    }

    _checkType(type) {
        return (this.mode & constants.S_IFMT) === type;
    }

    isFile() {
        return this._checkType(constants.S_IFREG);
    }

    isDirectory() {
        return this._checkType(constants.S_IFDIR);
    }

    isCharacterDevice() {
        return this._checkType(constants.S_IFCHR);
    }

    isBlockDevice() {
        return this._checkType(constants.S_IFBLK);
    }

    isFIFO() {
        return this._checkType(constants.S_IFIFO);
    }

    isSymbolicLink() {
        return this._checkType(constants.S_IFLNK);
    }

    isSocket() {
        return this._checkType(constants.S_IFSOCK);
    }
}

defineDate(Stats.prototype, 'atime', 'atimeMs');
defineDate(Stats.prototype, 'mtime', 'mtimeMs');
defineDate(Stats.prototype, 'ctime', 'ctimeMs');
defineDate(Stats.prototype, 'birthtime', 'birthtimeMs');

// --- Dirent -----------------------------------------------------------------

// The uv_dirent_t type code, kept off the public shape: Node's Dirent exposes
// name and parentPath and nothing else enumerable.
const kDirentType = Symbol('type');

class Dirent {
    constructor(name, type, parentPath) {
        this.name = name;
        this.parentPath = parentPath;
        this.path = parentPath;
        this[kDirentType] = type;
    }

    isFile() {
        return this[kDirentType] === constants.UV_DIRENT_FILE;
    }

    isDirectory() {
        return this[kDirentType] === constants.UV_DIRENT_DIR;
    }

    isSymbolicLink() {
        return this[kDirentType] === constants.UV_DIRENT_LINK;
    }

    isFIFO() {
        return this[kDirentType] === constants.UV_DIRENT_FIFO;
    }

    isSocket() {
        return this[kDirentType] === constants.UV_DIRENT_SOCKET;
    }

    isCharacterDevice() {
        return this[kDirentType] === constants.UV_DIRENT_CHAR;
    }

    isBlockDevice() {
        return this[kDirentType] === constants.UV_DIRENT_BLOCK;
    }
}

// --- descriptors ------------------------------------------------------------

function openSync(path, flags, mode = 0o666) {
    return binding.open(getPath(path), stringToFlags(flags), mode);
}

function closeSync(fd) {
    binding.close(getFd(fd));
}

function readSync(fd, buffer, offset, length, position) {
    // Node also accepts readSync(fd, buffer, { offset, length, position }).
    if (typeof offset === 'object' && offset !== null) {
        ({ offset, length, position } = offset);
    }

    offset = offset ?? 0;
    length = length ?? buffer.byteLength - offset;
    position = position ?? -1;

    return binding.read(getFd(fd), toUint8Array(buffer), offset, length, position);
}

function writeSync(fd, data, offsetOrPosition, lengthOrEncoding, position) {
    getFd(fd);

    // writeSync(fd, string[, position[, encoding]]) is a different signature
    // from writeSync(fd, buffer[, offset[, length[, position]]]), distinguished
    // exactly as Node distinguishes them: by the type of the second argument.
    if (typeof data === 'string') {
        const encoding = lengthOrEncoding ?? 'utf8';
        const bytes = Buffer.from(data, encoding);

        return binding.write(fd, bytes, 0, bytes.length, offsetOrPosition ?? -1);
    }

    const bytes = toUint8Array(data);
    const offset = offsetOrPosition ?? 0;
    const length = lengthOrEncoding ?? bytes.byteLength - offset;

    return binding.write(fd, bytes, offset, length, position ?? -1);
}

function toUint8Array(value) {
    if (value instanceof Uint8Array) {
        return value;
    }

    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }

    throw invalidArg('buffer', 'Buffer, TypedArray, or DataView', value);
}

function fsyncSync(fd) {
    binding.fsync(getFd(fd), false);
}

function fdatasyncSync(fd) {
    binding.fsync(getFd(fd), true);
}

function ftruncateSync(fd, len = 0) {
    binding.ftruncate(getFd(fd), len);
}

// --- stat -------------------------------------------------------------------

function statSync(path, options) {
    return statImpl(binding.stat, path, options);
}

function lstatSync(path, options) {
    return statImpl(binding.lstat, path, options);
}

function statImpl(fn, path, options) {
    const { throwIfNoEntry = true } = getOptions(options, {});

    try {
        return new Stats(fn(getPath(path)));
    } catch (err) {
        // statSync's one documented non-throwing case: era code and modern code
        // both use it as an existence probe.
        if (!throwIfNoEntry && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
            return undefined;
        }

        throw err;
    }
}

function fstatSync(fd) {
    return new Stats(binding.fstat(getFd(fd)));
}

// --- whole files ------------------------------------------------------------

const CHUNK = 64 * 1024;

// Reads to EOF rather than trusting st_size. On this board that is not a corner
// case: every sysfs file — which is how tessel-export.js reads a GPIO — reports
// st_size 0 and yields its contents anyway. A size-driven read returns empty.
function readAll(fd, size) {
    if (size > 0) {
        const buf = Buffer.allocUnsafe(size);
        let read = 0;

        while (read < size) {
            const n = binding.read(fd, buf, read, size - read, -1);

            if (n === 0) {
                break;
            }

            read += n;
        }

        return read === size ? buf : buf.slice(0, read);
    }

    const chunks = [];
    let total = 0;

    for (;;) {
        const buf = Buffer.allocUnsafe(CHUNK);
        const n = binding.read(fd, buf, 0, CHUNK, -1);

        if (n === 0) {
            break;
        }

        chunks.push(n === CHUNK ? buf : buf.slice(0, n));
        total += n;
    }

    if (chunks.length === 1) {
        return chunks[0];
    }

    return Buffer.concat(chunks, total);
}

function readFileSync(path, options) {
    const { encoding, flag } = getOptions(options, { encoding: null, flag: 'r' });

    // Node accepts a raw fd here as well as a path.
    const isFd = typeof path === 'number';
    const fd = isFd ? path : openSync(path, flag);

    try {
        const stats = binding.fstat(fd);
        const size = (stats.mode & constants.S_IFMT) === constants.S_IFREG ? stats.size : 0;
        const data = readAll(fd, size);

        return encoding ? data.toString(encoding) : data;
    } finally {
        if (!isFd) {
            binding.close(fd);
        }
    }
}

function writeFileSync(path, data, options) {
    const { encoding, mode, flag } = getOptions(options, {
        encoding: 'utf8',
        mode: 0o666,
        flag: 'w'
    });

    const bytes = typeof data === 'string' ? Buffer.from(data, encoding || 'utf8') : toUint8Array(data);

    const isFd = typeof path === 'number';
    const fd = isFd ? path : openSync(path, flag, mode);

    try {
        let written = 0;

        while (written < bytes.byteLength) {
            const n = binding.write(fd, bytes, written, bytes.byteLength - written, -1);

            if (n === 0) {
                break;
            }

            written += n;
        }
    } finally {
        if (!isFd) {
            binding.close(fd);
        }
    }
}

function appendFileSync(path, data, options) {
    return writeFileSync(path, data, getOptions(options, { encoding: 'utf8', mode: 0o666, flag: 'a' }));
}

// --- directories ------------------------------------------------------------

function readdirSync(path, options) {
    const { encoding, withFileTypes } = getOptions(options, {
        encoding: 'utf8',
        withFileTypes: false
    });

    const dir = getPath(path);
    const entries = binding.readdir(dir, withFileTypes);

    if (withFileTypes) {
        return entries.map(e => new Dirent(e.name, e.type, dir));
    }

    if (encoding === 'buffer') {
        return entries.map(name => Buffer.from(name, 'utf8'));
    }

    return entries;
}

function mkdirSync(path, options) {
    const opts = typeof options === 'number' ? { mode: options } : getOptions(options, {});
    const { recursive = false, mode = 0o777 } = opts;
    const dir = getPath(path);

    if (!recursive) {
        binding.mkdir(dir, mode);

        return undefined;
    }

    // Node returns the first directory it had to create, or undefined if there
    // was nothing to do. Walking up and back down gives that for free.
    const missing = [];
    let current = pathModule.resolve(dir);

    for (;;) {
        if (binding.access(current, constants.F_OK, false)) {
            break;
        }

        missing.push(current);

        const parent = pathModule.dirname(current);

        if (parent === current) {
            break;
        }

        current = parent;
    }

    let first;

    for (let i = missing.length - 1; i >= 0; i--) {
        try {
            binding.mkdir(missing[i], mode);
            first = first ?? missing[i];
        } catch (err) {
            // Lost a race, or a component appeared underneath us. Node's
            // recursive mkdir tolerates exactly this.
            if (err.code !== 'EEXIST') {
                throw err;
            }
        }
    }

    return first;
}

function rmdirSync(path, options) {
    // `recursive` was added in Node 12, deprecated in 14 and removed in 16 in
    // favour of fs.rmSync. Era code predates it entirely, so there is nobody to
    // keep it for — and accepting it would leave us quietly more permissive
    // than the Node we are checked against.
    if (options && options.recursive !== undefined) {
        const err = new TypeError(
            `The property 'options.recursive' is no longer supported. Received ${options.recursive}`
        );

        err.code = 'ERR_INVALID_ARG_VALUE';

        throw err;
    }

    binding.rmdir(getPath(path));
}

function rmSync(path, options) {
    const { recursive = false, force = false } = getOptions(options, {});
    const target = getPath(path);

    let stats;

    try {
        stats = binding.lstat(target);
    } catch (err) {
        if (force && err.code === 'ENOENT') {
            return undefined;
        }

        throw err;
    }

    if ((stats.mode & constants.S_IFMT) === constants.S_IFDIR) {
        if (!recursive) {
            throw nodeError('ERR_FS_EISDIR', 'Path is a directory', 'rm', target);
        }

        for (const name of binding.readdir(target, false)) {
            rmSync(pathModule.join(target, name), { recursive: true, force });
        }

        binding.rmdir(target);

        return undefined;
    }

    binding.unlink(target);

    return undefined;
}

function mkdtempSync(prefix, options) {
    const { encoding } = getOptions(options, { encoding: 'utf8' });
    const result = binding.mkdtemp(`${prefix}XXXXXX`);

    return encoding === 'buffer' ? Buffer.from(result, 'utf8') : result;
}

// --- paths ------------------------------------------------------------------

function unlinkSync(path) {
    binding.unlink(getPath(path));
}

function renameSync(from, to) {
    binding.rename(getPath(from, 'oldPath'), getPath(to, 'newPath'), 0);
}

function linkSync(from, to) {
    binding.link(getPath(from, 'existingPath'), getPath(to, 'newPath'), 0);
}

function symlinkSync(target, path) {
    // The third parameter is Windows-only ('dir' | 'file' | 'junction').
    binding.symlink(getPath(target, 'target'), getPath(path), 0);
}

function readlinkSync(path, options) {
    const { encoding } = getOptions(options, { encoding: 'utf8' });
    const result = binding.readlink(getPath(path));

    return encoding === 'buffer' ? Buffer.from(result, 'utf8') : result;
}

function realpathSync(path, options) {
    const { encoding } = getOptions(options, { encoding: 'utf8' });
    const result = __native.realpathSync(getPath(path));

    return encoding === 'buffer' ? Buffer.from(result, 'utf8') : result;
}

realpathSync.native = realpathSync;

function copyFileSync(from, to, mode = 0) {
    binding.copyfile(getPath(from, 'src'), getPath(to, 'dest'), mode);
}

function existsSync(path) {
    try {
        return binding.access(getPath(path), constants.F_OK, false);
    } catch {
        // A path that cannot even be coerced does not exist, which is what
        // existsSync has always answered rather than throwing.
        return false;
    }
}

function accessSync(path, mode = constants.F_OK) {
    binding.access(getPath(path), mode, true);
}

function chmodSync(path, mode) {
    binding.chmod(getPath(path), mode);
}

function truncateSync(path, len = 0) {
    const fd = openSync(path, 'r+');

    try {
        binding.ftruncate(fd, len);
    } finally {
        binding.close(fd);
    }
}

function toUnixTime(value) {
    if (typeof value === 'number') {
        return value;
    }

    if (value instanceof Date) {
        return value.getTime() / 1000;
    }

    if (typeof value === 'string') {
        return Number(value);
    }

    throw invalidArg('time', 'number, string, or Date', value);
}

function utimesSync(path, atime, mtime) {
    binding.utime(getPath(path), toUnixTime(atime), toUnixTime(mtime));
}

// --- the callback surface ---------------------------------------------------
//
// These map one-to-one onto the binding, which dispatches to the threadpool the
// moment it sees a function in the callback slot.

function open(path, flags, mode, callback) {
    if (typeof flags === 'function') {
        callback = flags;
        flags = 'r';
        mode = 0o666;
    } else if (typeof mode === 'function') {
        callback = mode;
        mode = 0o666;
    }

    binding.open(getPath(path), stringToFlags(flags), mode, guard(getCallback(callback)));
}

function close(fd, callback) {
    binding.close(getFd(fd), guard(getCallback(callback)));
}

function read(fd, buffer, offset, length, position, callback) {
    // read(fd, buffer, options, callback) and read(fd, callback) both exist.
    if (typeof buffer === 'function') {
        callback = buffer;
        buffer = Buffer.alloc(16384);
        offset = 0;
        length = buffer.byteLength;
        position = null;
    } else if (typeof offset === 'object' && offset !== null) {
        callback = length;
        ({ offset = 0, length = buffer.byteLength - offset, position = null } = offset);
    }

    getFd(fd);

    binding.read(
        fd,
        toUint8Array(buffer),
        offset ?? 0,
        length ?? buffer.byteLength - (offset ?? 0),
        position ?? -1,
        guard(getCallback(callback))
    );
}

function write(fd, data, offsetOrPosition, lengthOrEncoding, position, callback) {
    getFd(fd);

    if (typeof data === 'string') {
        // write(fd, string[, position[, encoding]], callback)
        if (typeof offsetOrPosition === 'function') {
            callback = offsetOrPosition;
            offsetOrPosition = null;
            lengthOrEncoding = 'utf8';
        } else if (typeof lengthOrEncoding === 'function') {
            callback = lengthOrEncoding;
            lengthOrEncoding = 'utf8';
        }

        const bytes = Buffer.from(data, lengthOrEncoding || 'utf8');

        binding.write(fd, bytes, 0, bytes.length, offsetOrPosition ?? -1, guard(getCallback(callback)));

        return;
    }

    if (typeof offsetOrPosition === 'function') {
        callback = offsetOrPosition;
        offsetOrPosition = 0;
        lengthOrEncoding = null;
        position = null;
    } else if (typeof lengthOrEncoding === 'function') {
        callback = lengthOrEncoding;
        lengthOrEncoding = null;
        position = null;
    } else if (typeof position === 'function') {
        callback = position;
        position = null;
    }

    const bytes = toUint8Array(data);
    const offset = offsetOrPosition ?? 0;

    binding.write(
        fd,
        bytes,
        offset,
        lengthOrEncoding ?? bytes.byteLength - offset,
        position ?? -1,
        guard(getCallback(callback))
    );
}

function statCallback(callback) {
    return guard((err, raw) => (err ? callback(err) : callback(null, new Stats(raw))));
}

function stat(path, options, callback) {
    const [, cb] = optionsAndCallback(options, callback, {});

    binding.stat(getPath(path), statCallback(cb));
}

function lstat(path, options, callback) {
    const [, cb] = optionsAndCallback(options, callback, {});

    binding.lstat(getPath(path), statCallback(cb));
}

function fstat(fd, options, callback) {
    const [, cb] = optionsAndCallback(options, callback, {});

    binding.fstat(getFd(fd), statCallback(cb));
}

function readdir(path, options, callback) {
    const [{ encoding, withFileTypes }, cb] = optionsAndCallback(options, callback, {
        encoding: 'utf8',
        withFileTypes: false
    });

    const dir = getPath(path);

    binding.readdir(dir, withFileTypes, guard((err, entries) => {
        if (err) {
            cb(err);

            return;
        }

        if (withFileTypes) {
            cb(null, entries.map(e => new Dirent(e.name, e.type, dir)));
        } else if (encoding === 'buffer') {
            cb(null, entries.map(name => Buffer.from(name, 'utf8')));
        } else {
            cb(null, entries);
        }
    }));
}

function unlink(path, callback) {
    binding.unlink(getPath(path), guard(getCallback(callback)));
}

function rename(from, to, callback) {
    binding.rename(getPath(from, 'oldPath'), getPath(to, 'newPath'), 0, guard(getCallback(callback)));
}

function link(from, to, callback) {
    binding.link(getPath(from, 'existingPath'), getPath(to, 'newPath'), 0, guard(getCallback(callback)));
}

function symlink(target, path, type, callback) {
    if (typeof type === 'function') {
        callback = type;
    }

    binding.symlink(getPath(target, 'target'), getPath(path), 0, guard(getCallback(callback)));
}

function copyFile(from, to, mode, callback) {
    if (typeof mode === 'function') {
        callback = mode;
        mode = 0;
    }

    binding.copyfile(getPath(from, 'src'), getPath(to, 'dest'), mode, guard(getCallback(callback)));
}

function readlink(path, options, callback) {
    const [{ encoding }, cb] = optionsAndCallback(options, callback, { encoding: 'utf8' });

    binding.readlink(getPath(path), guard((err, result) => {
        if (err) {
            cb(err);
        } else {
            cb(null, encoding === 'buffer' ? Buffer.from(result, 'utf8') : result);
        }
    }));
}

function realpath(path, options, callback) {
    const [{ encoding }, cb] = optionsAndCallback(options, callback, { encoding: 'utf8' });

    // realpathSync is a bootstrap primitive with no asynchronous form: the
    // module loader needs it synchronously and nothing else calls it hot. A
    // nextTick keeps the callback contract — never called in the same turn.
    process.nextTick(() => {
        let result;

        try {
            result = __native.realpathSync(getPath(path));
        } catch (err) {
            cb(err);

            return;
        }

        cb(null, encoding === 'buffer' ? Buffer.from(result, 'utf8') : result);
    });
}

realpath.native = realpath;

function mkdtemp(prefix, options, callback) {
    const [{ encoding }, cb] = optionsAndCallback(options, callback, { encoding: 'utf8' });

    binding.mkdtemp(`${prefix}XXXXXX`, guard((err, result) => {
        if (err) {
            cb(err);
        } else {
            cb(null, encoding === 'buffer' ? Buffer.from(result, 'utf8') : result);
        }
    }));
}

function chmod(path, mode, callback) {
    binding.chmod(getPath(path), mode, guard(getCallback(callback)));
}

function fsync(fd, callback) {
    binding.fsync(getFd(fd), false, guard(getCallback(callback)));
}

function fdatasync(fd, callback) {
    binding.fsync(getFd(fd), true, guard(getCallback(callback)));
}

function ftruncate(fd, len, callback) {
    if (typeof len === 'function') {
        callback = len;
        len = 0;
    }

    binding.ftruncate(getFd(fd), len, guard(getCallback(callback)));
}

function truncate(path, len, callback) {
    if (typeof len === 'function') {
        callback = len;
        len = 0;
    }

    const cb = getCallback(callback);

    open(path, 'r+', 0o666, (err, fd) => {
        if (err) {
            cb(err);

            return;
        }

        ftruncate(fd, len, truncErr => close(fd, closeErr => cb(truncErr || closeErr)));
    });
}

function utimes(path, atime, mtime, callback) {
    binding.utime(getPath(path), toUnixTime(atime), toUnixTime(mtime), guard(getCallback(callback)));
}

function access(path, mode, callback) {
    if (typeof mode === 'function') {
        callback = mode;
        mode = constants.F_OK;
    }

    binding.access(getPath(path), mode, false, guard(getCallback(callback)));
}

// Deprecated in Node since v1, still called by era code, and the one callback
// in fs that takes no error argument.
function exists(path, callback) {
    const cb = getCallback(callback);

    access(path, constants.F_OK, err => cb(!err));
}

function mkdir(path, options, callback) {
    const opts = typeof options === 'number' ? { mode: options } : options;
    const [{ recursive = false, mode = 0o777 }, cb] = optionsAndCallback(opts, callback, {});
    const dir = getPath(path);

    if (!recursive) {
        binding.mkdir(dir, mode, guard(cb));

        return;
    }

    // Same shape as the synchronous version: walk up to the first existing
    // ancestor, then create back down, reporting the topmost one created.
    const resolved = pathModule.resolve(dir);

    const walkUp = (current, missing) => {
        // The asynchronous form reports through the error argument, not a
        // boolean return: no error means the directory is already there.
        binding.access(current, constants.F_OK, false, guard(err => {
            if (!err) {
                createDown(missing, missing.length - 1, undefined);

                return;
            }

            missing.push(current);

            const parent = pathModule.dirname(current);

            if (parent === current) {
                createDown(missing, missing.length - 1, undefined);
            } else {
                walkUp(parent, missing);
            }
        }));
    };

    const createDown = (missing, index, first) => {
        if (index < 0) {
            cb(null, first);

            return;
        }

        binding.mkdir(missing[index], mode, guard(err => {
            if (err && err.code !== 'EEXIST') {
                cb(err);

                return;
            }

            createDown(missing, index - 1, first ?? (err ? undefined : missing[index]));
        }));
    };

    walkUp(resolved, []);
}

function rmdir(path, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = undefined;
    }

    if (options && options.recursive !== undefined) {
        throw new TypeError(
            `The property 'options.recursive' is no longer supported. Received ${options.recursive}`
        );
    }

    binding.rmdir(getPath(path), guard(getCallback(callback)));
}

function rm(path, options, callback) {
    const [{ recursive = false, force = false }, cb] = optionsAndCallback(options, callback, {});
    const target = getPath(path);

    binding.lstat(target, guard((err, raw) => {
        if (err) {
            cb(force && err.code === 'ENOENT' ? null : err);

            return;
        }

        if ((raw.mode & constants.S_IFMT) !== constants.S_IFDIR) {
            binding.unlink(target, guard(cb));

            return;
        }

        if (!recursive) {
            cb(nodeError('ERR_FS_EISDIR', 'Path is a directory', 'rm', target));

            return;
        }

        binding.readdir(target, false, guard((readErr, names) => {
            if (readErr) {
                cb(readErr);

                return;
            }

            const next = index => {
                if (index >= names.length) {
                    binding.rmdir(target, guard(cb));

                    return;
                }

                rm(pathModule.join(target, names[index]), { recursive: true, force }, childErr => {
                    if (childErr) {
                        cb(childErr);
                    } else {
                        next(index + 1);
                    }
                });
            };

            next(0);
        }));
    }));
}

// --- whole files, asynchronously --------------------------------------------

function readFile(path, options, callback) {
    const [{ encoding, flag }, cb] = optionsAndCallback(options, callback, { encoding: null, flag: 'r' });
    const isFd = typeof path === 'number';

    const withFd = fd => {
        const done = (err, data) => {
            const finish = () => (err ? cb(err) : cb(null, encoding ? data.toString(encoding) : data));

            if (isFd) {
                finish();
            } else {
                binding.close(fd, guard(closeErr => {
                    if (!err && closeErr) {
                        err = closeErr;
                    }

                    finish();
                }));
            }
        };

        binding.fstat(fd, guard((statErr, raw) => {
            if (statErr) {
                done(statErr);

                return;
            }

            const size = (raw.mode & constants.S_IFMT) === constants.S_IFREG ? raw.size : 0;

            // Sized and unsized files take different paths for the reason
            // readAll does: sysfs reports zero and yields bytes anyway.
            if (size > 0) {
                const buf = Buffer.allocUnsafe(size);

                const step = read => {
                    if (read >= size) {
                        done(null, buf);

                        return;
                    }

                    binding.read(fd, buf, read, size - read, -1, guard((readErr, n) => {
                        if (readErr) {
                            done(readErr);
                        } else if (n === 0) {
                            done(null, buf.slice(0, read));
                        } else {
                            step(read + n);
                        }
                    }));
                };

                step(0);

                return;
            }

            const chunks = [];
            let total = 0;

            const step = () => {
                const buf = Buffer.allocUnsafe(CHUNK);

                binding.read(fd, buf, 0, CHUNK, -1, guard((readErr, n) => {
                    if (readErr) {
                        done(readErr);
                    } else if (n === 0) {
                        done(null, chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total));
                    } else {
                        chunks.push(n === CHUNK ? buf : buf.slice(0, n));
                        total += n;
                        step();
                    }
                }));
            };

            step();
        }));
    };

    if (isFd) {
        withFd(path);

        return;
    }

    binding.open(getPath(path), stringToFlags(flag), 0o666, guard((err, fd) => {
        if (err) {
            cb(err);
        } else {
            withFd(fd);
        }
    }));
}

function writeFileImpl(path, data, options, callback, defaultFlag) {
    const [{ encoding, mode, flag }, cb] = optionsAndCallback(options, callback, {
        encoding: 'utf8',
        mode: 0o666,
        flag: defaultFlag
    });

    const bytes = typeof data === 'string' ? Buffer.from(data, encoding || 'utf8') : toUint8Array(data);
    const isFd = typeof path === 'number';

    const withFd = fd => {
        const done = err => {
            if (isFd) {
                cb(err);
            } else {
                binding.close(fd, guard(closeErr => cb(err || closeErr)));
            }
        };

        const step = written => {
            if (written >= bytes.byteLength) {
                done(null);

                return;
            }

            binding.write(fd, bytes, written, bytes.byteLength - written, -1, guard((err, n) => {
                if (err) {
                    done(err);
                } else if (n === 0) {
                    done(null);
                } else {
                    step(written + n);
                }
            }));
        };

        step(0);
    };

    if (isFd) {
        withFd(path);

        return;
    }

    binding.open(getPath(path), stringToFlags(flag), mode, guard((err, fd) => {
        if (err) {
            cb(err);
        } else {
            withFd(fd);
        }
    }));
}

function writeFile(path, data, options, callback) {
    writeFileImpl(path, data, options, callback, 'w');
}

function appendFile(path, data, options, callback) {
    writeFileImpl(path, data, options, callback, 'a');
}

// --- fs.createReadStream / createWriteStream ---------------------------------
//
// Built on first use, not at require time. node:stream is the largest module in
// the standard library, and the laziness rule in the Phase 1 plan says a program
// must not pay for it until it asks: a blinky that calls fs.writeFileSync on a
// sysfs node should never deserialize the stream bundle. Requiring it at the top
// of this file would make every require('fs') do exactly that.


// Node's stream and socket constructors work with or without `new`, because
// they predate classes and a decade of code calls them bare. An ES class throws
// when called. A proxy that forwards a plain call to construct keeps the class
// — and instanceof, and subclassing — while accepting both spellings.
function callableWithoutNew(Cls) {
    return new Proxy(Cls, {
        apply(target, thisArg, args) {
            return Reflect.construct(target, args);
        }
    });
}

let streamClasses;

function getStreamClasses() {
    if (streamClasses) {
        return streamClasses;
    }

    const { Readable, Writable } = require('stream');

    class ReadStream extends Readable {
        constructor(streamPath, options) {
            const opts = getOptions(options, {});

            super({
                highWaterMark: opts.highWaterMark ?? 64 * 1024,
                encoding: opts.encoding ?? null,
                autoDestroy: opts.autoDestroy ?? true,
                emitClose: opts.emitClose ?? true
            });

            this.path = streamPath === null || streamPath === undefined ? null : getPath(streamPath);
            this.flags = opts.flags ?? 'r';
            this.mode = opts.mode ?? 0o666;
            this.fd = opts.fd ?? null;
            this.start = opts.start;
            this.end = opts.end ?? Infinity;
            this.autoClose = opts.autoClose ?? opts.fd === undefined;
            this.bytesRead = 0;
            this.pos = this.start;

            if (this.fd === null) {
                openStream(this);
            } else {
                process.nextTick(() => readyStream(this));
            }
        }

        _read(size) {
            if (this.fd === null) {
                this.once('ready', () => this._read(size));

                return;
            }

            // Node's `end` is inclusive, so the last byte is end - pos + 1 away.
            let want = size;

            if (this.end !== Infinity) {
                const remaining = this.end - (this.pos ?? 0) + 1;

                if (remaining <= 0) {
                    this.push(null);

                    return;
                }

                want = Math.min(want, remaining);
            }

            const buf = Buffer.allocUnsafe(want);

            binding.read(this.fd, buf, 0, want, this.pos ?? -1, guard((err, bytesRead) => {
                if (err) {
                    this.destroy(err);

                    return;
                }

                if (bytesRead === 0) {
                    this.push(null);

                    return;
                }

                this.bytesRead += bytesRead;

                if (this.pos !== undefined) {
                    this.pos += bytesRead;
                }

                this.push(bytesRead === want ? buf : buf.slice(0, bytesRead));
            }));
        }

        _destroy(err, callback) {
            closeStream(this, err, callback);
        }

        close(callback) {
            if (callback) {
                this.once('close', callback);
            }

            this.destroy();
        }
    }

    class WriteStream extends Writable {
        constructor(streamPath, options) {
            const opts = getOptions(options, {});

            super({
                highWaterMark: opts.highWaterMark ?? 16 * 1024,
                autoDestroy: opts.autoDestroy ?? true,
                emitClose: opts.emitClose ?? true,
                decodeStrings: false
            });

            this.path = streamPath === null || streamPath === undefined ? null : getPath(streamPath);
            this.flags = opts.flags ?? 'w';
            this.mode = opts.mode ?? 0o666;
            this.fd = opts.fd ?? null;
            this.start = opts.start;
            this.autoClose = opts.autoClose ?? opts.fd === undefined;
            this.bytesWritten = 0;
            this.pos = this.start;
            this.encoding = opts.encoding ?? 'utf8';

            if (this.fd === null) {
                openStream(this);
            } else {
                process.nextTick(() => readyStream(this));
            }
        }

        _write(chunk, encoding, callback) {
            if (this.fd === null) {
                this.once('ready', () => this._write(chunk, encoding, callback));

                return;
            }

            const bytes = typeof chunk === 'string'
                ? Buffer.from(chunk, encoding === 'buffer' ? this.encoding : encoding || this.encoding)
                : toUint8Array(chunk);

            // uv_fs_write is allowed to write less than it was given.
            const step = written => {
                if (written >= bytes.byteLength) {
                    callback();

                    return;
                }

                binding.write(
                    this.fd,
                    bytes,
                    written,
                    bytes.byteLength - written,
                    this.pos ?? -1,
                    guard((err, n) => {
                        if (err) {
                            callback(err);

                            return;
                        }

                        this.bytesWritten += n;

                        if (this.pos !== undefined) {
                            this.pos += n;
                        }

                        step(written + n);
                    })
                );
            };

            step(0);
        }

        // Corked writes arrive here as a batch. Joining them costs one copy and
        // saves a syscall per chunk, which is the trade cork() exists to make.
        _writev(chunks, callback) {
            const buffers = chunks.map(({ chunk, encoding }) =>
                (typeof chunk === 'string' ? Buffer.from(chunk, encoding || this.encoding) : toUint8Array(chunk)));

            let total = 0;

            for (const b of buffers) {
                total += b.byteLength;
            }

            this._write(Buffer.concat(buffers, total), 'buffer', callback);
        }

        _destroy(err, callback) {
            closeStream(this, err, callback);
        }

        close(callback) {
            if (callback) {
                this.once('close', callback);
            }

            this.end();
        }
    }

    streamClasses = { ReadStream: callableWithoutNew(ReadStream), WriteStream: callableWithoutNew(WriteStream) };

    return streamClasses;
}

function readyStream(stream) {
    stream.emit('open', stream.fd);
    stream.emit('ready');
}

function openStream(stream) {
    binding.open(stream.path, stringToFlags(stream.flags), stream.mode, guard((err, fd) => {
        if (err) {
            stream.destroy(err);

            return;
        }

        stream.fd = fd;
        readyStream(stream);
    }));
}

function closeStream(stream, err, callback) {
    const finish = closeErr => callback(err || closeErr || null);

    if (stream.fd === null || !stream.autoClose) {
        finish();

        return;
    }

    const fd = stream.fd;

    stream.fd = null;
    binding.close(fd, guard(finish));
}

function createReadStream(path, options) {
    return new (getStreamClasses().ReadStream)(path, options);
}

function createWriteStream(path, options) {
    return new (getStreamClasses().WriteStream)(path, options);
}

// --- vectored I/O -----------------------------------------------------------
//
// Deliberately simple: libuv's read and write both take an array of buffers and
// would do these in one syscall, but our binding passes one. Looping is the
// polyfill that makes code using readv/writev *work*, at the cost of a syscall
// per buffer. Nothing on this board is I/O-bound in a way that notices, and the
// alternative is a variadic buffer marshaller in C for an API almost nobody
// calls directly. Recorded in runtime/docs/omissions.md as a known shortcut.

function readvSync(fd, buffers, position) {
    getFd(fd);

    let total = 0;
    let pos = position ?? -1;

    for (const buffer of buffers) {
        const bytes = toUint8Array(buffer);
        const n = binding.read(fd, bytes, 0, bytes.byteLength, pos);

        total += n;

        if (pos >= 0) {
            pos += n;
        }

        if (n < bytes.byteLength) {
            break;
        }
    }

    return total;
}

function writevSync(fd, buffers, position) {
    getFd(fd);

    let total = 0;
    let pos = position ?? -1;

    for (const buffer of buffers) {
        const bytes = toUint8Array(buffer);
        let written = 0;

        while (written < bytes.byteLength) {
            const n = binding.write(fd, bytes, written, bytes.byteLength - written, pos);

            if (n === 0) {
                break;
            }

            written += n;

            if (pos >= 0) {
                pos += n;
            }
        }

        total += written;
    }

    return total;
}

function readv(fd, buffers, position, callback) {
    if (typeof position === 'function') {
        callback = position;
        position = null;
    }

    const cb = getCallback(callback);

    // One buffer at a time on the threadpool, so the loop never blocks even
    // though it is a loop.
    let total = 0;
    let pos = position ?? -1;
    let index = 0;

    const step = () => {
        if (index >= buffers.length) {
            cb(null, total, buffers);

            return;
        }

        const bytes = toUint8Array(buffers[index]);

        binding.read(fd, bytes, 0, bytes.byteLength, pos, guard((err, n) => {
            if (err) {
                cb(err);

                return;
            }

            total += n;

            if (pos >= 0) {
                pos += n;
            }

            if (n < bytes.byteLength) {
                cb(null, total, buffers);

                return;
            }

            index++;
            step();
        }));
    };

    getFd(fd);
    step();
}

function writev(fd, buffers, position, callback) {
    if (typeof position === 'function') {
        callback = position;
        position = null;
    }

    const cb = getCallback(callback);

    let total = 0;
    let pos = position ?? -1;
    let index = 0;

    const step = () => {
        if (index >= buffers.length) {
            cb(null, total, buffers);

            return;
        }

        const bytes = toUint8Array(buffers[index]);

        binding.write(fd, bytes, 0, bytes.byteLength, pos, guard((err, n) => {
            if (err) {
                cb(err);

                return;
            }

            total += n;

            if (pos >= 0) {
                pos += n;
            }

            index++;
            step();
        }));
    };

    getFd(fd);
    step();
}

// --- directory handles ------------------------------------------------------
//
// Also deliberately simple. Node's Dir streams entries from an open DIR* so a
// directory with a million files costs one buffer, not a million objects; ours
// reads the whole listing at open and hands it out one at a time. The API is
// what matters here — a library that iterates a Dir works — and this board does
// not have directories where the difference is measurable.

const kDirEntries = Symbol('entries');
const kDirIndex = Symbol('index');
const kDirClosed = Symbol('closed');

class Dir {
    constructor(dirPath, entries) {
        this.path = dirPath;
        this[kDirEntries] = entries;
        this[kDirIndex] = 0;
        this[kDirClosed] = false;
    }

    readSync() {
        if (this[kDirClosed]) {
            throw nodeError('ERR_DIR_CLOSED', 'Directory handle was closed', 'readdir', this.path);
        }

        if (this[kDirIndex] >= this[kDirEntries].length) {
            return null;
        }

        return this[kDirEntries][this[kDirIndex]++];
    }

    read(callback) {
        if (callback === undefined) {
            return new Promise((resolve, reject) => {
                try {
                    const entry = this.readSync();

                    process.nextTick(() => resolve(entry));
                } catch (err) {
                    process.nextTick(() => reject(err));
                }
            });
        }

        const cb = getCallback(callback);

        process.nextTick(() => {
            try {
                cb(null, this.readSync());
            } catch (err) {
                cb(err);
            }
        });

        return undefined;
    }

    closeSync() {
        this[kDirClosed] = true;
    }

    close(callback) {
        this[kDirClosed] = true;

        if (callback === undefined) {
            return Promise.resolve();
        }

        const cb = getCallback(callback);

        process.nextTick(() => cb(null));

        return undefined;
    }

    async *[Symbol.asyncIterator]() {
        try {
            for (;;) {
                const entry = await this.read();

                if (entry === null) {
                    return;
                }

                yield entry;
            }
        } finally {
            await this.close();
        }
    }
}

function opendirSync(dirPath, options) {
    const resolved = getPath(dirPath);
    const entries = binding.readdir(resolved, true).map(e => new Dirent(e.name, e.type, resolved));

    return new Dir(resolved, entries);
}

function opendir(dirPath, options, callback) {
    const [, cb] = optionsAndCallback(options, callback, {});
    const resolved = getPath(dirPath);

    binding.readdir(resolved, true, guard((err, entries) => {
        if (err) {
            cb(err);
        } else {
            cb(null, new Dir(resolved, entries.map(e => new Dirent(e.name, e.type, resolved))));
        }
    }));
}

// --- FileHandle -------------------------------------------------------------
//
// fs.promises.open resolves to one of these rather than a bare descriptor, so a
// caller can close it (or let `await using` do it) without reaching back into
// the callback API.

class FileHandle {
    constructor(fd) {
        this.fd = fd;
    }

    async read(buffer, offset, length, position) {
        if (buffer === undefined || !ArrayBuffer.isView(buffer)) {
            // read({ buffer, offset, length, position }) and read() with nothing
            const opts = buffer ?? {};

            buffer = opts.buffer ?? Buffer.alloc(16384);
            offset = opts.offset ?? 0;
            length = opts.length ?? buffer.byteLength - offset;
            position = opts.position ?? null;
        }

        const bytesRead = await new Promise((resolve, reject) => {
            binding.read(
                this.fd,
                toUint8Array(buffer),
                offset ?? 0,
                length ?? buffer.byteLength - (offset ?? 0),
                position ?? -1,
                guard((err, n) => (err ? reject(err) : resolve(n)))
            );
        });

        return { bytesRead, buffer };
    }

    async write(data, offsetOrPosition, lengthOrEncoding, position) {
        const isString = typeof data === 'string';
        const bytes = isString ? Buffer.from(data, lengthOrEncoding || 'utf8') : toUint8Array(data);
        const offset = isString ? 0 : offsetOrPosition ?? 0;
        const length = isString ? bytes.length : lengthOrEncoding ?? bytes.byteLength - offset;
        const pos = isString ? offsetOrPosition ?? -1 : position ?? -1;

        const bytesWritten = await new Promise((resolve, reject) => {
            binding.write(this.fd, bytes, offset, length, pos,
                guard((err, n) => (err ? reject(err) : resolve(n))));
        });

        return { bytesWritten, buffer: data };
    }

    readFile(options) {
        return promises.readFile(this.fd, options);
    }

    writeFile(data, options) {
        return promises.writeFile(this.fd, data, options);
    }

    appendFile(data, options) {
        return promises.appendFile(this.fd, data, options);
    }

    stat() {
        return new Promise((resolve, reject) => {
            binding.fstat(this.fd, guard((err, raw) => (err ? reject(err) : resolve(new Stats(raw)))));
        });
    }

    truncate(len = 0) {
        return new Promise((resolve, reject) => {
            binding.ftruncate(this.fd, len, guard(err => (err ? reject(err) : resolve())));
        });
    }

    sync() {
        return new Promise((resolve, reject) => {
            binding.fsync(this.fd, false, guard(err => (err ? reject(err) : resolve())));
        });
    }

    datasync() {
        return new Promise((resolve, reject) => {
            binding.fsync(this.fd, true, guard(err => (err ? reject(err) : resolve())));
        });
    }

    createReadStream(options) {
        return createReadStream(null, { ...getOptions(options, {}), fd: this.fd });
    }

    createWriteStream(options) {
        return createWriteStream(null, { ...getOptions(options, {}), fd: this.fd });
    }

    close() {
        return new Promise((resolve, reject) => {
            binding.close(this.fd, guard(err => (err ? reject(err) : resolve())));
        });
    }

    [Symbol.asyncDispose]() {
        return this.close();
    }
}

// --- ownership, modes and times ----------------------------------------------
//
// Deferred out of step 1 as "mechanical", then pulled forward when Node's own
// fs tests turned out to ask for all of them by name.

function chownSync(path, uid, gid) {
    binding.chown(getPath(path), uid, gid);
}

function chown(path, uid, gid, callback) {
    binding.chown(getPath(path), uid, gid, guard(getCallback(callback)));
}

function lchownSync(path, uid, gid) {
    binding.lchown(getPath(path), uid, gid);
}

function lchown(path, uid, gid, callback) {
    binding.lchown(getPath(path), uid, gid, guard(getCallback(callback)));
}

function fchownSync(fd, uid, gid) {
    binding.fchown(getFd(fd), uid, gid);
}

function fchown(fd, uid, gid, callback) {
    binding.fchown(getFd(fd), uid, gid, guard(getCallback(callback)));
}

function fchmodSync(fd, mode) {
    binding.fchmod(getFd(fd), mode);
}

function fchmod(fd, mode, callback) {
    binding.fchmod(getFd(fd), mode, guard(getCallback(callback)));
}

function futimesSync(fd, atime, mtime) {
    binding.futime(getFd(fd), toUnixTime(atime), toUnixTime(mtime));
}

function futimes(fd, atime, mtime, callback) {
    binding.futime(getFd(fd), toUnixTime(atime), toUnixTime(mtime), guard(getCallback(callback)));
}

function lutimesSync(path, atime, mtime) {
    binding.lutime(getPath(path), toUnixTime(atime), toUnixTime(mtime));
}

function lutimes(path, atime, mtime, callback) {
    binding.lutime(getPath(path), toUnixTime(atime), toUnixTime(mtime), guard(getCallback(callback)));
}

class StatFs {
    constructor(raw) {
        Object.assign(this, raw);
    }
}

function statfsSync(path, options) {
    getOptions(options, {});

    return new StatFs(binding.statfs(getPath(path)));
}

function statfs(path, options, callback) {
    const [, cb] = optionsAndCallback(options, callback, {});

    binding.statfs(getPath(path), guard((err, raw) => (err ? cb(err) : cb(null, new StatFs(raw)))));
}

// --- omissions ---------------------------------------------------------------
//
// Present as stubs so a caller is told what it hit, rather than absent so it
// reads as a typo. The reasoning for each is in runtime/docs/omissions.md.

const WATCH_REASON = 'nothing on this device watches files, and FSWatcher semantics are ' +
    'platform-specific enough that a half-built one would be worse than none';

const LCHMOD_REASON = 'changing the mode of a symlink is a BSD extension; Linux has no lchmod(2), ' +
    'and Node throws here too on this platform';

const lchmod = __native.omitted('fs.lchmod', LCHMOD_REASON);
const lchmodSync = __native.omitted('fs.lchmodSync', LCHMOD_REASON);

const watch = __native.omitted('fs.watch', WATCH_REASON);
const watchFile = __native.omitted('fs.watchFile', WATCH_REASON);
const unwatchFile = __native.omitted('fs.unwatchFile', WATCH_REASON);

// --- fs.promises -------------------------------------------------------------
//
// A wrapper over the callback layer, as it is in Node — not a third
// implementation. read and write are the two whose callbacks carry a second
// result, and so the two that resolve to an object.

function promisify(fn) {
    return (...args) => new Promise((resolve, reject) => {
        fn(...args, (err, result) => (err ? reject(err) : resolve(result)));
    });
}

const promises = {
    access: promisify(access),
    appendFile: promisify(appendFile),
    chmod: promisify(chmod),
    copyFile: promisify(copyFile),
    lstat: promisify(lstat),
    link: promisify(link),
    mkdir: promisify(mkdir),
    mkdtemp: promisify(mkdtemp),
    readFile: promisify(readFile),
    readdir: promisify(readdir),
    readlink: promisify(readlink),
    realpath: promisify(realpath),
    rename: promisify(rename),
    rm: promisify(rm),
    rmdir: promisify(rmdir),
    stat: promisify(stat),
    symlink: promisify(symlink),
    truncate: promisify(truncate),
    unlink: promisify(unlink),
    utimes: promisify(utimes),
    writeFile: promisify(writeFile),
    constants
};

promises.opendir = promisify(opendir);
promises.chown = promisify(chown);
promises.lchown = promisify(lchown);
promises.lutimes = promisify(lutimes);
promises.statfs = promisify(statfs);
promises.lchmod = __native.omitted('fs.promises.lchmod', LCHMOD_REASON);
promises.cp = promisify(cp);
promises.watch = __native.omitted('fs.promises.watch', WATCH_REASON);

// The one promise-only entry point: it resolves to a FileHandle, not a number.
// The class itself is deliberately not exported: Node does not export it either,
// and this module's surface is checked against Node's for extras.
promises.open = function open(filePath, flags, mode = 0o666) {
    return new Promise((resolve, reject) => {
        binding.open(getPath(filePath), stringToFlags(flags), mode,
            guard((err, fd) => (err ? reject(err) : resolve(new FileHandle(fd)))));
    });
};

// --- cp ----------------------------------------------------------------------
//
// First-party rather than a vendored copy of one of the npm equivalents: the
// whole of it is a walk over primitives we already have, and pulling a package
// into the firmware image would be a dependency-policy event (DEPENDENCIES.md)
// for something this size. The fidelity gaps against Node are in the exotic
// options, not the common "copy this one file" call.

function cpOptions(options) {
    return getOptions(options, {
        recursive: false,
        force: true,
        errorOnExist: false,
        dereference: false,
        preserveTimestamps: false
    });
}

function cpSync(src, dest, options) {
    const opts = cpOptions(options);

    copyEntrySync(getPath(src, 'src'), getPath(dest, 'dest'), opts);
}

function copyEntrySync(src, dest, opts) {
    if (opts.filter && !opts.filter(src, dest)) {
        return;
    }

    const raw = opts.dereference ? binding.stat(src) : binding.lstat(src);
    const type = raw.mode & constants.S_IFMT;

    if (type === constants.S_IFDIR) {
        if (!opts.recursive) {
            throw nodeError('ERR_FS_EISDIR', 'Recursive option not enabled, cannot copy a directory', 'cp', src);
        }

        mkdirSync(dest, { recursive: true, mode: raw.mode & 0o777 });

        for (const name of binding.readdir(src, false)) {
            copyEntrySync(pathModule.join(src, name), pathModule.join(dest, name), opts);
        }

        return;
    }

    if (type === constants.S_IFLNK) {
        const target = binding.readlink(src);

        if (binding.access(dest, constants.F_OK, false)) {
            binding.unlink(dest);
        }

        binding.symlink(target, dest, 0);

        return;
    }

    if (binding.access(dest, constants.F_OK, false)) {
        if (opts.errorOnExist && !opts.force) {
            throw nodeError('ERR_FS_CP_EEXIST', 'Target already exists', 'cp', dest);
        }

        if (!opts.force) {
            return;
        }
    }

    binding.copyfile(src, dest, 0);

    if (opts.preserveTimestamps) {
        binding.utime(dest, raw.atimeMs / 1000, raw.mtimeMs / 1000);
    }
}

// The asynchronous form is written against fs.promises rather than as a
// callback chain: it is the same walk, and await keeps it readable.
async function copyEntry(src, dest, opts) {
    if (opts.filter && !(await opts.filter(src, dest))) {
        return;
    }

    const raw = await (opts.dereference ? promises.stat(src) : promises.lstat(src));
    const type = raw.mode & constants.S_IFMT;

    if (type === constants.S_IFDIR) {
        if (!opts.recursive) {
            throw nodeError('ERR_FS_EISDIR', 'Recursive option not enabled, cannot copy a directory', 'cp', src);
        }

        await promises.mkdir(dest, { recursive: true, mode: raw.mode & 0o777 });

        for (const name of await promises.readdir(src)) {
            await copyEntry(pathModule.join(src, name), pathModule.join(dest, name), opts);
        }

        return;
    }

    if (type === constants.S_IFLNK) {
        const target = await promises.readlink(src);

        if (existsSync(dest)) {
            await promises.unlink(dest);
        }

        await promises.symlink(target, dest);

        return;
    }

    if (existsSync(dest)) {
        if (opts.errorOnExist && !opts.force) {
            throw nodeError('ERR_FS_CP_EEXIST', 'Target already exists', 'cp', dest);
        }

        if (!opts.force) {
            return;
        }
    }

    await promises.copyFile(src, dest);

    if (opts.preserveTimestamps) {
        await promises.utimes(dest, raw.atimeMs / 1000, raw.mtimeMs / 1000);
    }
}

function cp(src, dest, options, callback) {
    const [, cb] = optionsAndCallback(options, callback, {});
    const opts = cpOptions(typeof options === 'function' ? undefined : options);

    copyEntry(getPath(src, 'src'), getPath(dest, 'dest'), opts).then(() => cb(null), cb);
}

// --- exports ----------------------------------------------------------------

module.exports = {
    constants,
    promises,
    Stats,
    Dirent,

    createReadStream,
    createWriteStream,
    chown,
    chownSync,
    cp,
    cpSync,
    fchmod,
    fchmodSync,
    fchown,
    fchownSync,
    futimes,
    futimesSync,
    lchmod,
    lchmodSync,
    lchown,
    lchownSync,
    lutimes,
    lutimesSync,
    statfs,
    statfsSync,
    StatFs,
    opendir,
    opendirSync,
    readv,
    readvSync,
    writev,
    writevSync,
    watch,
    watchFile,
    unwatchFile,
    Dir,

    access,
    appendFile,
    chmod,
    close,
    copyFile,
    exists,
    fdatasync,
    fstat,
    fsync,
    ftruncate,
    link,
    lstat,
    mkdir,
    mkdtemp,
    open,
    read,
    readFile,
    readdir,
    readlink,
    realpath,
    rename,
    rm,
    rmdir,
    stat,
    symlink,
    truncate,
    unlink,
    utimes,
    write,
    writeFile,

    accessSync,
    appendFileSync,
    chmodSync,
    closeSync,
    copyFileSync,
    existsSync,
    fdatasyncSync,
    fstatSync,
    fsyncSync,
    ftruncateSync,
    linkSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    renameSync,
    rmSync,
    rmdirSync,
    statSync,
    symlinkSync,
    truncateSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
    writeSync
};

// Node exposes the constructors too. Getters rather than values, so touching
// fs.ReadStream is what loads node:stream — not requiring fs.
Object.defineProperty(module.exports, 'ReadStream', {
    configurable: true,
    enumerable: true,
    get: () => getStreamClasses().ReadStream
});
Object.defineProperty(module.exports, 'WriteStream', {
    configurable: true,
    enumerable: true,
    get: () => getStreamClasses().WriteStream
});

// Node still exports these two names for the same classes.
Object.defineProperty(module.exports, 'FileReadStream', {
    configurable: true,
    enumerable: true,
    get: () => getStreamClasses().ReadStream
});
Object.defineProperty(module.exports, 'FileWriteStream', {
    configurable: true,
    enumerable: true,
    get: () => getStreamClasses().WriteStream
});
