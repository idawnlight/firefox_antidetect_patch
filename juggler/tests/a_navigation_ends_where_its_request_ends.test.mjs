// A navigation ends where its document request ends: in the parent.
//
// Measured on the engine (a second goto sent while the first one is being answered, 40 runs, trace 43776667712): the request
// of the second goto fails (NS_BINDING_ABORTED) a few milliseconds after its response, because the process swap of the first
// cancels what the docShell it leaves was loading. The content process of that docShell took the cancel for the swap's own
// (FrameTree.onStateChange, B302) and said nothing, or said it for the navigation the frame had in flight at that moment
// (the first), so the second was told neither committed nor aborted and the client waited out its timeout: 16 of 20 runs on
// Windows, 4 of 20 on Linux.
//
// The parent sees the request fail, with the load identifier of its navigation, in any process the document was being born
// in: it is the end of that navigation (FrameNavigations.onDocumentRequestFailed). The content process says what it said
// (FrameTree.onStateChange); the registry takes the end of a navigation once, whoever says it first.
//
// Run: node --test juggler/tests/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function load(file, scope, names) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^export /gm, '');
  vm.createContext(scope);
  vm.runInContext(source + `\n;globalThis.__names = { ${names.join(', ')} };`, scope);
  return scope.__names;
}

// ── the registry ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const { FrameNavigations } = load('FrameNavigations.js', {}, ['FrameNavigations']);

const MAIN = 'mainframe-1';

function registrySetup() {
  const events = [];
  const registry = new FrameNavigations((name, payload) => events.push([name, { ...payload }]));
  return { registry, events };
}

const started = (frameId, navigationId) => ['navigationstarted', { frameId, navigationId }];
const committed = (frameId, navigationId, url, name) => ['navigationcommitted', { frameId, navigationId, url, name }];
const aborted = (frameId, navigationId, errorText) => ['navigationaborted', { frameId, navigationId, errorText }];

test('the request of the second goto fails in the parent and the content says nothing: the second is aborted under its own id, then the first commits', () => {
  const { registry, events } = registrySetup();
  registry.onDocumentRequest(MAIN, 'nav-25', 'http://b.test/partial');   // goto 1, its response begun
  registry.onDocumentRequest(MAIN, 'nav-26', 'http://c.test/second');    // goto 2, in the document that is being left
  registry.onDocumentRequestFailed(MAIN, 'nav-26', 'NS_BINDING_ABORTED');
  assert.deepEqual(events, [started(MAIN, 'nav-25'), started(MAIN, 'nav-26'), aborted(MAIN, 'nav-26', 'NS_BINDING_ABORTED')]);
  assert.equal(registry.pendingNavigationId(MAIN), undefined);
  events.length = 0;
  registry.onDocumentInserted(MAIN, 'http://b.test/partial', '', 'nav-25');   // the server lets go of the first body
  assert.deepEqual(events, [committed(MAIN, 'nav-25', 'http://b.test/partial', '')]);
  assert.equal(registry.lastCommittedNavigationId(MAIN), 'nav-25');
});

test('the inverse: the request of the first fails, the second commits', () => {
  const { registry, events } = registrySetup();
  registry.onDocumentRequest(MAIN, 'nav-25', 'http://b.test/partial');
  registry.onDocumentRequest(MAIN, 'nav-26', 'http://c.test/second');
  registry.onDocumentRequestFailed(MAIN, 'nav-25', 'NS_BINDING_ABORTED');   // the one the second replaced: told under its own id
  assert.deepEqual(events, [started(MAIN, 'nav-25'), started(MAIN, 'nav-26'), aborted(MAIN, 'nav-25', 'NS_BINDING_ABORTED')]);
  assert.equal(registry.pendingNavigationId(MAIN), 'nav-26', 'the second is still in flight');
  events.length = 0;
  registry.onDocumentInserted(MAIN, 'http://c.test/second', '', 'nav-26');
  assert.deepEqual(events, [committed(MAIN, 'nav-26', 'http://c.test/second', '')]);
});

