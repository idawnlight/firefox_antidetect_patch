/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_StealthInputEventBirth_h
#define mozilla_StealthInputEventBirth_h

#include <cmath>

#include "mozilla/Assertions.h"
#include "mozilla/BasicEvents.h"  // WidgetEventTime
#include "mozilla/TimeStamp.h"
#include "mozilla/dom/BrowsingContext.h"
#include "nsError.h"

namespace mozilla {

/**
 * Stealthfox [B299] [B301]: the id of the page (the top-level browsing context)
 * an input event is for. Two pages of one content process are two independent
 * event streams, each with its own order of births. 0 when the caller does not
 * know the page: those events share one stream.
 */
inline uint64_t StealthPageIdOf(dom::BrowsingContext* aBrowsingContext) {
  if (!aBrowsingContext) {
    return 0;
  }
  dom::BrowsingContext* top = aBrowsingContext->Top();
  return top ? top->Id() : aBrowsingContext->Id();
}

/**
 * Stealthfox [B299] [B301]: the order of the births of ONE page, keys, mouse and
 * wheel together: a birth never goes before the previous one of the same page.
 * A birth of another page does not move it. The state is a few slots kept by
 * page id (the least recently used one is reused, so the memory is bounded
 * whatever the number of pages that came and went; a page that lost its slot
 * starts a new order, which only loosens the guard for a page that was idle).
 * The main thread only, as the births themselves.
 */
class StealthBirthOrder {
 public:
  // The birth for aPageId at aBorn, held back to the previous birth of that
  // page when it would go before it.
  static TimeStamp Keep(uint64_t aPageId, TimeStamp aBorn) {
    Slot& slot = SlotFor(aPageId);
    if (!slot.mLast.IsNull() && aBorn < slot.mLast) {
      aBorn = slot.mLast;
    }
    slot.mLast = aBorn;
    return aBorn;
  }

 private:
  struct Slot {
    uint64_t mPage = 0;
    uint64_t mUsed = 0;  // 0: never used
    TimeStamp mLast;
  };
  static constexpr size_t kSlots = 16;

