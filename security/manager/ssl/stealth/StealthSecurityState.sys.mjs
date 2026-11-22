/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The security state a retail Firefox holds in <profile>/security_state/ comes
// from files the core declares, never from the network.
//
// A retail Firefox gets three collections of the Remote Settings bucket
// "security-state" (RemoteSecuritySettings.init, browser-idle-startup, then every
// 24 hours): the intermediate certificates ("intermediates"), the CRLite filters
// ("cert-revocations": one full filter and its deltas) and the revocations of
// intermediates and roots ("onecrl"). A page tells the states apart: a chain that
// only a preloaded intermediate completes verifies in one and fails in the other,
// and a revoked certificate that CRLite covers, or an intermediate that OneCRL
// lists, loads in one and fails in the other.
//
// This engine is a full Firefox, so Remote Settings is there and would sync all
// three collections from the network. The hook in RemoteSecuritySettings.init()
// asks ownsSync() and returns before any of the three clients exists: Remote
// Settings never syncs them, at any launch.
//
// The engine has one job here, and it is not done at a normal launch. A normal
// launch imports nothing: cert_storage opens <profile>/security_state/ by itself
// (cert_storage/src/lib.rs, do_construct_cert_storage: it reads the CRLite deltas,
// the database and the full filter on its own thread), and finds there what the
// core put in the profile, as a retail profile that has synced. The core makes those
// files once per fetch, with the engine in the mode below, in a work profile, and
// copies them into the profile of each launch.
//
// What Juggler waits for: the first navigation of the client must see the full
// filter and every delta the core put in the profile. whenStorageReady() resolves
// once cert_storage has read <profile>/security_state/ (see there for why a
// callback of hasPriorData proves it); Juggler holds the client's messages and the
// readiness line until it has resolved. It never rejects and is never left pending.
//
// The mode "generate" is a launch of the engine whose profile has these prefs
// (user.js, written by the core):
//
//   zoom.stealth.securitystate.generate  true
//   zoom.stealth.intermediates.file      the list of intermediates (format 1, certs)
//   zoom.stealth.onecrl.file             the OneCRL revocations (format 1, revocations)
//   zoom.stealth.crlite.file             the CRLite manifest (format 1, full, deltas)
//
// The files are the ones the core fetched and verified (their sizes and hashes were
// checked when they were downloaded); the engine only reads them. A pref that is
// empty leaves that collection out. The engine hands them to nsICertStorage
// exactly as RemoteSecuritySettings hands the downloaded data (same nsICertInfo and
// revocation-state shapes, TRUST_INHERIT, STATE_ENFORCE, setFullCRLiteFilter and
// then addCRLiteDelta in the manifest's order), one write after the other, waits
// for cert_storage's serial queue to have done them all, writes
// <profile>/securitystate-result.json and quits with exit status 0, or with status 1
// when anything went wrong (the file says what, in "error"; when the file cannot be
// written the status is 1 and there is no file). Nothing is printed: the outcome is the
// exit status and the file. It writes nothing outside the profile.
//
// In this mode the full Firefox must ask the network for nothing and must not open
// its default browser window. run() puts the IO service offline first (without
// letting it manage the offline status), and fails the generation if it cannot.
// runAndQuit() cancels the default command-line action with a one-shot observer of
// "command-line-startup", so BrowserContentHandler opens no window.
//
// last_crlite_update, the time cert_storage takes the CRLite filters as fresh from
// (ten days), is the time of the write, as in a retail Firefox: the core generates
// right after it fetched, and says when the data are too old. The files of the filter
// and its deltas are the bytes the core fetched, so the same data make the same
// files; the database (data.safe.bin) holds the same content, and the time of the
// write in it.

const PREF_GENERATE = "zoom.stealth.securitystate.generate";
const PREF_INTERMEDIATES = "zoom.stealth.intermediates.file";
const PREF_ONECRL = "zoom.stealth.onecrl.file";
const PREF_CRLITE = "zoom.stealth.crlite.file";
const FORMAT = 1;
const RESULT_FILE = "securitystate-result.json";
const RESULT_FORMAT = 1;
// A call to cert_storage that has not called back by now is a broken
// cert_storage: the generation fails rather than hang for ever.
const WRITE_TIMEOUT_MS = 30000;
// The name cert_storage gives the full filter in the profile; a delta must not
// be able to overwrite it.
const FULL_FILTER_NAME = "crlite.filter";
// If cert_storage has not read the security state by then, a launch goes on without
// waiting for it.
const READY_TIMEOUT_MS = 30000;

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

