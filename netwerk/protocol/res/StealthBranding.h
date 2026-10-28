/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_net_StealthBranding_h
#define mozilla_net_StealthBranding_h

#include "mozilla/AlreadyAddRefed.h"
#include "nsError.h"
#include "nsStringFwd.h"

class nsIFile;
class nsIURI;

namespace mozilla::net {






void StealthBrandingRegisterPackage(const nsACString& aPackage, nsIURI* aBase);



nsresult StealthBrandingRedirect(nsACString& aResolvedSpec);



bool StealthBrandingIsDeclaredArchive(const nsACString& aSpec);



already_AddRefed<nsIFile> StealthBrandingDeclaredArchive();

}  // namespace mozilla::net

#endif  // mozilla_net_StealthBranding_h
