/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef StealthBundleFontList_h_
#define StealthBundleFontList_h_

#include "SharedFontList.h"
#include "mozilla/MemoryReporting.h"
#include "nsHashKeys.h"
#include "nsTArray.h"
#include "nsTHashMap.h"
#include "prio.h"

typedef struct hb_blob_t hb_blob_t;

// Vertical metrics in font units; scale by font size / mUpem.
struct StealthBundleVMetrics {
  uint16_t mUpem = 0;
  int32_t mAscent = 0;
  int32_t mDescent = 0;
  int32_t mLineGap = 0;
  int32_t mXHeight = 0;    // 0 = absent from OS/2 (pre-v2 table)
  int32_t mCapHeight = 0;  // 0 = absent from OS/2 (pre-v2 table)
  int32_t mUnderlineOffset = 0;
  int32_t mUnderlineSize = 0;
  int32_t mStrikeoutOffset = 0;
  int32_t mStrikeoutSize = 0;

  bool IsValid() const { return mUpem > 0; }
};

struct StealthBundleFace {
  nsCString mFile;
  nsCString
      mPsname;  // PostScript name (nameID 6); used to pick the right .ttc face
  uint16_t mIndex = 0;
  int32_t mWeightMin = 400;
  int32_t mWeightMax = 400;
  float mStretchMin = 100.0f;
  float mStretchMax = 100.0f;
  bool mItalic = false;
  StealthBundleVMetrics mVMetrics;
};

// Build shared family and face data from the packaged bundle manifest.
// Face descriptors carry the bundle filename and collection face index.
class StealthBundleFontList final {
 public:
  // Return the process-lifetime singleton; abort if its manifest cannot be loaded.
  static StealthBundleFontList* Get();

  // The full family list, ready for SharedFontList()->SetFamilyNames().
  const nsTArray<mozilla::fontlist::Family::InitData>& Families() const {
    return mFamilies;
  }

  // Appends the faces for aFamilyName (its display name) to aFaces. No-op if
  // the family is unknown. Mirrors the platform GetFacesInitDataForFamily
  // contract.
  void GetFaces(const nsACString& aFamilyName,
                nsTArray<mozilla::fontlist::Face::InitData>& aFaces);

  // Cache one refcounted read-only mapping per bundle file for the process lifetime.
  // Use heap storage if mapping fails; platform font objects borrow these bytes.
  class FileBlob final {
   public:
    NS_INLINE_DECL_THREADSAFE_REFCOUNTING(FileBlob)

    explicit FileBlob(nsTArray<uint8_t>&& aBytes) : mBytes(std::move(aBytes)) {}
    FileBlob(PRFileMap* aMap, void* aAddr, uint32_t aLength)
        : mMap(aMap),
          mMapped(static_cast<const uint8_t*>(aAddr)),
          mMappedLength(aLength) {}

    const uint8_t* Data() const {
      return mMapped ? mMapped : mBytes.Elements();
    }
    uint32_t Length() const {
      return mMapped ? mMappedLength : mBytes.Length();
    }

    // Bytes charged to THIS process's heap: zero when mapped, because the pages
    // are the file's and about:memory must not count them as ours.
    size_t HeapBytes() const { return mMapped ? 0 : mBytes.Length(); }
    size_t MappedBytes() const { return mMapped ? mMappedLength : 0; }

   private:
    ~FileBlob();
    const nsTArray<uint8_t> mBytes;
    PRFileMap* mMap = nullptr;
    const uint8_t* mMapped = nullptr;
    uint32_t mMappedLength = 0;
  };

  // How many bytes this object holds ON THE HEAP, for about:memory. Zero for a
  // mapped file: see FileBlob above for why counting those here would be wrong.
  size_t SizeOfIncludingThis(mozilla::MallocSizeOf aMallocSizeOf) const;

  // How many bytes are MAPPED, reported separately and as non-heap, so the two
  // never get added together by accident.
  size_t MappedBytes() const;

  // Resolve the absolute path used by both descriptors and byte mappings.
  static bool GetFacePath(const nsACString& aFile, nsACString& aOut);

  // Return cached process-lifetime bytes for a bundle filename, or null if unreadable.
  already_AddRefed<FileBlob> GetFaceBlob(const nsACString& aFile);

  // Select collection faces by PostScript name because CoreText descriptor order
  // is not documented to match the collection index.
  bool GetPsname(const nsACString& aFile, uint16_t aIndex, nsACString& aOut);

  // Return a caller-owned HarfBuzz blob borrowing the cached name-table bytes.
  hb_blob_t* GetFaceNameTable(const nsACString& aFile, uint16_t aIndex);

  // Return manifest vertical metrics for a bundle filename and face index.
  bool GetVMetrics(const nsACString& aFile, uint16_t aIndex,
                   StealthBundleVMetrics& aOut);

  // Resolve manifest aliases case-insensitively on every platform.
  bool GetAlias(const nsACString& aName, nsACString& aOut);

  // Suppress platform aliases when the manifest supplies its own alias table.
  bool HasAliases() const { return !mAliases.IsEmpty(); }

  bool GetCommonFallback(int16_t aScript, bool aPrefersColor, bool aSymbolish,
                         nsTArray<const char*>& aOut) const;

 private:
  StealthBundleFontList() = default;
  ~StealthBundleFontList() = default;

  // Reads + parses the manifest into mFamilies + mFaces. Returns false on any
  // failure (missing file, malformed line); on failure the instance is left
  // empty and Get() returns nullptr.
  bool Load();

  // Maps aPath read-only, or null if it cannot be mapped. The descriptor is
  // closed straight away: NSPR keeps what the mapping needs.
  static already_AddRefed<FileBlob> MapFile(nsIFile* aPath);

  nsTArray<mozilla::fontlist::Family::InitData> mFamilies;
  // family lookup key (lowercased display name) -> its faces (raw, copyable)
  nsTHashMap<nsCStringHashKey, nsTArray<StealthBundleFace>> mFaces;
  nsTHashMap<nsCStringHashKey, RefPtr<FileBlob>> mFileCache;
  // lowercased alias name -> target family display name
  nsTHashMap<nsCStringHashKey, nsCString> mAliases;

  nsTArray<nsCString> mFallbackPrefix;                               // P|
  nsTHashMap<nsUint32HashKey, nsTArray<nsCString>> mFallbackScript;  // S|
  nsTArray<nsCString> mFallbackTail;                                 // T|
  nsTArray<nsCString> mFallbackSymbolish;                            // Y|
  nsTArray<nsCString> mFallbackTailAfter;                            // Z|
};

#endif  // StealthBundleFontList_h_
