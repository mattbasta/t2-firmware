# Phase 1 — the Node kernel: plan

Scope and gate come from the strategy document; [phase0-results.md](phase0-results.md)
records what shipped before this. Dependency rules are
[DEPENDENCIES.md](../DEPENDENCIES.md); anything harvested follows the Tier 2
procedure in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## The gate

> A corpus of era scripts and the loader's behavior verified against Node's own
> resolution fixtures, in CI, on QEMU-mipsel and x86 both.

Delivering it means: a CommonJS loader; `process`, `Buffer`, timers and `console`
in the shapes Node gives them; and the pure-JS core modules — `events`, `util`,
`path`, `assert`, `querystring`, `string_decoder`, `url`, `stream`. No native-backed
modules (`fs`, `net`, `child_process`) — those are Phase 2's gate, and the loader
reads files through what txiki already exposes.

## 1. How the runtime attaches to txiki

Phase 0 cross-built and measured txiki's own `tjs` binary. Phase 1 is the first
phase where the artifact has to *be something else*: a binary that parses
`node script.js`, installs Node globals, and hands control to a CJS entry point.
Three facts from the tree decide how:

1. **The entrypoint is hardcoded.** `TJS_Run()` evaluates the CLI bundle directly —
   `tjs__eval_bytecode(qrt->ctx, tjs__run_main, tjs__run_main_size, true)` at
   [`deps/txiki.js/src/vm.c:983`](../deps/txiki.js/src/vm.c). The public embedding
   API (`deps/txiki.js/src/tjs.h:33`) carries only `mem_limit` and `stack_size`, so
   an embedder cannot supply its own entry.
2. **Builtins are a closed table.** `tjs:*` modules are a static array of qjsc
   bytecode blobs in `deps/txiki.js/src/builtins.c`; adding a name means editing
   that file.
3. **There is no script eval.** `tjs.engine.compile(src, name)` compiles with
   `JS_EVAL_FLAG_COMPILE_ONLY | JS_EVAL_TYPE_MODULE`
   ([`src/mod_engine.c:106`](../deps/txiki.js/src/mod_engine.c)). CommonJS needs a
   *classic script* eval that takes a filename, which nothing exposes to JS.

**Decision: our own `main()`, plus exactly one upstream-shaped patch.**

- `runtime/src/main.c` replaces `deps/txiki.js/src/cli.c`: `TJS_Initialize` →
  `TJS_NewRuntimeOptions` → `TJS_GetJSContext` → register our native primitives →
  `TJS_Run`. Our CMake project already injects first-party sources into the txiki
  target (`runtime/CMakeLists.txt`, the `T2_STATIC_DL_STUB` pattern), so this is an
  extension of machinery that exists.
- **Patch 0002 to the fork:** add an entrypoint override to `TJSRunOptions`
  (`const uint8_t *entry; size_t entry_size;`, defaulting to `tjs__run_main`) and
  have `TJS_Run` honor it. Roughly ten lines, no behavior change for existing
  embedders. Written to be upstreamable — saghul's runtime is explicitly an
  embeddable library, and "let the embedder choose the entrypoint" is the missing
  half of that — but it rides the fork for now rather than blocking on a PR. Goes
  to `deps/patches/txiki.js/0002-*.patch` and the fork branch under the naming rule
  in DEPENDENCIES.md.

This keeps R5 (txiki upstream divergence) at the "rides public seams" posture the
strategy asked for: one small patch that widens a seam, not a Node layer stitched
into their internals. Everything else — the loader, the globals, the modules —
is first-party code in `runtime/src` and `runtime/js`.

### The one native primitive Phase 1 needs

`evalScript(source, filename)` — `JS_Eval` with `JS_EVAL_TYPE_GLOBAL` and a real
filename, returning the compiled CJS wrapper function. About thirty lines in
`runtime/src/`, registered on the context by our `main()`.

The alternative is `new Function('exports','require','module','__filename','__dirname', src)`,
which needs no C at all but throws away the filename: every stack frame in every
user module reports as `<anonymous>`. Since era code leans on stack traces (and
`Error.captureStackTrace` is on the compat list), the thirty lines are worth it.

## 2. What we inherit, what we build

