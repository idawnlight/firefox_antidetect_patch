/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One case of the security-state test, run as `firefox -xpcshell <this file>` by
// run_stealth_security_state_gate.py, which is the only caller (it makes the
// certificates, the files the core declares and the profiles, and passes them in
// the environment). No xpcshell harness is involved: the engine package has a
// shell but not the harness, so this file does by hand what do_get_profile does
// (a ProfD provider, profile-do-change), and reports by writing a JSON file and
// exiting.
//
// The engine makes <profile>/security_state/ in its mode "generate", and a launch
// only finds it there: the cases are about the two sides. Verifications run with
// OCSP off: nothing is asked of the network.
//
// Cases (ST_CASE):
//   generate     the three prefs name the files and zoom.stealth.securitystate.generate
//                is set; run() (what the component does, minus the quit) imports them,
//                exits 0 and writes securitystate-result.json in the profile: the result
//                says ok, the engine's version and BuildID, the count and the timestamps of
//                each collection, and the hashes of the filters (the full one first, then
//                the delta), as the files say.
//   generate_without_delta  the same with a CRLite manifest that has no delta.
//   generate_fails  a file that is not there, a delta that is not there, a delta named like
//                the full filter, a manifest or a list of another format: run() exits 1, the
//                result says ok false and names the collection.
//   result_not_writable, profile_not_writable  the result cannot be written (the profile's folder
//                is closed; in the first the folder security_state/ is open): the marker cannot be
//                written, nothing is generated, run() answers 1 and there is no result file.
//   run_and_quit  the mode as the component runs it, with an application of the test's own: held
//                open (enterLastWindowClosingSurvivalArea) until the generation has ended, then the
//                quit with its status, then the exit from the area; paired when the generation
//                fails and when it throws.
//   marker       the result says "generation did not finish" from the start of run(), in place of an
//                earlier result, until the real one replaces it.
//   quit_refused  a request to quit (quit-application-requested) is refused while a generation
//                runs, and left alone before and after it.
//   inspect      what a launch sees in the profile (ST_PROFILE) with nothing imported: the
//                module's whenStorageReady() is awaited (what Juggler waits for), and then: the
//                hashes of the filters cert_storage holds, whether it
//                has data, the state of every OneCRL record, and verifications: a leaf that only
//                a preloaded intermediate completes, leaves of intermediates that OneCRL lists
//                (by issuer and serial, by subject and key hash) and one that it does not, and
//                Mozilla's test certificates at the time their validity says (revoked in the
//                full filter, revoked in the delta, valid, not covered). The runner compares the
//                answers with what each profile must give.
//   ready_settles  whenStorageReady() of the module (what Juggler waits for) is resolved, not
//                pending after 35 s and never rejected, is the same promise on every call, and
//                lastReady.result is "called-back"; the filters cert_storage holds right after it are
//                reported (the runner runs it on an empty profile and on a profile with a ready state).
//   no_import    the prefs name the files but generate is not set (a normal launch): the
//                component does nothing, cert_storage holds nothing.
//   never_asked  with all three files declared, generating asks the network for nothing (no http
//                channel, no Remote Settings module loaded) and the module has no code that could.
//   category     profile-after-change names the component.
//   poller       RemoteSecuritySettings.init() (the hook asks StealthSecurityState.ownsSync()) leaves
//                OneCRLBlocklistClient, IntermediatePreloadsClient and CRLiteFiltersClient null; the
//                case registers a client of its own for a collection of another bucket and polls
//                the changes feed of a local fake settings server (ST_SERVER) that lists the three
//                security-state collections and that one. The case reports; the runner, which owns the
//                server, judges the requests: none touches a collection of security-state, and the
//                one for the other bucket is made (the poller is alive). A release build honours
//                services.settings.server only with MOZ_REMOTE_SETTINGS_DEVTOOLS, which the runner sets.
//
// Environment: ST_CASE, ST_OUT (result file), ST_PROFILE (empty directory),
// ST_FIXTURE (JSON, see run_stealth_security_state_gate.py), ST_SERVER (poller), and, to test a module
// source before it is built, ST_MODULE_FILE (a file of the module, which is then
// loaded from a resource: URL pointed at its folder; the component is its
// startup class, called directly).

"use strict";

