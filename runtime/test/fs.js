// node:fs — the synchronous surface.
//
// This suite is written to pass on stock Node as well as on this runtime, and
// it is worth keeping that way. Phase 1 shipped a Buffer bug that our own tests
// could not have caught because the same author wrote the implementation and
// the assertions; an era package found it in a day. Running the same file
// against the reference implementation is the cheap standing version of that
// check — if an assertion here is wrong about Node, Node says so.
//
//   runtime/test/run.sh <node>     # this runtime
//   node runtime/test/fs.js        # the reference

'use strict';

const fs = require('fs');
const path = require('path');

let fail = 0;
const eq = (actual, expected, label) => {
    if (String(actual) !== String(expected)) {
        fail++;
        console.log('FAIL', label, '->', actual, '!=', expected);
    }
};

const throws = (fn, code, label) => {
    try {
        fn();
        fail++;
        console.log('FAIL', label, '-> did not throw');

        return undefined;
    } catch (err) {
        if (err.code !== code) {
            fail++;
            console.log('FAIL', label, '-> code', err.code, '!=', code);
        }

        return err;
    }
};

// --- constants --------------------------------------------------------------

for (const name of ['O_RDONLY', 'O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_EXCL', 'O_TRUNC',
    'O_APPEND', 'F_OK', 'R_OK', 'W_OK', 'X_OK', 'S_IFMT', 'S_IFREG', 'S_IFDIR', 'S_IFLNK']) {
    eq(typeof fs.constants[name], 'number', `constants.${name}`);
}

eq((fs.constants.S_IFREG & fs.constants.S_IFMT) === fs.constants.S_IFREG, true, 'S_IFREG within S_IFMT');

// --- a scratch directory ----------------------------------------------------

const dir = fs.mkdtempSync('/tmp/t2fs-');

eq(dir.startsWith('/tmp/t2fs-'), true, 'mkdtempSync honors the prefix');
eq(fs.statSync(dir).isDirectory(), true, 'mkdtempSync made a directory');

const file = path.join(dir, 'hello.txt');

// --- whole files ------------------------------------------------------------

fs.writeFileSync(file, 'hello');
eq(fs.readFileSync(file, 'utf8'), 'hello', 'writeFileSync/readFileSync round trip');
eq(Buffer.isBuffer(fs.readFileSync(file)), true, 'readFileSync defaults to a Buffer');
eq(fs.readFileSync(file).length, 5, 'Buffer length');
eq(fs.readFileSync(file, { encoding: 'utf8' }), 'hello', 'encoding as an option object');
eq(fs.readFileSync(file, 'hex'), '68656c6c6f', 'hex encoding');

fs.appendFileSync(file, ' world');
eq(fs.readFileSync(file, 'utf8'), 'hello world', 'appendFileSync');

fs.writeFileSync(file, Buffer.from([0, 1, 2, 255]));
eq(fs.readFileSync(file).length, 4, 'writeFileSync accepts a Buffer');
eq(fs.readFileSync(file)[3], 255, 'binary survives the round trip');

fs.writeFileSync(file, 'hello');

// --- descriptors ------------------------------------------------------------

const fd = fs.openSync(file, 'r');

eq(typeof fd, 'number', 'openSync returns a number');

const buf = Buffer.alloc(5);

eq(fs.readSync(fd, buf, 0, 5, 0), 5, 'readSync byte count');
eq(buf.toString(), 'hello', 'readSync contents');
eq(fs.readSync(fd, buf, 0, 2, 1), 2, 'readSync honors position');
eq(buf.toString('utf8', 0, 2), 'el', 'readSync positioned contents');
eq(fs.fstatSync(fd).size, 5, 'fstatSync');
fs.closeSync(fd);

const wfd = fs.openSync(path.join(dir, 'w.txt'), 'w');

eq(fs.writeSync(wfd, 'abc'), 3, 'writeSync(string) byte count');
eq(fs.writeSync(wfd, Buffer.from('de')), 2, 'writeSync(buffer) byte count');
fs.fsyncSync(wfd);
fs.closeSync(wfd);
eq(fs.readFileSync(path.join(dir, 'w.txt'), 'utf8'), 'abcde', 'writeSync contents');

// --- flags ------------------------------------------------------------------

