/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsScreencastService.h"

#include <stdio.h>
#include <algorithm>
#include <atomic>
#include <bit>
#include <cinttypes>
#include <memory>
#include <utility>

#include "VideoEngine.h"
#include "video_engine/desktop_capture_impl.h"

#include "api/scoped_refptr.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_frame.h"
#include "api/video/video_frame_buffer.h"
#include "api/video/video_sink_interface.h"
#include "modules/video_capture/video_capture_defines.h"

#include "gfxPlatform.h"
#include "mozilla/Base64.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/EndianUtils.h"
#include "mozilla/PresShell.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/gfx/Rect.h"
#include "nsIDocShell.h"
#include "nsIRandomGenerator.h"
#include "nsIWidget.h"
#include "nsServiceManagerUtils.h"
#include "nsThreadUtils.h"

extern "C" {
#include "jpeglib.h"
}
#include "libyuv/convert_argb.h"

namespace mozilla {

NS_IMPL_ISUPPORTS(nsScreencastService, nsIScreencastService)

namespace {

// Flow control. A client that cannot keep up sees fewer frames; the queue to
// the main thread never grows, and neither does the base64 held in memory.
const uint32_t kMaxFramesInFlight = 1;

const uint32_t kRetryDelayMs = 1000;

const uint32_t kHeartbeatMs = 250;
const uint32_t kHeartbeatTickMs = 100;

StaticRefPtr<nsScreencastService> gScreencastService;

// Atomic: every session creates its modules on its own control thread.
int32_t NextModuleId() {
  static std::atomic<int32_t> sModuleId{0};
  return ++sModuleId;
}

nsresult GenerateUid(nsString& aUid) {
  nsresult rv = NS_OK;
  nsCOMPtr<nsIRandomGenerator> rg =
      do_GetService("@mozilla.org/security/random-generator;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  uint8_t* buffer = nullptr;
  const int kLen = 16;
  rv = rg->GenerateRandomBytes(kLen, &buffer);
  NS_ENSURE_SUCCESS(rv, rv);
  for (int i = 0; i < kLen; i++) {
    aUid.AppendPrintf("%02x", buffer[i]);
  }
  free(buffer);
  return rv;
}

}  // namespace

class nsScreencastService::Session final
    : public webrtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(Session)

  Session(nsIScreencastServiceClient* aClient, nsIWidget* aWidget,
          nsIThread* aControl, const nsACString& aWindowId, int aWidth,
          int aHeight, int aViewportWidth, int aViewportHeight,
          gfx::IntMargin aMargin, uint32_t aQuality, uint32_t aFps)
      : mClient(aClient),
        mWidget(aWidget),
        mControl(aControl),
        mWindowId(aWindowId),
        mWidth(aWidth),
        mHeight(aHeight),
        mViewportWidth(aViewportWidth),
        mViewportHeight(aViewportHeight),
        mMargin(aMargin),
        mQuality(aQuality),
        mFps(aFps),
        mHeartbeatAge(HeartbeatAgeFor(aFps)) {}

  // The silence after which the last frame is repeated: kHeartbeatMs, or the
  // period of the requested rate when that is longer, so a repetition never
  // adds a frame the rate itself would not have. aFps is never 0: Start
  // refuses it.
  static TimeDuration HeartbeatAgeFor(uint32_t aFps) {
    return TimeDuration::FromMilliseconds(
        std::max(double(kHeartbeatMs), 1000.0 / double(aFps)));
  }

  nsIWidget* Widget() const { return mWidget; }

  // Main thread. The module is created and started on the control thread, and
  // DesktopCaptureImpl asserts that StartCapture and StopCapture come from the
  // thread that created it. Nothing here waits for it (see the comment on the
  // class): a start that fails is tried again after kRetryDelayMs, as a module
  // that ends is, and the caller hears of a window that cannot be captured by
  // the frames not coming, as of one that stopped being capturable. Only a
  // control thread that takes no task is the caller's answer.
  bool Start() {
    nsresult rv = mControl->Dispatch(NS_NewRunnableFunction(
        "nsScreencastService::Session::Start", [self = RefPtr{this}]() {
          if (!self->mStopped.load() && !self->CreateAndStartModule()) {
            self->RetryLater();
          }
        }));
    if (NS_FAILED(rv)) {
      // Nothing started, so nobody is told: the caller hears the failure.
      // The client and the widget are dropped here for the reason Stop gives.
      mStopped.store(true);
      mClient = nullptr;
      mWidget = nullptr;
      ShutdownControl();
      return false;
    }
    ArmHeartbeat();
    return true;
  }

