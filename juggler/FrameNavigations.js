/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Which navigation each frame of a page is in, as the parent process tells it.
//
// The navigations of a frame were reported by the content process that held it, from its own state. A navigation
// that changes the process (a frame going to another site, once sites are isolated) starts in one process and
// commits in another, and the process that commits cannot know the id the navigation was started with. The parent
// sees both ends: the load identifier of every document request, and the cut of the last one (NetworkObserver,
// `navigationId` of the request, only for NS_BINDING_ABORTED), the document appearing in whichever process holds the frame
// and the load ending with an error (both relayed by the content process that holds the frame, over the 'frames'
// namespace, in the order they happen: it tells every end that is not a cut, and the cuts too, with the filter of the
// process swap's own). Two voices for one end are one. One registry per PageHandler, a frame at a time: started, then
// committed or aborted, each id once.
//
// ⛔ THE PARENT HEARS ITS OWN NETWORK AT ONCE, AND THE CONTENT PROCESS LATE. A process that takes a new document starts its
// channel to the parent again (SimpleChannel.bindToActor) and keeps what it says until the parent's READY, while the
// NetworkObserver tells what it sees as it sees it. So the cut of a document request whose response had begun can come
// before the document that response made: measured on the wrapper's e2e (PR #534, run 44655615997), a goto whose document
// committed in another process and moved itself from an inline script was told aborted (NS_BINDING_ABORTED), and its
// document, which came after with no id, was told as a document no navigation made. Such a cut is held
// (`onDocumentRequestFailed` answers true) until a barrier sent through the channel of the process that holds the frame
// comes back (`onCutConfirmed`): what that process had to say before has arrived by then. And a document with no id is
// known by its address as the one of a navigation that was replaced before it was heard from, not only of the one in
// flight.
//
// ⛔ A CUT THE CONTENT PROCESS TELLS IS ITS OWN, NOT ALWAYS THE NAVIGATION'S. The docShell of the document being left holds a
// stand-in for the request (DocumentChannelChild), and a page that navigates itself stops it there (nsDocShell::Stop, from
// its own location.replace): that process sees NS_BINDING_ABORTED. But the request is the parent's, and once the parent has
// sent it on to the process that takes the document (DocumentLoadListener::Cancel returns at once when its open promise is
// resolved), that stop cuts nothing: the navigation commits. Measured on the wrapper's e2e
// (`test_a_read_right_after_goto_answers[/r50]`, gate 44862426341): the response of our goto had begun in the parent, which
// switched the browsing context and carried the navigation on (aContinueNavigating), while the page's own timer stopped the
// stand-in in the content process; goto raised NS_BINDING_ABORTED for a document that loaded. So NS_BINDING_ABORTED from
// the content process ends a navigation only when the parent never saw its document request. When it did, and that request
// has not ended (`_carried`), its own end decides: its cut (onDocumentRequestFailed), its document, or any other end without
// a document (onDocumentRequestEnded), held behind the barrier like a cut, then the abort the content process told.
//
// `emit(name, payload, frameId)`: 'navigationstarted' {frameId, navigationId}, 'navigationcommitted'
// {frameId, navigationId, url, name}, 'navigationaborted' {frameId, navigationId, errorText},
// 'initialloadfailed' {frameId}: a frame that never committed a document of its own was refused its first load.

// A diagnostic trace, off unless the parent's environment asks for it (Trace.js). Tolerant: a file loaded
// where there is no Gecko (a node test) traces nothing.
let traceNavigations = () => {};
try {
  const traceNavigationsModule = ChromeUtils.importESModule('resource://gre/modules/juggler/Trace.js');
  if (traceNavigationsModule && typeof traceNavigationsModule.trace === 'function')
    traceNavigations = (...args) => { try { traceNavigationsModule.trace(...args); } catch (e) {} };
} catch (e) {}

