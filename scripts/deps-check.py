#!/usr/bin/env python3
"""Dependency-policy enforcement for the Tessel 2 runtime.

Checks runtime/deps/MANIFEST.toml (the single source of truth — see
runtime/DEPENDENCIES.md) against the tree:

  * manifest entries are well-formed and licenses are on the allowlist
  * waivers have not expired
  * git submodules under runtime/deps/ exactly match runtime/deps/submodules.lock
  * the runtime's package.json declares zero runtime dependencies
  * harvested (tier 2) files carry provenance headers
  * runtime/THIRD_PARTY_NOTICES.md matches what the manifest generates

Modes:
  deps-check.py               run all checks (CI entry point; `make check-deps`)
  deps-check.py --snapshot    rewrite runtime/deps/submodules.lock from the tree
  deps-check.py --notices     rewrite runtime/THIRD_PARTY_NOTICES.md

Stdlib only. Requires Python >= 3.11 (tomllib).
"""

import argparse
import datetime
import subprocess
import sys
from pathlib import Path

if sys.version_info < (3, 11):
    sys.exit("deps-check: Python >= 3.11 required (tomllib)")

import tomllib

REPO = Path(__file__).resolve().parent.parent
MANIFEST = REPO / "runtime" / "deps" / "MANIFEST.toml"
LOCK = REPO / "runtime" / "deps" / "submodules.lock"
NOTICES = REPO / "runtime" / "THIRD_PARTY_NOTICES.md"
RUNTIME_PKG = REPO / "runtime" / "package.json"

LICENSE_ALLOWLIST = {
    "MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC",
    "Zlib", "0BSD", "Unlicense", "blessing",
}
INTAKES = {
    "submodule", "transitive-submodule", "in-tree", "in-tree-via-txiki",
    "harvest", "toolchain",
}
TIERS = {0, 1, 2, "D"}

errors = []
notes = []


def err(msg):
    errors.append(msg)


def load_manifest():
    with open(MANIFEST, "rb") as f:
        data = tomllib.load(f)
    if data.get("schema") != 1:
        err(f"manifest schema must be 1, got {data.get('schema')!r}")
    return data.get("dependency", [])


def check_entries(deps):
    seen = set()
    for d in deps:
        name = d.get("name")
        if not name:
            err("manifest entry with no name")
            continue
        if name in seen:
            err(f"{name}: duplicate manifest entry")
        seen.add(name)

        denied = d.get("denied", False)
        tier = d.get("tier")
        if denied:
            if tier is not None:
                err(f"{name}: denied entries must not carry a tier")
            if not d.get("notes"):
                err(f"{name}: tombstone requires rationale in notes")
            continue

        if tier not in TIERS:
            err(f"{name}: tier must be one of {sorted(map(str, TIERS))}, got {tier!r}")
        if d.get("intake") not in INTAKES:
            err(f"{name}: intake must be one of {sorted(INTAKES)}, got {d.get('intake')!r}")
        spdx = d.get("spdx")
        if not spdx:
            err(f"{name}: missing spdx license id")
        elif spdx not in LICENSE_ALLOWLIST and d.get("intake") != "toolchain":
            err(f"{name}: license {spdx!r} not on the allowlist "
                f"(toolchain-only exemption does not apply)")
        if tier == 1 and not d.get("breaks_if_removed"):
            err(f"{name}: tier 1 entries require breaks_if_removed")
        if tier == 2 and not d.get("harvest_paths"):
            err(f"{name}: tier 2 entries require harvest_paths")

        for w in d.get("waiver", []):
            review_by = w.get("review_by")
            if not isinstance(review_by, datetime.date):
                err(f"{name}: waiver missing/invalid review_by date")
            elif review_by < datetime.date.today():
                err(f"{name}: waiver expired on {review_by} — renew it or bring the "
                    f"dependency into compliance ({w.get('rule', 'unnamed rule')})")
            if not w.get("reason") or not w.get("approved_by"):
                err(f"{name}: waiver requires reason and approved_by")
    return seen


