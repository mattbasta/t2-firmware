// node:net — sockets as streams.
//
// Socket is a stream.Duplex over the libuv handles in runtime/src/net.c, which
// is the whole reason the handles are first-party. Building on txiki's public
// PipeSocket would have meant WHATWG streams with no ref, unref or cork; here
// cork/uncork and _writev arrive free from the Phase 1 stream port, so a corked
// batch becomes one uv_write with several buffers and one writev() syscall.
// That is exactly what tessel-export.js does around every SPI command batch,
// and its unref() on the spid socket is why a Tessel script exits at all.
//
// See runtime/docs/phase2-plan.md §2.

'use strict';

const { Duplex } = require('stream');
const EventEmitter = require('events');

const binding = __native.net;

// --- address helpers ---------------------------------------------------------

const IPv4_SEGMENT = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const IPv4_RE = new RegExp(`^(?:${IPv4_SEGMENT}\\.){3}${IPv4_SEGMENT}$`);
const IPv6_SEGMENT = '(?:[0-9a-fA-F]{1,4})';
const IPv6_RE = new RegExp(
    '^(?:' +
    `(?:${IPv6_SEGMENT}:){7}(?:${IPv6_SEGMENT}|:)|` +
    `(?:${IPv6_SEGMENT}:){6}(?::${IPv6_SEGMENT}|:)|` +
    `(?:${IPv6_SEGMENT}:){5}(?:(?::${IPv6_SEGMENT}){1,2}|:)|` +
    `(?:${IPv6_SEGMENT}:){4}(?:(?::${IPv6_SEGMENT}){1,3}|:)|` +
    `(?:${IPv6_SEGMENT}:){3}(?:(?::${IPv6_SEGMENT}){1,4}|:)|` +
    `(?:${IPv6_SEGMENT}:){2}(?:(?::${IPv6_SEGMENT}){1,5}|:)|` +
    `(?:${IPv6_SEGMENT}:){1}(?:(?::${IPv6_SEGMENT}){1,6}|:)|` +
    `(?::(?:(?::${IPv6_SEGMENT}){1,7}|:))` +
    ')(?:%[0-9a-zA-Z-.:]{1,})?$'
);

function isIPv4(value) {
    return IPv4_RE.test(value);
}

function isIPv6(value) {
    return IPv6_RE.test(value);
}

function isIP(value) {
    if (isIPv4(value)) {
        return 4;
    }

    if (isIPv6(value)) {
        return 6;
    }

    return 0;
}

