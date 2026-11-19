// The events of a stroke are born where the client's plan puts them, however late the engine delivers them, and the input
// of a page is delivered in the order of its commands (B299, B301).
//
// A client that types a planned sequence of keys sends every command of the stroke (one type(), one mouse path, one
// click) at its own planned instant and does not wait for the replies. Under load the engine's reply, and the delivery,
// come late (a key's reply came back 1.7 s late and every following key slipped with it, when the client waited). The
// page must read the plan, not the engine's delay: each command carries `stroke` (the id of the stroke) and `at` (ms
// from the start of the stroke in the client's own plan), besides `latency` (the session's drawn system latency). There
// is no clock shared with the client: only offsets.
//
// An early event waits, so a later command could overtake it. Every input command of a page in a process enters the
// page's gate on arrival and passes it after the one before it: the tests below put a command that waits in front of
// others that would go out at once, and read the order in which they are delivered.
//
// The real StrokeBirth.js and the real PageAgent._dispatchKeyEvent and _insertText run here, on a clock and a timer that
// the test drives; the mouse and the wheel of the parent process are checked on their source (their path needs a window)
// and, for the order, with the same gate and the same shape of wait.
//
// Run: node --test juggler/tests/*.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const JUGGLER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(JUGGLER, rel), 'utf8');
const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function bodyOf(source, header) {
  const at = source.indexOf(header);
  assert.ok(at >= 0, header + ' is in the source');
  const open = source.indexOf('{', source.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0)
      return source.slice(at, i + 1);
  }
  throw new Error('unbalanced ' + header);
}

const scope = {};
vm.createContext(scope);
vm.runInContext(read('StrokeBirth.js').replace(/^export /gm, '') + '\n;globalThis.__StrokeBirth = StrokeBirth;', scope);
const StrokeBirth = scope.__StrokeBirth;

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

// A clock and a timer of the test: sleep() waits until the test moves the clock past its instant.
function world() {
  const w = { t: 0, sleeping: [] };
  w.gate = new StrokeBirth({
    now: () => w.t,
    sleep: ms => new Promise(resolve => w.sleeping.push({ms, resolve, due: w.t + ms})),
  });
  // Moves the clock to `to`, waking what waits for an instant up to it, in the order of the instants.
  w.advance = async to => {
    w.t = to;
    const due = w.sleeping.filter(s => s.due <= to).sort((a, b) => a.due - b.due);
    for (const s of due) {
      w.sleeping.splice(w.sleeping.indexOf(s), 1);
      s.resolve();
    }
    await settle();
  };
  return w;
}

const keySource = bodyOf(read('content/PageAgent.js'), 'async _dispatchKeyEvent(');
const textSource = bodyOf(read('content/PageAgent.js'), 'async _insertText(');
const base = {keyCode: 65, code: 'KeyA', key: 'a', repeat: false, location: 0};

// The real key and insertText methods of the content agent, whose processor records what the engine would be told:
// what was delivered, with the latency declared for it and the time of the test at which it was handed over.
function agent(w) {
  const log = [];
  let declared = 0;
  const tip = {
    setNextKeyLatency: ms => { declared = ms; },
    keydown: () => log.push({what: 'keydown', latency: declared, t: w.t}),
    keyup: () => log.push({what: 'keyup', latency: declared, t: w.t}),
    commitCompositionWith: text => log.push({what: 'text:' + text, latency: declared, t: w.t}),
  };
  class KeyboardEvent {}
  const frame = {textInputProcessor: () => tip, domWindow: () => ({KeyboardEvent, browsingContext: {top: {id: 7}}})};
  const object = new Function('return {\n' + keySource + ',\n' + textSource + '\n};')();
  object._frameTree = {mainFrame: () => frame};
  object._inputGate = () => w.gate;
  return {object, log};
}

const key = (object, extra) => object._dispatchKeyEvent({...base, type: 'keydown', ...extra});
const up = (object, extra) => object._dispatchKeyEvent({...base, type: 'keyup', ...extra});