class CertInfo {
  constructor(cert, subject) {
    this.cert = cert;
    this.subject = subject;
    this.trust = Ci.nsICertStorage.TRUST_INHERIT;
  }
}
CertInfo.prototype.QueryInterface = ChromeUtils.generateQI(["nsICertInfo"]);

class IssuerAndSerialRevocationState {
  constructor(issuer, serial) {
    this.state = Ci.nsICertStorage.STATE_ENFORCE;
    this.issuer = issuer;
    this.serial = serial;
  }
}
IssuerAndSerialRevocationState.prototype.QueryInterface =
  ChromeUtils.generateQI(["nsIIssuerAndSerialRevocationState"]);

class SubjectAndPubKeyRevocationState {
  constructor(subject, pubKey) {
    this.state = Ci.nsICertStorage.STATE_ENFORCE;
    this.subject = subject;
    this.pubKey = pubKey;
  }
}
SubjectAndPubKeyRevocationState.prototype.QueryInterface =
  ChromeUtils.generateQI(["nsISubjectAndPubKeyRevocationState"]);

const isString = v => typeof v == "string" && v.length;

// One call to cert_storage: resolves with its callback's result, or rejects when
// the call threw, failed, or never called back.
function callStorage(invoke) {
  return new Promise((resolve, reject) => {
    const timer = lazy.setTimeout(
      () => reject(new Error("cert_storage did not call back")),
      WRITE_TIMEOUT_MS
    );
    try {
      invoke((rv, out) => {
        lazy.clearTimeout(timer);
        if (rv !== Cr.NS_OK) {
          reject(new Error("cert_storage call failed: " + rv));
        } else {
          resolve(out);
        }
      });
    } catch (e) {
      lazy.clearTimeout(timer);
      reject(e);
    }
  });
}

async function readJSON(path) {
  return JSON.parse(await IOUtils.readUTF8(path));
}

async function importIntermediates(path, certStorage) {
  const list = await readJSON(path);
  if (list.format !== FORMAT || !Array.isArray(list.certs)) {
    throw new Error("unknown format of the intermediates list");
  }
  const infos = [];
  for (const entry of list.certs) {
    if (entry && isString(entry.cert) && isString(entry.subject)) {
      infos.push(new CertInfo(entry.cert, entry.subject));
    }
  }
  await callStorage(cb => certStorage.addCerts(infos, cb));
  return {
    count: infos.length,
    collection_timestamp: list.collection_timestamp ?? null,
    fetched_utc: list.fetched_utc ?? null,
  };
}

async function importOneCRL(path, certStorage) {
  const list = await readJSON(path);
  if (list.format !== FORMAT || !Array.isArray(list.revocations)) {
    throw new Error("unknown format of the OneCRL file");
  }
  const items = [];
  for (const item of list.revocations) {
    if (!item) {
      continue;
    }
    if (isString(item.issuerName) && isString(item.serialNumber)) {
      items.push(
        new IssuerAndSerialRevocationState(item.issuerName, item.serialNumber)
      );
    } else if (isString(item.subject) && isString(item.pubKeyHash)) {
      items.push(
        new SubjectAndPubKeyRevocationState(item.subject, item.pubKeyHash)
      );
    }
  }
  await callStorage(cb => certStorage.setRevocations(items, cb));
  return {
    count: items.length,
    collection_timestamp: list.collection_timestamp ?? null,
    updated_utc: list.updated_utc ?? null,
  };
}

// A file entry of the manifest, checked before anything is imported: a plain name next
// to the manifest, and the sha256 the core checked the file by (crlite_filter_hashes of the
// result are the manifest's, so every entry must have one).
function checkEntry(entry) {
  if (
    !entry ||
    !isString(entry.file) ||
    /[\\/:\0]/.test(entry.file) ||
    entry.file.startsWith(".") ||
    entry.file === FULL_FILTER_NAME
  ) {
    throw new Error("a file entry of the CRLite manifest is not valid");
  }
  if (!isString(entry.sha256)) {
    throw new Error("the manifest entry " + entry.file + " has no sha256");
  }
}

