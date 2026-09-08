// Buffer — Node's, as a Uint8Array subclass.
//
// Subclassing is not cosmetic: era code passes Buffers to anything that takes a
// typed array, and `buf instanceof Uint8Array` has to hold. The cost is that a
// few inherited methods have the wrong semantics for Buffer and are overridden
// below — `slice` above all, which in Node shares memory rather than copying.
//
// Encoding conversions lean on the C-backed globals txiki already provides
// (TextEncoder/TextDecoder, atob/btoa) rather than looping in JS: this is hot
// code on a 580 MHz soft-float core.

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

const K_MAX_LENGTH = 0x7fffffff;

// String.fromCharCode.apply is far faster than a per-byte loop, but the argument
// list is bounded by the engine's stack. 4096 is comfortably under it.
const CHUNK = 4096;

function normalizeEncoding(encoding) {
    if (encoding === undefined || encoding === null) {
        return 'utf8';
    }

    switch (String(encoding).toLowerCase()) {
        case 'utf8':
        case 'utf-8':
            return 'utf8';
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
            return 'utf16le';
        case 'latin1':
        case 'binary':
            return 'latin1';
        case 'ascii':
            return 'ascii';
        case 'hex':
            return 'hex';
        case 'base64':
            return 'base64';
        case 'base64url':
            return 'base64url';
        default:
            return null;
    }
}

function assertEncoding(encoding) {
    const normalized = normalizeEncoding(encoding);

    if (normalized === null) {
        const err = new TypeError(`Unknown encoding: ${encoding}`);

        err.code = 'ERR_UNKNOWN_ENCODING';

        throw err;
    }

    return normalized;
}

function binaryString(bytes) {
    let out = '';

    for (let i = 0; i < bytes.length; i += CHUNK) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }

    return out;
}

const HEX = '0123456789abcdef';

function toHex(bytes) {
    let out = '';

    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];

        out += HEX[b >> 4] + HEX[b & 15];
    }

    return out;
}

function hexValue(code) {
    if (code >= 48 && code <= 57) {
        return code - 48;         // 0-9
    }

    if (code >= 97 && code <= 102) {
        return code - 87;         // a-f
    }

    if (code >= 65 && code <= 70) {
        return code - 55;         // A-F
    }

    return -1;
}

// Node stops at the first byte it cannot decode rather than throwing.
function fromHex(str) {
    const out = new Uint8Array(str.length >>> 1);
    let n = 0;

    for (let i = 0; i + 1 < str.length && n < out.length; i += 2) {
        const hi = hexValue(str.charCodeAt(i));
        const lo = hexValue(str.charCodeAt(i + 1));

        if (hi < 0 || lo < 0) {
            break;
        }

        out[n++] = (hi << 4) | lo;
    }

    return out.subarray(0, n);
}

function fromBase64(str, urlSafe) {
    let s = String(str);

    if (urlSafe) {
        s = s.replace(/-/g, '+').replace(/_/g, '/');
    }

    // Node ignores whitespace and tolerates missing padding.
    s = s.replace(/[^A-Za-z0-9+/]/g, '');

    while (s.length % 4 === 1) {
        s = s.slice(0, -1);
    }

    while (s.length % 4 !== 0) {
        s += '=';
    }

    let binary;

    try {
        binary = atob(s);
    } catch {
        return new Uint8Array(0);
    }

    const out = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        out[i] = binary.charCodeAt(i) & 0xff;
    }

    return out;
}

function toBase64(bytes, urlSafe) {
    const b64 = btoa(binaryString(bytes));

    return urlSafe ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64;
}

function fromUtf16le(str) {
    const out = new Uint8Array(str.length * 2);
    const view = new DataView(out.buffer);

    for (let i = 0; i < str.length; i++) {
        view.setUint16(i * 2, str.charCodeAt(i), true);
    }

    return out;
}

