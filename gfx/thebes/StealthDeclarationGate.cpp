/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "StealthDeclarationGate.h"

#include "mozilla/Assertions.h"
#include "mozilla/Atomics.h"
#include "mozilla/Preferences.h"
#include "mozilla/StaticPrefs_zoom.h"
#include "mozilla/gfx/StealthRefuse.h"
#include "mozilla/net/StealthBranding.h"
#include "nsIFile.h"
#include "nsString.h"
#include "nsXULAppAPI.h"

namespace mozilla {
namespace gfx {

namespace {

// The refusal of a missing declaration, one sentence for every list below.
[[noreturn]] void RefuseUndeclared(const char* aName) {
  StealthRefuse(
      "stealth: %s is not declared. Engine rule 7 - a finite-domain value "
      "lives only in invisible_core, and a missing declaration refuses "
      "rather than falling back to a compiled default or to the host. "
      "Launch through invisible_core, or clear zoom.stealth.fpp.hw_seed to "
      "run as stock Firefox.",
      aName);
}

struct StringDeclaration {
  const char* mName;
  bool (*mIsEmpty)();
};

struct IntDeclaration {
  const char* mName;
  int32_t (*mGet)();
  int32_t mFloor;  // a value below this means "not declared"
};

}  // namespace

void StealthAssertDeclarationsComplete() {
  // Stock behaviour when the engine is off: no seed, no declarations, nothing
  // to be complete about.
  if (!StealthEngineActive()) {
    return;
  }

  // Check once in the parent after Juggler has supplied preferences.
  if (!XRE_IsParentProcess()) {
    return;
  }
  static Atomic<bool> sChecked(false);
  if (sChecked.exchange(true)) {
    return;
  }

  const StringDeclaration kStrings[] = {
      {"zoom.stealth.fonts.manifest",
       []() -> bool {
         auto lock = StaticPrefs::zoom_stealth_fonts_manifest();
         return lock->IsEmpty();
       }},
      {"zoom.stealth.fonts.generics",
       []() -> bool {
         auto lock = StaticPrefs::zoom_stealth_fonts_generics();
         return lock->IsEmpty();
       }},
      {"zoom.stealth.media.decode_support",
       []() -> bool {
         auto lock = StaticPrefs::zoom_stealth_media_decode_support();
         return lock->IsEmpty();
       }},
      {"zoom.stealth.media.decoding_info",
       []() -> bool {
         auto lock = StaticPrefs::zoom_stealth_media_decoding_info();
         return lock->IsEmpty();
       }},
      {"zoom.stealth.text.coverage_ladder",
       []() -> bool {
         auto lock = StaticPrefs::zoom_stealth_text_coverage_ladder();
         return lock->IsEmpty();
       }},
      {"zoom.stealth.voices.list",
       []() -> bool {
         auto lock = StaticPrefs::zoom_stealth_voices_list();
         return lock->IsEmpty();
       }},
      {"zoom.stealth.branding.archive",
       []() -> bool {
         nsCOMPtr<nsIFile> archive =
             mozilla::net::StealthBrandingDeclaredArchive();
         return !archive;
       }},
  };

  for (const auto& d : kStrings) {
    if (d.mIsEmpty()) {
      RefuseUndeclared(d.mName);
    }
  }

  const IntDeclaration kInts[] = {
      {"zoom.stealth.screen.taskbar_px",
       []() { return StaticPrefs::zoom_stealth_screen_taskbar_px(); }, 0},
      {"zoom.stealth.screen.color_depth",
       []() { return StaticPrefs::zoom_stealth_screen_color_depth(); }, 1},
      {"zoom.stealth.max_touch_points",
       []() { return StaticPrefs::zoom_stealth_max_touch_points(); }, 0},
      {"zoom.stealth.canvas.edge_tolerance",
       []() { return StaticPrefs::zoom_stealth_canvas_edge_tolerance(); }, 0},
      // Verify the declared Windows text quality and ClearType parameters.
      {"zoom.stealth.text.system_quality",
       []() { return StaticPrefs::zoom_stealth_text_system_quality(); }, 0},
      {"zoom.stealth.text.freetype_hintstyle",
       []() { return StaticPrefs::zoom_stealth_text_freetype_hintstyle(); }, 0},
      {"zoom.stealth.text.freetype_antialias",
       []() { return StaticPrefs::zoom_stealth_text_freetype_antialias(); }, 0},
      {"zoom.stealth.screen.frame_border",
       []() { return StaticPrefs::zoom_stealth_screen_frame_border(); }, 0},
      {"zoom.stealth.screen.maximized_ui",
       []() { return StaticPrefs::zoom_stealth_screen_maximized_ui(); }, 1},
      {"zoom.stealth.screen.popup_ui",
       []() { return StaticPrefs::zoom_stealth_screen_popup_ui(); }, 1},
      {"zoom.stealth.screen.popup_position",
       []() { return StaticPrefs::zoom_stealth_screen_popup_position(); }, 0},
      {"zoom.stealth.screen.avail_device_width",
       []() { return StaticPrefs::zoom_stealth_screen_avail_device_width(); },
       320},
      {"zoom.stealth.screen.avail_device_height",
       []() { return StaticPrefs::zoom_stealth_screen_avail_device_height(); },
       240},
      // Require declared nonzero pointer capabilities.
      {"zoom.stealth.pointer.primary",
       []() { return StaticPrefs::zoom_stealth_pointer_primary(); }, 1},
      {"zoom.stealth.pointer.all",
       []() { return StaticPrefs::zoom_stealth_pointer_all(); }, 1},
      {"zoom.stealth.screen.width",
       []() { return StaticPrefs::zoom_stealth_screen_width(); }, 320},
      {"zoom.stealth.screen.height",
       []() { return StaticPrefs::zoom_stealth_screen_height(); }, 240},
      {"zoom.stealth.hw_concurrency",
       []() { return StaticPrefs::zoom_stealth_hw_concurrency(); }, 1},
      {"zoom.stealth.audio.sample_rate",
       []() { return StaticPrefs::zoom_stealth_audio_sample_rate(); }, 8000},
      {"zoom.stealth.audio.max_channel_count",
       []() { return StaticPrefs::zoom_stealth_audio_max_channel_count(); }, 1},
      {"zoom.stealth.audio.output_latency_ms",
       []() { return StaticPrefs::zoom_stealth_audio_output_latency_ms(); }, 1},
  };

  // Require the declared rasterization parameters in addition to DOM values.
  static const char* const kRasterInts[] = {
      "gfx.font_rendering.cleartype_params.gamma",
      "gfx.font_rendering.cleartype_params.enhanced_contrast",
      "gfx.font_rendering.cleartype_params.cleartype_level",
      "gfx.font_rendering.cleartype_params.pixel_structure",
      "gfx.font_rendering.cleartype_params.rendering_mode",
      "gfx.font_rendering.freetype.gamma",
      "gfx.font_rendering.freetype.enhanced_contrast",
  };
  for (const char* name : kRasterInts) {
    if (Preferences::GetInt(name, -1) < 0) {
      RefuseUndeclared(name);
    }
  }

  for (const auto& d : kInts) {
    if (d.mGet() < d.mFloor) {
      RefuseUndeclared(d.mName);
    }
  }
}

Maybe<StealthWindowFrame> StealthDeclaredWindowFrame() {
  if (!StealthEngineActive()) {
    // Stock Firefox. Not an incomplete declaration, the absence of one.
    return Nothing();
  }
  const StealthWindowFrame frame{
      StaticPrefs::zoom_stealth_screen_frame_border(),
      StaticPrefs::zoom_stealth_screen_maximized_ui(),
      StaticPrefs::zoom_stealth_screen_popup_ui(),
      StaticPrefs::zoom_stealth_screen_popup_position()};
  if (frame.mBorder < 0 || frame.mMaximizedUi < 1 || frame.mPopupUi < 1 ||
      frame.mPopupPosition < 0) {
    // Reject missing geometry declarations rather than inventing coordinates.
    StealthAssertDeclarationsComplete();
    return Nothing();
  }
  return Some(frame);
}

Maybe<LayoutDeviceIntRect> StealthDeclaredMaximizedWindow() {
  const Maybe<StealthWindowFrame> frame = StealthDeclaredWindowFrame();
  if (frame.isNothing()) {
    return Nothing();
  }
  const int32_t w = StaticPrefs::zoom_stealth_screen_avail_device_width();
  const int32_t h = StaticPrefs::zoom_stealth_screen_avail_device_height();
  if (w < 320 || h < 240) {
    StealthAssertDeclarationsComplete();
    return Nothing();
  }
  const int32_t b = frame->mBorder;
  return Some(LayoutDeviceIntRect(-b, -b, w + 2 * b, h + 2 * b));
}

Maybe<nsPoint> StealthDeclaredOriginShift(
    const nsPoint& aRealContentOrigin,
    const Maybe<LayoutDeviceIntPoint>& aPopupWindowOrigin,
    int32_t aAppUnitsPerDevPixel) {
  const Maybe<StealthWindowFrame> frame = StealthDeclaredWindowFrame();
  if (frame.isNothing()) {
    return Nothing();
  }
  // The maximized window's content starts at the screen's left edge, the UI
  // height below its top; a popup's starts a border in and the popup UI down
  // from wherever the popup really is.
  const LayoutDeviceIntPoint declared =
      aPopupWindowOrigin
          ? *aPopupWindowOrigin +
                LayoutDeviceIntPoint(frame->mBorder, frame->mPopupUi)
          : LayoutDeviceIntPoint(0, frame->mMaximizedUi);
  return Some(LayoutDevicePixel::ToAppUnits(declared, aAppUnitsPerDevPixel) -
              aRealContentOrigin);
}

}  // namespace gfx
}  // namespace mozilla