  // Main thread. Nothing here waits: the module is released on the control
  // thread, which then ends. A frame already queued to the main thread finds
  // mStopped set and drops itself, and so do the retry and the heartbeat.
  //
  // The widget and the client are main-thread objects and are dropped here,
  // because the last reference to this session may go on another thread.
  void Stop() {
    if (mStopped.exchange(true)) {
      return;
    }
    if (mClient) {
      mClient->ScreencastStopped();
      mClient = nullptr;
    }
    mWidget = nullptr;
    ShutdownControl();
  }

  // Control thread. The module's own word that it will not ask for frames any
  // more - a permanent error from the capturer. The module is released and
  // another one is tried after kRetryDelayMs, for as long as this session
  // lives: a window that cannot be captured now is usually a window that can
  // be captured in a moment.
  void OnCaptureEnded() {
    if (mStopped.load()) {
      return;
    }
    ReleaseModule();
    // Whatever the old module owed an acknowledgement for is not coming
    // through it any more; the next module starts with the budget it needs.
    mFramesInFlight.store(0);
    RetryLater();
  }

  void Ack() {
    if (mFramesInFlight.load() == 0) {
      return;
    }
    mFramesInFlight.fetch_sub(1);
  }

  // Capture thread.
  void OnFrame(const webrtc::VideoFrame& aFrame) override {
    if (mStopped.load() || mFramesInFlight.load() >= kMaxFramesInFlight) {
      return;
    }
    webrtc::scoped_refptr<webrtc::I420BufferInterface> i420 =
        aFrame.video_frame_buffer()->ToI420();
    if (!i420) {
      return;
    }
    const int frameWidth = i420->width();
    const int frameHeight = i420->height();

    const int marginLeft = int(mMargin.left);
    const int marginTop = int(mMargin.top);
    const int marginRight = int(mMargin.right);
    const int marginBottom = int(mMargin.bottom);
    const int left = std::clamp(marginLeft, 0, std::max(frameWidth - 1, 0));
    const int top = std::clamp(marginTop, 0, std::max(frameHeight - 1, 0));
    int cropWidth = frameWidth - left - std::max(marginRight, 0);
    int cropHeight = frameHeight - top - std::max(marginBottom, 0);
    // A minimized window is captured as 1x1.
    if (cropWidth <= 1 || cropHeight <= 1) {
      return;
    }
    // A headed window brings its size in sync with the viewport slowly.
    if (mViewportWidth && cropWidth > mViewportWidth) {
      cropWidth = mViewportWidth;
    }
    if (mViewportHeight && cropHeight > mViewportHeight) {
      cropHeight = mViewportHeight;
    }
    // CropAndScaleFrom asserts these with RTC_CHECK, which aborts the parent
    // process. A frame we cannot describe is dropped instead.
    if (left + cropWidth > frameWidth || top + cropHeight > frameHeight) {
      return;
    }

    // Scale down to fit the requested bound, never up.
    double scale = 1.0;
    if (mWidth < cropWidth || mHeight < cropHeight) {
      scale = std::min(1.0, std::min(double(mWidth) / cropWidth,
                                     double(mHeight) / cropHeight));
    }
    const int outWidth = std::max(1, int(cropWidth * scale));
    const int outHeight = std::max(1, int(cropHeight * scale));

    // One step: the crop and the scale together, straight into a buffer that
    // is already the output size. Nothing outside the kept area is ever
    // converted, which is the half of the work Playwright's version did and
    // then threw away.
    webrtc::scoped_refptr<webrtc::I420Buffer> out =
        webrtc::I420Buffer::Create(outWidth, outHeight);
    if (!out) {
      return;
    }
    out->CropAndScaleFrom(*i420, left, top, cropWidth, cropHeight);

    // I420 to ARGB. libyuv's "ARGB" is B,G,R,A in memory on little-endian.
    const int stride = outWidth * 4;
    std::unique_ptr<uint8_t[]> argb(new uint8_t[size_t(stride) * outHeight]);
    if (libyuv::I420ToARGB(out->DataY(), out->StrideY(), out->DataU(),
                           out->StrideU(), out->DataV(), out->StrideV(),
                           argb.get(), stride, outWidth, outHeight) != 0) {
      return;
    }

    jpeg_compress_struct info;
    jpeg_error_mgr error;
    info.err = jpeg_std_error(&error);
    jpeg_create_compress(&info);
    unsigned char* jpegBuffer = nullptr;
    unsigned long jpegSize = 0;
    jpeg_mem_dest(&info, &jpegBuffer, &jpegSize);
    info.image_width = outWidth;
    info.image_height = outHeight;
    info.input_components = 4;
    if constexpr (std::endian::native == std::endian::little) {
      info.in_color_space = JCS_EXT_BGRA;
    } else {
      info.in_color_space = JCS_EXT_ARGB;
    }
    jpeg_set_defaults(&info);
    jpeg_set_quality(&info, int(mQuality), true);
    jpeg_start_compress(&info, true);
    while (info.next_scanline < info.image_height) {
      JSAMPROW row = argb.get() + size_t(info.next_scanline) * size_t(stride);
      if (jpeg_write_scanlines(&info, &row, 1) != 1) {
        fprintf(stderr, "screencast: the JPEG encoder refused a scanline\n");
        break;
      }
    }
    jpeg_finish_compress(&info);
    jpeg_destroy_compress(&info);

    nsCString base64;
    nsresult rv = Base64Encode(reinterpret_cast<const char*>(jpegBuffer),
                               uint32_t(jpegSize), base64);
    free(jpegBuffer);
    if (NS_WARN_IF(NS_FAILED(rv))) {
      return;
    }

    mFramesInFlight.fetch_add(1);
    NS_DispatchToMainThread(NS_NewRunnableFunction(
        "nsScreencastService::Session::Frame",
        [self = RefPtr{this}, base64 = std::move(base64), cropWidth,
         cropHeight]() {
          if (self->mStopped.load() || !self->mClient) {
            return;
          }
          // Kept for the heartbeat, which repeats it while the module is
          // quiet. Main thread only, like everything that reads it.
          self->mLastFrame = base64;
          self->mLastWidth = uint32_t(cropWidth);
          self->mLastHeight = uint32_t(cropHeight);
          self->Deliver();
        }));
  }

