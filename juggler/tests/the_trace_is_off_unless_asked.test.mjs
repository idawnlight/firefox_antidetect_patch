// The diagnostic trace of the channels and the navigations (juggler/Trace.js) is OFF unless the environment of the
// parent process has INVISIBLE_JUGGLER_TRACE_DIR. It exists to read a goto that stays pending (never told committed
// nor aborted), and it must cost nothing, and touch nothing, when nobody asked for it.
//
// Off: no file, no write, no shared-data key, no listener. On, in the parent: one file per browser session, one JSON line
// per event, flushed at every line (the trace is wanted when the process is killed), the lines of the content processes
// (which cannot write a file) arriving over `juggler:trace`. In a content process: only a message, and only when the
// parent switched the trace on in the shared data. Never an exception at the caller.
//
// Run: node --test juggler/tests/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PROCESS_TYPE_DEFAULT = 0;
const TRACE_SOURCE = read('Trace.js').replace(/^export /gm, '') + '\n;globalThis.__names = { trace };';

// Trace.js as the parent or a content process loads it, with fakes for what it uses. `env` is the value of the variable,
// `shared` what the shared data of a content process holds, `streamFails` makes every write of the file stream throw,
// `initFails` makes the opening of the file throw.
function loadTrace({ processType = PROCESS_TYPE_DEFAULT, env = '', shared = {}, streamFails = false, initFails = false, pid = 4242 } = {}) {
  const seen = {
    envAsked: [], initWithPath: [], appended: [], streamsMade: 0, inits: [], written: [], flushes: 0,
    sharedSet: [], sharedFlushes: 0, listeners: [], sent: [], stderr: [],
  };
  const stream = {
    init(file, flags, mode, behavior) {
      if (initFails)
        throw new Error('NS_ERROR_FILE_NOT_FOUND');
      seen.inits.push({ file, flags, mode, behavior });
    },
    write(text, length) {
      if (streamFails)
        throw new Error('disk full');
      assert.equal(length, text.length);
      seen.written.push(text);
    },
    flush() { seen.flushes++; },
  };
  const file = {
    initWithPath(p) { seen.initWithPath.push(p); this.path = p; },
    append(name) { seen.appended.push(name); this.path += '/' + name; },
  };
  const scope = {
    Services: {
      env: { get: name => { seen.envAsked.push(name); return name === 'INVISIBLE_JUGGLER_TRACE_DIR' ? env : ''; } },
      appinfo: { processType, processID: pid },
      ppmm: {
        addMessageListener: (name, listener) => seen.listeners.push({ name, listener }),
        sharedData: { set: (k, v) => seen.sharedSet.push([k, v]), flush: () => seen.sharedFlushes++ },
      },
      cpmm: {
        sharedData: { get: key => shared[key] },
        sendAsyncMessage: (name, data) => seen.sent.push({ name, data: JSON.parse(JSON.stringify(data)) }),
      },
    },
    Ci: { nsIXULRuntime: { PROCESS_TYPE_DEFAULT }, nsIFile: 'nsIFile', nsIFileOutputStream: 'nsIFileOutputStream' },
    Cc: {
      '@mozilla.org/file/local;1': { createInstance: () => file },
      '@mozilla.org/network/file-output-stream;1': { createInstance: () => { seen.streamsMade++; return stream; } },
    },
    Components: { utils: { printStderr: text => seen.stderr.push(text) } },
  };
  vm.createContext(scope);
  vm.runInContext(TRACE_SOURCE, scope);
  const lines = () => seen.written.join('').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { trace: scope.__names.trace, seen, lines };
}

