# Phase 2 — the Tessel floor: plan

Scope and gate come from the strategy document; [phase1-plan.md](phase1-plan.md)
records the Node kernel this builds on, and [phase0-results.md](phase0-results.md)
the feasibility spike under both. Dependency rules are
[DEPENDENCIES.md](../DEPENDENCIES.md); anything harvested follows the Tier 2
procedure in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## The gate

> `fs`, `net` including Unix sockets, `child_process`, `os`, `tty` and
> `dns.lookup`; the binary aliased as `node`; the nodeunit suite green on the
> device; `t2 run` blinky end to end.

Phase 1 delivered a Node kernel with no native-backed I/O: the loader reads files
through primitives written for it, and `fs`, `net` and `child_process` all answer
with a "planned for Phase 2" error ([`runtime/js/entry.js:65`](../js/entry.js)).
Phase 2 is where the runtime stops being a language implementation and starts
being the thing the board actually runs.

## 0. Status

Not started. Phase 1 is complete: six suites (~200 assertions) pass on x86-64 and
on mipsel under QEMU, in CI on both, and the cross-built binary is 6,283,268
bytes against an 8 MB gate.

## 1. What the floor actually is

`node/tessel-export.js` is the 1,919-line library every Tessel script runs
through, so it defines the floor exactly. Its imports are `child_process`,
`stream`, `events`, `fs`, `net` and `util` — and the surface it touches inside
them is far narrower than those names suggest:

| Module | Used | Where |
|---|---|---|
| `fs` | `writeFile(path, string, cb)` — **one call site** | [`tessel-export.js:1342`](../../node/tessel-export.js), writing a digit to a sysfs GPIO node |
| `net` | `createConnection({ path }, cb)` — **one call site** | [`tessel-export.js:311`](../../node/tessel-export.js), the Unix socket to `spid` |
| `child_process` | `exec` ×14, `execSync` ×5 | `exec` is entirely the WiFi/UCI paths; `execSync` is the SAMD21 reset path, lines 221–231 |
| `util` | `deprecate` | already shipped |
| `stream`, `events` | `Duplex`, `EventEmitter` | already shipped |
| `process` | `env`, `on` | already shipped |

**The API surface is narrow; the semantics under it are not.** The one socket is
worked hard: `write` ×13, `on('error'|'end'|'close')` ×4, `destroy`/`destroyed`,
`read`, `ref`/`unref` (lines 325, 579, 592, 1223) and `cork`/`uncork` at more
than twenty sites — 607/611, 625/628, 647/660, 682/689, 855/861, and every SPI
command batch from 1044 through 1167. A `net.Socket` that merely *has* those
methods will not do; they have to mean what Node means by them, because the
board's throughput and its exit behavior both ride on them.

The gate is wider than the floor. The nodeunit suite, the era corpus and
`t2 run` exercise much more of `fs` and `child_process` than the board's own
library does, and that — not `tessel-export.js` — is what sets the scope below.

## 2. Three findings that shape the phase

Phase 1's defining discovery was that CommonJS is synchronous and txiki has no
synchronous file read. Phase 2 has three of the same kind, found by reading the
tree before planning against it.

### `execSync` has no substrate at all

txiki's `core.exec` is not Node's `child_process.exec`. It is `execvp()` —
[`mod_process.c:496`](../deps/txiki.js/src/mod_process.c) — which *replaces the
running process*. The real spawn, `tjs.spawn`
([`core/process.js`](../deps/txiki.js/src/js/core/process.js)), returns a
`Subprocess` whose `wait()` is a promise and whose stdio are WHATWG streams.
Nowhere in txiki is there a synchronous spawn-and-wait.

That matters more than the usage count suggests, because `execSync` is on the
reset path: stop `spid`, export a GPIO, drive it low, reboot
([`tessel-export.js:221–231`](../../node/tessel-export.js)). It cannot be
approximated with a promise.

**Decision: mirror what Node does.** Node's `spawnSync` runs a *private*
`uv_loop_t` to completion rather than blocking the main one. We do the same — a
dedicated loop in C, `uv_spawn` plus pipes, `uv_run(UV_RUN_DEFAULT)`, collecting
stdout, stderr and exit status. It reuses libuv machinery that is already linked
and keeps the main loop's invariants intact.

### The public socket surface cannot serve `net.Socket`

`tjs.connect('pipe', path)` yields a `PipeSocket`
([`core/direct-sockets/pipe.js`](../deps/txiki.js/src/js/core/direct-sockets/pipe.js))
built on WHATWG `ReadableStream`/`WritableStream`. Its base class,
`BaseStreamSocket`, has no `ref`, no `unref` and no `cork`. Both absences are
load-bearing: the `unref()` at `tessel-export.js:325` is the entire reason a
Tessel script exits when nothing else is pending, and cork/uncork is what turns
each SPI command batch into one write instead of a dozen.