test('the failure of a document request of a navigation already over says nothing', () => {
  const { registry, events } = registrySetup();
  registry.onDocumentRequest(MAIN, 'nav-1', 'http://a.test/');
  registry.onDocumentInserted(MAIN, 'http://a.test/', '', 'nav-1');
  events.length = 0;
  registry.onDocumentRequestFailed(MAIN, 'nav-1', 'NS_ERROR_NET_RESET');     // the body that fails after the document
  registry.onDocumentRequestFailed(MAIN, 'nav-99', 'NS_ERROR_NET_RESET');    // a navigation never heard of
  assert.deepEqual(events, []);
  assert.equal(registry.lastCommittedNavigationId(MAIN), 'nav-1');
  // And an abort says itself once, whoever says it.
  registry.onDocumentRequest(MAIN, 'nav-2', 'http://a.test/x');
  registry.onDocumentRequestFailed(MAIN, 'nav-2', 'NS_ERROR_CONNECTION_REFUSED');
  registry.onDocumentRequestFailed(MAIN, 'nav-2', 'NS_ERROR_CONNECTION_REFUSED');
  registry.onNavigationAborted(MAIN, 'nav-2', 'NS_ERROR_CONNECTION_REFUSED');
  assert.deepEqual(events, [started(MAIN, 'nav-2'), aborted(MAIN, 'nav-2', 'NS_ERROR_CONNECTION_REFUSED')]);
});

test('a redirect is not a failure: the hops add requests to the navigation, and only the end of the last one counts', () => {
  const { registry, events } = registrySetup();
  registry.onDocumentRequest(MAIN, 'nav-1', 'http://a.test/');
  registry.onDocumentRequest(MAIN, 'nav-1', 'http://a.test/hop');            // the hop finished, it did not fail
  assert.deepEqual(events, [started(MAIN, 'nav-1')]);
  assert.equal(registry.pendingNavigationId(MAIN), 'nav-1');
  registry.onDocumentInserted(MAIN, 'http://a.test/hop', '', 'nav-1');
  assert.deepEqual(events, [started(MAIN, 'nav-1'), committed(MAIN, 'nav-1', 'http://a.test/hop', '')]);
  // The last request of a redirected navigation that fails ends it.
  const other = registrySetup();
  other.registry.onDocumentRequest(MAIN, 'nav-2', 'http://a.test/');
  other.registry.onDocumentRequest(MAIN, 'nav-2', 'http://a.test/hop');
  other.registry.onDocumentRequestFailed(MAIN, 'nav-2', 'NS_ERROR_NET_RESET');
  assert.deepEqual(other.events, [started(MAIN, 'nav-2'), aborted(MAIN, 'nav-2', 'NS_ERROR_NET_RESET')]);
});

test('a process swap that goes its way (request, document in the other process) tells no abort', () => {
  const { registry, events } = registrySetup();
  registry.onDocumentRequest(MAIN, 'nav-1', 'http://b.test/');
  // The old process says nothing of the channel it loses (FrameTree.onStateChange), the new one inserts the document under
  // the id the parent knows.
  registry.onDocumentInserted(MAIN, 'http://b.test/', '', 'nav-1');
  assert.deepEqual(events, [started(MAIN, 'nav-1'), committed(MAIN, 'nav-1', 'http://b.test/', '')]);
});

test('a document of a navigation told aborted by its request still commits under its own id', () => {
  const { registry, events } = registrySetup();
  registry.onDocumentRequest(MAIN, 'nav-1', 'http://a.test/');
  registry.onDocumentRequestFailed(MAIN, 'nav-1', 'NS_BINDING_ABORTED');
  events.length = 0;
  registry.onDocumentInserted(MAIN, 'http://a.test/', 'n', 'nav-1');
  assert.deepEqual(events, [committed(MAIN, 'nav-1', 'http://a.test/', 'n')]);
});

// ── the request, in the parent ───────────────────────────────────────────────────────────────────────────────────────────