// The full filter and then every delta, in the order of the manifest, one after
// the other as RemoteSecuritySettings does. Every file must be there: a generation
// that leaves one out would make a state no retail profile has.
async function importCRLite(path, certStorage) {
  const manifest = await readJSON(path);
  if (
    manifest.format !== FORMAT ||
    !manifest.full ||
    !Array.isArray(manifest.deltas)
  ) {
    throw new Error("unknown format of the CRLite manifest");
  }
  for (const entry of [manifest.full, ...manifest.deltas]) {
    checkEntry(entry);
  }
  const dir = PathUtils.parent(path);
  const full = await IOUtils.read(PathUtils.join(dir, manifest.full.file));
  await callStorage(cb => certStorage.setFullCRLiteFilter(full, cb));
  for (const entry of manifest.deltas) {
    const bytes = await IOUtils.read(PathUtils.join(dir, entry.file));
    await callStorage(cb => certStorage.addCRLiteDelta(bytes, entry.file, cb));
  }
  return {
    count: 1 + manifest.deltas.length,
    collection_timestamp: manifest.collection_timestamp ?? null,
    updated_utc: manifest.updated_utc ?? null,
    channel: manifest.channel ?? null,
    // the hashes the core wrote in the manifest, in its order (taken out of the result by generate())
    hashes: [manifest.full, ...manifest.deltas].map(e => String(e.sha256 ?? "").toLowerCase()),
  };
}

// name in the result (the collection's own name), pref, importer
// The hashes cert_storage holds (sha256 of the bytes of each filter), in the order of
// the manifest, which is the order they were added in. Both lists must name the same
// filters: the manifest's hashes are the ones the core checked the files by.
function inManifestOrder(held, manifestHashes) {
  if (manifestHashes === null) {
    return held;
  }
  if (
    held.length !== manifestHashes.length ||
    !held.every(h => manifestHashes.includes(h))
  ) {
    throw new Error(
      "cert-revocations: cert_storage holds " + held.join(",") +
        ", the manifest names " + manifestHashes.join(",")
    );
  }
  return manifestHashes;
}

const PARTS = [
  ["intermediates", PREF_INTERMEDIATES, importIntermediates],
  ["onecrl", PREF_ONECRL, importOneCRL],
  ["cert-revocations", PREF_CRLITE, importCRLite],
];

// The engine that makes the files, so that the core knows when to make them again.
function engineVersion() {
  const info = Services.appinfo;
  return { version: info.version ?? null, build_id: info.appBuildID ?? null };
}

// In the mode "generate", every HTTP channel is cancelled as it opens (goOffline()):
// nothing of a generation needs one, and whatever else the browser starts must not leave.
const ChannelRefusal = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  observe(subject) {
    try {
      subject.QueryInterface(Ci.nsIChannel).cancel(Cr.NS_ERROR_OFFLINE);
    } catch (e) {
      // not a channel: nothing to cancel
    }
  },
};

// While a generation runs, a request to quit that can be refused is refused: whoever asks
// (a window closing, a command, the application) is told no, and the generation ends first.
// What cannot be refused is not this observer's to handle.
const QuitGuard = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  observe(subject) {
    subject.QueryInterface(Ci.nsISupportsPRBool).data = true;
  },
};

