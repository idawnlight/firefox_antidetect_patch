/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_net_ProxyConfigLookup_h
#define mozilla_net_ProxyConfigLookup_h

#include <functional>

#include "nsCOMPtr.h"
#include "mozilla/Maybe.h"  // STEALTH-HOOK(network/proxy-udp)
#include "mozilla/OriginAttributes.h"  // STEALTH-HOOK(network/doh)
#include "mozilla/net/NeckoChannelParams.h"  // STEALTH-HOOK(network/proxy-udp)
#include "nsIProtocolProxyCallback.h"

class nsIURI;

namespace mozilla {
namespace net {

class ProxyConfigLookup final : public nsIProtocolProxyCallback {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIPROTOCOLPROXYCALLBACK

  // aIsTRRServiceChannel marks the channel this lookup resolves against as a
  // TRR service channel, so that proxy filters can tell DoH traffic apart.
  static nsresult Create(
      std::function<void(nsIProxyInfo*, nsresult)>&& aCallback, nsIURI* aURI,
      uint32_t aProxyResolveFlags, bool aIsTRRServiceChannel = false,
      nsICancelable** aLookupCancellable = nullptr,
      const Maybe<LoadInfoArgs>& aLoadInfo = Nothing(),  // STEALTH-HOOK(network/proxy-udp)
      const Maybe<OriginAttributes>& aOriginAttributes = Nothing());  // STEALTH-HOOK(network/doh)

 private:
  explicit ProxyConfigLookup(
      std::function<void(nsIProxyInfo*, nsresult)>&& aCallback, nsIURI* aURI,
      uint32_t aProxyResolveFlags, bool aIsTRRServiceChannel,
      const Maybe<LoadInfoArgs>& aLoadInfo,  // STEALTH-HOOK(network/proxy-udp)
      const Maybe<OriginAttributes>& aOriginAttributes);  // STEALTH-HOOK(network/doh)
  virtual ~ProxyConfigLookup();
  nsresult DoProxyResolve(nsICancelable** aLookupCancellable);

  std::function<void(nsIProxyInfo*, nsresult)> mCallback;
  nsCOMPtr<nsIURI> mURI;
  uint32_t mProxyResolveFlags;
  bool mIsTRRServiceChannel;
  Maybe<LoadInfoArgs> mLoadInfo;  // STEALTH-HOOK(network/proxy-udp)
  Maybe<OriginAttributes> mOriginAttributes;  // STEALTH-HOOK(network/doh)
};

}  // namespace net
}  // namespace mozilla

#endif  // mozilla_net_ProxyConfigLookup_h
