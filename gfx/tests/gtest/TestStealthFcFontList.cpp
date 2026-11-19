/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The fontconfig half of the bundle-only font list (Linux only): the helpers
// take an FcPattern*, so no browser window is needed. Each case asserts the
// behaviour the code had inline in gfxFcPlatformFontList.cpp before it moved
// into StealthFcFontList.

#include "gtest/gtest.h"

#include <fontconfig/fontconfig.h>

#include <map>
#include <string>
#include <utility>

#include "StealthBundleFontList.h"
#include "StealthFcFontList.h"
#include "gfxPlatform.h"
#include "gfxPlatformFontList.h"
#include "mozilla/Preferences.h"
#include "nsString.h"
#include "nsTArray.h"
#include "nsXULAppAPI.h"

using mozilla::Preferences;

namespace {

const char* const kFcPrefs[] = {
    "zoom.stealth.text.freetype_hintstyle",
    "zoom.stealth.text.freetype_antialias",
};

// Back to stock Firefox (-1, nothing declared), whatever the test did.
struct RestoreFcStock {
  ~RestoreFcStock() {
    for (const char* name : kFcPrefs) {
      Preferences::ClearUser(name);
    }
  }
};

struct ScopedFcPattern {
  ScopedFcPattern() : mPattern(FcPatternCreate()) {}
  ~ScopedFcPattern() { FcPatternDestroy(mPattern); }
  FcPattern* mPattern;
};

}  // namespace

TEST(StealthFcFontList, DeclareFontFile)
{
  ScopedFcPattern p;
  StealthDeclareFontFile(p.mPattern, nullptr, 3);
  StealthDeclareFontFile(p.mPattern, "", 3);
  FcChar8* file = nullptr;
  int index = -1;
  EXPECT_EQ(FcResultNoMatch,
            FcPatternGetString(p.mPattern, FC_FILE, 0, &file));
  EXPECT_EQ(FcResultNoMatch,
            FcPatternGetInteger(p.mPattern, FC_INDEX, 0, &index));

  StealthDeclareFontFile(p.mPattern, "/x/a.ttc", 2);
  ASSERT_EQ(FcResultMatch, FcPatternGetString(p.mPattern, FC_FILE, 0, &file));
  EXPECT_STREQ("/x/a.ttc", reinterpret_cast<const char*>(file));
  ASSERT_EQ(FcResultMatch,
            FcPatternGetInteger(p.mPattern, FC_INDEX, 0, &index));
  EXPECT_EQ(2, index);
}

TEST(StealthFcFontList, DeclaredFontFile)
{
  std::string file;
  int index = 0;
  {
    // A data face with no file in the pattern (a page's font): nothing is set.
    ScopedFcPattern p;
    StealthDeclaredFontFile(p.mPattern, file, index);
    EXPECT_TRUE(file.empty());
    EXPECT_EQ(0, index);
  }
  {
    // A data face whose pattern names its file (the bundle): file and index.
    ScopedFcPattern p;
    FcPatternAddString(p.mPattern, FC_FILE,
                       reinterpret_cast<const FcChar8*>("/x/b.ttf"));
    FcPatternAddInteger(p.mPattern, FC_INDEX, 5);
    StealthDeclaredFontFile(p.mPattern, file, index);
    EXPECT_EQ("/x/b.ttf", file);
    EXPECT_EQ(5, index);
  }
  {
    // Mozilla's block already wrote the file (a normal face): left as it is.
    ScopedFcPattern p;
    FcPatternAddString(p.mPattern, FC_FILE,
                       reinterpret_cast<const FcChar8*>("/x/other.ttf"));
    FcPatternAddInteger(p.mPattern, FC_INDEX, 9);
    StealthDeclaredFontFile(p.mPattern, file, index);
    EXPECT_EQ("/x/b.ttf", file);
    EXPECT_EQ(5, index);
  }
  {
    // A file but no index: the pattern does not name a file.
    ScopedFcPattern p;
    FcPatternAddString(p.mPattern, FC_FILE,
                       reinterpret_cast<const FcChar8*>("/x/c.ttf"));
    file.clear();
    index = 0;
    StealthDeclaredFontFile(p.mPattern, file, index);
    EXPECT_TRUE(file.empty());
    EXPECT_EQ(0, index);
  }
}

