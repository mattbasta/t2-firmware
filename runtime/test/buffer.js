// Buffer conformance.

let fail = 0;
const eq = (actual, expected, label) => {
    if (String(actual) !== String(expected)) {
        fail++;
        console.log('FAIL', label, '->', actual, '!=', expected);
    }
};

// identity
eq(Buffer.from('abc') instanceof Uint8Array, true, 'instanceof Uint8Array');
eq(Buffer.isBuffer(Buffer.alloc(3)), true, 'isBuffer');
eq(new Buffer('hi').toString(), 'hi', 'legacy new Buffer(string)');
eq(new Buffer(3).length, 3, 'legacy new Buffer(size)');

// enumerability: Node's Buffer is a function with members assigned onto it, so
// they are enumerable. safer-buffer rebuilds Buffer with for..in and gets an
// empty object if they are not, which iconv-lite then calls .from on.
eq(Object.keys(Buffer).includes('from'), true, 'Buffer statics are enumerable');
eq(Object.keys(Buffer).includes('alloc'), true, 'Buffer.alloc enumerable');
eq(Object.keys(Buffer.prototype).includes('toString'), true, 'prototype methods enumerable');
eq(Object.keys(Buffer.prototype).includes('readUInt32BE'), true, 'read/write matrix enumerable');

// encodings
eq(Buffer.from('Hello').toString('hex'), '48656c6c6f', 'utf8 -> hex');
eq(Buffer.from('48656c6c6f', 'hex').toString(), 'Hello', 'hex -> utf8');
eq(Buffer.from('Hello').toString('base64'), 'SGVsbG8=', 'utf8 -> base64');
eq(Buffer.from('SGVsbG8=', 'base64').toString(), 'Hello', 'base64 -> utf8');
eq(Buffer.from('f+/g', 'base64').toString('base64url'), 'f-_g', 'base64url');
eq(Buffer.from('Hello', 'latin1').toString('latin1'), 'Hello', 'latin1 round-trip');
eq(Buffer.from([0xff]).toString('latin1').charCodeAt(0), 255, 'latin1 high byte');
eq(Buffer.from('Hello', 'utf16le').toString('utf16le'), 'Hello', 'utf16le round-trip');
eq(Buffer.from('Hello', 'ascii').toString('ascii'), 'Hello', 'ascii round-trip');
eq(Buffer.from('héllo').length, 6, 'utf8 byte length');
eq(Buffer.byteLength('héllo'), 6, 'byteLength');
eq(Buffer.isEncoding('utf-8'), true, 'isEncoding');
eq(Buffer.isEncoding('nope'), false, 'isEncoding rejects');

// slice shares memory — Node semantics, not Uint8Array's
const base = Buffer.from([1, 2, 3, 4]);
const slice = base.slice(1, 3);
slice[0] = 99;
eq(base[1], 99, 'slice shares memory');
eq(Buffer.isBuffer(slice), true, 'slice returns a Buffer');

// bulk operations
eq(Buffer.concat([Buffer.from('ab'), Buffer.from('cd')]).toString(), 'abcd', 'concat');
eq(Buffer.concat([Buffer.from('ab')], 4).length, 4, 'concat with totalLength pads');
eq(Buffer.from('abc').equals(Buffer.from('abc')), true, 'equals');
eq(Buffer.from('abc').compare(Buffer.from('abd')), -1, 'compare');
eq(Buffer.from('hello').indexOf('ll'), 2, 'indexOf string');
eq(Buffer.from('hello').lastIndexOf('l'), 3, 'lastIndexOf');
eq(Buffer.from('hello').includes(108), true, 'includes byte');
eq(Buffer.alloc(4, 'ab').toString(), 'abab', 'fill with a string');
eq(JSON.stringify(Buffer.from([1, 2])), '{"type":"Buffer","data":[1,2]}', 'toJSON');
eq(Buffer.from([1, 2, 3, 4]).swap32().toString('hex'), '04030201', 'swap32');

// read/write matrix
const rw = Buffer.alloc(8);
rw.writeUInt32BE(0xdeadbeef, 0);
eq(rw.readUInt32BE(0), 0xdeadbeef, 'uint32 BE');
rw.writeUInt32LE(0xdeadbeef, 0);
eq(rw.readUInt32LE(0), 0xdeadbeef, 'uint32 LE');
rw.writeInt32LE(-123456, 0);
eq(rw.readInt32LE(0), -123456, 'int32 LE');
rw.writeInt16BE(-1234, 0);
eq(rw.readInt16BE(0), -1234, 'int16 BE');
rw.writeInt8(-42, 0);
eq(rw.readInt8(0), -42, 'int8');
rw.writeFloatLE(1.5, 0);
eq(rw.readFloatLE(0), 1.5, 'float LE');
rw.writeDoubleBE(Math.PI, 0);
eq(rw.readDoubleBE(0), Math.PI, 'double BE');
rw.writeUIntLE(0x010203, 0, 3);
eq(rw.readUIntLE(0, 3), 0x010203, 'uintLE(3)');
rw.writeIntBE(-300, 0, 3);
eq(rw.readIntBE(0, 3), -300, 'intBE(3)');
rw.writeBigUInt64LE(2n ** 40n, 0);
eq(rw.readBigUInt64LE(0), 2n ** 40n, 'biguint64 LE');
eq(typeof rw.readUint32LE, 'function', 'Node 14 Uint alias');

try {
    Buffer.alloc(2).readUInt32LE(0);
    fail++;
    console.log('FAIL out-of-range read did not throw');
} catch (err) {
    eq(err.code, 'ERR_OUT_OF_RANGE', 'bounds check');
}

console.log(fail === 0 ? 'BUFFER: all pass' : `BUFFER: ${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
