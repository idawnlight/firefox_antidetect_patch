/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_net_ProxyConfigLookupChild_h
#define mozilla_net_ProxyConfigLookupChild_h

#include <functional>

#include "mozilla/OriginAttributes.h"  // STEALTH-HOOK(network/doh)
#include "mozilla/net/PProxyConfigLookupChild.h"

class nsIProxyInfo;

namespace mozilla {
namespace net {

class ProxyConfigLookupChild final : public PProxyConfigLookupChild {
 public:
  NS_INLINE_DECL_REFCOUNTING(ProxyConfigLookupChild, override)

  static bool Create(nsIURI* aURI, uint32_t aProxyResolveFlags,
                     bool aIsTRRServiceChannel,
                     std::function<void(nsIProxyInfo*, nsresult)>&& aCallback,
                     const Maybe<LoadInfoArgs>& aLoadInfo = Nothing(),  // STEALTH-HOOK(network/proxy-udp)
                     const Maybe<OriginAttributes>& aOriginAttributes = Nothing());  // STEALTH-HOOK(network/doh)

  mozilla::ipc::IPCResult Recv__delete__(
      nsTArray<ProxyInfoCloneArgs>&& aProxyInfo, const nsresult& aResult);

 private:
  explicit ProxyConfigLookupChild(
      std::function<void(nsIProxyInfo*, nsresult)>&& aCallback);
  virtual ~ProxyConfigLookupChild() = default;

  std::function<void(nsIProxyInfo*, nsresult)> mCallback;
};

}  // namespace net
}  // namespace mozilla

#endif  // mozilla_net_ProxyConfigLookupChild_h
