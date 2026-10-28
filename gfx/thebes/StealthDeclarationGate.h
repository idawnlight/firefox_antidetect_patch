/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef GFX_STEALTHDECLARATIONGATE_H
#define GFX_STEALTHDECLARATIONGATE_H

#include "Units.h"
#include "mozilla/Maybe.h"
#include "mozilla/StaticPrefs_zoom.h"
#include "mozilla/gfx/StealthCanvasProjection.h"
#include "nsPoint.h"

namespace mozilla {
namespace gfx {

// Return whether the hardware seed enables the engine.
inline bool StealthEngineActive() {
  return StaticPrefs::zoom_stealth_fpp_hw_seed() > 0;
}

// Return the declared canvas seed and tolerance, or Off() when disabled.
inline gfx::StealthCanvasNoise StealthCanvasNoiseDeclared() {
  if (!StealthEngineActive() ||
      !StaticPrefs::zoom_stealth_canvas_substitute_pixels()) {
    return gfx::StealthCanvasNoise::Off();
  }
  return {StaticPrefs::zoom_stealth_fpp_hw_seed(),
          StaticPrefs::zoom_stealth_canvas_edge_tolerance()};
}

// Check required preferences and packaged resources before serving page queries.
void StealthAssertDeclarationsComplete();

// Window-frame declarations use device pixels; DOM and event coordinates
// share these values.
struct StealthWindowFrame {
  // Invisible resize border, on the left, right and bottom of every window and
  // on the top of a popup.
  int32_t mBorder;
  // A maximized window: from the screen top to the content top.
  int32_t mMaximizedUi;
  // A popup: from the window top (border included) to the content top.
  int32_t mPopupUi;
  // A popup opened without left/top: where it is put, on both axes.
  int32_t mPopupPosition;
};
Maybe<StealthWindowFrame> StealthDeclaredWindowFrame();

Maybe<LayoutDeviceIntRect> StealthDeclaredMaximizedWindow();

// Return the offset from the real top-level content origin to its declared
// origin, in app units. Apply the offset so iframe-relative positions survive.
Maybe<nsPoint> StealthDeclaredOriginShift(
    const nsPoint& aRealContentOrigin,
    const Maybe<LayoutDeviceIntPoint>& aPopupWindowOrigin,
    int32_t aAppUnitsPerDevPixel);

}  // namespace gfx
}  // namespace mozilla

#endif  // GFX_STEALTHDECLARATIONGATE_H