throws(() => fs.openSync(path.join(dir, 'nope.txt'), 'r'), 'ENOENT', "flag 'r' on a missing file");
throws(() => fs.openSync(file, 'wx'), 'EEXIST', "flag 'wx' on an existing file");

// --- stat -------------------------------------------------------------------

const st = fs.statSync(file);

eq(st.isFile(), true, 'isFile');
eq(st.isDirectory(), false, 'isDirectory on a file');
eq(st.isSymbolicLink(), false, 'isSymbolicLink on a file');
eq(st.size, 5, 'size');
eq(typeof st.mode, 'number', 'mode');
eq(typeof st.ino, 'number', 'ino');
eq(typeof st.mtimeMs, 'number', 'mtimeMs');
eq(st.mtime instanceof Date, true, 'mtime is a Date');
eq(st.mtime.getTime(), Math.round(st.mtimeMs), 'mtime mirrors mtimeMs');
eq(fs.statSync(dir).isDirectory(), true, 'isDirectory on a directory');

eq(fs.statSync(path.join(dir, 'nope'), { throwIfNoEntry: false }), undefined, 'throwIfNoEntry: false');
throws(() => fs.statSync(path.join(dir, 'nope')), 'ENOENT', 'statSync throws by default');

// --- existence and access ---------------------------------------------------

eq(fs.existsSync(file), true, 'existsSync on a file');
eq(fs.existsSync(path.join(dir, 'nope')), false, 'existsSync on a missing path');
eq(fs.accessSync(file, fs.constants.R_OK), undefined, 'accessSync returns undefined');
throws(() => fs.accessSync(path.join(dir, 'nope')), 'ENOENT', 'accessSync on a missing path');

// --- error shape ------------------------------------------------------------

const err = throws(() => fs.readFileSync(path.join(dir, 'nope')), 'ENOENT', 'error code');

eq(typeof err.errno, 'number', 'error carries errno');
eq(err.errno < 0, true, 'errno is negative');
eq(err.syscall, 'open', 'error carries syscall');
eq(err.path, path.join(dir, 'nope'), 'error carries path');
eq(err.message.startsWith('ENOENT: no such file or directory, open '), true, `error message (${err.message})`);
eq(err.message.includes(`'${path.join(dir, 'nope')}'`), true, 'message quotes the path');

const err2 = throws(
    () => fs.renameSync(path.join(dir, 'nope'), path.join(dir, 'other')),
    'ENOENT',
    'two-path error code'
);

eq(err2.syscall, 'rename', 'two-path error syscall');
eq(err2.path, path.join(dir, 'nope'), 'two-path error path');
eq(err2.dest, path.join(dir, 'other'), 'two-path error dest');
eq(err2.message.includes(' -> '), true, `two-path error message (${err2.message})`);

// --- directories ------------------------------------------------------------

fs.mkdirSync(path.join(dir, 'sub'));
fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'a');

const names = fs.readdirSync(dir).sort();

eq(names.includes('hello.txt'), true, 'readdirSync lists files');
eq(names.includes('sub'), true, 'readdirSync lists directories');

const entries = fs.readdirSync(dir, { withFileTypes: true });
const subEntry = entries.find(e => e.name === 'sub');
const fileEntry = entries.find(e => e.name === 'hello.txt');

eq(subEntry.isDirectory(), true, 'Dirent.isDirectory');
eq(subEntry.isFile(), false, 'Dirent.isFile on a directory');
eq(fileEntry.isFile(), true, 'Dirent.isFile');
eq(fileEntry.parentPath, dir, 'Dirent.parentPath');

// recursive mkdir reports the topmost directory it created
const deep = path.join(dir, 'x', 'y', 'z');

eq(fs.mkdirSync(deep, { recursive: true }), path.join(dir, 'x'), 'recursive mkdirSync return value');
eq(fs.statSync(deep).isDirectory(), true, 'recursive mkdirSync created the leaf');
eq(fs.mkdirSync(deep, { recursive: true }), undefined, 'recursive mkdirSync is idempotent');
throws(() => fs.mkdirSync(deep), 'EEXIST', 'non-recursive mkdirSync on an existing directory');

// --- links ------------------------------------------------------------------

const link = path.join(dir, 'link.txt');

