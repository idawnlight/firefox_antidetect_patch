/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One case of the intermediates test, run as `firefox -xpcshell <this file>` by
// run_stealth_intermediates_gate.py, which is the only caller (it makes the
// certificates, the file of the list, the fake settings server and the profile,
// and passes them in the environment). No xpcshell harness is involved: the
// engine package has a shell but not the harness, so this file does by hand
// what do_get_profile does (a ProfD provider, profile-do-change), and reports
// by writing a JSON file and exiting.
//
// Cases (ST_CASE):
//   with      the pref names the list; the component is called the way the
//             profile-after-change category calls it; then StealthIntermediates
//             .whenLoaded is awaited, the very promise Juggler awaits before it
//             tells the client the browser is ready, and the verification of a
//             leaf that only the preloaded intermediate completes must succeed.
//             (Asked in the same turn, with no wait, the verification can
//             precede cert_storage's write: nothing orders the two.)
//   without   the same verification with no pref: the intermediate comes from
//             the list or from nowhere, so it must fail with UNKNOWN_ISSUER.
//   poller    RemoteSecuritySettings.init() and one poll of the changes feed of
//             a local server that lists security-state/intermediates and
//             security-state/onecrl: no request may touch the intermediates,
//             and the poller must have asked for onecrl (it is alive).
//   category  profile-after-change names the component.
//   settles   whenLoaded is resolved before any load, and after a load with no
//             pref, with a file that does not exist and with a file in a format
//             that is not ours: it is never left pending, never rejected.
//
// Environment: ST_CASE, ST_OUT (result file), ST_PROFILE (empty directory),
// ST_FIXTURE (JSON: root, leaf, hostname, listFile), ST_MODULE_DIR (optional,
// a directory with StealthIntermediates.sys.mjs to load instead of the one in
// the package: only for a binary that does not carry it), ST_SERVER (poller).

"use strict";

const CONTRACT = "@mozilla.org/psm/stealth-intermediates;1";
const CATEGORY_ENTRY = "StealthIntermediates";
const PREF_FILE = "zoom.stealth.intermediates.file";
const SEC_ERROR_UNKNOWN_ISSUER = Ci.nsINSSErrorsService.NSS_SEC_ERROR_BASE + 13;

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
  const dir = env("ST_MODULE_DIR");
  if (!dir) {
    return "resource://gre/modules/psm/StealthIntermediates.sys.mjs";
  }
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(dir);
  Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler)
    .setSubstitution("stealth-test", Services.io.newFileURI(file));
  return "resource://stealth-test/StealthIntermediates.sys.mjs";
}