const Cr = { NS_BINDING_ABORTED: 0x804b0002, NS_ERROR_NET_RESET: 0x804b0014 };
const Ci = { nsITransportSecurityInfo: { TLS_VERSION_1: 1, TLS_VERSION_1_1: 2, TLS_VERSION_1_2: 3, TLS_VERSION_1_3: 4 } };

class EventEmitter {
  on() {}
  off() {}
  once() {}
  emit() {}
}

const { Helper } = load('Helper.js', {
  Cc: { '@mozilla.org/uuid-generator;1': { getService: () => ({}) } },
  Ci, Cr,
  ChromeUtils: { importESModule: () => ({ EventEmitter }) },
}, ['Helper']);

const { NetworkRequest, PageNetwork } = load('NetworkObserver.js', {
  Components: { classes: {}, interfaces: Ci, utils: {}, results: Cr, manager: {},
                Constructor: () => function () {} },
  ChromeUtils: { importESModule: () => ({ Helper, NetUtil: {}, ChannelEventSinkFactory: {}, newProxyInfoFor: () => null }) },
  Services: {},
  dump: () => {},
}, ['NetworkRequest', 'PageNetwork']);

function documentRequest(events, navigationId) {
  const request = Object.create(NetworkRequest.prototype);
  request.requestId = '21';
  request.navigationId = navigationId;
  request.httpChannel = { responseEndTime: 5, transferSize: 1, encodedBodySize: 1 };
  request._frameId = MAIN;
  request._pageNetwork = { _interceptedRequests: new Map(), emit: (name, payload, frameId) => events.push([name, { ...payload }, frameId]) };
  request._networkObserver = { _channelToRequest: new Map([[request.httpChannel, request]]), _forgetExpectedRedirects() {} };
  return request;
}

test('the failure of a document request carries the navigation it belongs to', () => {
  const events = [];
  documentRequest(events, 'nav-26')._sendOnRequestFailed(Cr.NS_BINDING_ABORTED);
  assert.deepEqual(events, [[PageNetwork.Events.RequestFailed,
                             { requestId: '21', errorCode: 'NS_BINDING_ABORTED', navigationId: 'nav-26', documentResponded: false }, MAIN]]);
});

test('the cut of a document request says whether its response had begun: then a document may be on its way from its process', () => {
  const events = [];
  const request = documentRequest(events, 'nav-27');
  request._sentOnResponse = true;
  request._sendOnRequestFailed(Cr.NS_BINDING_ABORTED);
  assert.equal(events[0][1].navigationId, 'nav-27');
  assert.equal(events[0][1].documentResponded, true);
});

test('any other failure of a document request does not carry the navigation: the content tells it, in order with its documents', () => {
  const events = [];
  documentRequest(events, 'nav-26')._sendOnRequestFailed(Cr.NS_ERROR_NET_RESET);   // the connection drops half way through the body
  assert.equal(events.length, 1);
  assert.equal(events[0][1].errorCode, 'NS_ERROR_NET_RESET');
  assert.equal(events[0][1].navigationId, undefined);
});

test('a request that failed half way, with the navigation in flight: the registry is silent, then the document commits', () => {
  // The parent hears the failure before the content's message of the document (in flight) is heard: with no navigation id on
  // it, PageHandler tells the registry nothing, and the navigation that succeeded is not told aborted.
  const { registry, events } = registrySetup();
  registry.onDocumentRequest(MAIN, 'nav-1', 'http://a.test/');
  // (the request's failure arrives here, without a navigation id: nothing is told to the registry)
  assert.deepEqual(events, [started(MAIN, 'nav-1')]);
  registry.onDocumentInserted(MAIN, 'http://a.test/', '', 'nav-1');
  assert.deepEqual(events, [started(MAIN, 'nav-1'), committed(MAIN, 'nav-1', 'http://a.test/', '')]);
});