const CONTRACT = "@mozilla.org/psm/stealth-security-state;1";
const CATEGORY_ENTRY = "StealthSecurityState";
const PREF_GENERATE = "zoom.stealth.securitystate.generate";
const PREF_INTERMEDIATES = "zoom.stealth.intermediates.file";
const PREF_ONECRL = "zoom.stealth.onecrl.file";
const PREF_CRLITE = "zoom.stealth.crlite.file";
const SEC_ERROR_UNKNOWN_ISSUER = Ci.nsINSSErrorsService.NSS_SEC_ERROR_BASE + 13;
const SEC_ERROR_REVOKED_CERTIFICATE =
  Ci.nsINSSErrorsService.NSS_SEC_ERROR_BASE + 12;
// The time the certificates of Mozilla's CRLite test data are checked at.
const PROBE_BUCKET = "stealth-probe";
const PROBE_COLLECTION = "stealth-poller-probe";
const CRLITE_CHECK_TIME = new Date("2020-01-01T00:00:00Z").getTime() / 1000;

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

const env = name => Services.env.get(name);

function setUpProfile(dir) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(dir);
  const provider = {
    getFile(prop, persistent) {
      persistent.value = true;
      if (["ProfD", "ProfLD", "ProfDS", "ProfLDS"].includes(prop)) {
        return file.clone();
      }
      return null;
    },
    QueryInterface: ChromeUtils.generateQI(["nsIDirectoryServiceProvider"]),
  };
  Services.dirsvc
    .QueryInterface(Ci.nsIDirectoryService)
    .registerProvider(provider);
  Services.obs.notifyObservers(null, "profile-do-change", "stealth-case");
}

function moduleUrl() {
  const source = env("ST_MODULE_FILE");
  if (!source) {
    return "resource://gre/modules/psm/StealthSecurityState.sys.mjs";
  }
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(source);
  const handler = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  handler.setSubstitution("stealth-under-test", Services.io.newFileURI(file.parent));
  return "resource://stealth-under-test/" + file.leafName;
}

function stateModule() {
  return ChromeUtils.importESModule(moduleUrl());
}

// What the profile-after-change category does with the component: it creates
// it and notifies it.
function callComponent() {
  if (env("ST_MODULE_FILE")) {
    new (stateModule().StealthSecurityStateStartup)().observe(
      null,
      "profile-after-change",
      ""
    );
    return;
  }
  if (!(CONTRACT in Cc)) {
    throw new Error("the component " + CONTRACT + " is not registered");
  }
  Cc[CONTRACT].getService(Ci.nsIObserver).observe(
    null,
    "profile-after-change",
    ""
  );
}


function verifyAt(certdb, cert, hostname, time) {
  return new Promise(resolve => {
    certdb.asyncVerifyCertAtTime(
      cert,
      0x0001, // certificateUsageSSLServer
      0,
      hostname,
      time,
      [],
      prErrorCode => resolve(prErrorCode)
    );
  });
}

function getCertDB() {
  Services.prefs.setIntPref("security.OCSP.enabled", 0);
  // Mozilla's CRLite test certificates carry SCTs of a log that does not exist, as
  // the tests of Mozilla's own (test_crlite_filters.js: "all of the tests here
  // should work even when CT is disabled"): with CT off the timestamps are passed
  // to CRLite as they are.
  Services.prefs.setIntPref("security.pki.certificate_transparency.mode", 0);
  return Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);
}

// The chains this run made (a root and the intermediates and leaves under it)
// and Mozilla's CRLite test chain, in the certificate database as a profile has
// them: the roots trusted, the intermediates known to the database only as
// intermediates (the ones the lists carry are not added).
function prepareCertDb(fixture, { own = [], crlite = false } = {}) {
  const certdb = getCertDB();
  certdb.addCertFromBase64(fixture.root, "CTu,,");
  for (const name of own) {
    certdb.addCertFromBase64(fixture.certs[name], ",,");
  }
  if (crlite) {
    certdb.addCertFromBase64(fixture.crlite.ca, "C,C,");
    certdb.addCertFromBase64(fixture.crlite.int, ",,");
  }
  return certdb;
}

function leafOf(certdb, fixture, name) {
  return certdb.constructX509FromBase64(fixture.certs[name]);
}

function crliteLeaf(certdb, fixture, name) {
  return {
    cert: certdb.constructX509FromBase64(fixture.crlite.leaves[name]),
    hostname: name + ".example.com",
  };
}