TEST(StealthFcFontList, TextOptions)
{
  RestoreFcStock restore;
  FcBool hinting = FcFalse;
  int hintstyle = -1;
  FcBool antialias = FcFalse;

  Preferences::SetInt("zoom.stealth.text.freetype_hintstyle", FC_HINT_NONE);
  {
    ScopedFcPattern p;
    StealthDeclareTextOptions(p.mPattern);
    ASSERT_EQ(FcResultMatch,
              FcPatternGetInteger(p.mPattern, FC_HINT_STYLE, 0, &hintstyle));
    EXPECT_EQ(FC_HINT_NONE, hintstyle);
    ASSERT_EQ(FcResultMatch,
              FcPatternGetBool(p.mPattern, FC_HINTING, 0, &hinting));
    EXPECT_EQ(FcFalse, hinting);
  }
  Preferences::SetInt("zoom.stealth.text.freetype_hintstyle", FC_HINT_SLIGHT);
  {
    // The declaration replaces what the host configuration put there.
    ScopedFcPattern p;
    FcPatternAddInteger(p.mPattern, FC_HINT_STYLE, FC_HINT_FULL);
    FcPatternAddBool(p.mPattern, FC_HINTING, FcFalse);
    StealthDeclareTextOptions(p.mPattern);
    ASSERT_EQ(FcResultMatch,
              FcPatternGetInteger(p.mPattern, FC_HINT_STYLE, 0, &hintstyle));
    EXPECT_EQ(FC_HINT_SLIGHT, hintstyle);
    ASSERT_EQ(FcResultMatch,
              FcPatternGetBool(p.mPattern, FC_HINTING, 0, &hinting));
    EXPECT_EQ(FcTrue, hinting);
  }
  Preferences::SetInt("zoom.stealth.text.freetype_hintstyle", -1);
  {
    // Not declared: the host value stays.
    ScopedFcPattern p;
    FcPatternAddInteger(p.mPattern, FC_HINT_STYLE, FC_HINT_FULL);
    StealthDeclareTextOptions(p.mPattern);
    ASSERT_EQ(FcResultMatch,
              FcPatternGetInteger(p.mPattern, FC_HINT_STYLE, 0, &hintstyle));
    EXPECT_EQ(FC_HINT_FULL, hintstyle);
  }

  Preferences::SetInt("zoom.stealth.text.freetype_antialias", 0);
  {
    ScopedFcPattern p;
    StealthDeclareTextOptions(p.mPattern);
    ASSERT_EQ(FcResultMatch,
              FcPatternGetBool(p.mPattern, FC_ANTIALIAS, 0, &antialias));
    EXPECT_EQ(FcFalse, antialias);
  }
  Preferences::SetInt("zoom.stealth.text.freetype_antialias", 1);
  {
    ScopedFcPattern p;
    StealthDeclareTextOptions(p.mPattern);
    ASSERT_EQ(FcResultMatch,
              FcPatternGetBool(p.mPattern, FC_ANTIALIAS, 0, &antialias));
    EXPECT_EQ(FcTrue, antialias);
  }
  Preferences::SetInt("zoom.stealth.text.freetype_antialias", -1);
  {
    ScopedFcPattern p;
    FcPatternAddBool(p.mPattern, FC_ANTIALIAS, FcFalse);
    StealthDeclareTextOptions(p.mPattern);
    ASSERT_EQ(FcResultMatch,
              FcPatternGetBool(p.mPattern, FC_ANTIALIAS, 0, &antialias));
    EXPECT_EQ(FcFalse, antialias);
  }
}

TEST(StealthFcFontList, TableFaceIndex)
{
  EXPECT_EQ(0u, StealthTableFaceIndex(nullptr));
}