test('a request that failed half way, then the content tells its end: one abort', () => {
  const { registry, events } = registrySetup();
  registry.onDocumentRequest(MAIN, 'nav-1', 'http://a.test/');
  registry.onNavigationAborted(MAIN, 'nav-1', 'NS_ERROR_NET_RESET');
  registry.onNavigationAborted(MAIN, 'nav-1', 'NS_ERROR_NET_RESET');
  assert.deepEqual(events, [started(MAIN, 'nav-1'), aborted(MAIN, 'nav-1', 'NS_ERROR_NET_RESET')]);
});

test('a redirect hop finishes, it does not fail', () => {
  const events = [];
  documentRequest(events, 'nav-26')._sendOnRequestFinished();
  assert.deepEqual(events.map(e => e[0]), [PageNetwork.Events.RequestFinished]);
});

test('two voices for the same end (the parent and the content) tell one abort, in either order', () => {
  for (const order of ['parent first', 'content first']) {
    const { registry, events } = registrySetup();
    registry.onDocumentRequest(MAIN, 'nav-26', 'http://c.test/second');
    if (order === 'parent first') {
      registry.onDocumentRequestFailed(MAIN, 'nav-26', 'NS_BINDING_ABORTED');
      registry.onNavigationAborted(MAIN, 'nav-26', 'NS_BINDING_ABORTED');
    } else {
      registry.onNavigationAborted(MAIN, 'nav-26', 'NS_BINDING_ABORTED');
      registry.onDocumentRequestFailed(MAIN, 'nav-26', 'NS_BINDING_ABORTED');
    }
    assert.deepEqual(events, [started(MAIN, 'nav-26'), aborted(MAIN, 'nav-26', 'NS_BINDING_ABORTED')], order);
  }
});

test('the same, for a navigation a newer one replaced', () => {
  const { registry, events } = registrySetup();
  registry.onDocumentRequest(MAIN, 'nav-25', 'http://b.test/partial');
  registry.onDocumentRequest(MAIN, 'nav-26', 'http://c.test/second');
  registry.onNavigationAborted(MAIN, 'nav-25', 'NS_BINDING_ABORTED');
  registry.onDocumentRequestFailed(MAIN, 'nav-25', 'NS_BINDING_ABORTED');
  assert.equal(events.filter(e => e[0] === 'navigationaborted').length, 1);
});

// ── a cut the content process makes alone, while the parent carries the request on ───────────────────────────────────────
//
// The known-bad input, from the wrapper's e2e `test_a_read_right_after_goto_answers[/r50]` (gate 44862426341, Linux, round 1,
// the parent's calls of the registry in the order of the Juggler trace): our goto's response had begun in the parent, which
// switched the browsing context (bfcache in the parent) and carried the navigation on; the page being left stopped the
// stand-in of the request in its own docShell from its 50 ms timer (location.replace), and that process told
// NS_BINDING_ABORTED. goto raised it for a document that committed right after.

test('a cut the content process tells of a navigation whose request the parent carries on is not its end: its document commits it', () => {
  const { registry, events } = registrySetup();
  registry.onDocumentRequest(MAIN, 'nav-54', 'http://127.0.0.1/r50?i=r50-1');          // our goto, in the parent
  registry.onContentNavigationStarted(MAIN, 'nav-54');                                 // the docShell being left takes it
  registry.onContentNavigationStarted(MAIN, 'nav-12884901899');                        // the page's own location.replace
  registry.onNavigationAborted(MAIN, 'nav-54', 'NS_BINDING_ABORTED');                  // that docShell stopped its stand-in
  registry.onContentNavigationStarted(MAIN, 'nav-54');                                 // the new browsing context takes ours
  registry.onDocumentInserted(MAIN, 'http://127.0.0.1/r50?i=r50-1', '', 'nav-54');
  const ours = events.filter(([, payload]) => payload.navigationId === 'nav-54');
  assert.deepEqual(ours, [started(MAIN, 'nav-54'), committed(MAIN, 'nav-54', 'http://127.0.0.1/r50?i=r50-1', '')]);
});