function verifyCRLiteLeaf(certdb, fixture, name) {
  const { cert, hostname } = crliteLeaf(certdb, fixture, name);
  return verifyAt(certdb, cert, hostname, CRLITE_CHECK_TIME);
}

function verifyOwnLeaf(certdb, fixture, name) {
  return verifyAt(certdb, leafOf(certdb, fixture, name), fixture.hostnames[name], Date.now() / 1000);
}

// The hashes (hex, comma-separated) of the CRLite filters cert_storage holds, the
// full one first and then the deltas in the order they were loaded.

function judge(steps) {
  return {
    ok: steps.every(s => s.got === s.expected),
    detail: steps
      .map(s => s.label + ": " + s.got + (s.got === s.expected ? "" : " (expected " + s.expected + ")"))
      .join("; "),
    steps,
  };
}


const step = (label, got, expected) => ({ label, got, expected });

function setPrefs(prefs) {
  for (const [pref, value] of Object.entries(prefs)) {
    if (value === "" || value === null || value === undefined) {
      Services.prefs.clearUserPref(pref);
    } else if (typeof value == "boolean") {
      Services.prefs.setBoolPref(pref, value);
    } else {
      Services.prefs.setStringPref(pref, value);
    }
  }
}

function filesPrefs(fixture, over = {}) {
  return {
    [PREF_GENERATE]: true,
    [PREF_INTERMEDIATES]: fixture.files.intermediates,
    [PREF_ONECRL]: fixture.files.onecrl,
    [PREF_CRLITE]: fixture.files.crlite.delta,
    ...over,
  };
}

function resultFile() {
  return PathUtils.join(env("ST_PROFILE"), "securitystate-result.json");
}

function cb(invoke) {
  return new Promise(resolve => invoke((rv, out) => resolve({ rv, out })));
}

// A promise that is not settled within ms is a hang, said as such.
function settlesWithin(promise, ms) {
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule(
    "resource://gre/modules/Timer.sys.mjs"
  );
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve("pending"), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve("resolved");
      },
      () => {
        clearTimeout(timer);
        resolve("rejected");
      }
    );
  });
}

const certStorage = () =>
  Cc["@mozilla.org/security/certstorage;1"].getService(Ci.nsICertStorage);

async function caseGenerate(fixture) {
  const { StealthSecurityState } = stateModule();
  setPrefs(filesPrefs(fixture));
  // run() puts the IO service offline first, and stops it from managing the offline status:
  // the case starts online, so that what it sees afterwards is run()'s doing.
  Services.io.offline = false;
  const onlineBefore = Services.io.offline === false;
  const status = await StealthSecurityState.run();
  const result = JSON.parse(await IOUtils.readUTF8(resultFile()));
  const c = result.collections;
  const crl = c["cert-revocations"];
  const meta = fixture.meta;
  const out = judge([
    step("exit status", status, 0),
    step("result", result.ok + ":" + result.error, "true:null"),
    step("the IO service is online before run()", onlineBefore, true),
    step("Services.io.offline after run()", Services.io.offline, true),
    step("Services.io.manageOfflineStatus after run()", Services.io.manageOfflineStatus, false),
    // the version and the BuildID are the application's (the shell of this test has none: the launch of the engine checks them,
    // run_stealth_generate_launch_gate.py)
    step("the engine is in the result, with these two keys", typeof result.engine + ":" + Object.keys(result.engine ?? {}).join(","),
      "object:version,build_id"),
    step("format of the result", result.format, 1),
    step("counts of intermediates, OneCRL records and CRLite filters",
      JSON.stringify([c.intermediates?.count, c.onecrl?.count, crl?.count]),
      JSON.stringify([meta.intermediates_count, meta.onecrl_count, 2])),
    step("timestamps of the collections",
      JSON.stringify([c.intermediates?.collection_timestamp, c.onecrl?.collection_timestamp, c.onecrl?.updated_utc,
        crl?.collection_timestamp, crl?.updated_utc, crl?.channel]),
      JSON.stringify([meta.intermediates_timestamp, meta.onecrl_timestamp, meta.updated_utc, meta.crlite_timestamp, meta.updated_utc, "default"])),
    step("crlite_filter_hashes, the full one first", result.crlite_filter_hashes.join(","), fixture.hashes.full + "," + fixture.hashes.delta),
  ]);
  out.engine = result.engine;
  return out;
}

