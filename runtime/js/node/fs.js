// node:fs — the synchronous surface.
//
// A thin shell over the uv_fs_* primitives in runtime/src/fs.c. Everything that
// is shaping rather than syscall lives here: flag strings, encodings, Stats and
// Dirent, recursive mkdir and rm, and the argument coercions Node performs
// before it reaches the kernel.
//
// The callback and promise halves land on the same primitives — uv_fs_* runs on
// the threadpool when handed a callback — and are the next step of Phase 2; see
// runtime/docs/phase2-plan.md §2. Until they exist, the async names are absent
// rather than faked: a writeFile that is secretly synchronous would stall the
// loop on a 580 MHz core with slow flash, and would be discovered late.

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

// --- exports ----------------------------------------------------------------

module.exports = {
    constants,
    Stats,
    Dirent,

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