TEST(StealthFcFontList, PreferFileUnscaledFont)
{
  using mozilla::gfx::UnscaledFontFontconfig;
  {
    // Mozilla already built it on the path: kept (and aFile, moved from, is
    // not read).
    RefPtr<UnscaledFontFontconfig> font =
        new UnscaledFontFontconfig(std::string("/x/a.ttf"), 1, nullptr);
    UnscaledFontFontconfig* before = font;
    std::string file = "/x/other.ttf";
    StealthPreferFileUnscaledFont(nullptr, font, file, 2, nullptr);
    EXPECT_EQ(before, font.get());
  }
  {
    // A page's font: no path, no file. Kept.
    RefPtr<UnscaledFontFontconfig> font =
        new UnscaledFontFontconfig(RefPtr<mozilla::gfx::SharedFTFace>());
    UnscaledFontFontconfig* before = font;
    std::string file;
    StealthPreferFileUnscaledFont(nullptr, font, file, 0, nullptr);
    EXPECT_EQ(before, font.get());
  }
  {
    // A bundled face: no path but the file is known. Replaced by one on the
    // path, which goes into the entry's cache.
    ScopedFcPattern p;
    RefPtr<gfxFontconfigFontEntry> entry =
        new gfxFontconfigFontEntry("bundled"_ns, p.mPattern);
    RefPtr<UnscaledFontFontconfig> font =
        new UnscaledFontFontconfig(RefPtr<mozilla::gfx::SharedFTFace>());
    std::string file = "/x/d.ttc";
    StealthPreferFileUnscaledFont(entry, font, file, 4, nullptr);
    ASSERT_TRUE(font);
    EXPECT_EQ("/x/d.ttc", font->GetFile());
    EXPECT_EQ(4u, font->GetIndex());
    // Moved from in this case only.
    EXPECT_TRUE(file.empty());
  }
}

// The parent process brings the bundle to fontconfig before it builds the
// shared font list (InitSharedFontListForPlatform).
//
// A page's screenshot goes to the parent as a font file and an index, and the
// parent makes the font again from them with
// UnscaledFontFontconfig::CreateFromFontDescriptor, which asks fontconfig
// whether the file is a font it knows and, when it is not, uses the file of the
// best match instead. The bundle is <GRE>/fonts and fontconfig learns of a
// directory only from ActivateBundledFonts (FcConfigAppFontAddDir). Under
// bundle-only the parent returned from InitSharedFontListForPlatform with the
// shared list built from the manifest before it got there, so on a host that
// does not have the bundle installed (a CI runner) every bundled face came back
// as some other file of the host.
//
// This suite runs in the process of the gtests, which is the parent
// (XRE_IsParentProcess, asserted below), and bundle-only is not a mode to enter:
// gfxPlatformFontList sets it in its constructor, in every process of this
// build. What the test needs is the font list built, and
// gfxPlatform::GetPlatform() builds it through the same InitFontList the
// product runs.
namespace {

struct BundleFace {
  nsCString mFile;  // the name in the manifest
  nsCString mPath;  // where the bundle puts it: <GRE>/fonts/<name>
  uint32_t mIndex;
};

class StealthFcBundleFonts : public ::testing::Test {
 protected:
  static void SetUpTestSuite() {
    gfxPlatform::GetPlatform();
    // Waits for the font list, if it is built on its own thread.
    gfxPlatformFontList::PlatformFontList();
  }

  static nsTArray<BundleFace> BundleFaces(nsCString& aUnresolved) {
    nsTArray<BundleFace> out;
    StealthBundleFontList* bundle = StealthBundleFontList::Get();
    for (const auto& family : bundle->Families()) {
      nsTArray<mozilla::fontlist::Face::InitData> faces;
      bundle->GetFaces(family.mName, faces);
      for (const auto& face : faces) {
        BundleFace f;
        f.mFile = face.mDescriptor;
        f.mIndex = face.mIndex;
        if (!StealthBundleFontList::GetFacePath(f.mFile, f.mPath)) {
          aUnresolved.AppendPrintf(" %s", f.mFile.get());
          continue;
        }
        out.AppendElement(std::move(f));
      }
    }
    return out;
  }
};

}  // namespace

