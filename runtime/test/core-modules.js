// Step 4 core modules: events, util, assert, querystring, string_decoder, url.

let fail = 0;
const eq = (actual, expected, label) => {
    if (String(actual) !== String(expected)) {
        fail++;
        console.log('FAIL', label, '->', actual, '!=', expected);
    }
};
const throws = (fn, label) => {
    try {
        fn();
        fail++;
        console.log('FAIL', label, '-> did not throw');
    } catch { /* expected */ }
};

// --- events (harvested) -----------------------------------------------------
const EventEmitter = require('events');
eq(typeof EventEmitter, 'function', 'events exports the constructor');
eq(EventEmitter.EventEmitter === EventEmitter, true, 'events.EventEmitter self-reference');

const emitter = new EventEmitter();
let seen = [];
emitter.on('data', v => seen.push(`on:${v}`));
emitter.once('data', v => seen.push(`once:${v}`));
emitter.emit('data', 1);
emitter.emit('data', 2);
eq(seen.join(','), 'on:1,once:1,on:2', 'on/once semantics');
eq(emitter.listenerCount('data'), 1, 'listenerCount after once fired');

emitter.removeAllListeners();
eq(emitter.listenerCount('data'), 0, 'removeAllListeners');

// 'error' with no listener throws — the behaviour everything relies on
throws(() => new EventEmitter().emit('error', new Error('boom')), 'unhandled error event throws');

class Sub extends EventEmitter {}
const sub = new Sub();
let inherited = false;
sub.on('x', () => { inherited = true; });
sub.emit('x');
eq(inherited, true, 'subclassing works');

// --- util -------------------------------------------------------------------
const util = require('util');
eq(util.format('%s:%d', 'a', 5), 'a:5', 'format %s %d');
eq(util.format('%j', { a: 1 }), '{"a":1}', 'format %j');
eq(util.format('%i', '42abc'), '42', 'format %i');
eq(util.format('%%'), '%', 'format %%');
eq(util.format('a', 'b'), 'a b', 'format extra args');
eq(util.format('%s', { a: 1 }), '{ a: 1 }', 'format %s on object');
eq(util.inspect({ a: 1, b: 'x' }), "{ a: 1, b: 'x' }", 'inspect object');
eq(util.inspect([1, 2]), '[ 1, 2 ]', 'inspect array');
eq(util.inspect('s'), "'s'", 'inspect string quotes');
eq(util.inspect(null), 'null', 'inspect null');
eq(util.inspect(-0), '-0', 'inspect negative zero');
const circular = { a: 1 };
circular.self = circular;
eq(util.inspect(circular).includes('[Circular'), true, 'inspect circular');
eq(util.inspect(Buffer.from([1, 255])), '<Buffer 01 ff>', 'inspect Buffer');

// the is* family Node removed in v23
eq(util.isArray([]), true, 'util.isArray');
eq(util.isBuffer(Buffer.alloc(1)), true, 'util.isBuffer');
eq(util.isDate(new Date()), true, 'util.isDate');
eq(util.isRegExp(/x/), true, 'util.isRegExp');
eq(util.isNullOrUndefined(undefined), true, 'util.isNullOrUndefined');
eq(util.isPrimitive('x'), true, 'util.isPrimitive');
eq(util.isObject({}), true, 'util.isObject');
eq(util.isObject([]), false, 'util.isObject rejects arrays');

// inherits
function Base() {}
Base.prototype.greet = function () { return 'hi'; };
function Derived() {}
util.inherits(Derived, Base);
eq(new Derived().greet(), 'hi', 'util.inherits');
eq(Derived.super_ === Base, true, 'util.inherits sets super_');

eq(util.types.isDate(new Date()), true, 'util.types.isDate');
eq(util.isDeepStrictEqual({ a: [1] }, { a: [1] }), true, 'util.isDeepStrictEqual');

// --- assert -----------------------------------------------------------------
const assert = require('assert');
assert.ok(true);
assert.equal('1', 1);
assert.strictEqual(1, 1);
assert.notStrictEqual(1, '1');
assert.deepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] });
assert.deepStrictEqual(new Map([['k', 1]]), new Map([['k', 1]]));
assert.deepStrictEqual(new Set([1, 2]), new Set([2, 1]));
assert.deepStrictEqual(Buffer.from([1, 2]), Buffer.from([1, 2]));
assert.deepEqual({ a: '1' }, { a: 1 });
throws(() => assert.deepStrictEqual({ a: '1' }, { a: 1 }), 'deepStrictEqual is strict about leaves');
throws(() => assert.deepStrictEqual([1], [1, 2]), 'deepStrictEqual length');
throws(() => assert.strictEqual(1, 2), 'strictEqual mismatch throws');
assert.notDeepStrictEqual({ a: 1 }, { a: 2 });

// NaN is equal to itself here; +0 and -0 are not
assert.deepStrictEqual(NaN, NaN);
throws(() => assert.strictEqual(0, -0), 'strictEqual distinguishes -0');

// cycles must terminate rather than blow the stack
const cyclicA = { name: 'x' };
cyclicA.self = cyclicA;
const cyclicB = { name: 'x' };
cyclicB.self = cyclicB;
assert.deepStrictEqual(cyclicA, cyclicB);

