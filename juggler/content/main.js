/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Services is available as a global

// Load SimpleChannel and Runtime in content process's global.
// NOTE: since these have to exist in both Worker and main threads, and we do
// not know a way to load ES Modules in worker threads, we have to use the loadSubScript
// utility instead.
Services.scriptloader.loadSubScript('resource://gre/modules/juggler/SimpleChannel.js');
Services.scriptloader.loadSubScript('resource://gre/modules/juggler/content/Runtime.js');

const {Helper} = ChromeUtils.importESModule('resource://gre/modules/juggler/Helper.js');
const {FrameTree} = ChromeUtils.importESModule('resource://gre/modules/juggler/content/FrameTree.js');
const {PageAgent} = ChromeUtils.importESModule('resource://gre/modules/juggler/content/PageAgent.js');

const helper = new Helper();

export function initialize(browsingContext, docShell) {
  const data = { channel: undefined, pageAgent: undefined, frameTree: undefined };

  const applySetting = {
    geolocation: (geolocation) => {
      // The override is a field of the page's TOP browsing context, not synchronized: GetGeolocationServiceOverride
      // reads Top()'s, and the setter asserts IsTop() (BrowsingContext.cpp). A fragment root that is not the top is
      // in a process that holds a proxy of the top, the object its Top() answers: the override is set there, in
      // each process that has a root, from the shared settings at initialize and from the parent's broadcast.
      const top = browsingContext.top;
      if (geolocation) {
        top.setGeolocationServiceOverride({
          coords: {
            latitude: geolocation.latitude,
            longitude: geolocation.longitude,
            accuracy: geolocation.accuracy,
            altitude: NaN,
            altitudeAccuracy: NaN,
            heading: NaN,
            speed: NaN,
          },
          // The position is wrapped as an nsIDOMGeoPosition and Firefox reads this attribute each time it asks (cache check,
          // maximumAge check, the page's position.timestamp): it is the time of each delivery, like a fix the provider just
          // stamped, never the time of the set and never a day ahead. It cannot be older than a maximumAge either.
          get timestamp() { return Date.now(); },
        });
      } else {
        top.setGeolocationServiceOverride();
      }
    },
    bypassCSP: (bypassCSP) => {
      data.frameTree.setDocShellSettings({ bypassCSP: !!bypassCSP });
    },

    // No `locale` and no `timezoneId` here: the context's language list and
    // zone are the BrowsingContext's LanguageOverride and TimezoneOverride
    // fields, set from the parent (see PageTarget.updateLanguageOverride and
    // updateTimezoneOverride in TargetRegistry.js).

    // No `javaScriptDisabled` either: whether scripts run is the BrowsingContext's AllowJavascript, written by
    // the parent (PageTarget.updateJavaScriptDisabled), the one process that can write it for every document.
  };

  // STEALTHFOX: qui c'erano docShell.overrideHasFocus e forceActiveState,
  // messi su OGNI documento di primo livello. Sono codice morto: verificato in
  // tutto l'albero che l'unico lettore e' la coppia getter/setter in
  // nsDocShell.cpp:2891-2917, e che ne' Document::HasFocus() ne'
  // ComputeVisibilityState() li guardano. Il commento in Document.cpp:17188 e'
  // nostro e lo dice: "GetForceActiveState removed in 150".
  //
  // Misurato prima di toglierli, per non fidarsi del solo sorgente: su tre
  // schede il fuoco resta UNO, come in un browser vero, sia con sia senza.
  // STEALTHFOX: BFCache stays enabled, as for a real user, so
  // pageshow's event.persisted behaves like one. Upstream Juggler disables it
  // per docshell; the knob that was here to restore that
  // (zoom.stealth.juggler.disallow_bfcache) set an attribute nothing read, so
  // it never did anything, and it is gone with the attribute.
  data.frameTree = new FrameTree(browsingContext);
  // The state the client declared (the settings of the context, the init scripts with their worlds, the bindings, the
  // file chooser) is in the shared data, written by the parent before it tells the roots that have an actor. Every
  // root of a page applies it for its own part, when its agents are born AND each time its channel becomes ready: the
  // parent binds a root only after its agents were born, and what it declared meanwhile reached no one (a root with
  // no actor is sent nothing). It is read again, never remembered, and what is applied is idempotent: the same state
  // makes no second world, binding or script. The cookie holds settings that are not applied here (javaScriptDisabled
  // is the parent's): a name this process does not apply is skipped, not an error that would stop the root from
  // coming up.
  // What this root applied last, by name, as JSON: the same value is not applied again. The channel becomes ready at each
  // new document of the root (every navigation binds the actor again), and writing the geolocation override again
  // may reach the page that watches the position. The parent's messages are remembered the same way.
  const lastApplied = new Map();
  const remember = (key, value) => void lastApplied.set(key, String(JSON.stringify(value)));
  const isApplied = (key, value) => lastApplied.get(key) === String(JSON.stringify(value));
  const applySharedState = () => {
    const contextCrossProcessCookie = Services.cpmm.sharedData.get(helper.contextCookieKey(browsingContext.originAttributes.userContextId)) || { initScripts: [], bindings: [], settings: {} };
    const pageCrossProcessCookie = Services.cpmm.sharedData.get(helper.pageCookieKey(browsingContext.browserId)) || { initScripts: [], bindings: [], interceptFileChooserDialog: false };
    // A setting this root applied and the shared state no longer has (the client took it off between two documents,
    // and the broadcast skipped the root) is taken off here too: `undefined` is skipped only for a name never applied.
    const names = new Set([...Object.keys(contextCrossProcessCookie.settings), ...lastApplied.keys()]);
    for (const name of names) {
      const value = contextCrossProcessCookie.settings[name];
      if (!Object.hasOwn(applySetting, name) || isApplied(name, value))
        continue;
      if (value === undefined && !lastApplied.has(name))
        continue;
      applySetting[name](value);
      remember(name, value);
    }
    data.frameTree.applyCrossProcessState(
        [...contextCrossProcessCookie.initScripts, ...pageCrossProcessCookie.initScripts],
        [...contextCrossProcessCookie.bindings, ...pageCrossProcessCookie.bindings]);
    const interceptFileChooser = !!pageCrossProcessCookie.interceptFileChooserDialog;
    if (!isApplied('interceptFileChooser', interceptFileChooser)) {
      data.frameTree.setDocShellSettings({ interceptFileChooser });
      remember('interceptFileChooser', interceptFileChooser);
    }
  };
  applySharedState();
  data.channel = new SimpleChannel('', 'process-' + Services.appinfo.processID);
  data.pageAgent = new PageAgent(data.channel, data.frameTree);
  // A document restored from the back-forward cache announces itself when
  // its channel is attached again, before anything it said meanwhile goes
  // out: the client learns the document before it hears it. The detachment
  // and the request to be bound again are JugglerFrameChild's.
  data.channel.onReattached(() => {
    data.frameTree.announceRestoredDocument();
    // The workers of the document are said again once it is the current one (a no-op if the restore did).
    data.pageAgent.leaveCache();
  });
  // Before any command, and before what waited in the queue goes out: see applySharedState.
  data.channel.onReady(applySharedState);

  data.channel.register('', {
    setInitScripts(scripts) {
      data.frameTree.setInitScripts(scripts);
    },

    addBinding({worldName, name, script}) {
      data.frameTree.addBinding(worldName, name, script);
    },

    applyContextSetting({name, value}) {
      if (!Object.hasOwn(applySetting, name))
        return;
      applySetting[name](value);
      remember(name, value);
    },

    setInterceptFileChooserDialog(enabled) {
      data.frameTree.setDocShellSettings({ interceptFileChooser: !!enabled });
      remember('interceptFileChooser', !!enabled);
    },

    ensurePermissions() {
      // noop, just a rountrip.
    },

    // In device pixels: see PageTarget._awaitContentSize. One device pixel of
    // slack, because the parent's size is a CSS size times a scale and the
    // viewer's is the same size after layout snapped it to whole pixels.
    async awaitViewportDimensions({deviceWidth, deviceHeight}) {
      await new Promise(resolve => {
        const listeners = [];
        const check = () => {
          helper.removeListeners(listeners);
          const w = {}, h = {};
          docShell.domWindow.windowUtils.getDocumentViewerSize(w, h);
          if (Math.abs(w.value - deviceWidth) <= 1 && Math.abs(h.value - deviceHeight) <= 1) {
            resolve();
            return;
          }
          // Note: "domWindow" listeners are often removed upon navigation, as specced.
          // To survive viewport changes across navigations, re-install listeners upon commit.
          listeners.push(helper.addEventListener(docShell.domWindow, 'resize', check));
          listeners.push(helper.addEventListener(data.frameTree, 'navigationcommitted', check));
        };
        check();
      });
    },

  });

  return data;
}
