// The PageHandler listens to its FrameLifecycle the way the toolkit's EventEmitter calls listeners.
//
// The toolkit's EventEmitter calls a listener with the name of the event first and what was emitted second. The
// handler registered its three listeners straight on the emitter, so `({frameId}) => ...` was given the NAME
// ('framedetached'), read `frameId` from a string, and got undefined: no Page.frameDetached ever left for a frame
// the parent saw go, and `undefined` sat among the frames announced. The unit test of FrameLifecycle did not see it
// because its emitter, a fake, called listeners without the name. This runs the real PageHandler constructor with
// the real FrameLifecycle and Helper, and an emitter that calls listeners as the toolkit's does.
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

// The toolkit's EventEmitter: `listener(eventName, ...args)`, and off() that removes.
class EventEmitter {
  constructor() { this.listeners = new Map(); }
  on(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]); }
  off(name, listener) { this.listeners.set(name, (this.listeners.get(name) || []).filter(l => l !== listener)); }
  once() {}
  emit(name, ...args) { for (const listener of [...(this.listeners.get(name) || [])]) listener(name, ...args); }
}

function observers() {
  const byTopic = new Map();
  return {
    addObserver: (handler, topic) => byTopic.set(topic, [...(byTopic.get(topic) || []), handler]),
    removeObserver: (handler, topic) => byTopic.set(topic, (byTopic.get(topic) || []).filter(h => h !== handler)),
    notify: (subject, topic, data) => { for (const handler of byTopic.get(topic) || []) handler(subject, topic, data); },
    count: topic => (byTopic.get(topic) || []).length,
  };
}

const Events = (...names) => Object.fromEntries(names.map(name => [name, Symbol(name)]));

function pageHandlerOn(obs) {
  const modules = { 'resource://gre/modules/EventEmitter.sys.mjs': { EventEmitter } };
  const { Helper } = load('Helper.js', {
    Cc: { '@mozilla.org/uuid-generator;1': { getService: () => ({}) } },
    Ci: {},
    Services: { obs },
    ChromeUtils: { importESModule: url => modules[url] || {} },
  }, ['Helper']);
  modules['resource://gre/modules/juggler/Helper.js'] = { Helper, EventWatcher: class {} };
  const { FrameLifecycle } = load('FrameLifecycle.js', {
    ChromeUtils: { importESModule: url => modules[url] },
  }, ['FrameLifecycle']);
  modules['resource://gre/modules/juggler/FrameLifecycle.js'] = { FrameLifecycle };
  const { FrameNavigations } = load('FrameNavigations.js', {}, ['FrameNavigations']);
  modules['resource://gre/modules/juggler/FrameNavigations.js'] = { FrameNavigations };

  const helper = new Helper();
  const network = {};
  helper.decorateAsEventEmitter(network);
  modules['resource://gre/modules/juggler/NetworkObserver.js'] = {
    NetworkObserver: class {},
    PageNetwork: {
      forPageTarget: () => network,
      Events: Events('Request', 'Response', 'RequestFinished', 'RequestFailed'),
    },
  };
  modules['resource://gre/modules/juggler/TargetRegistry.js'] = {
    PageTarget: { Events: Events('DialogOpened', 'ContentDetached', 'Crashed', 'ScreencastFrame') },
  };
  const { PageHandler } = load('protocol/PageHandler.js', {
    Components: { classes: {}, interfaces: {}, utils: {}, results: {} },
    ChromeUtils: { importESModule: url => modules[url] || new Proxy({}, { get: () => class {} }) },
    dump: () => {},
  }, ['PageHandler']);
  return { PageHandler, helper };
}

let nextId = 100;
function context({ parent = null, browserId = 9 } = {}) {
  const bc = { id: nextId++, parent, browserId, isContent: true, webProgress: {}, currentRemoteType: 'web', children: [] };
  if (parent) parent.children.push(bc);
  return bc;
}

