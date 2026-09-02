# Contributing

For the SAMD21 firmware and the `node/` library, see the build and test notes in
[README.md](README.md). This document covers the parts of contribution that carry
policy: dependencies and harvested code in the runtime (`runtime/`).

The full dependency policy — tiers, admission criteria, the prime directive — lives
in [runtime/DEPENDENCIES.md](runtime/DEPENDENCIES.md). The short version: the
runtime must build with the pinned OpenWrt SDK, offline, forever, and CI enforces
that structurally. Run the checks locally with:

```
make check-deps
```

## Adding a dependency

1. Read the admission criteria for the tier you're proposing in
   [runtime/DEPENDENCIES.md](runtime/DEPENDENCIES.md). If the dependency fails a
   criterion, either stop or write a waiver (below).
2. Add a `[[dependency]]` entry to
   [runtime/deps/MANIFEST.toml](runtime/deps/MANIFEST.toml): name, tier, intake
   mode, upstream URL, SPDX license, notes. Tier 1 entries need
   `breaks_if_removed`; tier 2 entries need `harvest_paths`.
3. Bring in the code by its intake mode:
   - **Submodule** (live upstreams): add under `runtime/deps/`, pinned by SHA. If
     it needs patches, fork it first and pin the fork branch
     (`t2/v<upstream-version>+tessel.<n>`), mirroring the patches into
     `runtime/deps/patches/<dep>/` with `git format-patch`.
   - **In-tree copy** (artifacts, frozen code): unpack the release artifact under
     `runtime/deps/<name>/` and record the exact version in the manifest.
4. Refresh the generated files and commit them:
   ```
   python3 scripts/deps-check.py --snapshot
   python3 scripts/deps-check.py --notices
   ```
5. `make check-deps` must pass. One dependency per PR.

Upgrades follow the same shape (see the bump checklist in the policy doc):
one dep per PR, changelog reviewed against the portability checklist, patch series
re-applied or retired, snapshot and notices regenerated.

## Waivers

Exceptions to the policy live in the manifest, nowhere else. Add to the dependency's
entry:

```toml
  [[dependency.waiver]]
  rule = "which criterion is being waived"
  reason = "why compliance is worse than the exception"
  approved_by = "github-username"
  review_by = 2027-09-01
```

Maintainer approval of the PR *is* the exception process. Waivers expire — a
`review_by` date in the past fails CI until the waiver is renewed or the dependency
is brought into compliance.

## Harvesting JavaScript (tier 2)

Node-shell modules are adapted from MIT/Apache sources (readable-stream, unenv,
Deno `ext/node`, wasmedge-quickjs), then owned. Never fetched at build time, never
referenced through a package manager. Procedure, in order, one module family per PR:

1. Pick the source and record its exact commit SHA or version.
2. Copy the files into the runtime tree.
3. Add the provenance header to every harvested file:
   ```js
   // Provenance: readable-stream v3.6.2 (lib/_stream_duplex.js)
   //   https://github.com/nodejs/readable-stream @ <sha>
   //   License: MIT. Harvested 2026-08-30.
   //   Local modifications: <summary>
   ```
4. Adapt it to the runtime's substrate.
5. Add tests.
6. Add or update the tier 2 manifest entry (`harvest_paths` must cover the new
   files) and regenerate notices.

After harvest it is first-party code: adapt it freely, and treat any re-harvest as a
fresh audit — never a wholesale re-copy.

## Rules that CI will not let you break

- No runtime npm dependencies: the runtime's `package.json` keeps
  `"dependencies": {}` permanently.
- No submodule appears or moves without a matching
  `runtime/deps/submodules.lock` update.
- No license outside the allowlist enters `runtime/deps/`.
- The cross-built binary's dynamic `NEEDED` list stays within
  musl / libgcc_s / (recorded) libatomic.
- Rust does not enter the target-side build. (Host-side tooling is fine — but
  deleting all of it must not change a byte of the release binary.)
