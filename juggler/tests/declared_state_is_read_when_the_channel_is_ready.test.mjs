// What the client declares reaches every root, also when it is declared between the birth of the root's agents and
// the moment the parent binds the root.
//
// The declared state (init scripts with their worlds, bindings, the settings of the context, the file chooser) is in
// the shared data. The agents of a root read it when they are born; after that the parent writes it and sends a message
// to the roots that have an actor (ContentMux.broadcast). A root whose agents are born but whose actor the parent has
// not bound yet (the parent binds on the READY of the child, one hop later, on a busy main thread) read the old state
// and is skipped by the broadcast: nobody tells it again, the world of the caller never appears (the "Control+A" hunts,
// Windows, 8 reds out of 10). The agents now read the shared data every time their channel becomes ready, before any
// command, and what they apply is idempotent.
//
// Run: node --test juggler/tests/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { until, settle } from './_turns.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function load(file, scope, names) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^export /gm, '');
  vm.createContext(scope);
  vm.runInContext(source + `\n;globalThis.__names = { ${names.join(', ')} };`, scope);
  return scope.__names;
}

const { Helper } = load('Helper.js', {
  Cc: { '@mozilla.org/uuid-generator;1': { getService: () => ({}) } },
  Ci: {},
  ChromeUtils: { importESModule: () => ({}) },
}, ['Helper']);
const helper = new Helper();

const { FrameTree } = load('content/FrameTree.js', {
  Components: { interfaces: {}, results: {}, utils: {} },
  ChromeUtils: { importESModule: () => ({ Helper }) },
  dump: () => {},
}, ['FrameTree']);

function loadSimpleChannel() {
  const scope = { dump: () => {}, ChromeUtils: { importESModule: () => ({ setTimeout }) } };
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'SimpleChannel.js'), 'utf8'), scope);
  return scope.SimpleChannel;
}

// A frame as far as the declarations need it: it has a window, and records the contexts and the bindings it was given.
function fakeFrame(tree, speaks) {
  return {
    domWindow: () => ({}),
    contexts: [],
    bindings: [],
    _createIsolatedContext(name) { this.contexts.push(name); if (speaks) tree.say?.(name); },
    _addBinding(world, name, script) { this.bindings.push([world, name, script]); },
  };
}

// The real declaration methods of FrameTree over fake frames.
class FakeFrameTree {
  constructor() {
    this._isolatedWorlds = new Map();
    this._docShellSettings = {};
    this.theFrames = [fakeFrame(this, true), fakeFrame(this, false)];
    // what the tree was asked to write to the docshells, in order
    this.docShellCalls = [];
    // set by the test: how a context created later is announced to the client
    this.say = null;
  }
  frames() { return this.theFrames; }
  setDocShellSettings(s) { this.docShellCalls.push(JSON.parse(JSON.stringify(s))); Object.assign(this._docShellSettings, JSON.parse(JSON.stringify(s))); }
  announceRestoredDocument() {}
}
for (const name of ['setInitScripts', 'addBinding', 'applyCrossProcessState', '_ensureWorld'])
  FakeFrameTree.prototype[name] = FrameTree.prototype[name];

const CALLER = { worldName: '__caller__', worldKind: 'caller', script: 'init' };
const BINDING = { worldName: '__caller__', name: 'send', script: 'bind' };
const KEY = helper.contextCookieKey(0);

// main.js as the content process loads it, with the REAL channel end and the real declaration methods; the shared data
// is a map the test writes as the parent does.
function root() {
  const shared = new Map();
  const Channel = loadSimpleChannel();
  const made = {};
  const modules = {
    'resource://gre/modules/juggler/Helper.js': { Helper },
    'resource://gre/modules/juggler/content/FrameTree.js': { FrameTree: class extends FakeFrameTree { constructor() { super(); made.tree = this; } } },
    'resource://gre/modules/juggler/content/PageAgent.js': {
      // what the real agent queues at birth: the contexts start over, then the main one
      PageAgent: class { constructor(channel) { channel.connect('runtime').emit('cleared'); channel.connect('runtime').emit('context', 'main'); } },
    },
  };
  const scope = {
    Services: {
      scriptloader: { loadSubScript: () => {} },
      cpmm: { sharedData: { get: key => shared.get(key) } },
      appinfo: { processID: 1 },
    },
    ChromeUtils: { importESModule: url => modules[url] },
    SimpleChannel: class extends Channel { constructor(...args) { super(...args); made.channel = this; } },
    Date,
  };
  const { initialize } = load('content/main.js', scope, ['initialize']);
  const geoCalls = [];
  const bc = { id: 3, parent: null, browserId: 7, originAttributes: { userContextId: 0 }, setGeolocationServiceOverride: (...args) => geoCalls.push(args) };
  bc.top = bc;
  initialize(bc, {});
  made.tree.say = name => made.channel.connect('runtime').emit('context', name);
  return { shared, tree: made.tree, channel: made.channel, Channel, geoCalls };
}

