/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef MOZILLA_GFX_STEALTHGLYPHCOVERAGE_H_
#define MOZILLA_GFX_STEALTHGLYPHCOVERAGE_H_

#include <stddef.h>
#include <stdint.h>

// Keep this header independent of Gecko headers because vendored Skia includes it.

namespace mozilla {
namespace gfx {

// Quantize an A8 glyph mask to zoom.stealth.text.coverage_ladder.
// Called before mask filters; color glyphs are excluded.
void StealthQuantiseGlyphCoverage(uint8_t* aImage, int32_t aWidth,
                                  int32_t aHeight, size_t aRowBytes);

}  // namespace gfx
}  // namespace mozilla

#endif  // MOZILLA_GFX_STEALTHGLYPHCOVERAGE_H_
