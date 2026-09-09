# What this runtime does not implement

Three different things get confused with each other, so they are kept apart here:

- **Omissions** — an API Node has that this runtime does not. These are *present
  as stubs* and throw when called.
- **Simplifications** — an API that exists and works, built the cheap way, with
  something real given up. Calling code cannot tell, but a profiler could.
- **Not yet built** — no decision, just work that has not happened. Listed so it
  is a queue rather than a discovery.

Behavioral divergences in APIs we *do* implement are a fourth thing and live in
[phase1-plan.md §5a](phase1-plan.md), which is where they are recorded as they
are created.

## How an omission behaves

An omitted method exists and throws:

```
Error: fs.watch is not implemented by this runtime: nothing on this device
watches files, and FSWatcher semantics are platform-specific enough that a
half-built one would be worse than none. See runtime/docs/omissions.md.
    at watch (fs.js:...)
    at ...
  code: 'ERR_NOT_IMPLEMENTED'
```

It is a stub rather than an absence because `fs.watch is not a function` sends
the reader looking for a typo in their own code, while this names the thing they
hit and where the reasoning is written down. The stack comes with the throw. The
message is *also* logged to stderr once per method name — not per call — so that
code which swallows the error still leaves a trace.

**The tradeoff, stated plainly:** a stub makes `typeof fs.watch === 'function'`
true, so a library that feature-detects will take the branch it cannot use
instead of its fallback. That is the wrong answer for a library with a fallback
and the right answer for the much more common case of a library that simply
calls the method. If a real package is found taking the bad branch, the fix is
to make that specific stub absent again, not to change the policy.

## Omissions

| API | Why |
|---|---|
| `child_process.fork()` | Needs an IPC channel this runtime has no path to. Nothing on the board uses it, and on a 64 MB device forking a second runtime is not a thing to encourage. A `fork` that silently behaved like `spawn` would be worse than one that says so. |
| `fs.watch`, `fs.watchFile`, `fs.unwatchFile`, `fs.promises.watch` | txiki has a watcher to build on, but `FSWatcher` semantics — rename versus change, the `recursive` option, coalescing — are notoriously platform-specific, and the consumers (nodemon, chokidar and friends) run on a development machine, not on the board. A half-built watcher would be worse than none. |

## Simplifications

Present, working, and cheaper than Node's.

| API | What is given up |
|---|---|
| `fs.readv`, `fs.writev` (+`Sync`) | libuv would do these in one syscall; our binding passes one buffer, so these loop. One syscall per buffer instead of one per call. Closing it means a variadic buffer marshaller in C for an API almost nobody calls directly. |
| `fs.opendir` / `Dir` | Node streams entries from an open `DIR*`, so a directory with a million files costs one buffer. Ours reads the whole listing at open and hands it out one at a time. The API is faithful; the memory profile is not. |
| `fs.cp` / `fs.cpSync` | First-party and deliberately small. The common "copy this one file" call and recursive directory copies work, including symlinks and `preserveTimestamps`; the more exotic option interactions are not exhaustively matched. Written rather than vendored because pulling an npm package into the firmware image is a dependency-policy event for something this size. |
| `fs.WriteStream._writev` | Concatenates the corked batch and issues one write, rather than a true vectored write. Same syscall count, one extra copy. |
| `Buffer.allocUnsafe` | Allocates fresh zeroed memory instead of slicing a shared pool. Deliberate on a 64 MB board; not planned to close. |

## Not yet built — revisit

No decision has been made against these; they are queued.

- **The mechanical `fs` family.** Each is the same ten-line shape as a binding
  that already exists, and libuv has all of them: `chown`, `fchown`, `lchown`,
  `fchmod`, `lchmod`, `futimes`, `lutimes` (each with its `Sync` form), and
  `statfs`/`statfsSync`. Worth doing together, most naturally alongside `os` in
  step 4 of [phase2-plan.md](phase2-plan.md).
