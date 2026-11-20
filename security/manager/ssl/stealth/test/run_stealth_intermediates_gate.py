# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""The test of the intermediates the core declares, against a built engine.

    python run_stealth_intermediates_gate.py <firefox binary> [--module-dir DIR]
                                             [--cases with,without,poller,category,settles]

Each case is one `firefox -xpcshell stealth_intermediates_case.js` process with
its own empty profile (stealth_intermediates_case.js says what each case asks).
The package of the engine carries the xpcshell shell but not the xpcshell
harness, which is why the profile, the certificates and the fake server are made
here. The certificates are made on every run (a root, an intermediate and a
leaf, with the `cryptography` library): nothing of them is a file of the repo.

The list the core declares is a file in the format the core writes, with the
intermediate of the run as its only certificate; the leaf verifies only if that
intermediate is in cert_storage when the verification looks for it.

Exit status: 0 when every case passed, 1 when one failed, 2 when one did not run.
--module-dir is for a binary that does not carry StealthIntermediates.sys.mjs
(the retail Firefox the test is first shown red against): the module is loaded
from that directory instead, and only the cases that need the module change.
"""

import argparse
import base64
import datetime
import hashlib
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
CASE_SCRIPT = os.path.join(HERE, "stealth_intermediates_case.js")
ALL_CASES = ["with", "without", "poller", "category", "settles"]
HOSTNAME = "intermediates.example.test"
TIMEOUT_S = 180
# The timestamps the fake feed gives the two collections: far from anything a
# profile holds, so a client that sees them has to sync. Only the poller sends
# one of them as `_expected`, which is how its request tells from a read of the
# local database.
INTERMEDIATES_TS = 1900000000001
ONECRL_TS = 1900000000002


def b64(raw):
    return base64.b64encode(raw).decode("ascii")


def make_fixture(workdir, filler):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    now = datetime.datetime.now(datetime.timezone.utc)

    def name(cn):
        return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])

    def build(subject, issuer, key, issuer_key, ca, path_length=None, san=None):
        builder = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=30))
            .add_extension(
                x509.BasicConstraints(ca=ca, path_length=path_length), critical=True
            )
        )
        if ca:
            builder = builder.add_extension(
                x509.KeyUsage(
                    digital_signature=True,
                    content_commitment=False,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=True,
                    crl_sign=True,
                    encipher_only=False,
                    decipher_only=False,
                ),
                critical=True,
            )
        else:
            builder = builder.add_extension(
                x509.SubjectAlternativeName([x509.DNSName(san)]), critical=False
            ).add_extension(
                x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False
            )
        return builder.sign(issuer_key, hashes.SHA256())

    root_key, mid_key, leaf_key = (ec.generate_private_key(ec.SECP256R1()) for _ in range(3))
    root = build(name("Stealth Test Root"), name("Stealth Test Root"), root_key, root_key, True)
    mid = build(name("Stealth Test Intermediate"), root.subject, mid_key, root_key, True, 0)
    leaf = build(name(HOSTNAME), mid.subject, leaf_key, mid_key, False, san=HOSTNAME)

    der = lambda cert: cert.public_bytes(serialization.Encoding.DER)
    certs = []
    # The list the core declares has about 1850 certificates, so the write to
    # cert_storage takes as long as it does in a profile: the filler is other
    # intermediates of the same root, which nothing verifies against. The one
    # the leaf needs is somewhere in the middle of the list.
    others = []
    for n in range(filler):
        others.append(
            build(name("Stealth Test Filler %d" % n), root.subject, mid_key, root_key, True, 0)
        )
    for cert in others[: filler // 2] + [mid] + others[filler // 2 :]:
        raw = der(cert)
        certs.append(
            {
                "derHash": b64(hashlib.sha256(raw).digest()),
                "cert": b64(raw),
                "subject": b64(cert.subject.public_bytes()),
            }
        )
    listing = {
        "format": 1,
        "collection": "security-state/intermediates",
        "collection_timestamp": INTERMEDIATES_TS,
        "fetched_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(certs),
        "set_sha256": hashlib.sha256(
            "".join(sorted(c["derHash"] for c in certs)).encode("ascii")
        ).hexdigest(),
        "certs": certs,
    }
    list_file = os.path.join(workdir, "intermediates.json")
    with open(list_file, "w", encoding="utf-8", newline="") as fh:
        fh.write(json.dumps(listing, separators=(",", ":")))
    fixture = {
        "root": b64(der(root)),
        "leaf": b64(der(leaf)),
        "hostname": HOSTNAME,
        "listFile": list_file,
    }
    fixture_file = os.path.join(workdir, "fixture.json")
    with open(fixture_file, "w", encoding="utf-8", newline="") as fh:
        json.dump(fixture, fh)
    return fixture_file


class FeedServer(http.server.ThreadingHTTPServer):
    """A Remote Settings server that lists two collections of security-state
    and answers every other request with a 404, recording each request."""

    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), FeedHandler)
        self.requests = []

    @property
    def base(self):
        return "http://127.0.0.1:%d/v1" % self.server_address[1]


class FeedHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.requests.append(self.path)
        path = urllib.parse.urlsplit(self.path).path
        if path.endswith("/buckets/monitor/collections/changes/changeset"):
            body = {
                "timestamp": ONECRL_TS,
                "metadata": {},
                "changes": [
                    {
                        "id": "intermediates-record",
                        "last_modified": INTERMEDIATES_TS,
                        "bucket": "security-state",
                        "collection": "intermediates",
                    },
                    {
                        "id": "onecrl-record",
                        "last_modified": ONECRL_TS,
                        "bucket": "security-state",
                        "collection": "onecrl",
                    },
                ],
            }
            code = 200
        else:
            body, code = {}, 404
        raw = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def kill_tree(proc):
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        import signal

        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run_case(firefox, case, fixture_file, workdir, module_dir, server_base):
    profile = os.path.join(workdir, "profile-" + case)
    os.makedirs(profile)
    out = os.path.join(workdir, "result-%s.json" % case)
    env = dict(os.environ)
    env.update(
        ST_CASE=case,
        ST_OUT=out,
        ST_PROFILE=profile,
        ST_FIXTURE=fixture_file,
        ST_SERVER=server_base,
        # A release build ignores services.settings.server without this.
        MOZ_REMOTE_SETTINGS_DEVTOOLS="1",
        MOZ_CRASHREPORTER_DISABLE="1",
    )
    if module_dir:
        env["ST_MODULE_DIR"] = module_dir
    proc = subprocess.Popen(
        [firefox, "-xpcshell", CASE_SCRIPT],
        env=env,
        cwd=workdir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=(os.name != "nt"),
    )
    try:
        output, _ = proc.communicate(timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        output, _ = proc.communicate()
        return None, "timed out after %d s" % TIMEOUT_S, output
    finally:
        if proc.poll() is None:
            kill_tree(proc)
    text = output.decode("utf-8", "replace")
    if not os.path.exists(out):
        return None, "no result written (exit %s)" % proc.returncode, text
    with open(out, encoding="utf-8") as fh:
        return json.load(fh), "", text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("firefox")
    ap.add_argument("--module-dir")
    ap.add_argument("--cases", default=",".join(ALL_CASES))
    ap.add_argument("--filler", type=int, default=1800, help="other certificates in the list")
    args = ap.parse_args()
    # The cases run in a temporary directory: a relative path would not follow.
    args.firefox = os.path.abspath(args.firefox)
    cases = args.cases.split(",")
    for case in cases:
        if case not in ALL_CASES:
            sys.exit("unknown case " + case)

    workdir = tempfile.mkdtemp(prefix="stealth-intermediates-")
    status = 0
    try:
        fixture_file = make_fixture(workdir, args.filler)
        server = FeedServer()
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            for case in cases:
                server.requests.clear()
                result, problem, log = run_case(
                    args.firefox, case, fixture_file, workdir, args.module_dir, server.base
                )
                if result is None:
                    print("%-9s DID NOT RUN: %s" % (case, problem))
                    print(log[-2000:])
                    status = max(status, 2)
                    continue
                ok, detail = result["ok"], result["detail"]
                if case == "poller":
                    seen = list(server.requests)
                    on_intermediates = [r for r in seen if "intermediates" in r.lower()]
                    # `_expected` is the poller's own: init() reads the local
                    # database with `_expected=0`.
                    on_onecrl = [
                        r
                        for r in seen
                        if "/collections/onecrl/" in r and "_expected=%d" % ONECRL_TS in r
                    ]
                    feed = [r for r in seen if "/collections/changes/" in r]
                    ok = bool(feed) and bool(on_onecrl) and not on_intermediates
                    detail = (
                        "%d requests: feed %d, onecrl asked by the poller %d, "
                        "touching the intermediates %d %s"
                        % (len(seen), len(feed), len(on_onecrl), len(on_intermediates), on_intermediates)
                    )
                print("%-9s %s  %s" % (case, "PASS" if ok else "FAIL", detail))
                if result.get("evidence"):
                    print("          evidence (never asserted): %s" % json.dumps(result["evidence"]))
                if not ok:
                    status = max(status, 1)
        finally:
            server.shutdown()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    return status


if __name__ == "__main__":
    sys.exit(main())
