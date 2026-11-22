/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// STEALTH-HOOK(network/proxy-udp)
// STEALTH-HOOK(fingerprint/webrtc/declared-network)
//
// The sockets of a PeerConnection are born in NrSocket::create, and two rules are made there:
//
//   * the proxy: the UDP socket of a PeerConnection gets the layer of its proxy (StealthUdpProxyAttachRefused, the line after
//     PR_OpenUDPSocket). Without that line the socket of a PeerConnection behind a proxy that carries no UDP is a plain one, and its
//     datagrams go out direct, around the proxy: an IP leak. The test makes a real NrSocket under a real config (the lookup of the
//     proxy made as the PeerConnection makes it) and looks at where its datagram goes, with the same socket under "no proxy" as the
//     control (a laboratory in which a direct datagram does not arrive proves nothing).
//   * the port: a port that another socket holds is R_ALREADY (the caller takes the next one, as the kernel would), never R_INTERNAL
//     (REVIEW-63 #12). The answer "access denied" (a privileged port for a user that is not root on Linux; the ranges Windows
//     reserves) is the same: it is injected at the bind (StealthFailNextBindForTests), so it is asserted on every machine, and the scan of
//     the system's own refused port stays as a second test where the machine gives one.
//   * the birth: only a socket whose bind worked takes the road of its proxy (StealthBindAndBear). A refused port takes nothing from the
//     pool of associations, so the socket born after a run of refused ports finds the ready ones.
//
// Pure behaviour: the NrSocket is the real one, on the socket thread, and the receiver is a plain NSPR socket.

#include "gtest/gtest.h"

#include <atomic>
#include <cstring>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// nICEr is C++: its headers are not wrapped in extern "C".
// clang-format off
#include <csi_platform.h>
#include "nr_api.h"
#include "transport_addr.h"
// clang-format on

#include "StealthTestProxyKit.h"
#include "nr_stealth_network.h"
#include "nsSOCKSUDPIOLayer.h"
#include "mozilla/RefPtr.h"
#include "mozilla/SyncRunnable.h"
#include "nr_socket_prsock.h"
#include "nr_socket_proxy_config.h"
#include "nsCOMPtr.h"
#include "nsIEventTarget.h"
#include "nsISocketTransportService.h"
#include "nsNetCID.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsThreadUtils.h"
#include "prerror.h"
#include "prio.h"
#include "prnetdb.h"