// What the profile-after-change category does with the component: it creates
// it and notifies it. With a module directory the class is the module's own.
function callComponent() {
  if (env("ST_MODULE_DIR")) {
    const mod = ChromeUtils.importESModule(moduleUrl());
    new mod.StealthIntermediatesStartup().observe(
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

function verifyLeaf(certdb, leaf, hostname) {
  return new Promise(resolve => {
    certdb.asyncVerifyCertAtTime(
      leaf,
      0x0001, // certificateUsageSSLServer
      0,
      hostname,
      Date.now() / 1000,
      [],
      prErrorCode => resolve(prErrorCode)
    );
  });
}

function prepareCertDb(fixture) {
  Services.prefs.setIntPref("security.OCSP.enabled", 0);
  const certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(
    Ci.nsIX509CertDB
  );
  certdb.addCertFromBase64(fixture.root, "CTu,,");
  return {
    certdb,
    leaf: certdb.constructX509FromBase64(fixture.leaf),
  };
}

async function caseWithOrWithout(fixture, withPref) {
  const { certdb, leaf } = prepareCertDb(fixture);
  if (withPref) {
    Services.prefs.setStringPref(PREF_FILE, fixture.listFile);
  }
  let componentProblem = "";
  if (withPref) {
    callComponent();
  } else {
    // With no pref the component has nothing to do, whether it is there or
    // not: the case asks only where the intermediate would come from.
    try {
      callComponent();
    } catch (e) {
      componentProblem = " (" + e.message + ")";
    }
  }
  let waited = null;
  if (withPref) {
    // What Juggler does before the client can send a command.
    const { StealthIntermediates } = ChromeUtils.importESModule(moduleUrl());
    const t0 = ChromeUtils.now();
    await StealthIntermediates.whenLoaded;
    waited = ChromeUtils.now() - t0;
  }
  const prErrorCode = await verifyLeaf(certdb, leaf, fixture.hostname);
  let last = null;
  try {
    last = ChromeUtils.importESModule(moduleUrl()).StealthIntermediates.lastLoad;
  } catch (e) {
    // A binary without the module has no record of a load.
  }
  // Evidence only, never asserted: how long each step took.
  const evidence = last
    ? {
        read_ms: last.readMs,
        parse_ms: last.parseMs,
        add_certs_ms: last.addCertsMs,
        count: last.count,
        load_result: last.result,
        done_ms: last.doneMs,
        when_loaded_wait_ms: waited,
      }
    : null;
  if (withPref) {
    return {
      ok: prErrorCode === 0 && !!last && last.result === Cr.NS_OK,
      detail:
        "verification after whenLoaded ended with " +
        prErrorCode +
        ", the write ended with " +
        (last ? last.result : "no record"),
      prErrorCode,
      evidence,
    };
  }
  return {
    ok: prErrorCode === SEC_ERROR_UNKNOWN_ISSUER,
    detail:
      "verification with no list ended with " +
      prErrorCode +
      ", SEC_ERROR_UNKNOWN_ISSUER is " +
      SEC_ERROR_UNKNOWN_ISSUER +
      componentProblem,
    prErrorCode,
    evidence,
  };
}

async function casePoller() {
  Services.prefs.setStringPref("services.settings.server", env("ST_SERVER"));
  Services.prefs.setBoolPref(
    "security.remote_settings.crlite_filters.enabled",
    false
  );
  const { RemoteSecuritySettings } = ChromeUtils.importESModule(
    "resource://gre/modules/psm/RemoteSecuritySettings.sys.mjs"
  );
  const { RemoteSettings } = ChromeUtils.importESModule(
    "resource://services-settings/remote-settings.sys.mjs"
  );
  RemoteSecuritySettings.init();
  let pollError = "";
  try {
    await RemoteSettings.pollChanges({ trigger: "manual" });
  } catch (e) {
    // The fake server cannot sign the collections it lists: a failed sync of
    // onecrl is expected, the requests it made are the evidence.
    pollError = String(e);
  }
  // Whatever the poll-end observers started is on its way.
  await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
  return {
    ok: true,
    detail: "poll done",
    pollError,
    clientOfIntermediates: !!RemoteSecuritySettings.IntermediatePreloadsClient
      ?.client,
  };
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

async function caseSettles(fixture) {
  const { StealthIntermediates } = ChromeUtils.importESModule(moduleUrl());
  const steps = [];
  const record = async (label, expectedResult) => {
    const state = await settlesWithin(StealthIntermediates.whenLoaded, 10000);
    const result = StealthIntermediates.lastLoad?.result;
    steps.push({
      label,
      state,
      result: String(result),
      ok:
        state === "resolved" &&
        (expectedResult === undefined ||
          String(result).startsWith(expectedResult)),
    });
  };
  // Before any load of this process. (A module the component has already
  // started has a record; the check is then the one of the next steps.)
  if (!StealthIntermediates.lastLoad) {
    await record("before any load");
  }
  Services.prefs.clearUserPref(PREF_FILE);
  StealthIntermediates.load();
  await record("no pref", "skipped");
  StealthIntermediates.load(
    PathUtils.join(env("ST_PROFILE"), "there-is-no-such-file.json")
  );
  await record("a file that does not exist", "error");
  const wrong = PathUtils.join(env("ST_PROFILE"), "wrong-format.json");
  await IOUtils.writeUTF8(wrong, JSON.stringify({ format: 99, certs: [] }));
  StealthIntermediates.load(wrong);
  await record("a format that is not ours", "error");
  StealthIntermediates.load(fixture.listFile);
  await record("the list", String(Cr.NS_OK));
  return {
    ok: steps.every(step => step.ok),
    detail: steps
      .map(step => step.label + ": " + step.state + " (" + step.result + ")")
      .join("; "),
    steps,
  };
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

async function main() {
  const which = env("ST_CASE");
  const fixture = JSON.parse(await IOUtils.readUTF8(env("ST_FIXTURE")));
  setUpProfile(env("ST_PROFILE"));
  switch (which) {
    case "with":
      return caseWithOrWithout(fixture, true);
    case "without":
      return caseWithOrWithout(fixture, false);
    case "poller":
      return casePoller();
    case "category":
      return caseCategory();
    case "settles":
      return caseSettles(fixture);
    default:
      throw new Error("unknown case " + which);
  }
}

let finished = false;
let exitCode = 0;
main()
  .catch(e => ({ ok: false, detail: "threw: " + e, stack: String(e.stack) }))
  .then(async result => {
    result.case = env("ST_CASE");
    await IOUtils.writeUTF8(env("ST_OUT"), JSON.stringify(result));
    print("STEALTH_INTERMEDIATES_CASE " + JSON.stringify(result));
  })
  .catch(e => {
    print("STEALTH_INTERMEDIATES_CASE_ERROR " + e);
    exitCode = 2;
  })
  .finally(() => {
    finished = true;
  });
Services.tm.spinEventLoopUntil("stealth-intermediates-case", () => finished);
quit(exitCode);