test('keys delivered at 0, 1728 and 1740 ms with the plan at 0, 276 and 490 are born 276 and 214 ms apart', async () => {
  const w = world();
  const {object, log} = agent(w);
  const delivery = [[0, 0], [1728, 276], [1740, 490]];
  for (const [t, at] of delivery) {
    await w.advance(t);
    await key(object, {latency: 30, stroke: 's1', at});
  }
  const lat = log.map(e => e.latency);
  const births = lat.map((l, i) => delivery[i][0] - l);
  assert.equal(births[0], -30, 'the first key is born `latency` before its delivery, as today');
  assert.equal(births[1] - births[0], 276, 'the plan, not the delay of the engine');
  assert.equal(births[2] - births[1], 214);
  assert.deepEqual(lat, [30, 1728 - 246, 1740 - 460]);
  assert.equal(w.sleeping.length, 0, 'a late event goes out at once');
});

test('an early event waits for its instant, and a late timer only moves the handler, not the birth', async () => {
  const w = world();
  const {object, log} = agent(w);
  await key(object, {latency: 30, stroke: 's2', at: 0});   // born at -30
  await w.advance(50);
  // the plan puts the second key at 70 (born), so delivered at 100; it arrived at 50
  const second = up(object, {latency: 30, stroke: 's2', at: 100});
  await settle();
  assert.equal(w.sleeping.length, 1, 'it waits');
  assert.equal(w.sleeping[0].ms, 50);
  assert.equal(log.length, 1, 'and has not been delivered');
  await w.advance(117);   // the timer comes 17 ms late
  await second;
  assert.equal(log.length, 2);
  assert.equal(117 - log[1].latency, 70, 'born where the plan puts it, whatever the timer did');
});

test('a stroke that follows never goes back in time: its first event is not born before the last birth of the page', async () => {
  const w = world();
  const {object, log} = agent(w);
  for (const [t, at] of [[0, 0], [1728, 276], [1740, 490]]) {
    await w.advance(t);
    await key(object, {latency: 30, stroke: 'a', at});
  }
  // The last birth is 460. A new stroke at 1741 whose latency (1500 ms) would put its first event at 241 is held at 460:
  // it is not born before the last birth of the page, so it goes out when 460 + 1500 has come, and is born at 460.
  await w.advance(1741);
  const next = key(object, {latency: 1500, stroke: 'b', at: 0});
  await settle();
  assert.equal(w.sleeping.length, 1);
  assert.equal(w.sleeping[0].ms, 219);
  await w.advance(1960);
  await next;
  assert.equal(1960 - log[3].latency, 460, 'held at the last birth');
  await w.advance(2000);
  await key(object, {latency: 30, stroke: 'c', at: 0});   // a normal stroke is born `latency` before its delivery
  assert.equal(2000 - log[4].latency, 1970);
  const births = [0, 1728, 1740, 1960, 2000].map((t, i) => t - log[i].latency);
  for (let i = 1; i < births.length; i++)
    assert.ok(births[i] >= births[i - 1], 'birth ' + i);
});

test('a birth is never in the future, whatever the plan', async () => {
  const w = world();
  w.t = 10;
  const first = w.gate.enter({stroke: 'x', at: 0, latency: 0});
  assert.equal(first.mustWait(), false);
  first.release();
  assert.equal(first.latency(), 0);
  // an event of the plan that arrives well before its instant waits for it, and is never born after its delivery
  const early = w.gate.enter({stroke: 'x', at: 300, latency: 0});
  assert.equal(early.mustWait(), true);
  let released = false;
  const waiting = early.due().then(() => { released = true; });
  await settle();
  assert.equal(released, false);
  assert.equal(w.sleeping[0].ms, 300);
  await w.advance(310);
  await waiting;
  early.release();
  assert.equal(early.latency(), 0);
});