The handle-level primitives that *do* carry `ref`/`unref` — `Pipe`, `TCP`, and a
base stream with `startRead`/`stopRead`/`write`/`shutdown`/`fileno`/`ref`/`unref`
([`mod_streams.c:990–1031`](../deps/txiki.js/src/mod_streams.c)) — live on
`tjs:internal/core`, the namespace whose own source says user code must not
import it. Building on it is the coupling R5 exists to prevent, and Phase 1
already declined it once for the same reason.

**Decision: `net.Socket` is our ported `stream.Duplex` over our own libuv handle
native.** `cork`, `uncork` and `_writev` then come free from Phase 1's stream
port — verified present, including the `CorkedRequest` batching path, at
[`_stream_writable.js:314`](../js/node/stream/lib/_stream_writable.js) and
`:469` — so a corked SPI batch becomes a single `uv_write` with multiple buffers
and one `writev()` syscall. This is where step 5 of Phase 1 pays for itself.

### `fs` is three surfaces, and libuv already unifies two of them

Node's `fs` is sync, callback and promise, three times over. txiki has exactly
two synchronous calls — `mkdirSync` and `statSync`,
[`mod_fs.c:1696–1697`](../deps/txiki.js/src/mod_fs.c) — and everything else is a
promise, because its ESM loader does that work down in C.

But `uv_fs_*` is a single API with one switch: pass a callback and the request
runs on the threadpool, pass `NULL` and it runs inline and returns the result.
So **one binding table in C serves both halves of Node's `fs`**, and
`fs.promises` is a thin JS wrapper over the callback layer. That is how Node
itself is built, it keeps the C small, and it means the callback layer is
genuinely asynchronous rather than a synchronous call hidden behind
`setImmediate` — which on a 580 MHz core with slow flash would stall the loop
on every read.

## 3. What we inherit, what we build

| Phase 2 surface | Status | Where it comes from |
|---|---|---|
| `fs` | **Build** | The largest item. One `uv_fs_*` binding table; sync/callback/promise layers in JS; `Stats`, `Dirent`, `constants`, `ReadStream`/`WriteStream` over the Phase 1 stream port. Phase 1's `readFileSync`/`pathKind`/`realpathSync` generalize into it. |
| `net` | **Build** | `Socket` as a `Duplex` over a first-party pipe/TCP handle native; `createConnection`, `Server`/`createServer`, `isIP`/`isIPv4`/`isIPv6`. Unix sockets first — that is the spid path. |
| `child_process` | **Build** | `spawn` over `uv_spawn` with an `EventEmitter` and our streams; `exec`/`execFile` as buffering wrappers; `execSync`/`execFileSync`/`spawnSync` on a private loop (§2). `fork` needs an IPC channel nothing here has — it gets an explicit error, not a stub. |
| `os` | **Wrap** | [`mod_os.c:519–540`](../deps/txiki.js/src/mod_os.c) already has `uname`, `uptime`, `cpuInfo`, `loadavg`, `networkInterfaces`, `homeDir`, `hostName`, `tmpDir`, `userInfo`, `availableParallelism` — but on the internal namespace, so the handful we need get first-party bindings alongside the rest. Mostly shaping into Node's names and return shapes. |
| `tty` | **Wrap + build** | `core.guessHandle(fd)` answers `'tty'`/`'pipe'`/`'file'`, and the TTY handle has `setMode`/`getWinSize`. `isatty` is nearly free; `ReadStream`/`WriteStream` fall out of `net` plus the stream port. Phase 1 already ships an `isTTY` native. |
| `dns` | **Wrap** | `lookup` over `getaddrinfo` ([`core/lookup.js`](../deps/txiki.js/src/js/core/lookup.js)) with Node's callback shape, plus `dns.promises.lookup`. The resolver family (`resolve4`, `resolveMx`, …) is not in the gate and is not planned here. |
| `process.stdout`/`stderr` | **Close a deviation** | Become real `Writable`s now that `stream` exists. |
| `setImmediate` | **Close a deviation** | A real `uv_check` handle. `tessel-export.js` polls on `setImmediate` in the reset path and uses it in `Pin.read`, so its ordering against I/O stops being academic. |

## 4. The native primitives Phase 2 needs

Everything below goes in `runtime/src/natives.c` behind the same `__t2native`
object, under the same bar Phase 1 set: native only when JS cannot express it.

- **A `uv_fs_*` binding table** — `open`, `read`, `write`, `close`, `stat`,
  `lstat`, `fstat`, `readdir`, `unlink`, `rename`, `mkdir`, `rmdir`, `access`,
  `chmod`, `realpath`, `readlink`, `symlink`, `link`, `copyfile`, `ftruncate`,
  `utime`, `fsync`, `fdatasync` — each synchronous when handed no callback and
  threadpool-async when handed one.
