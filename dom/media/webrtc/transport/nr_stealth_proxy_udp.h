/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * The proxy of a PeerConnection, for the UDP sockets of its ICE gather.
 *
 * The rule is made where the socket is born (NrSocket::create), once, from what Firefox itself answers when asked which
 * proxy the document of the PeerConnection uses (PcUdpProxy, from nsIProtocolProxyService and the proxy filters):
 *
 *   no proxy                   the socket is a plain one: UDP goes out as on a machine with none
 *   SOCKS5                     the SOCKS5 UDP layer: UDP leaves by UDP ASSOCIATE (nsSOCKSUDPIOLayer.cpp)
 *   a proxy that has no UDP    the socket whose datagrams go nowhere: no error, no answer, as behind a router that
 *                              drops UDP, so STUN and TURN-over-UDP retransmit and end in their own time
 *
 * There is no filter of the sends after the fact: no datagram of a socket with a proxy is ever sent direct.
 */

#ifndef nr_stealth_proxy_udp_h__
#define nr_stealth_proxy_udp_h__

#include <memory>

#include "StealthPcUdpProxy.h"
#include "nr_socket_proxy_config.h"
#include "nsSOCKSUDPIOLayer.h"
#include "prio.h"

namespace mozilla {

/* NrSocket::create: the layer for the proxy of the PeerConnection on a new UDP socket. True = REFUSED (the layer could
 * not be pushed: the socket must not exist, a plain one would send direct). A socket with no proxy config (not of a
 * PeerConnection) or of a PeerConnection that has no proxy is left plain. The layer is pushed before the bind; the
 * socket takes its road only when it is born (StealthBindAndBear below). */
inline bool StealthUdpProxyAttachRefused(PRFileDesc* aFd, const RefPtr<net::PcUdpProxy>& aProxy) {
  return aProxy && NS_FAILED(net::nsSOCKSUDPIOLayerPushOnUnbornSocket(aFd, aProxy));
}

inline bool StealthUdpProxyAttachRefused(PRFileDesc* aFd,
                                         const std::shared_ptr<NrSocketProxyConfig>& aConfig) {
  RefPtr<net::PcUdpProxy> proxy = aConfig ? aConfig->UdpProxy() : nullptr;
  return StealthUdpProxyAttachRefused(aFd, proxy);
}

bool StealthBind(struct PRFileDesc* aFd, const union PRNetAddr* aAddr);  // nr_stealth_network.h

/* NrSocket::create: the bind of a new socket (StealthBind), and its birth. Only a socket whose bind worked takes the road of its
 * proxy (an association of the pool, the plain socket, or the socket that drops; nothing for a socket with no layer). A port
 * the system refuses (in use, or a range Windows keeps for itself) is a socket that is never born: it is closed, the caller
 * (nr_socket_local_create) takes the next port, and the pool keeps its ready associations for the socket that is born. */
inline bool StealthBindAndBear(PRFileDesc* aFd, const PRNetAddr* aAddr) {
  if (!StealthBind(aFd, aAddr)) {
    return false;
  }
  net::nsSOCKSUDPIOLayerSocketBorn(aFd);
  return true;
}

}  // namespace mozilla

#endif /* nr_stealth_proxy_udp_h__ */