namespace mozilla {
namespace {

// Runs aFn on the socket transport thread and returns when it has run.
template <typename F>
void OnSocketThread(F&& aFn) {
  nsresult rv;
  nsCOMPtr<nsISocketTransportService> sts = do_GetService(NS_SOCKETTRANSPORTSERVICE_CONTRACTID, &rv);
  ASSERT_TRUE(NS_SUCCEEDED(rv) && sts);
  nsCOMPtr<nsIEventTarget> target = do_QueryInterface(sts);
  ASSERT_TRUE(target);
  ASSERT_EQ(NS_OK, SyncRunnable::DispatchToThread(target, NS_NewRunnableFunction("StealthNrSocketBirth", std::forward<F>(aFn))));
}

nr_transport_addr UdpAddr(const char* aIp, uint16_t aPort) {
  nr_transport_addr a;
  EXPECT_EQ(0, nr_str_port_to_transport_addr(aIp, nullptr, aPort, IPPROTO_UDP, &a));
  return a;
}

// A plain NSPR UDP socket bound to the wildcard, on a port the system chose.
PRFileDesc* PlainSocketOnAnyPort() {
  PRFileDesc* s = PR_NewUDPSocket();
  PRNetAddr any;
  PR_InitializeNetAddr(PR_IpAddrAny, 0, &any);
  EXPECT_EQ(PR_SUCCESS, PR_Bind(s, &any));
  return s;
}

uint16_t PortOf(PRFileDesc* aSocket) {
  PRNetAddr bound;
  EXPECT_EQ(PR_SUCCESS, PR_GetSockName(aSocket, &bound));
  return PR_ntohs(bound.inet.port);
}

// The address of this host that is not loopback (a datagram to the loopback goes direct in every state): where a receiver can stand.
std::string HostAddressString() {
  PRNetAddr probe;
  PR_InitializeNetAddr(PR_IpAddrNull, 9, &probe);
  probe.inet.ip = PR_htonl(0xC0000201);  // 192.0.2.1: nothing is sent
  PRFileDesc* s = PR_NewUDPSocket();
  PRNetAddr mine;
  PR_InitializeNetAddr(PR_IpAddrAny, 0, &mine);
  if (PR_Connect(s, &probe, PR_INTERVAL_NO_WAIT) == PR_SUCCESS) {
    PR_GetSockName(s, &mine);
  }
  PR_Close(s);
  char text[64] = {0};
  EXPECT_EQ(PR_SUCCESS, PR_NetAddrToString(&mine, text, sizeof(text)));
  return text;
}

// A port the system refuses a plain bind to with 'access denied' (0 if it refuses none): the privileged ports where the user is not root, then
// the end of the dynamic range, where Windows keeps its reserved ranges.
uint16_t PortThePlainBindOfThisUserIsDenied() {
  PRFileDesc* probe = PR_NewUDPSocket();
  uint16_t found = 0;
  for (uint32_t port = 1; port < 65536 && found == 0; ++port) {
    if (port == 1024) {
      port = 49152;
    }
    PRNetAddr addr;
    PR_InitializeNetAddr(PR_IpAddrAny, static_cast<uint16_t>(port), &addr);
    if (PR_Bind(probe, &addr) == PR_SUCCESS) {
      PR_Close(probe);  // a socket that is bound cannot try another port
      probe = PR_NewUDPSocket();
    } else if (PR_GetError() == PR_NO_ACCESS_RIGHTS_ERROR) {
      found = static_cast<uint16_t>(port);
    }
  }
  PR_Close(probe);
  return found;
}

// Whether a datagram sent by a real NrSocket made under aConfig reaches a receiver at the host's own (non-loopback) address.
bool DatagramOfANrSocketArrives(const std::shared_ptr<NrSocketProxyConfig>& aConfig) {
  const std::string host = HostAddressString();
  EXPECT_NE(std::string("0.0.0.0"), host) << "this host has no address to a route: a receiver cannot stand";
  // The engine drops, and says it sent, a datagram to a port Necko bans (NrSocketBase::IsForbiddenAddress): a receiver on one would make
  // the Blocked test green for a wrong reason. A port the engine would drop is not taken.
  PRFileDesc* receiver = PlainSocketOnAnyPort();
  nr_transport_addr to = UdpAddr(host.c_str(), PortOf(receiver));
  for (int attempt = 0; attempt < 20 && NrSocketBase::IsForbiddenAddress(&to); ++attempt) {
    PR_Close(receiver);
    receiver = PlainSocketOnAnyPort();
    to = UdpAddr(host.c_str(), PortOf(receiver));
  }
  EXPECT_FALSE(NrSocketBase::IsForbiddenAddress(&to)) << "no receiver port the engine would not drop was found";
  nr_transport_addr local = UdpAddr("0.0.0.0", 0);

  RefPtr<NrSocket> nrSocket = new NrSocket(aConfig);
  int created = -1;
  OnSocketThread([&] {
    created = nrSocket->create(&local);
    if (created == 0) {
      (void)nrSocket->sendto("ping", 4, 0, &to);
    }
  });
  EXPECT_EQ(0, created) << "the socket of the PeerConnection could not be born";

  bool arrived = false;
  if (created == 0) {
    char buf[16];
    PRNetAddr from;
    arrived = PR_RecvFrom(receiver, buf, sizeof(buf), 0, &from, PR_MillisecondsToInterval(500)) > 0;
  }
  OnSocketThread([&] { nrSocket->close(); });
  PR_Close(receiver);
  return arrived;
}

// A NrSocket whose file descriptor the test can ask the layer about.
class NrSocketWithItsFd final : public NrSocket {
 public:
  explicit NrSocketWithItsFd(const std::shared_ptr<NrSocketProxyConfig>& aConfig) : NrSocket(aConfig) {}
  PRFileDesc* Fd() const { return fd_; }
};

bool RecvAll(PRFileDesc* aFd, uint8_t* aBuf, int32_t aLen) {
  int32_t got = 0;
  while (got < aLen) {
    int32_t n = PR_Recv(aFd, aBuf + got, aLen - got, 0, PR_SecondsToInterval(5));
    if (n <= 0) {
      return false;
    }
    got += n;
  }
  return true;
}

// A SOCKS5 proxy that carries UDP, for one test: "no authentication", every UDP ASSOCIATE answered with a relay on the loopback, the
// control connection kept until the client closes it (RFC 1928 section 6). It counts the associations it answered.
class UdpCarryingSocks final {
 public:
  UdpCarryingSocks() {
    mListener = PR_NewTCPSocket();
    PRNetAddr addr;
    PR_InitializeNetAddr(PR_IpAddrLoopback, 0, &addr);
    EXPECT_EQ(PR_SUCCESS, PR_Bind(mListener, &addr));
    EXPECT_EQ(PR_SUCCESS, PR_Listen(mListener, 16));
    PRNetAddr bound;
    EXPECT_EQ(PR_SUCCESS, PR_GetSockName(mListener, &bound));
    mPort = PR_ntohs(bound.inet.port);
    mRelay = PR_NewUDPSocket();
    EXPECT_EQ(PR_SUCCESS, PR_Bind(mRelay, &addr));
    EXPECT_EQ(PR_SUCCESS, PR_GetSockName(mRelay, &bound));
    mRelayPort = bound.inet.port;  // network order, as the reply carries it
    mAcceptor = std::thread([this] { Accept(); });
  }
  ~UdpCarryingSocks() {
    mStop = true;
    mAcceptor.join();
    for (std::thread& client : mClients) {
      client.join();
    }
    PR_Close(mListener);
    PR_Close(mRelay);
  }
  uint16_t Port() const { return mPort; }
  uint32_t Answered() const { return mAnswered; }

