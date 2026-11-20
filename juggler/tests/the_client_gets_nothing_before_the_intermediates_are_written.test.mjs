// The client of a driven browser can not navigate before the declared
// intermediate certificates are in cert_storage.
//
// StealthIntermediates.load() hands the list to cert_storage at
// profile-after-change; the write runs on cert_storage's own thread and a
// verification asked before it ends may not see the list. Juggler is the only
// way a client reaches the browser, so it is the point that orders the two: at
// final-ui-startup it reads StealthIntermediates.whenLoaded and
//   - writes the line the client waits for (the one that says Juggler is
//     listening to the pipe) only after that promise has settled, and
//   - keeps every message that arrives on the pipe before then, and hands them
//     to the dispatcher, in order, after it.
//
// The real components/Juggler.js runs here on stubs. Without the wait the
// first two tests are red (see FEATURE.md of stillborn/intermediates).
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
const READY = 'Juggler listening to the pipe';

const turn = () => new Promise(resolve => setImmediate(resolve));

// One browser at final-ui-startup. `whenLoaded` is what the module of the
// intermediates offers; `moduleThrows` makes importing it fail.
async function browserAtFinalUi({ whenLoaded, moduleThrows = false }) {
  const stdout = [];       // what dump() wrote: the readiness line
  const warnings = [];     // what say() wrote
  const toDispatcher = []; // messages the dispatcher received, in order
  let pipeConnection = null;

  class Dispatcher {
    constructor(connection) {
      this.connection = connection;
      connection.onmessage = ({ data }) => toDispatcher.push(data);
    }
    rootSession() { return { setHandler() {} }; }
  }
  class BrowserHandler {}
  class TargetRegistry {
    static markDriven() {}
  }
  class NetworkObserver {}
  const modules = {
    'protocol/Dispatcher.js': { Dispatcher },
    'protocol/BrowserHandler.js': { BrowserHandler },
    'NetworkObserver.js': { NetworkObserver },
    'TargetRegistry.js': { TargetRegistry },
    'EarlyProxyHold.js': { EarlyProxyHold: { register: () => ({}) } },
    'Helper.js': { Helper: class {} },
    'Say.js': { say: text => warnings.push(text) },
    'ActorManagerParent.sys.mjs': { ActorManagerParent: { addJSWindowActors() {} } },
    'psm/StealthIntermediates.sys.mjs': { StealthIntermediates: { whenLoaded } },
  };
  const scope = {
    Components: {
      classes: {
        '@mozilla.org/gfx/info;1': { getService: () => ({ isHeadless: false }) },
        '@mozilla.org/juggler/remotedebuggingpipe;1': {
          getService: () => ({ init: c => { pipeConnection = c; }, stop() {}, sendMessage() {} }),
        },
      },
      interfaces: { nsIRemoteDebuggingPipeClient: {} },
      ID: x => x,
    },
    Services: {
      obs: { addObserver() {}, removeObserver() {} },
      scriptloader: { loadSubScript() {} },
      appShell: { hasHiddenWindow: false },
      prefs: {
        prefHasUserValue: () => false,
        getBoolPref: (name, dflt) => dflt,
        setBoolPref() {},
        clearUserPref() {},
      },
      startup: {},
    },
    dump: text => stdout.push(text),
    ChromeUtils: {
      importESModule: url => {
        const key = Object.keys(modules).find(k => url.endsWith('/' + k));
        assert.ok(key, 'unexpected import ' + url);
        if (moduleThrows && key === 'psm/StealthIntermediates.sys.mjs')
          throw new Error('no such module');
        return modules[key];
      },
      generateQI: () => () => {},
    },
  };
  vm.createContext(scope);
  vm.runInContext(read('components/Juggler.js').replace(/^export /gm, '') + '\n;globalThis.__Juggler = Juggler;', scope);
  const juggler = new scope.__Juggler();
  await juggler.observe(null, 'profile-after-change');
  await juggler.observe({ handleFlag: name => name === 'juggler-pipe', findFlag: () => -1 }, 'command-line-startup');
  const finished = juggler.observe(null, 'final-ui-startup');
  return {
    stdout, warnings, toDispatcher, finished,
    send: message => pipeConnection.receiveMessage(message),
    ready: () => stdout.some(line => line.includes(READY)),
  };
}

function pending() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('the readiness line is not written until the intermediates are written', async () => {
  const written = pending();
  const b = await browserAtFinalUi({ whenLoaded: written.promise });
  await turn();
  assert.equal(b.ready(), false, 'the client must not be told the browser is ready while the write is going on');
  written.resolve(0);
  await b.finished;
  assert.equal(b.ready(), true, 'and it is told once the write has ended');
});

test('a command that arrives before the write ends reaches the dispatcher after it, in order', async () => {
  const written = pending();
  const b = await browserAtFinalUi({ whenLoaded: written.promise });
  b.send('{"id":1,"method":"Browser.enable"}');
  b.send('{"id":2,"method":"Browser.newPage"}');
  await turn();
  assert.deepEqual(b.toDispatcher, [], 'nothing reaches the dispatcher while the write is going on');
  written.resolve(0);
  await b.finished;
  assert.deepEqual(b.toDispatcher, ['{"id":1,"method":"Browser.enable"}', '{"id":2,"method":"Browser.newPage"}']);
  b.send('{"id":3,"method":"Page.navigate"}');
  assert.equal(b.toDispatcher.length, 3, 'afterwards a message goes straight through');
  assert.equal(b.toDispatcher[2], '{"id":3,"method":"Page.navigate"}');
});

test('a write that is already done costs nothing: the line is written in the same start', async () => {
  const b = await browserAtFinalUi({ whenLoaded: Promise.resolve(0) });
  await b.finished;
  assert.equal(b.ready(), true);
  assert.deepEqual(b.warnings, []);
});

test('a module that cannot be loaded is said, and nothing waits for it', async () => {
  const b = await browserAtFinalUi({ whenLoaded: pending().promise, moduleThrows: true });
  await b.finished;
  assert.equal(b.ready(), true);
  assert.match(b.warnings.join(''), /intermediates are not awaited: no such module/);
});

test('source: the wait sits before the line and after the dispatcher exists, in Juggler.js', () => {
  const juggler = read('components/Juggler.js');
  const wait = juggler.indexOf('await whenIntermediatesLoaded;');
  const line = juggler.indexOf('dump(`');
  const dispatcher = juggler.indexOf('new Dispatcher(connection)');
  assert.ok(dispatcher > 0 && wait > dispatcher && line > wait, 'dispatcher, then the wait, then the line');
  assert.match(juggler, /StealthIntermediates\.sys\.mjs"\)\.StealthIntermediates\.whenLoaded/);
});

test('source: whenLoaded is resolved when nothing is written, never rejected, and bounded', () => {
  const module = read('../security/manager/ssl/stealth/StealthIntermediates.sys.mjs');
  assert.match(module, /get whenLoaded\(\) \{\s*return this\.lastLoad \? this\.lastLoad\.done : Promise\.resolve\(\);/);
  assert.match(module, /WRITE_TIMEOUT_MS/);
  assert.doesNotMatch(module, /Promise\.reject|resolve, reject|\(reject\)|reject\(/);
  // Every early exit of load() leaves the record with its resolved promise.
  assert.match(module, /done: Promise\.resolve\(\),/);
});