- **A stream-handle native** for pipes and TCP: `connect`, `bind`/`listen`/
  `accept`, `startRead`/`stopRead`, `write`/`writev`, `shutdown`, `close`,
  `ref`/`unref`, `fileno`, `getsockname`/`getpeername`, `setNoDelay`/
  `setKeepAlive`.
- **`spawn`** over `uv_process_t` with an exit callback and stdio pipes, and
  **`spawnSync`** on a private loop.
- **Small ones:** `guessHandle` and the TTY mode/winsize pair for `tty`;
  `getaddrinfo` for `dns.lookup`; `uv_resident_set_memory` so
  `process.memoryUsage()` stops reporting zeros; a `uv_check` handle for
  `setImmediate`.

Errors keep the shape Phase 1 established — Node's `code`, `errno`, `syscall`,
`path`, and Node's message text — because era code branches on `err.code` and
prints the rest.

### Patch 0004: one line, same posture as 0002

Most of that needs the event loop, and an embedder cannot get it.
`TJS_GetLoop()` is defined and externally linked at
[`vm.c:1036`](../deps/txiki.js/src/vm.c) but declared only in
[`private.h:252`](../deps/txiki.js/src/private.h); the public header
[`tjs.h`](../deps/txiki.js/src/tjs.h) does not mention it.

**Patch 0004 promotes that one declaration to `tjs.h`.** No new code, no
behavior change, nothing added to the ABI that was not already exported — and
the same argument as patch 0002: txiki is explicitly an embeddable library, and
an embedder that links `libtjs_core` to add libuv-backed natives needs the loop
those natives run on. Fork branch becomes `t2/v26.6.0+tessel.4`, patch mirrored
to `runtime/deps/patches/txiki.js/`, per the naming rule in DEPENDENCIES.md.

That keeps the running total at four small patches, each widening a public seam
rather than reaching through one.

**But the patch is not on the critical path, because the synchronous half of
`fs` does not need a loop.** `uv_fs_*` accepts a `NULL` loop for synchronous
requests, and Phase 1 already relies on this: `readFileSync` calls
`uv_fs_open`/`uv_fs_fstat`/`uv_fs_read`/`uv_fs_close` with `NULL` throughout
([`natives.c:101`](../src/natives.c)), and it has been passing on x86-64 and
mipsel since step 1. So the largest single piece of Phase 2 — the whole
synchronous `fs` surface — can be built and tested before the fork is touched at
all. The loop is needed for the *callback* half of `fs`, for `net` handles, for
`uv_spawn` and for the `uv_check`, which is to say for steps 1b onward.

## 5. Ordering

Chosen so that the board's own capabilities come up in the order that makes them
testable, and so blinky is reachable before the largest remaining piece starts.

1. **`fs`** — the binding table, then sync, then callback, then `promises`, then
   `Stats`/`Dirent`/`constants`, then the streams. Everything downstream uses it,
   and it retires three corpus packages at once. The sync surface comes first
   deliberately: it needs no loop and so no fork patch (§4), which puts the
   phase's biggest piece of JS in front of its first upstream change rather than
   behind it.
2. **`net`** — the handle native, then `Socket` as a `Duplex`, Unix sockets
   before TCP, then `Server`. **Blinky is reachable at the end of this step:**
   an LED write is `fs.writeFile` to sysfs and a `Port` is the spid socket;
   neither touches `child_process`.
3. **`child_process`** — `spawn`, then `exec`/`execFile` over it, then the
   synchronous family on its private loop.
4. **`os`, `tty`, `dns.lookup`** — small, independent, parallelizable.
5. **The `node` alias and firmware packaging** — the binary installed where the
   board expects it, and the deviations from §6a closed.
6. **The gate** — nodeunit on the device, `t2 run` blinky, the corpus
   inversions, CI.

## 6. Testing

Three rings, not two. Phase 1's suites run on x86-64 and on mipsel under QEMU;
Phase 2 adds the board itself as the authority for anything that spawns.

- **New suites** in `runtime/test/`: `fs`, `net`, `child_process`, and one
  covering `os`/`tty`/`dns` together. Registered in `run.sh` beside the existing
  six, and runnable against a path so the same files run under QEMU and on the
  board — the property `run.sh` was built for.
- **Corpus inversions.** Three of the packages in `runtime/test/corpus/` assert
  today that they resolve through a real `node_modules` walk and then fail
  *exactly* at the `fs`/`tty` boundary: `debug` needs `tty`, `rimraf` and
  `graceful-fs` need `fs`. Phase 2 turns those assertions inside out. They are
  the phase's cheapest real-world signal, and the corpus has already caught one
  bug our own tests structurally could not.