test('an event that would wait past the bound goes out at the deadline, born `latency` before it, never left in the future', async () => {
  const w = world();
  w.t = 0;
  const first = w.gate.enter({stroke: 'm', at: 0, latency: 30});    // born at -30
  first.release();
  // a mistaken `at`: the plan puts this one a minute away
  const far = w.gate.enter({stroke: 'm', at: 60000, latency: 30});
  assert.equal(far.mustWait(), true);
  const waiting = far.due();
  await settle();
  assert.equal(w.sleeping.length, 1);
  assert.equal(w.sleeping[0].ms, 10000, 'the wait is bound');
  await w.advance(10000);
  await waiting;
  far.release();
  assert.equal(far.latency(), 30, 'born 30 ms before the deadline: now - latency, not left 50 s ahead');
  assert.equal(10000 - far.latency(), 9970);
  // the page's order follows the realigned birth: the next event of the stroke is not held for the mistaken one
  const next = w.gate.enter({stroke: 'm', at: 100, latency: 30});
  assert.equal(next.mustWait(), false);
  next.release();
  assert.equal(next.latency(), 30, 'born at the same birth, never before the previous one');
});

test('without stroke and at (a client that waits for the replies) the key is born as before, in the same turn', async () => {
  for (const extra of [{}, {stroke: 's'}, {at: 5}, {stroke: 's', at: 'soon'}, {stroke: 's', at: NaN}]) {
    const w = world();
    const {object, log} = agent(w);
    const promise = key(object, {latency: 40, ...extra});
    assert.deepEqual(log.map(e => e.what + ':' + e.latency), ['keydown:40'], JSON.stringify(extra));
    await promise;
    // insertText too, when nothing before it waits
    const text = object._insertText({text: 'é'});
    assert.deepEqual(log.map(e => e.what), ['keydown', 'text:é']);
    await text;
    assert.equal(w.sleeping.length, 0);
  }
});

test('the state is per page and holds only the current stroke', () => {
  const w = world();
  const other = new StrokeBirth({now: () => w.t, sleep: () => Promise.resolve()});
  w.t = 1000;
  w.gate.enter({stroke: 'one', at: 0, latency: 30}).release();
  w.gate.enter({stroke: 'one', at: 500, latency: 30}).release();
  // another page has its own order: the birth of the first does not hold the second back
  const t = other.enter({stroke: 'two', at: 0, latency: 600});
  w.t = 1010;
  assert.equal(t.latency(), 610, 'born 600 before its delivery at 1000, read 10 ms later');
  // a long run of strokes keeps one, and releases its tickets
  for (let i = 0; i < 1000; i++)
    w.gate.enter({stroke: 's' + i, at: 0, latency: 10}).release();
  assert.equal(w.gate._stroke, 's999');
  assert.equal(w.gate._tail._previous, null, 'a ticket keeps no chain behind it');
});

// ---- the order ------------------------------------------------------------------------------------------------------

test('ORDER: a command that waits is not overtaken by the ones that arrive after it, insertText included', async () => {
  const w = world();
  const {object, log} = agent(w);
  // a stroke of keys: the first goes out at once (born at 0); the second is planned at 100 with a system latency of 100,
  // so it waits until 200; the others come at once, with a plan and a latency that would put them out at 110 and 120 if
  // nothing held them; and a text with no key on any layout, which has no stroke and no plan.
  await key(object, {latency: 0, stroke: 'o', at: 0});
  const e1 = key(object, {latency: 100, stroke: 'o', at: 100});
  const text = object._insertText({text: 'é'});
  const e2 = up(object, {latency: 0, stroke: 'o', at: 110});
  const e3 = key(object, {latency: 0, stroke: 'o', at: 120});
  const e4 = up(object, {latency: 0, stroke: 'p', at: 0});    // a new stroke arrives behind the tail of the previous one
  await settle();
  assert.equal(log.length, 1, 'only the first has gone out');
  await w.advance(115);
  assert.equal(log.length, 1, 'the instants of the later ones have come, and none has overtaken the one that waits');
  await w.advance(200);
  await Promise.all([e1, text, e2, e3, e4]);
  assert.deepEqual(log.map(e => e.what), ['keydown', 'keydown', 'text:é', 'keyup', 'keydown', 'keyup']);
  assert.deepEqual(log.slice(1).map(e => e.t), [200, 200, 200, 200, 200]);
  // born where the plan puts them: 100, 110, 120, and the new stroke not before the last birth (120)
  const key1 = log[1], key2 = log[3], key3 = log[4], stroke2 = log[5];
  assert.deepEqual([200 - key1.latency, 200 - key2.latency, 200 - key3.latency], [100, 110, 120]);
  assert.ok(200 - stroke2.latency >= 120, 'a new stroke never goes back in time');
  assert.equal(log[2].latency, 0, 'the text keeps the stamp of its construction: it declares no latency');
});

