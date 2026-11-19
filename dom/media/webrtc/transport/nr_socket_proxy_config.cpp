/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nr_socket_proxy_config.h"

#include "StealthPcUdpProxy.h"
#include "mozilla/net/WebrtcProxyConfig.h"
#include "nsXULAppAPI.h"

namespace mozilla {

class NrSocketProxyConfig::Private {
 public:
  net::WebrtcProxyConfig mProxyConfig;
  RefPtr<net::PcUdpProxy> mUdpProxy;
};

NrSocketProxyConfig::NrSocketProxyConfig(
    const net::WebrtcProxyConfig& aProxyConfig)
    : mPrivate(new Private({aProxyConfig})) {
  // The sockets of the ICE gather are made in the socket process (or in the parent); the lookup starts here, before
  // the gather asks for the first of them.
  if (XRE_IsSocketProcess() || XRE_IsParentProcess()) {
    mPrivate->mUdpProxy = net::PcUdpProxy::Lookup(aProxyConfig.loadInfoArgs());
  }
}

NrSocketProxyConfig::NrSocketProxyConfig(NrSocketProxyConfig&& aOrig)
    : mPrivate(std::move(aOrig.mPrivate)) {}

NrSocketProxyConfig::~NrSocketProxyConfig() = default;

const net::WebrtcProxyConfig& NrSocketProxyConfig::GetConfig() const {
  return mPrivate->mProxyConfig;
}

RefPtr<net::PcUdpProxy> NrSocketProxyConfig::UdpProxy() const {
  return mPrivate->mUdpProxy;
}

bool NrSocketProxyConfig::GetForceProxy() const {
  return mPrivate->mProxyConfig.forceProxy();
}
}  // namespace mozilla
