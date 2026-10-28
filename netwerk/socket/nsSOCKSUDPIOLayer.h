/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */




#ifndef nsSOCKSUDPIOLayer_h__
#define nsSOCKSUDPIOLayer_h__

#include "prio.h"
#include "nscore.h"

namespace mozilla {
namespace net {



nsresult nsSOCKSUDPIOLayerAddToSocket(PRFileDesc* aFd,
                                      const char* aProxyHost,
                                      int32_t aProxyPort,
                                      const char* aProxyUsername,
                                      const char* aProxyPassword);

}  // namespace net
}  // namespace mozilla

#endif /* nsSOCKSUDPIOLayer_h__ */
