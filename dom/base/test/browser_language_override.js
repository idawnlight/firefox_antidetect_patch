/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

"use strict";

const PAGE_URL = "https://example.com/chrome/dom/base/test/file_empty.html";
const languages = ["en-US", "es-ES", "fr-FR"];

add_task(async function test_set_language_override() {
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE_URL);
  const browser = gBrowser.getBrowserForTab(tab);

  await BrowserTestUtils.browserLoaded(browser);

  info("Get default language");
  const defaultLanguage = await getIntlLanguage(browser);
  const defaultNavigatorLanguage = await getNavigatorLanguage(browser);

  const browsingContext = browser.browsingContext;

  const languageOverride = getLanguageToOverride(defaultLanguage);

  info("Set language override");
  browsingContext.languageOverride = languageOverride;
  await assertLanguageOverridden(browser, languageOverride);

  const secondLanguageOverride = getSecondLanguageToOverride(
    defaultLanguage,
    languageOverride
  );

  info("Set language override again");
  browsingContext.languageOverride = secondLanguageOverride;
  await assertLanguageOverridden(browser, secondLanguageOverride);

  info("Reset language override");
  browsingContext.languageOverride = "";
  await assertLanguageIsNotOverridden(
    browser,
    defaultLanguage,
    defaultNavigatorLanguage
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_set_language_override_and_navigate() {
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE_URL);
  const browser = gBrowser.getBrowserForTab(tab);

  await BrowserTestUtils.browserLoaded(browser);

  info("Get default language");
  const defaultLanguage = await getIntlLanguage(browser);

  const browsingContext = browser.browsingContext;

  const languageOverride = getLanguageToOverride(defaultLanguage);

  info("Set language override");
  browsingContext.languageOverride = languageOverride;
  await assertLanguageOverridden(browser, languageOverride);

  info("Navigate browsing context");
  const url = "https://example.com/chrome/dom/base/test/dummy.html";
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url, false);
  BrowserTestUtils.startLoadingURIString(browser, url);
  await loaded;
  await assertLanguageOverridden(browser, languageOverride);

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_set_language_override_in_different_contexts() {
  const tab1 = BrowserTestUtils.addTab(gBrowser, PAGE_URL);
  const browser1 = gBrowser.getBrowserForTab(tab1);

  await BrowserTestUtils.browserLoaded(browser1);

  const tab2 = BrowserTestUtils.addTab(gBrowser, PAGE_URL);
  const browser2 = gBrowser.getBrowserForTab(tab2);

  await BrowserTestUtils.browserLoaded(browser2);

  info("Get default language in the first tab");
  const defaultLanguage1 = await getIntlLanguage(browser1);
  const defaultNavigatorLanguage1 = await getNavigatorLanguage(browser1);

  info("Get default language in the second tab");
  const defaultLanguage2 = await getIntlLanguage(browser2);
  const defaultNavigatorLanguage2 = await getNavigatorLanguage(browser2);

  const browsingContext1 = browser1.browsingContext;

  const languageOverride = getLanguageToOverride(defaultLanguage1);

  info("Set language override to the first tab");
  browsingContext1.languageOverride = languageOverride;
  await assertLanguageOverridden(browser1, languageOverride);

  info("Make sure that in the second tab language is not overridden");
  await assertLanguageIsNotOverridden(
    browser2,
    defaultLanguage2,
    defaultNavigatorLanguage2
  );

  info("Reset language override");
  browsingContext1.languageOverride = "";
  await assertLanguageIsNotOverridden(
    browser1,
    defaultLanguage1,
    defaultNavigatorLanguage1
  );

  BrowserTestUtils.removeTab(tab1);
  BrowserTestUtils.removeTab(tab2);
});

add_task(async function test_language_override_reaches_workers() {
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE_URL);
  const browser = gBrowser.getBrowserForTab(tab);

  await BrowserTestUtils.browserLoaded(browser);

  const defaultLanguage = await getIntlLanguage(browser);
  const languageOverride = getLanguageToOverride(defaultLanguage);

  info("Set language override before the workers are created");
  browser.browsingContext.languageOverride = languageOverride;
  await assertLanguageOverridden(browser, languageOverride);

  for (const kind of ["dedicated", "nested", "shared"]) {
    const result = await getWorkerLanguages(browser, kind);
    is(
      result.intl,
      languageOverride,
      `Intl locale in a ${kind} worker follows the language override`
    );
    is(
      result.language,
      languageOverride,
      `navigator.language in a ${kind} worker follows the language override`
    );
    Assert.deepEqual(
      result.languages,
      [languageOverride],
      `navigator.languages in a ${kind} worker follows the language override`
    );
  }

  BrowserTestUtils.removeTab(tab);
});

async function getWorkerLanguages(browser, kind) {
  return SpecialPowers.spawn(browser, [kind], async workerKind => {
    const probe = `
      function probe() {
        return {
          intl: Intl.DateTimeFormat().resolvedOptions().locale,
          language: navigator.language,
          languages: Array.from(navigator.languages),
        };
      }
    `;
    const blobURL = source =>
      content.URL.createObjectURL(
        new content.Blob([source], { type: "text/javascript" })
      );
    const receive = target =>
      new Promise(resolve => {
        target.addEventListener(
          "message",
          event => resolve(JSON.parse(content.JSON.stringify(event.data))),
          { once: true }
        );
      });

    if (workerKind === "shared") {
      const worker = new content.SharedWorker(
        blobURL(
          probe + "onconnect = e => e.ports[0].postMessage(probe());"
        )
      );
      const received = receive(worker.port);
      worker.port.start();
      return received;
    }

    let source = probe + "postMessage(probe());";
    if (workerKind === "nested") {
      const inner = blobURL(source);
      source = `const w = new Worker("${inner}");
                w.onmessage = e => postMessage(e.data);`;
    }
    const worker = new content.Worker(blobURL(source));
    return receive(worker);
  });
}

function getLanguageToOverride(defaultLanguage) {
  return languages.find(lang => lang !== defaultLanguage);
}

function getSecondLanguageToOverride(defaultLanguage, secondLanguage) {
  return languages.find(
    lang => lang !== defaultLanguage && lang !== secondLanguage
  );
}

async function getIntlLanguage(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    return content.eval(`Intl.DateTimeFormat().resolvedOptions().locale`);
  });
}

async function getNavigatorLanguage(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    return content.eval(`window.navigator.language`);
  });
}

async function getNavigatorLanguages(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    return content.eval(`window.navigator.languages`);
  });
}

async function assertLanguageOverridden(browser, languageOverride) {
  is(
    await getIntlLanguage(browser),
    languageOverride,
    "new Intl.DateTimeFormat().resolvedOptions().locale is overridden"
  );

  is(
    await getNavigatorLanguage(browser),
    languageOverride,
    "navigator.language is overridden"
  );

  const navigatorLanguages = await getNavigatorLanguages(browser);
  is(
    navigatorLanguages.includes(languageOverride),
    true,
    "navigator.languages is overridden"
  );
}

async function assertLanguageIsNotOverridden(
  browser,
  defaultLanguage,
  defaultNavigatorLanguage
) {
  is(
    await getIntlLanguage(browser),
    defaultLanguage,
    "new Intl.DateTimeFormat().resolvedOptions().locale is not overridden"
  );

  is(
    await getNavigatorLanguage(browser),
    defaultNavigatorLanguage,
    "navigator.language is not overridden"
  );

  const navigatorLanguages = await getNavigatorLanguages(browser);
  is(
    navigatorLanguages.includes(defaultNavigatorLanguage),
    true,
    "navigator.languages is not overridden"
  );
}