async function caseGenerateWithoutDelta(fixture) {
  const { StealthSecurityState } = stateModule();
  setPrefs(filesPrefs(fixture, { [PREF_CRLITE]: fixture.files.crlite.fresh }));
  const status = await StealthSecurityState.run();
  const result = JSON.parse(await IOUtils.readUTF8(resultFile()));
  return judge([
    step("exit status", status, 0),
    step("filters", result.collections["cert-revocations"]?.count, 1),
    step("crlite_filter_hashes", result.crlite_filter_hashes.join(","), fixture.hashes.full),
  ]);
}

async function caseGenerateFails(fixture) {
  const { StealthSecurityState } = stateModule();
  const steps = [];
  const errors = {};
  const bad = async (label, over, word, text) => {
    setPrefs(filesPrefs(fixture, over));
    const status = await StealthSecurityState.run();
    const result = JSON.parse(await IOUtils.readUTF8(resultFile()));
    errors[label] = result.error;
    steps.push(step(label + ", exit status", status, 1));
    steps.push(step(label + ", result", result.ok + ":" + (result.error ?? "").split(":")[0], "false:" + word));
    if (text) {
      steps.push(step(label + ", the message", result.error, text));
    }
  };
  await bad("a file that is not there", { [PREF_ONECRL]: fixture.files.missing }, "onecrl");
  await bad("a manifest of another format", { [PREF_CRLITE]: fixture.files.crlite.bad_format }, "cert-revocations");
  await bad("a delta that is not there", { [PREF_CRLITE]: fixture.files.crlite.missing_delta }, "cert-revocations");
  await bad("a delta named like the full filter", { [PREF_CRLITE]: fixture.files.crlite.named_like_full }, "cert-revocations");
  await bad("a delta whose name has a path separator", { [PREF_CRLITE]: fixture.files.crlite.name_with_slash }, "cert-revocations");
  await bad("a delta whose name has a backslash", { [PREF_CRLITE]: fixture.files.crlite.name_with_backslash }, "cert-revocations");
  await bad("a delta whose name goes up a folder", { [PREF_CRLITE]: fixture.files.crlite.name_with_dots }, "cert-revocations");
  await bad("a list of another format", { [PREF_INTERMEDIATES]: fixture.files.bad_format }, "intermediates");
  // crlite_filter_hashes are the manifest's sha256: a file entry without one fails the generation
  await bad("the full filter with no sha256 in the manifest", { [PREF_CRLITE]: fixture.files.crlite.no_sha256_full }, "cert-revocations",
    "cert-revocations: the manifest entry " + fixture.hashes.full_name + " has no sha256");
  await bad("a delta with no sha256 in the manifest", { [PREF_CRLITE]: fixture.files.crlite.no_sha256_delta }, "cert-revocations",
    "cert-revocations: the manifest entry " + fixture.hashes.delta_name + " has no sha256");
  const out = judge(steps);
  out.evidence = errors;
  return out;
}

// The result cannot be written: the status is 1 and there is no file, whatever the
// generation did. With the folder security_state/ made before the profile's folder
// is closed, the generation itself works (its files are written) and only the result
// fails; with nothing made, the generation fails as well. A user for whom a closed
// folder is not closed (root) cannot run the case.
//
// Windows has no closed folder (the read-only attribute of a folder does not stop a file being
// made in it): there the result cannot be written because a folder is where the file goes (IOUtils
// refuses a write whose destination is a directory, whatever the platform), which stops the
// marker, and so the generation, the same way.
async function caseResultNotWritable(fixture, withState) {
  const { StealthSecurityState } = stateModule();
  const profile = env("ST_PROFILE");
  setPrefs(filesPrefs(fixture));
  const state = PathUtils.join(profile, "security_state");
  if (withState) {
    await IOUtils.makeDirectory(state);
  }
  if (Services.appinfo.OS == "WINNT") {
    await IOUtils.makeDirectory(resultFile());
    const status = await StealthSecurityState.run();
    const isFile = (await IOUtils.stat(resultFile())).type == "regular";
    const made = await IOUtils.exists(PathUtils.join(state, "crlite.filter"));
    return judge([
      step("exit status", status, 1),
      step("a result file", isFile, false),
      step("nothing was generated (the marker could not be written)", made, false),
    ]);
  }
  await IOUtils.setPermissions(profile, 0o555);
  try {
    try {
      await IOUtils.writeUTF8(PathUtils.join(profile, "probe"), "x");
      await IOUtils.remove(PathUtils.join(profile, "probe"));
      return { ok: false, detail: "a closed folder can be written here (root?): the case cannot run" };
    } catch (e) {
      // as it must be
    }
    const status = await StealthSecurityState.run();
    const there = await IOUtils.exists(resultFile());
    const made = await IOUtils.exists(PathUtils.join(state, "crlite.filter"));
    return judge([
      step("exit status", status, 1),
      step("a result file", there, false),
      step("nothing was generated (the marker could not be written)", made, false),
    ]);
  } finally {
    await IOUtils.setPermissions(profile, 0o755);
  }
}

