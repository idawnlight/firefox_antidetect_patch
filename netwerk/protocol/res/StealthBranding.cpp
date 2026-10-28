/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/net/StealthBranding.h"

#include "StealthDeclarationGate.h"
#include "mozilla/StaticMutex.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/StaticPrefs_zoom.h"
#include "mozilla/UniquePtr.h"
#include "nsIFile.h"
#include "nsIURI.h"
#include "nsNetUtil.h"
#include "nsString.h"
#include "nsZipArchive.h"

namespace mozilla::net {

namespace {

constexpr auto kBrandingPackage = "branding"_ns;

StaticMutex sMutex MOZ_UNANNOTATED;
StaticAutoPtr<nsCString> sBrandingDir;  // ends with '/'

}  // namespace

bool StealthBrandingIsDeclaredArchive(const nsACString& aSpec) {
  return StringBeginsWith(aSpec, "file:///"_ns) &&
         !StringEndsWith(aSpec, "/"_ns) && aSpec.FindChar('\\') == kNotFound &&
         aSpec.FindChar('!') == kNotFound;
}

already_AddRefed<nsIFile> StealthBrandingDeclaredArchive() {
  if (!gfx::StealthEngineActive()) {
    return nullptr;
  }
  nsAutoCString declared;
  {
    auto lock = StaticPrefs::zoom_stealth_branding_archive();
    declared = *lock;
  }
  if (!StealthBrandingIsDeclaredArchive(declared)) {
    return nullptr;
  }
  nsCOMPtr<nsIFile> archive;
  bool isFile = false, isLink = false;
  if (NS_FAILED(NS_GetFileFromURLSpec(declared, getter_AddRefs(archive))) ||
      NS_FAILED(archive->IsFile(&isFile)) || !isFile ||
      NS_FAILED(archive->IsSymlink(&isLink)) || isLink) {
    return nullptr;
  }
  RefPtr<nsZipArchive> zip = nsZipArchive::OpenArchive(archive);
  if (!zip) {
    return nullptr;
  }
  nsZipFind* rawFind = nullptr;
  if (NS_FAILED(zip->FindInit(nullptr, &rawFind))) {
    return nullptr;
  }
  UniquePtr<nsZipFind> find(rawFind);
  const char* name = nullptr;
  uint16_t nameLength = 0;
  uint32_t entries = 0;
  while (NS_SUCCEEDED(find->FindNext(&name, &nameLength))) {
    if (!nameLength || nsDependentCSubstring(name, nameLength).FindChar('/') !=
                           kNotFound) {
      return nullptr;
    }
    ++entries;
  }
  if (!entries) {
    return nullptr;
  }
  return archive.forget();
}

void StealthBrandingRegisterPackage(const nsACString& aPackage, nsIURI* aBase) {
  if (!aPackage.Equals(kBrandingPackage)) {
    return;
  }
  nsAutoCString branding;
  MOZ_RELEASE_ASSERT(aBase && NS_SUCCEEDED(aBase->GetSpec(branding)) &&
                         StringEndsWith(branding, "/"_ns),
                     "stealth: the branding package is not a directory");
  StaticMutexAutoLock lock(sMutex);
  sBrandingDir = new nsCString(branding);
}

nsresult StealthBrandingRedirect(nsACString& aResolvedSpec) {
  if (!gfx::StealthEngineActive()) {
    return NS_OK;
  }

  size_t brandingLength;
  {
    StaticMutexAutoLock lock(sMutex);
    if (!sBrandingDir || !StringBeginsWith(aResolvedSpec, *sBrandingDir)) {
      return NS_OK;
    }
    brandingLength = sBrandingDir->Length();
  }

  nsAutoCString declared;
  {
    auto lock = StaticPrefs::zoom_stealth_branding_archive();
    declared = *lock;
  }
  if (!StealthBrandingIsDeclaredArchive(declared)) {
    gfx::StealthAssertDeclarationsComplete();
    return NS_ERROR_FILE_NOT_FOUND;
  }

  const nsDependentCSubstring rest(aResolvedSpec, brandingLength);
  nsAutoCString lowered(rest);
  ToLowerCase(lowered);
  if (lowered.Find("..") != kNotFound || lowered.Find("%2e") != kNotFound ||
      lowered.Find("%5c") != kNotFound || lowered.Find("%2f") != kNotFound ||
      lowered.FindChar('\\') != kNotFound || lowered.FindChar('/') != kNotFound) {
    return NS_ERROR_FILE_NOT_FOUND;
  }

  aResolvedSpec.Replace(0, brandingLength,
                        "jar:"_ns + declared + "!/"_ns);
  return NS_OK;
}

}  // namespace mozilla::net