// The parent binds the root: its end meets the child's, as JugglerFrameParent and JugglerFrameChild do.
function bind(channel, Channel) {
  const parent = new Channel('browser::page[1]', 'target-1');
  // what the client hears of the contexts, in the order it hears it
  parent.heard = [];
  parent.register('runtime', { cleared: () => { parent.heard.push('cleared'); }, context: name => { parent.heard.push(name); } });
  const deliver = (to, message) => setImmediate(() => to._onMessage(JSON.parse(JSON.stringify(message))));
  channel.setTransport({ sendMessage: m => deliver(parent, m), dispose: () => {} });
  parent.setTransport({ sendMessage: m => deliver(channel, m), dispose: () => {} });
  return parent;
}

const declare = (shared, state) => shared.set(KEY, { initScripts: [], bindings: [], settings: {}, ...state });

test('what is declared after the agents were born and before the parent binds the root reaches the root at the bind', async () => {
  const { shared, tree, channel, Channel } = root();
  assert.equal(tree._isolatedWorlds.size, 0);
  // the parent declares: it writes the shared data, and the broadcast skips the root, which has no actor
  declare(shared, { initScripts: [CALLER], bindings: [BINDING] });
  assert.equal(tree._isolatedWorlds.size, 0);
  bind(channel, Channel);
  await until('the channel is ready', () => channel.isReady());
  const world = tree._isolatedWorlds.get('__caller__');
  assert.ok(world, 'the world of the caller exists');
  assert.equal(world._kind, 'caller');
  assert.deepEqual([...world._scriptsToEvaluateOnNewDocument], ['init']);
  assert.equal(world._bindings.get('send'), 'bind');
  for (const frame of tree.theFrames) {
    assert.deepEqual(frame.contexts, ['__caller__']);
    assert.deepEqual(frame.bindings, [['__caller__', 'send', 'bind']]);
  }
});

test('the settings and the file chooser declared in that window arrive too', async () => {
  const { shared, tree, channel, Channel } = root();
  declare(shared, { settings: { bypassCSP: true } });
  shared.set(helper.pageCookieKey(7), { initScripts: [], bindings: [], interceptFileChooserDialog: true });
  bind(channel, Channel);
  await until('the channel is ready', () => channel.isReady());
  assert.deepEqual(tree._docShellSettings, { bypassCSP: true, interceptFileChooser: true });
});

test('the state read at each ready does not make a second world or a second binding', async () => {
  const { shared, tree, channel, Channel } = root();
  declare(shared, { initScripts: [CALLER], bindings: [BINDING] });
  bind(channel, Channel);
  await until('the channel is ready', () => channel.isReady());
  // a second actor (the page binds the root again) is a second ready
  channel.resetTransport();
  bind(channel, Channel);
  await until('the channel is ready again', () => channel.isReady());
  await settle(20);
  for (const frame of tree.theFrames) {
    assert.deepEqual(frame.contexts, ['__caller__']);
    assert.equal(frame.bindings.length, 1);
  }
});

test('the same state applied twice changes nothing: no context, binding or script more', () => {
  const tree = new FakeFrameTree();
  tree.applyCrossProcessState([CALLER], [BINDING]);
  const after = JSON.stringify([tree.theFrames, [...tree._isolatedWorlds]]);
  tree.applyCrossProcessState([CALLER], [BINDING]);
  assert.equal(JSON.stringify([tree.theFrames, [...tree._isolatedWorlds]]), after);
  assert.deepEqual([...tree._isolatedWorlds.get('__caller__')._scriptsToEvaluateOnNewDocument], ['init']);
  for (const frame of tree.theFrames) {
    assert.deepEqual(frame.contexts, ['__caller__']);
    assert.equal(frame.bindings.length, 1);
  }
});

