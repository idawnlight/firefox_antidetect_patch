# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""The test of the security state the core declares, against a built engine.

    python run_stealth_security_state_gate.py <firefox binary>
        [--cases generate,inspect,...]
        [--module-file StealthSecurityState.sys.mjs] [--crlite-data DIR]
    python run_stealth_security_state_gate.py --make-crlite-data DIR

Each case is one `firefox -xpcshell stealth_security_state_case.js` process with
a profile of its own (stealth_security_state_case.js says what each case asks).
The package of the engine carries the xpcshell shell but not the xpcshell
harness, which is why the profiles, the certificates and the files are made here.

The engine makes <profile>/security_state/ in its mode "generate" from the files
the core declares, and a launch finds it there. The cases:

  generate         two profiles, from the same files: both exit 0 and say ok (the
                   engine's version and BuildID, the count and the timestamps of every
                   collection, the hashes of the filters); crlite.filter and the delta
                   have the same sha256 in both, and are the bytes of the files; and the
                   database is the same by content, asked of cert_storage's API in a
                   process of its own: the same hashes, the same state of every OneCRL
                   record, the same answer to every verification.
  ready            a copy of the state of a generated profile, put in a new profile:
                   a process that uses it gives the same answers (a certificate revoked in
                   the full filter and one revoked in a delta are -8180, a valid one and one
                   the filter does not cover are 0, the intermediates and OneCRL work) and
                   does not rewrite a file (sha256, mtime and inode of every file, before
                   and after).
  empty            a profile with no state: the answers of a launch before the core has
                   made one (nothing revoked, the intermediate of the list unknown).
  ready_settles    whenStorageReady() (what Juggler waits for): resolved, not pending, never
                   rejected, the same promise on every call, `lastReady.result` is
                   "called-back", on an empty profile and on a profile with a ready state (a
                   copy of the one `generate` made), the filters it sees being the state's.
  poller           RemoteSecuritySettings.init() leaves the three clients (OneCRL, intermediates,
                   CRLite filters) null; one poll of a local fake settings server that lists
                   security-state/onecrl, security-state/intermediates and
                   security-state/cert-revocations, and one collection of another bucket with a
                   client the case registers itself, makes no request that touches a collection of
                   security-state and does ask for the other one (the poller is alive).
  generate_without_delta, generate_fails, quit_refused, run_and_quit, marker,
  result_not_writable, profile_not_writable, no_import, never_asked, category
                   see stealth_security_state_case.js.

The files the core declares, in the formats the core writes (format 1):

  intermediates  a list with the intermediate of the run among 1800 others (the
                 leaf verifies only if that intermediate is in cert_storage).
  onecrl         the OneCRL revocations: one intermediate listed by issuer and
                 serial, one by subject and public key hash, among 900 other
                 records; a third intermediate is not listed.
  crlite         manifests (format 1) with the full filter and the delta of
                 Mozilla's CRLite test data, next to their files, and the ones with
                 something wrong in them.

The files carry what the core writes besides what the engine reads, and the
engine ignores it without an error: `collection`, `count` and a `derHash` for every
certificate (intermediates), `collection` and `enabled` (OneCRL; the engine imports every
record, enabled or not, as updateCertBlocklist does), `collection`, and `sha256` and `size`
for every file (CRLite); the times are ISO strings and are passed on as they are.