fs.symlinkSync(file, link);
eq(fs.readlinkSync(link), file, 'readlinkSync');
eq(fs.lstatSync(link).isSymbolicLink(), true, 'lstatSync sees the link');
eq(fs.statSync(link).isSymbolicLink(), false, 'statSync follows the link');
eq(fs.statSync(link).isFile(), true, 'statSync resolves to the target');
eq(fs.readFileSync(link, 'utf8'), 'hello', 'reading through a symlink');
eq(fs.realpathSync(link), fs.realpathSync(file), 'realpathSync resolves the link');

const hard = path.join(dir, 'hard.txt');

fs.linkSync(file, hard);
eq(fs.readFileSync(hard, 'utf8'), 'hello', 'linkSync');
eq(fs.statSync(hard).nlink >= 2, true, 'hard link raises nlink');

// --- copy, rename, truncate, times ------------------------------------------

const copy = path.join(dir, 'copy.txt');

fs.copyFileSync(file, copy);
eq(fs.readFileSync(copy, 'utf8'), 'hello', 'copyFileSync');
throws(() => fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL), 'EEXIST', 'COPYFILE_EXCL');

const moved = path.join(dir, 'moved.txt');

fs.renameSync(copy, moved);
eq(fs.existsSync(copy), false, 'renameSync removed the source');
eq(fs.readFileSync(moved, 'utf8'), 'hello', 'renameSync kept the contents');

fs.truncateSync(moved, 3);
eq(fs.readFileSync(moved, 'utf8'), 'hel', 'truncateSync');

const tfd = fs.openSync(moved, 'r+');

fs.ftruncateSync(tfd, 1);
fs.closeSync(tfd);
eq(fs.readFileSync(moved, 'utf8'), 'h', 'ftruncateSync');

fs.utimesSync(moved, new Date(1000000), new Date(2000000));
eq(Math.round(fs.statSync(moved).mtimeMs), 2000000, 'utimesSync sets mtime');

fs.chmodSync(moved, 0o600);
eq(fs.statSync(moved).mode & 0o777, 0o600, 'chmodSync');

// --- files whose size the kernel does not know ------------------------------

// sysfs and procfs report st_size 0 and produce bytes anyway. This is how
// tessel-export.js reads a GPIO, so a size-driven read would return empty and
// the board would silently see nothing. Linux only; skipped elsewhere.
if (fs.existsSync('/proc/self/status')) {
    const status = fs.readFileSync('/proc/self/status', 'utf8');

    eq(fs.statSync('/proc/self/status').size, 0, 'procfs reports size 0');
    eq(status.length > 0, true, 'readFileSync reads a zero-sized file to EOF');
    eq(status.includes('Name:'), true, 'zero-sized read has real contents');
}

// --- removal ----------------------------------------------------------------

fs.unlinkSync(hard);
eq(fs.existsSync(hard), false, 'unlinkSync');

throws(() => fs.rmSync(path.join(dir, 'x')), 'ERR_FS_EISDIR', 'rmSync on a directory without recursive');
fs.rmSync(path.join(dir, 'x'), { recursive: true });
eq(fs.existsSync(path.join(dir, 'x')), false, 'recursive rmSync');

eq(fs.rmSync(path.join(dir, 'gone'), { force: true }), undefined, 'rmSync force ignores a missing path');
throws(() => fs.rmSync(path.join(dir, 'gone')), 'ENOENT', 'rmSync without force reports a missing path');

// rmdirSync lost its `recursive` option in Node 16; fs.rmSync replaced it.
throws(
    () => fs.rmdirSync(path.join(dir, 'sub'), { recursive: true }),
    'ERR_INVALID_ARG_VALUE',
    'rmdirSync rejects the removed recursive option'
);
throws(() => fs.rmdirSync(path.join(dir, 'sub')), 'ENOTEMPTY', 'rmdirSync on a non-empty directory');
fs.rmSync(path.join(dir, 'sub'), { recursive: true });
eq(fs.existsSync(path.join(dir, 'sub')), false, 'rmSync removed the subtree');

// clean up
fs.rmSync(dir, { recursive: true, force: true });
eq(fs.existsSync(dir), false, 'scratch directory removed');

console.log(fail === 0 ? 'FS: all pass' : `FS: ${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