function construct(top) {
  const obs = observers();
  const { PageHandler, helper } = pageHandlerOn(obs);
  const events = [];
  const session = { emitEvent: (name, payload) => events.push([name, JSON.parse(JSON.stringify(payload || {}))]) };
  const target = { linkedBrowser: () => ({ browsingContext: top }) };
  helper.decorateAsEventEmitter(target);
  const registered = {};
  const channel = { connect: () => ({ send() {}, emit() {}, dispose() {} }),
                    register: (namespace, handlers) => { registered[namespace] = handlers; return () => {}; } };
  const handler = new PageHandler(target, session, channel);
  return { handler, obs, events, registered };
}

test('the main frame and the frames already there are announced with their ids, by the parent', () => {
  const top = context();
  const child = context({ parent: top });
  const { handler, events } = construct(top);
  assert.deepEqual(events, [
    ['Page.frameAttached', { frameId: 'mainframe-9' }],
    ['Page.frameAttached', { frameId: 'subframe-' + child.id, parentFrameId: 'mainframe-9' }],
  ]);
  assert.ok(!handler._liveFrameIds.has(undefined), 'no frame named undefined');
});

test('a frame the parent sees go is detached for the client, with its id', () => {
  const top = context();
  const { obs, events } = construct(top);
  const child = context({ parent: top });
  obs.notify(child, 'browsing-context-attached', 'attach');
  obs.notify(child, 'browsing-context-discarded', 'discard');
  assert.deepEqual(events.slice(1), [
    ['Page.frameAttached', { frameId: 'subframe-' + child.id, parentFrameId: 'mainframe-9' }],
    ['Page.frameDetached', { frameId: 'subframe-' + child.id }],
  ]);
});

test('a frame never announced that goes leaves nothing waiting for it', () => {
  const top = context();
  const { handler, obs } = construct(top);
  const chrome = context({ parent: top });
  chrome.isContent = false;
  chrome.webProgress = null;
  handler._emitFrameKeyed('Page.eventFired', { frameId: 'subframe-' + chrome.id, name: 'load' }, 'subframe-' + chrome.id);
  assert.equal(handler._frameEventsBeforeFrame.size, 1);
  obs.notify(chrome, 'browsing-context-discarded', 'discard');
  assert.equal(handler._frameEventsBeforeFrame.size, 0, 'framedropped reached the handler');
});

test('dispose() removes the observers and the listeners on the lifecycle', async () => {
  const top = context();
  const { handler, obs } = construct(top);
  assert.equal(obs.count('browsing-context-attached'), 1);
  await handler.dispose();
  assert.equal(obs.count('browsing-context-attached'), 0);
  assert.equal(obs.count('browsing-context-discarded'), 0);
  assert.equal(handler._eventListeners.length, 0);
});

// test_nested_parent_chain (strategy 1, Linux): an iframe starts in the process of its embedder and leaves it for a process of its
// own, so the embedder's process says the frame attached (the page agent) as well as the parent. A frame below a frame whose
// document is about to commit is told after that commit, whoever says it: told before, the client drops it at the commit and keeps
// a stale unnamed Frame in the parent's child list (payment.child_frames == [Frame(url=''), widget]).
test('a frame the content process says attached while its parent navigates is held back and told after the commit', () => {
  const top = context();
  const payment = context({ parent: top });
  const { handler, obs, events, registered } = construct(top);
  const paymentId = 'subframe-' + payment.id;
  handler._frameNavigations.onDocumentRequest(paymentId, 'nav-pay', 'http://b.test/payment');   // payment navigates
  events.length = 0;
  const widgetId = 'subframe-' + (payment.id + 1);
  registered.page.pageFrameAttached({ frameId: widgetId, parentFrameId: paymentId });
  assert.deepEqual(events, [], 'not told while its parent navigates');
  handler._frameNavigations.onDocumentInserted(paymentId, 'http://b.test/payment', 'payment');
  assert.deepEqual(events.map(([name, payload]) => [name, payload.frameId]), [
    ['Page.navigationCommitted', paymentId],
    ['Page.frameAttached', widgetId],
  ]);
});

