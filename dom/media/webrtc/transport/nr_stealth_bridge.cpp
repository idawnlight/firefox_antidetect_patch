/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nr_stealth_bridge.h"

#include <cstdlib>
#include <cstring>




namespace {

size_t CopyEnvTo(const char* aName, char* aBuf, size_t aBufLen) {
  if (!aBuf || aBufLen == 0) {
    return 0;
  }
  const char* value = getenv(aName);
  if (!value || value[0] == '\0') {
    aBuf[0] = '\0';
    return 0;
  }
  size_t len = strlen(value);
  if (len >= aBufLen) {
    len = aBufLen - 1;
  }
  std::memcpy(aBuf, value, len);
  aBuf[len] = '\0';
  return len;
}

}  // namespace

extern "C" size_t nr_stealth_get_webrtc_public_ip(char* buf, size_t buf_len) {
  return CopyEnvTo("STEALTHFOX_WEBRTC_PUBLIC_IP", buf, buf_len);
}

extern "C" int nr_stealth_webrtc_disable_ipv6(void) {
  /* "0" spegne esplicitamente; qualunque altro valore non vuoto accende.
   * Assente = spento: senza dichiarazione non si tocca l'ICE gathering. */
  const char* env = getenv("STEALTHFOX_WEBRTC_DISABLE_IPV6");
  if (env && env[0] != '\0') {
    return (env[0] != '0') ? 1 : 0;
  }
  return 0;
}