test('a state with a new binding adds only the new one, and a new world is created on the frames that have a window', () => {
  const tree = new FakeFrameTree();
  tree.applyCrossProcessState([CALLER], [BINDING]);
  const other = { worldName: '__other__', worldKind: 'isolated', script: 'o' };
  const second = { worldName: '__caller__', name: 'more', script: 'm' };
  tree.applyCrossProcessState([CALLER, other], [BINDING, second]);
  for (const frame of tree.theFrames) {
    assert.deepEqual(frame.contexts, ['__caller__', '__other__']);
    assert.deepEqual(frame.bindings, [['__caller__', 'send', 'bind'], ['__caller__', 'more', 'm']]);
  }
});

test('onReady runs at every passage to ready, before what waited is sent, and onReattached is as before', () => {
  const Channel = loadSimpleChannel();
  const events = [];
  const channel = new Channel('', 'process-1');
  channel.onReady(() => events.push('ready'));
  channel.onReattached(() => events.push('reattached'));
  // said before the peer is there: it waits
  channel.connect('page').emit('hello');
  const transport = { sendMessage: m => { events.push(m.ack || m.methodName); }, dispose: () => {} };
  channel.setTransport(transport);
  assert.deepEqual(events, ['READY']);
  channel._onMessage({ ack: 'READY_ACK', uid: 'peer' });
  // the first ready is not a reattachment; the hook runs before the queued message goes out
  assert.deepEqual(events, ['READY', 'ready', 'hello']);
  // the document goes into the cache and comes back: a second ready, and now a reattachment
  channel.detachFromPeer();
  channel.connect('page').emit('while-detached');
  events.length = 0;
  channel._onMessage({ ack: 'READY', uid: 'peer2' });
  assert.deepEqual(events, ['READY_ACK', 'ready', 'reattached', 'while-detached']);
  // a READY_ACK that comes after is not another passage to ready
  events.length = 0;
  channel._onMessage({ ack: 'READY_ACK', uid: 'peer2' });
  assert.deepEqual(events, []);
  // a second actor: the transport is reset and set again
  channel.resetTransport();
  events.length = 0;
  channel.setTransport(transport);
  channel._onMessage({ ack: 'READY_ACK', uid: 'peer3' });
  // (the request still waiting for its answer is said again to the new peer, as before)
  assert.deepEqual(events, ['READY', 'ready', 'while-detached']);
});

test('a hook of onReady that throws does not keep the queue from going out', () => {
  const Channel = loadSimpleChannel();
  const channel = new Channel('', 'process-1');
  channel.onReady(() => { throw new Error('boom'); });
  channel.connect('page').emit('hello');
  const sent = [];
  channel.setTransport({ sendMessage: m => sent.push(m.ack || m.methodName), dispose: () => {} });
  channel._onMessage({ ack: 'READY_ACK', uid: 'peer' });
  assert.deepEqual(sent, ['READY', 'hello']);
  assert.equal(channel.isReady(), true);
});

// ---- the order the client hears it in ------------------------------------------------------------------------------

test('what the ready hook says goes out after what the agents queued at birth: the client keeps the world it hears last', async () => {
  const { shared, channel, Channel } = root();
  // at birth the agent queued [cleared, the main context]; the parent declares, then binds
  declare(shared, { initScripts: [CALLER] });
  const parent = bind(channel, Channel);
  await until('the three are heard', () => parent.heard.length >= 3);
  await settle(20);
  assert.deepEqual(parent.heard, ['cleared', 'main', '__caller__']);
});

// ---- the same state is not applied again -------------------------------------------------------------------------

const GEO = { latitude: 45.1, longitude: 9.2, accuracy: 10 };

async function ready(channel, Channel) {
  channel.resetTransport();
  bind(channel, Channel);
  await until('the channel is ready', () => channel.isReady());
}

