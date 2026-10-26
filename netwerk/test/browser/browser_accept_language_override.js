/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

"use strict";

const PAGE_URL = "https://example.com/browser/netwerk/test/browser/dummy.html";
const SCRIPT_URL =
  "https://example.com/browser/netwerk/test/browser/request_accept_language.sjs";
const languages = ["en-US", "es-ES", "fr-FR"];

add_task(async function test_set_language_override() {
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE_URL);
  const browser = gBrowser.getBrowserForTab(tab);

  await BrowserTestUtils.browserLoaded(browser);

  info("Get default language");
  const defaultLanguage = await getAcceptLanguageHeader(browser);
  const browsingContext = browser.browsingContext;
  const languageOverride = getLanguageToOverride(defaultLanguage);

  info("Set language override");
  browser.browsingContext.languageOverride = languageOverride;
  is(
    await getAcceptLanguageHeader(browser),
    languageOverride,
    '"Accept-Language" header is overridden'
  );

  const secondLanguageOverride = getSecondLanguageToOverride(
    defaultLanguage,
    languageOverride
  );

  info("Set language override again");
  browsingContext.languageOverride = secondLanguageOverride;
  is(
    await getAcceptLanguageHeader(browser),
    secondLanguageOverride,
    '"Accept-Language" header is overridden'
  );

  info("Reset language override");
  browsingContext.languageOverride = "";
  is(
    await getAcceptLanguageHeader(browser),
    defaultLanguage,
    '"Accept-Language" header is not overridden'
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_set_language_override_and_navigate() {
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE_URL);
  const browser = gBrowser.getBrowserForTab(tab);

  await BrowserTestUtils.browserLoaded(browser);

  info("Get default language");
  const defaultLanguage = await getAcceptLanguageHeader(browser);
  const browsingContext = browser.browsingContext;
  const languageOverride = getLanguageToOverride(defaultLanguage);

  info("Set language override");
  browsingContext.languageOverride = languageOverride;
  is(
    await getAcceptLanguageHeader(browser),
    languageOverride,
    '"Accept-Language" header is overridden'
  );

  info("Navigate browsing context");
  const url = "https://example.com/chrome/dom/base/test/dummy.html";
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url, false);
  BrowserTestUtils.startLoadingURIString(browser, url);
  await loaded;
  is(
    await getAcceptLanguageHeader(browser),
    languageOverride,
    '"Accept-Language" header is overridden'
  );

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
  const defaultLanguage1 = await getAcceptLanguageHeader(browser1);

  info("Get default language in the second tab");
  const defaultLanguage2 = await getAcceptLanguageHeader(browser2);

  const browsingContext1 = browser1.browsingContext;
  const languageOverride = getLanguageToOverride(defaultLanguage1);

  info("Set language override to the first tab");
  browsingContext1.languageOverride = languageOverride;
  is(
    await getAcceptLanguageHeader(browser1),
    languageOverride,
    '"Accept-Language" header is overridden'
  );

  info("Make sure that in the second tab language is not overridden");
  browsingContext1.languageOverride = languageOverride;
  is(
    await getAcceptLanguageHeader(browser2),
    defaultLanguage2,
    '"Accept-Language" header is not overridden'
  );

  info("Reset language override");
  browsingContext1.languageOverride = "";
  is(
    await getAcceptLanguageHeader(browser1),
    defaultLanguage1,
    '"Accept-Language" header is not overridden'
  );

  BrowserTestUtils.removeTab(tab1);
  BrowserTestUtils.removeTab(tab2);
});

// STEALTHFOX: the override can carry a language list (juggler.locale.override
// seeds it with the same list as intl.accept_languages). It must go out the
// way Firefox sends that list from intl.accept_languages, q-values included,
// not as the raw list.
add_task(async function test_language_override_list_is_prepared() {
  const list = "it-IT, it, en-US, en";
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE_URL);
  const browser = gBrowser.getBrowserForTab(tab);
  await BrowserTestUtils.browserLoaded(browser);

  info("The header Firefox sends for the list as intl.accept_languages");
  await SpecialPowers.pushPrefEnv({ set: [["intl.accept_languages", list]] });
  const fromPref = await getAcceptLanguageHeader(browser);
  await SpecialPowers.popPrefEnv();
  is(
    fromPref,
    "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "intl.accept_languages is prepared with q-values"
  );

  info("The same list as a language override");
  browser.browsingContext.languageOverride = list;
  is(
    await getAcceptLanguageHeader(browser),
    fromPref,
    '"Accept-Language" from an override list is what the pref would send'
  );
  const languages = await SpecialPowers.spawn(browser, [], () =>
    content.navigator.languages.join("|")
  );
  is(languages, "it-IT|it|en-US|en", "navigator.languages is the list");

  browser.browsingContext.languageOverride = "";
  BrowserTestUtils.removeTab(tab);
});

function getLanguageToOverride(defaultLanguage) {
  return languages.find(lang => lang !== defaultLanguage);
}

function getSecondLanguageToOverride(defaultLanguage, secondLanguage) {
  return languages.find(
    lang => lang !== defaultLanguage && lang !== secondLanguage
  );
}

async function getAcceptLanguageHeader(browser) {
  return SpecialPowers.spawn(browser, [SCRIPT_URL], async url => {
    const response = await content.fetch(url);
    return response.json();
  });
}