- **nodeunit on the device.** `node/test/unit/tessel.js` is 131 KB of tests
  driven by grunt, nodeunit and sinon. Getting it green on the board is the
  gate's own wording, and it is a harder ask than the suites above — it is
  third-party test infrastructure, not our code, exercising `fs` and
  `child_process` through mocks. Treat the first run as discovery, not as a
  pass/fail step, and budget for the tail.
- **`t2 run` blinky.** End to end through the real CLI: bundle, push, execute,
  observe the LED. The one test that proves the alias, the loader, `fs`, `net`
  and the spid protocol all work at once.

**The QEMU caveat stands, unchanged from Phase 1 decision 4.** `binfmt_misc`
routing was verified on 2026-09-08 — a mipsel `node` spawns another mipsel
`node`, pipes its stdout and collects an exit status — so `child_process` *is*
exercisable in CI. But qemu-user still cannot share memory across
`clone(CLONE_VM)`/`vfork`, so libuv falls back to `fork` and the emulated path is
not the board's path. **Green CI is an early-warning system; the Tessel signs off
the gate.**

## 6a. Deviations this phase closes

From the Phase 1 list ([phase1-plan.md §5a](phase1-plan.md)):

| Deviation | Closed by |
|---|---|
| `process.stdout`/`stderr` are not Writable streams | Step 5, now that `stream` exists |
| `process` is not an `instanceof EventEmitter` | Step 5 — the bootstrap re-bases it once the loader is up |
| `process.memoryUsage()` returns zeros | A native over `uv_resident_set_memory()` |
| `setImmediate` is `setTimeout(fn, 0)` | A `uv_check` handle — and the board's reset path polls on it |

`process.nextTick` ordering inside later turns, and `util.inspect` fidelity, stay
open: neither has produced a symptom, and both cost more than they currently
return. New deviations get appended to that table as they are created, not
reconstructed at the end.

## 7. Budget and risks

- **Size.** 6,283,268 bytes today against the 8 MB gate — 1.9 MB of headroom,
  and LTO, `MinSizeRel` and dropping txiki's `run-main`/`run-repl` bundles all
  remain unspent. Phase 2's cost is mostly C, which is far denser than bytecode;
  `fs` is the one JS surface large enough to notice. The per-module lazy loading
  from Phase 1 applies unchanged, and matters more here: a blinky must not pay
  for `child_process`.
  Any new CMake target has to opt into `-ffunction-sections`/`--gc-sections`
  explicitly — txiki applies them to its own executable only, and that trap
  already cost 1.1 MB once.
- **`net.Socket` semantics** are the phase's R3 — the subtlest surface, the same
  role streams played in Phase 1. Half-open connections, `allowHalfOpen`,
  `destroy` versus `end` ordering, and the exact `'close'`-after-`'end'` sequence
  are where era code and `tessel-export.js` both have opinions.
- **`spawnSync` on a private loop** is correct but needs care about reentrancy:
  nothing on the main loop may run while it is blocked, and the child's stdio
  must not be registered on the loop it is not running on.
- **nodeunit on the device** is the schedule risk. It is third-party test
  infrastructure whose failures will not always be ours.
- **The board is a single point of verification** for `child_process` and the
  spid protocol, and it is reachable only over ssh with 2015-era dropbear
  options. Device tooling is in `runtime/scripts/device/`; the constraints
  (never transfer files over the USB console; USB and Ethernet not
  simultaneously available) are in [phase0-results.md](phase0-results.md).

## 8. Decisions taken

1. **`net.Socket` over first-party libuv handles, not txiki's WHATWG sockets**
   (§2). The public surface cannot express `ref`/`unref` or `cork`, and the
   internal one is off limits.
2. **`spawnSync` on a private `uv_loop_t`**, following Node (§2).
3. **One `uv_fs_*` binding table serving both sync and callback `fs`** (§2),
   rather than a synchronous core with an `setImmediate` veneer.
4. **Patch 0004 promotes `TJS_GetLoop` to the public header** (§4) — one
   declaration, upstreamable, riding the fork like 0002 and 0003.
5. **`fork()` gets an explicit unsupported error, not a stub.** It needs an IPC
   channel this runtime has no path to, nothing on the board uses it, and a
   `fork` that silently behaves like `spawn` is worse than one that says so.

Still open:

- **What `process.version` should report.** Carried over from Phase 1 §7,
  where it was deferred to "Phase 2 or 3". It still tracks txiki's version and
  reads as `v26.6.0` by coincidence rather than decision, which invites era code
  down modern paths this runtime does not serve. Phase 2 is when the evidence
  arrives: the corpus and the nodeunit run will show what actually feature-
  detects on it. **Decide at the end of this phase, not the start**, and record
  the answer here.
