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

// --- the callback surface ---------------------------------------------------

const rejects = async (promise, code, label) => {
    try {
        await promise;
        fail++;
        console.log('FAIL', label, '-> did not reject');
    } catch (err) {
        if (err.code !== code) {
            fail++;
            console.log('FAIL', label, '-> code', err.code, '!=', code);
        }
    }
};

const call = (fn, ...args) =>
    new Promise((resolve, reject) => {
        fn(...args, (err, ...rest) => (err ? reject(err) : resolve(rest.length > 1 ? rest : rest[0])));
    });

async function asyncTests() {
    const adir = await call(fs.mkdtemp, '/tmp/t2fsa-');
    const afile = path.join(adir, 'a.txt');

    // A callback must never run in the turn that scheduled it. Era code relies
    // on this; a synchronous call hidden behind an async name breaks it.
    let sameTurn = true;
    let ranInSameTurn = false;

    fs.stat(adir, () => {
        ranInSameTurn = sameTurn;
    });
    sameTurn = false;

    await call(fs.writeFile, afile, 'hello');
    eq(ranInSameTurn, false, 'callbacks do not run in the calling turn');

    eq(await call(fs.readFile, afile, 'utf8'), 'hello', 'writeFile/readFile round trip');
    eq(Buffer.isBuffer(await call(fs.readFile, afile)), true, 'readFile defaults to a Buffer');

    await call(fs.appendFile, afile, ' world');
    eq(await call(fs.readFile, afile, 'utf8'), 'hello world', 'appendFile');

    await call(fs.writeFile, afile, Buffer.from([1, 2, 3]));
    eq((await call(fs.readFile, afile)).length, 3, 'writeFile accepts a Buffer');

    await call(fs.writeFile, afile, 'hello');

    // stat
    const ast = await call(fs.stat, afile);

    eq(ast instanceof fs.Stats, true, 'stat yields a Stats');
    eq(ast.isFile(), true, 'async stat isFile');
    eq(ast.size, 5, 'async stat size');
    eq((await call(fs.lstat, afile)).isFile(), true, 'async lstat');

    // descriptors
    const afd = await call(fs.open, afile, 'r');
    const abuf = Buffer.alloc(5);
    const readResult = await call(fs.read, afd, abuf, 0, 5, 0);

    eq(readResult[0], 5, 'async read reports the byte count');
    eq(Buffer.isBuffer(readResult[1]), true, 'async read passes the buffer back');
    eq(abuf.toString(), 'hello', 'async read filled the buffer');
    eq((await call(fs.fstat, afd)).size, 5, 'async fstat');
    await call(fs.close, afd);

    const wfd2 = await call(fs.open, path.join(adir, 'w.txt'), 'w');

    eq((await call(fs.write, wfd2, 'abc'))[0], 3, 'async write(string)');
    await call(fs.fsync, wfd2);
    await call(fs.fdatasync, wfd2);
    await call(fs.close, wfd2);
    eq(await call(fs.readFile, path.join(adir, 'w.txt'), 'utf8'), 'abc', 'async write contents');

    // directories
    await call(fs.mkdir, path.join(adir, 'sub'));
    await call(fs.writeFile, path.join(adir, 'sub', 'b.txt'), 'b');

    const anames = (await call(fs.readdir, adir)).sort();

    eq(anames.join(), 'a.txt,sub,w.txt', 'async readdir');

    const aents = await call(fs.readdir, adir, { withFileTypes: true });

    eq(aents.find(e => e.name === 'sub').isDirectory(), true, 'async readdir withFileTypes');

    const deepFirst = await call(fs.mkdir, path.join(adir, 'p', 'q', 'r'), { recursive: true });

    eq(deepFirst, path.join(adir, 'p'), 'async recursive mkdir reports the topmost created');
    eq(fs.existsSync(path.join(adir, 'p', 'q', 'r')), true, 'async recursive mkdir created the leaf');
    eq(await call(fs.mkdir, path.join(adir, 'p', 'q', 'r'), { recursive: true }), undefined,
        'async recursive mkdir is idempotent');

    // links, copies, moves
    const alink = path.join(adir, 'link.txt');

    await call(fs.symlink, afile, alink);
    eq(await call(fs.readlink, alink), afile, 'async readlink');
    eq(await call(fs.realpath, alink), await call(fs.realpath, afile), 'async realpath resolves the link');
    eq((await call(fs.lstat, alink)).isSymbolicLink(), true, 'async lstat sees the link');

    await call(fs.copyFile, afile, path.join(adir, 'copy.txt'));
    eq(await call(fs.readFile, path.join(adir, 'copy.txt'), 'utf8'), 'hello', 'async copyFile');

    await call(fs.rename, path.join(adir, 'copy.txt'), path.join(adir, 'moved.txt'));
    eq(fs.existsSync(path.join(adir, 'copy.txt')), false, 'async rename removed the source');

    await call(fs.truncate, path.join(adir, 'moved.txt'), 2);
    eq(await call(fs.readFile, path.join(adir, 'moved.txt'), 'utf8'), 'he', 'async truncate');

    await call(fs.chmod, path.join(adir, 'moved.txt'), 0o600);
    eq((await call(fs.stat, path.join(adir, 'moved.txt'))).mode & 0o777, 0o600, 'async chmod');

    await call(fs.utimes, path.join(adir, 'moved.txt'), new Date(1000000), new Date(3000000));
    eq(Math.round((await call(fs.stat, path.join(adir, 'moved.txt'))).mtimeMs), 3000000, 'async utimes');

    await call(fs.unlink, path.join(adir, 'moved.txt'));
    eq(fs.existsSync(path.join(adir, 'moved.txt')), false, 'async unlink');

    // access and the legacy exists
    eq(await call(fs.access, afile), undefined, 'async access on a readable file');
    await rejects(call(fs.access, path.join(adir, 'nope')), 'ENOENT', 'async access on a missing path');
    eq(await new Promise(resolve => fs.exists(afile, resolve)), true, 'fs.exists on a file');
    eq(await new Promise(resolve => fs.exists(path.join(adir, 'nope'), resolve)), false,
        'fs.exists on a missing path');

    // errors carry the same shape as the synchronous ones
    await rejects(call(fs.readFile, path.join(adir, 'nope')), 'ENOENT', 'async readFile on a missing file');

    let asyncErr;

    await new Promise(resolve => fs.stat(path.join(adir, 'nope'), err => {
        asyncErr = err;
        resolve();
    }));

    eq(asyncErr.code, 'ENOENT', 'async error code');
    eq(asyncErr.syscall, 'stat', 'async error syscall');
    eq(asyncErr.path, path.join(adir, 'nope'), 'async error path');
    eq(asyncErr.message.startsWith('ENOENT: no such file or directory, stat '), true,
        `async error message (${asyncErr.message})`);

    // An exception thrown inside an fs callback is an uncaught exception, not
    // something the event loop swallows. The C completion cannot make that
    // call, so fs wraps every callback it hands down.
    await new Promise(resolve => {
        const onUncaught = err => {
            eq(err.message, 'thrown from an fs callback', 'a throwing callback reaches uncaughtException');
            process.removeListener('uncaughtException', onUncaught);
            resolve();
        };

        process.on('uncaughtException', onUncaught);

        fs.stat(afile, () => {
            throw new Error('thrown from an fs callback');
        });
    });

    // --- fs.promises ---------------------------------------------------------
    const pdir = await fs.promises.mkdtemp('/tmp/t2fsp-');
    const pfile = path.join(pdir, 'p.txt');

    await fs.promises.writeFile(pfile, 'promised');
    eq(await fs.promises.readFile(pfile, 'utf8'), 'promised', 'promises writeFile/readFile');
    eq((await fs.promises.stat(pfile)).isFile(), true, 'promises stat');
    eq((await fs.promises.readdir(pdir)).join(), 'p.txt', 'promises readdir');
    eq(typeof fs.promises.constants.O_RDONLY, 'number', 'promises carries constants');
    await rejects(fs.promises.readFile(path.join(pdir, 'nope')), 'ENOENT', 'promises reject with the code');
    await fs.promises.rm(pdir, { recursive: true });
    eq(fs.existsSync(pdir), false, 'promises rm');

    // --- createReadStream / createWriteStream --------------------------------
    const sfile = path.join(adir, 'stream.txt');

    await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(sfile);
        const opened = [];

        ws.on('open', fd => opened.push(typeof fd));
        ws.on('error', reject);
        ws.on('close', () => {
            eq(opened.join(), 'number', "createWriteStream emits 'open' with a descriptor");
            eq(ws.bytesWritten, 11, 'WriteStream.bytesWritten');
            resolve();
        });

        ws.write('hello ');
        ws.write('world');
        ws.end();
    });

    eq(fs.readFileSync(sfile, 'utf8'), 'hello world', 'createWriteStream contents');

    // cork/uncork routes through _writev, which is the batching path the SPI
    // port depends on; here it just has to produce the same bytes.
    await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(path.join(adir, 'corked.txt'));

        ws.on('error', reject);
        ws.on('close', resolve);
        ws.cork();
        ws.write('a');
        ws.write('b');
        ws.write('c');
        ws.uncork();
        ws.end();
    });

    eq(fs.readFileSync(path.join(adir, 'corked.txt'), 'utf8'), 'abc', 'corked writes reach the file in order');

    const streamed = await new Promise((resolve, reject) => {
        const chunks = [];
        const rs = fs.createReadStream(sfile, { encoding: 'utf8' });

        rs.on('data', chunk => chunks.push(chunk));
        rs.on('error', reject);
        rs.on('end', () => resolve(chunks.join('')));
    });

    eq(streamed, 'hello world', 'createReadStream reads the whole file');

    const sliced = await new Promise((resolve, reject) => {
        const chunks = [];
        const rs = fs.createReadStream(sfile, { start: 6, end: 10 });

        rs.on('data', chunk => chunks.push(chunk));
        rs.on('error', reject);
        rs.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });

    eq(sliced, 'world', 'createReadStream honors start and end');

    await new Promise(resolve => {
        const rs = fs.createReadStream(path.join(adir, 'nope'));

        rs.on('error', err => {
            eq(err.code, 'ENOENT', 'createReadStream on a missing file emits ENOENT');
            resolve();
        });
    });

    // piping one into the other, which is what era code actually does with these
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(path.join(adir, 'piped.txt'));

        out.on('error', reject);
        out.on('close', resolve);
        fs.createReadStream(sfile).pipe(out);
    });

    eq(fs.readFileSync(path.join(adir, 'piped.txt'), 'utf8'), 'hello world', 'read stream pipes into write stream');

    // --- vectored I/O ---------------------------------------------------------
    const vfd = await call(fs.open, path.join(adir, 'vec.txt'), 'w');

    eq((await call(fs.writev, vfd, [Buffer.from('abc'), Buffer.from('de')]))[0], 5, 'writev byte count');
    await call(fs.close, vfd);
    eq(fs.readFileSync(path.join(adir, 'vec.txt'), 'utf8'), 'abcde', 'writev contents in order');

    const rvfd = await call(fs.open, path.join(adir, 'vec.txt'), 'r');
    const vbufs = [Buffer.alloc(3), Buffer.alloc(2)];

    eq((await call(fs.readv, rvfd, vbufs))[0], 5, 'readv byte count');
    eq(vbufs[0].toString() + vbufs[1].toString(), 'abcde', 'readv fills the buffers in order');
    await call(fs.close, rvfd);

    const svfd = fs.openSync(path.join(adir, 'vecs.txt'), 'w');

    eq(fs.writevSync(svfd, [Buffer.from('xy'), Buffer.from('z')]), 3, 'writevSync byte count');
    fs.closeSync(svfd);
    eq(fs.readFileSync(path.join(adir, 'vecs.txt'), 'utf8'), 'xyz', 'writevSync contents');

    // --- opendir / Dir --------------------------------------------------------
    const dirHandle = await call(fs.opendir, path.join(adir, 'sub'));

    eq(dirHandle.path, path.join(adir, 'sub'), 'Dir.path');

    const firstEntry = await dirHandle.read();

    eq(firstEntry.name, 'b.txt', 'Dir.read yields a Dirent');
    eq(firstEntry.isFile(), true, 'Dir entries are Dirents');
    eq(await dirHandle.read(), null, 'Dir.read returns null at the end');
    await dirHandle.close();

    const iterated = [];

    for await (const entry of await call(fs.opendir, path.join(adir, 'sub'))) {
        iterated.push(entry.name);
    }

    eq(iterated.join(), 'b.txt', 'Dir is async-iterable');

    const syncDir = fs.opendirSync(path.join(adir, 'sub'));

    eq(syncDir.readSync().name, 'b.txt', 'opendirSync + readSync');
    eq(syncDir.readSync(), null, 'readSync returns null at the end');
    syncDir.closeSync();

    // --- cp -------------------------------------------------------------------
    fs.mkdirSync(path.join(adir, 'cpsrc', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(adir, 'cpsrc', 'one.txt'), 'one');
    fs.writeFileSync(path.join(adir, 'cpsrc', 'nested', 'two.txt'), 'two');

    // the single-file case, which is what most callers actually use
    await call(fs.cp, path.join(adir, 'cpsrc', 'one.txt'), path.join(adir, 'one-copy.txt'));
    eq(fs.readFileSync(path.join(adir, 'one-copy.txt'), 'utf8'), 'one', 'cp copies a single file');

    fs.cpSync(path.join(adir, 'cpsrc', 'one.txt'), path.join(adir, 'one-copy2.txt'));
    eq(fs.readFileSync(path.join(adir, 'one-copy2.txt'), 'utf8'), 'one', 'cpSync copies a single file');

    await rejects(call(fs.cp, path.join(adir, 'cpsrc'), path.join(adir, 'cpdest')), 'ERR_FS_EISDIR',
        'cp on a directory without recursive');

    await call(fs.cp, path.join(adir, 'cpsrc'), path.join(adir, 'cpdest'), { recursive: true });
    eq(fs.readFileSync(path.join(adir, 'cpdest', 'one.txt'), 'utf8'), 'one', 'recursive cp copies files');
    eq(fs.readFileSync(path.join(adir, 'cpdest', 'nested', 'two.txt'), 'utf8'), 'two',
        'recursive cp descends');

    fs.cpSync(path.join(adir, 'cpsrc'), path.join(adir, 'cpdest2'), { recursive: true });
    eq(fs.readFileSync(path.join(adir, 'cpdest2', 'nested', 'two.txt'), 'utf8'), 'two', 'recursive cpSync');

    // --- FileHandle -----------------------------------------------------------
    const handle = await fs.promises.open(path.join(adir, 'fh.txt'), 'w+');

    eq(typeof handle.fd, 'number', 'FileHandle carries a descriptor');

    const written = await handle.write('through a handle');

    eq(written.bytesWritten, 16, 'FileHandle.write reports bytesWritten');
    eq((await handle.stat()).size, 16, 'FileHandle.stat');

    const hbuf = Buffer.alloc(7);
    const hread = await handle.read(hbuf, 0, 7, 0);

    eq(hread.bytesRead, 7, 'FileHandle.read reports bytesRead');
    eq(hbuf.toString(), 'through', 'FileHandle.read fills the buffer');
    // readFile on a handle reads from the *current* position, which the write
    // above left at EOF — so this is empty, and that is Node's behavior too.
    eq(await handle.readFile('utf8'), '', 'FileHandle.readFile reads from the current position');

    await handle.truncate(7);
    eq((await handle.stat()).size, 7, 'FileHandle.truncate');
    await handle.sync();
    await handle.close();

    eq(fs.readFileSync(path.join(adir, 'fh.txt'), 'utf8'), 'through', 'FileHandle wrote to the file');

    const rehandle = await fs.promises.open(path.join(adir, 'fh.txt'), 'r');

    eq(await rehandle.readFile('utf8'), 'through', 'a fresh FileHandle reads from the start');
    await rehandle.close();

    // --- recursive removal ---------------------------------------------------
    await rejects(call(fs.rm, path.join(adir, 'p')), 'ERR_FS_EISDIR', 'async rm on a directory');
    await call(fs.rm, path.join(adir, 'p'), { recursive: true });
    eq(fs.existsSync(path.join(adir, 'p')), false, 'async recursive rm');
    eq(await call(fs.rm, path.join(adir, 'gone'), { force: true }), undefined, 'async rm force');

    await call(fs.rm, adir, { recursive: true, force: true });
    eq(fs.existsSync(adir), false, 'async scratch directory removed');
}

asyncTests().then(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    eq(fs.existsSync(dir), false, 'scratch directory removed');

    console.log(fail === 0 ? 'FS: all pass' : `FS: ${fail} FAILURES`);
    process.exitCode = fail === 0 ? 0 : 1;
}, err => {
    console.log('FS: async tests threw ->', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