TEST_F(StealthFcBundleFonts, TheFontOfAFileOfTheBundleIsMadeFromThatFile)
{
  using mozilla::gfx::UnscaledFontFontconfig;

  ASSERT_TRUE(XRE_IsParentProcess());
  gfxPlatformFontList* list = gfxPlatformFontList::PlatformFontList();
  ASSERT_TRUE(list);
  ASSERT_TRUE(list->StealthBundleOnly());

  nsCString unresolved;
  nsTArray<BundleFace> faces = BundleFaces(unresolved);
  ASSERT_TRUE(unresolved.IsEmpty()) << "no path in <GRE>/fonts for:"
                                    << unresolved.get();
  ASSERT_FALSE(faces.IsEmpty());

  // A file with one face in the manifest has no other index to be taken for.
  // A collection (.ttc) names several faces, and which of them fontconfig
  // answers with is not this test's question; its file is.
  std::map<std::string, int> facesOfFile;
  for (const auto& f : faces) {
    ++facesOfFile[f.mPath.get()];
  }

  size_t wrongFile = 0, wrongIndex = 0, none = 0;
  nsCString firstWrong;
  for (const auto& f : faces) {
    RefPtr<mozilla::gfx::UnscaledFont> font =
        UnscaledFontFontconfig::CreateFromFontDescriptor(
            reinterpret_cast<const uint8_t*>(f.mPath.get()), f.mPath.Length(),
            f.mIndex);
    if (!font) {
      ++none;
      continue;
    }
    ASSERT_TRUE(font->GetType() == mozilla::gfx::FontType::FONTCONFIG);
    auto* fc = static_cast<UnscaledFontFontconfig*>(font.get());
    if (fc->GetFile() != f.mPath.get()) {
      if (!wrongFile++) {
        firstWrong.AppendPrintf("%s became %s", f.mPath.get(),
                                fc->GetFile().c_str());
      }
    } else if (facesOfFile[f.mPath.get()] == 1 && fc->GetIndex() != f.mIndex) {
      ++wrongIndex;
    }
  }
  EXPECT_EQ(0u, none) << "faces fontconfig did not answer for";
  EXPECT_EQ(0u, wrongFile) << "of " << faces.Length()
                           << " faces of the bundle the parent made from "
                              "another file; the first: "
                           << firstWrong.get();
  EXPECT_EQ(0u, wrongIndex);
}

// The other question, apart from the file: a collection (.ttc) holds several
// faces, and the descriptor of one is the path and the index of that face. The
// parent has to make the face it was told (Cambria Math is index 1 of
// cambria6_99.ttc, not Cambria), or WebRender draws another face of the file.
TEST_F(StealthFcBundleFonts, EachFaceOfACollectionIsMadeWithItsOwnIndex)
{
  using mozilla::gfx::UnscaledFontFontconfig;

  ASSERT_TRUE(XRE_IsParentProcess());
  ASSERT_TRUE(gfxPlatformFontList::PlatformFontList());

  nsCString unresolved;
  nsTArray<BundleFace> faces = BundleFaces(unresolved);
  ASSERT_TRUE(unresolved.IsEmpty()) << "no path in <GRE>/fonts for:"
                                    << unresolved.get();

  std::map<std::string, int> facesOfFile;
  for (const auto& f : faces) {
    ++facesOfFile[f.mPath.get()];
  }

  size_t collectionFaces = 0, wrong = 0;
  nsCString report;
  for (const auto& f : faces) {
    if (facesOfFile[f.mPath.get()] < 2) {
      continue;
    }
    ++collectionFaces;
    RefPtr<mozilla::gfx::UnscaledFont> font =
        UnscaledFontFontconfig::CreateFromFontDescriptor(
            reinterpret_cast<const uint8_t*>(f.mPath.get()), f.mPath.Length(),
            f.mIndex);
    if (!font) {
      ++wrong;
      report.AppendPrintf("\n  %s index %u: no font", f.mFile.get(), f.mIndex);
      continue;
    }
    ASSERT_TRUE(font->GetType() == mozilla::gfx::FontType::FONTCONFIG);
    auto* fc = static_cast<UnscaledFontFontconfig*>(font.get());
    if (fc->GetFile() != f.mPath.get()) {
      ++wrong;
      report.AppendPrintf("\n  %s index %u: came back from the file %s",
                          f.mFile.get(), f.mIndex, fc->GetFile().c_str());
    } else if (fc->GetIndex() != f.mIndex) {
      ++wrong;
      report.AppendPrintf("\n  %s: expected index %u, got index %u",
                          f.mFile.get(), f.mIndex, fc->GetIndex());
    }
  }
  // The bundle has collections (cambria6_99.ttc, msgothic5_32.ttc, ...): none
  // would make the loop above prove nothing.
  ASSERT_GT(collectionFaces, 0u);
  EXPECT_EQ(0u, wrong) << wrong << " of " << collectionFaces
                       << " faces of collections were not made as asked:"
                       << report.get();
}
