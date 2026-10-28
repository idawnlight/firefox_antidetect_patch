/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_intl_StealthSessionPrefs_h__
#define mozilla_intl_StealthSessionPrefs_h__

#include "nsStringFwd.h"

namespace mozilla::intl {

// Fill empty values from the session's thread-safe static preferences.
void OrSessionLanguage(nsACString& aLanguage);
void OrSessionTimezone(nsAString& aZone);

// The session language as a single tag.
void SessionLanguageTag(nsACString& aTag);

// Extract and trim the first tag of an Accept-Language list.
void PrimaryLanguageTag(const nsACString& aList, nsACString& aTag);

}  // namespace mozilla::intl

#endif  // mozilla_intl_StealthSessionPrefs_h__
