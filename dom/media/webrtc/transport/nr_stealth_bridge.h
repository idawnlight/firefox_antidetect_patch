/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */




#ifndef nr_stealth_bridge_h__
#define nr_stealth_bridge_h__

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif






size_t nr_stealth_get_webrtc_public_ip(char* buf, size_t buf_len);



int nr_stealth_webrtc_disable_ipv6(void);

#ifdef __cplusplus
}
#endif

#endif /* nr_stealth_bridge_h__ */