function invalidArg(name, expected, actual) {
    const err = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${typeof actual}`);

    err.code = 'ERR_INVALID_ARG_TYPE';

    return err;
}

// A callback reaching us from a libuv callback has nowhere to throw, so
// everything installed on a handle is wrapped and routed the way Node routes an
// exception out of an I/O callback.
function guard(fn) {
    return function (...args) {
        try {
            fn(...args);
        } catch (err) {
            __native.handleUncaught(err);
        }
    };
}

function toBuffer(chunk, encoding) {
    return typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : chunk;
}

// --- Socket ------------------------------------------------------------------

class Socket extends Duplex {
    constructor(options = {}) {
        const opts = typeof options === 'object' && options !== null ? options : {};

        super({
            allowHalfOpen: opts.allowHalfOpen === true,
            autoDestroy: true,
            emitClose: true,
            decodeStrings: false,
            readableHighWaterMark: opts.readableHighWaterMark,
            writableHighWaterMark: opts.writableHighWaterMark
        });

        this._handle = opts.handle ?? null;
        this._pendingConnect = null;
        this._reading = false;
        this._wantRead = false;

        this.connecting = false;
        this.bytesRead = 0;
        this.bytesWritten = 0;
        this.remoteAddress = undefined;
        this.remotePort = undefined;
        this.remoteFamily = undefined;
        this.localAddress = undefined;
        this.localPort = undefined;

        this._timeout = null;
        this._timeoutHandle = null;

        if (this._handle) {
            this._afterConnect(false);
        } else if (opts.fd !== undefined) {
            this._handle = binding.pipe();
            this._handle.open(opts.fd);
            this._afterConnect(false);
        }
    }

    // --- connecting ----------------------------------------------------------

    connect(...args) {
        let options = args[0];
        let connectListener = args[args.length - 1];

        if (typeof connectListener !== 'function') {
            connectListener = undefined;
        }

        // connect(port[, host][, cb]) and connect(path[, cb]) both exist.
        if (typeof options === 'number') {
            options = { port: options, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
        } else if (typeof options === 'string') {
            options = { path: options };
        }

        if (typeof options !== 'object' || options === null) {
            throw invalidArg('options', 'object', options);
        }

        if (connectListener) {
            this.once('connect', connectListener);
        }

        this.connecting = true;

        if (options.path) {
            this._handle = binding.pipe();
            this._connectHandle(options.path, 0);
        } else if (isIP(options.host ?? '') !== 0) {
            this._handle = binding.tcp();
            this._connectHandle(options.host, options.port);
        } else {
            // A name, so it has to be resolved first — the one asynchronous step
            // before the connect itself.
            const host = options.host ?? 'localhost';

            binding.lookup(host, options.family ?? 0, guard((err, addresses) => {
                if (this.destroyed) {
                    return;
                }

                if (err || addresses.length === 0) {
                    this.connecting = false;
                    this.destroy(err ?? new Error(`getaddrinfo ENOTFOUND ${host}`));

                    return;
                }

                this._handle = binding.tcp();
                this._connectHandle(addresses[0].address, options.port);
            }));
        }

        return this;
    }

    _connectHandle(target, port) {
        this._handle.connect(String(target), port ?? 0, guard(err => {
            this.connecting = false;

            if (err) {
                this.destroy(err);

                return;
            }

            this._afterConnect(true);
        }));
    }

    _afterConnect(emit) {
        const local = this._handle.sockname(false);
        const remote = this._handle.sockname(true);

        if (local) {
            this.localAddress = local.address;
            this.localPort = local.port;
        }

        if (remote) {
            this.remoteAddress = remote.address;
            this.remotePort = remote.port;
            this.remoteFamily = remote.family;
        }

        if (emit) {
            this.emit('connect');
            this.emit('ready');
        }

        // Anything the writable side buffered while connecting can go now, and
        // a _read() that arrived early can start.
        if (this._wantRead) {
            this._wantRead = false;
            this._startReading();
        }

        // Node does this too, and it is not an optimization: a socket nobody
        // reads still has to notice that the peer went away. Without it the
        // handle never starts, EOF is never delivered, 'end' and 'close' never
        // fire, and a server holding such a connection never finishes closing.
        // read(0) starts the handle without consuming anything.
        this.read(0);
    }

    // --- reading -------------------------------------------------------------

    _startReading() {
        if (this._reading || !this._handle || this.destroyed) {
            return;
        }

        this._reading = true;

        this._handle.startRead(guard((chunk, err) => {
            if (err) {
                this.destroy(err);

                return;
            }

            if (chunk === null) {
                // EOF. push(null) ends the readable side; Duplex takes care of
                // ending the writable side too unless allowHalfOpen.
                this.push(null);

                // And then a nudge. A pushed EOF does not become an 'end'
                // event on its own: something has to read() and find the buffer
                // drained. Without this a socket nobody consumes sits
                // ended-but-silent forever, and a server waiting on that
                // connection never finishes closing.
                //
                // This is not a quirk of our readable-stream port — Node's
                // streams behave identically, down to the same four cases — so
                // do not remove it on the theory that newer streams would end
                // by themselves. Node's own net.Socket does the same kick; that
                // is the difference, and it is invisible from the stream API.
                this.read(0);

                return;
            }

            this.bytesRead += chunk.length;
            this._resetTimeout();

            // Node's Buffer, not a bare Uint8Array: era code calls toString()
            // and the read* family on what it gets from a socket.
            if (!this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length))) {
                this._stopReading();
            }
        }));
    }

    _stopReading() {
        if (!this._reading || !this._handle) {
            return;
        }

        this._reading = false;
        this._handle.stopRead();
    }

    _read() {
        if (this.connecting || !this._handle) {
            this._wantRead = true;

            return;
        }

        this._startReading();
    }

    // --- writing -------------------------------------------------------------

    _write(chunk, encoding, callback) {
        this._writev([{ chunk, encoding }], callback);
    }

    // Corked batches arrive here as a list and go out as one uv_write. This is
    // the path tessel-export.js leans on around every SPI command batch.
    _writev(chunks, callback) {
        if (this.connecting) {
            this.once('connect', () => this._writev(chunks, callback));

            return;
        }

        if (!this._handle || this.destroyed) {
            callback(new Error('This socket is closed'));

            return;
        }

        const buffers = chunks.map(({ chunk, encoding }) => toBuffer(chunk, encoding));
        let total = 0;

        for (const buffer of buffers) {
            total += buffer.length;
        }

        this._resetTimeout();

        // The handle calls back exactly once whether or not the write went out
        // inline, so there is only one completion path to get right here.
        try {
            this._handle.write(buffers, guard(err => {
                if (err) {
                    callback(err);
                } else {
                    this.bytesWritten += total;
                    callback();
                }
            }));
        } catch (err) {
            callback(err);
        }
    }

    _final(callback) {
        if (!this._handle || this.destroyed) {
            callback();

            return;
        }

        this._handle.shutdown(guard(err => {
            // A shutdown still in flight when the handle closes comes back
            // ECANCELED, and a peer that has already gone gives ENOTCONN or
            // EPIPE. None of those is a failure of end(): the writable side is
            // finished either way, and reporting them would turn an ordinary
            // close race into an 'error' on the socket.
            if (err && !['ECANCELED', 'ENOTCONN', 'EPIPE'].includes(err.code)) {
                callback(err);

                return;
            }

            callback(null);
        }));
    }

    _destroy(err, callback) {
        this._stopReading();
        this._clearTimeout();

        const handle = this._handle;

        this._handle = null;

        if (!handle) {
            callback(err);

            return;
        }

        handle.close(guard(() => callback(err)));
    }

    // --- the rest ------------------------------------------------------------

    destroySoon() {
        if (this.writable) {
            this.end();
        }

        if (this.writableFinished) {
            this.destroy();
        } else {
            this.once('finish', () => this.destroy());
        }
    }

    address() {
        if (!this._handle) {
            return {};
        }

        return this._handle.sockname(false) ?? {};
    }

    setNoDelay(enable = true) {
        if (this._handle) {
            this._handle.setNoDelay(enable);
        }

        return this;
    }

    setKeepAlive(enable = true, initialDelay = 0) {
        if (this._handle) {
            this._handle.setKeepAlive(enable, Math.floor(initialDelay / 1000));
        }

        return this;
    }

    // Node's socket timeout is an inactivity timer that only emits — it does not
    // close the socket. Era code relies on being the one to decide.
    setTimeout(msecs, callback) {
        if (callback) {
            this.once('timeout', callback);
        }

        this._timeout = msecs > 0 ? msecs : null;
        this._resetTimeout();

        return this;
    }

    _resetTimeout() {
        this._clearTimeout();

        if (this._timeout) {
            this._timeoutHandle = setTimeout(() => this.emit('timeout'), this._timeout);

            if (this._timeoutHandle && typeof this._timeoutHandle.unref === 'function') {
                this._timeoutHandle.unref();
            }
        }
    }

    _clearTimeout() {
        if (this._timeoutHandle) {
            clearTimeout(this._timeoutHandle);
            this._timeoutHandle = null;
        }
    }

    ref() {
        if (this._handle) {
            this._handle.ref();
        }

        return this;
    }

    unref() {
        if (this._handle) {
            this._handle.unref();
        }

        return this;
    }
}

Object.defineProperty(Socket.prototype, 'readyState', {
    configurable: true,
    get() {
        if (this.connecting) {
            return 'opening';
        }

        if (this.readable && this.writable) {
            return 'open';
        }

        if (this.readable) {
            return 'readOnly';
        }

        if (this.writable) {
            return 'writeOnly';
        }

        return 'closed';
    }
});

Object.defineProperty(Socket.prototype, 'bufferSize', {
    configurable: true,
    get() {
        return this.writableLength;
    }
});

// --- Server ------------------------------------------------------------------

class Server extends EventEmitter {
    constructor(options, connectionListener) {
        super();

        if (typeof options === 'function') {
            connectionListener = options;
            options = {};
        }

        this._options = options ?? {};
        this._handle = null;
        this._connections = 0;
        this._closed = false;
        this.listening = false;

        if (connectionListener) {
            this.on('connection', connectionListener);
        }
    }

    listen(...args) {
        let options = args[0];
        const callback = args.find(a => typeof a === 'function');

        if (typeof options === 'number') {
            options = { port: options, host: typeof args[1] === 'string' ? args[1] : '0.0.0.0' };
        } else if (typeof options === 'string') {
            options = { path: options };
        } else if (typeof options !== 'object' || options === null) {
            options = { port: 0 };
        }

        const backlog = args.find((a, i) => i > 0 && typeof a === 'number') ?? options.backlog ?? 511;

        if (callback) {
            this.once('listening', callback);
        }

        try {
            if (options.path) {
                this._handle = binding.pipe();
                this._handle.bind(options.path, 0);
            } else {
                this._handle = binding.tcp();
                this._handle.bind(options.host ?? '0.0.0.0', options.port ?? 0);
            }

            this._handle.listen(backlog, guard(err => this._onConnection(err)));
        } catch (err) {
            // Node reports a bind failure through 'error', not by throwing out
            // of listen(): the call is asynchronous in shape even when the
            // failure is immediate.
            this._handle = null;
            process.nextTick(() => this.emit('error', err));

            return this;
        }

        this.listening = true;
        process.nextTick(() => this.emit('listening'));

        return this;
    }

    _onConnection(err) {
        if (err) {
            this.emit('error', err);

            return;
        }

        const handle = this._handle.accept();

        if (handle === null) {
            return;
        }

        const socket = new Socket({ handle, allowHalfOpen: this._options.allowHalfOpen === true });

        this._connections++;
        socket.once('close', () => {
            this._connections--;
            this._maybeEmitClose();
        });

        this.emit('connection', socket);
    }

    address() {
        if (!this._handle) {
            return null;
        }

        return this._handle.sockname(false);
    }

    getConnections(callback) {
        const count = this._connections;

        process.nextTick(() => callback(null, count));

        return this;
    }

    close(callback) {
        if (callback) {
            this.once('close', callback);
        }

        if (!this._handle) {
            process.nextTick(() =>
                this.emit('close', Object.assign(new Error('Server is not running'), { code: 'ERR_SERVER_NOT_RUNNING' })));

            return this;
        }

        this.listening = false;

        const handle = this._handle;

        this._handle = null;

        handle.close(guard(() => {
            this._closed = true;
            this._maybeEmitClose();
        }));

        return this;
    }

    // Node emits 'close' once the listening handle is down *and* every accepted
    // connection has gone.
    _maybeEmitClose() {
        if (this._closed && this._connections === 0) {
            this._closed = false;
            this.emit('close');
        }
    }

    ref() {
        if (this._handle) {
            this._handle.ref();
        }

        return this;
    }

    unref() {
        if (this._handle) {
            this._handle.unref();
        }

        return this;
    }
}

// --- module surface ----------------------------------------------------------

function createConnection(...args) {
    const socket = new Socket(typeof args[0] === 'object' && args[0] !== null ? args[0] : {});

    return socket.connect(...args);
}

function createServer(options, connectionListener) {
    return new Server(options, connectionListener);
}

module.exports = {
    Socket,
    Stream: Socket,
    Server,
    createConnection,
    connect: createConnection,
    createServer,
    isIP,
    isIPv4,
    isIPv6
};
