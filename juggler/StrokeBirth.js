/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Stealthfox [B299] [B301]: the births of the events of one stroke (one type(), one mouse path, one click) of a
// client that sends every command at its own planned instant and does not wait for the replies, and the order in which
// the input of one page is delivered.
//
// Under load the engine's reply, and the delivery itself, come late. The client no longer waits, so what reaches the
// page must not slip with the engine: the events of a stroke are born where the client's own plan puts them, however
// late they are delivered. There is no shared clock with the client (it may be on another machine): the plan comes as
// offsets, `at` (ms from the start of the stroke) on each command, with the `stroke` they belong to and the session's
// drawn system `latency`.
//
//   - the FIRST event of a stroke fixes the anchor: it is born `latency` ms before its delivery, as today;
//   - the event i is born at anchor + at_i;
//   - delivered late (birth_i + latency has passed): it goes out at once and declares now - birth_i, so the page reads
//     the birth of the plan, the handler comes late and the time the page reads does not;
//   - delivered early: it waits until birth_i + latency, and is then born at birth_i whatever the timer did (a timer
//     that came late only moves the handler: the latency is read again when the event is handed over);
//   - an event that would wait more than MAX_EARLY_WAIT_MS (a mistaken `at`) goes out at that deadline, born
//     `latency` ms before it, so a birth is never left in the future;
//   - a birth is never in the future, never before the previous birth of the page, and a new stroke never starts
//     before the last birth of the page.
//
// ORDER. An early event waits, so a later command could overtake it. Every input command of the page in this process
// (tagged with a stroke or not: the keys, insertText, the mouse, the wheel) enters the page's gate on arrival, in the
// order of arrival, and passes it only after the one before it has passed: a keyup never overtakes its waiting keydown,
// a mousemove never the one before it, a new stroke never the tail of the previous one, an untagged insertText never a
// key that waits. The caller releases its ticket (release(), in a finally) as soon as it is past the gate, before it
// hands the event over and before any wait for an answer, so the gate holds nothing for a reply.
//
// Without `stroke` and `at` (a client that sends and waits) a command only keeps its place in the order; when nothing
// before it waits, mustWait() is false and it goes on in the turn it arrived, as before.
//
// KNOWN LIMIT: the state is per page AND per process, as the order of births in C++ is (StealthInputEventBirth.h):
// the keys and insertText are delivered by the content process, the mouse and the wheel by the parent. They have two
// gates, as they had two `sLastBorn` since firefox-64. A click may therefore be born a few ms before a key that was
// delivered just before it only when the two fall within the system latency (30 ms at most), which a human plan does
// not produce. No state is shared across processes.
//
// One instance per top-level page and per process. Only the current stroke is kept: a new stroke replaces it, and a
// ticket drops its predecessor when it is released, so the memory does not grow.

// The longest an event waits for its instant. An event is early by the jitter of the client's timer; a wait of seconds
// is a mistaken `at`, and the chain of inputs of the page must not stand still for it.
const MAX_EARLY_WAIT_MS = 10000;

export class StrokeBirth {
  /**
   * @param {{now: function(): number, sleep: function(number): Promise}} clock
   *   now(): a monotonic clock, in ms. sleep(ms): resolves after ms, on a timer of the chrome (never of a page).
   */
  constructor({now, sleep}) {
    this._now = now;
    this._sleep = sleep;
    this._stroke = undefined;
    this._anchor = 0;
    this._last = -Infinity;       // the last birth planned for this page, whatever the stroke
    this._settled = -Infinity;    // the last birth of an event that has gone out
    this._tail = null;            // the last ticket entered
  }

  /**
   * A command arrives: it takes its place in the order of the page, and, when it carries `stroke` and a usable `at`,
   * its birth. Always a ticket. Call it before the first await of the command.
   */
  enter({stroke, at, latency} = {}) {
    const tagged = stroke !== undefined && stroke !== null && typeof at === 'number' && Number.isFinite(at);
    let birth = 0;
    let systemLatency = 0;
    if (tagged) {
      systemLatency = typeof latency === 'number' && Number.isFinite(latency) && latency > 0 ? latency : 0;
      const offset = at > 0 ? at : 0;
      if (stroke !== this._stroke) {
        // A new stroke: the first event is born `latency` before its delivery, and never before the last birth.
        this._stroke = stroke;
        this._anchor = Math.max(this._now() - systemLatency, this._last) - offset;
      }
      // Never before the previous birth of the page. (Never in the future either: an event that is early waits for
      // birth + latency in due(), and latency() is never negative.)
      birth = Math.max(this._anchor + offset, this._last);
      this._last = birth;
    }
    const ticket = new StrokeTicket(this, tagged, birth, systemLatency, this._tail);
    this._tail = ticket;
    return ticket;
  }
}

class StrokeTicket {
  constructor(owner, tagged, birth, systemLatency, previous) {
    this._owner = owner;
    this.tagged = tagged;
    this._birth = birth;
    this._systemLatency = systemLatency;
    this._due = birth + systemLatency;
    this._previous = previous && !previous._released ? previous : null;
    this._released = false;
    this._resolveReleased = null;
    this._whenReleased = null;
  }

  // Must the command wait before it is handed over: something before it has not passed the gate, or it is early.
  mustWait() {
    if (this._previous && !this._previous._released)
      return true;
    return this.tagged && this._due - this._owner._now() > 0;
  }

  // Resolves once the command may be handed over: the ones before it have passed, and its instant has come.
  async due() {
    while (this._previous && !this._previous._released)
      await this._previous._releasePromise();
    this._previous = null;
    if (!this.tagged)
      return;
    const owner = this._owner;
    const early = this._due - owner._now();
    if (early > 0) {
      await owner._sleep(Math.min(early, MAX_EARLY_WAIT_MS));
      if (this._due > owner._now()) {
        // The deadline came before its instant: it goes out now and is born `latency` before now, never before the
        // last event that went out. A birth is not left in the future.
        const planned = this._birth;
        this._birth = Math.max(owner._now() - this._systemLatency, owner._settled);
        if (owner._last === planned)
          owner._last = this._birth;
      }
    }
    owner._settled = Math.max(owner._settled, this._birth);
  }

  // The latency to declare to the engine NOW: the event is born at its birth, however long it took to get here.
  // Never negative: a birth is not in the future. Only for a tagged ticket.
  latency() {
    return Math.max(this._owner._now() - this._birth, 0);
  }

  // The command is past the gate: the next one may pass. Idempotent; the caller calls it in a finally.
  release() {
    if (this._released)
      return;
    this._released = true;
    this._previous = null;
    if (this._resolveReleased)
      this._resolveReleased();
  }

  _releasePromise() {
    if (!this._whenReleased)
      this._whenReleased = new Promise(resolve => { this._resolveReleased = resolve; });
    return this._whenReleased;
  }
}
