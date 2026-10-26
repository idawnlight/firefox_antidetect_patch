/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gfxDWriteCommon.h"

#include <unordered_map>

#include "mozilla/StaticMutex.h"
#include "mozilla/gfx/Logging.h"

class gfxDWriteFontFileStream;

using namespace mozilla;

static StaticMutex sFontFileStreamsMutex MOZ_UNANNOTATED;
static uint64_t sNextFontFileKey = 0;
MOZ_RUNINIT static std::unordered_map<uint64_t, gfxDWriteFontFileStream*>
    sFontFileStreams;

IDWriteFontFileLoader* gfxDWriteFontFileLoader::mInstance = nullptr;

IFACEMETHODIMP_(ULONG) gfxDWriteFontFileStream::Release() {
  MOZ_ASSERT(0 != mRefCnt, "dup release");
  uint32_t count = --mRefCnt;
  if (count == 0) {
    // Avoid locking unless necessary. Verify the refcount hasn't changed
    // while locked. Delete within the scope of the lock when zero.
    StaticMutexAutoLock lock(sFontFileStreamsMutex);
    if (0 != mRefCnt) {
      return mRefCnt;
    }
    delete this;
  }
  return count;
}

gfxDWriteFontFileStream::gfxDWriteFontFileStream(FontData* aData,
                                                 uint64_t aFontFileKey)
    : mData(aData), mFontFileKey(aFontFileKey) {}

gfxDWriteFontFileStream::gfxDWriteFontFileStream(const uint8_t* aData,
                                                 uint32_t aLength,
                                                 uint64_t aFontFileKey,
                                                 Borrowed)
    : mBorrowed(aData), mBorrowedLength(aLength), mFontFileKey(aFontFileKey) {
  // Nothing to copy. The caller guarantees the bytes outlive this object; see
  // the header for why that guarantee holds for the only caller.
}

gfxDWriteFontFileStream::~gfxDWriteFontFileStream() {
  sFontFileStreams.erase(mFontFileKey);
}

const uint8_t* gfxDWriteFontFileStream::Bytes() const {
  return mBorrowed ? mBorrowed : mData->Data();
}

uint32_t gfxDWriteFontFileStream::BytesLength() const {
  return mBorrowed ? mBorrowedLength : mData->Length();
}

HRESULT STDMETHODCALLTYPE
gfxDWriteFontFileStream::GetFileSize(UINT64* fileSize) {
  *fileSize = BytesLength();
  return S_OK;
}

HRESULT STDMETHODCALLTYPE
gfxDWriteFontFileStream::GetLastWriteTime(UINT64* lastWriteTime) {
  return E_NOTIMPL;
}

HRESULT STDMETHODCALLTYPE gfxDWriteFontFileStream::ReadFileFragment(
    const void** fragmentStart, UINT64 fileOffset, UINT64 fragmentSize,
    void** fragmentContext) {
  // We are required to do bounds checking.
  if (fileOffset + fragmentSize > (UINT64)BytesLength()) {
    return E_FAIL;
  }
  // We should be alive for the duration of this.
  *fragmentStart = Bytes() + fileOffset;
  *fragmentContext = nullptr;
  return S_OK;
}

void STDMETHODCALLTYPE
gfxDWriteFontFileStream::ReleaseFileFragment(void* fragmentContext) {}

HRESULT STDMETHODCALLTYPE gfxDWriteFontFileLoader::CreateStreamFromKey(
    const void* fontFileReferenceKey, UINT32 fontFileReferenceKeySize,
    IDWriteFontFileStream** fontFileStream) {
  if (!fontFileReferenceKey || !fontFileStream) {
    return E_POINTER;
  }

  StaticMutexAutoLock lock(sFontFileStreamsMutex);
  uint64_t fontFileKey = *static_cast<const uint64_t*>(fontFileReferenceKey);
  auto found = sFontFileStreams.find(fontFileKey);
  if (found == sFontFileStreams.end()) {
    *fontFileStream = nullptr;
    return E_FAIL;
  }

  found->second->AddRef();
  *fontFileStream = found->second;
  return S_OK;
}

// Stealth: the body of the two entry points below, which differ ONLY in whether
// the stream holds a FontData or borrows the bytes. Written as one function
// instead of two so the registration, the key allocation and the locking cannot
// drift apart. aBorrowedData non-null selects the borrowed stream (aFontData is
// then ignored and may be null).
static HRESULT CreateFontFileImpl(FontData* aFontData,
                                  const uint8_t* aBorrowedData,
                                  uint32_t aBorrowedLength,
                                  IDWriteFontFile** aFontFile,
                                  gfxDWriteFontFileStream** aFontFileStream) {
  MOZ_ASSERT(aFontFile);
  MOZ_ASSERT(aFontFileStream);

  RefPtr<IDWriteFactory> factory = gfx::Factory::GetDWriteFactory();
  if (!factory) {
    gfxCriticalError()
        << "Failed to get DWrite Factory in CreateCustomFontFile.";
    return E_FAIL;
  }

  sFontFileStreamsMutex.Lock();
  uint64_t fontFileKey = sNextFontFileKey++;
  RefPtr<gfxDWriteFontFileStream> ffsRef =
      aBorrowedData ? new gfxDWriteFontFileStream(
                          aBorrowedData, aBorrowedLength, fontFileKey,
                          gfxDWriteFontFileStream::Borrowed::Yes)
                    : new gfxDWriteFontFileStream(aFontData, fontFileKey);
  sFontFileStreams[fontFileKey] = ffsRef;
  sFontFileStreamsMutex.Unlock();

  RefPtr<IDWriteFontFile> fontFile;
  HRESULT hr = factory->CreateCustomFontFileReference(
      &fontFileKey, sizeof(fontFileKey),
      gfxDWriteFontFileLoader::Instance(), getter_AddRefs(fontFile));
  if (FAILED(hr)) {
    NS_WARNING("Failed to load font file from data!");
    return hr;
  }

  fontFile.forget(aFontFile);
  ffsRef.forget(aFontFileStream);

  return S_OK;
}

/* static */
HRESULT
gfxDWriteFontFileLoader::CreateCustomFontFile(
    FontData* aFontData, IDWriteFontFile** aFontFile,
    gfxDWriteFontFileStream** aFontFileStream) {
  return CreateFontFileImpl(aFontData, /* aBorrowedData */ nullptr,
                            /* aBorrowedLength */ 0, aFontFile,
                            aFontFileStream);
}

/* static */
HRESULT
gfxDWriteFontFileLoader::CreateBorrowedFontFile(
    const uint8_t* aFontData, uint32_t aLength, IDWriteFontFile** aFontFile,
    gfxDWriteFontFileStream** aFontFileStream) {
  return CreateFontFileImpl(/* aFontData */ nullptr, aFontData, aLength,
                            aFontFile, aFontFileStream);
}

size_t gfxDWriteFontFileLoader::SizeOfIncludingThis(
    MallocSizeOf mallocSizeOf) const {
  // We are a singleton type that is effective owner of sFontFileStreams.
  MOZ_ASSERT(this == mInstance);

  size_t sizes = mallocSizeOf(this);

  // We don't have memory-reporting methods for a std::unordered_map, so just
  // take the size of the actual elements stored for now.
  sizes += sFontFileStreams.size() *
           (sizeof(uint64_t) + sizeof(gfxDWriteFontFileStream*));

  return sizes;
}
