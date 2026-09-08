// process conformance. Run with two extra arguments: `process.js one two`.

let fail = 0;
const eq = (actual, expected, label) => {
    if (String(actual) !== String(expected)) {
        fail++;
        console.log('FAIL', label, '->', actual, '!=', expected);
    }
};

// argv
eq(process.argv.length, 4, 'argv length');
eq(process.argv[0], process.execPath, 'argv[0] is execPath');
eq(process.argv[1].endsWith('/process.js'), true, 'argv[1] is the resolved script');
eq(process.argv[2] + process.argv[3], 'onetwo', 'argv passthrough');

// identity
eq(['linux', 'darwin'].includes(process.platform), true, `platform (${process.platform})`);
eq(typeof process.arch === 'string' && process.arch !== 'unknown', true, `arch (${process.arch})`);
eq(typeof process.pid, 'number', 'pid');
eq(typeof process.env, 'object', 'env');
eq(process.cwd().startsWith('/'), true, 'cwd is absolute');
eq(typeof process.versions.node, 'string', 'versions.node');
eq(typeof process.versions.quickjs, 'string', 'versions.quickjs');
eq(globalThis.GLOBAL === globalThis, true, 'GLOBAL alias restored');
eq(typeof setImmediate, 'function', 'setImmediate');

// hrtime
const t0 = process.hrtime();
eq(Array.isArray(t0) && t0.length === 2, true, 'hrtime shape');
const delta = process.hrtime(t0);
eq(delta[0] === 0 && delta[1] >= 0, true, 'hrtime difference');
eq(typeof process.hrtime.bigint(), 'bigint', 'hrtime.bigint');

// stdio, text and binary
process.stdout.write('');
process.stdout.write(Buffer.alloc(0));
eq(typeof process.stdout.isTTY, 'boolean', 'stdout.isTTY');
eq(process.stdout.fd, 1, 'stdout.fd');

// ordering: Node drains nextTick before promise jobs, and both before timers
const order = [];
setTimeout(() => order.push('timeout'), 0);
setImmediate(() => order.push('immediate'));
Promise.resolve().then(() => order.push('promise'));
process.nextTick(() => order.push('tick'));
order.push('sync');

process.on('exit', code => {
    eq(order.join(','), 'sync,tick,promise,timeout,immediate', 'callback ordering');
    eq(code, fail === 0 ? 0 : 1, 'exit event receives the code');
    console.log(fail === 0 ? 'PROCESS: all pass' : `PROCESS: ${fail} FAILURES`);
});

process.exitCode = fail === 0 ? 0 : 1;