The certificates of the first two are made on every run (a root and the
intermediates and leaves under it, with the `cryptography` library). The CRLite
data are Mozilla's own test data (security/manager/ssl/tests/unit/
test_crlite_filters/: the filters, and the certificates they say are revoked). Only this
test folder is checked out where the gate runs, so they are in crlite_test_data.json next to
this file (per file: Mozilla's path, sha256, base64; every sha256 is checked before use):
the gate unpacks that file unless --crlite-data names a folder that has the files. The file
is made by `--make-crlite-data DIR`, DIR being Mozilla's test_crlite_filters folder. The
times in the files are fixed: nothing here reads the clock but the certificates' validity.

--module-file tests a source of the module before the engine is built: the case
loads it from a resource: URL pointed at its folder, and calls its startup class
as the profile-after-change category does. (`category` and `poller` are about the
package and ignore it.)

Exit status: 0 when every case passed, 1 when one failed, 2 when one did not run.
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
CASE_SCRIPT = os.path.join(HERE, "stealth_security_state_case.js")
CRLITE_DATA_FILE = os.path.join(HERE, "crlite_test_data.json")
MOZILLA_CRLITE_DIR = "security/manager/ssl/tests/unit/test_crlite_filters"
ALL_CASES = [
    "generate",
    "ready",
    "ready_settles",
    "empty",
    "generate_without_delta",
    "generate_fails",
    "quit_refused",
    "run_and_quit",
    "marker",
    "result_not_writable",
    "profile_not_writable",
    "no_import",
    "never_asked",
    "category",
    "poller",
]
# The cases about the package, not about the module's source.
PACKAGE_ONLY = ("category", "poller")
UPDATED_UTC = "2020-01-01T00:00:00Z"
TIMEOUT_S = 180
INTERMEDIATES_TS = 1900000000001
ONECRL_TS = 1900000000002
CRLITE_TS = 1900000000003
# The collection of another bucket that the poller case registers a client for. Its timestamp is the one the
# fake feed gives it, and the one a request names in `_expected` when the poller asks for it.
PROBE_BUCKET = "stealth-probe"
PROBE_COLLECTION = "stealth-poller-probe"
PROBE_TS = 1900000000004
CRLITE_LEAVES = [
    "valid",
    "not-covered",
    "revoked",
    "revoked-in-delta",
]
FULL_FILTER = "20200101-0-filter"
DELTA_FILTER = "20200101-1-filter.delta"
# the files of Mozilla's CRLite test data the gate uses
CRLITE_FILES = [FULL_FILTER, DELTA_FILTER, "ca.pem", "int.pem"] + ["%s.example.com.pem" % n for n in CRLITE_LEAVES]


def b64(raw):
    return base64.b64encode(raw).decode("ascii")


def utc(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def write_json(path, value):
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(json.dumps(value, separators=(",", ":")))


def pem_to_der_b64(path):
    with open(path, encoding="ascii") as fh:
        lines = [ln.strip() for ln in fh if ln.strip() and not ln.startswith("-----")]
    return "".join(lines)


def make_crlite_data(source_dir, out=CRLITE_DATA_FILE):
    """Writes crlite_test_data.json from Mozilla's test_crlite_filters folder: per file, its path in Mozilla's tree,
    its sha256 and its bytes in base64. The same folder makes the same file."""
    files = {}
    for name in CRLITE_FILES:
        with open(os.path.join(source_dir, name), "rb") as fh:
            raw = fh.read()
        files[name] = {"path": MOZILLA_CRLITE_DIR + "/" + name, "sha256": hashlib.sha256(raw).hexdigest(), "base64": b64(raw)}
    write_json(out, {"format": 1, "source": "Mozilla's " + MOZILLA_CRLITE_DIR, "files": files})


def unpack_crlite_data(json_path, directory):
    """The files of crlite_test_data.json in `directory`, every sha256 checked first. Returns the directory."""
    with open(json_path, encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("format") != 1 or sorted(data.get("files", {})) != sorted(CRLITE_FILES):
        raise SystemExit("%s does not hold the files of the gate: %s" % (json_path, CRLITE_FILES))
    os.makedirs(directory, exist_ok=True)
    for name, entry in data["files"].items():
        raw = base64.b64decode(entry["base64"])
        if hashlib.sha256(raw).hexdigest() != entry["sha256"]:
            raise SystemExit("%s: the bytes of %s are not the sha256 it names" % (json_path, name))
        with open(os.path.join(directory, name), "wb") as fh:
            fh.write(raw)
    return directory


def crlite_data_dir(option, workdir):
    """The folder with Mozilla's CRLite test files: the one --crlite-data names, else crlite_test_data.json unpacked in workdir."""
    if option:
        return os.path.abspath(option)
    return unpack_crlite_data(CRLITE_DATA_FILE, os.path.join(workdir, "crlite-data"))


def file_entry(directory, name):
    with open(os.path.join(directory, name), "rb") as fh:
        raw = fh.read()
    return {"file": name, "sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw)}


def make_chains(workdir, filler):
    """The root, the intermediates and the leaves of the run, the list of
    intermediates and the OneCRL file. Returns the part of the fixture about them."""
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

    der = lambda cert: cert.public_bytes(serialization.Encoding.DER)
    spki = lambda cert: cert.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    # cert_storage keys a revocation by the bytes of the serial number's value.
    serial_value = lambda cert: cert.serial_number.to_bytes(
        cert.serial_number.bit_length() // 8 + 1, "big"
    )

    root_key = ec.generate_private_key(ec.SECP256R1())
    root = build(name("Stealth Test Root"), name("Stealth Test Root"), root_key, root_key, True)
    certs = {}
    hostnames = {}
    made = {}
    # i: the intermediate that the list of intermediates carries. a, b, c: the
    # intermediates OneCRL lists by issuer and serial, by subject and public key
    # hash, and not at all.
    for tag in "iabcd":
        key, leaf_key = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
        mid = build(name("Stealth Test Intermediate " + tag), root.subject, key, root_key, True, 0)
        hostname = "state-%s.example.test" % tag
        leaf = build(name(hostname), mid.subject, leaf_key, key, False, san=hostname)
        made[tag] = (mid, key)
        certs["mid_" + tag] = b64(der(mid))
        certs["leaf_" + tag] = b64(der(leaf))
        hostnames["leaf_" + tag] = hostname

    # The list the core declares has about 1850 certificates, so the write to
    # cert_storage takes as long as it does in a profile: the filler is other
    # intermediates of the same root, which nothing verifies against. The one
    # the leaf needs is somewhere in the middle of the list.
    mid_i, mid_key = made["i"]
    others = [
        build(name("Stealth Test Filler %d" % n), root.subject, mid_key, root_key, True, 0)
        for n in range(filler)
    ]
    listed = []
    for cert in others[: filler // 2] + [mid_i] + others[filler // 2 :]:
        raw = der(cert)
        listed.append(
            {
                "derHash": b64(hashlib.sha256(raw).digest()),
                "cert": b64(raw),
                "subject": b64(cert.subject.public_bytes()),
            }
        )
    intermediates_file = os.path.join(workdir, "intermediates.json")
    write_json(
        intermediates_file,
        {
            "format": 1,
            "collection": "security-state/intermediates",
            "collection_timestamp": INTERMEDIATES_TS,
            "fetched_utc": UPDATED_UTC,
            "count": len(listed),
            "set_sha256": hashlib.sha256(
                "".join(sorted(c["derHash"] for c in listed)).encode("ascii")
            ).hexdigest(),
            "certs": listed,
        },
    )

    bad_format_file = os.path.join(workdir, "wrong-format.json")
    write_json(bad_format_file, {"format": 99, "certs": [], "revocations": [], "deltas": []})

    # OneCRL: the records as the collection has them, copied as they are (base64).
    mid_a, _ = made["a"]
    mid_b, _ = made["b"]
    records = [
        {"issuerName": b64(root.subject.public_bytes()), "serialNumber": b64(serial_value(mid_a))},
        {"subject": b64(mid_b.subject.public_bytes()), "pubKeyHash": b64(hashlib.sha256(spki(mid_b)).digest())},
    ]
    # a record the collection marks enabled: false: the engine imports every record, as updateCertBlocklist does
    mid_d, _ = made["d"]
    records.append({"issuerName": b64(root.subject.public_bytes()), "serialNumber": b64(serial_value(mid_d)), "enabled": False})
    for n in range(900):
        if n % 2:
            records.append({"issuerName": b64(os.urandom(48)), "serialNumber": b64(os.urandom(16))})
        else:
            records.append({"subject": b64(os.urandom(48)), "pubKeyHash": b64(os.urandom(32))})
    onecrl_file = os.path.join(workdir, "onecrl.json")
    write_json(
        onecrl_file,
        {
            "format": 1,
            "collection": "onecrl",
            "collection_timestamp": ONECRL_TS,
            "updated_utc": UPDATED_UTC,
            "revocations": records,
        },
    )
    return {
        "root": b64(der(root)),
        "certs": certs,
        "hostnames": hostnames,
        "meta": {
            "intermediates_count": len(listed),
            "intermediates_timestamp": INTERMEDIATES_TS,
            "onecrl_count": len(records),
            "onecrl_issuer_count": sum(1 for r in records if "issuerName" in r),
            "onecrl_timestamp": ONECRL_TS,
            "crlite_timestamp": CRLITE_TS,
            "updated_utc": UPDATED_UTC,
        },
        "files": {
            "intermediates": intermediates_file,
            "onecrl": onecrl_file,
            "missing": os.path.join(workdir, "there-is-no-such-file.json"),
            "bad_format": bad_format_file,
        },
    }


def make_crlite(workdir, data):
    """The manifests, each in a folder of its own with its files next to it.
    Returns the part of the fixture about them."""
    full = os.path.join(data, FULL_FILTER)
    delta = os.path.join(data, DELTA_FILTER)

    def folder(label, deltas=True, mutate=None):
        directory = os.path.join(workdir, "crlite-" + label)
        os.makedirs(directory)
        shutil.copy(full, os.path.join(directory, FULL_FILTER))
        shutil.copy(delta, os.path.join(directory, DELTA_FILTER))
        manifest = {
            "format": 1,
            "collection": "cert-revocations",
            "channel": "default",
            "collection_timestamp": CRLITE_TS,
            "updated_utc": UPDATED_UTC,
            "full": file_entry(directory, FULL_FILTER),
            "deltas": [file_entry(directory, DELTA_FILTER)] if deltas else [],
        }
        if mutate:
            mutate(directory, manifest)
        path = os.path.join(directory, "crlite.json")
        write_json(path, manifest)
        return path

    def wrong_format(directory, manifest):
        manifest["format"] = 2

    def missing_delta(directory, manifest):
        manifest["deltas"] = [dict(manifest["deltas"][0], file="there-is-no-such-delta")]

    def named_like_full(directory, manifest):
        # A delta named like the full filter exists and is right but for its name: it
        # would overwrite the filter.
        shutil.copy(delta, os.path.join(directory, "crlite.filter"))
        manifest["deltas"] = [dict(manifest["deltas"][0], file="crlite.filter")]

    def named(name):
        # The file the name points at exists and is right: only the check of the name leaves it out.
        def mutate(directory, manifest):
            target = os.path.normpath(os.path.join(directory, name)) if "\\" not in name else os.path.join(directory, name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy(delta, target)
            manifest["deltas"] = [dict(manifest["deltas"][0], file=name)]
        return mutate

    def no_sha256(entry):
        def mutate(directory, manifest):
            target = manifest["full"] if entry == "full" else manifest["deltas"][0]
            del target["sha256"]
        return mutate

    files = {
        "no_sha256_full": folder("no-sha256-full", mutate=no_sha256("full")),
        "no_sha256_delta": folder("no-sha256-delta", mutate=no_sha256("delta")),
        "name_with_slash": folder("name-with-slash", mutate=named("sub/" + DELTA_FILTER)),
        "name_with_backslash": folder("name-with-backslash", mutate=named("sub\\" + DELTA_FILTER)),
        "name_with_dots": folder("name-with-dots", mutate=named("../" + DELTA_FILTER)),
        "fresh": folder("fresh", deltas=False),
        "delta": folder("delta"),
        "bad_format": folder("bad-format", mutate=wrong_format),
        "missing_delta": folder("missing-delta", mutate=missing_delta),
        "named_like_full": folder("named-like-full", mutate=named_like_full),
    }
    sha = lambda path: hashlib.sha256(open(path, "rb").read()).hexdigest()
    return {
        "files": files,
        "hashes": {"full": sha(full), "delta": sha(delta), "full_name": FULL_FILTER, "delta_name": DELTA_FILTER},
        "certificates": {
            "ca": pem_to_der_b64(os.path.join(data, "ca.pem")),
            "int": pem_to_der_b64(os.path.join(data, "int.pem")),
            "leaves": {
                n: pem_to_der_b64(os.path.join(data, n + ".example.com.pem"))
                for n in CRLITE_LEAVES
            },
        },
    }


def make_fixture(workdir, filler, crlite_data):
    fixture = make_chains(workdir, filler)
    crlite = make_crlite(workdir, crlite_data)
    fixture["files"]["crlite"] = crlite["files"]
    fixture["hashes"] = crlite["hashes"]
    fixture["crlite"] = crlite["certificates"]
    fixture_file = os.path.join(workdir, "fixture.json")
    write_json(fixture_file, fixture)
    return fixture_file


class FeedServer(http.server.ThreadingHTTPServer):
    """A Remote Settings server that lists the three collections of security-state and the collection of another
    bucket, and answers every other request with a 404, recording each request."""

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
            listed = [
                ("security-state", "onecrl", ONECRL_TS),
                ("security-state", "intermediates", INTERMEDIATES_TS),
                ("security-state", "cert-revocations", CRLITE_TS),
                (PROBE_BUCKET, PROBE_COLLECTION, PROBE_TS),
            ]
            body = {
                "timestamp": PROBE_TS,
                "metadata": {},
                "changes": [
                    {"id": collection + "-record", "last_modified": stamp, "bucket": bucket, "collection": collection}
                    for bucket, collection, stamp in listed
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


def run_case(firefox, case, fixture_file, workdir, module_file, profile_name=None, extra_env=None):
    """-> (result, problem, log); the profile is workdir/profile-<profile_name or case>, made empty unless it is there."""
    profile = os.path.join(workdir, "profile-" + (profile_name or case))
    os.makedirs(profile, exist_ok=True)
    out = os.path.join(workdir, "result-%s-%s.json" % (case, profile_name or case))
    env = dict(os.environ)
    env.update(
        ST_CASE=case,
        ST_OUT=out,
        ST_PROFILE=profile,
        ST_FIXTURE=fixture_file,
        MOZ_CRASHREPORTER_DISABLE="1",
    )
    if module_file and case not in PACKAGE_ONLY:
        env["ST_MODULE_FILE"] = module_file
    if extra_env:
        env.update(extra_env)
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
        return None, "timed out after %d s" % TIMEOUT_S, output.decode("utf-8", "replace")
    finally:
        if proc.poll() is None:
            kill_tree(proc)
    text = output.decode("utf-8", "replace")
    if not os.path.exists(out):
        return None, "no result written (exit %s)" % proc.returncode, text
    with open(out, encoding="utf-8") as fh:
        return json.load(fh), "", text


def snapshot(directory):
    """name -> (sha256, mtime in ns, inode, size) of every file of the directory."""
    found = {}
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        st = os.stat(path)
        with open(path, "rb") as fh:
            found[name] = (hashlib.sha256(fh.read()).hexdigest(), st.st_mtime_ns, st.st_ino, st.st_size)
    return found


def expected_answers(fixture, full):
    """What a profile with the state (full) or with none must answer, as caseInspect reports it."""
    revoked = -8180  # SEC_ERROR_REVOKED_CERTIFICATE
    unknown_issuer = -8179  # SEC_ERROR_UNKNOWN_ISSUER
    meta = fixture["meta"]
    if full:
        return {
            "has_certs": True,
            "has_revocations": True,
            "hashes": [fixture["hashes"]["full"], fixture["hashes"]["delta"]],
            "onecrl_states": "1" * meta["onecrl_issuer_count"],
            "verify": {
                "intermediate_of_the_list": 0,
                "onecrl_issuer_and_serial": revoked,
                "onecrl_subject_and_key": revoked,
                "onecrl_not_listed": 0,
                "onecrl_enabled_false": revoked,
                "crlite_revoked_in_full": revoked,
                "crlite_revoked_in_delta": revoked,
                "crlite_valid": 0,
                "crlite_not_covered": 0,
            },
        }
    return {
        "has_certs": False,
        "has_revocations": False,
        "hashes": [],
        "onecrl_states": "0" * meta["onecrl_issuer_count"],
        "verify": {
            "intermediate_of_the_list": unknown_issuer,
            "onecrl_issuer_and_serial": 0,
            "onecrl_subject_and_key": 0,
            "onecrl_not_listed": 0,
            "onecrl_enabled_false": 0,
            "crlite_revoked_in_full": 0,
            "crlite_revoked_in_delta": 0,
            "crlite_valid": 0,
            "crlite_not_covered": 0,
        },
    }


class CaseFailed(Exception):
    """A step that a case needs ran and failed (not the case's own check): the case is red."""


class Verdict:
    def __init__(self, name):
        self.name = name
        self.problems = []
        self.notes = []

    def check(self, condition, message):
        if not condition:
            self.problems.append(message)

    def line(self):
        return "%-24s %s  %s" % (
            self.name,
            "FAIL" if self.problems else "PASS",
            "; ".join(self.problems) if self.problems else "; ".join(self.notes),
        )


def inspect_profile(firefox, fixture_file, workdir, module_file, profile_name):
    result, problem, log = run_case(firefox, "inspect", fixture_file, workdir, module_file, profile_name)
    if result is None:
        raise RuntimeError("inspect of %s did not run: %s\n%s" % (profile_name, problem, log[-1500:]))
    if "answers" not in result:
        raise CaseFailed("inspect of %s: %s" % (profile_name, result.get("detail")))
    return result


def case_generate(firefox, fixture_file, fixture, workdir, module_file):
    v = Verdict("generate")
    sources = {
        "crlite.filter": os.path.join(os.path.dirname(fixture["files"]["crlite"]["delta"]), FULL_FILTER),
        DELTA_FILTER: os.path.join(os.path.dirname(fixture["files"]["crlite"]["delta"]), DELTA_FILTER),
    }
    made = {}
    for name in ("gen-a", "gen-b"):
        result, problem, log = run_case(firefox, "generate", fixture_file, workdir, module_file, name)
        if result is None:
            v.problems.append("%s did not run: %s %s" % (name, problem, log[-600:]))
            return v
        v.check(result["ok"], "%s: %s" % (name, result["detail"]))
        state = os.path.join(workdir, "profile-" + name, "security_state")
        made[name] = snapshot(state) if os.path.isdir(state) else {}
        v.check(os.path.isfile(os.path.join(workdir, "profile-" + name, "securitystate-result.json")), "%s: no result file" % name)
        v.check("data.safe.bin" in made[name], "%s: no database in security_state/" % name)
        for target, source in sources.items():
            with open(source, "rb") as fh:
                want = hashlib.sha256(fh.read()).hexdigest()
            v.check(made[name].get(target, ("",))[0] == want, "%s: %s is not the bytes of the file it was given" % (name, target))
        v.check(sorted(made[name]) == sorted(["data.safe.bin", "crlite.filter", DELTA_FILTER]),
                "%s: the files of security_state/ are %s" % (name, sorted(made[name])))
    if made.get("gen-a") and made.get("gen-b"):
        same = {n: made["gen-a"][n][0] for n in made["gen-a"] if n != "data.safe.bin"}
        again = {n: made["gen-b"][n][0] for n in made["gen-b"] if n != "data.safe.bin"}
        v.check(same == again, "two generations from the same files did not make the same filter and delta")
    answers = {}
    for name in ("gen-a", "gen-b"):
        answers[name] = inspect_profile(firefox, fixture_file, workdir, module_file, name)["answers"]
        v.check(answers[name] == expected_answers(fixture, True), "%s, by content: %s" % (name, json.dumps(answers[name])[:300]))
    v.check(answers["gen-a"] == answers["gen-b"], "the two databases do not answer the same")
    if not v.problems:
        v.notes.append("two generations: the filter and the delta have the same sha256, the databases answer the same (hashes, %d OneCRL records, %d verifications)"
                       % (fixture["meta"]["onecrl_issuer_count"], len(expected_answers(fixture, True)["verify"])))
    return v


def case_ready(firefox, fixture_file, fixture, workdir, module_file):
    v = Verdict("ready")
    source = os.path.join(workdir, "profile-gen-a", "security_state")
    if not os.path.isdir(source):
        v.problems.append("needs the profile of the case generate")
        return v
    profile = os.path.join(workdir, "profile-ready")
    os.makedirs(profile)
    shutil.copytree(source, os.path.join(profile, "security_state"))
    state = os.path.join(profile, "security_state")
    before = snapshot(state)
    answers = inspect_profile(firefox, fixture_file, workdir, module_file, "ready")["answers"]
    after = snapshot(state)
    v.check(answers == expected_answers(fixture, True), "answers: %s" % json.dumps(answers)[:400])
    for name in before:
        v.check(after.get(name) == before[name], "%s was rewritten (sha256, mtime, inode)" % name)
    v.check(sorted(after) == sorted(before), "files appeared or went: %s" % sorted(set(after) ^ set(before)))
    if not v.problems:
        v.notes.append("%d files used as copied (sha256, mtime, inode); revoked in the full filter and in the delta: -8180, valid and not covered: 0"
                       % len(before))
    return v


def case_empty(firefox, fixture_file, fixture, workdir, module_file):
    v = Verdict("empty")
    answers = inspect_profile(firefox, fixture_file, workdir, module_file, "empty")["answers"]
    v.check(answers == expected_answers(fixture, False), "answers: %s" % json.dumps(answers)[:400])
    state = os.path.join(workdir, "profile-empty", "security_state")
    v.check(not os.path.isdir(state) or not [n for n in os.listdir(state) if n != "data.safe.bin"],
            "a profile with no state got files other than the database")
    if not v.problems:
        v.notes.append("no state: nothing revoked, the intermediate of the list unknown, no filter")
    return v


def case_ready_settles(firefox, fixture_file, fixture, workdir, module_file):
    v = Verdict("ready_settles")
    source = os.path.join(workdir, "profile-gen-a", "security_state")
    if not os.path.isdir(source):
        v.problems.append("needs the profile of the case generate")
        return v
    state = os.path.join(workdir, "profile-rs-ready")
    os.makedirs(state)
    shutil.copytree(source, os.path.join(state, "security_state"))
    for label, profile_name, hashes in (
        ("empty profile", "rs-empty", []),
        ("ready state", "rs-ready", [fixture["hashes"]["full"], fixture["hashes"]["delta"]]),
    ):
        result, problem, log = run_case(firefox, "ready_settles", fixture_file, workdir, module_file, profile_name)
        if result is None:
            v.problems.append("%s did not run: %s %s" % (label, problem, log[-600:]))
            continue
        v.check(result["ok"], "%s: %s" % (label, result["detail"]))
        v.check(result.get("hashes") == hashes, "%s: the filters it holds right after are %s" % (label, result.get("hashes")))
        if result.get("evidence"):
            v.notes.append("%s: %s" % (label, json.dumps(result["evidence"])))
    if not v.problems:
        v.notes.insert(0, "resolved, the same promise every call, called-back, on an empty profile and on a ready state")
    return v


def case_poller(firefox, fixture_file, fixture, workdir, module_file):
    v = Verdict("poller")
    server = FeedServer()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        # A release build ignores services.settings.server without MOZ_REMOTE_SETTINGS_DEVTOOLS.
        result, problem, log = run_case(
            firefox, "poller", fixture_file, workdir, module_file,
            extra_env={"ST_SERVER": server.base, "MOZ_REMOTE_SETTINGS_DEVTOOLS": "1"},
        )
    finally:
        server.shutdown()
        server.server_close()
    if result is None:
        raise RuntimeError("poller did not run: %s\n%s" % (problem, log[-1500:]))
    seen = list(server.requests)
    paths = [(r, urllib.parse.urlsplit(r).path.lower()) for r in seen]
    touching = [
        r
        for r, path in paths
        if "/buckets/security-state" in path
        or any("/collections/%s/" % c in path or path.endswith("/collections/" + c) for c in ("onecrl", "intermediates", "cert-revocations"))
    ]
    feed = [r for r, path in paths if "/collections/changes/" in path]
    probe = [
        r
        for r, path in paths
        if "/buckets/%s/collections/%s/" % (PROBE_BUCKET, PROBE_COLLECTION) in path and "_expected=%d" % PROBE_TS in r
    ]
    v.check(result["ok"], result["detail"])
    v.check(bool(feed), "the poller did not ask for the changes feed")
    v.check(bool(probe), "the poller did not ask for the collection of the other bucket: it is not alive (%d requests)" % len(seen))
    v.check(not touching, "requests that touch a collection of security-state: %s" % touching)
    if not v.problems:
        v.notes.append(
            "%d requests: feed %d, the other bucket's collection asked by the poller %d, touching security-state %d; the three clients are null"
            % (len(seen), len(feed), len(probe), len(touching))
        )
    return v


COMPOSITE = {
    "generate": case_generate,
    "ready": case_ready,
    "ready_settles": case_ready_settles,
    "empty": case_empty,
    "poller": case_poller,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("firefox", nargs="?")
    ap.add_argument("--cases", default=",".join(ALL_CASES))
    ap.add_argument("--filler", type=int, default=1800, help="other certificates in the list of intermediates")
    ap.add_argument("--crlite-data", help="a folder with Mozilla's test_crlite_filters files, instead of crlite_test_data.json")
    ap.add_argument("--make-crlite-data", metavar="DIR", help="write crlite_test_data.json from Mozilla's test_crlite_filters folder DIR, and stop")
    ap.add_argument("--module-file", help="a source of StealthSecurityState.sys.mjs to test instead of the package's")
    args = ap.parse_args()
    if args.make_crlite_data:
        make_crlite_data(os.path.abspath(args.make_crlite_data))
        print("wrote " + CRLITE_DATA_FILE)
        return 0
    if not args.firefox:
        ap.error("the firefox binary is required")
    # The cases run in a temporary directory: a relative path would not follow.
    args.firefox = os.path.abspath(args.firefox)
    module_file = os.path.abspath(args.module_file) if args.module_file else None
    cases = args.cases.split(",")
    for case in cases:
        if case not in ALL_CASES:
            sys.exit("unknown case " + case)

    workdir = tempfile.mkdtemp(prefix="stealth-security-state-")
    status = 0
    try:
        fixture_file = make_fixture(workdir, args.filler, crlite_data_dir(args.crlite_data, workdir))
        with open(fixture_file, encoding="utf-8") as fh:
            fixture = json.load(fh)
        # `ready` uses what `generate` made: it runs it too, quietly, when it is asked alone
        if "ready" in cases and "generate" not in cases:
            case_generate(args.firefox, fixture_file, fixture, workdir, module_file)
        for case in cases:
            try:
                if case in COMPOSITE:
                    verdict = COMPOSITE[case](args.firefox, fixture_file, fixture, workdir, module_file)
                    print(verdict.line())
                    if verdict.problems:
                        status = max(status, 1)
                    continue
                result, problem, log = run_case(args.firefox, case, fixture_file, workdir, module_file)
            except CaseFailed as exc:
                print("%-24s FAIL  %s" % (case, exc))
                status = max(status, 1)
                continue
            except RuntimeError as exc:
                print("%-24s DID NOT RUN: %s" % (case, exc))
                status = max(status, 2)
                continue
            if result is None:
                print("%-24s DID NOT RUN: %s" % (case, problem))
                print(log[-2000:])
                status = max(status, 2)
                continue
            ok, detail = result["ok"], result["detail"]
            print("%-24s %s  %s" % (case, "PASS" if ok else "FAIL", detail))
            if result.get("evidence"):
                print("%-24s evidence (never asserted): %s" % ("", json.dumps(result["evidence"])))
            if not ok:
                status = max(status, 1)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    return status


if __name__ == "__main__":
    sys.exit(main())