- **`constants` gaps.** We ship 146 entries against Node 18's 251 on the same
  platform. About seventy of the difference is crypto and TLS (`SSL_OP_*`,
  `RSA_*`, `TLS1_*`), which belongs with Phase 3, and six are `PRIORITY_*`,
  which belongs with `os`. The genuine gaps are small and should be closed with
  the above: `ENODATA`, `ENOSR`, `ENOSTR`, `ETIME`, `SIGPOLL`, `SIGPWR`,
  `SIGSTKFLT`, `O_DIRECT`, `O_NOATIME`, `RTLD_DEEPBIND`, and the `UV_DIRENT_*`
  and `COPYFILE_*` values Node mirrors into the flat table.
- **`fs.glob`/`globSync`** (Node 22+). Era code uses the npm `glob` package,
  which runs on this runtime today — it is in the test corpus. Building Node's
  own would duplicate that for nobody.
- **`fs.openAsBlob`**, **`Utf8Stream`**, **`mkdtempDisposableSync`** — modern
  Node surface with no caller in sight.

## How far behind the stream port is

`node:stream` is a port of `readable-stream` v3.6.2, which is not an independent
reimplementation: it is Node's own `lib/internal/streams/` extracted and
republished by the Node streams working group, which is why our streams and
Node's agree exactly on the mechanics that have not changed. Measured against
Node 26 on 2026-09-09, a pushed EOF with no consumer behaves identically on
both — no `'end'` until something reads, `'end'` after `read(0)` or `resume()`,
no early end while data is buffered.

v3.6.2 tracks roughly Node 10–12, though, so the gap is real. What it amounts to:

**One behavioral difference, and it is the one to remember.** `autoDestroy`
defaults to **`false`** here and `true` in Node 26, which changes when a stream
is destroyed and when `'close'` fires. Our own modules are unaffected —
`net.Socket` and the `fs` streams both pass `autoDestroy: true` explicitly — but
a stream a *user* constructs will behave differently from the same code on Node.

**Surface added to Node after v3.6.2**, none of which era code can be reaching
for, listed so nobody has to diff it again:

- Iterator helpers on `Readable.prototype`: `map`, `filter`, `forEach`,
  `toArray`, `some`, `every`, `find`, `reduce`, `drop`, `take`, `flatMap`,
  `iterator`, `compose`.
- State inspection: `readableEnded`, `readableAborted`, `readableDidRead`,
  `readableEncoding`, `readableObjectMode`, `closed`, `errored`.
- Module-level helpers: `compose`, `duplexPair`, `addAbortSignal`, `destroy`,
  `isDisturbed`, `isErrored`, `isReadable`, `isWritable`, `isDestroyed`,
  `getDefaultHighWaterMark`, `setDefaultHighWaterMark`.
- Web-stream interop: `Readable.fromWeb`, `Readable.toWeb`.

Present and working: `pipeline`, `finished`, `stream.promises`, `Readable.from`,
and `Symbol.asyncIterator`. Of the gaps, `autoDestroy` and the state getters are
the only ones a moderately recent package is likely to touch; the rest are
Node 16-and-later conveniences.

**The trap this replaced.** A `net` bug was first explained as our older streams
diverging from Node's, which was wrong and pointed at the wrong layer. The
streams agreed; the difference was between our `net.js` and Node's. Node's
*module* implementations do work on top of streams that is invisible from the
stream API — `net.Socket` calls `read(0)` on connect and after EOF, and nothing
about the stream contract says so. Expect more of that in `http`, which leans on
streams far harder than `net` does, and measure Node rather than reasoning from
the stream docs.

## A note on build variants

The idea of a **slim build** — one that drops optional weight, with the full
build pulling in more — has come up twice: once for backing an API with a
third-party library, and once for excluding SQLite (~900 KB, currently on by
default). Nothing here needs it yet, and the flash arithmetic says it is not
urgent: the runtime replaces a Node 4 binary of 8,893,391 bytes with one about
2.5 MB smaller, so it *frees* space rather than consuming it. Recorded as the
lever to reach for if that stops being true.