// The failure of the last document request of a navigation ends it, in the parent (FrameNavigations.onDocumentRequestFailed): the
// request is told as the client knows it, with no `navigationId` (a field of the registry's, not of the protocol), and the
// navigation is aborted under its own id.
test('a document request that fails ends its navigation, and the client is told the request without the navigation id', () => {
  const top = context();
  const { handler, events } = construct(top);
  const frameId = 'mainframe-9';
  handler._handleNetworkEvent('Network.requestWillBeSent', { requestId: '21', navigationId: 'nav-26', url: 'http://c.test/second' }, frameId);
  events.length = 0;
  handler._handleNetworkEvent('Network.requestFailed', { requestId: '21', errorCode: 'NS_BINDING_ABORTED', navigationId: 'nav-26' }, frameId);
  assert.deepEqual(events.map(([name, payload]) => [name, payload.navigationId, payload.errorCode || payload.errorText]), [
    ['Network.requestFailed', undefined, 'NS_BINDING_ABORTED'],
    ['Page.navigationAborted', 'nav-26', 'NS_BINDING_ABORTED'],
  ]);
});

test('a request that is not a document\'s fails without ending any navigation', () => {
  const top = context();
  const { handler, events } = construct(top);
  events.length = 0;
  handler._handleNetworkEvent('Network.requestFailed', { requestId: '22', errorCode: 'NS_ERROR_NET_RESET', navigationId: undefined }, 'mainframe-9');
  assert.deepEqual(events.map(([name]) => name), ['Network.requestFailed']);
});

test('a document request that failed with another error than a cut ends no navigation: the content tells it', () => {
  const top = context();
  const { handler, events } = construct(top);
  const frameId = 'mainframe-9';
  handler._handleNetworkEvent('Network.requestWillBeSent', { requestId: '23', navigationId: 'nav-27', url: 'http://c.test/body' }, frameId);
  events.length = 0;
  // What NetworkRequest emits for NS_ERROR_NET_RESET: no navigation id (NetworkObserver), so nothing for the registry.
  handler._handleNetworkEvent('Network.requestFailed', { requestId: '23', errorCode: 'NS_ERROR_NET_RESET', navigationId: undefined }, frameId);
  assert.deepEqual(events.map(([name]) => name), ['Network.requestFailed']);
  assert.equal(handler._frameNavigations.pendingNavigationId(frameId), 'nav-27');
});

// A cut the content process told of a navigation whose request the parent carries (FrameNavigations.onNavigationAborted) waits
// for the end of that request: a request that finishes with no document holds it behind the barrier, then ends it. The client is
// told the request without `documentEnded`, a field of the registry's.
test('a document request that finishes after a cut the content told sends the barrier, then ends the navigation', async () => {
  const top = context();
  const { handler, events, registered } = construct(top);
  const frameId = 'mainframe-9';
  const barriers = [];
  handler._contentPage.send = (method, params) => { barriers.push([method, params.frameId]); return Promise.resolve(); };
  handler._handleNetworkEvent('Network.requestWillBeSent', { requestId: '24', navigationId: 'nav-28', url: 'http://c.test/stopped' }, frameId);
  registered.frames.frameNavigationAborted({ frameId, navigationId: 'nav-28', errorText: 'NS_BINDING_ABORTED' });
  events.length = 0;
  handler._handleNetworkEvent('Network.requestFinished', { requestId: '24', documentEnded: 'nav-28' }, frameId);
  assert.deepEqual(events.map(([name, payload]) => [name, payload.documentEnded]), [['Network.requestFinished', undefined]]);
  assert.deepEqual(barriers, [['barrier', frameId]]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events.map(([name, payload]) => [name, payload.navigationId, payload.errorText]), [
    ['Network.requestFinished', undefined, undefined],
    ['Page.navigationAborted', 'nav-28', 'NS_BINDING_ABORTED'],
  ]);
});
