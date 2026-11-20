/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The intermediate certificates of Mozilla's list come from a file the core
// declares, never from the network.
//
// A retail Firefox holds, a few minutes into its first session, the whole
// "security-state/intermediates" collection of Remote Settings: it downloads
// it once the browser is idle (RemoteSecuritySettings.init, browser-idle-
// startup), after the first navigation. A page can tell the two states apart,
// because a chain that only the preloaded intermediate completes verifies in
// one and fails in the other. So the engine never creates that collection (the
// hook in RemoteSecuritySettings.sys.mjs: ownsPreloads) and the same list is
// written into cert_storage before any window, from the file whose path the
// core declares in the pref below. The list is the one the core fetched and
// pinned (format, collection timestamp, set hash); this module only reads it.
//
// No request is ever made from here: the file is read with nsIFile and a
// synchronous stream (IOUtils is asynchronous only, and the point is to be
// done before the first window exists), parsed, and handed to
// nsICertStorage.addCerts, exactly as RemoteSecuritySettings hands the
// downloaded certificates (same nsICertInfo shape, TRUST_INHERIT). Any error
// is one line in the console and nothing else: a browser that starts without
// the list is a browser that verifies like a fresh profile, not a broken one.
//
// addCerts returns before the write: cert_storage does it on its own thread, and
// a verification asked in between may not see the list. Nothing here waits for
// it on the main thread; whenLoaded says when it is done, and Juggler
// (components/Juggler.js) does not tell the client the browser is ready, and does
// not hand it a command, before that promise has settled. The write runs in
// parallel to the start of the browser, so the wait costs nothing in a normal
// start.

const PREF_FILE = "zoom.stealth.intermediates.file";
const FORMAT = 1;
// A write that has not called back by now is a broken cert_storage; whoever
// waits for whenLoaded goes on rather than hang for ever.
const WRITE_TIMEOUT_MS = 30000;

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
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

function readFileSync(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  const stream = Cc[
    "@mozilla.org/network/file-input-stream;1"
  ].createInstance(Ci.nsIFileInputStream);
  stream.init(file, -1, -1, 0);
  try {
    return lazy.NetUtil.readInputStreamToString(stream, stream.available(), {
      charset: "UTF-8",
    });
  } finally {
    stream.close();
  }
}

export const StealthIntermediates = {
  // What the last load did, for the test and for whoever debugs a profile:
  // { path, readMs, parseMs, addCertsMs, count, result, doneMs, done }.
  // result is "" until addCerts calls back, then its nsresult (a number);
  // "skipped" when the pref is empty, "error: ..." when something threw.
  // done is a promise that settles when the write to cert_storage has ended.
  lastLoad: null,

  // Resolves when the list of the last load() is in cert_storage: at addCerts'
  // callback, at once when there is nothing to write (no pref, a file that does
  // not read, a format that is not ours, anything that threw) and after
  // WRITE_TIMEOUT_MS if the callback never comes. Never rejected, never left
  // pending. Before the first load() it is already resolved: nothing is being
  // written, so whoever asks has nothing to wait for (a module that is loaded
  // but never started, as in a build without the component, must not hang its
  // waiters). The component calls load() at profile-after-change, before any
  // command line handler, so a waiter that asks later sees the real promise.
  get whenLoaded() {
    return this.lastLoad ? this.lastLoad.done : Promise.resolve();
  },

  // The engine never creates the Remote Settings collection of intermediates,
  // with or without the pref: the list is declared, not downloaded.
  ownsPreloads() {
    return true;
  },

  /**
   * Reads the declared list and writes it to cert_storage. Synchronous up to
   * the call to addCerts, which dispatches the write to cert_storage's own
   * thread and returns; the callback settles lastLoad.done (whenLoaded).
   *
   * @param {string} [path] a file to read instead of the one the pref names
   * @returns {object} the record that is also stored in lastLoad
   */
  load(path) {
    const record = {
      path: "",
      readMs: 0,
      parseMs: 0,
      addCertsMs: 0,
      count: 0,
      result: "",
      doneMs: 0,
      done: Promise.resolve(),
    };
    this.lastLoad = record;
    try {
      record.path =
        path ?? Services.prefs.getStringPref(PREF_FILE, "");
      if (!record.path) {
        record.result = "skipped";
        return record;
      }

      let t0 = ChromeUtils.now();
      const text = readFileSync(record.path);
      let t1 = ChromeUtils.now();
      record.readMs = t1 - t0;

      const list = JSON.parse(text);
      if (list.format !== FORMAT || !Array.isArray(list.certs)) {
        throw new Error("unknown format of the intermediates list");
      }
      const infos = [];
      for (const entry of list.certs) {
        if (entry && entry.cert && entry.subject) {
          infos.push(new CertInfo(entry.cert, entry.subject));
        }
      }
      let t2 = ChromeUtils.now();
      record.parseMs = t2 - t1;
      record.count = infos.length;

      const certStorage = Cc["@mozilla.org/security/certstorage;1"].getService(
        Ci.nsICertStorage
      );
      record.done = new Promise(resolve => {
        let timer = null;
        const settle = (rv, why) => {
          if (timer) {
            lazy.clearTimeout(timer);
            timer = null;
          }
          if (record.result === "") {
            record.result = rv;
            record.doneMs = ChromeUtils.now() - t2;
            if (why) {
              console.error("StealthIntermediates: " + why);
            }
          }
          resolve(record.result);
        };
        timer = lazy.setTimeout(
          () => settle("error: timeout", "addCerts did not call back"),
          WRITE_TIMEOUT_MS
        );
        try {
          certStorage.addCerts(infos, rv => {
            settle(
              rv,
              rv != Cr.NS_OK ? "addCerts failed: " + rv : ""
            );
          });
        } catch (e) {
          settle("error: " + e, "" + e);
        }
      });
      record.addCertsMs = ChromeUtils.now() - t2;
    } catch (e) {
      record.result = "error: " + e;
      console.error("StealthIntermediates: " + e);
    }
    return record;
  },
};

// The component the profile-after-change category creates (components.conf):
// the list is in cert_storage before any window, so before any verification a
// page can cause.
export function StealthIntermediatesStartup() {}

StealthIntermediatesStartup.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  observe(subject, topic) {
    if (topic == "profile-after-change") {
      StealthIntermediates.load();
    }
  },
};
