/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


#include "StealthBundleFontList.h"

#include "gfxFontConstants.h"
#include "gfxFontUtils.h"
#include "mozilla/FontPropertyTypes.h"
#include "mozilla/StaticPrefs_zoom.h"
#include "mozilla/gfx/StealthRefuse.h"
#include "nsCharSeparatedTokenizer.h"
#include "nsDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIFile.h"
#include "nsIInputStream.h"
#include "nsNetUtil.h"
#include "nsReadableUtils.h"
#include "nsStreamUtils.h"
#include "prenv.h"

using namespace mozilla;
using mozilla::fontlist::Face;
using mozilla::fontlist::Family;

// Split aLine on '|' into aOut, keeping empty fields (a face's psname may be
// empty). Returns the field count.
static uint32_t SplitPipe(const nsACString& aLine, nsTArray<nsCString>& aOut) {
  aOut.Clear();
  int32_t start = 0;
  const nsCString line(aLine);
  while (true) {
    int32_t bar = line.FindChar('|', start);
    if (bar < 0) {
      aOut.AppendElement(Substring(line, start));
      break;
    }
    aOut.AppendElement(Substring(line, start, bar - start));
    start = bar + 1;
  }
  return aOut.Length();
}

static int32_t ParseInt(const nsACString& aStr, int32_t aDefault) {
  nsresult rv;
  int32_t v = nsCString(aStr).ToInteger(&rv);
  return NS_FAILED(rv) ? aDefault : v;
}

static float ParseFloat(const nsACString& aStr, float aDefault) {
  nsresult rv;
  float v = nsCString(aStr).ToFloat(&rv);
  return NS_FAILED(rv) ? aDefault : v;
}

