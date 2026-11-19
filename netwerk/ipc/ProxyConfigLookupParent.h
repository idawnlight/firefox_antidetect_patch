/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_net_ProxyConfigLookupParent_h
#define mozilla_net_ProxyConfigLookupParent_h

#include "mozilla/OriginAttributes.h"  // STEALTH-HOOK(network/doh)
#include "mozilla/net/PProxyConfigLookupParent.h"

class nsIURI;

namespace mozilla {
namespace net {

class ProxyConfigLookupParent final : public PProxyConfigLookupParent {
 public:
  NS_INLINE_DECL_REFCOUNTING(ProxyConfigLookupParent, override)

  ProxyConfigLookupParent(nsIURI* aURI, uint32_t aProxyResolveFlags,
                          bool aIsTRRServiceChannel,
                          const Maybe<LoadInfoArgs>& aLoadInfo,  // STEALTH-HOOK(network/proxy-udp)
                          const Maybe<OriginAttributes>& aOriginAttributes);  // STEALTH-HOOK(network/doh)

  void DoProxyLookup();

 private:
  virtual ~ProxyConfigLookupParent();

  nsCOMPtr<nsIURI> mURI;
  uint32_t mProxyResolveFlags;
  bool mIsTRRServiceChannel;
  Maybe<LoadInfoArgs> mLoadInfo;  // STEALTH-HOOK(network/proxy-udp)
  Maybe<OriginAttributes> mOriginAttributes;  // STEALTH-HOOK(network/doh)
};

}  // namespace net
}  // namespace mozilla

#endif  // mozilla_net_ProxyConfigLookupParent_h