 private:
  void Accept() {
    while (!mStop) {
      PRNetAddr from;
      PRFileDesc* client = PR_Accept(mListener, &from, PR_MillisecondsToInterval(50));
      if (client) {
        mClients.emplace_back([this, client] { Serve(client); });
      }
    }
  }
  void Serve(PRFileDesc* aClient) {
    uint8_t greeting[2];
    uint8_t methods[255];
    uint8_t associate[10];
    const uint8_t chosen[2] = {0x05, 0x00};
    if (RecvAll(aClient, greeting, 2) && RecvAll(aClient, methods, greeting[1]) &&
        PR_Send(aClient, chosen, 2, 0, PR_SecondsToInterval(5)) == 2 && RecvAll(aClient, associate, sizeof(associate))) {
      uint8_t reply[10] = {0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0};
      std::memcpy(reply + 8, &mRelayPort, 2);
      if (PR_Send(aClient, reply, sizeof(reply), 0, PR_SecondsToInterval(5)) == static_cast<int32_t>(sizeof(reply))) {
        ++mAnswered;
        uint8_t b;
        while (!mStop) {
          int32_t n = PR_Recv(aClient, &b, 1, 0, PR_MillisecondsToInterval(20));
          if (n == 0 || (n < 0 && PR_GetError() != PR_IO_TIMEOUT_ERROR)) {
            break;
          }
        }
      }
    }
    PR_Close(aClient);
  }