 private:
  ~Session() override = default;

  // Main thread. The control thread releases what it holds and ends, and its
  // last join is an event on this thread rather than a wait. The way out of a
  // Stop and of a Start that failed.
  void ShutdownControl() {
    if (!mControl) {
      return;
    }
    // Neither fails while the thread is alive, and a thread already gone at
    // XPCOM shutdown has taken its module down with it.
    (void)mControl->Dispatch(NS_NewRunnableFunction(
        "nsScreencastService::Session::Release",
        [self = RefPtr{this}]() { self->ReleaseModule(); }));
    (void)mControl->AsyncShutdown();
    mControl = nullptr;
  }

  // Control thread. A module for the window, started. Shared by the first
  // start and by every retry.
  bool CreateAndStartModule() {
    mModule = webrtc::DesktopCaptureImpl::Create(
        NextModuleId(), mWindowId.get(), camera::CaptureDeviceType::Window);
    if (!mModule || !StartModule()) {
      mModule = nullptr;
      return false;
    }
    return true;
  }

  // Control thread. Register, start, and listen for the module ending on its
  // own, on this same thread.
  bool StartModule() {
    webrtc::VideoCaptureCapability capability;
    // The desktop capturer takes its size from the window; the frame rate is
    // the only knob it reads here.
    capability.width = 1280;
    capability.height = 960;
    capability.maxFPS = static_cast<int32_t>(mFps);
    capability.videoType = webrtc::VideoType::kI420;
    mModule->RegisterCaptureDataCallback(this);
    if (mModule->StartCapture(capability) != 0) {
      mModule->DeRegisterCaptureDataCallback();
      fprintf(stderr, "screencast: StartCapture failed\n");
      return false;
    }
    mEnded = mModule->CaptureEndedEvent()->Connect(
        GetCurrentSerialEventTarget(), this, &Session::OnCaptureEnded);
    return true;
  }