| Phase 1 surface | Status | Where it comes from |
|---|---|---|
| `path` | **Free** | `deps/txiki.js/src/js/core/path.js` is Node's own `path`, verbatim — Joyent header, `posix` + `win32`, 1,556 lines. Already compiled into the binary; needs only to be exposed as `require('path')`. |
| `console` | Inherit + shape | `src/js/polyfills/console.js`. Add Node's format specifiers (`%s %d %i %f %j %o %O %c`) and `console.table`/`group` as needed. |
| timers | Inherit + shape | `src/js/polyfills/timers.js`. Node shape needs a `Timeout` object (not an integer) with `ref`/`unref`/`refresh`, plus `setImmediate`/`clearImmediate`. |
| `url` (WHATWG half) | Inherit | `src/js/polyfills/url.js` over ada. The legacy `url.parse`/`format`/`resolve` half is net-new (harvest). |
| `process` | Build | txiki's `core/process.js` is `spawn` only. Node's `process` — `argv`, `env`, `cwd`, `platform`, `arch`, `versions`, `exit` + `'exit'`, `nextTick`, `hrtime`, `stdout`/`stderr`, `uncaughtException` — is ours. `tjs.env`, `tjs.exit`, `tjs.cwd`, `tjs.system` back most of it. |
| **`Buffer`** | Build | The largest net-new item. `Uint8Array` subclass; `from`/`alloc`/`allocUnsafe`/`concat`/`compare`/`isBuffer`; utf8, hex, base64, base64url, latin1, ucs2/utf16le; the full `read*`/`write*` matrix; `new Buffer()` tolerated. Lean on txiki's C `text-coding` and `mod_hashing` rather than doing encodings in JS — this is hot code on a 580 MHz soft-float core. |
| CJS loader | Build | node_modules walk, `main`/`index`, `.json`, `require.cache`, `require.resolve`, circular-dependency semantics, `"exports"` map parsing, `.node` → clear "native addons are not supported" error. |
| `events` | Harvest | Node core, MIT. Small and self-contained. |
| `util` | Harvest + build | `format`, `inspect`, `promisify`, `callbackify`, `inherits`, `deprecate`, plus the resurrected `is*` family (strategy §2.3). `inspect` is the bulky part. |
| `assert` | Harvest | txiki's `src/js/stdlib/assert.js` is zora-derived, *not* Node's — 187 lines, wrong API surface. Harvest Node's `assert` (incl. `deepStrictEqual`). |
| `querystring`, `string_decoder` | Harvest | Node core, small. |
| `stream` | **Port** | `readable-stream` (R3 — the subtlest surface in the plan). Port it rather than reimplement, per the strategy. |

## 3. Build pipeline for our JavaScript

txiki's own pattern, which the policy already anticipates ("the JS stdlib is compiled
to bytecode by a host build of the runtime itself — there is no bundler in the release
path"):

`src/js/**` → esbuild bundle → `tjsc` (qjsc) → a `.c` byte array → `#include`d by
`builtins.c`. The generated `.c` files **are committed** (18 tracked files under
`deps/txiki.js/src/bundles/`), and `tjsc` is `EXCLUDE_FROM_ALL`
(`deps/txiki.js/CMakeLists.txt:226`), so a release cross-build never runs a bundler
or npm — `runtime/scripts/build-cross.sh` doesn't mention `tjsc` at all. Phase 0
proved the embedded-bytecode path end to end: bundles generated on x86-64 ran
correctly on the board.

We mirror it for `runtime/js/**`, with two constraints to record:

- **The bytecode is host-generated and endianness-bound.** The BC reader has no
  byte-swap path — `bc_get_u16`/`bc_get_u32` are native-endian loads and the opcode
  buffer is a raw `memcpy` — so the serialized form is native-endian. x86-64 →
  mipsel works because both are little-endian (proven in Phase 0). A big-endian
  target would need regeneration on a big-endian host; not our target, but it
  belongs in the notes.
- **Bundler: esbuild, as txiki does it** (decided). It is driven via `npx`
  (`Makefile:19`), stays Tier D, and stays out of the release path because the
  generated `.c` is committed. Needs a MANIFEST entry.

### What the shipped bytecode actually is, and the laziness rule

Each bundle becomes a literal array in a generated C file — `const uint8_t
tjs__uuid[17331] = { 0x1b, 0xd9, ... };` — compiled into `.rodata` and shipped inside
the binary. No filesystem, no archive. The bytes are QuickJS's `JS_WriteObject`
serialization; `tjsc -s` sets `JS_WRITE_OBJ_STRIP_SOURCE`, so source text is dropped
while debug info survives (that would need `-ss`), and stack traces keep line numbers.

Loading is *not* execute-in-place, and cannot be. `JS_ReadObject(...,
JS_READ_OBJ_BYTECODE)` is closer to a linker than a parser: the opcode array itself
is flat and arrives in one `memcpy` (`deps/quickjs/quickjs.c:39591`), but the reader
then walks it and rewrites every atom operand in place —
`idx = get_u32(...)`, `bc_idx_to_atom(...)`, `put_u32(...)` — relocating
stream-local atom indices to live runtime atom IDs. Atoms are the runtime's global
interned string table, so the same name has a different ID in every process; the
blob carries its own atom table (`JS_ReadObjectAtoms`, `quickjs.c:40491`) and
indices into it. String constants, the constant pool, closure metadata and module
import/export tables are allocated as real refcounted objects on the way in.

