// What a content end said to its peer before the document went into the cache is not said again to the peer of
// the restore.
//
// Before: `emit` is a request that waits for its answer, so every message stayed in the queue until the answer
// came; at the READY of the restore the end replayed the whole queue, after the reattachment hook. A
// `pageWorkerDestroyed` said at the pagehide whose answer never came (the parent already followed the next
// document's actor) was said again after the hook had announced the same worker again (`pageWorkerCreated`, same
// id): the parent ended the worker it had just been told about, and the client got `Page.workerDestroyed` for a
// live worker (3 restores in 300 on Windows with a change of process, 0 on Linux).
//
// Now: at the detach what was transmitted leaves the queue; the READY of the restore sends only what was said
// while detached, after the hook. The first READY of a new end, and the READY of a parent end that is bound to
// another actor, replay all as before.
//
// Each test below fails on the SimpleChannel before this change, except the ones that say what stays.
//
// Run: node --test juggler/tests/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { settle } from './_turns.mjs';

const SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'SimpleChannel.js'), 'utf8');

function loadIntoProcess() {
  const scope = { dump: () => {}, ChromeUtils: { importESModule: () => ({ setTimeout }) } };
  vm.createContext(scope);
  vm.runInContext(SOURCE, scope);
  return scope.SimpleChannel;
}

// An end whose transport only writes down what leaves it; the test plays the peer.
function end() {
  const Channel = loadIntoProcess();
  const channel = new Channel('content', 'process-1');
  const out = [];
  channel.setTransport({ sendMessage: message => out.push(JSON.parse(JSON.stringify(message))), dispose: () => {} });
  // the requests that left, as "method:argument"
  const said = () => out.filter(m => m.requestId).map(m => `${m.methodName}:${m.params[0]}`);
  const readyFromPeer = () => channel._onMessage({ ack: 'READY', uid: 'parent' });
  return { channel, out, said, readyFromPeer };
}

test('a message said before the detach and never answered is not said again at the restore', async () => {
  const { channel, said, readyFromPeer } = end();
  readyFromPeer();
  channel.onReattached(() => channel.connect('page').emit('pageWorkerCreated', 'w1'));

  channel.connect('page').emit('pageWorkerDestroyed', 'w1');   // the pagehide: said, the answer never comes
  channel.detachFromPeer();
  readyFromPeer();                                              // the restore binds the document again
  await settle();
  assert.deepEqual(said(), ['pageWorkerDestroyed:w1', 'pageWorkerCreated:w1']);
});

test('a message said while detached goes out after the reattachment hook', async () => {
  const { channel, said, readyFromPeer } = end();
  readyFromPeer();
  channel.onReattached(() => channel.connect('page').emit('pageWorkerCreated', 'w1'));
  channel.connect('page').emit('before', 'a');
  channel.detachFromPeer();
  channel.connect('page').emit('while-detached', 'b');
  assert.deepEqual(said(), ['before:a'], 'nothing leaves while detached');
  readyFromPeer();
  await settle();
  assert.deepEqual(said(), ['before:a', 'pageWorkerCreated:w1', 'while-detached:b']);
});

test('a request that was waiting for its answer at the detach is refused, and its late answer is ignored', async () => {
  const { channel, out, said, readyFromPeer } = end();
  readyFromPeer();
  const request = channel.connect('page').send('ask', 'x');
  let outcome = 'still waiting';
  request.then(() => { outcome = 'answered'; }, error => { outcome = error.message; });
  channel.detachFromPeer();
  await settle();
  assert.match(outcome, /went away before it answered/);
  const requestId = out.find(m => m.methodName === 'ask').requestId;
  readyFromPeer();
  channel._onMessage({ responseId: requestId, result: 'late', uid: 'parent' });   // no throw, nothing to settle
  await settle();
  assert.deepEqual(said(), ['ask:x'], 'not asked again');
});

test('a request that was queued while detached is still answered after the restore', async () => {
  const { channel, out, readyFromPeer } = end();
  readyFromPeer();
  channel.detachFromPeer();
  const request = channel.connect('page').send('ask', 'x');
  readyFromPeer();
  await settle();
  const sent = out.filter(m => m.methodName === 'ask');
  assert.equal(sent.length, 1);
  channel._onMessage({ responseId: sent[0].requestId, result: 'answer' });
  assert.equal(await request, 'answer');
});

test('the first READY of a new end replays everything queued before it', async () => {
  const Channel = loadIntoProcess();
  const channel = new Channel('content', 'process-1');
  const out = [];
  channel.connect('page').emit('one', 1);
  channel.connect('page').emit('two', 2);
  channel.setTransport({ sendMessage: message => out.push(message), dispose: () => {} });
  channel._onMessage({ ack: 'READY', uid: 'parent' });
  await settle();
  assert.deepEqual(out.filter(m => m.requestId).map(m => m.methodName), ['one', 'two']);
});

test('an end that is not detached replays its unanswered messages to the peer that binds it again, as before', async () => {
  // the parent end of a page's channel: bound to one actor after another, never detached
  const { channel, said, readyFromPeer } = end();
  readyFromPeer();
  channel.connect('page').emit('unanswered', 1);
  channel.resetTransport();
  const out = [];
  channel.setTransport({ sendMessage: message => out.push(message), dispose: () => {} });
  channel._onMessage({ ack: 'READY', uid: 'other-actor' });
  await settle();
  assert.deepEqual(out.filter(m => m.requestId).map(m => m.methodName), ['unanswered']);
  assert.deepEqual(said(), ['unanswered:1']);
});

test('a detach of an end that is not attached leaves its queue alone', async () => {
  const Channel = loadIntoProcess();
  const channel = new Channel('content', 'process-1');
  channel.connect('page').emit('queued', 1);
  channel.detachFromPeer();
  const out = [];
  channel.setTransport({ sendMessage: message => out.push(message), dispose: () => {} });
  channel._onMessage({ ack: 'READY', uid: 'parent' });
  await settle();
  assert.deepEqual(out.filter(m => m.requestId).map(m => m.methodName), ['queued']);
});