test('ORDER: the mouse and the wheel of the parent, one gate, one order (the shape of the handlers)', async () => {
  const w = world();
  const log = [];
  // what the handlers do: enter on arrival, wait if told to, release, hand over
  async function command(label, plan, beforeGate = async () => {}) {
    const ticket = w.gate.enter(plan);
    try {
      await beforeGate();      // the round trips of the handler before its gate (_pagePixels, armLanding)
      if (ticket.mustWait())
        await ticket.due();
    } finally {
      ticket.release();
    }
    log.push({label, t: w.t, latency: ticket.tagged ? ticket.latency() : null});
  }
  await command('move0', {stroke: 'm', at: 0, latency: 0});
  const slow = () => new Promise(resolve => w.sleeping.push({ms: 0, resolve, due: w.t + 30}));
  const a = command('move1', {stroke: 'm', at: 100, latency: 100});         // waits until 200
  const b = command('move2', {stroke: 'm', at: 110, latency: 0});
  const c = command('wheel', {stroke: 'm', at: 120, latency: 0});
  const d = command('plain', undefined);                                   // an old client's command
  const e = command('slowest', {stroke: 'n', at: 0, latency: 0}, slow);     // takes longer on its way to the gate
  await w.advance(150);
  assert.deepEqual(log.map(x => x.label), ['move0']);
  await w.advance(200);
  await Promise.all([a, b, c, d, e]);
  assert.deepEqual(log.map(x => x.label), ['move0', 'move1', 'move2', 'wheel', 'plain', 'slowest']);
  assert.deepEqual(log.slice(1, 4).map(x => 200 - x.latency), [100, 110, 120], 'increasing births');
  assert.equal(log[4].latency, null);
});

test('ORDER: a command that fails before its gate does not hold the ones after it', async () => {
  const w = world();
  const log = [];
  const failing = w.gate.enter({stroke: 'f', at: 0, latency: 0});
  const after = w.gate.enter({stroke: 'f', at: 0, latency: 0});
  const run = (async () => {
    try {
      if (after.mustWait())
        await after.due();
    } finally {
      after.release();
    }
    log.push('after');
  })();
  await settle();
  assert.deepEqual(log, [], 'it waits for the one before it');
  failing.release();     // what the finally of the failed command does
  await run;
  assert.deepEqual(log, ['after']);
});

test('after a stall, five events of one stroke that arrive together in a burst go out as the plan spaces them', async () => {
  const w = world();
  const {object, log} = agent(w);
  await w.advance(1700);          // the engine was stalled 1.7 s; the client's commands arrive together
  const plan = [0, 100, 200, 300, 400];
  const all = plan.map((at, i) => (i % 2 ? up : key)(object, {latency: 30, stroke: 'burst', at}));
  await settle();
  assert.equal(log.length, 1, 'the first goes out at once');
  assert.equal(log[0].latency, 30);
  for (const [i, t] of [[1, 1800], [2, 1900], [3, 2000], [4, 2100]]) {
    await w.advance(t - 1);
    assert.equal(log.length, i, 'not before its time (' + t + ')');
    await w.advance(t);
    assert.equal(log.length, i + 1);
  }
  await Promise.all(all);
  assert.deepEqual(log.map(e => e.t), [1700, 1800, 1900, 2000, 2100]);
  assert.deepEqual(log.map(e => e.t - e.latency), plan.map(at => 1670 + at), 'births = anchor + at');
  assert.deepEqual(log.map(e => e.what), ['keydown', 'keyup', 'keydown', 'keyup', 'keydown']);
});