  void ReleaseModule() {
    mEnded.DisconnectIfExists();
    if (mModule) {
      mModule->DeRegisterCaptureDataCallback();
      mModule->StopCapture();
      mModule = nullptr;
    }
  }

  // Control thread.
  void RetryLater() {
    NS_DelayedDispatchToCurrentThread(
        NS_NewRunnableFunction("nsScreencastService::Session::Retry",
                               [self = RefPtr{this}]() { self->Retry(); }),
        kRetryDelayMs);
  }

  // Control thread. A new module for the same window, and another attempt
  // later if this one cannot even start.
  void Retry() {
    if (mStopped.load() || mModule) {
      return;
    }
    if (!CreateAndStartModule()) {
      RetryLater();
    }
  }

  void ArmHeartbeat() {
    NS_DelayedDispatchToCurrentThread(
        NS_NewRunnableFunction("nsScreencastService::Session::Heartbeat",
                               [self = RefPtr{this}]() { self->Heartbeat(); }),
        kHeartbeatTickMs);
  }

  // Main thread. The last frame again, if the module has handed over nothing
  // for a heartbeat and the client is not still holding one.
  void Heartbeat() {
    if (mStopped.load()) {
      return;
    }
    if (!mLastFrame.IsEmpty() && mClient && mFramesInFlight.load() == 0 &&
        TimeStamp::Now() - mLastDelivered > mHeartbeatAge) {
      mFramesInFlight.fetch_add(1);
      Deliver();
    }
    ArmHeartbeat();
  }

  // Main thread. The frame held in mLastFrame goes to the client, counted
  // against the flow control by whoever called this.
  void Deliver() {
    mLastDelivered = TimeStamp::Now();
    NS_ConvertUTF8toUTF16 utf16(mLastFrame);
    mClient->ScreencastFrame(utf16, mLastWidth, mLastHeight);
  }