function toUtf16le(bytes) {
    const usable = bytes.length - (bytes.length % 2);
    let out = '';

    for (let i = 0; i < usable; i += 2) {
        out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    }

    return out;
}

function fromLatin1(str) {
    const out = new Uint8Array(str.length);

    for (let i = 0; i < str.length; i++) {
        out[i] = str.charCodeAt(i) & 0xff;
    }

    return out;
}

// ascii is latin1 with the high bit dropped on the way in.
function fromAscii(str) {
    const out = new Uint8Array(str.length);

    for (let i = 0; i < str.length; i++) {
        out[i] = str.charCodeAt(i) & 0x7f;
    }

    return out;
}

function toAscii(bytes) {
    let out = '';

    for (let i = 0; i < bytes.length; i += CHUNK) {
        const chunk = bytes.subarray(i, i + CHUNK);
        const masked = new Uint8Array(chunk.length);

        for (let j = 0; j < chunk.length; j++) {
            masked[j] = chunk[j] & 0x7f;
        }

        out += String.fromCharCode.apply(null, masked);
    }

    return out;
}

function encodeString(str, encoding) {
    switch (encoding) {
        case 'utf8':
            return utf8Encoder.encode(str);
        case 'hex':
            return fromHex(str);
        case 'base64':
            return fromBase64(str, false);
        case 'base64url':
            return fromBase64(str, true);
        case 'latin1':
            return fromLatin1(str);
        case 'ascii':
            return fromAscii(str);
        case 'utf16le':
            return fromUtf16le(str);
        default:
            return utf8Encoder.encode(str);
    }
}

function decodeBytes(bytes, encoding) {
    switch (encoding) {
        case 'utf8':
            return utf8Decoder.decode(bytes);
        case 'hex':
            return toHex(bytes);
        case 'base64':
            return toBase64(bytes, false);
        case 'base64url':
            return toBase64(bytes, true);
        case 'latin1':
            // Not TextDecoder: txiki's only speaks utf-8, and String.fromCharCode
            // over the raw bytes *is* latin1 by definition.
            return binaryString(bytes);
        case 'ascii':
            return toAscii(bytes);
        case 'utf16le':
            return toUtf16le(bytes);
        default:
            return utf8Decoder.decode(bytes);
    }
}

// Scratch space for float and 64-bit conversions: reusing one 8-byte view keeps
// these allocation-free, which a per-call `new DataView` would not be.
const scratch = new ArrayBuffer(8);
const scratchView = new DataView(scratch);
const scratchBytes = new Uint8Array(scratch);

