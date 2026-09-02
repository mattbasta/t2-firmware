# Dependency Policy

This document governs every third-party component in the Tessel 2 runtime. It exists
because transitive dependencies quietly kill niche targets: the runtime targets a
32-bit, soft-float, 64 MB MIPS system that mainstream toolchains have already
abandoned once. The policy makes portability a structural guarantee, not a hope.

## Prime directive

> A fresh clone plus the pinned OpenWrt SDK (gcc/musl, soft-float, mipsel_24kc) must
> produce the release binary, offline, forever. Nothing in the release build path may
> depend on a toolchain, package registry, or network service other than
> `git submodule update` and one sha256-pinned SDK tarball.

Every rule below serves that sentence. When a proposed dependency and the prime
directive conflict, the dependency loses.

## The manifest

[`deps/MANIFEST.toml`](deps/MANIFEST.toml) is the single source of truth. Every
dependency — including the toolchain, and including *denied* dependencies (kept as
tombstones so the rationale travels with the repo) — has exactly one entry. CI
([`deps-police`](../.github/workflows/deps-police.yml), backed by
[`scripts/deps-check.py`](../scripts/deps-check.py)) fails on anything present in the
tree but absent from the manifest, and on any waiver past its review date. If it's not
in the manifest, the answer is no.

## Tiers and admission criteria

### Tier 0 — Core spine

The runtime does not exist without these: **quickjs-ng, libuv, mbedTLS, llhttp, and
the OpenWrt SDK itself** (the toolchain is a dependency and is pinned like one).

All criteria are mandatory:

- **Language:** C99/C11 only. No C++, no Rust, no required assembly. Per-arch fast
  paths are acceptable only with a portable C fallback selectable at compile time.
- **Portability:** 32-bit clean (no `sizeof(void*) == 8` assumptions); alignment-safe
  (MIPS traps on unaligned access — a kernel fixup is a silent ~100× slowdown, so
  treat unaligned access as a bug); no *required* lock-free 64-bit atomics (a
  libatomic fallback is acceptable if recorded in the manifest as a linked runtime
  lib); no hard-float ABI assumptions; no mandatory `dlopen`.
