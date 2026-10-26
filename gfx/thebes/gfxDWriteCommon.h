/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef GFX_DWRITECOMMON_H
#define GFX_DWRITECOMMON_H

// Mozilla includes
#include <dwrite.h>
#include <windows.h>

#include "gfxFontConstants.h"
#include "gfxWindowsPlatform.h"
#include "mozilla/FontPropertyTypes.h"
#include "mozilla/MemoryReporting.h"
#include "nsCOMPtr.h"
#include "nsTArray.h"
#include "nscore.h"

class FontData;

#define GFX_CLEARTYPE_PARAMS "gfx.font_rendering.cleartype_params."
#define GFX_CLEARTYPE_PARAMS_GAMMA "gfx.font_rendering.cleartype_params.gamma"
#define GFX_CLEARTYPE_PARAMS_CONTRAST \
  "gfx.font_rendering.cleartype_params.enhanced_contrast"
#define GFX_CLEARTYPE_PARAMS_LEVEL \
  "gfx.font_rendering.cleartype_params.cleartype_level"
#define GFX_CLEARTYPE_PARAMS_STRUCTURE \
  "gfx.font_rendering.cleartype_params.pixel_structure"
#define GFX_CLEARTYPE_PARAMS_MODE \
  "gfx.font_rendering.cleartype_params.rendering_mode"

#define DISPLAY1_REGISTRY_KEY \
  HKEY_CURRENT_USER, L"Software\\Microsoft\\Avalon.Graphics\\DISPLAY1"

#define ENHANCED_CONTRAST_VALUE_NAME L"EnhancedContrastLevel"

// FIXME: This shouldn't look at constants probably.
static inline DWRITE_FONT_STRETCH DWriteFontStretchFromWidth(
    mozilla::FontWidth aWidth) {
  if (aWidth == mozilla::FontWidth::ULTRA_CONDENSED) {
    return DWRITE_FONT_STRETCH_ULTRA_CONDENSED;
  }
  if (aWidth == mozilla::FontWidth::EXTRA_CONDENSED) {
    return DWRITE_FONT_STRETCH_EXTRA_CONDENSED;
  }
  if (aWidth == mozilla::FontWidth::CONDENSED) {
    return DWRITE_FONT_STRETCH_CONDENSED;
  }
  if (aWidth == mozilla::FontWidth::SEMI_CONDENSED) {
    return DWRITE_FONT_STRETCH_SEMI_CONDENSED;
  }
  if (aWidth == mozilla::FontWidth::NORMAL) {
    return DWRITE_FONT_STRETCH_NORMAL;
  }
  if (aWidth == mozilla::FontWidth::SEMI_EXPANDED) {
    return DWRITE_FONT_STRETCH_SEMI_EXPANDED;
  }
  if (aWidth == mozilla::FontWidth::EXPANDED) {
    return DWRITE_FONT_STRETCH_EXPANDED;
  }
  if (aWidth == mozilla::FontWidth::EXTRA_EXPANDED) {
    return DWRITE_FONT_STRETCH_EXTRA_EXPANDED;
  }
  if (aWidth == mozilla::FontWidth::ULTRA_EXPANDED) {
    return DWRITE_FONT_STRETCH_ULTRA_EXPANDED;
  }
  return DWRITE_FONT_STRETCH_UNDEFINED;
}

static inline mozilla::FontWidth FontWidthFromDWriteStretch(
    DWRITE_FONT_STRETCH aStretch) {
  switch (aStretch) {
    case DWRITE_FONT_STRETCH_ULTRA_CONDENSED:
      return mozilla::FontWidth::ULTRA_CONDENSED;
    case DWRITE_FONT_STRETCH_EXTRA_CONDENSED:
      return mozilla::FontWidth::EXTRA_CONDENSED;
    case DWRITE_FONT_STRETCH_CONDENSED:
      return mozilla::FontWidth::CONDENSED;
    case DWRITE_FONT_STRETCH_SEMI_CONDENSED:
      return mozilla::FontWidth::SEMI_CONDENSED;
    case DWRITE_FONT_STRETCH_NORMAL:
      return mozilla::FontWidth::NORMAL;
    case DWRITE_FONT_STRETCH_SEMI_EXPANDED:
      return mozilla::FontWidth::SEMI_EXPANDED;
    case DWRITE_FONT_STRETCH_EXPANDED:
      return mozilla::FontWidth::EXPANDED;
    case DWRITE_FONT_STRETCH_EXTRA_EXPANDED:
      return mozilla::FontWidth::EXTRA_EXPANDED;
    case DWRITE_FONT_STRETCH_ULTRA_EXPANDED:
      return mozilla::FontWidth::ULTRA_EXPANDED;
    default:
      return mozilla::FontWidth::NORMAL;
  }
}

class gfxDWriteFontFileStream final : public IDWriteFontFileStream {
 public:
  /**
   * Used by the FontFileLoader to create a new font stream,
   * this font stream is created from data in memory.
   *
   * The FontData struct is refcounted; the stream will hold a reference
   * to it as long as needed, to guaranteed the data remains alive.
   *
   * @param aData Font data
   */
  gfxDWriteFontFileStream(FontData* aData, uint64_t aFontFileKey);