  // Main thread only: the client is a JavaScript object.
  nsCOMPtr<nsIScreencastServiceClient> mClient;
  // Main thread only.
  nsCOMPtr<nsIWidget> mWidget;
  // Main thread only; null once the session stopped.
  nsCOMPtr<nsIThread> mControl;
  // Control thread only.
  webrtc::scoped_refptr<webrtc::DesktopCaptureImpl> mModule;
  // Control thread only.
  MediaEventListener mEnded;
  const nsCString mWindowId;
  nsCString mLastFrame;
  uint32_t mLastWidth = 0;
  uint32_t mLastHeight = 0;
  TimeStamp mLastDelivered;
  const int mWidth;
  const int mHeight;
  const int mViewportWidth;
  const int mViewportHeight;
  const gfx::IntMargin mMargin;
  const uint32_t mQuality;
  const uint32_t mFps;
  const TimeDuration mHeartbeatAge;
  std::atomic<bool> mStopped{false};
  std::atomic<uint32_t> mFramesInFlight{0};
};

// static
already_AddRefed<nsIScreencastService> nsScreencastService::GetSingleton() {
  if (!gScreencastService) {
    gScreencastService = new nsScreencastService();
    ClearOnShutdown(&gScreencastService);
  }
  return do_AddRef(gScreencastService);
}

nsScreencastService::nsScreencastService() = default;

nsScreencastService::~nsScreencastService() {
  // A session outliving the service would leave a capture thread running and
  // a window being read after nobody is listening.
  for (auto& it : mIdToSession) {
    it.second->Stop();
  }
  mIdToSession.clear();
}

NS_IMETHODIMP nsScreencastService::StartScreencast(
    nsIScreencastServiceClient* aClient, nsIDocShell* aDocShell,
    uint32_t aWidth, uint32_t aHeight, uint32_t aQuality,
    uint32_t aViewportWidth, uint32_t aViewportHeight, uint32_t aOffsetTop,
    bool aFullWindow, uint32_t aFps, nsAString& aSessionId) {
  MOZ_RELEASE_ASSERT(NS_IsMainThread(),
                     "the screencast is started on the main thread");
  if (!aClient || !aDocShell || !aWidth || !aHeight || !aFps) {
    return NS_ERROR_INVALID_ARG;
  }
  // No native window, nothing to capture. Said plainly, instead of a stream
  // of nothing: HeadlessWidget::GetNativeData returns null for every request.
  if (gfxPlatform::IsHeadless()) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  PresShell* presShell = aDocShell->GetPresShell();
  if (!presShell) {
    return NS_ERROR_UNEXPECTED;
  }
  nsCOMPtr<nsIWidget> widget = presShell->GetRootWidget();
  if (!widget) {
    return NS_ERROR_UNEXPECTED;
  }
  // The native window id belongs to the top level, and a capture of a child
  // widget would miss the tab strip and the address bar - which is exactly
  // what fullWindow exists to keep.
  if (nsIWidget* topLevel = widget->GetTopLevelWidget()) {
    widget = topLevel;
  }

  // The capture module holds ONE sink, so one session per window. Two pages
  // in one window share the window, and a second screencast there is refused
  // rather than silently stealing the first one's frames.
  for (auto& it : mIdToSession) {
    if (it.second->Widget() == widget) {
      return NS_ERROR_ALREADY_INITIALIZED;
    }
  }

  gfx::IntMargin margin;
  {
    auto screenBounds = widget->GetScreenBounds().ToUnknownRect();
    auto clientBounds = widget->GetClientBounds().ToUnknownRect();
    for (auto parent = widget->GetParent(); parent;
         parent = parent->GetParent()) {
      auto parentBounds = parent->GetClientBounds().ToUnknownRect();
      clientBounds.MoveBy(parentBounds.X(), parentBounds.Y());
    }
    margin = screenBounds - clientBounds;
  }
  if (!aFullWindow) {
    margin.top += int32_t(aOffsetTop);
  }

  uintptr_t rawWindowId = reinterpret_cast<uintptr_t>(
      widget->GetNativeData(NS_NATIVE_WINDOW_WEBRTC_DEVICE_ID));
  if (!rawWindowId) {
    fprintf(stderr, "screencast: this widget has no native window id\n");
    return NS_ERROR_NOT_AVAILABLE;
  }
  nsCString windowId;
  windowId.AppendPrintf("%" PRIuPTR, rawWindowId);

  nsString uid;
  nsresult rv = GenerateUid(uid);
  NS_ENSURE_SUCCESS(rv, rv);

  // The thread the capture module is created, started and stopped on: see
  // the comment on Session for why it is never this one.
  nsCOMPtr<nsIThread> control;
  rv = NS_NewNamedThread("ScreencastCtl", getter_AddRefs(control));
  NS_ENSURE_SUCCESS(rv, rv);

  RefPtr<Session> session = new Session(
      aClient, widget, control, windowId, int(aWidth), int(aHeight),
      int(aViewportWidth), int(aViewportHeight), margin, aQuality, aFps);
  if (!session->Start()) {
    return NS_ERROR_FAILURE;
  }
  aSessionId = uid;
  mIdToSession.emplace(uid, std::move(session));
  return NS_OK;
}

NS_IMETHODIMP nsScreencastService::StopScreencast(
    const nsAString& aSessionId) {
  MOZ_RELEASE_ASSERT(NS_IsMainThread(),
                     "the screencast is stopped on the main thread");
  nsString sessionId(aSessionId);
  auto it = mIdToSession.find(sessionId);
  if (it == mIdToSession.end()) {
    return NS_ERROR_INVALID_ARG;
  }
  RefPtr<Session> session = it->second;
  mIdToSession.erase(it);
  session->Stop();
  return NS_OK;
}

NS_IMETHODIMP nsScreencastService::ScreencastFrameAck(
    const nsAString& aSessionId) {
  nsString sessionId(aSessionId);
  auto it = mIdToSession.find(sessionId);
  if (it == mIdToSession.end()) {
    return NS_ERROR_INVALID_ARG;
  }
  it->second->Ack();
  return NS_OK;
}

}  // namespace mozilla