export const StealthSecurityState = {
  // The debug record of the last whenStorageReady(): { result, ms }, result being
  // "called-back", "timeout" or "error".
  lastReady: null,
  _ready: null,

  /**
   * Whether this module, and not Remote Settings, owns the sync of the three
   * collections of the security-state bucket. RemoteSecuritySettings.init() returns
   * before creating their clients when this is true.
   *
   * @returns {boolean}
   */
  ownsSync() {
    return true;
  },

  /**
   * One promise, the same for every caller, that resolves when cert_storage has
   * read <profile>/security_state/, or after READY_TIMEOUT_MS, or at once if
   * anything throws. It never rejects and is never left pending.
   *
   * Why the callback proves it: the constructor of cert_storage
   * (security/manager/ssl/cert_storage/src/lib.rs, do_construct_cert_storage)
   * dispatches to its serial queue the task that reads <profile>/security_state/
   * (the CRLite deltas, the database and the full filter). hasPriorData() is
   * dispatched to the same queue, so its callback comes after that task: from then
   * on a verification sees the full filter and every delta. The result and the
   * value the callback carries do not matter, only that it comes.
   *
   * @returns {Promise<void>}
   */
  whenStorageReady() {
    if (this._ready) {
      return this._ready;
    }
    this._ready = new Promise(resolve => {
      const start = ChromeUtils.now();
      let timer = null;
      let settled = false;
      const settle = result => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          try {
            lazy.clearTimeout(timer);
          } catch (e) {
            // nothing to clear
          }
        }
        this.lastReady = { result, ms: Math.round(ChromeUtils.now() - start) };
        resolve();
      };
      try {
        timer = lazy.setTimeout(() => settle("timeout"), READY_TIMEOUT_MS);
        const certStorage = Cc["@mozilla.org/security/certstorage;1"].getService(
          Ci.nsICertStorage
        );
        certStorage.hasPriorData(Ci.nsICertStorage.DATA_TYPE_CERTIFICATE, {
          QueryInterface: ChromeUtils.generateQI(["nsICertStorageCallback"]),
          done() {
            settle("called-back");
          },
        });
      } catch (e) {
        settle("error");
      }
    });
    return this._ready;
  },

  /**
   * Puts the IO service offline and stops it from managing the offline status, and
   * cancels every HTTP channel at its opening, so that the generation asks the network
   * for nothing.
   *
   * Offline alone is not enough: Necko refuses a socket to a remote address while
   * offline, but a channel whose proxy is on the loopback (a system proxy on
   * localhost) still connects, and the full Firefox opens channels of its own from
   * final-ui-startup on (the launch counter, Region). "http-on-opening-request" is
   * notified in nsHttpChannel::AsyncOpen, before the proxy is resolved, so a channel
   * cancelled there reaches no proxy and no server, whatever the machine's settings.
   *
   * @returns {string|null} null when it worked, else what went wrong
   */
  goOffline() {
    try {
      Services.obs.addObserver(ChannelRefusal, "http-on-opening-request");
      Services.io.manageOfflineStatus = false;
      Services.io.offline = true;
      if (Services.io.offline !== true) {
        return "offline: the IO service is not offline";
      }
      return null;
    } catch (e) {
      return "offline: " + (e?.message ?? e);
    }
  },

  /**
   * Imports the declared files into cert_storage (the profile's security_state/),
   * waits until cert_storage's queue has done every write, and says what is in
   * it. Never rejects: a failure is {ok: false, error}.
   *
   * @param {object} [paths] files to read instead of the ones the prefs name:
   *   { intermediates, onecrl, crlite }, each optional
   * @returns {Promise<object>} the content of securitystate-result.json
   */
  async generate(paths = {}) {
    const result = {
      format: RESULT_FORMAT,
      ok: false,
      error: null,
      engine: null,
      collections: {},
      crlite_filter_hashes: [],
    };
    try {
      result.engine = engineVersion();
      const certStorage = Cc["@mozilla.org/security/certstorage;1"].getService(
        Ci.nsICertStorage
      );
      let manifestHashes = null;
      for (const [name, pref, importer] of PARTS) {
        const key = name == "cert-revocations" ? "crlite" : name;
        const path = paths[key] ?? Services.prefs.getStringPref(pref, "");
        if (!path) {
          result.collections[name] = null;
          continue;
        }
        try {
          result.collections[name] = await importer(path, certStorage);
          if (name == "cert-revocations") {
            manifestHashes = result.collections[name].hashes;
            delete result.collections[name].hashes;
          }
        } catch (e) {
          throw new Error(name + ": " + (e?.message ?? e));
        }
      }
      // One more call on the serial queue: it comes back after every write above
      // and tells what the filters are.
      const held = String(
        (await callStorage(cb => certStorage.getCRLiteFilterHashes(cb))) ?? ""
      )
        .split(",")
        .filter(Boolean);
      result.crlite_filter_hashes = inManifestOrder(held, manifestHashes);
      result.ok = true;
    } catch (e) {
      result.error = String(e?.message ?? e);
    }
    return result;
  },

  /**
   * generate(), then the result in <profile>/securitystate-result.json.
   *
   * @returns {Promise<number>} the exit status: 0 when it worked
   */
  async run() {
    // Synchronously, before the first await: nothing may reach the network from here on.
    const offlineError = this.goOffline();
    Services.obs.addObserver(QuitGuard, "quit-application-requested");
    let result;
    try {
      // Before anything is touched, the result says the generation did not finish: if
      // the process ends before the end of it (a quit that cannot be refused, a signal),
      // that is what the file says, never a result of an earlier generation in the same
      // profile and never ok. A marker that cannot be written is a failure: the status
      // is 1, there is no file, and nothing is generated.
      if (!(await this.writeResult(this.unfinished()))) {
        return 1;
      }
      if (offlineError) {
        // The generation must not run with a network that could be asked: nothing is imported.
        result = this.unfinished();
        result.error = offlineError;
      } else {
        result = await this.generate();
      }
    } finally {
      Services.obs.removeObserver(QuitGuard, "quit-application-requested");
    }
    // A result that cannot be written is a failure whatever the generation did.
    // Nothing is printed: the outcome is the exit status and the file.
    if (!(await this.writeResult(result))) {
      return 1;
    }
    return result.ok ? 0 : 1;
  },

  /** One-shot: the next command line started has its default action prevented (no default window). */
  preventDefaultWindow() {
    const observer = {
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
      observe(subject) {
        try {
          Services.obs.removeObserver(observer, "command-line-startup");
        } catch (e) {
          // already removed
        }
        try {
          subject.QueryInterface(Ci.nsICommandLine).preventDefault = true;
        } catch (e) {
          // not a command line
        }
      },
    };
    Services.obs.addObserver(observer, "command-line-startup");
  },

  /** The result of a generation that has begun and has not ended. */
  unfinished() {
    let engine = null;
    try {
      engine = engineVersion();
    } catch (e) {
      // no application information: the result is still the marker
    }
    return {
      format: RESULT_FORMAT,
      ok: false,
      error: "generation did not finish",
      engine,
      collections: {},
      crlite_filter_hashes: [],
    };
  },

  /** result -> <profile>/securitystate-result.json, atomically. @returns {Promise<boolean>} written */
  async writeResult(result) {
    const file = PathUtils.join(PathUtils.profileDir, RESULT_FILE);
    try {
      await IOUtils.writeUTF8(file, JSON.stringify(result, null, 1), {
        tmpPath: file + ".tmp",
      });
      return true;
    } catch (e) {
      return false;
    }
  },

  /**
   * The mode as the component runs it: the application is held open until the
   * generation has ended, then asked to quit with its status. `startup` is
   * nsIAppStartup (a test gives its own).
   *
   * Without a window, nsAppStartup::Run does not spin the event loop and quits at once
   * with status 0 (nsAppStartup.cpp:297, :315), before the generation has ended: the
   * survival area gives the loop a reason to run. The quit comes before the exit from
   * the area: leaving it asks nsAppStartup to quit with the status of the first quit
   * so far (nsAppStartup.cpp:627-637), which would be 0 and would win, since the first
   * quit wins (nsAppStartup.cpp:340; the code is taken once, AppShutdown.cpp:209). The
   * pair enter/exit is kept whatever happens.
   *
   * A quit that others force before the end is not ours to answer: the first quit
   * wins, and for a forced closing the outcome is the result file, which says ok: false
   * ("generation did not finish") until the very end.
   */
  async runAndQuit(startup = Services.startup) {
    startup.enterLastWindowClosingSurvivalArea();
    // Synchronously, before anything else: the default browser window is opened by
    // BrowserContentHandler only when the command line has not had its default
    // prevented. "command-line-startup" is notified (nsAppRunner.cpp) after
    // profile-after-change and before the command line runs; the observer removes itself.
    this.preventDefaultWindow();
    let status = 1;
    try {
      status = await this.run();
    } catch (e) {
      // run() does not reject; if it does, the result is still the marker (ok: false) and
      // the status is 1.
    } finally {
      try {
        startup.quit(Ci.nsIAppStartup.eForceQuit, status);
      } finally {
        startup.exitLastWindowClosingSurvivalArea();
      }
    }
    return status;
  },
};

// The component the profile-after-change category creates (components.conf).
// Without the pref it does nothing: a normal launch imports nothing.
export function StealthSecurityStateStartup() {}

StealthSecurityStateStartup.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  observe(subject, topic) {
    if (
      topic == "profile-after-change" &&
      Services.prefs.getBoolPref(PREF_GENERATE, false)
    ) {
      StealthSecurityState.runAndQuit();
    }
  },
};
