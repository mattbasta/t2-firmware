# Phase 0 — feasibility spike results

Running log of the strategy's Phase 0 gates for the Tessel 2 runtime. Gate
definitions come from the strategy document; the dependency rules from
[DEPENDENCIES.md](../DEPENDENCIES.md).

## Status

| Gate | Result | Where |
|---|---|---|
| Cross-compiles with the pinned OpenWrt SDK, offline | **Pass** | Daddy, 2026-09-02 |
| Static binary ≤ 8 MB | **Pass — 6,164,468 bytes** (6.02 MB), sqlite on, no LTO/MinSizeRel yet | Daddy |
| Numerics correct on 32-bit soft-float | **Pass under QEMU** — 0/4,588 test262 errors in the numerics slice; probe values exact | QEMU (qemu-mipsel 8.2) |
| Engine conformance on MIPS matches x86 | **Pass** — full test262 byte-identical to the native build (38/43,034 upstream-known failures) | QEMU |
| Platform layer (libuv/mbedTLS/sqlite/…) works on MIPS | **Pass with one fix** — txiki suite: 217 pass; the only MIPS defect (static-musl `dlsym` crash) is fixed by `runtime/src/static_dl_stub.c` | QEMU |
| Numerics correct on the real 24KEc (pre-NaN2008 core) | **Pending — needs the board attached** | — |
| Startup ≥ 5× faster than Node 8, RSS ≤ ⅓ | **Pending — needs the board** (QEMU timings are not representative) | — |
| spid handshake from the runtime | **Pending — needs the board** | — |

## Build

- SDK: `openwrt-sdk-25.12.5-ramips-mt7620_gcc-14.3.0_musl` (pinned in the manifest).
- Toolchain file: [`runtime/cmake/openwrt-mipsel.cmake`](../cmake/openwrt-mipsel.cmake);
  driver: [`runtime/scripts/build-cross.sh`](../scripts/build-cross.sh).
- Output: `ELF 32-bit LSB executable, MIPS, MIPS32 rel2, statically linked`,
  stripped, `--gc-sections`, Release.
- Everything in the tree compiled for MIPS on the first attempt (quickjs-ng
  0.16.0, libuv 1.52, mbedTLS 3.6.6, libwebsockets, ada, miniz, sqlite,
  tweetnacl). The only problems were at link time, both toolchain quirks:
  - MIPS32 has no native 64-bit atomics; quickjs-ng's `Atomics` reach
    `libatomic`, which must be listed *after* the archives that use it.
  - OpenWrt's gcc specs omit `-lgcc_eh` under `-static` (their unwinder ships in
    the shared `libgcc_s`), so libstdc++'s exception personality — pulled in by
    ada — only links with `-lstdc++ -lgcc_eh` named explicitly, in that order.
- A fully static musl binary was chosen deliberately: it satisfies the
  no-system-libraries rule and should also run on the original uClibc-era
  Tessel 2 firmware, which allows side-by-side measurement against Node 8
  without reflashing first.

## Under QEMU (qemu-mipsel-static 8.2.2, x86-64 host)

- `tjs eval 'console.log(...)'` runs; `tjs.version` reports 26.6.0.
- Numerics probe (NaN self-inequality, `Object.is(-0, 0)`, 2⁵³ rounding,
  `toFixed`, `Math.round` on halves, BigInt, `Math.fround`, `Float64Array`
  NaN round-trip, `Date.UTC`) matches the x86-64 reference exactly.
- test262 numerics slice, `run-test262 -c test262.conf` per directory:
  Number 340, Math 327, parseFloat 54, parseInt 55, DataView 561, TypedArray
  1446, TypedArrayConstructors 738, ArrayBuffer 221, BigInt 77, Date 586 (8
  skipped), types/number 21, literals/numeric 157 — **all 0 errors**.
  Atomics: 5 run, 384 skipped by the config (SharedArrayBuffer/wait features).