// The mode as the component runs it (runAndQuit), with an application of the test's own:
// the application is held open (enter) until the generation has ended, then asked to quit
// with its status (the quit before the exit), and enter and exit are paired when the
// generation fails and when it throws.
async function caseRunAndQuit(fixture) {
  const { StealthSecurityState } = stateModule();
  const calls = [];
  const startup = {
    enterLastWindowClosingSurvivalArea: () => calls.push("enter"),
    exitLastWindowClosingSurvivalArea: () => calls.push("exit"),
    quit: (mode, status) => calls.push("quit " + mode + " " + status),
  };
  const force = Ci.nsIAppStartup.eForceQuit;
  const steps = [];
  const go = async (label, expected) => {
    calls.length = 0;
    let threw = "";
    try {
      await StealthSecurityState.runAndQuit(startup);
    } catch (e) {
      threw = String(e);
    }
    steps.push(step(label, calls.join(", ") + threw, expected));
  };
  setPrefs(filesPrefs(fixture));
  await go("a generation that works", "enter, quit " + force + " 0, exit");
  setPrefs(filesPrefs(fixture, { [PREF_ONECRL]: fixture.files.missing }));
  await go("a generation that fails", "enter, quit " + force + " 1, exit");
  setPrefs(filesPrefs(fixture));
  const realRun = StealthSecurityState.run;
  StealthSecurityState.run = () => {
    throw new Error("run threw");
  };
  await go("a run that throws", "enter, quit " + force + " 1, exit");
  StealthSecurityState.run = realRun;
  return judge(steps);
}

// The result says "generation did not finish" from the start of run() until its end:
// the marker is what unfinished() gives and writeResult() writes; run() writes it before
// it touches cert_storage and replaces it with the real result at the end; a marker that
// cannot be written stops the generation.
async function caseMarker(fixture) {
  const { StealthSecurityState } = stateModule();
  const read = async () => JSON.parse(await IOUtils.readUTF8(resultFile()));
  const steps = [];
  const marker = StealthSecurityState.unfinished();
  steps.push(step("the marker", JSON.stringify([marker.format, marker.ok, marker.error, marker.collections, marker.crlite_filter_hashes]),
    JSON.stringify([1, false, "generation did not finish", {}, []])));
  // an earlier generation of the profile that said ok: the marker takes its place
  await IOUtils.writeUTF8(resultFile(), JSON.stringify({ format: 1, ok: true, error: null }));
  steps.push(step("writeResult(marker)", await StealthSecurityState.writeResult(marker), true));
  const written = await read();
  steps.push(step("the file says", written.ok + ":" + written.error, "false:generation did not finish"));
  // run(): a marker, then the generation (a file that is not there fails it), and the file says the real error
  setPrefs(filesPrefs(fixture, { [PREF_ONECRL]: fixture.files.missing }));
  const status = await StealthSecurityState.run();
  const failed = await read();
  steps.push(step("a failed generation", status + ":" + failed.ok + ":" + failed.error.split(":")[0], "1:false:onecrl"));
  setPrefs(filesPrefs(fixture));
  steps.push(step("a generation that works", await StealthSecurityState.run(), 0));
  const done = await read();
  steps.push(step("the file at the end", done.ok + ":" + done.error, "true:null"));
  // A generation that never reaches its end (a quit that cannot be refused, in the middle of it, is
  // this): the result file is replaced by the marker at once and stays so.
  await IOUtils.remove(resultFile());
  const realGenerate = StealthSecurityState.generate;
  StealthSecurityState.generate = () => new Promise(() => {});
  StealthSecurityState.run();
  // the marker is being written: no clock, the next turn of the loop (bounded: no marker is a failure, not a hang)
  for (let turns = 0; turns < 200000 && !(await IOUtils.exists(resultFile())); turns++);
  StealthSecurityState.generate = realGenerate;
  const interrupted = (await IOUtils.exists(resultFile())) ? await read() : { ok: "no file", error: "" };
  steps.push(step("the result of a generation that does not end", interrupted.ok + ":" + interrupted.error, "false:generation did not finish"));
  return judge(steps);
}