  PRFileDesc* mListener = nullptr;
  PRFileDesc* mRelay = nullptr;
  uint16_t mPort = 0;
  uint16_t mRelayPort = 0;
  std::thread mAcceptor;
  std::vector<std::thread> mClients;  // only the acceptor adds; the destructor joins them after the acceptor is gone
  std::atomic<bool> mStop{false};
  std::atomic<uint32_t> mAnswered{0};
};

// Setup only (never a verdict): until aDone, at most aMs.
template <typename F>
bool WaitFor(F&& aDone, uint32_t aMs) {
  for (uint32_t waited = 0; !aDone(); waited += 10) {
    if (waited >= aMs) {
      return false;
    }
    PR_Sleep(PR_MillisecondsToInterval(10));
  }
  return true;
}

}  // namespace

TEST(StealthNrSocketBirth, TheControlASocketOfAPeerConnectionWithNoProxyIsHeardDirect)
{
  stealthtest::SessionProxyScope scope(stealthtest::ProxyOfTheSession::None);
  ASSERT_TRUE(scope.Ok());
  std::shared_ptr<NrSocketProxyConfig> config = stealthtest::MakeConfigAfterTheLookup();
  ASSERT_TRUE(config);
  EXPECT_TRUE(DatagramOfANrSocketArrives(config))
      << "the laboratory does not see a direct datagram: the test below would prove nothing";
}

TEST(StealthNrSocketBirth, ASocketOfAPeerConnectionBehindAProxyThatCarriesNoUdpSendsNothingDirect)
{
  stealthtest::SessionProxyScope scope(stealthtest::ProxyOfTheSession::HttpWithoutUdp);
  ASSERT_TRUE(scope.Ok());
  std::shared_ptr<NrSocketProxyConfig> config = stealthtest::MakeConfigAfterTheLookup();
  ASSERT_TRUE(config);
  EXPECT_FALSE(DatagramOfANrSocketArrives(config))
      << "a datagram of a PeerConnection behind a proxy without UDP went out direct: NrSocket::create does not put the layer on its "
         "socket";
}

TEST(StealthNrSocketBirth, APortAnotherSocketHoldsIsAlreadyAndTheNextOneIsBorn)
{
  PRFileDesc* holder = PlainSocketOnAnyPort();
  const uint16_t busy = PortOf(holder);
  PRFileDesc* spare = PlainSocketOnAnyPort();
  const uint16_t freePort = PortOf(spare);
  PR_Close(spare);  // a port the system just gave and nobody holds

  nr_transport_addr busyAddr = UdpAddr("0.0.0.0", busy);
  nr_transport_addr freeAddr = UdpAddr("0.0.0.0", freePort);
  RefPtr<NrSocket> refused = new NrSocket();
  RefPtr<NrSocket> born = new NrSocket();
  int busyResult = -1;
  int freeResult = -1;
  OnSocketThread([&] {
    busyResult = refused->create(&busyAddr);
    freeResult = born->create(&freeAddr);
  });
  EXPECT_EQ(R_ALREADY, busyResult) << "a port another socket holds is R_ALREADY (the caller takes the next one), not a failure of the gather";
  EXPECT_EQ(0, freeResult) << "the next port is taken as the kernel would";
  OnSocketThread([&] { born->close(); });  // the refused one never was born: it is only released, close() is for a socket that was
  PR_Close(holder);
}

// REVIEW-63 #12, on every machine: the system answers a bind with 'access denied' (PR_NO_ACCESS_RIGHTS_ERROR) and the socket is R_ALREADY, so the
// caller (nr_socket_local_create) takes the next port. The answer is INJECTED at the bind of NrSocket::create (StealthFailNextBindForTests), because
// a real one needs a machine that refuses a port (a user that is not root on Linux; a Windows with a reserved range): a runner with neither
// asserted nothing. The scan of real ports below stays as the same check against the system's own answer, where the machine gives one.
TEST(StealthNrSocketBirth, AnAccessDeniedBindIsAlreadyAndThePortAfterItIsBorn)
{
  PRFileDesc* first = PlainSocketOnAnyPort();
  PRFileDesc* second = PlainSocketOnAnyPort();
  const uint16_t deniedPort = PortOf(first);
  const uint16_t nextPort = PortOf(second);
  PR_Close(first);
  PR_Close(second);  // two ports the system just gave and nobody holds

  nr_transport_addr denied = UdpAddr("0.0.0.0", deniedPort);
  nr_transport_addr next = UdpAddr("0.0.0.0", nextPort);
  RefPtr<NrSocket> refused = new NrSocket();
  RefPtr<NrSocket> born = new NrSocket();
  int refusedResult = -1;
  int bornResult = -1;
  StealthFailNextBindForTests(PR_NO_ACCESS_RIGHTS_ERROR);
  OnSocketThread([&] {
    refusedResult = refused->create(&denied);
    bornResult = born->create(&next);  // the refusal was for ONE bind: the next create binds for real
  });
  StealthFailNextBindForTests(0);
  EXPECT_EQ(R_ALREADY, refusedResult) << "'access denied' on a bind is R_ALREADY (the caller takes the next port), not R_INTERNAL";
  EXPECT_EQ(0, bornResult) << "the port after a refused one is taken as the kernel would, and the refusal is not kept for it";
  if (bornResult == 0) {
    OnSocketThread([&] { born->close(); });  // the refused one never was born: it is only released
  }
}

// The mapping is specific: 'in use' is R_ALREADY too (the caller takes the next one), any other answer of a bind is a failure of the gather.
TEST(StealthNrSocketBirth, OnlyAPortThatIsNotAvailableIsAlreadyAnyOtherBindFailureIsInternal)
{
  PRFileDesc* spare = PlainSocketOnAnyPort();
  const uint16_t port = PortOf(spare);
  PR_Close(spare);
  nr_transport_addr addr = UdpAddr("0.0.0.0", port);
  struct Case {
    PRErrorCode error;
    int expected;
    const char* why;
  };
  const Case cases[] = {{PR_ADDRESS_IN_USE_ERROR, R_ALREADY, "a port another socket holds"},
                        {PR_NO_ACCESS_RIGHTS_ERROR, R_ALREADY, "a port the system keeps from this user"},
                        {PR_INVALID_ARGUMENT_ERROR, R_INTERNAL, "an error that is not about the port"}};
  for (const Case& c : cases) {
    RefPtr<NrSocket> nrSocket = new NrSocket();
    int result = -1;
    StealthFailNextBindForTests(c.error);
    OnSocketThread([&] { result = nrSocket->create(&addr); });
    StealthFailNextBindForTests(0);
    EXPECT_EQ(c.expected, result) << c.why;
  }
  // The injection is spent: with none pending the same port binds.
  RefPtr<NrSocket> control = new NrSocket();
  int controlResult = -1;
  OnSocketThread([&] { controlResult = control->create(&addr); });
  EXPECT_EQ(0, controlResult) << "a bind failure was left pending for a create that asked for none";
  if (controlResult == 0) {
    OnSocketThread([&] { control->close(); });
  }
}

TEST(StealthNrSocketBirth, APortTheSystemKeepsFromThisUserIsAlreadyToo)
{
  // 'Access denied' on a bind: a privileged port where the user is not root (Linux), a range the system reserves (Windows keeps some of the
  // dynamic range for Hyper-V, WSL and Docker). The machine is asked, port by port, for one it refuses; where it refuses none (a root user,
  // a Windows with no reserved range) there is no such answer to map and nothing is asserted.
  const uint16_t kept = PortThePlainBindOfThisUserIsDenied();
  if (kept == 0) {
    // A fixed line, for the verdict of the candidate to read: whether the mapping of 'access denied' was asserted on this machine.
    GTEST_LOG_(INFO) << "#12: nothing asserted, no refused port on this machine";
    return;
  }
  GTEST_LOG_(INFO) << "#12: asserted on port " << kept;
  nr_transport_addr addr = UdpAddr("0.0.0.0", kept);
  RefPtr<NrSocket> nrSocket = new NrSocket();
  int result = -1;
  OnSocketThread([&] { result = nrSocket->create(&addr); });
  EXPECT_EQ(R_ALREADY, result) << "'access denied' for port " << kept
                               << " is R_ALREADY (the caller takes the next one), not R_INTERNAL";
  // A socket whose create failed is only released (its close() is for a socket that was born: it asks for the socket thread it remembered).
  if (result == 0) {
    OnSocketThread([&] { nrSocket->close(); });
  }
}

// The socket of a PeerConnection whose layer cannot be pushed must not exist: a plain one would send direct, around the proxy.
TEST(StealthNrSocketBirth, ASocketWhoseLayerCannotBePushedIsNotBorn)
{
  stealthtest::SessionProxyScope scope(stealthtest::ProxyOfTheSession::None);
  ASSERT_TRUE(scope.Ok());
  std::shared_ptr<NrSocketProxyConfig> config = stealthtest::MakeConfigAfterTheLookup();
  ASSERT_TRUE(config);
  nr_transport_addr local = UdpAddr("0.0.0.0", 0);
  RefPtr<NrSocket> refused = new NrSocket(config);
  int result = 0;
  net::nsSOCKSUDPIOLayerFailNextPushForTests(true);
  OnSocketThread([&] { result = refused->create(&local); });
  net::nsSOCKSUDPIOLayerFailNextPushForTests(false);
  EXPECT_EQ(R_INTERNAL, result) << "the socket was born plain although its layer was refused: its datagrams would go out direct";
  // The refusal is for one socket: the next one is born, with its layer.
  RefPtr<NrSocket> next = new NrSocket(config);
  int nextResult = -1;
  OnSocketThread([&] { nextResult = next->create(&local); });
  EXPECT_EQ(0, nextResult);
  OnSocketThread([&] { next->close(); });  // the refused one never was born: it is only released
}

// REVIEW-63 #23: a declared host socket is registered as one of ours (R3) as the LAST step of create, after the socket transport service
// took it. A create that fails at that step must leave no port of ours behind: else a datagram of this browser to that declared port
// would be sent to the loopback (where a socket of someone else may be) instead of to the declared address.
TEST(StealthNrSocketBirth, ACreateThatFailsAtTheLastStepLeavesNoPortOfOursBehind)
{
  const char* kDeclared = "198.51.100.77";  // documentation address: the host does not own it, as a declared one
  // Four ports the system gives together (the sockets are closed together, so no two are the same) and that the engine does not ban.
  PRFileDesc* probes[4];
  uint16_t ports[4];
  for (int i = 0; i < 4; ++i) {
    probes[i] = PlainSocketOnAnyPort();
    ports[i] = PortOf(probes[i]);
    nr_transport_addr checked = UdpAddr(kDeclared, ports[i]);
    EXPECT_FALSE(NrSocketBase::IsForbiddenAddress(&checked)) << "port " << ports[i] << " is one the engine drops datagrams to";
  }
  for (PRFileDesc* probe : probes) {
    PR_Close(probe);
  }
  const uint16_t senderPort = ports[0];
  const uint16_t heardPort = ports[1];
  nr_transport_addr senderAddr = UdpAddr(kDeclared, senderPort);
  nr_transport_addr heardAddr = UdpAddr(kDeclared, heardPort);
  RefPtr<NrSocket> sender = new NrSocket();
  RefPtr<NrSocket> heard = new NrSocket();
  int senderResult = -1;
  int heardResult = -1;
  OnSocketThread([&] {
    senderResult = sender->create(&senderAddr);
    heardResult = heard->create(&heardAddr);
  });
  ASSERT_EQ(0, senderResult);
  ASSERT_EQ(0, heardResult);

  // The control: the port of a socket that was born IS one of ours, a datagram to it goes to the loopback and the socket hears it.
  int sentToHeard = -1;
  OnSocketThread([&] { sentToHeard = sender->sendto("ping", 4, 0, &heardAddr); });
  EXPECT_EQ(0, sentToHeard);
  bool heardIt = false;
  for (int attempt = 0; attempt < 50 && !heardIt; ++attempt) {
    char buf[16];
    size_t len = 0;
    nr_transport_addr from;
    int r = -1;
    OnSocketThread([&] { r = heard->recvfrom(buf, sizeof(buf), &len, 0, &from); });
    heardIt = (r == 0 && len == 4);
    if (!heardIt) {
      PR_Sleep(PR_MillisecondsToInterval(20));
    }
  }
  EXPECT_TRUE(heardIt) << "the datagram to a port of ours did not go to the loopback: the test below would prove nothing";

  // A create whose last step fails.
  const uint16_t refusedPort = ports[2];
  nr_transport_addr refusedAddr = UdpAddr(kDeclared, refusedPort);
  RefPtr<NrSocket> refused = new NrSocket();
  int refusedResult = 0;
  StealthFailNextSocketAttachForTests(true);
  OnSocketThread([&] { refusedResult = refused->create(&refusedAddr); });
  StealthFailNextSocketAttachForTests(false);
  EXPECT_EQ(R_INTERNAL, refusedResult) << "the socket transport service refused the socket and create went on (or failed for another reason)";
  refused = nullptr;  // closes its file descriptor: the port is free again

  // Someone else takes that port. A datagram of ours to the declared address and that port must NOT be taken for a datagram to one of ours.
  PRFileDesc* other = PR_NewUDPSocket();
  PRNetAddr bindTo;
  PR_InitializeNetAddr(PR_IpAddrAny, refusedPort, &bindTo);
  ASSERT_EQ(PR_SUCCESS, PR_Bind(other, &bindTo));
  OnSocketThread([&] { (void)sender->sendto("ping", 4, 0, &refusedAddr); });
  char buf[16];
  PRNetAddr from;
  EXPECT_LT(PR_RecvFrom(other, buf, sizeof(buf), 0, &from, PR_MillisecondsToInterval(300)), 0)
      << "a port left by a create that failed is still taken for a port of ours: the datagram went to the loopback";
  PR_Close(other);
  OnSocketThread([&] {
    sender->close();
    heard->close();
  });
}

// The pool of associations is for the sockets that are born. nr_socket_local_create tries port after port in one task of the socket
// thread, a new NrSocket for each, until a bind works; over a range Windows keeps for itself every bind is refused ('access denied'). A
// socket that is refused is never born and must take nothing: before, the layer took its association at the push, before the bind, so
// two refused ports used up the two ready ones and the socket that was born got one still being made (the candidates' logs on Windows:
// up to 173 takes in 20 ms for one socket; the e2e of the TURN chain by name red about once in 55 runs). Counted, not timed: the state of
// the association the socket was born with, and how many handshakes the pool began.
TEST(StealthNrSocketBirth, TwoRefusedPortsLeaveTheReadyAssociationsToTheSocketThatIsBorn)
{
  UdpCarryingSocks proxy;
  stealthtest::SessionProxyScope scope(stealthtest::ProxyOfTheSession::Socks5CarryingUdp, proxy.Port());
  ASSERT_TRUE(scope.Ok());
  std::shared_ptr<NrSocketProxyConfig> config = stealthtest::MakeConfigAfterTheLookup();
  ASSERT_TRUE(config);

  // The pool of the proxy, warmed as a SOCKS5 connection of the context warms it, and made: its associations are ready.
  const uint32_t ready = net::nsSOCKSUDPIOLayerPoolReady();
  const uint32_t begunBefore = net::nsSOCKSUDPIOLayerAssociationsBegunForTests();
  const uint32_t madeBefore = net::nsSOCKSUDPIOLayerAssociationsMadeForTests();
  net::nsSOCKSUDPIOLayerWarm("127.0.0.1"_ns, proxy.Port(), ""_ns, ""_ns);
  ASSERT_TRUE(WaitFor([&] { return net::nsSOCKSUDPIOLayerAssociationsMadeForTests() - madeBefore >= ready; }, 5000))
      << "the pool did not make its associations (the proxy answered " << proxy.Answered() << ")";
  ASSERT_EQ(ready, net::nsSOCKSUDPIOLayerAssociationsBegunForTests() - begunBefore);

  nr_transport_addr any = UdpAddr("0.0.0.0", 0);
  RefPtr<NrSocketWithItsFd> born = new NrSocketWithItsFd(config);
  int refused[2] = {-1, -1};
  int bornResult = -1;
  bool readyAtBirth = false;
  OnSocketThread([&] {
    // What nr_socket_local_create does over a reserved range: a socket per port, each released at once when its bind is refused.
    for (int& result : refused) {
      RefPtr<NrSocket> attempt = new NrSocket(config);
      StealthFailNextBindForTests(PR_NO_ACCESS_RIGHTS_ERROR);
      result = attempt->create(&any);
    }
    bornResult = born->create(&any);
    readyAtBirth = bornResult == 0 && net::nsSOCKSUDPIOLayerIsReady(born->Fd());
  });
  StealthFailNextBindForTests(0);
  // The handshakes the takes asked for are begun on this thread after the task above: one more task, and every one has begun.
  OnSocketThread([] {});
  const uint32_t begun = net::nsSOCKSUDPIOLayerAssociationsBegunForTests() - begunBefore;

  EXPECT_EQ(R_ALREADY, refused[0]);
  EXPECT_EQ(R_ALREADY, refused[1]);
  ASSERT_EQ(0, bornResult) << "the socket after two refused ports was not born";
  EXPECT_TRUE(readyAtBirth) << "the socket that was born got an association still being made: the refused ports used up the ready ones";
  EXPECT_EQ(ready + 1, begun) << "the pool began " << begun << " handshakes: its " << ready
                              << " and one to replace the one the born socket took; the refused sockets must take none";
  OnSocketThread([&] { born->close(); });
}

}  // namespace mozilla
