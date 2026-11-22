# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""The engine in the mode "generate", launched as the core launches it, against a built engine (the full Firefox).

    python run_stealth_generate_launch_gate.py <firefox binary> [--crlite-data DIR] [--timeout SECONDS]

The xpcshell test (run_stealth_security_state_gate.py) runs the module in the engine's shell; this one runs the whole
engine, `firefox -headless -no-remote -profile <work profile>` and nothing else on the command line (the engine is a full
Firefox: no -app), with a profile whose user.js has zoom.stealth.securitystate.generate and the prefs of the three
files, and asks what only a launch can say. application.ini is the one next to the binary. The environment is the core's:
XDG_CONFIG_HOME, XDG_CACHE_HOME, APPDATA, LOCALAPPDATA, HOME and TMPDIR/TMP/TEMP are folders of this test,
MOZ_CRASHREPORTER_DISABLE is 1, there is no DISPLAY and no WAYLAND_DISPLAY, and the engine's output goes nowhere (it must
print nothing; this test does not read it).

  exit       the process ends by itself with status 0 (it quits itself: nothing here ends it but a time-out, which fails;
             the tree is then killed), and with status 1 when a file is wrong, with the result file saying ok false and which
             collection in "error" (the missing file, the missing delta, the wrong format), and with status 1 and no file when
             the result cannot be written (a folder where the file goes).
  result     <profile>/securitystate-result.json: the version and the BuildID of the engine that made the files are the ones
             of application.ini; the count and the timestamps (collection_timestamp, updated_utc) of each collection are the
             ones of its file, and the channel is the manifest's; the hashes are the sha256 of the filters, the full one first
             and then the deltas, and as a set.
  files      <profile>/security_state/ has the database, the filter and the delta, which are the bytes of the files it was given.
  same       a second generation from the same files makes the same filter and delta (sha256).
  rule       whatever the way the engine ends, it exits with 0 ONLY when it has written a result with ok true. The heavy launch
             always runs: the list of intermediates of the size of the real one and the manifest with as many deltas as the real
             one (66), so that the generation cannot end before a quit that came too early (a full Firefox that has no window
             does not spin its event loop and quits at once with status 0 unless the module holds it): the window must not open
             and the quit must come after the end, with status 0, a result with ok true and all the filters. A quit that others
             force in the middle is not ours to answer (the first quit wins, and the status is that quit's): the outcome there is
             the result file, which says ok false ("generation did not finish") until the end; the xpcshell test checks that
             (marker), and this test does not claim a status for it.
  silent     no connection reaches the proxy the engine was told to use for everything (localhost's too): a request of any kind
             would go there; no new FILE appears outside the profile (in the folders this test redirected, in the engine's own
             folder, and in the folder the process runs in); the only things allowed to appear are the empty folders that the
             profile service and the crash reporter's and telemetry's directories make at every launch of Firefox with any
             profile (ALLOWED_EMPTY_FOLDERS), and, on Linux, the cache that fontconfig writes in XDG_CACHE_HOME (ALLOWED_FILES).

The times in the files are fixed; nothing here sleeps. The data are made by run_stealth_security_state_gate.py (Mozilla's CRLite
test data from crlite_test_data.json, certificates made on the run). Exit status: 0 when everything passed, 1 when something
failed. It works on Linux and Windows (firefox.exe; the tree is killed on a time-out).
"""

import argparse
import configparser
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run_stealth_security_state_gate as gate  # noqa: E402

DEFAULT_TIMEOUT_S = 120
# The redirected folders the core points the engine at, by the variable that names them.
FOLDERS = ("home", "config", "cache", "appdata", "localappdata", "tmp")
# The empty folders that Firefox makes at every launch with any profile, per redirected folder (relative paths, with "/"). They are
# the ones a launch of the full Firefox made in a first run in the redirected folders (Linux, measured on firefox-67 with the module
# and the hook of this series): the profile service (nsToolkitProfileService, nsXREDirProvider::GetUserDataDirectory) makes
# <config>/mozilla/firefox and <cache>/mozilla/firefox, the crash reporter's and the telemetry's directories (Crash Reports, its
# events folder, Pending Pings) are made under the first even with the crash reporter off, and the default download folder is
# made in HOME. None holds a file: any file that appears is a failure (below).
# Windows (APPDATA, LOCALAPPDATA): the analogous folders, Mozilla/Firefox and the same three; not measured: Firefox on Windows asks
# the system for its known folders, so the redirected ones may stay untouched.
ALLOWED_EMPTY_FOLDERS = {
    "linux": {
        "home": {"Downloads"},
        "config": {"mozilla", "mozilla/firefox", "mozilla/firefox/Crash Reports", "mozilla/firefox/Crash Reports/events",
                   "mozilla/firefox/Pending Pings"},
        "cache": {"mozilla", "mozilla/firefox", "fontconfig"},
    },
    "windows": {
        "appdata": {"Mozilla", "Mozilla/Firefox", "Mozilla/Firefox/Crash Reports", "Mozilla/Firefox/Crash Reports/events",
                    "Mozilla/Firefox/Pending Pings"},
        "localappdata": {"Mozilla", "Mozilla/Firefox"},
    },
}
# The only files allowed outside the profile: the cache that fontconfig (the library, not Firefox) writes in its own folder of
# XDG_CACHE_HOME when the engine shows it the font bundle (the `wrapper.e2e.fontconfig` suite is about that): CACHEDIR.TAG and the
# cache files named <hash>-le64.cache-<n>. Linux only. Anything else is a failure.
ALLOWED_FILES = {
    "linux": re.compile(r"^cache:fontconfig/(CACHEDIR\.TAG|[0-9a-f]+-[a-z0-9]+\.cache-\d+)$"),
    "windows": re.compile(r"(?!)"),
}


class Heard:
    """A listener that counts the connections made to it, and keeps the first bytes of each (what the engine asked for)."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        self.connections = 0
        self.samples = []
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.connections += 1
            threading.Thread(target=self._sample, args=(conn,), daemon=True).start()

    def _sample(self, conn):
        try:
            conn.settimeout(0.5)
            data = conn.recv(200)
        except OSError:
            data = b""
        finally:
            conn.close()
        if len(self.samples) < 10:
            self.samples.append(data.split(bytes([13, 10]))[0].decode("latin-1")[:120])

    def close(self):
        self.sock.close()


def listing(root):
    """-> (files, folders): relative path -> mtime for the files, the set of the folders (relative paths, with "/")."""
    found, folders = {}, set()
    for base, dirs, names in os.walk(root):
        for d in dirs:
            folders.add(os.path.relpath(os.path.join(base, d), root).replace(os.sep, "/"))
        for name in names:
            path = os.path.join(base, name)
            try:
                found[os.path.relpath(path, root).replace(os.sep, "/")] = os.stat(path).st_mtime_ns
            except OSError:
                pass
    return found, folders


def sha(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def environment(redirected):
    """The core's environment for the launch: the redirected folders, no display, the crash reporter off."""
    env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
    env.update(
        HOME=redirected["home"],
        XDG_CONFIG_HOME=redirected["config"],
        XDG_CACHE_HOME=redirected["cache"],
        APPDATA=redirected["appdata"],
        LOCALAPPDATA=redirected["localappdata"],
        TMPDIR=redirected["tmp"],
        TMP=redirected["tmp"],
        TEMP=redirected["tmp"],
        MOZ_CRASHREPORTER_DISABLE="1",
    )
    return env


def launch(binary, work, label, files, timeout, block_result=False):
    """One launch of the engine; -> what it did (exit status, result file, connections heard, what it wrote outside the profile)."""
    profile = os.path.join(work, "profile-" + label)
    redirected = {name: os.path.join(work, name + "-" + label) for name in FOLDERS}
    cwd = os.path.join(work, "cwd-" + label)
    for d in [profile, cwd] + list(redirected.values()):
        os.makedirs(d)
    if block_result:
        # a folder where the result goes: the generation works, the result cannot be written
        os.makedirs(os.path.join(profile, "securitystate-result.json"))
    heard = Heard()
    prefs = {
        "zoom.stealth.securitystate.generate": True,
        "zoom.stealth.intermediates.file": files["intermediates"],
        "zoom.stealth.onecrl.file": files["onecrl"],
        "zoom.stealth.crlite.file": files["crlite"],
        "network.proxy.type": 1,
        "network.proxy.http": "127.0.0.1",
        "network.proxy.http_port": heard.port,
        "network.proxy.ssl": "127.0.0.1",
        "network.proxy.ssl_port": heard.port,
        "network.proxy.socks": "127.0.0.1",
        "network.proxy.socks_port": heard.port,
        "network.proxy.no_proxies_on": "",
        "network.proxy.allow_hijacking_localhost": True,
    }
    with open(os.path.join(profile, "user.js"), "w", encoding="utf-8") as fh:
        for k, v in prefs.items():
            fh.write("user_pref(%s, %s);\n" % (json.dumps(k), json.dumps(v)))
    engine_dir = os.path.dirname(binary)
    watched = {"engine": engine_dir, "cwd": cwd}
    watched.update(redirected)
    before = {name: listing(path) for name, path in watched.items()}
    proc = subprocess.Popen(
        [binary, "-headless", "-no-remote", "-profile", profile],
        env=environment(redirected),
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=(os.name != "nt"),
    )
    try:
        rc = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        rc = None
    finally:
        # the tree, whatever happened: nothing the engine started outlives the launch
        gate.kill_tree(proc)
        proc.wait()
    heard.close()
    after = {name: listing(path) for name, path in watched.items()}
    result_path = os.path.join(profile, "securitystate-result.json")
    result = None
    if os.path.isfile(result_path):
        with open(result_path, encoding="utf-8") as fh:
            result = json.load(fh)
    new_files, new_folders, changed = [], [], []
    for name in watched:
        (b_files, b_folders), (a_files, a_folders) = before[name], after[name]
        if name == "engine":
            changed = sorted(set(a_files) ^ set(b_files) | {k for k in a_files if k in b_files and a_files[k] != b_files[k]})
        else:
            new_files += [name + ":" + k for k in sorted(set(a_files) - set(b_files))]
            new_folders += [(name, k) for k in sorted(a_folders - b_folders)]
    return {
        "rc": rc,
        "profile": profile,
        "result": result,
        "heard": heard.connections,
        "heard_samples": heard.samples,
        "engine_changed": changed,
        "files_outside": new_files,
        "folders_outside": new_folders,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("firefox", help="the engine's firefox binary (firefox.exe on Windows); application.ini is next to it")
    ap.add_argument("--crlite-data", help="a folder with Mozilla's test_crlite_filters files, instead of crlite_test_data.json")
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_S, help="seconds a launch may take before it is killed and fails")
    args = ap.parse_args()
    binary = os.path.abspath(args.firefox)
    timeout = args.timeout
    system = "windows" if os.name == "nt" else "linux"
    allowed_empty = ALLOWED_EMPTY_FOLDERS[system]
    problems = []

    def check(condition, message):
        if not condition:
            problems.append(message)

    ini = configparser.ConfigParser()
    ini.read(os.path.join(os.path.dirname(binary), "application.ini"))
    if not ini.has_option("App", "BuildID"):
        sys.exit("no application.ini with App/BuildID next to " + binary)

    work = tempfile.mkdtemp(prefix="stealth-generate-launch-")
    try:
        fixture_file = gate.make_fixture(work, 1800, gate.crlite_data_dir(args.crlite_data, work))
        with open(fixture_file, encoding="utf-8") as fh:
            fixture = json.load(fh)
        files = {"intermediates": fixture["files"]["intermediates"], "onecrl": fixture["files"]["onecrl"],
                 "crlite": fixture["files"]["crlite"]["delta"]}
        source_dir = os.path.dirname(files["crlite"])
        meta = fixture["meta"]
        full_hash, delta_hash = fixture["hashes"]["full"], fixture["hashes"]["delta"]

        a = launch(binary, work, "a", files, timeout)
        print("a: exit %s, heard %s, engine files changed %s, files outside %s, folders outside %s"
              % (a["rc"], a["heard"], a["engine_changed"][:3], a["files_outside"][:5], a["folders_outside"][:8]))
        check(a["rc"] == 0, "exit status %s (None: it had not ended after %d s)" % (a["rc"], timeout))
        r = a["result"]
        check(bool(r) and r["ok"] is True and r["error"] is None, "the result is not ok: %s" % r)
        if r:
            check(r["engine"]["version"] == ini["App"]["Version"] and r["engine"]["build_id"] == ini["App"]["BuildID"],
                  "the result names the engine %s, the engine is %s %s" % (r["engine"], ini["App"]["Version"], ini["App"]["BuildID"]))
            check(sorted(r) == ["collections", "crlite_filter_hashes", "engine", "error", "format", "ok"],
                  "the keys of the result are %s" % sorted(r))
            c = r["collections"]
            check(sorted(c) == ["cert-revocations", "intermediates", "onecrl"], "the collections are %s" % sorted(c))
            check([c["intermediates"]["count"], c["intermediates"]["collection_timestamp"]]
                  == [meta["intermediates_count"], meta["intermediates_timestamp"]], "intermediates: %s" % c["intermediates"])
            check([c["onecrl"]["count"], c["onecrl"]["collection_timestamp"], c["onecrl"]["updated_utc"]]
                  == [meta["onecrl_count"], meta["onecrl_timestamp"], meta["updated_utc"]], "onecrl: %s" % c["onecrl"])
            check([c["cert-revocations"]["count"], c["cert-revocations"]["collection_timestamp"], c["cert-revocations"]["updated_utc"], c["cert-revocations"]["channel"]]
                  == [2, meta["crlite_timestamp"], meta["updated_utc"], "default"], "cert-revocations: %s" % c["cert-revocations"])
            check(r["crlite_filter_hashes"] == [full_hash, delta_hash], "the hashes are %s" % r["crlite_filter_hashes"])
            check(set(r["crlite_filter_hashes"]) == {full_hash, delta_hash}, "the set of the hashes is %s" % sorted(set(r["crlite_filter_hashes"])))
            check(r["format"] == 1 and sorted(r["engine"]) == ["build_id", "version"], "format or engine keys: %s" % {k: r[k] for k in ("format", "engine")})
        state = os.path.join(a["profile"], "security_state")
        names = sorted(os.listdir(state)) if os.path.isdir(state) else []
        check(names == sorted(["data.safe.bin", "crlite.filter", gate.DELTA_FILTER]), "security_state/ has %s" % names)
        for name, key in (("crlite.filter", "full"), (gate.DELTA_FILTER, "delta")):
            path = os.path.join(state, name)
            check(os.path.exists(path) and sha(path) == fixture["hashes"][key], "%s is not the bytes it was given" % name)
        check(a["heard"] == 0, "the proxy heard %d connection(s), the first ones asked for %s" % (a["heard"], a["heard_samples"]))
        check(not a["engine_changed"], "the engine's folder changed: %s" % a["engine_changed"][:5])
        stray_files = [f for f in a["files_outside"] if not ALLOWED_FILES[system].match(f)]
        check(not stray_files, "files written outside the profile: %s" % stray_files)
        stray = [(n, f) for n, f in a["folders_outside"] if f not in allowed_empty.get(n, ())]
        check(not stray, "folders other than the profile service's empty ones outside the profile: %s" % stray)

        b = launch(binary, work, "b", files, timeout)
        check(b["rc"] == 0, "b: exit status %s" % b["rc"])
        for name in ("crlite.filter", gate.DELTA_FILTER):
            pa, pb = os.path.join(a["profile"], "security_state", name), os.path.join(b["profile"], "security_state", name)
            check(os.path.exists(pa) and os.path.exists(pb) and sha(pa) == sha(pb), "two generations from the same files: %s differs" % name)

        for label, over, word in (
            ("missing-file", {"onecrl": fixture["files"]["missing"]}, "onecrl"),
            ("missing-delta", {"crlite": fixture["files"]["crlite"]["missing_delta"]}, "cert-revocations"),
            ("wrong-format", {"intermediates": fixture["files"]["bad_format"]}, "intermediates"),
        ):
            bad = launch(binary, work, label, {**files, **over}, timeout)
            print("%s: exit %s" % (label, bad["rc"]))
            check(bad["rc"] == 1, "%s: exit status %s" % (label, bad["rc"]))
            check(bool(bad["result"]) and bad["result"]["ok"] is False and (bad["result"]["error"] or "").startswith(word + ": "),
                  "%s: the result says %s" % (label, bad["result"] and bad["result"]["error"]))

        def rule(label, run):
            check(run["rc"] != 0 or (bool(run["result"]) and run["result"]["ok"] is True),
                  "%s: exit status 0 and no result with ok true: %s" % (label, run["result"]))

        rule("a", a)
        rule("b", b)
        # Enough work that the generation cannot end before an early quit could happen: the list of intermediates of the size
        # of the real one, and the manifest with as many deltas as the real one (66: each is a file, a write and a new time in
        # the database). The deltas are copies of Mozilla's one, under other names.
        heavy = os.path.join(work, "heavy")
        os.makedirs(heavy)
        names = ["%02d-%s" % (n, gate.DELTA_FILTER) for n in range(66)]
        shutil.copy(os.path.join(source_dir, gate.FULL_FILTER), heavy)
        for name in names:
            shutil.copy(os.path.join(source_dir, gate.DELTA_FILTER), os.path.join(heavy, name))
        heavy_manifest = {"format": 1, "collection": "cert-revocations", "channel": "default", "collection_timestamp": 1,
                          "updated_utc": gate.UPDATED_UTC, "full": gate.file_entry(heavy, gate.FULL_FILTER),
                          "deltas": [gate.file_entry(heavy, name) for name in names]}
        gate.write_json(os.path.join(heavy, "crlite.json"), heavy_manifest)
        heavy_run = launch(binary, work, "heavy", {**files, "crlite": os.path.join(heavy, "crlite.json")}, timeout)
        print("heavy (66 deltas): exit %s, result ok %s" % (heavy_run["rc"], heavy_run["result"] and heavy_run["result"]["ok"]))
        rule("heavy", heavy_run)
        check(heavy_run["rc"] == 0 and bool(heavy_run["result"]) and heavy_run["result"]["ok"] is True
              and heavy_run["result"]["crlite_filter_hashes"] == [full_hash] + [delta_hash] * 66,
              "heavy: the generation did not get to the end: exit %s, result %s" % (heavy_run["rc"], heavy_run["result"]))
        state_heavy = os.path.join(heavy_run["profile"], "security_state")
        check(os.path.isdir(state_heavy) and sorted(os.listdir(state_heavy)) == sorted(["data.safe.bin", "crlite.filter"] + names),
              "heavy: security_state/ has %s" % (sorted(os.listdir(state_heavy)) if os.path.isdir(state_heavy) else None))

        blocked = launch(binary, work, "blocked", files, timeout, block_result=True)
        print("blocked-result: exit %s" % blocked["rc"])
        check(blocked["rc"] == 1 and blocked["result"] is None, "blocked result: exit %s, result %s" % (blocked["rc"], blocked["result"]))
    finally:
        shutil.rmtree(work, ignore_errors=True)
    for p in problems:
        print("FAIL", p)
    print("PASS the engine in generate mode makes security_state/ and exits" if not problems else "FAIL: %d" % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