// While a generation runs, a request to quit is refused (the subject, a nsISupportsPRBool, is
// set to true); before and after, it is not touched.
async function caseQuitRefused(fixture) {
  const { StealthSecurityState } = stateModule();
  setPrefs(filesPrefs(fixture));
  const request = () => {
    const subject = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
    subject.data = false;
    Services.obs.notifyObservers(subject, "quit-application-requested");
    return subject.data;
  };
  const before = request();
  const running = StealthSecurityState.run();
  const during = request();
  const status = await running;
  const after = request();
  return judge([
    step("a request before the generation is left alone", before, false),
    step("a request while it runs is refused", during, true),
    step("the generation ended", status, 0),
    step("a request after it is left alone", after, false),
  ]);
}

// What a launch sees in the profile.
async function caseInspect(fixture) {
  const certdb = prepareCertDb(fixture, { crlite: true, own: ["mid_a", "mid_b", "mid_c", "mid_d"] });
  const cs = certStorage();
  const t0 = ChromeUtils.now();
  // what Juggler waits for before the client's first message: cert_storage has read <profile>/security_state/ (the
  // background read of the deltas, the open of the database, the full filter)
  const { StealthSecurityState } = stateModule();
  await StealthSecurityState.whenStorageReady();
  const ready_ms = ChromeUtils.now() - t0;
  const prior = await cb(f => cs.hasPriorData(Ci.nsICertStorage.DATA_TYPE_CERTIFICATE, f));
  const priorRev = await cb(f => cs.hasPriorData(Ci.nsICertStorage.DATA_TYPE_REVOCATION, f));
  const hashes = String((await cb(f => cs.getCRLiteFilterHashes(f))).out ?? "");
  const dec = b => Array.from(atob(b), c => c.charCodeAt(0));
  const onecrl = JSON.parse(await IOUtils.readUTF8(fixture.files.onecrl)).revocations;
  // The records by issuer and serial: their state is asked by the same two values. (The ones by subject and
  // public key hash carry the hash of the key, which this API cannot be asked with: a leaf below such an
  // intermediate is verified instead.)
  const states = onecrl
    .filter(r => r.issuerName)
    .map(r => cs.getRevocationState(dec(r.issuerName), dec(r.serialNumber), [], []));
  const verify = {
    intermediate_of_the_list: await verifyOwnLeaf(certdb, fixture, "leaf_i"),
    onecrl_issuer_and_serial: await verifyOwnLeaf(certdb, fixture, "leaf_a"),
    onecrl_subject_and_key: await verifyOwnLeaf(certdb, fixture, "leaf_b"),
    onecrl_not_listed: await verifyOwnLeaf(certdb, fixture, "leaf_c"),
    // a record the collection marks enabled: false is revoked all the same, as in a retail Firefox
    // (updateCertBlocklist does not look at the field)
    onecrl_enabled_false: await verifyOwnLeaf(certdb, fixture, "leaf_d"),
    crlite_revoked_in_full: await verifyCRLiteLeaf(certdb, fixture, "revoked"),
    crlite_revoked_in_delta: await verifyCRLiteLeaf(certdb, fixture, "revoked-in-delta"),
    crlite_valid: await verifyCRLiteLeaf(certdb, fixture, "valid"),
    crlite_not_covered: await verifyCRLiteLeaf(certdb, fixture, "not-covered"),
  };
  return {
    ok: true,
    detail: "inspected",
    answers: {
      has_certs: prior.out,
      has_revocations: priorRev.out,
      hashes: hashes.split(",").filter(Boolean),
      onecrl_states: states.join(""),
      verify,
    },
    evidence: { ready_ms, ready: StealthSecurityState.lastReady },
  };
}

