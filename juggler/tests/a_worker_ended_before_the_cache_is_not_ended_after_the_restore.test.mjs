// The whole chain of a restore with a change of process: the agents, the channel, the mux and the handler.
//
// The pagehide of a document that goes into the cache ends its workers for the client (`pageWorkerDestroyed`, said on
// the channel that is still attached). When the parent already follows the next document's actor that message is not
// heard and its answer never comes, so it stayed in the content end's queue; the restore announced the same worker
// again (`pageWorkerCreated`, same id) and then the READY replayed the queue: the client got `Page.workerDestroyed`
// for a live worker and nothing more (a hunt on Windows: 3 restores in 300 with a change of process).
//
// The first test below fails on the SimpleChannel before the fix.
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
const plain = x => JSON.parse(JSON.stringify(x));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

const { SimpleChannel } = load('SimpleChannel.js', { dump: () => {} }, ['SimpleChannel']);
const { ContentMux } = load('ContentMux.js', {}, ['ContentMux']);
const { Helper } = load('Helper.js', {
  Cc: { '@mozilla.org/uuid-generator;1': { getService: () => ({}) } }, Ci: {}, ChromeUtils: { importESModule: () => ({}) },
}, ['Helper']);
const { JugglerFrameChild } = load('content/JugglerFrameChild.sys.mjs', {
  Components: { interfaces: {} },
  ChromeUtils: { importESModule: url => (url.endsWith('Helper.js') ? { Helper } : { initialize: () => ({}) }) },
  JSWindowActorChild: class {},
}, ['JugglerFrameChild']);

function pageAgentOn(channel, { workers = [] } = {}) {
  const scope = { Components: { interfaces: {}, results: {}, utils: {} }, dump: () => {},
    Cc: new Proxy({}, { get: () => ({ getService: () => ({ addObserver() {}, removeObserver() {} }) }) }) };
  scope.ChromeUtils = { importESModule: url => url.endsWith('Helper.js') ? { Helper: class extends Helper { addObserver() { return () => {}; } } }
      : { NetUtil: {}, setTimeout } };
  const { PageAgent } = load('content/PageAgent.js', scope, ['PageAgent']);
  const workerChannel = { connect: () => ({ dispose() {} }), register: () => () => {} };
  const main = { id: () => 'mainframe-1', docShell: () => ({}), url: () => 'about:blank', name: () => '', pendingNavigationId: () => null,
    lastCommittedNavigationId: () => null, domWindow: () => null };
  const runtime = new Proxy({}, { get: (_, name) => name === 'executionContexts' ? () => [] : name === 'events' ? new Proxy({}, { get: () => () => () => {} }) : function () {} });
  const live = new Map(workers.map(id => [id, { id: () => id, url: () => 'w.js', frame: () => main, channel: () => workerChannel }]));
  const tree = { runtime: () => runtime, mainFrame: () => main, frames: () => [], isPageReady: () => false,
    workers: () => [...live.values()], _isPageMain: () => true, enterCache() {}, leaveCache() {},
    on() {}, off() {} };
  const agent = new PageAgent(channel, tree);
  return { agent, main };
}

function handlerOnly() {
  const scope = { Components: { classes: {}, interfaces: {}, utils: {}, results: {} }, dump: () => {}, setTimeout, clearTimeout };
  scope.ChromeUtils = { importESModule: url => url.endsWith('Helper.js') ? { Helper, EventWatcher: class {} }
      : url.endsWith('Timer.sys.mjs') ? { setTimeout, clearTimeout } : new Proxy(function () {}, { get: () => class {} }) };
  const { PageHandler } = load('protocol/PageHandler.js', scope, ['PageHandler']);
  const events = [];
  const h = Object.create(PageHandler.prototype);
  h._workersNotToldYet = new Map();
  h._restoreBeingSaid = false;
  h._session = { emitEvent: (name, payload) => events.push([name, plain(payload)]) };
  h._reportedFrameIds = new Set(); h._liveFrameIds = new Set(); h._parentOfFrame = new Map(); h._droppedFrameIds = new Set();
  h._frameEventsBeforeFrame = new Map(); h._contextFrame = new Map(); h._contextsOfFrame = new Map();
  h._workers = new Map(); h._hitWaiters = new Set(); h._landingVerdicts = new Map(); h._pendingEventWatchers = new Set();
  h._heldBackFrames = new Map(); h._eventsAfterName = new Map(); h._frameNavigations = { forget() {} };
  h._eventListeners = []; h._pageNetwork = null; h._frameLifecycle = { reannounceBelow() {}, dispose() {} };
  return { h, events };
}

