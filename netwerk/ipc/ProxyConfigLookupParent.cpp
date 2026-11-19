/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ProxyConfigLookupParent.h"

#include "ProxyConfigLookup.h"
#include "nsProxyInfo.h"

namespace mozilla {
namespace net {

ProxyConfigLookupParent::ProxyConfigLookupParent(
    nsIURI* aURI, uint32_t aProxyResolveFlags, bool aIsTRRServiceChannel,
    const Maybe<LoadInfoArgs>& aLoadInfo,  // STEALTH-HOOK(network/proxy-udp)
    const Maybe<OriginAttributes>& aOriginAttributes)  // STEALTH-HOOK(network/doh)
    : mURI(aURI),
      mProxyResolveFlags(aProxyResolveFlags),
      mIsTRRServiceChannel(aIsTRRServiceChannel),
      mLoadInfo(aLoadInfo),  // STEALTH-HOOK(network/proxy-udp)
      mOriginAttributes(aOriginAttributes) {}  // STEALTH-HOOK(network/doh)

ProxyConfigLookupParent::~ProxyConfigLookupParent() = default;

void ProxyConfigLookupParent::DoProxyLookup() {
  RefPtr<ProxyConfigLookupParent> self = this;
  nsresult rv = ProxyConfigLookup::Create(
      [self](nsIProxyInfo* aProxyInfo, nsresult aStatus) {
        if (self->CanSend()) {
          nsTArray<ProxyInfoCloneArgs> proxyInfoArray;
          if (aProxyInfo && NS_SUCCEEDED(aStatus)) {
            nsProxyInfo::SerializeProxyInfo(
                static_cast<nsProxyInfo*>(aProxyInfo), proxyInfoArray);
          }
          (void)Send__delete__(self, proxyInfoArray, aStatus);
        }
      },
      mURI, mProxyResolveFlags, mIsTRRServiceChannel, nullptr,
      mLoadInfo,  // STEALTH-HOOK(network/proxy-udp)
      mOriginAttributes);  // STEALTH-HOOK(network/doh)

  if (NS_WARN_IF(NS_FAILED(rv))) {
    nsTArray<ProxyInfoCloneArgs> emptyArray;
    (void)Send__delete__(self, emptyArray, rv);
  }
}

}  // namespace net
}  // namespace mozilla