// whenStorageReady() settles, whatever is in the profile (the runner runs the case on an empty one and
// on one with a state): never pending, never rejected, one promise for every caller.
async function caseReadySettles() {
  const { StealthSecurityState } = stateModule();
  const first = StealthSecurityState.whenStorageReady();
  const second = StealthSecurityState.whenStorageReady();
  const state = await settlesWithin(first, 35000);
  const third = StealthSecurityState.whenStorageReady();
  const hashes = String((await cb(f => certStorage().getCRLiteFilterHashes(f))).out ?? "");
  const out = judge([
    step("the promise", state, "resolved"),
    step("the same promise on the second call", first === second, true),
    step("the same promise after it settled", first === third, true),
    step("lastReady.result", StealthSecurityState.lastReady?.result, "called-back"),
  ]);
  out.hashes = hashes.split(",").filter(Boolean);
  out.evidence = { ready: StealthSecurityState.lastReady };
  return out;
}

// What Remote Settings does with the security-state bucket in a full Firefox: nothing. The hook in
// RemoteSecuritySettings.init() returns before any of the three clients exists, and a poll of a server
// that lists them asks for none of them, while a client of another bucket is polled as ever.
async function casePoller() {
  Services.prefs.setStringPref("services.settings.server", env("ST_SERVER"));
  const { RemoteSecuritySettings } = ChromeUtils.importESModule(
    "resource://gre/modules/psm/RemoteSecuritySettings.sys.mjs"
  );
  const { RemoteSettings } = ChromeUtils.importESModule(
    "resource://services-settings/remote-settings.sys.mjs"
  );
  const returned = RemoteSecuritySettings.init();
  const created = client => (client === null ? "null" : "created");
  const clients = [
    created(RemoteSecuritySettings.OneCRLBlocklistClient),
    created(RemoteSecuritySettings.IntermediatePreloadsClient),
    created(RemoteSecuritySettings.CRLiteFiltersClient),
  ];
  // A client of the case's own, for a collection of another bucket: the proof that the poller is alive.
  const probe = RemoteSettings(PROBE_COLLECTION, { bucketName: PROBE_BUCKET });
  let pollError = "";
  try {
    await RemoteSettings.pollChanges({ trigger: "manual" });
  } catch (e) {
    // The fake server cannot sign what it lists: a failed sync of the probe is expected, the requests
    // it made are the evidence the runner judges.
    pollError = String(e);
  }
  // Whatever the poll-end observers started is on its way.
  await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
  const out = judge([
    step("init() answers the object", returned === RemoteSecuritySettings, true),
    step("OneCRLBlocklistClient, IntermediatePreloadsClient, CRLiteFiltersClient", clients.join(","), "null,null,null"),
    step("the client of the other bucket is registered", !!probe, true),
  ]);
  out.evidence = { pollError };
  return out;
}

// A normal launch: the prefs name the files, generate is not set.
async function caseNoImport(fixture) {
  setPrefs(filesPrefs(fixture, { [PREF_GENERATE]: "" }));
  // The component's observer starts the generation synchronously when it does: a spy on run() sees it at once.
  const { StealthSecurityState } = stateModule();
  const realRun = StealthSecurityState.run;
  let started = 0;
  StealthSecurityState.run = function () {
    started++;
    return realRun.call(this);
  };
  callComponent();
  StealthSecurityState.run = realRun;
  const cs = certStorage();
  const certs = await cb(f => cs.hasPriorData(Ci.nsICertStorage.DATA_TYPE_CERTIFICATE, f));
  const revs = await cb(f => cs.hasPriorData(Ci.nsICertStorage.DATA_TYPE_REVOCATION, f));
  const hashes = String((await cb(f => cs.getCRLiteFilterHashes(f))).out ?? "");
  let resultThere = true;
  try {
    await IOUtils.readUTF8(resultFile());
  } catch (e) {
    resultThere = false;
  }
  return judge([
    step("generations started by the component", started, 0),
    step("certificates in cert_storage", certs.out, false),
    step("revocations in cert_storage", revs.out, false),
    step("filters in cert_storage", hashes, ""),
    step("a result file", resultThere, false),
  ]);
}

