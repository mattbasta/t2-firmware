// stream conformance — the ported readable-stream plus Node's legacy base.

const stream = require('stream');
const { Readable, Writable, Duplex, Transform, PassThrough, pipeline, finished } = stream;

let fail = 0;
const eq = (actual, expected, label) => {
    if (String(actual) !== String(expected)) {
        fail++;
        console.log('FAIL', label, '->', actual, '!=', expected);
    }
};

function collect(readable) {
    return new Promise((resolve, reject) => {
        const chunks = [];

        readable.on('data', chunk => chunks.push(chunk));
        readable.on('end', () => resolve(chunks));
        readable.on('error', reject);
    });
}

function sink(target) {
    return new Writable({
        write(chunk, encoding, cb) {
            target.push(chunk.toString());
            cb();
        }
    });
}

async function main() {
    // --- shape ---------------------------------------------------------------
    eq(stream === stream.Stream, true, 'module export is the Stream constructor');
    eq(typeof stream.Stream.prototype.pipe, 'function', 'legacy Stream has pipe');
    eq(new Readable({ read() {} }) instanceof stream.Stream, true, 'Readable instanceof Stream');
    eq(new Writable({ write() {} }) instanceof stream.Stream, true, 'Writable instanceof Stream');
    eq(new Duplex({ read() {}, write() {} }) instanceof Readable, true, 'Duplex instanceof Readable');
    eq(new Transform() instanceof Duplex, true, 'Transform instanceof Duplex');
    eq(new PassThrough() instanceof Transform, true, 'PassThrough instanceof Transform');

    // --- readable ------------------------------------------------------------
    const readable = new Readable({
        read() {
            this.push('one');
            this.push('two');
            this.push(null);
        }
    });

    eq((await collect(readable)).join('|'), 'one|two', 'Readable push/data/end');

    const encoded = new Readable({ encoding: 'utf8', read() { this.push(Buffer.from('héllo')); this.push(null); } });
    eq((await collect(encoded))[0], 'héllo', 'Readable with encoding decodes');

    const objects = new Readable({ objectMode: true, read() { this.push({ n: 1 }); this.push(null); } });
    eq((await collect(objects))[0].n, 1, 'objectMode preserves objects');

    // --- writable ------------------------------------------------------------
    const written = [];
    const writable = sink(written);

    await new Promise(resolve => {
        writable.on('finish', resolve);
        writable.write('a');
        writable.write('b');
        writable.end();
    });

    eq(written.join(''), 'ab', 'Writable write/end/finish');

    // --- pipe ----------------------------------------------------------------
    const piped = [];

    await new Promise(resolve => {
        const src = new Readable({ read() { this.push('x'); this.push('y'); this.push(null); } });

        src.pipe(sink(piped)).on('finish', resolve);
    });

    eq(piped.join(''), 'xy', 'pipe');

    // --- transform -----------------------------------------------------------
    const upper = new Transform({
        transform(chunk, encoding, cb) {
            cb(null, chunk.toString().toUpperCase());
        }
    });

    const transformed = [];

    await new Promise(resolve => {
        const src = new Readable({ read() { this.push('ab'); this.push(null); } });

        src.pipe(upper).pipe(sink(transformed)).on('finish', resolve);
    });

    eq(transformed.join(''), 'AB', 'Transform');

    // --- duplex, the shape tessel-export.js uses for UART ---------------------
    const sent = [];

    class Port extends Duplex {
        _write(chunk, encoding, cb) {
            sent.push(chunk.toString());
            cb();
        }

        _read() {
            this.push('rx');
            this.push(null);
        }
    }

    const port = new Port();

    port.write('tx');
    eq(sent.join(''), 'tx', 'Duplex writable half');
    eq((await collect(port)).join(''), 'rx', 'Duplex readable half');

    // --- Readable.from -------------------------------------------------------
    eq(typeof Readable.from, 'function', 'Readable.from exists');
    eq((await collect(Readable.from(['p', 'q']))).join(''), 'pq', 'Readable.from(iterable)');

    async function* generate() {
        yield 'g1';
        yield 'g2';
    }

    eq((await collect(Readable.from(generate()))).join('|'), 'g1|g2', 'Readable.from(async iterable)');

    // --- async iteration -----------------------------------------------------
    const iterated = [];

    for await (const chunk of Readable.from(['i1', 'i2'])) {
        iterated.push(chunk);
    }

    eq(iterated.join('|'), 'i1|i2', 'for await over a Readable');

    // --- pipeline and finished ----------------------------------------------
    const pipelined = [];

    await new Promise((resolve, reject) => {
        pipeline(
            Readable.from(['1', '2']),
            new PassThrough(),
            sink(pipelined),
            err => (err ? reject(err) : resolve())
        );
    });

    eq(pipelined.join(''), '12', 'pipeline');

    const promised = [];

    await stream.promises.pipeline(Readable.from(['3']), sink(promised));
    eq(promised.join(''), '3', 'stream.promises.pipeline');

    await stream.promises.finished(Readable.from(['4']).resume());
    eq(true, true, 'stream.promises.finished resolves');

    // --- errors --------------------------------------------------------------
    let caught = null;

    try {
        await new Promise((resolve, reject) => {
            pipeline(
                new Readable({ read() { this.destroy(new Error('source failed')); } }),
                new PassThrough(),
                sink([]),
                err => (err ? reject(err) : resolve())
            );
        });
    } catch (err) {
        caught = err;
    }

    eq(caught && caught.message, 'source failed', 'pipeline propagates a source error');

    const destroyed = new Readable({ read() {} });
    let destroyError = null;

    destroyed.on('error', err => { destroyError = err; });
    destroyed.destroy(new Error('boom'));
    await new Promise(resolve => setTimeout(resolve, 0));
    eq(destroyError && destroyError.message, 'boom', 'destroy(err) emits error');

    console.log(fail === 0 ? 'STREAM: all pass' : `STREAM: ${fail} FAILURES`);
    process.exitCode = fail === 0 ? 0 : 1;
}

main().catch(err => {
    console.log('STREAM: threw', err && err.stack);
    process.exitCode = 1;
});
