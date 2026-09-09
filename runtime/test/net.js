// node:net — sockets as streams.
//
// Differential, like the fs suite: every assertion here must hold on stock Node
// as well as on this runtime.
//
//   runtime/test/run.sh <node>      # this runtime
//   node runtime/test/net.js        # the reference

'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');

let fail = 0;
const eq = (actual, expected, label) => {
    if (String(actual) !== String(expected)) {
        fail++;
        console.log('FAIL', label, '->', actual, '!=', expected);
    }
};

// --- address classification --------------------------------------------------

eq(net.isIP('127.0.0.1'), 4, 'isIP v4');
eq(net.isIP('::1'), 6, 'isIP v6');
eq(net.isIP('not an ip'), 0, 'isIP rejects');
eq(net.isIP('256.1.1.1'), 0, 'isIP rejects an out-of-range octet');
eq(net.isIPv4('10.0.0.1'), true, 'isIPv4');
eq(net.isIPv4('::1'), false, 'isIPv4 on a v6 address');
eq(net.isIPv6('fe80::1'), true, 'isIPv6');
eq(typeof net.Socket, 'function', 'net.Socket');
eq(typeof net.Server, 'function', 'net.Server');
eq(net.connect === net.createConnection, true, 'net.connect aliases createConnection');

const dir = fs.mkdtempSync('/tmp/t2net-');

function once(emitter, event) {
    return new Promise(resolve => emitter.once(event, resolve));
}

async function unixSocketRoundTrip() {
    const sockPath = path.join(dir, 'echo.sock');
    const received = [];

    const server = net.createServer(conn => {
        conn.on('data', chunk => {
            received.push(chunk.toString());
            conn.write(chunk.toString().toUpperCase());
        });
        conn.on('end', () => conn.end());
    });

    server.listen(sockPath);
    await once(server, 'listening');

    eq(fs.existsSync(sockPath), true, 'listening created the socket file');

    const client = net.createConnection({ path: sockPath });

    await once(client, 'connect');

    const replies = [];

    client.on('data', chunk => replies.push(chunk.toString()));

    client.write('hello');
    await new Promise(resolve => setTimeout(resolve, 50));

    eq(received.join(''), 'hello', 'server received the client write');
    eq(replies.join(''), 'HELLO', 'client received the reply');
    eq(client.bytesWritten, 5, 'bytesWritten');
    eq(client.bytesRead, 5, 'bytesRead');

    // cork/uncork is the path tessel-export.js uses around every SPI batch:
    // three writes, one flush, bytes in order.
    client.cork();
    client.write('a');
    client.write('b');
    client.write('c');
    client.uncork();

    await new Promise(resolve => setTimeout(resolve, 50));
    eq(received.join(''), 'helloabc', 'corked writes arrive in order');

    const ended = once(client, 'close');

    client.end();
    await ended;

    eq(client.destroyed, true, 'client is destroyed after close');

    const closed = once(server, 'close');

    server.close();
    await closed;
}

