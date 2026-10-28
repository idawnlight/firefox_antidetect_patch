/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const {XPIProvider} = ChromeUtils.importESModule("resource://gre/modules/addons/XPIProvider.sys.mjs");
const {TargetRegistry} = ChromeUtils.importESModule("resource://gre/modules/juggler/TargetRegistry.js");
const {Helper} = ChromeUtils.importESModule('resource://gre/modules/juggler/Helper.js');
const {PageHandler} = ChromeUtils.importESModule("resource://gre/modules/juggler/protocol/PageHandler.js");
const {AppConstants} = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const helper = new Helper();

export class BrowserHandler {
  constructor(session, dispatcher, targetRegistry, startCompletePromise, onclose) {
    this._session = session;
    this._dispatcher = dispatcher;
    this._targetRegistry = targetRegistry;
    this._enabled = false;
    this._attachToDefaultContext = false;
    this._eventListeners = [];
    this._createdBrowserContextIds = new Set();
    this._attachedSessions = new Map();
    this._onclose = onclose;
    this._startCompletePromise = startCompletePromise;
  }

  async ['Browser.enable']({attachToDefaultContext, userPrefs}) {
    if (userPrefs !== undefined && userPrefs !== null &&
        !(Array.isArray(userPrefs) && userPrefs.length === 0)) {
      throw new Error(
          'Browser.enable no longer applies preferences. They are written into ' +
          'the profile before startup, so a browser started this way already ' +
          'has them. Remove userPrefs from the request.');
    }
    if (this._enabled)
      return;
    await this._startCompletePromise;
    this._enabled = true;
    this._attachToDefaultContext = attachToDefaultContext;

    this._eventListeners = [
      helper.on(this._targetRegistry, TargetRegistry.Events.TargetCreated, this._onTargetCreated.bind(this)),
      helper.on(this._targetRegistry, TargetRegistry.Events.TargetDestroyed, this._onTargetDestroyed.bind(this)),
      helper.on(this._targetRegistry, TargetRegistry.Events.DownloadCreated, this._onDownloadCreated.bind(this)),
      helper.on(this._targetRegistry, TargetRegistry.Events.DownloadFinished, this._onDownloadFinished.bind(this)),
    ];

    for (const target of this._targetRegistry.targets())
      this._onTargetCreated(target);
  }

  async ['Browser.createBrowserContext']({removeOnDetach}) {
    if (!this._enabled)
      throw new Error('Browser domain is not enabled');
    const browserContext = this._targetRegistry.createBrowserContext(removeOnDetach);
    this._createdBrowserContextIds.add(browserContext.browserContextId);
    return {browserContextId: browserContext.browserContextId};
  }

  async ['Browser.removeBrowserContext']({browserContextId}) {
    if (!this._enabled)
      throw new Error('Browser domain is not enabled');
    await this._targetRegistry.browserContextForId(browserContextId).destroy();
    this._createdBrowserContextIds.delete(browserContextId);
  }

  dispose() {
    helper.removeListeners(this._eventListeners);
    for (const [target, session] of this._attachedSessions)
      this._dispatcher.destroySession(session);
    this._attachedSessions.clear();
    for (const browserContextId of this._createdBrowserContextIds) {
      const browserContext = this._targetRegistry.browserContextForId(browserContextId);
      if (browserContext.removeOnDetach)
        browserContext.destroy();
    }
    this._createdBrowserContextIds.clear();
  }

  _shouldAttachToTarget(target) {
    if (this._createdBrowserContextIds.has(target._browserContext.browserContextId))
      return true;
    return this._attachToDefaultContext && target._browserContext === this._targetRegistry.defaultContext();
  }

  _onTargetCreated(target) {
    if (!this._shouldAttachToTarget(target))
      return;
    const channel = target.channel();
    const session = this._dispatcher.createSession();
    this._attachedSessions.set(target, session);
    this._session.emitEvent('Browser.attachedToTarget', {
      sessionId: session.sessionId(),
      targetInfo: target.info()
    });
    session.setHandler(new PageHandler(target, session, channel));
  }

  _onTargetDestroyed(target) {
    const session = this._attachedSessions.get(target);
    if (!session)
      return;
    this._attachedSessions.delete(target);
    this._dispatcher.destroySession(session);
    this._session.emitEvent('Browser.detachedFromTarget', {
      sessionId: session.sessionId(),
      targetId: target.id(),
    });
  }