bool StealthBundleFontList::Load() {
  nsCString data;

  // Read the manifest from environment, then preference, then packaged file.
  // The environment is available before Juggler applies its preferences.
  if (const char* envPath = PR_GetEnv("STEALTHFOX_FONT_MANIFEST")) {
    if (envPath[0]) {
      nsCOMPtr<nsIFile> envFile;
      if (NS_SUCCEEDED(NS_NewNativeLocalFile(nsDependentCString(envPath),
                                             getter_AddRefs(envFile)))) {
        nsCOMPtr<nsIInputStream> envStream;
        if (NS_SUCCEEDED(NS_NewLocalFileInputStream(getter_AddRefs(envStream),
                                                    envFile))) {
          nsCString envData;
          if (NS_SUCCEEDED(NS_ConsumeStream(envStream, UINT32_MAX, envData)) &&
              !envData.IsEmpty()) {
            data = envData;
          }
        }
      }
    }
  }

  if (data.IsEmpty()) {
    auto lock = mozilla::StaticPrefs::zoom_stealth_fonts_manifest();
    data = *lock;
  }

  if (data.IsEmpty()) {
    nsCOMPtr<nsIFile> file;
    if (NS_FAILED(NS_GetSpecialDirectory(NS_GRE_DIR, getter_AddRefs(file)))) {
      return false;
    }
    if (NS_FAILED(file->Append(u"fonts"_ns)) ||
        NS_FAILED(file->Append(u"bundle-fonts.list"_ns))) {
      return false;
    }
    nsCOMPtr<nsIInputStream> stream;
    if (NS_FAILED(NS_NewLocalFileInputStream(getter_AddRefs(stream), file))) {
      return false;
    }
    if (NS_FAILED(NS_ConsumeStream(stream, UINT32_MAX, data))) {
      return false;
    }
  }

  nsCString currentKey;  // lowercased display name of the family being filled
  nsTArray<nsCString> fields;

  for (const auto& lineRange : data.Split('\n')) {
    nsDependentCSubstring line(lineRange);
    if (line.IsEmpty() || line[0] == '#') {
      continue;
    }
    if (StringBeginsWith(line, "F|"_ns)) {
      nsCString name(Substring(line, 2));
      nsAutoCString key(name);
      ToLowerCase(key);
      currentKey = key;
      mFamilies.AppendElement(
          Family::InitData(key, name, Family::kNoIndex, FontVisibility::Base));
      continue;
    }
    // P|T|Y|Z contain the fixed fallback lists in platform order.
    {
      nsTArray<nsCString>* dest = nullptr;
      if (StringBeginsWith(line, "P|"_ns)) {
        dest = &mFallbackPrefix;
      } else if (StringBeginsWith(line, "T|"_ns)) {
        dest = &mFallbackTail;
      } else if (StringBeginsWith(line, "Y|"_ns)) {
        dest = &mFallbackSymbolish;
      } else if (StringBeginsWith(line, "Z|"_ns)) {
        dest = &mFallbackTailAfter;
      }
      if (dest) {
        const uint32_t n = SplitPipe(line, fields);
        dest->Clear();
        for (uint32_t i = 1; i < n; ++i) {
          if (!fields[i].IsEmpty()) {
            dest->AppendElement(fields[i]);
          }
        }
        continue;
      }
    }
    if (StringBeginsWith(line, "S|"_ns)) {
      // S|<Script>|<font>|... uses numeric mozilla::intl::Script keys.
      const uint32_t n = SplitPipe(line, fields);
      if (n < 3) {
        continue;
      }
      const int32_t script = ParseInt(fields[1], -1);
      if (script < 0) {
        continue;
      }
      nsTArray<nsCString> fonts;
      for (uint32_t i = 2; i < n; ++i) {
        if (!fields[i].IsEmpty()) {
          fonts.AppendElement(fields[i]);
        }
      }
      if (!fonts.IsEmpty()) {
        mFallbackScript.InsertOrUpdate(uint32_t(script), std::move(fonts));
      }
      continue;
    }
    if (StringBeginsWith(line, "A|"_ns)) {
      // A|<alias>|<target family> - canonical Windows substitute table (v3).
      // Absent from a v1/v2 manifest, in which case HasAliases() is false and
      // the platform keeps whatever it did before.
      if (SplitPipe(line, fields) < 3) {
        continue;
      }
      nsAutoCString key(fields[1]);
      ToLowerCase(key);
      if (!key.IsEmpty() && !fields[2].IsEmpty()) {
        mAliases.InsertOrUpdate(key, fields[2]);
      }
      continue;
    }
    if (StringBeginsWith(line, "f|"_ns)) {
      // Face records contain file, index, ranges, style and PostScript name.
      // Version 2 appends vertical metrics in font units; version 1 keeps backend metrics.
      const uint32_t nFields = SplitPipe(line, fields);
      if (nFields < 9 || currentKey.IsEmpty()) {
        continue;  // malformed / orphan face - skip, never crash
      }
      StealthBundleFace face;
      face.mFile = fields[1];
      face.mIndex = uint16_t(ParseInt(fields[2], 0));
      face.mWeightMin = ParseInt(fields[3], 400);
      face.mWeightMax = ParseInt(fields[4], face.mWeightMin);
      face.mStretchMin = ParseFloat(fields[5], 100.0f);
      face.mStretchMax = ParseFloat(fields[6], face.mStretchMin);
      face.mItalic = fields[7].EqualsLiteral("italic");
      face.mPsname = fields[8];
      if (nFields >= 19) {
        const int32_t upem = ParseInt(fields[9], 0);
        // A non-positive or oversized upem would make every derived metric
        // garbage; treat it as "no metrics" so the backend keeps its own.
        if (upem > 0 && upem <= UINT16_MAX) {
          face.mVMetrics.mUpem = uint16_t(upem);
          face.mVMetrics.mAscent = ParseInt(fields[10], 0);
          face.mVMetrics.mDescent = ParseInt(fields[11], 0);
          face.mVMetrics.mLineGap = ParseInt(fields[12], 0);
          face.mVMetrics.mXHeight = ParseInt(fields[13], 0);
          face.mVMetrics.mCapHeight = ParseInt(fields[14], 0);
          face.mVMetrics.mUnderlineOffset = ParseInt(fields[15], 0);
          face.mVMetrics.mUnderlineSize = ParseInt(fields[16], 0);
          face.mVMetrics.mStrikeoutOffset = ParseInt(fields[17], 0);
          face.mVMetrics.mStrikeoutSize = ParseInt(fields[18], 0);
        }
      }
      mFaces.LookupOrInsert(currentKey).AppendElement(std::move(face));
    }
  }

  return !mFamilies.IsEmpty();
}