// An address without its fragment: the one a request goes by, whatever the document's location adds.
function withoutFragment(url) {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

// How many ended navigations of a frame are remembered, so a late request of an ended navigation is not a new one.
const ENDED_REMEMBERED = 8;

export class FrameNavigations {
  constructor(emit) {
    // What the registry tells is traced as it goes out.
    this._emit = (name, payload, frameId) => {
      traceNavigations('navigations', 'emit ' + name, payload);
      return emit(name, payload, frameId);
    };
    this._pending = new Map();      // frameId -> {navigationId, url}
    this._committed = new Map();    // frameId -> navigationId
    this._ended = new Map();        // frameId -> [navigationId] (committed, aborted or replaced), the last few
    this._replaced = new Map();     // frameId -> Map(navigationId -> its addresses): replaced by a newer navigation before they were heard from
    this._cuts = new Map();         // frameId -> Map(navigationId -> errorText): cuts held until their barrier comes back
    this._carried = new Map();      // frameId -> Map(navigationId -> errorText or null): document requests the parent still carries, with the cut the content told meanwhile
    this._initialDone = new Set();  // frameIds that have had a navigation end
    this._restoredDocuments = 0;
    this._documents = new Map();    // frameId -> {navigationId, url, name}: the last document told committed
  }

  pendingNavigationId(frameId) {
    const pending = this._pending.get(frameId);
    return pending ? pending.navigationId : undefined;
  }

  // The frame's first navigation is in flight: no document of its own told yet, and its first load not refused. In the
  // page, the `load` of a document above it comes after this frame's first document (PageHandler holds it till then).
  waitsForItsFirstDocument(frameId) {
    return this._pending.has(frameId) && !this._initialDone.has(frameId);
  }

  lastCommittedNavigationId(frameId) {
    return this._committed.has(frameId) ? this._committed.get(frameId) : null;
  }

  // A document request of the navigation, seen in the parent. Before the request itself is forwarded, so
  // the navigation starts before its first request.
  onDocumentRequest(frameId, navigationId, url) {
    traceNavigations('navigations', 'onDocumentRequest', {frameId, navigationId, url});
    this._start(frameId, navigationId, url);
    if (!navigationId || !this._inFlight(frameId, navigationId))
      return;
    let carried = this._carried.get(frameId);
    if (!carried) {
      carried = new Map();
      this._carried.set(frameId, carried);
    }
    if (!carried.has(navigationId))
      carried.set(navigationId, null);
    while (carried.size > ENDED_REMEMBERED)
      carried.delete(carried.keys().next().value);
  }

  _inFlight(frameId, navigationId) {
    const pending = this._pending.get(frameId);
    const replaced = this._replaced.get(frameId);
    return !!(pending && pending.navigationId === navigationId) || !!(replaced && replaced.has(navigationId));
  }

  _uncarry(frameId, navigationId) {
    const carried = this._carried.get(frameId);
    if (!carried)
      return;
    carried.delete(navigationId);
    if (!carried.size)
      this._carried.delete(frameId);
  }

  // The load was begun in the content process of the frame, whether or not a request follows (about:blank,
  // data:, a navigation the network never sees).
  onContentNavigationStarted(frameId, navigationId) {
    traceNavigations('navigations', 'onContentNavigationStarted', {frameId, navigationId});
    this._start(frameId, navigationId, undefined);
  }

  _start(frameId, navigationId, url) {
    if (!navigationId) {
      traceNavigations('navigations', 'start dropped: no navigation id', {frameId, url});
      return;
    }
    const pending = this._pending.get(frameId);
    if (pending && pending.navigationId === navigationId) {
      if (url) {
        pending.url = pending.url || url;
        pending.urls.add(withoutFragment(url));   // a redirect hop of the same navigation
      }
      return;
    }
    if (this._committed.get(frameId) === navigationId || this._hasEnded(frameId, navigationId)) {
      traceNavigations('navigations', 'start dropped: the navigation already ended', {frameId, navigationId, committed: this._committed.get(frameId) === navigationId});
      return;
    }
    // A navigation replaces the one in flight without ending it, as it always did: its document or its abort can
    // still come, and is told under its own id.
    if (pending) {
      this._remember(frameId, pending.navigationId);
      let replaced = this._replaced.get(frameId);
      if (!replaced) {
        replaced = new Map();
        this._replaced.set(frameId, replaced);
      }
      // With its addresses: its document may still come with no id (the process that commits a navigation that changed
      // process does not know it), and is known by them.
      replaced.set(pending.navigationId, pending.urls);
      // Bounded like the list of ended navigations: a frame that never hears from the ones it replaced (the main
      // frame is never forgotten) does not keep them for ever.
      while (replaced.size > ENDED_REMEMBERED)
        replaced.delete(replaced.keys().next().value);
    }
    this._pending.set(frameId, {navigationId, url, urls: new Set(url ? [withoutFragment(url)] : [])});
    this._emit('navigationstarted', {frameId, navigationId}, frameId);
  }

  // A document appeared in the frame, in whichever process holds it. It commits the navigation in flight; a
  // document with none (the first about:blank of an iframe, document.open) commits nothing.
  //
  // `navigationId`: the navigation the process that holds the frame had in flight when the document appeared, if it
  // had one. The document is that navigation's even if the parent has since started another one for the frame (a page
  // that navigates from its first script: the parent sees the new request before it hears of the document), so it is
  // committed under its own id and the navigation in flight stays.
  onDocumentInserted(frameId, url, name, navigationId) {
    const pending = this._pending.get(frameId);
    traceNavigations('navigations', 'onDocumentInserted', {frameId, url, name, navigationId, pendingNavigationId: pending ? pending.navigationId : null});
    if (navigationId && (!pending || pending.navigationId !== navigationId)) {
      const replaced = this._replaced.get(frameId);
      // A navigation that was told aborted and whose document appeared all the same (the page's own location.replace,
      // cancelled by the client's navigation and restarted by the engine under the same load identifier): the frame HAS
      // this document, and the client is told so, or it waits for ever for a document no navigation of its own made.
      const returned = this._hasEnded(frameId, navigationId) && this._committed.get(frameId) !== navigationId;
      if ((replaced && replaced.delete(navigationId)) || returned) {
        this._committed.set(frameId, navigationId);
        this._initialDone.add(frameId);
        this._tellCommit(frameId, navigationId, url, name);
      } else {
        traceNavigations('navigations', 'document dropped: its navigation is not pending, replaced or returned', {frameId, url, navigationId});
      }
      return;
    }
    // No navigation of the process's own to go by, and an address the navigation in flight did not go by (or none in
    // flight): the document is the one of a navigation replaced before it was heard from, if it went by that address.
    // Its commit had waited in the channel of the process that holds the frame while the parent saw the newer request.
    if (!navigationId && url && (!pending || (pending.urls.size && !pending.urls.has(withoutFragment(url))))) {
      const theirs = this._replacedAt(frameId, url);
      if (theirs !== undefined) {
        this._replaced.get(frameId).delete(theirs);
        this._committed.set(frameId, theirs);
        this._initialDone.add(frameId);
        this._tellCommit(frameId, theirs, url, name);
        return;
      }
    }
    if (!pending) {
      traceNavigations('navigations', 'document dropped: no navigation in flight', {frameId, url, navigationId});
      return;
    }
    // No navigation of the process's own to go by: the document is the pending navigation's if it is at an address
    // that navigation went by. A document.open() writes a root element into the document that stays, which is not
    // the one the navigation in flight is loading.
    if (!navigationId && pending.urls.size && url && !pending.urls.has(withoutFragment(url))) {
      traceNavigations('navigations', 'document dropped: not an address of the navigation in flight', {frameId, url, pendingNavigationId: pending.navigationId, urls: [...pending.urls]});
      return;
    }
    this._pending.delete(frameId);
    this._committed.set(frameId, pending.navigationId);
    this._remember(frameId, pending.navigationId);
    this._initialDone.add(frameId);
    this._tellCommit(frameId, pending.navigationId, url, name);
  }

  // The newest navigation of the frame replaced before it was heard from that went by `url`, or undefined.
  _replacedAt(frameId, url) {
    const replaced = this._replaced.get(frameId);
    if (!replaced)
      return undefined;
    let theirs;
    for (const [navigationId, urls] of replaced) {
      if (urls.has(withoutFragment(url)))
        theirs = navigationId;
    }
    return theirs;
  }

  _tellCommit(frameId, navigationId, url, name) {
    if (navigationId)
      this._uncarry(frameId, navigationId);
    this._documents.set(frameId, {navigationId, url, name});
    this._emit('navigationcommitted', {frameId, navigationId, url, name}, frameId);
  }

  // The commit of a document was told to the client with another name than the one the registry had: the name of the
  // <iframe> of a frame in a process of its own is asked of its embedder, which is where the element is. What the
  // client was told is what the frame says again when it comes back from the cache, not the name the registry was
  // given, which a process that holds no <iframe> element leaves empty. Only the document that was told: a later one
  // keeps its own.
  onCommitNamed(frameId, navigationId, url, name) {
    const document = this._documents.get(frameId);
    if (document && document.navigationId === navigationId && document.url === url)
      document.name = name;
  }

  // The last document told committed in the frame, or undefined: what a frame says again when it comes back with the
  // page from the back-forward cache, the client having dropped it.
  lastDocument(frameId) {
    return this._documents.get(frameId);
  }

  // The address of the document changed without a new document (pushState, a hash): the next time it is said, it is this.
  onSameDocumentNavigation(frameId, url) {
    const document = this._documents.get(frameId);
    if (document)
      document.url = url;
  }

  // A frame as its process has it, said again: a page the client attaches to as it is, the frames of a document
  // restored from the cache (the client dropped them), the first document of a frame that no navigation made. A
  // document already committed is committed again, with the id the process knows; a navigation
  // in flight is started.
  onFrameKnown(frameId, {url, name, navigationId, pendingNavigationId}) {
    traceNavigations('navigations', 'onFrameKnown', {frameId, url, name, navigationId, pendingNavigationId});
    if (url) {
      // The id the process gives, and none otherwise: a document that no navigation of ours made (the about:blank of
      // a tree that is born, the one a script navigates to) must not borrow the id of the one it replaces.
      const known = navigationId || undefined;
      if (known)
        this._committed.set(frameId, known);
      this._initialDone.add(frameId);
      this._tellCommit(frameId, known, url, name);
    }
    if (pendingNavigationId && !this._pending.has(frameId))
      this._start(frameId, pendingNavigationId, undefined);
  }

  // The main frame's document came back from the back-forward cache. A restore has no load identifier to borrow:
  // the id only has to be new, and it is new for the whole page because it is counted here.
  onDocumentRestored(frameId, url, name) {
    const navigationId = 'nav-bfcache-' + (++this._restoredDocuments);
    const pending = this._pending.get(frameId);
    if (pending)
      this._remember(frameId, pending.navigationId);
    this._pending.set(frameId, {navigationId, url, urls: new Set()});
    this._emit('navigationstarted', {frameId, navigationId}, frameId);
    this.onDocumentInserted(frameId, url, name);
  }


  // The last document request of a navigation was cut (NS_BINDING_ABORTED), as the parent sees it (the NetworkObserver, where
  // the request lives, whichever process the document was being born in and whatever the docShell it left does meanwhile).
  // It is the end of the navigation, told with its own id: in flight, or replaced by a newer one before it was heard from,
  // and not committed. A navigation that already ended (committed, aborted) says nothing more. A redirect is no failure:
  // only the end of the LAST request of the navigation comes here. Another error of the request does not: the content
  // process tells it, in order with the documents it inserts.
  //
  // `responded`: the response of the request had begun. Then a document may already exist in the process that holds the
  // frame, its commit still waiting in that process's channel (the head of this file): the cut is held, and the answer is
  // true, for the caller to send the barrier and call `onCutConfirmed` when it comes back, or when it cannot be delivered.
  // Before any response no process can have a document of the request: the cut ends the navigation at once.
  onDocumentRequestFailed(frameId, navigationId, errorText, responded = false) {
    traceNavigations('navigations', 'onDocumentRequestFailed', {frameId, navigationId, errorText, responded});
    this._uncarry(frameId, navigationId);
    if (!responded) {
      this._abort(frameId, navigationId, errorText);
      return false;
    }
    const pending = this._pending.get(frameId);
    const replaced = this._replaced.get(frameId);
    if (!(pending && pending.navigationId === navigationId) && !(replaced && replaced.has(navigationId))) {
      traceNavigations('navigations', 'cut not held: the navigation is not pending or replaced', {frameId, navigationId});
      return false;   // committed or ended already: nothing to hold
    }
    let cuts = this._cuts.get(frameId);
    if (!cuts) {
      cuts = new Map();
      this._cuts.set(frameId, cuts);
    }
    cuts.set(navigationId, errorText);
    return true;
  }

  // The last document request of a navigation ended in the parent otherwise than cut: it finished, or failed with another
  // error. If the content process told a cut of this navigation while the parent carried the request (onNavigationAborted),
  // no document of it may come but one already on its way: the cut is held like the parent's own, and the answer is true,
  // for the caller to send the barrier and call `onCutConfirmed`. Otherwise the end says nothing: the content process tells
  // the other errors, in order with its documents.
  onDocumentRequestEnded(frameId, navigationId) {
    const carried = this._carried.get(frameId);
    const told = carried ? carried.get(navigationId) : undefined;
    traceNavigations('navigations', 'onDocumentRequestEnded', {frameId, navigationId, contentCut: told || null});
    this._uncarry(frameId, navigationId);
    if (!told || !this._inFlight(frameId, navigationId))
      return false;
    let cuts = this._cuts.get(frameId);
    if (!cuts) {
      cuts = new Map();
      this._cuts.set(frameId, cuts);
    }
    cuts.set(navigationId, told);
    return true;
  }

  // The barrier of a held cut came back, or could not be delivered: what the process that holds the frame had to say
  // before it has arrived. A navigation whose document came meanwhile has committed and is not ended; any other ends
  // with the cut.
  onCutConfirmed(frameId, navigationId) {
    const cuts = this._cuts.get(frameId);
    traceNavigations('navigations', 'onCutConfirmed', {frameId, navigationId, held: !!(cuts && cuts.has(navigationId))});
    if (!cuts || !cuts.has(navigationId))
      return;
    const errorText = cuts.get(navigationId);
    cuts.delete(navigationId);
    // The frame's entry goes with its last held cut, not before: another cut of the frame may still wait for its barrier.
    if (!cuts.size)
      this._cuts.delete(frameId);
    this._abort(frameId, navigationId, errorText);
  }

  // A navigation of the frame ended in an error, as its content process saw it end: window.stop(), document.open(), a refused
  // port, a failed load. The process sees the end of the load in order with the documents it inserts, so a navigation whose
  // document came before the load was cut is already committed and is not aborted (a page that navigates from its first
  // script), and it filters the cut it makes itself when a navigation changes process (FrameTree.onStateChange). The cut of
  // a document request may also be told by the parent (onDocumentRequestFailed): whoever says an end first, the registry
  // takes it once. `errorText` is already the protocol's text.
  //
  // A cut (NS_BINDING_ABORTED) of a navigation whose document request the parent still carries is not its end (the head of
  // this file): it is kept, and the end of that request decides.
  onNavigationAborted(frameId, navigationId, errorText) {
    traceNavigations('navigations', 'onNavigationAborted', {frameId, navigationId, errorText});
    const cuts = this._cuts.get(frameId);
    if (errorText === 'NS_BINDING_ABORTED' && cuts && cuts.has(navigationId)) {
      traceNavigations('navigations', 'content cut not told: a cut of the navigation is held', {frameId, navigationId});
      return;
    }
    const carried = this._carried.get(frameId);
    if (errorText === 'NS_BINDING_ABORTED' && carried && carried.has(navigationId) && this._inFlight(frameId, navigationId)) {
      traceNavigations('navigations', 'content cut not told: the parent still carries the request', {frameId, navigationId});
      carried.set(navigationId, errorText);
      return;
    }
    this._abort(frameId, navigationId, errorText);
  }

  _abort(frameId, navigationId, errorText) {
    const pending = this._pending.get(frameId);
    if (!pending || pending.navigationId !== navigationId) {
      // A navigation a newer one replaced before its abort was heard: the client still waits for the end of it.
      const replaced = this._replaced.get(frameId);
      if (replaced && replaced.delete(navigationId)) {
        this._uncarry(frameId, navigationId);
        this._emit('navigationaborted', {frameId, navigationId, errorText}, frameId);
      } else {
        traceNavigations('navigations', 'abort dropped: the navigation is not pending or replaced', {frameId, navigationId, errorText, pendingNavigationId: pending ? pending.navigationId : null});
      }
      return;
    }
    this._end(frameId, pending, errorText);
  }

  _end(frameId, pending, errorText) {
    this._pending.delete(frameId);
    this._uncarry(frameId, pending.navigationId);
    this._remember(frameId, pending.navigationId);
    this._emit('navigationaborted', {frameId, navigationId: pending.navigationId, errorText}, frameId);
    if (!this._initialDone.has(frameId)) {
      this._initialDone.add(frameId);
      // A frame that was refused its first load still ends the way a loaded frame does, or whoever waits for its
      // load waits for good.
      if (!frameId.startsWith('mainframe-'))
        this._emit('initialloadfailed', {frameId}, frameId);
    }
  }

  _remember(frameId, navigationId) {
    let ended = this._ended.get(frameId);
    if (!ended) {
      ended = [];
      this._ended.set(frameId, ended);
    }
    ended.push(navigationId);
    if (ended.length > ENDED_REMEMBERED)
      ended.shift();
  }

  _hasEnded(frameId, navigationId) {
    const ended = this._ended.get(frameId);
    return !!ended && ended.includes(navigationId);
  }

  // A frame that is gone keeps nothing.
  forget(frameId) {
    traceNavigations('navigations', 'forget', {frameId, pendingNavigationId: this.pendingNavigationId(frameId)});
    this._pending.delete(frameId);
    this._committed.delete(frameId);
    this._ended.delete(frameId);
    this._replaced.delete(frameId);
    this._cuts.delete(frameId);
    this._carried.delete(frameId);
    this._documents.delete(frameId);
    this._initialDone.delete(frameId);
  }
}