Execute-from-flash is not an option that was passed over: quickjs-ng defines
`JS_READ_OBJ_ROM_DATA` as `(0)`, "obsolete, broken by ICs"
(`deps/quickjs/quickjs.h:1268`) — inline caches mutate bytecode at runtime, so it
cannot live in read-only memory. Every loaded bundle is an unconditional
flash-to-RAM expansion. It is still far cheaper than parsing source, since the
tokenizing, parsing and codegen already happened on the host — a large part of
Phase 0's 0.18 s startup against Node's 2.41 s.

Current cost, our config (FFI and WASM off): **472 KiB of embedded bytecode, 7.8% of
the 6,164,468-byte binary.** It divides into two tiers:

| Bundle | Bytecode | Loaded |
|---|---|---|
| `polyfills` + `core` | 354 KiB | Eagerly, every process start (`src/vm.c:535`) |
| `run_main` (the CLI) | 26 KiB | Eagerly (`src/vm.c:983`) |
| `tjs:*` stdlib | 93 KiB | Lazily, on import (`src/builtins.c:91`) |

**Rule for Phase 1: the Node stdlib ships as lazy builtins, not in the eager core
bundle.** `require('stream')` must cost nothing until a program calls it. Only what
has to exist before user code runs — the CJS loader, `process`, `Buffer` — belongs in
the eager path. Inverted, the readable-stream port would tax the startup and RSS of
every program on the board, including a blinky that never opens a stream. This is
also the lever for the RSS half of Phase 0's gate, which Phase 1 must not regress.

## 4. Ordering

1. **Seam** — patch 0002, `runtime/src/main.c`, `evalScript`, our own bundle
   pipeline and a `node`-shaped argv parse (`node file.js`, `-e`, `-p`, `--`).
   Nothing else can be tested until a first-party entrypoint runs.
2. **`process` + `Buffer`** — everything downstream assumes them.
3. **Loader** — with `require.cache` and circular semantics; `path` wired through.
4. **`events`, `util`, `assert`, `querystring`, `string_decoder`, legacy `url`** —
   independent harvests, parallelizable.
5. **`stream`** — last of the modules and the riskiest; the readable-stream port
   wants the rest of the kernel underneath it.
6. **Corpus + CI** — the gate itself.

## 5. Testing, and one wrinkle from Phase 0

Two suites, both required on x86 *and* QEMU-mipsel:

- **Resolution fixtures** — Node's own `test/fixtures/node_modules` trees and the
  `require` resolution tests, harvested per Tier 2.
- **Era corpus** — the packages the strategy names (`readable-stream`, `debug`,
  `rimraf`, `graceful-fs`, `iconv-lite`), exercised as scripts.

**The wrinkle:** Phase 0 found that `tjs test` cannot run under qemu-user without
binfmt_misc — the runner spawns a child per test file and `execve` of a MIPS binary
fails with `ENOEXEC`. Phase 0 worked around it by running each file with `tjs run`.
Phase 1's CI needs a decision up front: either a runner with
`sudo apt-get install qemu-user-static` (binfmt registered, spawning works), or a
one-file-per-invocation harness that never spawns. The former is better —
`child_process` is Phase 2's gate and will need real spawning anyway.

## 6. Budget and risks

- **Size.** Phase 0 shipped 6,164,468 bytes against the strategy's 8 MB gate, with
  sqlite on and neither LTO nor `MinSizeRel` applied. Phase 1 adds bytecode for
  perhaps 15–25k lines of JS plus a little C. Headroom looks adequate, and LTO,
  `MinSizeRel`, and dropping txiki's `run-main`/`run-repl` bundles are all still
  unspent. Track the per-commit size delta from the first Phase 1 commit rather than
  discovering it at the end.
- **R3 (streams fidelity)** is the phase's main technical risk and is why `stream`
  is a port, not a reimplementation.
- **Harvest provenance.** Every harvested file needs the Tier 2 header (project,
  path, commit, license, date, modifications). Cheap per file, expensive to
  retrofit across twenty of them.
- **`Error.captureStackTrace`** — the strategy lists it as present in quickjs-ng and
  as something era code calls. Confirm it on the first host build rather than at
  the gate; if absent it is a small shim, but it should not be a surprise.

## 7. Decisions taken

1. **Bundler: esbuild**, matching txiki — committed generated bytecode, esbuild Tier D,
   nothing bundler-shaped in the release path.
2. **Patch 0002 rides the fork.** It is written to be upstreamable and should go up
   eventually, but not as a blocking PR: Phase 2 exercises the shape first, and an
   upstream review round-trip is not on the critical path.
3. **First-party JS lives in `runtime/js/`**, beside `runtime/src/`, keeping the
   fork's diff to the single entrypoint patch.

Still open: whether the Phase 1 CI runner gets `binfmt_misc` (see §5) — decide before
the corpus job is written, not after.