void StealthBundleFontList::GetFaces(const nsACString& aFamilyName,
                                     nsTArray<Face::InitData>& aFaces) {
  nsAutoCString key(aFamilyName);
  ToLowerCase(key);
  auto entry = mFaces.Lookup(key);
  if (!entry) {
    return;
  }
  for (const auto& f : entry.Data()) {
    // Build a fresh (move-only) Face::InitData per call from the cached raw
    // primitives; aggregate-init every member in declaration order, with fresh
    // (move-only) range values.
    Face::InitData face = {
        f.mFile,   // mDescriptor = bundle file name
        f.mIndex,  // mIndex
#ifdef MOZ_WIDGET_GTK
        0,  // mSize (0 = scalable)
#endif
        false,  // mFixedPitch (manifest does not carry it yet)
        WeightRange(FontWeight::FromInt(f.mWeightMin),
                    FontWeight::FromInt(f.mWeightMax)),
        WidthRange(FontWidth::FromFloat(f.mStretchMin),
                   FontWidth::FromFloat(f.mStretchMax)),
        SlantStyleRange(f.mItalic ? FontSlantStyle::ITALIC
                                  : FontSlantStyle::NORMAL),
        nullptr,  // mCharMap
    };
    aFaces.AppendElement(std::move(face));
  }
}

StealthBundleFontList::FileBlob::~FileBlob() {
  if (mMap) {
    if (mMapped) {
      PR_MemUnmap(const_cast<uint8_t*>(mMapped), mMappedLength);
    }
    PR_CloseFileMap(mMap);
  }
}

size_t StealthBundleFontList::SizeOfIncludingThis(
    mozilla::MallocSizeOf aMallocSizeOf) const {
  size_t n = aMallocSizeOf(this);
  // Account mapped bytes separately from heap allocations.
  for (const auto& blob : mFileCache.Values()) {
    if (blob) {
      n += sizeof(FileBlob) + blob->HeapBytes();
    }
  }
  return n;
}

size_t StealthBundleFontList::MappedBytes() const {
  size_t n = 0;
  for (const auto& blob : mFileCache.Values()) {
    if (blob) {
      n += blob->MappedBytes();
    }
  }
  return n;
}

// Resolve file paths and byte mappings through the same bundle directory.
static already_AddRefed<nsIFile> PercorsoDelFile(const nsACString& aFile) {
  nsCOMPtr<nsIFile> path;
  if (NS_FAILED(NS_GetSpecialDirectory(NS_GRE_DIR, getter_AddRefs(path))) ||
      NS_FAILED(path->Append(u"fonts"_ns)) ||
      NS_FAILED(path->Append(NS_ConvertUTF8toUTF16(nsCString(aFile))))) {
    return nullptr;
  }
  return path.forget();
}

bool StealthBundleFontList::GetFacePath(const nsACString& aFile,
                                        nsACString& aOut) {
  nsCOMPtr<nsIFile> path = PercorsoDelFile(aFile);
  if (!path) {
    return false;
  }
  // Use the platform-specific native path encoding.
#ifdef XP_WIN
  nsAutoString largo;
  if (NS_FAILED(path->GetPath(largo))) {
    return false;
  }
  CopyUTF16toUTF8(largo, aOut);
#else
  if (NS_FAILED(path->GetNativePath(aOut))) {
    return false;
  }
#endif
  return !aOut.IsEmpty();
}

already_AddRefed<StealthBundleFontList::FileBlob>
StealthBundleFontList::GetFaceBlob(const nsACString& aFile) {
  nsCString file(aFile);
  if (auto cached = mFileCache.Lookup(file)) {
    return do_AddRef(cached.Data());
  }
  nsCOMPtr<nsIFile> path = PercorsoDelFile(aFile);
  if (!path) {
    return nullptr;
  }
  // Map it read-only first. The pages are then the FILE's: shared by the OS
  // with every other process that maps it, and evictable instead of swappable.
  if (RefPtr<FileBlob> mapped = MapFile(path)) {
    mFileCache.InsertOrUpdate(file, mapped);
    return mapped.forget();
  }

  // Read into owned heap storage if mapping fails.
  nsCOMPtr<nsIInputStream> stream;
  if (NS_FAILED(NS_NewLocalFileInputStream(getter_AddRefs(stream), path))) {
    return nullptr;
  }
  nsCString bytes;
  if (NS_FAILED(NS_ConsumeStream(stream, UINT32_MAX, bytes))) {
    return nullptr;
  }
  nsTArray<uint8_t> buf;
  buf.AppendElements(reinterpret_cast<const uint8_t*>(bytes.get()),
                     bytes.Length());
  RefPtr<FileBlob> blob = new FileBlob(std::move(buf));
  mFileCache.InsertOrUpdate(file, blob);
  return blob.forget();
}