// ---- the sources the engine runs ------------------------------------------------------------------------------------

test('every input command enters the gate of its page before its first await, and releases its ticket in a finally', () => {
  const agentCode = strip(read('content/PageAgent.js'));
  const handler = strip(read('protocol/PageHandler.js'));
  const bodies = [
    ['key', bodyOf(agentCode, 'async _dispatchKeyEvent(')],
    ['insertText', bodyOf(agentCode, 'async _insertText(')],
    ['mouse command', bodyOf(handler, "async ['Page.dispatchMouseEvent'](")],
    ['wheel command', bodyOf(handler, "async ['Page.dispatchWheelEvent'](")],
    ['parent gate for key and text', bodyOf(handler, 'async _passInputGate(')],
  ];
  for (const [name, body] of bodies) {
    const enter = body.indexOf('this._inputGate().enter(');
    assert.ok(enter > 0, name + ' enters the gate');
    const firstAwait = body.indexOf('await ');
    assert.ok(firstAwait < 0 || enter < firstAwait, name + ': before the first await');
    assert.match(body, /finally \{\s*ticket\.release\(\);\s*\}/, name + ' releases in a finally');
  }
  // the parts of the mouse and the wheel that pass the gate after their own round trips release there, before they hand over
  for (const header of ['async _dispatchMouseEvent(', 'async _dispatchWheelEvent(']) {
    const body = bodyOf(handler, header);
    assert.match(body, /try \{\s*if \(ticket\.mustWait\(\)\)\s*await ticket\.due\(\);\s*\} finally \{\s*ticket\.release\(\);\s*\}/, header);
    assert.ok(body.indexOf('ticket.release()') < body.indexOf('activateAndRun'), header + ': released before the hand-over');
    assert.match(body, /ticket\.tagged \? ticket\.latency\(\) : \(latency \|\| 0\)/, header + ' declares at the hand-over');
  }
  // a key and a text commanded to the parent take their place after the mouse and the wheel that wait
  assert.match(bodyOf(handler, "async ['Page.dispatchKeyEvent']("), /await this\._passInputGate\(\);/);
  assert.match(bodyOf(handler, "async ['Page.insertText']("), /await this\._passInputGate\(\);/);
});

test('the commands carry stroke and at, optional, to the code that delivers them', () => {
  const protocol = read('protocol/Protocol.js');
  for (const command of ["'dispatchKeyEvent'", "'dispatchMouseEvent'", "'dispatchWheelEvent'"]) {
    const at = protocol.indexOf(command + ': {');
    assert.ok(at >= 0, command);
    const text = protocol.slice(at, at + 2600);
    assert.match(text, /stroke: t\.Optional\(t\.String\)/, command);
    assert.match(text, /at: t\.Optional\(t\.Number\)/, command);
  }
  const handler = strip(read('protocol/PageHandler.js'));
  assert.match(bodyOf(handler, "async ['Page.dispatchKeyEvent']("), /latency, stroke, at\}\) \{[\s\S]*\{type, keyCode, code, key, repeat, location, text, latency, stroke, at\}\)\);/);
  assert.match(bodyOf(handler, "async ['Page.dispatchWheelEvent']("), /latency, stroke, at\}\) \{[\s\S]*enter\(\{stroke, at, latency\}\)/);
  assert.match(bodyOf(handler, "async ['Page.dispatchMouseEvent']("), /enter\(options\)/);
  assert.match(read('moz.build'), /"StrokeBirth\.js",/);
});