// A page with a live worker, its root bound to the mux. `lost.up` drops what the content end says (the mux already
// follows the actor of the next document); `lost.answers` drops what the parent says back.
async function pageWithAWorker() {
  const mux = new ContentMux({
    pageTarget: { linkedBrowser: () => ({ browsingContext: { id: 1 } }), frameIdToBrowsingContext: () => null },
    name: 'page', uid: 'parent', createChannel: (n, u) => new SimpleChannel(n, u),
  });
  const { h, events } = handlerOnly();
  h._contentChannel = mux;
  h._onFrameAttached({ frameId: 'mainframe-1' });
  mux.register('page', {
    pageWorkerCreated: p => h._onWorkerCreated(p), pageWorkerDestroyed: p => h._onWorkerDestroyed(p),
    runtimeExecutionContextsCleared: p => h._onExecutionContextsCleared(p),
    runtimeExecutionContextCreated: () => {}, runtimeExecutionContextDestroyed: () => {},
    pageEventFired: () => {}, pageReady: () => {},
  });
  const lost = { up: false, answers: false };
  const channel = new SimpleChannel('content', 'process-x');
  const actor = { receiveMessage() {}, sendAsyncMessage: (name, obj) => queueMicrotask(() => {
    if (lost.answers && obj.responseId)
      return;
    channel._onMessage(structuredClone(obj));
  }) };
  channel.setTransport({ sendMessage: obj => { if (!lost.up) actor.receiveMessage({ data: structuredClone(obj) }); }, dispose() {} });
  mux.bindRoot(1, actor, { isMain: true });
  await settle(3);
  const { agent, main } = pageAgentOn(channel, { workers: ['w1'] });
  channel.onReattached(() => { agent._onDocumentRestored(main); agent.leaveCache(); });
  await settle(3);
  const frameChild = new JugglerFrameChild();
  const document = {};
  frameChild._agents = () => ({ channel, pageAgent: agent });
  frameChild.sendAsyncMessage = () => {};
  Object.defineProperty(frameChild, 'browsingContext', { value: { parent: null } });
  Object.defineProperty(frameChild, 'document', { value: document });
  const seen = () => events.map(e => e[0]).filter(n => /^Page\.worker/.test(n)).map(n => n.replace('Page.', ''));
  return { h, mux, channel, frameChild, document, lost, seen };
}

test('a workerDestroyed that was not heard at the pagehide is not said again after the restore', async () => {
  const p = await pageWithAWorker();
  assert.deepEqual(p.seen(), ['workerCreated']);

  // the pagehide: the parent follows the next document's actor and hears nothing of what is said now
  p.lost.up = true;
  p.frameChild.handleEvent({ type: 'pagehide', persisted: true, target: p.document });
  await settle(3);
  assert.deepEqual(p.seen(), ['workerCreated'], 'nothing was heard');

  // the restore: the parent binds the document again, the hook announces the worker again
  p.lost.up = false;
  p.frameChild.handleEvent({ type: 'pageshow', persisted: true, target: p.document });
  p.channel._onMessage({ ack: 'READY', uid: 'parent' });
  await settle(5);
  // the mux ends the workers of the root when it hears the restored document (the reconciliation of the parent, not
  // the message of the pagehide, which was not heard), and then the worker is announced again; the stale message
  // must not come after that
  assert.deepEqual(p.seen(), ['workerCreated', 'workerDestroyed', 'workerCreated'], 'the worker is announced again and not ended after');
  assert.equal(p.h._workers.size, 1, 'the handler holds the worker');
  assert.deepEqual([...p.mux._workerRoot.keys()], ['w1']);
});

// What stays: the parent end keeps the answer it gave (`_bufferedResponses`), so a repeated request was already answered
// from it. This test does not fail on the old channel; it says the new one does not change it.
test('a workerDestroyed that was heard but not answered at the pagehide is delivered once', async () => {
  const p = await pageWithAWorker();
  // heard, but the answer never comes back
  p.lost.answers = true;
  p.frameChild.handleEvent({ type: 'pagehide', persisted: true, target: p.document });
  await settle(3);
  assert.deepEqual(p.seen(), ['workerCreated', 'workerDestroyed'], 'the parent heard it once');

  p.lost.answers = false;
  p.frameChild.handleEvent({ type: 'pageshow', persisted: true, target: p.document });
  p.channel._onMessage({ ack: 'READY', uid: 'parent' });
  await settle(5);
  assert.deepEqual(p.seen(), ['workerCreated', 'workerDestroyed', 'workerCreated'], 'the restore does not end the worker again');
  assert.equal(p.h._workers.size, 1);
});