  static Slot& SlotFor(uint64_t aPageId) {
    // An inline function's static: ONE instance in the whole binary, so the
    // mouse path (nsContentUtils), the wheel path (nsDOMWindowUtils) and the
    // key path (TextInputProcessor) share it.
    static Slot sSlots[kSlots];
    static uint64_t sClock = 0;
    Slot* oldest = &sSlots[0];
    for (Slot& slot : sSlots) {
      if (slot.mUsed && slot.mPage == aPageId) {
        slot.mUsed = ++sClock;
        return slot;
      }
      if (slot.mUsed < oldest->mUsed) {
        oldest = &slot;
      }
    }
    *oldest = Slot();
    oldest->mPage = aPageId;
    oldest->mUsed = ++sClock;
    return *oldest;
  }
};

/**
 * Stealthfox [B299] [B301]: the birth of a synthesized input event that
 * reaches the page aLatencyMs after it was born, as a system's does; never
 * before the previous such birth of the same page (aPageId), key, mouse or
 * wheel.
 *
 * An inline function: the C++17 rule gives the state of StealthBirthOrder ONE
 * instance in the whole binary. No lock, as before.
 *
 * There is no upper limit on the latency: a client that sent a key at its
 * planned instant and reaches the engine seconds late declares those seconds.
 * The conversion to ticks saturates; a birth that would fall before the clock
 * starts (null) is taken as the delivery instant, and a non-finite latency is
 * no latency.
 */
inline TimeStamp StealthInputEventBirth(double aLatencyMs,
                                        uint64_t aPageId = 0) {
  // Stealthfox [B299] [B301]: an input event is born in the system a few
  // milliseconds before a page's handler runs, and a page can tell: its
  // `timeStamp` is below `performance.now()` there. A synthesized one was born
  // at its dispatch, so a tracker that keeps only events from the past dropped
  // them. The caller's latency is taken off the birth, and never past the
  // birth of the previous one of the page, mouse, wheel or key alike, so the
  // times stay in order as a system's do.
  const TimeStamp now = TimeStamp::Now();
  TimeStamp born = now;
  if (std::isfinite(aLatencyMs) && aLatencyMs > 0) {
    born = now - TimeDuration::FromMilliseconds(aLatencyMs);
    if (born.IsNull()) {
      born = now;
    }
  }
  return StealthBirthOrder::Keep(aPageId, born);
}

/**
 * Stealthfox [B299] [B301]: born before the page sees it. Stamp aEvent with
 * the birth for aLatencyMs when the caller declared a latency. Works for the
 * mouse and the wheel event alike (the wheel as the mouse): mTimeStamp lives
 * on their common base. A latency of 0 (or less, or NaN) leaves the stamp the
 * event got at its construction.
 */
inline void StealthSetInputEventBirth(WidgetEventTime& aEvent,
                                      double aLatencyMs,
                                      uint64_t aPageId = 0) {
  if (aLatencyMs > 0) {
    aEvent.mTimeStamp = StealthInputEventBirth(aLatencyMs, aPageId);
  }
}

/**
 * Stealthfox [B299] [B301]: the page of an event is found here, from what the
 * call site has at hand, so that the hook in Mozilla's file stays one line:
 * a Document (its browsing context), or a PresShell (its Document). Templates
 * on the pointer, so this header needs neither Document.h nor PresShell.h:
 * the type is complete where the hook is written.
 */
template <class Source>
inline auto StealthPageOfSource(Source* aSource, int)
    -> decltype(StealthPageIdOf(aSource->GetBrowsingContext())) {
  return aSource ? StealthPageIdOf(aSource->GetBrowsingContext()) : 0;
}

template <class Source>
inline auto StealthPageOfSource(Source* aSource, long)
    -> decltype(StealthPageOfSource(aSource->GetDocument(), 0)) {
  return aSource ? StealthPageOfSource(aSource->GetDocument(), 0) : 0;
}

template <class Source>
inline auto StealthSetInputEventBirth(WidgetEventTime& aEvent,
                                      double aLatencyMs, Source* aSource)
    -> decltype(StealthPageOfSource(aSource, 0), void()) {
  StealthSetInputEventBirth(aEvent, aLatencyMs,
                            StealthPageOfSource(aSource, 0));
}

/**
 * Stealthfox [B299]: the birth of a key event the caller sent with a latency,
 * for nsITextInputProcessor (chrome only; nothing is added to the web-exposed
 * KeyboardEventInit). A null stamp when no latency was declared (0, less, NaN
 * or infinite): the event then keeps the stamp it got at its construction.
 * There is no cap: a latency of seconds is a birth.
 */
inline TimeStamp StealthInputEventBirthOrNull(double aLatencyMs,
                                              uint64_t aPageId = 0) {
  return aLatencyMs > 0 && std::isfinite(aLatencyMs)
             ? StealthInputEventBirth(aLatencyMs, aPageId)
             : TimeStamp();
}

/**
 * Stealthfox [B299]: the birth of the key that nsITextInputProcessor is
 * delivering. The caller declares the latency of the NEXT key with
 * setNextKeyLatency() (stored in the processor, mStealthNextKeyLatencyMs);
 * keydown(), keyup() and commitCompositionWith() each open this scope, which
 * takes the declared latency (one use: it is cleared) and holds the birth for
 * the duration of the call. KeydownInternal() and KeyupInternal() stamp their
 * copy of the key event through Stamp(); TextEventDispatcher copies the stamp
 * with AssignKeyEventData, and the keypress events are copies of the keydown,
 * so every key event of the call carries the birth. With no latency declared the
 * scope holds no birth and Stamp() does nothing: the event keeps the stamp of
 * its construction. The scopes nest (a restore on exit); the processor lives
 * on the main thread only, as the births of the mouse and the wheel do.
 *
 * Known limit: on commitCompositionWith() the keydown and keyup carry the
 * birth, but the composition events and the input event that follow keep the
 * time of the delivery, as they did with the old timer. They are created by
 * TextEventDispatcher::CommitComposition(), whose call in
 * TextInputProcessor.cpp is a line of Mozilla's and takes no stamp from here.
 */
class StealthKeyBirthScope {
 public:
  // aBirth: what setNextKeyLatency() declared for the next key, any struct
  // with mLatencyMs and mPageId (the page the key is for, whose order of
  // births the key joins; Juggler gives it). It is taken once: cleared here.
  template <class Birth>
  explicit StealthKeyBirthScope(Birth& aBirth) : mPrevious(Current()) {
    Current() = StealthInputEventBirthOrNull(aBirth.mLatencyMs, aBirth.mPageId);
    aBirth.mLatencyMs = 0;
    aBirth.mPageId = 0;
  }
  ~StealthKeyBirthScope() { Current() = mPrevious; }
  StealthKeyBirthScope(const StealthKeyBirthScope&) = delete;
  StealthKeyBirthScope& operator=(const StealthKeyBirthScope&) = delete;

  static void Stamp(WidgetEventTime& aEvent) {
    if (!Current().IsNull()) {
      aEvent.mTimeStamp = Current();
    }
  }

 private:
  static TimeStamp& Current() {
    static TimeStamp sBorn;
    return sBorn;
  }
  TimeStamp mPrevious;
};

/**
 * Stealthfox [B299]: nsITextInputProcessor.setNextKeyLatency(). Chrome only
 * (as the rest of the interface); stores the latency of the next key in the
 * processor's field, to be taken by the scope above.
 */
template <class Birth>
inline nsresult StealthSetNextKeyLatency(Birth& aField, double aLatencyMs,
                                         uint64_t aPageId,
                                         bool aIsCallerChrome) {
  MOZ_RELEASE_ASSERT(aIsCallerChrome);
  aField.mLatencyMs = aLatencyMs;
  aField.mPageId = aPageId;
  return NS_OK;
}

/**
 * Stealthfox [B299]: what setNextKeyLatency() declares for the next key. The
 * processor's header (a Mozilla file with a budget of one line) holds a struct
 * of this shape, declared where its member is, without an include.
 */
struct StealthKeyBirth {
  double mLatencyMs = 0;
  uint64_t mPageId = 0;
};

}  // namespace mozilla

#endif  // mozilla_StealthInputEventBirth_h