def runtime_submodule_lines():
    """Gitlinks under runtime/deps/ as recorded in the index.

    Deliberately NOT recursive: a submodule commit SHA immutably pins all of its
    own submodules, so top-level gitlinks are sufficient for pin integrity, and
    the lock stays identical whether or not submodules are initialized.
    """
    out = subprocess.run(
        ["git", "ls-files", "-s", "runtime/deps/"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout
    lines = []
    for line in out.splitlines():
        mode, sha, _stage, path = line.split(None, 3)
        if mode == "160000":
            lines.append(f"{sha} {path}")
    return sorted(lines)


def check_submodules():
    live = runtime_submodule_lines()
    if not LOCK.exists():
        if live:
            err("runtime submodules exist but runtime/deps/submodules.lock is "
                "missing — run scripts/deps-check.py --snapshot and commit it")
        else:
            notes.append("no runtime submodules yet; lock file not required")
        return
    locked = sorted(l for l in LOCK.read_text().splitlines()
                    if l.strip() and not l.startswith("#"))
    if live != locked:
        err("submodule state does not match runtime/deps/submodules.lock — a "
            "dependency arrived or moved without a manifest/lock update.\n"
            "  live:   " + ("\n          ".join(live) or "(none)") + "\n"
            "  locked: " + ("\n          ".join(locked) or "(none)"))


def check_runtime_pkg():
    if not RUNTIME_PKG.exists():
        return
    import json
    pkg = json.loads(RUNTIME_PKG.read_text())
    if pkg.get("dependencies"):
        err('runtime/package.json declares runtime dependencies — the policy is '
            '"dependencies": {} permanently (see runtime/DEPENDENCIES.md §JS-layer)')


def check_provenance(deps):
    for d in deps:
        if d.get("denied") or d.get("tier") != 2:
            continue
        for glob in d.get("harvest_paths", []):
            matched = False
            for f in REPO.glob(glob):
                if not f.is_file():
                    continue
                matched = True
                head = f.read_text(errors="replace")[:2048]
                if "Provenance:" not in head:
                    err(f"{f.relative_to(REPO)}: harvested file missing "
                        f"'Provenance:' header (dep {d['name']})")
            if not matched:
                err(f"{d['name']}: harvest_paths glob {glob!r} matched no files")


def render_notices(deps):
    lines = [
        "# Third-party notices",
        "",
        "Generated from [`deps/MANIFEST.toml`](deps/MANIFEST.toml) by "
        "`scripts/deps-check.py --notices`. Do not edit by hand.",
        "",
        "The Tessel 2 runtime statically links or incorporates the following "
        "third-party components:",
        "",
        "| Component | License | Upstream |",
        "|---|---|---|",
    ]
    for d in sorted(deps, key=lambda d: d.get("name", "")):
        if d.get("denied") or d.get("intake") == "toolchain":
            continue
        lines.append(f"| {d['name']} | {d.get('spdx', '?')} | "
                     f"{d.get('upstream', '?')} |")
    lines.append("")
    return "\n".join(lines)


def check_notices(deps):
    expected = render_notices(deps)
    if not NOTICES.exists():
        err("runtime/THIRD_PARTY_NOTICES.md missing — run "
            "scripts/deps-check.py --notices and commit it")
        return
    if NOTICES.read_text() != expected:
        err("runtime/THIRD_PARTY_NOTICES.md is stale — run "
            "scripts/deps-check.py --notices and commit the result")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot", action="store_true",
                    help="rewrite runtime/deps/submodules.lock from the tree")
    ap.add_argument("--notices", action="store_true",
                    help="rewrite runtime/THIRD_PARTY_NOTICES.md from the manifest")
    args = ap.parse_args()

    deps = load_manifest()

    if args.snapshot:
        LOCK.write_text(
            "# git submodule pins under runtime/deps/ — written by "
            "scripts/deps-check.py --snapshot\n"
            + "".join(l + "\n" for l in runtime_submodule_lines()))
        print(f"wrote {LOCK.relative_to(REPO)}")
        return 0
    if args.notices:
        NOTICES.write_text(render_notices(deps))
        print(f"wrote {NOTICES.relative_to(REPO)}")
        return 0

    check_entries(deps)
    check_submodules()
    check_runtime_pkg()
    check_provenance(deps)
    check_notices(deps)

    for n in notes:
        print(f"note: {n}")
    if errors:
        print(f"\ndeps-check: {len(errors)} problem(s):\n", file=sys.stderr)
        for e in errors:
            print(f"  * {e}", file=sys.stderr)
        return 1
    print(f"deps-check: OK ({len(deps)} manifest entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
