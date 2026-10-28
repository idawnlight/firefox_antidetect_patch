/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef MOZILLA_GFX_STEALTHCANVASPROJECTION_H_
#define MOZILLA_GFX_STEALTHCANVASPROJECTION_H_

#include <stdint.h>

#include "mozilla/AlreadyAddRefed.h"
#include "mozilla/gfx/Point.h"
#include "mozilla/gfx/Rect.h"
#include "mozilla/gfx/Types.h"

namespace mozilla {
namespace gfx {

class DataSourceSurface;

// The seed and edge tolerance travel together; Off() disables projection.
class StealthCanvasNoise {
 public:
  static StealthCanvasNoise Off() { return StealthCanvasNoise(0, 0); }
  StealthCanvasNoise(int32_t aSeed, int32_t aEdgeTolerance)
      : mSeed(aSeed), mEdgeTolerance(aEdgeTolerance) {}
  explicit operator bool() const { return mSeed != 0; }

  int32_t mSeed;
  // How far, in LSB-cleared RGBA channel units, a colour of the 3x3
  // neighbourhood may sit from the segment between its two farthest colours and
  // still count as a blend of two (zoom.stealth.canvas.edge_tolerance, 0-255).
  int32_t mEdgeTolerance;
};

// Project GPU canvas readback as a deterministic function of seed and pixels.
// Canonical keys clear RGB low bits, making the projection idempotent and
// independent of channel order, row order and readback rectangle.

// Project aRect from aSrc into aDst using neighbors from the full source.
// aDst already contains the source pixels and may alias aSrc. Only RGB low bits
// are written; alpha remains unchanged.
bool StealthProjectPixels(const uint8_t* aSrc, int32_t aSrcStride,
                          const IntSize& aSrcSize, SurfaceFormat aFormat,
                          const IntRect& aRect, uint8_t* aDst,
                          int32_t aDstStride, bool aPremultiplied,
                          const StealthCanvasNoise& aNoise);

// Copy aRect and project it using aSource neighbors; leave aSource unchanged.
already_AddRefed<DataSourceSurface> StealthProjectedRegion(
    DataSourceSurface* aSource, const IntRect& aRect, bool aPremultiplied,
    const StealthCanvasNoise& aNoise);

}  // namespace gfx
}  // namespace mozilla

#endif  // MOZILLA_GFX_STEALTHCANVASPROJECTION_H_
