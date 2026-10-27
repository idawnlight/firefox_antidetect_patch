#!/usr/bin/env python3
"""scripts/ci against the cases it exists for.

  legs
    1. the asset names are the ones the release has always published
       (firefox-157.0.1-stealth-<os>-<arch>.<ext>), derived, not written;
    2. the matrix carries every field release.yml reads;
  mozconfig
    3. the flags decided on 2026-10-27, leg by leg, in order: a flag that
       changes is a decision and changes this test;
    4. the repository's sccache lines go, case-insensitive (SCCACHE_CACHE_SIZE
       too), its comments stay;
    5. compile_cache=gha without the pinned sccache's path is refused;
    6. every layer writes its reason into the file;
  phase
    7. a failing command fails the phase with its exit code, and the summary
       carries its first error lines and the memory watch's kill;
    8. a passing one records its time;
  report
    9. one row per phase; a leg that never started and a phase that never
       ended (cancelled, runner lost) are rows, not gaps.

    python3 scripts/ci/test_ci.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import legs  # noqa: E402
import mozconfig  # noqa: E402
import phase  # noqa: E402
import report  # noqa: E402

BASE = """# the development machines' file
ac_add_options --enable-release
ac_add_options --with-ccache=sccache
mk_add_options 'export RUSTC_WRAPPER=sccache'
mk_add_options 'export SCCACHE_CACHE_SIZE=50G'
# sccache is in PATH on both machines
ac_add_options --disable-debug-symbols
"""


def fake_pgo(leg, out):
    lto = {"win-x86_64": "full,cross", "linux-x86_64": "full,cross", "linux-arm64": "cross"}[leg]
    return ["ac_add_options --enable-profile-use=cross",
            "ac_add_options --with-pgo-profile-path=%s/merged.profdata" % out,
            "ac_add_options --with-pgo-jarlog=%s/en-US.log" % out,
            "ac_add_options --enable-lto=%s" % lto]


def expected(leg, cache):
    lines = ["ac_add_options --enable-release", "ac_add_options --disable-debug-symbols"]
    if cache == "gha":
        lines += ["ac_add_options --with-ccache=/s/sccache", "mk_add_options 'export RUSTC_WRAPPER=/s/sccache'"]
    lines += ["ac_add_options --enable-debug-symbols=-gline-tables-only",
              "mk_add_options 'export RUSTFLAGS=-Cdebuginfo=line-tables-only'"]
    lines += fake_pgo(leg, "pgo")
    lines += ["export CFLAGS=-Wno-backend-plugin", "export CXXFLAGS=-Wno-backend-plugin"]
    lines += {"linux-x86_64": ["ac_add_options --host=x86_64-unknown-linux-gnu"],
              "linux-arm64": [],
              "win-x86_64": ["ac_add_options --target=x86_64-pc-windows-msvc",
                             "ac_add_options --host=x86_64-unknown-linux-gnu",
                             "ac_add_options --with-redist"]}[leg]
    lines += ["mk_add_options MOZ_PARALLEL_BUILD=4", "mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-rel"]
    return lines


def compose(leg, cache, sccache="/s/sccache"):
    plan = mozconfig.Plan(cache, sccache, Path("pgo"), fake_pgo)
    return mozconfig.compose(BASE, legs.by_name(leg), plan)


def with_env(tmp, **env):
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    return old


def restore(old):
    for k, v in old.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def phase_case(tmp: Path, argv, memwatch=""):
    (tmp / "memwatch.log").write_text(memwatch, encoding="utf-8")
    phase.EVENTS = tmp / "events.jsonl"
    phase.LOGS = tmp / "logs"
    old = with_env(tmp, GITHUB_STEP_SUMMARY=str(tmp / "summary.md"), CI_LEG="win-x86_64",
                   CI_MEMWATCH=str(tmp / "memwatch.log"))
    try:
        code = phase.run("build", argv)
    finally:
        restore(old)
    events = [json.loads(l) for l in (tmp / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    return code, events, (tmp / "summary.md").read_text(encoding="utf-8")


def main() -> int:
    cases = []
    names = {l.leg: l.asset("157.0.1") for l in legs.LEGS}
    cases.append(("asset names as the release has always published them", names == {
        "linux-x86_64": "firefox-157.0.1-stealth-linux-x86_64.tar.gz",
        "linux-arm64": "firefox-157.0.1-stealth-linux-arm64.tar.gz",
        "win-x86_64": "firefox-157.0.1-stealth-win-x86_64.zip"}))
    inc = json.loads(legs.matrix("157.0.1"))["include"]
    need = {"leg", "runner", "family", "host", "target", "rust_target", "extra_pkgs", "asset"}
    cases.append(("the matrix carries every field release.yml reads",
                  len(inc) == 3 and all(need <= set(e) for e in inc)))

    for leg in ("linux-x86_64", "linux-arm64", "win-x86_64"):
        for cache in ("gha", "off"):
            got = mozconfig.active(compose(leg, cache))
            cases.append(("the decided flags, %s, compile_cache=%s" % (leg, cache), got == expected(leg, cache)))
    text = compose("linux-x86_64", "off")
    cases.append(("sccache lines go case-insensitive, comments stay",
                  "SCCACHE_CACHE_SIZE" not in text and "# sccache is in PATH on both machines" in text))

    def gha_without_path():
        try:
            compose("linux-x86_64", "gha", sccache="")
        except ValueError:
            return True
        return False
    cases.append(("compile_cache=gha without the sccache path is refused", gha_without_path()))
    cases.append(("every layer writes its reason",
                  all(("# [%s] " % f.__name__) in text for f in mozconfig.LAYERS)))

    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        code, events, summ = phase_case(tmp, [sys.executable, "-c",
            "print('compiling'); print('warning: unused'); print('121:36.08 E clang++: error: linker command failed'); raise SystemExit(3)"],
            memwatch="14:10:15 [mem] KILLED pid 1 (14086 MB) to keep the runner alive: ld.lld\n")
        cases.append(("a failing command fails the phase with its exit code", code == 3 and events[-1]["exit"] == 3))
        cases.append(("the summary names the first error and the kill, not the warning",
                      "E clang++: error: linker command failed" in summ and "KILLED" in summ and "unused" not in summ))
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        code, events, summ = phase_case(tmp, [sys.executable, "-c", "print('ok')"])
        cases.append(("a passing command records its time",
                      code == 0 and events[0]["event"] == "start" and events[-1]["exit"] == 0 and "✅" in summ))

    with tempfile.TemporaryDirectory() as t:
        root = Path(t)
        ok = root / "events-linux-x86_64"
        ok.mkdir()
        (ok / "events.jsonl").write_text("\n".join(json.dumps(e) for e in [
            {"phase": "build", "event": "start"}, {"phase": "build", "event": "end", "exit": 0, "seconds": 5400},
            {"phase": "package", "event": "start"}]) + "\n", encoding="utf-8")
        (ok / "memwatch.log").write_text("[mem] available 1000/16000 MB, swap used 4000/24000 MB, disk free 40 GB\n", encoding="utf-8")
        (ok / "sccache-stats.txt").write_text("Cache hits rate                 87.50 %\n", encoding="utf-8")
        bad = root / "events-win-x86_64"
        bad.mkdir()
        (bad / "events.jsonl").write_text(json.dumps({"phase": "build", "event": "start"}) + "\n" + json.dumps(
            {"phase": "build", "event": "end", "exit": 2, "seconds": 60, "killed": ["[mem] KILLED pid 9 ld.lld"]}) + "\n", encoding="utf-8")
        got = report.rows(root)
        table = {(r[0], r[1]): r for r in got}
        cases.append(("a passing phase: time, memory peak, cache hits",
                      table[("linux-x86_64", "build")][2:] == ("✅", "1h30m", "18.6 GB", "87.50 %")))
        cases.append(("a phase that never ended is a row",
                      table[("linux-x86_64", "package")][2].startswith("⏹️")))
        cases.append(("a failed phase names why", "KILLED" in table[("win-x86_64", "build")][2]))
        cases.append(("a leg that never started is a row", table[("linux-arm64", "-")][2] == "⚪ never started"))

    import re
    literal = re.compile(r"firefox-\d+(\.\d+)*-stealth-")
    wf = HERE.parent.parent / ".github" / "workflows"
    written = sorted("%s:%d" % (p.name, i + 1) for p in wf.glob("*.yml")
                     for i, l in enumerate(p.read_text(encoding="utf-8").splitlines()) if literal.search(l))
    cases.append(("no workflow writes a versioned asset name (%s)" % (", ".join(written) or "none"), not written))

    import payload_guard as pg

    def guard(view, download=(0, "", ""), published=b"SEAL", ours=b"SEAL"):
        with tempfile.TemporaryDirectory() as t:
            seal = Path(t) / "seal.json"
            seal.write_bytes(ours)

            def gh(args):
                if args[:2] == ["release", "view"]:
                    return view
                if download[0] == 0:
                    out = Path(args[args.index("--dir") + 1])
                    (out / "seal.json").write_bytes(published)
                return download
            try:
                return pg.check("firefox-60", "o/r", seal, gh)
            except pg.GuardError as exc:
                return "REFUSED " + str(exc)
    with_seal = (0, json.dumps({"assets": [{"name": "seal.json"}]}), "")
    cases.append(("payload guard: no release yet proceeds",
                  "first publish" in guard((1, "", "release not found"))))
    cases.append(("payload guard: a network error is refused, not read as 'no seal yet'",
                  guard((1, "", "HTTP 502: Bad Gateway")).startswith("REFUSED")))
    cases.append(("payload guard: a release without a seal proceeds",
                  "first seal" in guard((0, json.dumps({"assets": [{"name": "x.zip"}]}), ""))))
    cases.append(("payload guard: an identical seal proceeds", "identical" in guard(with_seal)))
    cases.append(("payload guard: a different seal is refused",
                  "DIFFERENT" in guard(with_seal, published=b"OTHER")))
    cases.append(("payload guard: a seal that cannot be downloaded is refused",
                  guard(with_seal, download=(1, "", "HTTP 500")).startswith("REFUSED")))

    failures = 0
    for name, ok in cases:
        print(("ok    " if ok else "FAIL  ") + name)
        failures += not ok
    print("%d/%d cases as expected" % (len(cases) - failures, len(cases)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