- **Build:** builds with plain make or CMake using only the SDK compilers. Build-time
  codegen is allowed **only if the generated output is what we vendor** (llhttp is
  the model: upstream's TypeScript→C generator runs at *their* release time; we
  vendor the release tarball's C and never run the generator).
- **License:** MIT, BSD-2/3-Clause, Apache-2.0, ISC, Zlib, 0BSD, Unlicense, or
  public domain. Nothing copyleft — everything statically links into one binary.
- **Ownability:** if upstream vanished today, one or two maintainers could plausibly
  keep it building and patch CVEs indefinitely. (This is why quickjs-ng and mbedTLS,
  not a JIT engine and OpenSSL.)
- **No system libraries:** the shipped binary's dynamic `NEEDED` list may contain
  only musl libc, `libgcc_s`, and — if recorded in the manifest — `libatomic`.
  Everything else is statically linked. Enforced with `readelf -d` in CI.
- **Maintenance:** upstream released or meaningfully committed within 18 months, or
  the manifest declares it `frozen` and we own it.

### Tier 1 — Batteries

Useful, removable without redesigning the runtime, individually toggleable at the
CMake level: **ada, miniz, tweetnacl, libwebsockets, sqlite3**.

Same criteria as Tier 0, with two relaxations, each requiring a manifest waiver:

- **C++ is permitted** for a specific dependency when no credible C alternative
  exists. *ada is the day-one waiver* (C++; build with `-fno-exceptions -fno-rtti`
  where feasible, statically link libstdc++, and record the size cost). This
  deliberately exercises the waiver mechanism from the start.
- **Frozen upstreams** are acceptable when the code is small enough to own outright
  (tweetnacl, miniz).

Every battery carries a "what breaks if we delete it" note in its manifest entry, so
future removal is a decision, not archaeology.

### Tier 2 — Harvested-then-owned code

JavaScript (occasionally C) copied from MIT/Apache sources, adapted, and thereafter
maintained as first-party source. Sources include readable-stream, unenv, Deno's
`ext/node`, wasmedge-quickjs, and Node core test fixtures.

- Copied into the tree — **never referenced through a package manager, never fetched
  at build time.**
- Every harvested file carries a provenance header: upstream project, upstream path,
  commit SHA or version, upstream license, harvest date, and a summary of local
  modifications. (A deliberate exception to this repo's no-per-file-headers
  convention: harvested files are exactly where provenance matters.)
- The upstream license must be on the allowlist, and the file appears in the
  generated third-party notices.
- After harvest it is our code: adapted freely, tested by our suite. Re-harvesting is
  a fresh audit, never `cp -r`.

### Tier D — Dev and CI tooling (host-side only)

Anything that runs only on developer machines or CI: test runners, linters, QEMU,
size-report scripts.

- **Litmus test:** deleting `node_modules`, cargo, pip, and everything in Tier D must
  not change a single byte of the release binary.
- npm devDependencies are allowed with a committed `package-lock.json` and
  `node_modules` gitignored (the existing `node/` convention).
- Rust, Go, and Python are allowed here (see "Rust's place" below).
- The release build path itself is restricted to: git, POSIX sh, GNU make, CMake, the
  SDK, and the host-built runtime (the JS stdlib is compiled to bytecode by a host
  build of the runtime itself — there is no bundler in the release path).

## Intake modes

1. **Submodule** — SHA-pinned under `runtime/deps/`, for live upstreams we track.
   The txiki.js fork is the primary submodule and carries quickjs-ng, libuv, mbedTLS,
   and libwebsockets transitively via its own submodules, so there is one source of
   truth for those pins. `runtime/deps/submodules.lock` snapshots
   `git submodule status --recursive`; CI diffs it so no dependency arrives or moves
   silently.
2. **In-tree copy** — for release artifacts and small frozen code (llhttp's generated
   C; ada/miniz/tweetnacl/sqlite3 as carried in txiki's tree). Rule of thumb: vendor
   in-tree when what we consume is an *artifact* (amalgamation, generated output)
   rather than a live source tree.
3. **Harvest-and-own** — Tier 2, per the procedure in
   [CONTRIBUTING.md](../CONTRIBUTING.md).

## Patches to vendored dependencies

- Patched submodules point at **forks under the maintainer's GitHub account**, on
  branches named `t2/v<upstream-version>+tessel.<n>`. Builds pin against forks —
  reproducible, with no patch-application step at build time.
- The same deltas are mirrored as numbered patch files in
  `runtime/deps/patches/<dep>/NNN-description.patch`, regenerated with
  `git format-patch <upstream-tag>..<t2-branch>`. The patch directory is the
  reviewable, fork-loss-proof record of exactly how far we've diverged. CI verifies
  that the fork pin's diff against its recorded upstream base equals the patch
  series.

## Upgrades

- **Security bumps** (mbedTLS, quickjs-ng CVEs): immediately, out of cadence.
- **Everything else:** a quarterly review window. Skipping a bump is fine; skipping
  the review is not.
- Every bump PR contains exactly one dependency and includes: the manifest diff; the
  patch series re-applied (or explicitly retired) with the fork branch renamed; the
  upstream changelog reviewed against the portability checklist (new atomics?
  alignment assumptions? build deps? language standard? `dlopen`? FPU assumptions?);
  a green cross-build and QEMU run; and the CI-posted size delta.

## JS-layer rules

1. **Zero runtime npm dependencies, ever.** The runtime's `package.json` keeps
   `"dependencies": {}` permanently; CI enforces it.
2. All Node-core-module JS is Tier 2 or original, compiled to bytecode at build time
   by the host-built runtime. No fetch, no registry, no postinstall — ever — in any
   build.
3. devDependencies for tests and tooling follow the Tier D rules.

## Waivers

Open a PR adding a `[[dependency.waiver]]` entry to the manifest with a rationale and
a `review_by` date. Maintainer approval of that PR *is* the exception process — there
is no side channel. Waivers expire: a `review_by` date in the past fails CI until the
waiver is renewed or the dependency is brought into compliance.

## Rust's place

- **Target-side: denied**, as a Tier 0/1 criterion, not a footnote. `mipsel` is a
  Tier 3 Rust target — no prebuilt std, nightly `-Zbuild-std`, and an ecosystem that
  assumes 64-bit atomics. Admitting Rust would make the prime directive contingent on
  nightly toolchain archaeology.
- **Host-side (Tier D): allowed**, subject to the litmus test — no Rust tool may sit
  in the release build path.
- **Escape hatch, pre-agreed:** if `mipsel-unknown-linux-musl` reaches Tier 2 with
  host tools *and* our own CI demonstrates a stable-channel std build against the
  OpenWrt SDK's musl for two consecutive Rust releases, a policy-amendment PR may
  admit Rust for leaf components behind a C ABI. Until both conditions hold: no.

## Current decisions

The authoritative record is the manifest; this table summarizes the initial calls.

| Component | Decision | Notes |
|---|---|---|
| quickjs-ng, libuv, mbedTLS | Keep — Tier 0 | Engine, event loop, TLS + crypto primitives |
| llhttp | Keep — Tier 0 | Vendored generated C from release tarballs |
| ada | Keep — Tier 1, C++ waiver | WHATWG URL; no credible C equivalent |
| miniz | Keep — Tier 1 | Backs `node:zlib` via a first-party shim |
| tweetnacl | Keep — Tier 1, contained | txiki surfaces only; `node:crypto` builds on mbedTLS |
| libwebsockets | Keep — Tier 1, removal candidate | Re-evaluate once first-party http/ws on llhttp exist |
| sqlite3 | Keep — Tier 1, **default ON** | `node:sqlite` parity + on-device storage; ~900 KB flash |
| WAMR | **Deny** (`BUILD_WITH_WASM=OFF`) | No Node-shell use case; size and attack surface; MIPS untested upstream |
| libffi | **Deny** (`BUILD_WITH_FFI=OFF`) | The only system lib in txiki; shaky mips-o32 soft-float assembly history; hardware access uses spid's domain socket |
| mimalloc | **Deny** (`BUILD_WITH_MIMALLOC=OFF`, host too) | Designed for 64-bit servers; musl's mallocng fits this class; host/target heap behavior kept identical |
