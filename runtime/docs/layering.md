# Which layer knows what

Three layers, and a rule for each boundary. Written down because "should this
live in C or in JS?" comes up on every module, and because a fix in the wrong
layer is expensive to find later.

```
  user code
      │
  runtime/js/node/*.js     Node semantics.        Knows Node. Knows nothing about the OS.
      │
  runtime/src/*.c          libuv, exposed.        Knows libuv and the target's headers.
      │
  libuv                    the portability layer. Knows epoll, kqueue, IOCP, MIPS errno tables.
      │
  the operating system
```

## The rule at each boundary

**libuv → C.** libuv is already the higher-level interface: one handle model
over epoll/kqueue/IOCP, one `UV_E*` error namespace over every platform's errno
table. Our C does not re-abstract it and does not go around it.

**C → JS.** The C layer exposes libuv's model and *nothing Node-shaped*. No
`fs.readFileSync`, no `net.Socket` — just `open`, `read`, `write`, `connect`,
`startRead`. Two invariants make the boundary portable:

- **Numbers stay below it; names cross it.** An error reaches JS as
  `err.code === 'ENOENT'`, never as `-2`. This is not a style preference:
  `ENOTEMPTY` is 39 on x86 Linux and 93 on MIPS, so a number that crossed the
  boundary would be wrong on the board and right on every machine this is
  developed on. The platform's numbers are read from the target's own headers in
  `constants.c` and handed up as a table.
- **Node's semantics do not leak downward.** C does not know what a stream is,
  what `'end'` means, or that `fs.writeFile` exists. That is what keeps the
  engine swappable, which the strategy names as the reason to be JS-first.

**JS → user code.** This layer implements Node, on top of the vocabulary above.
It is allowed to know POSIX *shapes* — that a special file may report `st_size`
0 and still yield bytes, that a socket can be half-closed — because those are
Node's semantics too, and they are stated in libuv's vocabulary rather than any
one platform's.

## Two worked examples

**`read(0)` after EOF**, in `net.js`, looks like the sort of thing that belongs
lower down. It is not: it is a JS-level poke at a JS-level state machine.
`push(null)` sets `state.ended`, but the `'end'` *event* is only emitted from
`endReadable()`, which is only reachable from inside `read()` — so "EOF
happened" and "EOF was announced" are separated by a call nobody makes unless
something reads. Measured on macOS/arm64, Linux/x86-64 and Linux/mipsel: same
behavior, so nothing platform-specific is involved. libuv did its job, C did its
job, and the gap was inside the JS abstraction, which is where the fix belongs.
Node's own `lib/net.js` writes `this.read(0)` in the same place.

**MIPS errno numbers** are the opposite case, and the one that proves the rule.
`graceful-fs` compares `err.errno` against `constants.ENOTEMPTY`. Had that table
been written in JS it would have been correct on every development machine and
silently wrong on the board. It lives in `constants.c` and is read from the
target's headers at compile time.

## The obligation always sits on the same side

A contract you have to remember is a bug waiting to be written, so where this
runtime owns both sides of an interface, it does not have one.

`handle.write()` used to return `true` when `uv_try_write` had taken the whole
batch inline, and in that case it had registered no completion callback — so
completing the write was the *caller's* job in one branch and the handle's in
the other. The optimization was worth keeping; the split obligation was not. It
now calls back exactly once either way, synchronously when the write finished
inline, and returns nothing.

The general form: **a callback this layer accepts is invoked exactly once**,
whether the work finished immediately or went to the loop, and a caller never
has to inspect a return value to find out whose turn it is. `connect`, `write`,
`shutdown` and `close` all behave this way. `accept()` is the deliberate
exception and reads as one — it returns a handle or `null` and takes no
callback, because there is nothing asynchronous about it.

This is worth stating because we cannot do it everywhere. Node's own stream
interface has exactly the trap described above — `push(null)` records EOF but
somebody must `read()` before `'end'` is announced — and compatibility means
living with it rather than improving it. The rule applies to interfaces this
project defines, not to the ones it reimplements.

## The failure mode to watch

The bug that prompted this document was first explained as our older stream port
diverging from Node's. It was not — the streams agree — and the wrong diagnosis
pointed at the wrong layer. The actual gap was between our `net.js` and Node's
`net.js`: **Node's module implementations do work on top of streams that the
stream API does not reveal.** `net.Socket` calls `read(0)` on connect and after
EOF, and nothing in the stream contract says it must.

So when a stream-shaped thing misbehaves, the first question is not "how old is
our stream port" but "what does Node's *module* do here that we do not" — and
the way to answer it is to run the same program against Node, not to read our
own code. See [omissions.md](omissions.md) for how far the stream port actually
is from Node 26, which is less than that story suggested.