- **Full test262** (`run-test262 -c test262.conf`, 43,034 tests run, 4,802
  excluded, 5,736 skipped): **38 errors on mipsel — byte-identical to the
  native x86-64 build of the same quickjs-ng commit** (the logs differ only in
  timing lines). Every failure is an upstream-known one; nothing is
  MIPS-specific. Wall time under QEMU with 32 threads: ~21 s.

## txiki.js test suite under QEMU (380 files, run one at a time)

The runner itself (`tjs test`) cannot be used under qemu-user: it spawns dozens
of `tjs` children, and qemu-user without binfmt_misc cannot `execve` a MIPS
binary (`ENOEXEC`). Running each file with `tjs run` instead, and comparing
against the same fork built natively on x86-64 (278 OK / 64 FAIL / 38 SKIP —
the FAILs are the FFI tests, which the runner does not feature-skip):

- **217 pass** on mipsel.
- **28 `test-wasm-*` fail** — expected: WASM is off and `tjs run` bypasses the
  runner's feature-skip list. The host run skips them.
- **1 `test-exec.js` and the spawn-of-self tests fail with `ENOEXEC`/`EPERM`**
  — the binfmt limitation above. On a CI runner with `sudo apt-get install
  qemu-user-static`, binfmt_misc is registered and these should run.
- **73 segfaulted** before the fix below. **This was the one real MIPS defect
  found in Phase 0.**

### Defect: `dlsym()` crashes in any static musl binary on MIPS

Every crashing test spawned a subprocess. The gdb backtrace under qemu
(`-g` + the SDK's `mipsel-openwrt-linux-gdb` on an unstripped build) ends in
`__dlsym_time64` at `src/ldso/mips/dlsym.s:14`, jumping to a garbage address.
A three-line C program calling `dlsym(RTLD_DEFAULT, "printf")` reproduces it
with `-static` and `-static-pie`; only a dynamic link works. musl's MIPS
`dlsym` is an assembly shim that derives `$gp` from `$t9` per the PIC calling
convention, which static non-PIC callers never set up.

Callers in our link: libuv (one startup probe for
`posix_spawn_file_actions_addchdir`, plus `uv_dlopen`) and sqlite's extension
loader. Fix: `runtime/src/static_dl_stub.c` defines `__dlsym_time64`/`dlsym`
returning NULL — the answer musl gives for an unknown symbol, and the only
possible answer in a static binary — and `runtime/CMakeLists.txt` links it
when `T2_STATIC_DL_STUB=ON` (set by `build-cross.sh`). With the stub, `spawn`
works and the 73 tests run. Worth reporting to musl (static MIPS `dlsym`) and
libuv (prefer the direct symbol on musl); tracked as a follow-up.

### QEMU-only limitations (not runtime bugs)

- `clone(CLONE_VM)`/`vfork` does not share memory under qemu-user
  (libuv's own probe reports `works=0` and falls back to `fork`).
- No binfmt_misc without root → a MIPS binary cannot spawn another MIPS binary.

## Repro

```
scripts/fetch-sdk.sh build/sdk
runtime/scripts/build-cross.sh build/sdk build/mipsel
runtime/scripts/test-qemu.sh build/mipsel build/sdk     # TEST262_QUICK=1 to skip test262
```

Host prerequisites without root: a CMake binary tarball on `PATH`, and
`qemu-user-static` extracted from the distro package (`apt-get download` +
`dpkg -x`).

## Open items for the on-device session

1. Copy `build/mipsel/tjs` to the board (works on either the stock firmware or
   the tessel-2-revive image) and rerun the numerics probe and the test262
   numerics slice there — this is the R1 gate, and QEMU cannot close it.
2. Measure wall-clock startup, RSS, and a small benchmark against the installed
   Node 8.11.3 on the same board.
3. Open spid's Unix socket from `tjs` and toggle a pin.