  _onDownloadCreated(downloadInfo) {
    this._session.emitEvent('Browser.downloadCreated', downloadInfo);
  }

  _onDownloadFinished(downloadInfo) {
    this._session.emitEvent('Browser.downloadFinished', downloadInfo);
  }

  async ['Browser.cancelDownload']({uuid}) {
    await this._targetRegistry.cancelDownload({uuid});
  }

  async ['Browser.newPage']({browserContextId}) {
    const targetId = await this._targetRegistry.newPage({browserContextId});
    return {targetId};
  }

  async ['Browser.close']() {
    let browserWindow = Services.wm.getMostRecentWindow(
      "navigator:browser"
    );
    if (browserWindow && browserWindow.gBrowserInit) {
      // idleTasksFinishedPromise does not resolve when the window
      // is closed early enough, so we race against window closure.
      await Promise.race([
        browserWindow.gBrowserInit.idleTasksFinishedPromise,
        waitForWindowClosed(browserWindow),
      ]);
    }
    await this._startCompletePromise;
    await Promise.all([
      ...XPIProvider.startupPromises,
      ...XPIProvider.enabledAddonsStartupPromises,
    ]);
    this._onclose();
    Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
  }

  async ['Browser.grantPermissions']({browserContextId, origin, permissions}) {
    await this._targetRegistry.browserContextForId(browserContextId).grantPermissions(origin, permissions);
  }

  async ['Browser.resetPermissions']({browserContextId}) {
    this._targetRegistry.browserContextForId(browserContextId).resetPermissions();
  }

  ['Browser.setExtraHTTPHeaders']({browserContextId, headers}) {
    this._targetRegistry.browserContextForId(browserContextId).extraHTTPHeaders = headers;
  }

  ['Browser.clearCache']() {
    // Clearing only the context cache does not work: https://bugzilla.mozilla.org/show_bug.cgi?id=1819147
    Services.cache2.clear();
    ChromeUtils.clearResourceCache({
      types: ["stylesheet"],
    });
  }

  ['Browser.setHTTPCredentials']({browserContextId, credentials}) {
    this._targetRegistry.browserContextForId(browserContextId).httpCredentials = nullToUndefined(credentials);
  }

  async ['Browser.setBrowserProxy']({type, host, port, bypass, username, password}) {
    this._targetRegistry.setBrowserProxy({ type, host, port, bypass, username, password});
  }

  async ['Browser.setContextProxy']({browserContextId, type, host, port, bypass, username, password}) {
    const browserContext = this._targetRegistry.browserContextForId(browserContextId);
    browserContext.setProxy({ type, host, port, bypass, username, password });
  }

  ['Browser.setRequestInterception']({browserContextId, enabled}) {
    this._targetRegistry.browserContextForId(browserContextId).requestInterceptionEnabled = enabled;
  }

  async ['Browser.setServiceWorkersBlocked']({browserContextId, blocked}) {
    await this._targetRegistry.browserContextForId(browserContextId).setServiceWorkersBlocked(blocked);
  }

  ['Browser.setCacheDisabled']({browserContextId, cacheDisabled}) {
    this._targetRegistry.browserContextForId(browserContextId).setCacheDisabled(cacheDisabled);
  }

  ['Browser.setIgnoreHTTPSErrors']({browserContextId, ignoreHTTPSErrors}) {
    this._targetRegistry.browserContextForId(browserContextId).setIgnoreHTTPSErrors(nullToUndefined(ignoreHTTPSErrors));
  }

  ['Browser.setDownloadOptions']({browserContextId, downloadOptions}) {
    this._targetRegistry.browserContextForId(browserContextId).downloadOptions = nullToUndefined(downloadOptions);
  }

  async ['Browser.setGeolocationOverride']({browserContextId, geolocation}) {
    await this._targetRegistry.browserContextForId(browserContextId).applySetting('geolocation', nullToUndefined(geolocation));
  }

  async ['Browser.setOnlineOverride']({browserContextId, override}) {
    const forceOffline = override === 'offline';
    await this._targetRegistry.browserContextForId(browserContextId).setForceOffline(forceOffline);
  }

  async ['Browser.setColorScheme']({browserContextId, colorScheme}) {
    await this._targetRegistry.browserContextForId(browserContextId).setColorScheme(nullToUndefined(colorScheme));
  }