test('source: the module is installed with the others, reads one variable, sets no pref, and is no page API', () => {
  assert.match(read('moz.build'), /"Trace\.js",/);
  const text = read('Trace.js');
  assert.doesNotMatch(text, /Services\.prefs|Preferences|dump\(|window|document/);
  assert.deepEqual([...text.matchAll(/Services\.env\.(\w+)\(/g)].map(m => m[1]), ['get']);
  assert.match(text, /const TRACE_ENV = 'INVISIBLE_JUGGLER_TRACE_DIR';/);
});

test('off: with no variable, the parent opens no file, writes nothing, touches no shared data, listens to nothing', () => {
  for (const env of ['', undefined, null]) {
    const { trace, seen } = loadTrace({ env });
    trace('channel', 'send', { requestId: 1 });
    trace('mux', 'route', { rootId: 3 });
    assert.equal(seen.streamsMade, 0);
    assert.deepEqual(seen.initWithPath, []);
    assert.deepEqual(seen.written, []);
    assert.equal(seen.flushes, 0);
    assert.deepEqual(seen.sharedSet, []);
    assert.equal(seen.sharedFlushes, 0);
    assert.deepEqual(seen.listeners, []);
    assert.deepEqual(seen.sent, []);
    // the variable is read once, not at every event
    assert.deepEqual(seen.envAsked, ['INVISIBLE_JUGGLER_TRACE_DIR']);
  }
});

test('on, in the parent: one file per session, one JSON line per event, flushed at every line', () => {
  const { trace, seen, lines } = loadTrace({ env: '/tmp/traces' });
  assert.deepEqual(seen.initWithPath, ['/tmp/traces']);
  assert.equal(seen.appended.length, 1);
  assert.match(seen.appended[0], /^juggler-4242-\d+\.jsonl$/);
  assert.equal(seen.streamsMade, 1);
  // append mode, write-only, created if missing
  assert.equal(seen.inits[0].flags, 0x02 | 0x08 | 0x10);

  trace('channel', 'send', { namespace: 'page', methodName: 'goto', requestId: 7, sent: false });
  trace('page-handler', 'frameDocumentInserted', { payload: { frameId: 'mainframe-1' }, dropped: false });
  trace('mux', 'no detail');

  const all = lines();
  assert.equal(all.length, 3);
  assert.equal(seen.written.length, 3);
  assert.equal(seen.flushes, 3, 'flushed after every line');
  assert.deepEqual(all.map(l => [l.where, l.what, l.proc, l.pid]), [
    ['channel', 'send', 'parent', 4242],
    ['page-handler', 'frameDocumentInserted', 'parent', 4242],
    ['mux', 'no detail', 'parent', 4242],
  ]);
  assert.deepEqual(all[0].detail, { namespace: 'page', methodName: 'goto', requestId: 7, sent: false });
  assert.deepEqual(all[1].detail, { payload: { frameId: 'mainframe-1' }, dropped: false });
  assert.equal(all[2].detail, null);
  for (const line of all)
    assert.ok(Number.isFinite(line.t) && line.t > 1e12, 'a time in ms');
  assert.ok(all[0].t <= all[1].t && all[1].t <= all[2].t);
  // one line each: a newline and a non-ASCII letter in the detail stay on the line, in bytes the stream takes
  trace('x', 'y', { text: 'a\nè' });
  assert.ok(seen.written.at(-1).endsWith('\n'));
  assert.equal(seen.written.at(-1).split('\n').length, 2);
  assert.doesNotMatch(seen.written.at(-1), /[^\x00-\x7f]/);
  assert.equal(lines().at(-1).detail.text, 'a\nè');
});

test('on, in the parent: the shared data tells the content processes, and their lines are written with their own time', () => {
  const { seen, lines } = loadTrace({ env: '/tmp/traces' });
  assert.deepEqual(seen.sharedSet, [['juggler-trace', true]]);
  assert.equal(seen.sharedFlushes, 1);
  assert.equal(seen.listeners.length, 1);
  assert.equal(seen.listeners[0].name, 'juggler:trace');
  seen.listeners[0].listener.receiveMessage({ data: { t: 1234.5, pid: 99, where: 'frame-child', what: 'actorCreated', detail: { browsingContextId: 12 } } });
  const [line] = lines();
  const { rt, ...rest } = line;
  assert.deepEqual(rest, { t: 1234.5, pid: 99, proc: 'content', where: 'frame-child', what: 'actorCreated', detail: { browsingContextId: 12 } });
  assert.ok(Number.isFinite(rt) && rt > 1e12, 'the time it reached the parent');
  // a message with nothing in it is a line; one that is no message is lost, and no exception comes of it
  seen.listeners[0].listener.receiveMessage({});
  assert.doesNotThrow(() => seen.listeners[0].listener.receiveMessage(null));
  assert.equal(lines().length, 2);
});

test('in a content process: a message to the parent when the shared data says so, never a file', () => {
  const on = loadTrace({ processType: 2, env: '/tmp/traces', shared: { 'juggler-trace': true }, pid: 777 });
  on.trace('frame-child', 'handleEvent', { type: 'pageshow', persisted: true });
  assert.equal(on.seen.sent.length, 1);
  assert.equal(on.seen.sent[0].name, 'juggler:trace');
  const { t, pid, where, what, detail } = on.seen.sent[0].data;
  assert.deepEqual({ pid, where, what, detail }, { pid: 777, where: 'frame-child', what: 'handleEvent', detail: { type: 'pageshow', persisted: true } });
  assert.ok(Number.isFinite(t) && t > 1e12);
  // no file, no key written, no variable read, nothing listened to
  assert.equal(on.seen.streamsMade, 0);
  assert.deepEqual(on.seen.initWithPath, []);
  assert.deepEqual(on.seen.written, []);
  assert.deepEqual(on.seen.sharedSet, []);
  assert.deepEqual(on.seen.listeners, []);
  assert.deepEqual(on.seen.envAsked, []);

  const off = loadTrace({ processType: 2, env: '/tmp/traces', shared: {} });
  off.trace('frame-child', 'handleEvent', {});
  assert.deepEqual(off.seen.sent, []);
  assert.equal(off.seen.streamsMade, 0);
});

test('in a content process: the shared data written after the process began is seen at the next event', () => {
  const shared = {};
  const { trace, seen } = loadTrace({ processType: 2, shared });
  trace('channel', 'send', {});
  assert.deepEqual(seen.sent, []);
  shared['juggler-trace'] = true;
  trace('channel', 'send', {});
  assert.equal(seen.sent.length, 1);
});

test('no exception reaches the caller: a stream that fails, a detail that cannot be said, a folder that is not there', () => {
  const failing = loadTrace({ env: '/tmp/traces', streamFails: true });
  assert.doesNotThrow(() => failing.trace('channel', 'send', { requestId: 1 }));
  assert.doesNotThrow(() => failing.trace('channel', 'send', { requestId: 2 }));
  assert.doesNotThrow(() => failing.seen.listeners[0].listener.receiveMessage({ data: { where: 'a', what: 'b' } }));

  const { trace, seen, lines } = loadTrace({ env: '/tmp/traces' });
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => trace('channel', 'circular', circular));
  assert.equal(lines().length, 1);
  assert.match(lines()[0].detail.unserializable, /circular/i);
  assert.doesNotThrow(() => trace('channel', 'big', { n: 10n }));
  assert.equal(seen.written.length, 2);

  // the folder cannot be opened: one line on stderr, nothing else, and the callers go on
  const noFolder = loadTrace({ env: '/no/such/folder', initFails: true });
  assert.doesNotThrow(() => noFolder.trace('channel', 'send', {}));
  assert.deepEqual(noFolder.seen.written, []);
  assert.deepEqual(noFolder.seen.sharedSet, []);
  assert.equal(noFolder.seen.stderr.length, 1);
  assert.match(noFolder.seen.stderr[0], /could not be opened/);

  // a process with none of the services at all
  const bare = {};
  vm.createContext(bare);
  vm.runInContext(TRACE_SOURCE, bare);
  assert.doesNotThrow(() => bare.__names.trace('channel', 'send', {}));

  const content = loadTrace({ processType: 2, shared: { 'juggler-trace': true } });
  assert.doesNotThrow(() => content.trace('channel', 'send', { circular }));
  assert.match(content.seen.sent[0].data.detail.unserializable, /circular/i);
});

test('SimpleChannel, loaded where Trace.js is there, traces its handshake and its messages; where it is not, it still works', async () => {
  const calls = [];
  const load = importESModule => {
    const scope = { dump: () => {}, ChromeUtils: importESModule && { importESModule } };
    vm.createContext(scope);
    vm.runInContext(read('SimpleChannel.js') + '\n;globalThis.__names = { SimpleChannel };', scope);
    return scope.__names.SimpleChannel;
  };
  const connect = SimpleChannel => {
    const a = new SimpleChannel('a', 'a');
    const b = new SimpleChannel('b', 'b');
    a.setTransport({ sendMessage: m => queueMicrotask(() => b._onMessage(m)), dispose() {} });
    b.setTransport({ sendMessage: m => queueMicrotask(() => a._onMessage(m)), dispose() {} });
    b.register('ns', { ping: async x => x + 1 });
    return { a, b };
  };
  const Traced = load(() => ({ trace: (where, what, detail) => calls.push([where, what, detail]) }));
  const { a } = connect(Traced);
  assert.equal(await a.connect('ns').send('ping', 1), 2);
  const whats = calls.map(([where, what]) => `${where}:${what}`);
  for (const expected of ['channel:send READY', 'channel:recv READY', 'channel:markAsReady', 'channel:send', 'channel:recv request', 'channel:send response', 'channel:recv response'])
    assert.ok(whats.includes(expected), expected + ' in ' + whats.join(', '));
  assert.ok(calls.every(([where, what, detail]) => typeof where === 'string' && typeof what === 'string' && JSON.stringify(detail)));
  // a trace module that throws, or is not there, or an importer that throws, changes nothing
  for (const importESModule of [() => ({ trace: () => { throw new Error('boom'); } }), () => ({}), () => { throw new Error('no module'); }, undefined]) {
    const { a: end } = connect(load(importESModule));
    assert.equal(await end.connect('ns').send('ping', 41), 42);
  }
});
