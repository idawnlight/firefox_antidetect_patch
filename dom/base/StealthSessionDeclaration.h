/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_StealthSessionDeclaration_h
#define mozilla_dom_StealthSessionDeclaration_h

#include "nsStringFwd.h"
#include "prtime.h"

namespace JS {
class RealmOptions;
}

namespace mozilla::dom {

class BrowsingContext;
class Document;

// Main-thread readers: a top context's declaration takes precedence over the
// session. Documents without a context use their scope window's context.
void GetDeclaredTimezone(BrowsingContext* aContext, nsAString& aZone);
void GetDeclaredLanguage(BrowsingContext* aContext, nsACString& aLanguage);
void GetDeclaredTimezone(const Document* aDocument, nsAString& aZone);
void GetDeclaredLanguage(const Document* aDocument, nsACString& aLanguage);

// Any thread. RFP takes precedence; language lists provide their primary tag.
void SetRealmTimeAndLanguage(JS::RealmOptions& aOptions, bool aForceUTC,
                             bool aLocaleEnUS, const nsACString& aLanguage,
                             const nsAString& aZone);

// Main thread. Expand local time in the document's declared zone using ICU.
void ExplodeLocalTime(PRTime aTime, const Document* aDocument,
                      PRExplodedTime* aExploded);

}  // namespace mozilla::dom

#endif  // mozilla_dom_StealthSessionDeclaration_h
