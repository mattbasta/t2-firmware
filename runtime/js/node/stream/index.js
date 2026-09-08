// stream
//
// Assembled from the ported readable-stream v3.6.2 (see the provenance headers
// on the files under lib/). Ported rather than reimplemented deliberately:
// stream semantics are the subtlest surface in this runtime, and readable-stream
// *is* Node's implementation, extracted and MIT-licensed (strategy R3).
//
// readable-stream's own entry points are both wrong for us. readable.js starts
// with `require('stream')`, which here would be this module requiring itself;
// readable-browser.js aliases Stream to Readable, which would leave
// `readable instanceof stream.Stream` false. So the entry is first-party, and
// the base class comes from Node's own legacy.js.

'use strict';

const Stream = require('./lib/internal/streams/stream.js');

const Readable = require('./lib/_stream_readable.js');
const Writable = require('./lib/_stream_writable.js');
const Duplex = require('./lib/_stream_duplex.js');
const Transform = require('./lib/_stream_transform.js');
const PassThrough = require('./lib/_stream_passthrough.js');
const finished = require('./lib/internal/streams/end-of-stream.js');
const pipeline = require('./lib/internal/streams/pipeline.js');

// Node's module object is the legacy Stream constructor with everything hung
// off it, and plenty of era code relies on that shape — `require('stream')`
// used directly as a base class, or `stream.Stream === stream`.
module.exports = Stream;

Stream.Stream = Stream;
Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Duplex = Duplex;
Stream.Transform = Transform;
Stream.PassThrough = PassThrough;
Stream.finished = finished;
Stream.pipeline = pipeline;

// stream/promises, which Node grew in v15. Both are thin wrappers over the
// callback forms rather than reimplementations.
Stream.promises = {
    finished(stream, options) {
        return new Promise((resolve, reject) => {
            finished(stream, options || {}, err => (err ? reject(err) : resolve()));
        });
    },

    pipeline(...streams) {
        return new Promise((resolve, reject) => {
            pipeline(...streams, err => (err ? reject(err) : resolve()));
        });
    }
};
