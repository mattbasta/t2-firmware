// Era-package corpus.
//
// Third-party code nobody on this project wrote, which is the only kind that
// finds the bugs our own tests are blind to — the same reason running the
// harvested events module against its own upstream suite turned up two real
// defects that runtime/test/*.js had missed.
//
// Run runtime/test/corpus/fetch.sh first; without it this exits 0 with a note,
// so a fresh checkout does not fail for want of a network.
//
// Three of the packages the strategy names — debug, rimraf, graceful-fs — need
// fs or tty, which arrive in Phase 2. They are still worth having here now: we
// assert that they *resolve* through a real node_modules tree and fail exactly
// at the boundary we expect, which tests the loader and turns Phase 2 into a
// matter of deleting these assertions.

let fail = 0;
const eq = (actual, expected, label) => {
    if (String(actual) !== String(expected)) {
        fail++;
        console.log('FAIL', label, '->', actual, '!=', expected);
    }
};

try {
    require.resolve('iconv-lite');
} catch {
    console.log('CORPUS: skipped (run runtime/test/corpus/fetch.sh first)');
    return;
}

// --- iconv-lite: Buffer, encodings, string_decoder, stream ------------------
const iconv = require('iconv-lite');

eq(iconv.decode(Buffer.from([0x68, 0x69]), 'utf8'), 'hi', 'iconv utf8 decode');
eq(iconv.encode('hi', 'utf8').toString('hex'), '6869', 'iconv utf8 encode');
eq(iconv.decode(Buffer.from([0xe9]), 'latin1'), 'é', 'iconv latin1 decode');
eq(iconv.encode('é', 'latin1').toString('hex'), 'e9', 'iconv latin1 encode');
eq(iconv.decode(iconv.encode('héllo wörld', 'win1252'), 'win1252'), 'héllo wörld', 'iconv win1252 round-trip');
eq(iconv.decode(iconv.encode('日本', 'utf16'), 'utf16'), '日本', 'iconv utf16 round-trip');
eq(iconv.encodingExists('koi8-r'), true, 'iconv encodingExists');

// The streaming half, which reaches our stream and string_decoder
const decodeStream = iconv.decodeStream('utf8');
const collected = [];

decodeStream.on('data', chunk => collected.push(chunk));
decodeStream.write(Buffer.from('héllo').slice(0, 2));
decodeStream.write(Buffer.from('héllo').slice(2));
decodeStream.end();

// --- readable-stream from npm, running on our Buffer/events/util ------------
//
// Distinct from our own port: this is the published package resolving through
// node_modules, requiring inherits, util-deprecate and string_decoder/ (with
// the trailing slash that deliberately bypasses the core module).
const RS = require('readable-stream');

eq(typeof RS.Readable, 'function', 'readable-stream exports Readable');
eq(typeof RS.pipeline, 'function', 'readable-stream exports pipeline');

const piped = [];
const rsSource = new RS.Readable({ read() { this.push('a'); this.push('b'); this.push(null); } });
const rsSink = new RS.Writable({ write(chunk, enc, cb) { piped.push(chunk.toString()); cb(); } });

// --- transitive dependencies resolved through the walk ----------------------
eq(require('ms')('1s'), 1000, 'ms (transitive dep) resolves and runs');
eq(typeof require('inherits'), 'function', 'inherits resolves');
eq(typeof require('util-deprecate'), 'function', 'util-deprecate resolves');
eq(require('safer-buffer').Buffer.from('x').toString(), 'x', 'safer-buffer resolves');

// The trailing slash forces node_modules resolution past the core module.
eq(require('string_decoder/') !== require('string_decoder'), true,
    "require('string_decoder/') reaches the package, not the core module");

// --- packages gated on Phase 2 ----------------------------------------------
for (const [name, missing] of [['debug', 'tty'], ['graceful-fs', 'fs']]) {
    try {
        require(name);
        fail++;
        console.log('FAIL', `${name} loaded, but it needs ${missing} — has Phase 2 landed?`);
    } catch (err) {
        eq(err.code, 'ERR_MODULE_NOT_IMPLEMENTED', `${name} resolves and blocks on a core module`);
        eq(err.message.includes(`'${missing}'`), true, `${name} blocks specifically on ${missing}`);
    }
}

rsSource.pipe(rsSink).on('finish', () => {
    eq(piped.join(''), 'ab', 'readable-stream (npm) pipes on our runtime');
    eq(collected.join(''), 'héllo', 'iconv decodeStream reassembles a split multi-byte char');

    console.log(fail === 0 ? 'CORPUS: all pass' : `CORPUS: ${fail} FAILURES`);
    process.exitCode = fail === 0 ? 0 : 1;
});