  _rifiutaSeNonNeutro(nome, valore, neutro) {
    if (valore === null || valore === undefined || valore === neutro)
      return;
    throw new Error(
        `Browser.${nome}: '${valore}' non si imposta dal protocollo. ` +
        `L'apparato di override delle media feature non esiste piu' in questa ` +
        `build; il solo valore accettato e' '${neutro}', che e' quello che il ` +
        `browser riporta davvero. Per cambiarlo si dichiara la preferenza in ` +
        `invisible_core, non si manda questo comando.`);
  }

  async ['Browser.setReducedMotion']({reducedMotion}) {
    this._rifiutaSeNonNeutro('setReducedMotion', reducedMotion, 'no-preference');
  }

  async ['Browser.setForcedColors']({forcedColors}) {
    this._rifiutaSeNonNeutro('setForcedColors', forcedColors, 'none');
  }

  async ['Browser.setContrast']({contrast}) {
    this._rifiutaSeNonNeutro('setContrast', contrast, 'no-preference');
  }
  async ['Browser.setUserAgentOverride']({browserContextId, userAgent}) {
    await this._targetRegistry.browserContextForId(browserContextId).setDefaultUserAgent(userAgent);
  }
  async ['Browser.setBypassCSP']({browserContextId, bypassCSP}) {
    await this._targetRegistry.browserContextForId(browserContextId).applySetting('bypassCSP', nullToUndefined(bypassCSP));
  }

  async ['Browser.setJavaScriptDisabled']({browserContextId, javaScriptDisabled}) {
    await this._targetRegistry.browserContextForId(browserContextId).applySetting('javaScriptDisabled', nullToUndefined(javaScriptDisabled));
  }

  async ['Browser.setLocaleOverride']({browserContextId, locale}) {
    this._targetRegistry.browserContextForId(browserContextId).setLanguageOverride(nullToUndefined(locale));
  }

  async ['Browser.setTimezoneOverride']({browserContextId, timezoneId}) {
    this._targetRegistry.browserContextForId(browserContextId).setTimezoneOverride(nullToUndefined(timezoneId));
  }

  async ['Browser.setTouchOverride']({browserContextId, hasTouch}) {
    await this._targetRegistry.browserContextForId(browserContextId).setTouchOverride(nullToUndefined(hasTouch));
  }

  async ['Browser.setDefaultViewport']({browserContextId, viewport}) {
    await this._targetRegistry.browserContextForId(browserContextId).setDefaultViewport(nullToUndefined(viewport));
  }

  async ['Browser.setInitScripts']({browserContextId, scripts}) {
    await this._targetRegistry.browserContextForId(browserContextId).setInitScripts(scripts);
  }

  async ['Browser.addBinding']({browserContextId, worldName, name, script}) {
    await this._targetRegistry.browserContextForId(browserContextId).addBinding(worldName, name, script);
  }

  ['Browser.setCookies']({browserContextId, cookies}) {
    this._targetRegistry.browserContextForId(browserContextId).setCookies(cookies);
  }

  ['Browser.clearCookies']({browserContextId}) {
    this._targetRegistry.browserContextForId(browserContextId).clearCookies();
  }

  ['Browser.getCookies']({browserContextId}) {
    const cookies = this._targetRegistry.browserContextForId(browserContextId).getCookies();
    return {cookies};
  }

  async ['Browser.getInfo']() {
    const version = AppConstants.MOZ_APP_VERSION_DISPLAY;
    const userAgent = Components.classes["@mozilla.org/network/protocol;1?name=http"]
                                .getService(Components.interfaces.nsIHttpProtocolHandler)
                                .userAgent;
    return {version: 'Firefox/' + version, userAgent};
  }
}

async function waitForWindowClosed(browserWindow) {
  if (browserWindow.closed)
    return;
  await new Promise((resolve => {
    const listener = {
      onCloseWindow: window => {
        let domWindow;
        if (window instanceof Ci.nsIAppWindow)
          domWindow = window.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowInternal || Ci.nsIDOMWindow);
        else
          domWindow = window;
        if (domWindow === browserWindow) {
          Services.wm.removeListener(listener);
          resolve();
        }
      },
    };
    Services.wm.addListener(listener);
  }));
}

function nullToUndefined(value) {
  return value === null ? undefined : value;
}
