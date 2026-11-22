/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * A diagnostic trace of the channels and the navigations, OFF unless the
 * environment of the parent process has INVISIBLE_JUGGLER_TRACE_DIR=<folder>.
 *
 * It exists to read a goto that stays pending: a navigation that is told to the
 * client neither "committed" nor "aborted". What happens to the channels
 * between the parent and the content processes, and to the navigation events,
 * goes in ONE file per browser session, `juggler-<parent pid>-<ms>.jsonl`, one
 * JSON line per event: {t, pid, proc, where, what, detail}.
 *
 * - The parent opens the file once, at the first use, and flushes after every
 *   line: the trace is wanted most when the process is killed. It also writes
 *   `juggler-trace` in the shared data, which the content processes read, and
 *   listens to `juggler:trace`, the message the content processes send their
 *   events in (they cannot write a file: the sandbox forbids it). The lines that
 *   come that way carry the content process's own `t` and `pid`, and `rt`, the
 *   time they reached the parent.
 * - Off, the parent's cost is one boolean test, and a content process reads one
 *   shared-data key.
 * - It never throws at its caller, sets no pref, and the variable, the shared
 *   key and the file are not readable from a page.
 */

const TRACE_ENV = 'INVISIBLE_JUGGLER_TRACE_DIR';
const TRACE_SHARED_KEY = 'juggler-trace';
const TRACE_MESSAGE = 'juggler:trace';

// 0: not looked at yet; 1: off; 2: writing; 3: could not open the file.
let parentState = 0;
let parentStream = null;

const processKind = () => {
  try {
    return Services.appinfo.processType === Ci.nsIXULRuntime.PROCESS_TYPE_DEFAULT ? 'parent' : 'content';
  } catch (e) {
    return 'content';
  }
};

const nowMs = () => {
  try {
    if (typeof performance !== 'undefined' && performance.timeOrigin !== undefined)
      return performance.timeOrigin + performance.now();
  } catch (e) {
    // The wall clock does it.
  }
  return Date.now();
};

// What goes to a file or to a message: plain data, whatever the caller passed.
const plain = detail => {
  if (detail === undefined)
    return null;
  try {
    return JSON.parse(JSON.stringify(detail));
  } catch (e) {
    return {unserializable: String(e && e.message)};
  }
};

const stderr = text => {
  try {
    Components.utils.printStderr(text + '\n');
  } catch (e) {
    // Nothing else to tell.
  }
};

function writeLine(record) {
  // nsIOutputStream.write takes bytes: anything outside ASCII is escaped.
  const line = JSON.stringify(record).replace(/[\u0080-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n';
  parentStream.write(line, line.length);
  parentStream.flush();
}

function openParent() {
  parentState = 1;
  const dir = Services.env.get(TRACE_ENV);
  if (!dir)
    return;
  parentState = 3;
  try {
    const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    file.initWithPath(dir);
    file.append(`juggler-${Services.appinfo.processID}-${Date.now()}.jsonl`);
    const stream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
    // PR_WRONLY | PR_CREATE_FILE | PR_APPEND
    stream.init(file, 0x02 | 0x08 | 0x10, 0o644, 0);
    parentStream = stream;
    parentState = 2;
    Services.ppmm.addMessageListener(TRACE_MESSAGE, {
      receiveMessage(message) {
        try {
          const data = message.data || {};
          writeLine({t: data.t, pid: data.pid, proc: 'content', where: data.where, what: data.what, detail: data.detail, rt: nowMs()});
        } catch (e) {
          // A line that cannot be written is lost; the next one may be.
        }
      },
    });
    Services.ppmm.sharedData.set(TRACE_SHARED_KEY, true);
    Services.ppmm.sharedData.flush();
  } catch (e) {
    stderr(`WARNING: the Juggler trace in "${dir}" could not be opened: ${e && e.message}`);
  }
}

function traceInParent(where, what, detail) {
  if (parentState === 0)
    openParent();
  if (parentState !== 2)
    return;
  writeLine({t: nowMs(), pid: Services.appinfo.processID, proc: 'parent', where, what, detail: plain(detail)});
}

let contentOn = false;

function traceInContent(where, what, detail) {
  if (!contentOn) {
    // Looked at again each time while it is off: the parent writes the key after the content process may have started.
    if (Services.cpmm.sharedData.get(TRACE_SHARED_KEY) !== true)
      return;
    contentOn = true;
  }
  Services.cpmm.sendAsyncMessage(TRACE_MESSAGE, {t: nowMs(), pid: Services.appinfo.processID, where, what, detail: plain(detail)});
}

let kind = null;

export function trace(where, what, detail) {
  try {
    if (kind === null)
      kind = processKind();
    if (kind === 'parent')
      traceInParent(where, what, detail);
    else
      traceInContent(where, what, detail);
  } catch (e) {
    // A diagnostic must not become the failure it looks for.
  }
}

// The parent opens the file now, not at its first event: the shared key has to be there before a content process asks.
try {
  kind = processKind();
  if (kind === 'parent' && parentState === 0)
    openParent();
} catch (e) {
  // The first event looks again.
}
