/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A visible pointer in the CHROME window, for watching an automated session.
 *
 * ⛔ IT IS NOT A STEALTH FEATURE AND IT IS NOT A HUMANIZE FEATURE. It draws
 * nothing the page can reach and it changes no event the page receives: it
 * exists so a person watching the monitor, or a screen recording made from
 * outside the browser, can see where the pointer is.
 *
 * ⛔ WHETHER IT IS ON IS NOT DECIDED HERE. This file reads
 * `stealthfox.showcursor` and obeys; the value is declared by
 * `invisible_core.prefs.DEFAULT_SHOW_CURSOR`, which since 2026-08-28 is true.
 * The `getBoolPref(PREF, false)` fallback below is not a competing default -
 * it answers the different question "this profile was not written by us". The
 * argument against shipping it on has not gone away and is recorded next to
 * that constant: a pointer moving on its own says "this is a bot" to anybody
 * looking at the screen.
 *
 * ⛔ IN THE CHROME DOCUMENT, NEVER IN THE PAGE. The overlay is a node in the
 * browser UI's own document, which runs in a different process from the
 * content: page JavaScript cannot see it, cannot find it with a selector,
 * cannot hit it with `elementFromPoint`, and cannot photograph it - it is
 * absent from `page.screenshot()`, which is a consequence and not a
 * limitation. Drawing it in the page's document would be a DOM node a site can
 * enumerate, which is a tell and breaks rule 12.
 *
 * ⛔ WHY IT CAN WORK AT ALL. Juggler dispatches the mouse INTO THE CHROME
 * WINDOW: `Page.dispatchMouseEvent` takes the `<browser>` bounding box and
 * calls `win.windowUtils.jugglerSendMouseEvent(...)` with page coordinates
 * offset into chrome space (`protocol/PageHandler.js`). So a `mousemove`
 * listener on the chrome document sees automated movement in exactly the
 * coordinates this overlay needs. ⛔ THAT IS THE LOAD-BEARING ASSUMPTION of
 * this file and it is VERIFIED, not assumed: `tests/gates/chrome_cursor.py`
 * drives `page.mouse.move` and reads the counter this object keeps.
 *
 * ⛔ AND IT IS OURS, NOT MOZILLA'S. Camoufox does this by patching
 * `browser/base/content/browser-init.js`, a Mozilla file, which is a conflict
 * to resolve at every major. Everything here lives under `juggler/`, which we
 * already own, and the only foreign line is two in `TargetRegistry.js`.
 */

const PREF_ENABLED = 'stealthfox.showcursor';

const LOGO_INK = '%230C1824';      // the logo's outline navy, URL-encoded
const LOGO_GREEN = '108, 216, 48';
const GLOW_IDLE = `rgba(${LOGO_GREEN}, .95)`;
const GLOW_IDLE_SOFT = `rgba(${LOGO_GREEN}, .6)`;
const GLOW_PRESSED = `rgba(${LOGO_GREEN}, 1)`;
const GLOW_PRESSED_SOFT = `rgba(${LOGO_GREEN}, .75)`;
const RING_COLOUR = `rgba(${LOGO_GREEN}, .9)`;
//: The artwork, in viewBox units. The real Windows arrow is 12x19.
const ARROW_ART_W = 12;
const ARROW_ART_H = 19;
//: Room kept around it so the stroke is not clipped: the outline is 1.3 wide
//: and half of it falls outside the path.
const ARROW_PAD = 1;
//: How many pixels one viewBox unit is drawn as. Larger than 1 so the pointer
//: stays legible on a high-DPI screen, which is what a person watching is
//: looking at.
const ARROW_SCALE = 1.4;
const ARROW_W = (ARROW_ART_W + 2 * ARROW_PAD) * ARROW_SCALE;
const ARROW_H = (ARROW_ART_H + 2 * ARROW_PAD) * ARROW_SCALE;
const ARROW_OFFSET = ARROW_PAD * ARROW_SCALE;

/**
 * The arrow as a data URI.
 *
 * ⛔ URL-ENCODED BY HAND, and the `#` is why. A `data:image/svg+xml` inside a
 * CSS `url()` is parsed as a URL, so a raw `#` in a colour starts a fragment
 * and silently truncates the SVG - the rule still applies, the background just
 * never paints, and the cursor is invisible with no error anywhere. `%23` is
 * the fix; `<` and `>` are left alone because they are legal in a quoted
 * url() and encoding them costs readability for nothing.
 */