already_AddRefed<StealthBundleFontList::FileBlob>
StealthBundleFontList::MapFile(nsIFile* aPath) {
  PRFileDesc* fd = nullptr;
  if (NS_FAILED(aPath->OpenNSPRFileDesc(PR_RDONLY, 0, &fd)) || !fd) {
    return nullptr;
  }
  PRFileInfo64 info;
  if (PR_GetOpenFileInfo64(fd, &info) != PR_SUCCESS || info.size <= 0 ||
      info.size > int64_t(UINT32_MAX)) {
    PR_Close(fd);
    return nullptr;
  }
  const uint32_t len = uint32_t(info.size);
  PRFileMap* map = PR_CreateFileMap(fd, info.size, PR_PROT_READONLY);
  if (!map) {
    PR_Close(fd);
    return nullptr;
  }
  void* addr = PR_MemMap(map, 0, len);
  // NSPR keeps what it needs from the descriptor; the mapping stays valid after
  // the file is closed, which is what lets the whole thing be fire-and-forget.
  PR_Close(fd);
  if (!addr) {
    PR_CloseFileMap(map);
    return nullptr;
  }
  return MakeAndAddRef<FileBlob>(map, addr, len);
}


bool StealthBundleFontList::GetPsname(const nsACString& aFile, uint16_t aIndex,
                                      nsACString& aOut) {
  for (const auto& faces : mFaces.Values()) {
    for (const auto& f : faces) {
      if (f.mIndex == aIndex && f.mFile.Equals(aFile)) {
        aOut = f.mPsname;
        return !aOut.IsEmpty();
      }
    }
  }
  return false;
}

hb_blob_t* StealthBundleFontList::GetFaceNameTable(const nsACString& aFile,
                                                   uint16_t aIndex) {
  RefPtr<FileBlob> blob = GetFaceBlob(aFile);
  if (!blob || !blob->Length()) {
    return nullptr;
  }
  // The table points into the cached bytes, which outlive every caller: the
  // cache is never cleared (see the comment on GetFaceBlob's borrowers).
  return gfxFontUtils::GetTableFromFontData(
      blob->Data(), TRUETYPE_TAG('n', 'a', 'm', 'e'), aIndex);
}

bool StealthBundleFontList::GetVMetrics(const nsACString& aFile,
                                        uint16_t aIndex,
                                        StealthBundleVMetrics& aOut) {
  // Same linear walk as GetPsname above: 133 faces, and the caller only
  // reaches this for a bundled face (a web font has no shmem face), so the
  // miss case never pays for it.
  for (const auto& faces : mFaces.Values()) {
    for (const auto& f : faces) {
      if (f.mIndex == aIndex && f.mFile.Equals(aFile)) {
        if (!f.mVMetrics.IsValid()) {
          return false;  // v1 manifest: leave the backend's values alone
        }
        aOut = f.mVMetrics;
        return true;
      }
    }
  }
  return false;
}

bool StealthBundleFontList::GetAlias(const nsACString& aName,
                                     nsACString& aOut) {
  nsAutoCString key(aName);
  ToLowerCase(key);
  if (auto entry = mAliases.Lookup(key)) {
    aOut = entry.Data();
    return true;
  }
  return false;
}

bool StealthBundleFontList::GetCommonFallback(
    int16_t aScript, bool aPrefersColor, bool aSymbolish,
    nsTArray<const char*>& aOut) const {
  if (mFallbackTail.IsEmpty()) {
    return false;  // pre-v4 manifest: let the caller keep the platform list
  }
  auto append = [&aOut](const nsTArray<nsCString>& aList) {
    for (const nsCString& name : aList) {
      aOut.AppendElement(name.get());
    }
  };
  // Preserve the declared script, BMP and color-emoji fallback order.
  if (aPrefersColor) {
    append(mFallbackPrefix);
  }
  if (auto entry = mFallbackScript.Lookup(uint32_t(aScript))) {
    append(entry.Data());
  }
  append(mFallbackTail);
  if (aSymbolish) {
    append(mFallbackSymbolish);
  }
  append(mFallbackTailAfter);
  if (!aPrefersColor) {
    append(mFallbackPrefix);
  }
  return true;
}

/* static */
StealthBundleFontList* StealthBundleFontList::Get() {
  static StealthBundleFontList* sInstance = []() -> StealthBundleFontList* {
    auto* list = new StealthBundleFontList();
    if (list->Load()) {
      return list;  // leaked on purpose: lives for the process
    }
    delete list;
    // A missing manifest is a startup error for this bundle-only font list.
    mozilla::gfx::StealthRefuse(
        "stealth: bundle-fonts.list not loadable from env, pref or GRE_DIR - "
        "refusing to run with host fonts");
  }();
  return sInstance;
}