test('a cut the content process tells of a navigation whose request the parent never saw ends it at once', () => {
  const { registry, events } = registrySetup();
  registry.onContentNavigationStarted(MAIN, 'nav-7');   // no request in the parent (about:blank, a stop before the request)
  registry.onNavigationAborted(MAIN, 'nav-7', 'NS_BINDING_ABORTED');
  assert.deepEqual(events, [started(MAIN, 'nav-7'), aborted(MAIN, 'nav-7', 'NS_BINDING_ABORTED')]);
});

test('a cut the content process told is kept, and the parent\'s cut of the same request ends the navigation once', () => {
  const { registry, events } = registrySetup();
  registry.onDocumentRequest(MAIN, 'nav-8', 'http://a.test/stopped');
  registry.onNavigationAborted(MAIN, 'nav-8', 'NS_BINDING_ABORTED');
  assert.deepEqual(events, [started(MAIN, 'nav-8')], 'nothing ended while the parent carries the request');
  assert.equal(registry.onDocumentRequestFailed(MAIN, 'nav-8', 'NS_BINDING_ABORTED', false), false);
  registry.onNavigationAborted(MAIN, 'nav-8', 'NS_BINDING_ABORTED');
  assert.deepEqual(events, [started(MAIN, 'nav-8'), aborted(MAIN, 'nav-8', 'NS_BINDING_ABORTED')]);
});

test('a cut the content process told, then the request ends with no document: held behind the barrier, then the content\'s abort', () => {
  const { registry, events } = registrySetup();
  registry.onDocumentRequest(MAIN, 'nav-9', 'http://a.test/finished');
  registry.onNavigationAborted(MAIN, 'nav-9', 'NS_BINDING_ABORTED');
  assert.equal(registry.onDocumentRequestEnded(MAIN, 'nav-9'), true, 'the caller is asked for the barrier');
  assert.deepEqual(events, [started(MAIN, 'nav-9')]);
  registry.onCutConfirmed(MAIN, 'nav-9');
  assert.deepEqual(events, [started(MAIN, 'nav-9'), aborted(MAIN, 'nav-9', 'NS_BINDING_ABORTED')]);
  // The same end with the document still on its way: it comes before the barrier, and commits.
  const other = registrySetup();
  other.registry.onDocumentRequest(MAIN, 'nav-10', 'http://a.test/landed');
  other.registry.onNavigationAborted(MAIN, 'nav-10', 'NS_BINDING_ABORTED');
  assert.equal(other.registry.onDocumentRequestEnded(MAIN, 'nav-10'), true);
  other.registry.onDocumentInserted(MAIN, 'http://a.test/landed', '', 'nav-10');
  other.registry.onCutConfirmed(MAIN, 'nav-10');
  assert.deepEqual(other.events, [started(MAIN, 'nav-10'), committed(MAIN, 'nav-10', 'http://a.test/landed', '')]);
  // And with no cut told, the end of the request says nothing.
  const quiet = registrySetup();
  quiet.registry.onDocumentRequest(MAIN, 'nav-11', 'http://a.test/');
  assert.equal(quiet.registry.onDocumentRequestEnded(MAIN, 'nav-11'), false);
  assert.deepEqual(quiet.events, [started(MAIN, 'nav-11')]);
});

test('the last request of a document says its navigation when it ends otherwise than cut; a hop and a cut do not', () => {
  const finished = [];
  documentRequest(finished, 'nav-30')._sendOnRequestFinished();
  assert.equal(finished[0][1].documentEnded, 'nav-30');
  const hop = [];
  documentRequest(hop, 'nav-30')._sendOnRequestFinished(true);
  assert.equal(hop[0][1].documentEnded, undefined);
  const failed = [];
  documentRequest(failed, 'nav-30')._sendOnRequestFailed(Cr.NS_ERROR_NET_RESET);
  assert.equal(failed[0][1].documentEnded, 'nav-30');
  const cut = [];
  documentRequest(cut, 'nav-30')._sendOnRequestFailed(Cr.NS_BINDING_ABORTED);
  assert.equal(cut[0][1].documentEnded, undefined);
});
