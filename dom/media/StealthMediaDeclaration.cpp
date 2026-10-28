/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "StealthMediaDeclaration.h"

#include "mozilla/StaticPrefs_zoom.h"
#include "nsCharSeparatedTokenizer.h"
#include "nsString.h"

namespace mozilla {

// Entries are newline-separated because codec lists can contain commas.

bool StealthDeclaredDecodeSupport(const nsACString& aTrackMimeType,
                                  bool& aSoftware, bool& aHardware) {
  nsAutoCString spec;
  {
    auto lock = StaticPrefs::zoom_stealth_media_decode_support();
    spec = *lock;
  }
  if (spec.IsEmpty()) {
    return false;
  }
  for (const nsACString& entry : spec.Split('\n')) {
    const int32_t bar = nsCString(entry).FindChar('|');
    if (bar <= 0) {
      continue;
    }
    if (!aTrackMimeType.Equals(Substring(entry, 0, bar))) {
      continue;
    }
    const nsDependentCSubstring flags(Substring(entry, bar + 1));
    if (flags.EqualsLiteral("no")) {
      aSoftware = false;
      aHardware = false;
    } else if (flags.EqualsLiteral("sw")) {
      aSoftware = true;
      aHardware = false;
    } else if (flags.EqualsLiteral("hw")) {
      aSoftware = false;
      aHardware = true;
    } else if (flags.EqualsLiteral("swhw")) {
      aSoftware = true;
      aHardware = true;
    } else {
      // Unrecognized flags leave the platform answer unchanged.
      return false;
    }
    return true;
  }
  return false;
}

bool StealthDeclaredDecodingInfo(const nsACString& aContainerMimeType,
                                 const nsACString& aCodec, bool& aSupported,
                                 bool& aSmooth, bool& aPowerEfficient) {
  nsAutoCString spec;
  {
    auto lock = StaticPrefs::zoom_stealth_media_decoding_info();
    spec = *lock;
  }
  if (spec.IsEmpty()) {
    return false;
  }
  // Match the codec family before the first dot.
  const int32_t dot = nsCString(aCodec).FindChar('.');
  const nsDependentCSubstring family =
      dot > 0 ? Substring(aCodec, 0, uint32_t(dot)) : Substring(aCodec, 0);

  for (const nsACString& entry : spec.Split('\n')) {
    const int32_t bar1 = nsCString(entry).FindChar('|');
    if (bar1 <= 0) {
      continue;
    }
    if (!aContainerMimeType.Equals(Substring(entry, 0, bar1))) {
      continue;
    }
    const nsDependentCSubstring rest(Substring(entry, bar1 + 1));
    const int32_t bar2 = nsCString(rest).FindChar('|');
    if (bar2 <= 0) {
      continue;
    }
    if (!family.Equals(Substring(rest, 0, bar2))) {
      continue;
    }
    const nsDependentCSubstring bits(Substring(rest, bar2 + 1));
    if (bits.Length() != 3) {
      return false;  // malformed: fall through, never a partial answer
    }
    for (uint32_t i = 0; i < 3; ++i) {
      if (bits[i] != '0' && bits[i] != '1') {
        return false;
      }
    }
    aSupported = bits[0] == '1';
    aSmooth = bits[1] == '1';
    aPowerEfficient = bits[2] == '1';
    return true;
  }
  return false;
}

}  // namespace mozilla
