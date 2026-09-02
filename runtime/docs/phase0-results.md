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