async function tcpRoundTrip() {
    const server = net.createServer(conn => {
        conn.pipe(conn); // echo
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();

    eq(typeof address.port, 'number', 'server.address() reports a port');
    eq(address.port > 0, true, 'the port was assigned');
    eq(address.address, '127.0.0.1', 'server.address() reports the host');

    const client = net.createConnection({ port: address.port, host: '127.0.0.1' });

    await once(client, 'connect');

    eq(client.remotePort, address.port, 'remotePort');
    eq(client.remoteAddress, '127.0.0.1', 'remoteAddress');
    eq(typeof client.localPort, 'number', 'localPort');
    eq(client.readyState, 'open', 'readyState while open');

    // chained setters return the socket
    eq(client.setNoDelay(true), client, 'setNoDelay returns the socket');
    eq(client.setKeepAlive(true, 1000), client, 'setKeepAlive returns the socket');
    eq(client.ref(), client, 'ref returns the socket');
    eq(client.unref(), client, 'unref returns the socket');
    client.ref();

    const echoed = [];

    client.on('data', chunk => echoed.push(chunk.toString()));
    client.write('over tcp');

    await new Promise(resolve => setTimeout(resolve, 50));
    eq(echoed.join(''), 'over tcp', 'tcp echo round trip');

    const closed = once(client, 'close');

    client.end();
    await closed;

    const serverClosed = once(server, 'close');

    server.close();
    await serverClosed;
}

async function hostnameResolution() {
    const server = net.createServer(conn => conn.end('resolved'));

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    // 'localhost' has to go through a name lookup before connecting.
    const client = net.createConnection({ port: server.address().port, host: 'localhost' });
    const chunks = [];

    client.on('data', chunk => chunks.push(chunk.toString()));
    await once(client, 'connect');
    await once(client, 'end');

    eq(chunks.join(''), 'resolved', 'connecting by hostname resolves and works');

    client.destroy();

    const serverClosed = once(server, 'close');

    server.close();
    await serverClosed;
}

async function errorPaths() {
    const missing = net.createConnection({ path: path.join(dir, 'not-there.sock') });
    const err = await once(missing, 'error');

    eq(['ENOENT', 'ECONNREFUSED'].includes(err.code), true, `connecting to a missing socket fails (${err.code})`);
    eq(missing.destroyed, true, 'a failed connect destroys the socket');

    // Writing after destroy reports through the callback rather than throwing.
    const gone = new net.Socket();

    gone.destroy();

    const writeErr = await new Promise(resolve => gone.write('x', resolve));

    eq(writeErr instanceof Error, true, 'writing to a destroyed socket reports an error');
}

async function halfOpen() {
    const sockPath = path.join(dir, 'half.sock');
    const server = net.createServer({ allowHalfOpen: true }, conn => {
        conn.on('end', () => {
            // The readable side ended, but with allowHalfOpen the writable side
            // is still ours to use.
            conn.end('after end');
        });
        conn.resume();
    });

    server.listen(sockPath);
    await once(server, 'listening');

    const client = net.createConnection({ path: sockPath });

    await once(client, 'connect');

    const chunks = [];

    client.on('data', chunk => chunks.push(chunk.toString()));
    client.end();
    await once(client, 'end');

    eq(chunks.join(''), 'after end', 'allowHalfOpen lets the peer reply after end');

    client.destroy();

    const serverClosed = once(server, 'close');

    server.close();
    await serverClosed;
}

async function eventOrdering() {
    const sockPath = path.join(dir, 'order.sock');
    const server = net.createServer(conn => conn.end());

    server.listen(sockPath);
    await once(server, 'listening');

    const client = net.createConnection({ path: sockPath });
    const order = [];

    client.on('connect', () => order.push('connect'));
    client.on('end', () => order.push('end'));
    client.on('close', () => order.push('close'));
    client.resume();

    await once(client, 'close');
    eq(order.join(','), 'connect,end,close', 'connect then end then close');

    const serverClosed = once(server, 'close');

    server.close();
    await serverClosed;
}

async function largeTransfer() {
    const sockPath = path.join(dir, 'big.sock');
    const payload = 'x'.repeat(512 * 1024);
    const server = net.createServer(conn => {
        conn.end(payload);
    });

    server.listen(sockPath);
    await once(server, 'listening');

    const client = net.createConnection({ path: sockPath });
    let total = 0;

    client.on('data', chunk => {
        total += chunk.length;
    });

    await once(client, 'end');
    eq(total, payload.length, 'a payload larger than one buffer arrives whole');

    client.destroy();

    const serverClosed = once(server, 'close');

    server.close();
    await serverClosed;
}

async function main() {
    await unixSocketRoundTrip();
    await tcpRoundTrip();
    await hostnameResolution();
    await errorPaths();
    await halfOpen();
    await eventOrdering();
    await largeTransfer();
}

main().then(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(fail === 0 ? 'NET: all pass' : `NET: ${fail} FAILURES`);
    process.exitCode = fail === 0 ? 0 : 1;
}, err => {
    console.log('NET: threw ->', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