// Asks nothing of the network: with the three files declared, generating opens no
// http channel while the data are written and for a while after, the Remote Settings
// modules (the only code that could ask for these collections) are not loaded, and the
// module's own source has nothing that opens a channel.
async function caseNeverAsked(fixture) {
  const requests = [];
  const topics = ["http-on-opening-request", "http-on-modify-request", "http-on-before-connect"];
  const observer = {
    observe(subject, topic) {
      try {
        requests.push(topic + " " + subject.QueryInterface(Ci.nsIChannel).URI.spec);
      } catch (e) {
        requests.push(topic);
      }
    },
  };
  for (const topic of topics) {
    Services.obs.addObserver(observer, topic);
  }
  setPrefs(filesPrefs(fixture));
  const status = await stateModule().StealthSecurityState.run();
  const result = JSON.parse(await IOUtils.readUTF8(resultFile()));
  const certdb = prepareCertDb(fixture, { crlite: true, own: ["mid_a"] });
  await verifyCRLiteLeaf(certdb, fixture, "revoked");
  await verifyOwnLeaf(certdb, fixture, "leaf_a");
  // A request made late (a timer, an idle callback) is still a request.
  const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  await new Promise(resolve => setTimeout(resolve, 1500));
  for (const topic of topics) {
    Services.obs.removeObserver(observer, topic);
  }
  const loaded = [
    "resource://services-settings/remote-settings.sys.mjs",
    "resource://services-settings/RemoteSettingsClient.sys.mjs",
    "resource://services-settings/Utils.sys.mjs",
    "resource://gre/modules/psm/RemoteSecuritySettings.sys.mjs",
  ].filter(url => Cu.isESModuleLoaded(url));
  // The module's source, through the engine's own channel for resource: URLs.
  const channel = NetUtil.newChannel({
    uri: moduleUrl(),
    loadUsingSystemPrincipal: true,
  });
  const stream = channel.open();
  let source = "";
  try {
    source = NetUtil.readInputStreamToString(stream, stream.available());
  } finally {
    stream.close();
  }
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !line.trimStart().startsWith("//"))
    .join("\n");
  const asks = [
    /services-settings/,
    /RemoteSettings\b/,
    /RemoteSecuritySettings/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /newChannel/,
    /ServiceRequest/,
    /https?:/,
  ].filter(re => re.test(code)).map(String);
  return {
    ok: status === 0 && result.ok && !requests.length && !loaded.length && !asks.length && source.length > 0,
    detail:
      "generate exit " + status +
      "; http channels opened: " + (requests.length ? requests.join(", ") : "none") +
      "; Remote Settings modules loaded: " + (loaded.length ? loaded.join(", ") : "none") +
      "; code in the module that could ask: " + (asks.length ? asks.join(", ") : "none"),
    requests,
    loaded,
    asks,
  };
}

async function main() {
  const which = env("ST_CASE");
  const fixture = JSON.parse(await IOUtils.readUTF8(env("ST_FIXTURE")));
  setUpProfile(env("ST_PROFILE"));
  switch (which) {
    case "generate":
      return caseGenerate(fixture);
    case "generate_without_delta":
      return caseGenerateWithoutDelta(fixture);
    case "generate_fails":
      return caseGenerateFails(fixture);
    case "result_not_writable":
      return caseResultNotWritable(fixture, true);
    case "profile_not_writable":
      return caseResultNotWritable(fixture, false);
    case "run_and_quit":
      return caseRunAndQuit(fixture);
    case "marker":
      return caseMarker(fixture);
    case "quit_refused":
      return caseQuitRefused(fixture);
    case "inspect":
      return caseInspect(fixture);
    case "no_import":
      return caseNoImport(fixture);
    case "never_asked":
      return caseNeverAsked(fixture);
    case "category":
      return caseCategory();
    case "ready_settles":
      return caseReadySettles();
    case "poller":
      return casePoller();
    default:
      throw new Error("unknown case " + which);
  }
}

function caseCategory() {
  const entries = [];
  for (const entry of Services.catMan.enumerateCategory(
    "profile-after-change"
  )) {
    entries.push(entry.entry);
  }
  return {
    ok: entries.includes(CATEGORY_ENTRY),
    detail:
      "profile-after-change has " +
      (entries.includes(CATEGORY_ENTRY) ? "" : "no ") +
      CATEGORY_ENTRY,
    entries: entries.length,
  };
}


let finished = false;
let exitCode = 0;
main()
  .catch(e => ({ ok: false, detail: "threw: " + e, stack: String(e.stack) }))
  .then(async result => {
    result.case = env("ST_CASE");
    await IOUtils.writeUTF8(env("ST_OUT"), JSON.stringify(result));
    print("STEALTH_SECURITY_STATE_CASE " + JSON.stringify(result));
  })
  .catch(e => {
    print("STEALTH_SECURITY_STATE_CASE_ERROR " + e);
    exitCode = 2;
  })
  .finally(() => {
    finished = true;
  });
Services.tm.spinEventLoopUntil("stealth-security-state-case", () => finished);
quit(exitCode);
