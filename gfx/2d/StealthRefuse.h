/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef MOZILLA_GFX_STEALTHREFUSE_H_
#define MOZILLA_GFX_STEALTHREFUSE_H_

#include <stdarg.h>

#include "mozilla/Assertions.h"
#include "mozilla/Attributes.h"
#include "mozilla/Sprintf.h"
#include "mozilla/glue/Debug.h"

namespace mozilla {
namespace gfx {

// Print declaration or installation failures before recording the crash reason.
[[noreturn]] MOZ_FORMAT_PRINTF(1,
                               2) inline void StealthRefuse(const char* aFormat,
                                                            ...) {
  char message[1024];
  va_list args;
  va_start(args, aFormat);
  VsprintfLiteral(message, aFormat, args);
  va_end(args);
  printf_stderr("%s\n", message);
  MOZ_CRASH_UNSAFE_PRINTF("%s", message);
}

}  // namespace gfx
}  // namespace mozilla

#endif  // MOZILLA_GFX_STEALTHREFUSE_H_