function _arrowSvg() {
  return 'data:image/svg+xml;utf8,' +
      `<svg xmlns='http://www.w3.org/2000/svg' width='${ARROW_W}'` +
      ` height='${ARROW_H}'` +
      ` viewBox='${-ARROW_PAD} ${-ARROW_PAD}` +
      ` ${ARROW_ART_W + 2 * ARROW_PAD} ${ARROW_ART_H + 2 * ARROW_PAD}'>` +
      `<path d='M0 0 L0 16.6 L4.1 12.7 L6.7 18.6 L9.4 17.4 L6.8 11.6 L11.7 11.6 Z'` +
      ` fill='%23FFFFFF' stroke='${LOGO_INK}' stroke-width='1.3'` +
      ` stroke-linejoin='round'/></svg>`;
}
const MAX_PENDING_RINGS = 3;

const PREF_MOVES = 'stealthfox.showcursor.moves';
const PREF_OVERLAYS = 'stealthfox.showcursor.overlays';
const NODE_ID = '__stealth_cursor__';

/**
 * ⛔ ONE OVERLAY PER CHROME WINDOW, NOT PER PAGE, and the difference is
 * reachable rather than theoretical. `TargetRegistry.newPage` opens a window
 * of its own for every page, so most of the time the two are the same thing -
 * but a `noopener` popup opened by page JavaScript lands as a SECOND TAB IN
 * THE SAME WINDOW, and `TargetRegistry.js` says so in its own comment. With an
 * instance per `PageTarget` that window would then carry two listeners doing
 * two style writes on every mouse event, and two `<div>` elements sharing one
 * id.
 *
 * The dot is a property of the WINDOW - it is drawn in the window's document
 * and positioned in the window's coordinates - so the window is where it has
 * to be owned. A refcount rather than a plain cache, because the second tab
 * closing must not take the overlay away from the first.
 */
const _perWindow = new WeakMap();
let _live = 0;
let _peak = 0;

export class StealthCursor {
  /** The overlay for this chrome window, created once and shared. */
  static forWindow(win) {
    let entry = _perWindow.get(win);
    if (!entry) {
      entry = {cursor: new StealthCursor(win), refs: 0};
      _perWindow.set(win, entry);
    }
    entry.refs++;
    return entry.cursor;
  }

  /** One holder is done with it. The last one out disposes it. */
  static releaseWindow(win) {
    const entry = _perWindow.get(win);
    if (!entry)
      return;
    if (--entry.refs > 0)
      return;
    _perWindow.delete(win);
    entry.cursor.dispose();
  }

  static _publishCount(delta) {
    _live += delta;
    if (_live < 0)
      _live = 0;
    if (_live > _peak) {
      _peak = _live;
      try { Services.prefs.setIntPref(PREF_OVERLAYS, _peak); }
      catch (e) {}
    }
  }

  constructor(win) {
    this._win = win;
    this._dot = null;
    this._style = null;
    //: L'ultima posizione vista, e il frame gia' chiesto. NESSUN gestore di
    //: input tocca il DOM: registrano numeri, e disegna `_paint` sul frame.
    //: Vedi il commento sopra `_schedule`.
    this._pendingX = 0;
    this._pendingY = 0;
    this._pendingVisible = false;
    this._pendingPressed = false;
    this._sawDown = false;
    //: Quanti anelli spawnare al prossimo frame. Un contatore, non un nodo:
    //: creare l'elemento qui rimetterebbe nel gestore esattamente il lavoro
    //: che questa modifica toglie.
    this._pendingRings = 0;
    this._frame = 0;
    this._listening = false;
    this.moves = 0;
    this._published = 0;
    this._counted = true;
    StealthCursor._publishCount(1);

    this._onMove = this._onMove.bind(this);
    this._onDown = this._onDown.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onLeave = this._onLeave.bind(this);
    this._onPrefChanged = this._onPrefChanged.bind(this);

    Services.prefs.addObserver(PREF_ENABLED, this._onPrefChanged);
    if (this._wanted())
      this._enable();
  }

  _wanted() {
    try { return Services.prefs.getBoolPref(PREF_ENABLED, false); }
    catch (e) { return false; }
  }

  _stepMs() {
    try { return Services.prefs.getIntPref('stealthfox.humanize.stepMs', 10); }
    catch (e) { return 10; }
  }

  _onPrefChanged() {
    if (this._wanted())
      this._enable();
    else
      this._disable();
  }

  _enable() {
    if (this._listening)
      return;
    this._build();
    const opts = {passive: true, capture: false};
    this._win.addEventListener('mousemove', this._onMove, opts);
    this._win.addEventListener('mousedown', this._onDown, opts);
    this._win.addEventListener('mouseup', this._onUp, opts);
    this._win.addEventListener('mouseleave', this._onLeave, opts);
    this._listening = true;
  }