  /**
   * Stealth: a stream that does NOT hold a FontData. The caller LENDS bytes it
   * guarantees outlive the stream; the only user is the bundled-font cache in
   * StealthBundleFontList, which is immortal by construction - that object is
   * deliberately leaked and never clears the cache, and it stores refcounted
   * blobs so rehashing cannot move the bytes.
   *
   * Why it exists: the bundle is 218.7 MB over 126 files, the largest a 35.4 MB
   * .ttc with two faces, and DirectWrite holds one stream per FACE. A FontData
   * owns a malloc'd buffer and frees it (gfx/thebes/FontData.h), so wrapping
   * the cache's bytes in one means a permanent copy per face on top of the
   * cache's own: that single file cost 106 MB where 35.4 is enough.
   */
  enum class Borrowed { Yes };
  gfxDWriteFontFileStream(const uint8_t* aData, uint32_t aLength,
                          uint64_t aFontFileKey, Borrowed);

  ~gfxDWriteFontFileStream();

  // IUnknown interface
  IFACEMETHOD(QueryInterface)(IID const& iid, OUT void** ppObject) {
    if (iid == __uuidof(IDWriteFontFileStream)) {
      *ppObject = static_cast<IDWriteFontFileStream*>(this);
      return S_OK;
    } else if (iid == __uuidof(IUnknown)) {
      *ppObject = static_cast<IUnknown*>(this);
      return S_OK;
    } else {
      return E_NOINTERFACE;
    }
  }

  IFACEMETHOD_(ULONG, AddRef)() {
    MOZ_ASSERT(int32_t(mRefCnt) >= 0, "illegal refcnt");
    return ++mRefCnt;
  }

  IFACEMETHOD_(ULONG, Release)();

  // IDWriteFontFileStream methods
  virtual HRESULT STDMETHODCALLTYPE
  ReadFileFragment(void const** fragmentStart, UINT64 fileOffset,
                   UINT64 fragmentSize, OUT void** fragmentContext);

  virtual void STDMETHODCALLTYPE ReleaseFileFragment(void* fragmentContext);

  virtual HRESULT STDMETHODCALLTYPE GetFileSize(OUT UINT64* fileSize);

  virtual HRESULT STDMETHODCALLTYPE GetLastWriteTime(OUT UINT64* lastWriteTime);

  size_t SizeOfExcludingThis(mozilla::MallocSizeOf mallocSizeOf) const {
    // We don't report the size of mData, because the original user font entry
    // will account for that. A borrowed stream owns no bytes either, and
    // counting the lender's would double-count them in about:memory: the
    // bundle cache is where those bytes belong and where they are reported.
    return 0;
  }

  size_t SizeOfIncludingThis(mozilla::MallocSizeOf mallocSizeOf) const {
    return mallocSizeOf(this) + SizeOfExcludingThis(mallocSizeOf);
  }

 private:
  // Exactly one of these two is in use: mData when the stream holds a FontData,
  // mBorrowed when it was lent bytes that outlive it (then mData is null).
  // Defined in the .cpp because FontData is only forward-declared here.
  const uint8_t* Bytes() const;
  uint32_t BytesLength() const;

  RefPtr<FontData> mData;
  const uint8_t* mBorrowed = nullptr;
  uint32_t mBorrowedLength = 0;
  mozilla::Atomic<uint32_t> mRefCnt;
  uint64_t mFontFileKey;
};

class gfxDWriteFontFileLoader : public IDWriteFontFileLoader {
 public:
  gfxDWriteFontFileLoader() = default;

  // IUnknown interface
  IFACEMETHOD(QueryInterface)(IID const& iid, OUT void** ppObject) {
    if (iid == __uuidof(IDWriteFontFileLoader)) {
      *ppObject = static_cast<IDWriteFontFileLoader*>(this);
      return S_OK;
    } else if (iid == __uuidof(IUnknown)) {
      *ppObject = static_cast<IUnknown*>(this);
      return S_OK;
    } else {
      return E_NOINTERFACE;
    }
  }

  IFACEMETHOD_(ULONG, AddRef)() { return 1; }

  IFACEMETHOD_(ULONG, Release)() { return 1; }

  // IDWriteFontFileLoader methods
  /**
   * Important! Note the key here -has- to be a pointer to a uint64_t.
   */
  virtual HRESULT STDMETHODCALLTYPE CreateStreamFromKey(
      void const* fontFileReferenceKey, UINT32 fontFileReferenceKeySize,
      OUT IDWriteFontFileStream** fontFileStream);

  /**
   * Gets the singleton loader instance. Note that when using this font
   * loader, the key must be a pointer to a unint64_t.
   */
  static IDWriteFontFileLoader* Instance() {
    if (!mInstance) {
      mInstance = new gfxDWriteFontFileLoader();
      mozilla::gfx::Factory::GetDWriteFactory()->RegisterFontFileLoader(
          mInstance);
    }
    return mInstance;
  }

  /**
   * Creates a IDWriteFontFile and IDWriteFontFileStream from aFontData.
   * The data from aFontData must remain valid as long as the DWrite
   * font file is alive.
   *
   * @param aFontData the font data for the custom font file
   * @param aFontFile out param for the created font file
   * @param aFontFileStream out param for the corresponding stream
   * @return HRESULT of internal calls
   */
  static HRESULT CreateCustomFontFile(
      FontData* aFontData, IDWriteFontFile** aFontFile,
      gfxDWriteFontFileStream** aFontFileStream);

  /**
   * Stealth: as above, but the stream BORROWS aFontData instead of copying it.
   * Only for bytes that outlive the stream; today that is exactly the bundled
   * font cache. See gfxDWriteFontFileStream's Borrowed constructor.
   */
  static HRESULT CreateBorrowedFontFile(
      const uint8_t* aFontData, uint32_t aLength, IDWriteFontFile** aFontFile,
      gfxDWriteFontFileStream** aFontFileStream);

  size_t SizeOfIncludingThis(mozilla::MallocSizeOf mallocSizeOf) const;

 private:
  static IDWriteFontFileLoader* mInstance;
};

#endif /* GFX_DWRITECOMMON_H */
