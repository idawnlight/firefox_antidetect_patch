"use strict";

const { TargetRegistry } = ChromeUtils.importESModule('resource://gre/modules/juggler/TargetRegistry.js');
const { Helper } = ChromeUtils.importESModule('resource://gre/modules/juggler/Helper.js');

const helper = new Helper();

export class JugglerFrameParent extends JSWindowActorParent {
  constructor() {
    super();
  }

  receiveMessage(message) {
    if (message?.name !== 'juggler:became-current')
      return;
    if (this._browserId === undefined || !this.manager?.isCurrentGlobal)
      return;
    const registry = TargetRegistry.instance();
    if (!registry?.targetForBrowserId(this._browserId))
      return;
    registry.onActorCreated(this, this._browserId);
  }

  async actorCreated() {
    // Actors are registered per the WindowGlobalParent / WindowGlobalChild pair. We are only
    // interested in those WindowGlobalParent actors that are matching current browsingContext
    // window global.
    // See https://github.com/mozilla/gecko-dev/blob/cd2121e7d83af1b421c95e8c923db70e692dab5f/testing/mochitest/BrowserTestUtils/BrowserTestUtilsParent.sys.mjs#L15
    if (!this.manager?.isCurrentGlobal)
      return;

    // Only interested in main frames for now.
    if (this.browsingContext.parent)
      return;

    this._browserId = this.browsingContext.browserId;
    TargetRegistry.instance()?.onActorCreated(this, this._browserId);
  }

  didDestroy() {
    if (this._browserId === undefined)
      return;
    TargetRegistry.instance()?.onActorDestroyed(this, this._browserId);
  }
}
