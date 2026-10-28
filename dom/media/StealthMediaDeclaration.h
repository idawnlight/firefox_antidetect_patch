/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_MEDIA_STEALTHMEDIADECLARATION_H_
#define DOM_MEDIA_STEALTHMEDIADECLARATION_H_

#include "nsStringFwd.h"

namespace mozilla {

// Decode capability declarations supplied through invisible_core preferences.

// Return false for undeclared track MIME types; otherwise return SW/HW flags.
bool StealthDeclaredDecodeSupport(const nsACString& aTrackMimeType,
                                  bool& aSoftware, bool& aHardware);

// Read decodingInfo by container MIME type and codec family.
bool StealthDeclaredDecodingInfo(const nsACString& aContainerMimeType,
                                 const nsACString& aCodec, bool& aSupported,
                                 bool& aSmooth, bool& aPowerEfficient);

}  // namespace mozilla

#endif  // DOM_MEDIA_STEALTHMEDIADECLARATION_H_