  _disable() {
    if (this._listening) {
      const opts = {capture: false};
      this._win.removeEventListener('mousemove', this._onMove, opts);
      this._win.removeEventListener('mousedown', this._onDown, opts);
      this._win.removeEventListener('mouseup', this._onUp, opts);
      this._win.removeEventListener('mouseleave', this._onLeave, opts);
      this._listening = false;
    }
    if (this._dot) {
      this._dot.remove();
      this._dot = null;
    }
    if (this._frame) {
      try { this._win.cancelAnimationFrame(this._frame); } catch (e) {}
      this._frame = 0;
    }
    if (this._style) {
      this._style.remove();
      this._style = null;
    }
  }

  _build() {
    if (this._dot)
      return;
    const doc = this._win.document;
    const root = doc.documentElement;
    if (!root)
      return;

    this._style = doc.createElement('style');
    this._style.textContent = `
      #${NODE_ID} {
        position: fixed; top: 0; left: 0;
        width: ${ARROW_W}px; height: ${ARROW_H}px;
        margin: ${-ARROW_OFFSET}px 0 0 ${-ARROW_OFFSET}px;
        background: url("${_arrowSvg()}") no-repeat 0 0 / 100% 100%;
        filter: drop-shadow(0 0 5px ${GLOW_IDLE})
                drop-shadow(0 0 13px ${GLOW_IDLE_SOFT});
        pointer-events: none;
        z-index: 2147483647;
        opacity: 1;
        will-change: transform;
        transition: transform ${this._stepMs()}ms linear, opacity 120ms linear;
      }
      #${NODE_ID}.pressed {
        filter: drop-shadow(0 0 6px ${GLOW_PRESSED})
                drop-shadow(0 0 20px ${GLOW_PRESSED_SOFT});
      }
      #${NODE_ID} > .ring {
        position: absolute; top: 0; left: 0;
        width: 14px; height: 14px; margin: -7px 0 0 -7px;
        border-radius: 50%;
        border: 2px solid ${RING_COLOUR};
        pointer-events: none;
        animation: __stealth_cursor_ring__ 380ms ease-out forwards;
      }
      @keyframes __stealth_cursor_ring__ {
        from { transform: scale(1);   opacity: .9; }
        to   { transform: scale(3.4); opacity: 0;  }
      }
    `;
    root.appendChild(this._style);

    this._dot = doc.createElement('div');
    this._dot.id = NODE_ID;
    root.appendChild(this._dot);
  }

  _onMove(event) {
    this.moves++;
    if (!this._published) {
      this._published = 1;
      this._publishMoves();
    }
    if (!this._dot)
      return;
    this._pendingX = event.clientX;
    this._pendingY = event.clientY;
    this._pendingVisible = true;
    this._schedule();
  }

  _schedule() {
    if (this._frame)
      return;
    this._frame = this._win.requestAnimationFrame(() => {
      this._frame = 0;
      this._paint();
    });
  }

  _paint() {
    if (!this._dot)
      return;
    this._dot.style.opacity = this._pendingVisible ? '1' : '0';
    this._dot.style.transform =
        `translate3d(${this._pendingX}px, ${this._pendingY}px, 0)`;
    const press = this._pendingPressed || this._sawDown;
    this._dot.classList.toggle('pressed', press);
    while (this._pendingRings > 0) {
      this._pendingRings--;
      const ring = this._win.document.createElement('div');
      ring.className = 'ring';
      ring.addEventListener('animationend', () => ring.remove(), {once: true});
      this._dot.appendChild(ring);
    }
    if (this._sawDown) {
      this._sawDown = false;
      if (!this._pendingPressed)
        this._schedule();
    }
  }

  _publishMoves() {
    try { Services.prefs.setIntPref(PREF_MOVES, this.moves); }
    catch (e) {}
  }

  _onDown(event) {
    this._pendingPressed = true;
    this._sawDown = true;
    if (this._pendingRings < MAX_PENDING_RINGS)
      this._pendingRings++;
    this._schedule();
  }

  _onUp(event) {
    this._pendingPressed = false;
    this._schedule();
  }

  _onLeave(event) {
    this._pendingVisible = false;
    this._schedule();
  }

  dispose() {
    try { Services.prefs.removeObserver(PREF_ENABLED, this._onPrefChanged); }
    catch (e) {}
    this._disable();
    this._publishMoves();
    if (this._counted) {
      this._counted = false;
      StealthCursor._publishCount(-1);
    }
    this._win = null;
  }
}

