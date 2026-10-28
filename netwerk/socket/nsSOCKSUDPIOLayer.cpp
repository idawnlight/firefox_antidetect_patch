/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsSOCKSUDPIOLayer.h"

#include <atomic>
#include <cstdint>
#include <cstring>

#include "nspr.h"
#include "private/pprio.h"
#include "mozilla/Logging.h"

namespace mozilla {
namespace net {

static LazyLogModule gSocksUdpLog("SOCKS-UDP");
#define LOG(args) MOZ_LOG(gSocksUdpLog, LogLevel::Debug, args)
#define LOGE(args) MOZ_LOG(gSocksUdpLog, LogLevel::Error, args)

namespace {

PRDescIdentity gIdentity = PR_INVALID_IO_LAYER;
PRIOMethods gMethods;
bool gMethodsInitialized = false;

struct SocksUdpInfo {
  PRFileDesc* mTcpControl = nullptr;  // TCP control connection (held open)
  PRNetAddr mRelayAddr;                // Where to send UDP datagrams
  bool mAssociated = false;            // True once UDP ASSOCIATE succeeded
};

bool TcpSendAll(PRFileDesc* fd, const uint8_t* buf, size_t len) {
  size_t sent = 0;
  while (sent < len) {
    PRInt32 n = PR_Send(fd, buf + sent, len - sent, 0,
                       PR_SecondsToInterval(4));
    if (n <= 0) {
      LOGE(("TcpSendAll: PR_Send failed (sent=%zu/%zu, err=%d)",
            sent, len, PR_GetError()));
      return false;
    }
    sent += n;
  }
  return true;
}

bool TcpRecvAll(PRFileDesc* fd, uint8_t* buf, size_t len) {
  size_t got = 0;
  while (got < len) {
    PRInt32 n = PR_Recv(fd, buf + got, len - got, 0,
                       PR_SecondsToInterval(4));
    if (n <= 0) {
      LOGE(("TcpRecvAll: PR_Recv failed (got=%zu/%zu, err=%d)",
            got, len, PR_GetError()));
      return false;
    }
    got += n;
  }
  return true;
}

bool SocksHandshake(PRFileDesc* tcp, const char* user, const char* pass,
                    PRNetAddr* relayOut) {
  bool wantAuth = user && user[0] && pass && pass[0];

  uint8_t greet[4];
  greet[0] = 0x05;  // VER
  greet[1] = wantAuth ? 2 : 1;  // NMETHODS
  greet[2] = 0x00;  // METHOD: no-auth
  uint8_t greetLen = 3;
  if (wantAuth) {
    greet[3] = 0x02;  // METHOD: user/pass
    greetLen = 4;
  }
  if (!TcpSendAll(tcp, greet, greetLen)) return false;

  uint8_t greetReply[2];
  if (!TcpRecvAll(tcp, greetReply, 2)) return false;
  if (greetReply[0] != 0x05) {
    LOGE(("greet: bad VER %02x", greetReply[0]));
    return false;
  }
  uint8_t method = greetReply[1];
  LOG(("greet OK method=%02x", method));

  if (method == 0x02) {
    if (!wantAuth) {
      LOGE(("proxy required user/pass but no creds provided"));
      return false;
    }
    size_t ulen = strlen(user), plen = strlen(pass);
    if (ulen > 255 || plen > 255) return false;
    uint8_t buf[2 + 255 + 1 + 255];
    size_t off = 0;
    buf[off++] = 0x01;  // VER (auth subnegotiation)
    buf[off++] = (uint8_t)ulen;
    memcpy(buf + off, user, ulen); off += ulen;
    buf[off++] = (uint8_t)plen;
    memcpy(buf + off, pass, plen); off += plen;
    if (!TcpSendAll(tcp, buf, off)) return false;
    uint8_t authReply[2];
    if (!TcpRecvAll(tcp, authReply, 2)) return false;
    if (authReply[1] != 0x00) {
      LOGE(("auth failed: status=%02x", authReply[1]));
      return false;
    }
    LOG(("auth OK"));
  } else if (method == 0xff) {
    LOGE(("proxy: no acceptable auth method"));
    return false;
  } else if (method != 0x00) {
    LOGE(("proxy: unsupported auth method %02x", method));
    return false;
  }

  uint8_t assoc[10];
  assoc[0] = 0x05;  // VER
  assoc[1] = 0x03;  // CMD = UDP ASSOCIATE
  assoc[2] = 0x00;  // RSV
  assoc[3] = 0x01;  // ATYP = IPv4
  memset(assoc + 4, 0, 4);  // ADDR = 0.0.0.0
  memset(assoc + 8, 0, 2);  // PORT = 0
  if (!TcpSendAll(tcp, assoc, sizeof(assoc))) return false;

  uint8_t hdr[4];
  if (!TcpRecvAll(tcp, hdr, 4)) return false;
  if (hdr[0] != 0x05 || hdr[1] != 0x00) {
    LOGE(("UDP ASSOCIATE rejected ver=%02x rep=%02x", hdr[0], hdr[1]));
    return false;
  }

  memset(relayOut, 0, sizeof(*relayOut));
  if (hdr[3] == 0x01) {  // IPv4
    uint8_t addr[4 + 2];
    if (!TcpRecvAll(tcp, addr, 6)) return false;
    relayOut->inet.family = PR_AF_INET;
    memcpy(&relayOut->inet.ip, addr, 4);
    memcpy(&relayOut->inet.port, addr + 4, 2);
  } else if (hdr[3] == 0x04) {  // IPv6
    uint8_t addr[16 + 2];
    if (!TcpRecvAll(tcp, addr, 18)) return false;
    relayOut->ipv6.family = PR_AF_INET6;
    memcpy(&relayOut->ipv6.ip, addr, 16);
    memcpy(&relayOut->ipv6.port, addr + 16, 2);
  } else if (hdr[3] == 0x03) {  // domain name
    uint8_t dlen;
    if (!TcpRecvAll(tcp, &dlen, 1)) return false;
    uint8_t buf[256 + 2];
    if (!TcpRecvAll(tcp, buf, dlen + 2)) return false;
    LOGE(("UDP ASSOCIATE returned domain name; not supported"));
    return false;
  } else {
    LOGE(("UDP ASSOCIATE bad ATYP %02x", hdr[3]));
    return false;
  }

  LOG(("UDP ASSOCIATE OK"));
  return true;
}


PRStatus PR_CALLBACK SocksUdpClose(PRFileDesc* fd) {
  auto* info = reinterpret_cast<SocksUdpInfo*>(fd->secret);
  if (info) {
    if (info->mTcpControl) {
      PR_Close(info->mTcpControl);
    }
    delete info;
    fd->secret = nullptr;
  }
  fd->dtor(fd);
  return PR_SUCCESS;
}

PRInt32 PR_CALLBACK SocksUdpSendTo(PRFileDesc* fd, const void* buf,
                                   PRInt32 amount, PRIntn flags,
                                   const PRNetAddr* addr,
                                   PRIntervalTime timeout) {
  auto* info = reinterpret_cast<SocksUdpInfo*>(fd->secret);
  if (!info || !info->mAssociated) {
    PR_SetError(PR_NOT_CONNECTED_ERROR, 0);
    return -1;
  }

  uint8_t header[22];
  size_t hlen = 0;
  header[hlen++] = 0x00;  // RSV
  header[hlen++] = 0x00;  // RSV
  header[hlen++] = 0x00;  // FRAG (no fragmentation)
  if (addr->raw.family == PR_AF_INET) {
    header[hlen++] = 0x01;  // ATYP IPv4
    memcpy(header + hlen, &addr->inet.ip, 4); hlen += 4;
    memcpy(header + hlen, &addr->inet.port, 2); hlen += 2;
  } else if (addr->raw.family == PR_AF_INET6) {
    header[hlen++] = 0x04;  // ATYP IPv6
    memcpy(header + hlen, &addr->ipv6.ip, 16); hlen += 16;
    memcpy(header + hlen, &addr->ipv6.port, 2); hlen += 2;
  } else {
    PR_SetError(PR_ADDRESS_NOT_SUPPORTED_ERROR, 0);
    return -1;
  }

  static thread_local uint8_t scratch[2048 + 22];
  if (amount < 0 || (size_t)amount + hlen > sizeof(scratch)) {
    PR_SetError(PR_BUFFER_OVERFLOW_ERROR, 0);
    return -1;
  }
  memcpy(scratch, header, hlen);
  memcpy(scratch + hlen, buf, amount);

  PRInt32 sent = (fd->lower->methods->sendto)(
      fd->lower, scratch, hlen + amount, flags, &info->mRelayAddr, timeout);
  if (sent < 0) return sent;
  if ((size_t)sent < hlen) {
    PR_SetError(PR_IO_ERROR, 0);
    return -1;
  }
  return sent - (PRInt32)hlen;
}

PRInt32 PR_CALLBACK SocksUdpSend(PRFileDesc* fd, const void* buf,
                                 PRInt32 amount, PRIntn flags,
                                 PRIntervalTime timeout) {
  PR_SetError(PR_NOT_IMPLEMENTED_ERROR, 0);
  return -1;
}

PRInt32 PR_CALLBACK SocksUdpRecvFrom(PRFileDesc* fd, void* buf, PRInt32 amount,
                                     PRIntn flags, PRNetAddr* addr,
                                     PRIntervalTime timeout) {
  auto* info = reinterpret_cast<SocksUdpInfo*>(fd->secret);
  if (!info || !info->mAssociated) {
    PR_SetError(PR_NOT_CONNECTED_ERROR, 0);
    return -1;
  }

  static thread_local uint8_t scratch[2048 + 22];
  PRNetAddr relaySrc;
  PRInt32 got = (fd->lower->methods->recvfrom)(
      fd->lower, scratch, sizeof(scratch), flags, &relaySrc, timeout);
  if (got < 0) return got;
  if (got < 10) {
    PR_SetError(PR_IO_ERROR, 0);
    return -1;
  }

  if (scratch[0] != 0 || scratch[1] != 0) {
    PR_SetError(PR_IO_ERROR, 0);
    return -1;
  }
  if (scratch[2] != 0) {
    PR_SetError(PR_WOULD_BLOCK_ERROR, 0);
    return -1;
  }
  size_t hlen = 4;
  uint8_t atyp = scratch[3];
  if (atyp == 0x01) {  // IPv4
    if (got < 10) { PR_SetError(PR_IO_ERROR, 0); return -1; }
    if (addr) {
      memset(addr, 0, sizeof(*addr));
      addr->inet.family = PR_AF_INET;
      memcpy(&addr->inet.ip, scratch + 4, 4);
      memcpy(&addr->inet.port, scratch + 8, 2);
    }
    hlen += 4 + 2;
  } else if (atyp == 0x04) {  // IPv6
    if (got < 22) { PR_SetError(PR_IO_ERROR, 0); return -1; }
    if (addr) {
      memset(addr, 0, sizeof(*addr));
      addr->ipv6.family = PR_AF_INET6;
      memcpy(&addr->ipv6.ip, scratch + 4, 16);
      memcpy(&addr->ipv6.port, scratch + 20, 2);
    }
    hlen += 16 + 2;
  } else if (atyp == 0x03) {  // domain (rare)
    uint8_t dlen = scratch[4];
    if ((size_t)got < (size_t)5 + dlen + 2) {
      PR_SetError(PR_IO_ERROR, 0); return -1;
    }
    hlen += 1 + dlen + 2;
    if (addr) memset(addr, 0, sizeof(*addr));
  } else {
    PR_SetError(PR_IO_ERROR, 0);
    return -1;
  }

  size_t payload = (size_t)got - hlen;
  if ((size_t)amount < payload) {
    PR_SetError(PR_BUFFER_OVERFLOW_ERROR, 0);
    return -1;
  }
  memcpy(buf, scratch + hlen, payload);
  return (PRInt32)payload;
}

PRInt32 PR_CALLBACK SocksUdpRecv(PRFileDesc* fd, void* buf, PRInt32 amount,
                                 PRIntn flags, PRIntervalTime timeout) {
  return SocksUdpRecvFrom(fd, buf, amount, flags, nullptr, timeout);
}

void EnsureMethods() {
  if (gMethodsInitialized) return;
  gIdentity = PR_GetUniqueIdentity("SOCKS UDP layer");
  gMethods = *PR_GetDefaultIOMethods();
  gMethods.close = SocksUdpClose;
  gMethods.send = SocksUdpSend;
  gMethods.recv = SocksUdpRecv;
  gMethods.sendto = SocksUdpSendTo;
  gMethods.recvfrom = SocksUdpRecvFrom;
  gMethodsInitialized = true;
}

}  // namespace

static std::atomic<bool> sProxyFailed{false};

nsresult nsSOCKSUDPIOLayerAddToSocket(PRFileDesc* aFd, const char* aProxyHost,
                                      int32_t aProxyPort,
                                      const char* aProxyUsername,
                                      const char* aProxyPassword) {
  if (sProxyFailed.load(std::memory_order_relaxed)) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  EnsureMethods();

  PRNetAddr proxyAddr;
  PRStatus rv;
  PRHostEnt host;
  char buf[PR_NETDB_BUF_SIZE];
  rv = PR_GetHostByName(aProxyHost, buf, sizeof(buf), &host);
  if (rv != PR_SUCCESS) {
    LOGE(("PR_GetHostByName(%s) failed: %d", aProxyHost, PR_GetError()));
    return NS_ERROR_UNKNOWN_HOST;
  }
  if (PR_EnumerateHostEnt(0, &host, (PRUint16)aProxyPort, &proxyAddr) <= 0) {
    LOGE(("PR_EnumerateHostEnt: empty"));
    return NS_ERROR_UNKNOWN_HOST;
  }

  PRFileDesc* tcp = PR_OpenTCPSocket(proxyAddr.raw.family);
  if (!tcp) {
    LOGE(("PR_OpenTCPSocket failed"));
    return NS_ERROR_OUT_OF_MEMORY;
  }
  if (PR_Connect(tcp, &proxyAddr, PR_SecondsToInterval(4)) != PR_SUCCESS) {
    LOGE(("TCP connect to proxy failed: %d", PR_GetError()));
    PR_Close(tcp);
    sProxyFailed.store(true, std::memory_order_relaxed);
    return NS_ERROR_CONNECTION_REFUSED;
  }
  LOG(("TCP control connected to %s:%d", aProxyHost, aProxyPort));

  PRNetAddr relay;
  if (!SocksHandshake(tcp, aProxyUsername, aProxyPassword, &relay)) {
    PR_Close(tcp);
    sProxyFailed.store(true, std::memory_order_relaxed);
    return NS_ERROR_FAILURE;
  }

  auto* info = new SocksUdpInfo();
  info->mTcpControl = tcp;
  info->mRelayAddr = relay;
  info->mAssociated = true;

  PRFileDesc* layer = PR_CreateIOLayerStub(gIdentity, &gMethods);
  if (!layer) {
    PR_Close(tcp);
    delete info;
    return NS_ERROR_OUT_OF_MEMORY;
  }
  layer->secret = reinterpret_cast<PRFilePrivate*>(info);

  if (PR_PushIOLayer(aFd, PR_GetLayersIdentity(aFd), layer) != PR_SUCCESS) {
    LOGE(("PR_PushIOLayer failed"));
    PR_Close(tcp);
    delete info;
    PR_Free(layer);
    return NS_ERROR_FAILURE;
  }

  LOG(("SOCKS5 UDP layer pushed onto fd"));
  return NS_OK;
}

}  // namespace net
}  // namespace mozilla