function outOfRange(name, range, value) {
    const err = new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${value}`);

    err.code = 'ERR_OUT_OF_RANGE';

    return err;
}

function checkBounds(buf, offset, size) {
    if (typeof offset !== 'number' || offset < 0 || offset + size > buf.length) {
        throw outOfRange('offset', `>= 0 and <= ${Math.max(buf.length - size, 0)}`, offset);
    }
}

class Buffer extends Uint8Array {
    // Deprecated since Node 6 and still everywhere in era code, so it works.
    constructor(value, encodingOrOffset, length) {
        if (typeof value === 'number') {
            super(value < 0 ? 0 : value);
        } else if (typeof value === 'string') {
            const bytes = encodeString(value, assertEncoding(encodingOrOffset));

            super(bytes.length);
            this.set(bytes);
        } else if (value instanceof ArrayBuffer) {
            // Also the path the engine takes for subarray(), which calls the
            // species constructor as (buffer, byteOffset, length).
            if (encodingOrOffset === undefined) {
                super(value);
            } else if (length === undefined) {
                super(value, encodingOrOffset);
            } else {
                super(value, encodingOrOffset, length);
            }
        } else if (value === null || value === undefined) {
            throw new TypeError(
                'The first argument must be of type string or an instance of Buffer, ' +
                `ArrayBuffer, or Array. Received ${value}`
            );
        } else {
            super(value);
        }
    }

    static from(value, encodingOrOffset, length) {
        if (typeof value === 'string') {
            return new Buffer(value, encodingOrOffset);
        }

        if (value instanceof ArrayBuffer) {
            return new Buffer(value, encodingOrOffset, length);
        }

        if (value === null || value === undefined) {
            throw new TypeError(
                'The first argument must be of type string or an instance of Buffer, ' +
                `ArrayBuffer, or Array. Received ${value}`
            );
        }

        // Typed arrays, arrays, and array-likes all copy.
        if (typeof value === 'object' && typeof value.valueOf === 'function' && value.valueOf() !== value) {
            return Buffer.from(value.valueOf(), encodingOrOffset, length);
        }

        return new Buffer(value);
    }

    static alloc(size, fill, encoding) {
        const buf = new Buffer(size);

        if (fill !== undefined && fill !== 0) {
            buf.fill(fill, 0, buf.length, encoding);
        }

        return buf;
    }

    // No pool here: Node's allocUnsafe hands back a slice of a shared pool, which
    // trades predictable memory for speed. On a 64 MB board the trade is the wrong
    // way round, so this is just alloc, and the name keeps era code working.
    static allocUnsafe(size) {
        return new Buffer(size);
    }

    static allocUnsafeSlow(size) {
        return new Buffer(size);
    }

    static isBuffer(obj) {
        return obj instanceof Buffer;
    }

    static isEncoding(encoding) {
        return normalizeEncoding(encoding) !== null;
    }

    static byteLength(value, encoding) {
        if (typeof value !== 'string') {
            if (ArrayBuffer.isView(value)) {
                return value.byteLength;
            }

            if (value instanceof ArrayBuffer) {
                return value.byteLength;
            }

            throw new TypeError('The "string" argument must be of type string or an instance of Buffer or ArrayBuffer');
        }

        const enc = assertEncoding(encoding);

        switch (enc) {
            case 'ascii':
            case 'latin1':
                return value.length;
            case 'utf16le':
                return value.length * 2;
            case 'hex':
                return value.length >>> 1;
            default:
                return encodeString(value, enc).length;
        }
    }

    static concat(list, totalLength) {
        if (!Array.isArray(list)) {
            throw new TypeError('The "list" argument must be an instance of Array');
        }

        if (list.length === 0) {
            return Buffer.alloc(0);
        }

        let total = totalLength;

        if (total === undefined) {
            total = 0;

            for (const buf of list) {
                total += buf.length;
            }
        }

        const out = Buffer.allocUnsafe(total);
        let offset = 0;

        for (const buf of list) {
            if (offset >= total) {
                break;
            }

            const chunk = offset + buf.length > total ? buf.subarray(0, total - offset) : buf;

            out.set(chunk, offset);
            offset += chunk.length;
        }

        // A short list against an explicit totalLength leaves a zeroed tail.
        if (offset < total) {
            out.fill(0, offset, total);
        }

        return out;
    }

    static compare(a, b) {
        return a.compare(b);
    }

    toString(encoding, start, end) {
        const enc = assertEncoding(encoding);
        const from = start === undefined ? 0 : Math.max(0, start | 0);
        const to = end === undefined ? this.length : Math.min(this.length, end | 0);

        if (to <= from) {
            return '';
        }

        return decodeBytes(this.subarray(from, to), enc);
    }

    toJSON() {
        return { type: 'Buffer', data: Array.prototype.slice.call(this) };
    }

    equals(other) {
        return this.compare(other) === 0;
    }

    compare(target, targetStart, targetEnd, sourceStart, sourceEnd) {
        const a = this.subarray(sourceStart ?? 0, sourceEnd ?? this.length);
        const b = target.subarray(targetStart ?? 0, targetEnd ?? target.length);
        const len = Math.min(a.length, b.length);

        for (let i = 0; i < len; i++) {
            if (a[i] !== b[i]) {
                return a[i] < b[i] ? -1 : 1;
            }
        }

        if (a.length === b.length) {
            return 0;
        }

        return a.length < b.length ? -1 : 1;
    }

    copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
        const source = this.subarray(sourceStart, sourceEnd);
        const room = target.length - targetStart;
        const chunk = source.length > room ? source.subarray(0, room) : source;

        target.set(chunk, targetStart);

        return chunk.length;
    }

    // Node's slice aliases subarray — it shares memory. Uint8Array's copies, so
    // inheriting it would silently break every caller that writes through a slice.
    slice(start, end) {
        return this.subarray(start, end);
    }

    write(string, offset, length, encoding) {
        let off = 0;
        let len;
        let enc = 'utf8';

        // write(string[, offset[, length]][, encoding]) — the overloads era code uses.
        if (typeof offset === 'string') {
            enc = offset;
        } else if (typeof length === 'string') {
            off = offset | 0;
            enc = length;
        } else {
            off = offset === undefined ? 0 : offset | 0;
            len = length === undefined ? undefined : length | 0;
            enc = encoding ?? 'utf8';
        }

        const bytes = encodeString(String(string), assertEncoding(enc));
        const room = Math.min(len === undefined ? this.length - off : len, this.length - off);
        const chunk = bytes.length > room ? bytes.subarray(0, room) : bytes;

        this.set(chunk, off);

        return chunk.length;
    }

    fill(value, start = 0, end = this.length, encoding) {
        if (typeof value === 'string') {
            const bytes = encodeString(value, assertEncoding(encoding));

            if (bytes.length === 0) {
                return this;
            }

            for (let i = start; i < end; i++) {
                this[i] = bytes[(i - start) % bytes.length];
            }

            return this;
        }

        if (value instanceof Uint8Array) {
            if (value.length === 0) {
                return this;
            }

            for (let i = start; i < end; i++) {
                this[i] = value[(i - start) % value.length];
            }

            return this;
        }

        return super.fill(value === undefined ? 0 : value, start, end);
    }

    indexOf(value, byteOffset, encoding) {
        const needle = typeof value === 'number'
            ? Uint8Array.of(value & 0xff)
            : (typeof value === 'string' ? encodeString(value, assertEncoding(encoding)) : value);

        if (needle.length === 0) {
            return 0;
        }

        const start = Math.max(0, byteOffset === undefined ? 0 : byteOffset | 0);

        outer:
        for (let i = start; i + needle.length <= this.length; i++) {
            for (let j = 0; j < needle.length; j++) {
                if (this[i + j] !== needle[j]) {
                    continue outer;
                }
            }

            return i;
        }

        return -1;
    }

    lastIndexOf(value, byteOffset, encoding) {
        const needle = typeof value === 'number'
            ? Uint8Array.of(value & 0xff)
            : (typeof value === 'string' ? encodeString(value, assertEncoding(encoding)) : value);

        if (needle.length === 0) {
            return this.length;
        }

        const from = byteOffset === undefined ? this.length : byteOffset | 0;

        outer:
        for (let i = Math.min(from, this.length - needle.length); i >= 0; i--) {
            for (let j = 0; j < needle.length; j++) {
                if (this[i + j] !== needle[j]) {
                    continue outer;
                }
            }

            return i;
        }

        return -1;
    }

    includes(value, byteOffset, encoding) {
        return this.indexOf(value, byteOffset, encoding) !== -1;
    }

    swap16() {
        for (let i = 0; i < this.length; i += 2) {
            const t = this[i];

            this[i] = this[i + 1];
            this[i + 1] = t;
        }

        return this;
    }

    swap32() {
        for (let i = 0; i < this.length; i += 4) {
            let t = this[i];

            this[i] = this[i + 3];
            this[i + 3] = t;
            t = this[i + 1];
            this[i + 1] = this[i + 2];
            this[i + 2] = t;
        }

        return this;
    }

    swap64() {
        for (let i = 0; i < this.length; i += 8) {
            for (let j = 0; j < 4; j++) {
                const t = this[i + j];

                this[i + j] = this[i + 7 - j];
                this[i + 7 - j] = t;
            }
        }

        return this;
    }
}

// Enumerable, because Node's are: its Buffer is a function with methods assigned
// onto it, not a class, so Object.keys(Buffer.prototype).length is 95 in Node 26
// and `for (k in buf)` yields the methods along with the indices. See the
// enumerability fixup at the bottom of this file for why that matters.
function define(target, methods) {
    for (const name of Object.keys(methods)) {
        Object.defineProperty(target, name, {
            value: methods[name],
            writable: true,
            enumerable: true,
            configurable: true
        });
    }
}

function loadScratch(buf, offset, size) {
    for (let i = 0; i < size; i++) {
        scratchBytes[i] = buf[offset + i];
    }
}

function storeScratch(buf, offset, size) {
    for (let i = 0; i < size; i++) {
        buf[offset + i] = scratchBytes[i];
    }
}

define(Buffer.prototype, {
    readUInt8(offset = 0) {
        checkBounds(this, offset, 1);

        return this[offset];
    },
    readUInt16LE(offset = 0) {
        checkBounds(this, offset, 2);

        return this[offset] | (this[offset + 1] << 8);
    },
    readUInt16BE(offset = 0) {
        checkBounds(this, offset, 2);

        return (this[offset] << 8) | this[offset + 1];
    },
    readUInt32LE(offset = 0) {
        checkBounds(this, offset, 4);

        return ((this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16)) >>> 0) +
            this[offset + 3] * 0x1000000;
    },
    readUInt32BE(offset = 0) {
        checkBounds(this, offset, 4);

        return this[offset] * 0x1000000 +
            (((this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]) >>> 0);
    },
    readInt8(offset = 0) {
        checkBounds(this, offset, 1);

        return (this[offset] << 24) >> 24;
    },
    readInt16LE(offset = 0) {
        checkBounds(this, offset, 2);

        return ((this[offset] | (this[offset + 1] << 8)) << 16) >> 16;
    },
    readInt16BE(offset = 0) {
        checkBounds(this, offset, 2);

        return (((this[offset] << 8) | this[offset + 1]) << 16) >> 16;
    },
    readInt32LE(offset = 0) {
        checkBounds(this, offset, 4);

        return this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24);
    },
    readInt32BE(offset = 0) {
        checkBounds(this, offset, 4);

        return (this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3];
    },

    readUIntLE(offset, byteLength) {
        checkBounds(this, offset, byteLength);

        let value = 0;
        let scale = 1;

        for (let i = 0; i < byteLength; i++) {
            value += this[offset + i] * scale;
            scale *= 0x100;
        }

        return value;
    },
    readUIntBE(offset, byteLength) {
        checkBounds(this, offset, byteLength);

        let value = 0;

        for (let i = 0; i < byteLength; i++) {
            value = value * 0x100 + this[offset + i];
        }

        return value;
    },
    readIntLE(offset, byteLength) {
        const value = this.readUIntLE(offset, byteLength);
        const limit = Math.pow(2, byteLength * 8 - 1);

        return value >= limit ? value - limit * 2 : value;
    },
    readIntBE(offset, byteLength) {
        const value = this.readUIntBE(offset, byteLength);
        const limit = Math.pow(2, byteLength * 8 - 1);

        return value >= limit ? value - limit * 2 : value;
    },

    readFloatLE(offset = 0) {
        checkBounds(this, offset, 4);
        loadScratch(this, offset, 4);

        return scratchView.getFloat32(0, true);
    },
    readFloatBE(offset = 0) {
        checkBounds(this, offset, 4);
        loadScratch(this, offset, 4);

        return scratchView.getFloat32(0, false);
    },
    readDoubleLE(offset = 0) {
        checkBounds(this, offset, 8);
        loadScratch(this, offset, 8);

        return scratchView.getFloat64(0, true);
    },
    readDoubleBE(offset = 0) {
        checkBounds(this, offset, 8);
        loadScratch(this, offset, 8);

        return scratchView.getFloat64(0, false);
    },
    readBigInt64LE(offset = 0) {
        checkBounds(this, offset, 8);
        loadScratch(this, offset, 8);

        return scratchView.getBigInt64(0, true);
    },
    readBigInt64BE(offset = 0) {
        checkBounds(this, offset, 8);
        loadScratch(this, offset, 8);

        return scratchView.getBigInt64(0, false);
    },
    readBigUInt64LE(offset = 0) {
        checkBounds(this, offset, 8);
        loadScratch(this, offset, 8);

        return scratchView.getBigUint64(0, true);
    },
    readBigUInt64BE(offset = 0) {
        checkBounds(this, offset, 8);
        loadScratch(this, offset, 8);

        return scratchView.getBigUint64(0, false);
    },

    writeUInt8(value, offset = 0) {
        checkBounds(this, offset, 1);
        this[offset] = value & 0xff;

        return offset + 1;
    },
    writeUInt16LE(value, offset = 0) {
        checkBounds(this, offset, 2);
        this[offset] = value & 0xff;
        this[offset + 1] = (value >>> 8) & 0xff;

        return offset + 2;
    },
    writeUInt16BE(value, offset = 0) {
        checkBounds(this, offset, 2);
        this[offset] = (value >>> 8) & 0xff;
        this[offset + 1] = value & 0xff;

        return offset + 2;
    },
    writeUInt32LE(value, offset = 0) {
        checkBounds(this, offset, 4);
        this[offset] = value & 0xff;
        this[offset + 1] = (value >>> 8) & 0xff;
        this[offset + 2] = (value >>> 16) & 0xff;
        this[offset + 3] = (value >>> 24) & 0xff;

        return offset + 4;
    },
    writeUInt32BE(value, offset = 0) {
        checkBounds(this, offset, 4);
        this[offset] = (value >>> 24) & 0xff;
        this[offset + 1] = (value >>> 16) & 0xff;
        this[offset + 2] = (value >>> 8) & 0xff;
        this[offset + 3] = value & 0xff;

        return offset + 4;
    },
    writeInt8(value, offset = 0) {
        return this.writeUInt8(value, offset);
    },
    writeInt16LE(value, offset = 0) {
        return this.writeUInt16LE(value, offset);
    },
    writeInt16BE(value, offset = 0) {
        return this.writeUInt16BE(value, offset);
    },
    writeInt32LE(value, offset = 0) {
        return this.writeUInt32LE(value, offset);
    },
    writeInt32BE(value, offset = 0) {
        return this.writeUInt32BE(value, offset);
    },

    writeUIntLE(value, offset, byteLength) {
        checkBounds(this, offset, byteLength);

        let v = value;

        for (let i = 0; i < byteLength; i++) {
            this[offset + i] = v & 0xff;
            v = Math.floor(v / 0x100);
        }

        return offset + byteLength;
    },
    writeUIntBE(value, offset, byteLength) {
        checkBounds(this, offset, byteLength);

        let v = value;

        for (let i = byteLength - 1; i >= 0; i--) {
            this[offset + i] = v & 0xff;
            v = Math.floor(v / 0x100);
        }

        return offset + byteLength;
    },
    writeIntLE(value, offset, byteLength) {
        return this.writeUIntLE(value < 0 ? value + Math.pow(2, byteLength * 8) : value, offset, byteLength);
    },
    writeIntBE(value, offset, byteLength) {
        return this.writeUIntBE(value < 0 ? value + Math.pow(2, byteLength * 8) : value, offset, byteLength);
    },

    writeFloatLE(value, offset = 0) {
        checkBounds(this, offset, 4);
        scratchView.setFloat32(0, value, true);
        storeScratch(this, offset, 4);

        return offset + 4;
    },
    writeFloatBE(value, offset = 0) {
        checkBounds(this, offset, 4);
        scratchView.setFloat32(0, value, false);
        storeScratch(this, offset, 4);

        return offset + 4;
    },
    writeDoubleLE(value, offset = 0) {
        checkBounds(this, offset, 8);
        scratchView.setFloat64(0, value, true);
        storeScratch(this, offset, 8);

        return offset + 8;
    },
    writeDoubleBE(value, offset = 0) {
        checkBounds(this, offset, 8);
        scratchView.setFloat64(0, value, false);
        storeScratch(this, offset, 8);

        return offset + 8;
    },
    writeBigInt64LE(value, offset = 0) {
        checkBounds(this, offset, 8);
        scratchView.setBigInt64(0, value, true);
        storeScratch(this, offset, 8);

        return offset + 8;
    },
    writeBigInt64BE(value, offset = 0) {
        checkBounds(this, offset, 8);
        scratchView.setBigInt64(0, value, false);
        storeScratch(this, offset, 8);

        return offset + 8;
    },
    writeBigUInt64LE(value, offset = 0) {
        checkBounds(this, offset, 8);
        scratchView.setBigUint64(0, value, true);
        storeScratch(this, offset, 8);

        return offset + 8;
    },
    writeBigUInt64BE(value, offset = 0) {
        checkBounds(this, offset, 8);
        scratchView.setBigUint64(0, value, false);
        storeScratch(this, offset, 8);

        return offset + 8;
    }
});

// Node 14 added lower-case `Uint` spellings alongside the originals.
for (const name of ['readUIntLE', 'readUIntBE', 'readUInt8', 'readUInt16LE', 'readUInt16BE',
    'readUInt32LE', 'readUInt32BE', 'writeUIntLE', 'writeUIntBE', 'writeUInt8', 'writeUInt16LE',
    'writeUInt16BE', 'writeUInt32LE', 'writeUInt32BE', 'readBigUInt64LE', 'readBigUInt64BE',
    'writeBigUInt64LE', 'writeBigUInt64BE']) {
    define(Buffer.prototype, { [name.replace('UInt', 'Uint')]: Buffer.prototype[name] });
}

Buffer.poolSize = 8192;
Buffer.kMaxLength = K_MAX_LENGTH;

// Deprecated in Node since 6.0 and still imported by era code.
function SlowBuffer(size) {
    return Buffer.alloc(size);
}

// Node's Buffer is a plain function with `Buffer.from = ...` and
// `Buffer.prototype.write = ...` assigned onto it, so every one of those is
// enumerable. Class statics and class prototype methods are non-enumerable by
// spec, which is a difference real code trips over: safer-buffer rebuilds Buffer
// with `for (key in Buffer)` and, against a class, copies nothing — iconv-lite
// then calls Buffer.from on the empty result and dies with "not a function".
//
// Verified against Node 26: 12 enumerable own properties on Buffer, 95 on
// Buffer.prototype.
function matchNodeEnumerability(target, skip) {
    for (const name of Object.getOwnPropertyNames(target)) {
        if (skip.includes(name)) {
            continue;
        }

        const descriptor = Object.getOwnPropertyDescriptor(target, name);

        if (descriptor.enumerable || !descriptor.configurable) {
            continue;
        }

        descriptor.enumerable = true;
        Object.defineProperty(target, name, descriptor);
    }
}

matchNodeEnumerability(Buffer, ['length', 'name', 'prototype']);
matchNodeEnumerability(Buffer.prototype, ['constructor']);

export { Buffer, SlowBuffer, K_MAX_LENGTH as kMaxLength };