test('the same state read at the next ready calls neither the geolocation override nor the docshell settings again', async () => {
  const { shared, tree, channel, Channel, geoCalls } = root();
  declare(shared, { settings: { geolocation: GEO, bypassCSP: true } });
  shared.set(helper.pageCookieKey(7), { initScripts: [], bindings: [], interceptFileChooserDialog: true });
  bind(channel, Channel);
  await until('the channel is ready', () => channel.isReady());
  assert.equal(geoCalls.length, 1);
  const docShellCalls = tree.docShellCalls.length;
  // every new document of the root binds the actor again
  await ready(channel, Channel);
  await ready(channel, Channel);
  assert.equal(geoCalls.length, 1);
  assert.equal(tree.docShellCalls.length, docShellCalls);
});

test('a value that changed is applied once at the next ready, and the others are not', async () => {
  const { shared, tree, channel, Channel, geoCalls } = root();
  declare(shared, { settings: { geolocation: GEO, bypassCSP: true } });
  bind(channel, Channel);
  await until('the channel is ready', () => channel.isReady());
  const docShellCalls = tree.docShellCalls.length;
  declare(shared, { settings: { geolocation: { ...GEO, latitude: 46 }, bypassCSP: true } });
  await ready(channel, Channel);
  assert.equal(geoCalls.length, 2);
  assert.equal(geoCalls[1][0].coords.latitude, 46);
  assert.equal(tree.docShellCalls.length, docShellCalls);
  shared.set(helper.pageCookieKey(7), { initScripts: [], bindings: [], interceptFileChooserDialog: true });
  await ready(channel, Channel);
  assert.equal(geoCalls.length, 2);
  assert.deepEqual(tree.docShellCalls.slice(docShellCalls), [{ interceptFileChooser: true }]);
});

test('what the parent said by message counts as applied: the next read of the same value calls nothing', async () => {
  const { shared, tree, channel, Channel, geoCalls } = root();
  declare(shared, { settings: { geolocation: GEO } });
  const parent = bind(channel, Channel);
  await until('the channel is ready', () => channel.isReady());
  const newer = { ...GEO, latitude: 47 };
  await parent.connect('').send('applyContextSetting', { name: 'geolocation', value: newer });
  await parent.connect('').send('setInterceptFileChooserDialog', true);
  assert.equal(geoCalls.length, 2);
  const docShellCalls = tree.docShellCalls.length;
  declare(shared, { settings: { geolocation: newer } });
  shared.set(helper.pageCookieKey(7), { initScripts: [], bindings: [], interceptFileChooserDialog: true });
  await ready(channel, Channel);
  assert.equal(geoCalls.length, 2);
  assert.equal(tree.docShellCalls.length, docShellCalls);
});

test('a setting this root applied and the shared state no longer has is taken off at the next ready', async () => {
  const { shared, tree, channel, Channel, geoCalls } = root();
  declare(shared, { settings: { geolocation: GEO, bypassCSP: true } });
  bind(channel, Channel);
  await until('the channel is ready', () => channel.isReady());
  assert.equal(geoCalls.length, 1);
  const docShellCalls = tree.docShellCalls.length;
  // the client took the position off between two documents, and the broadcast skipped this root
  declare(shared, { settings: { geolocation: undefined, bypassCSP: true } });
  await ready(channel, Channel);
  assert.equal(geoCalls.length, 2);
  assert.deepEqual(geoCalls[1], []);
  assert.equal(tree.docShellCalls.length, docShellCalls);
  // taken off once: the next ready asks nothing more
  await ready(channel, Channel);
  assert.equal(geoCalls.length, 2);
  // a name that is not in the state at all is the same as undefined
  declare(shared, { settings: { geolocation: GEO } });
  await ready(channel, Channel);
  assert.equal(geoCalls.length, 3);
  declare(shared, { settings: {} });
  await ready(channel, Channel);
  assert.equal(geoCalls.length, 4);
  assert.deepEqual(geoCalls[3], []);
  assert.deepEqual(tree.docShellCalls.slice(docShellCalls), [{ bypassCSP: false }]);
});

test('a setting that was never applied and is undefined is not applied', async () => {
  const { shared, tree, channel, Channel, geoCalls } = root();
  const before = tree.docShellCalls.length;
  declare(shared, { settings: { geolocation: undefined, bypassCSP: undefined } });
  bind(channel, Channel);
  await until('the channel is ready', () => channel.isReady());
  await ready(channel, Channel);
  assert.equal(geoCalls.length, 0);
  assert.equal(tree.docShellCalls.length, before);
});