assert.throws(() => { throw new TypeError('bad'); }, TypeError);
assert.throws(() => { throw new Error('nope'); }, /nope/);
assert.doesNotThrow(() => {});
assert.ifError(null);
assert.match('hello', /ell/);

try {
    assert.strictEqual(1, 2, 'custom message');
    fail++;
    console.log('FAIL AssertionError not thrown');
} catch (err) {
    eq(err.name, 'AssertionError', 'AssertionError name');
    eq(err.code, 'ERR_ASSERTION', 'AssertionError code');
    eq(err.message, 'custom message', 'AssertionError custom message');
    eq(err.generatedMessage, false, 'generatedMessage false with custom message');
    eq(err.actual, 1, 'AssertionError actual');
}

eq(assert.strict.equal === assert.strictEqual, true, 'assert.strict aliases equal');

// A string second argument is the message, not a matcher. Getting this wrong
// makes assert.throws rethrow the caller's error instead of asserting.
assert.throws(() => { throw new Error('boom'); }, 'Error: boom');
throws(() => assert.throws(() => {}, 'some message'), 'throws still fails when nothing is thrown');

// --- querystring ------------------------------------------------------------
const qs = require('querystring');
eq(JSON.stringify(qs.parse('a=1&b=2')), '{"a":"1","b":"2"}', 'qs.parse');
eq(JSON.stringify(qs.parse('a=1&a=2')), '{"a":["1","2"]}', 'qs.parse repeated key');
eq(JSON.stringify(qs.parse('a')), '{"a":""}', 'qs.parse bare key');
eq(qs.parse('a=hello+world').a, 'hello world', 'qs.parse decodes + as space');
eq(qs.parse('a=%2F').a, '/', 'qs.parse percent-decodes');
eq(qs.stringify({ a: 1, b: 'x y' }), 'a=1&b=x%20y', 'qs.stringify');
eq(qs.stringify({ a: [1, 2] }), 'a=1&a=2', 'qs.stringify array');
eq(qs.parse('a=%E0%A4%A').a, '%E0%A4%A', 'qs.parse tolerates malformed escapes');

// --- string_decoder (harvested) ---------------------------------------------
const { StringDecoder } = require('string_decoder');
const decoder = new StringDecoder('utf8');
const multibyte = Buffer.from('héllo');
eq(decoder.write(multibyte.slice(0, 2)) + decoder.write(multibyte.slice(2)), 'héllo',
    'string_decoder holds a partial sequence across chunks');

// --- url --------------------------------------------------------------------
const url = require('url');
const parsed = url.parse('http://user:pw@example.com:8080/a/b?x=1#frag');
eq(parsed.protocol, 'http:', 'url.parse protocol');
eq(parsed.hostname, 'example.com', 'url.parse hostname');
eq(parsed.port, '8080', 'url.parse port');
eq(parsed.pathname, '/a/b', 'url.parse pathname');
eq(parsed.search, '?x=1', 'url.parse search');
eq(parsed.hash, '#frag', 'url.parse hash');
eq(parsed.auth, 'user:pw', 'url.parse auth');
eq(parsed.path, '/a/b?x=1', 'url.parse path');
eq(url.parse('http://h/?x=1&y=2', true).query.y, '2', 'url.parse with query parsing');
eq(url.parse('/just/a/path').pathname, '/just/a/path', 'url.parse relative');
eq(url.format({ protocol: 'https:', host: 'a.com', pathname: '/p' }), 'https://a.com/p', 'url.format');
eq(url.resolve('http://a.com/one/two', 'three'), 'http://a.com/one/three', 'url.resolve relative');
eq(url.resolve('http://a.com/one/two', '/root'), 'http://a.com/root', 'url.resolve absolute path');
eq(url.URL === URL, true, 'url re-exports WHATWG URL');
eq(new url.URL('http://x/p').pathname, '/p', 'WHATWG URL still works');

// --- laziness ---------------------------------------------------------------
//
// Not a Node behavior, so it lives here rather than in the differential fs
// suite. Every core module is a separate bytecode blob that costs nothing until
// something requires it (phase1-plan.md §3), and node:stream is the largest of
// them. fs.createReadStream needs it, but fs itself must not: a program that
// only calls fs.writeFileSync on a sysfs node should never deserialize the
// stream bundle. What makes that true is that fs reaches for stream inside
// getStreamClasses() and exposes the constructors as getters — so if someone
// moves that require to the top of the file, this assertion is what notices.
const fsModule = require('fs');
const readStreamDescriptor = Object.getOwnPropertyDescriptor(fsModule, 'ReadStream');

eq(typeof readStreamDescriptor.get, 'function', 'fs.ReadStream is deferred behind a getter');
eq(readStreamDescriptor.value, undefined, 'fs.ReadStream is not a materialized value');
eq(typeof fsModule.ReadStream, 'function', 'touching fs.ReadStream produces the constructor');
eq(fsModule.ReadStream.prototype instanceof require('stream').Readable, true,
    'fs.ReadStream extends the real stream.Readable');

console.log(fail === 0 ? 'CORE MODULES: all pass' : `CORE MODULES: ${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
