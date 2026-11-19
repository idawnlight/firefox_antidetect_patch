/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The properties of the synthesized input event birth ([B299] [B301]) and of
// the Juggler id that rides on a synthesized mouse event ([B217]), the flag a Juggler event does not carry on the
// asynchronous route (APZ) and the data of the notification of a crashed frame.

#include <limits>

#include "StealthFrameCrash.h"
#include "StealthInputEventBirth.h"
#include "StealthJugglerEventId.h"
#include "gtest/gtest.h"
#include "mozilla/BasicEvents.h"
#include "mozilla/MouseEvents.h"
#include "mozilla/TextEvents.h"
#include "mozilla/TimeStamp.h"

using namespace mozilla;

TEST(StealthInputEventBirth, NoLatencyKeepsTheConstructionStamp)
{
  WidgetEventTime event;
  const TimeStamp before = event.mTimeStamp;
  StealthSetInputEventBirth(event, 0);
  EXPECT_TRUE(event.mTimeStamp == before);
  StealthSetInputEventBirth(event, -5);
  EXPECT_TRUE(event.mTimeStamp == before);
  StealthSetInputEventBirth(event, std::numeric_limits<double>::quiet_NaN());
  EXPECT_TRUE(event.mTimeStamp == before);
}

TEST(StealthInputEventBirth, BirthIsInThePastAndNotBeforeTheLatency)
{
  const TimeStamp before = TimeStamp::Now();
  WidgetEventTime event;
  StealthSetInputEventBirth(event, 20);
  EXPECT_TRUE(event.mTimeStamp <= TimeStamp::Now());
  EXPECT_TRUE(event.mTimeStamp >= before - TimeDuration::FromMilliseconds(20));
}

TEST(StealthInputEventBirth, NeverPastThePreviousBirth)
{
  // A short latency, then a long one: the second would be born before the
  // first, so it takes the first's birth.
  WidgetEventTime first, second;
  StealthSetInputEventBirth(first, 10);
  StealthSetInputEventBirth(second, 5000);
  EXPECT_TRUE(second.mTimeStamp == first.mTimeStamp);

  // Whatever the latencies, the births never go back.
  TimeStamp last = second.mTimeStamp;
  for (double latency : {30.0, 2.0, 400.0, 1.0, 90.0, 7.0}) {
    WidgetEventTime event;
    StealthSetInputEventBirth(event, latency);
    EXPECT_TRUE(event.mTimeStamp >= last);
    last = event.mTimeStamp;
  }
}

// The born-in-the-past time of a key ([B299]): nsITextInputProcessor stamps its copy of the key event with
// StealthInputEventBirthOrNull(latency) before TextEventDispatcher copies it again with AssignKeyEventData. The
// processor itself needs a window and a widget, which a gtest has none of; what these tests hold is the two pieces
// it is made of: the birth the latency gives, and a stamp that the copies of a WidgetKeyboardEvent keep.
TEST(StealthInputEventBirth, KeyNoLatencyIsNoBirth)
{
  EXPECT_TRUE(StealthInputEventBirthOrNull(0).IsNull());
  EXPECT_TRUE(StealthInputEventBirthOrNull(-5).IsNull());
  EXPECT_TRUE(StealthInputEventBirthOrNull(std::numeric_limits<double>::quiet_NaN()).IsNull());
  // an infinite latency is no birth (it is not a number of milliseconds); an hour or a day is one, there is no cap
  EXPECT_TRUE(StealthInputEventBirthOrNull(std::numeric_limits<double>::infinity()).IsNull());
}

TEST(StealthInputEventBirth, KeyLatencyIsBornInThePast)
{
  const TimeStamp before = TimeStamp::Now();
  const TimeStamp born = StealthInputEventBirthOrNull(35);
  ASSERT_FALSE(born.IsNull());
  EXPECT_TRUE(born <= TimeStamp::Now());
  EXPECT_TRUE(born >= before - TimeDuration::FromMilliseconds(35));
}

TEST(StealthInputEventBirth, TheStampOfAKeyEventSurvivesTheCopiesOfTheProcessor)
{
  // KeydownInternal copies the event and stamps the copy; TextEventDispatcher builds the event that is dispatched with
  // AssignKeyEventData (and the keypress is a copy of the copy). The stamp must come through all of them.
  WidgetKeyboardEvent original(true, eKeyDown, nullptr);
  const TimeStamp born = original.mTimeStamp - TimeDuration::FromMilliseconds(50);

  WidgetKeyboardEvent copy(original);
  copy.mTimeStamp = born;

  WidgetKeyboardEvent dispatched(true, eKeyDown, nullptr);
  dispatched.AssignKeyEventData(copy, false);
  EXPECT_TRUE(dispatched.mTimeStamp == born);

  WidgetKeyboardEvent keypress(copy);
  keypress.mMessage = eKeyPress;
  EXPECT_TRUE(keypress.mTimeStamp == born);

  // the original was not touched: the processor never modifies the event it is given
  EXPECT_TRUE(original.mTimeStamp != born);
}

TEST(StealthInputEventBirth, KeysAndMouseShareTheOrderOfBirths)
{
  // a key born after a mouse event keeps the order of the system: never before the previous birth, of either kind
  WidgetEventTime mouse;
  StealthSetInputEventBirth(mouse, 5);
  const TimeStamp key = StealthInputEventBirthOrNull(4000);
  ASSERT_FALSE(key.IsNull());
  EXPECT_TRUE(key >= mouse.mTimeStamp);
}

TEST(StealthJugglerEventId, TravelsOnTheMouseEvent)
{
  WidgetMouseEvent event(true, eMouseDown, nullptr, WidgetMouseEvent::eReal);
  EXPECT_EQ(event.mJugglerEventId, 0u);
  StealthSetJugglerId(event, 7);
  EXPECT_EQ(event.mJugglerEventId, 7u);
}

// The asynchronous (APZ) route marks an event "async synthesized for tests", and nsBaseDragService then sends a drag
// started on it to the native drag loop. A Juggler event (it has an id) must come out of the route without the flag; every
// other event keeps what the route gave it.
TEST(StealthJugglerEventId, ADragStartedByAJugglerEventIsNotAsyncSynthesized)
{
  WidgetMouseEvent juggler(true, eMouseDown, nullptr, WidgetMouseEvent::eReal);
  StealthSetJugglerId(juggler, 7);
  juggler.mFlags.mIsSynthesizedForTests = true;
  juggler.mFlags.mIsAsyncSynthesizedForTests = true;
  StealthJugglerNotAsyncSynthesized(juggler);
  EXPECT_FALSE(juggler.mFlags.mIsAsyncSynthesizedForTests);
  // still a synthesized event: the drag session of the content process stays its own (no native loop)
  EXPECT_TRUE(juggler.mFlags.mIsSynthesizedForTests);
}

TEST(StealthJugglerEventId, AnEventWithNoIdKeepsTheFlagOfTheRoute)
{
  WidgetMouseEvent other(true, eMouseDown, nullptr, WidgetMouseEvent::eReal);
  EXPECT_EQ(other.mJugglerEventId, 0u);
  other.mFlags.mIsSynthesizedForTests = true;
  other.mFlags.mIsAsyncSynthesizedForTests = true;
  StealthJugglerNotAsyncSynthesized(other);
  EXPECT_TRUE(other.mFlags.mIsAsyncSynthesizedForTests);
  EXPECT_TRUE(other.mFlags.mIsSynthesizedForTests);
}

// The data of oop-frameloader-crashed is the id of the browsing context that crashed, as digits; none when the caller
// does not say which one (a frameloader that failed to build: the observer takes that for the tab).
TEST(StealthFrameCrash, NoContextIsNoData)
{
  nsAutoString buffer;
  EXPECT_EQ(StealthCrashedContextData(static_cast<dom::BrowsingContext*>(nullptr), buffer), nullptr);
  EXPECT_TRUE(buffer.IsEmpty());
}

TEST(StealthFrameCrash, TheIdIsTheDigits)
{
  nsAutoString buffer;
  // an id of the kind the engine makes: the process in the high word, the counter in the low one
  const char16_t* data = StealthCrashedContextData(uint64_t(15032385537), buffer);
  ASSERT_NE(data, nullptr);
  EXPECT_TRUE(nsDependentString(data).EqualsLiteral("15032385537"));
  // the buffer holds the digits for as long as the notification runs, and a second id does not append to the first
  data = StealthCrashedContextData(uint64_t(9), buffer);
  EXPECT_TRUE(nsDependentString(data).EqualsLiteral("9"));
  // char16ptr_t has no unambiguous == with const char16_t* on Windows (clang-cl): compare the plain pointers
  EXPECT_EQ(data, static_cast<const char16_t*>(buffer.get()));
}

// The scope that nsITextInputProcessor opens around keydown(), keyup() and commitCompositionWith() ([B299]): the latency
// declared with setNextKeyLatency() is taken once, and the key events stamped inside the scope are born in the past.
TEST(StealthKeyBirthScope, NothingDeclaredStampsNothing)
{
  StealthKeyBirth declared;
  StealthKeyBirthScope scope(declared);
  WidgetKeyboardEvent event(true, eKeyDown, nullptr);
  const TimeStamp before = event.mTimeStamp;
  StealthKeyBirthScope::Stamp(event);
  EXPECT_TRUE(event.mTimeStamp == before);
}

TEST(StealthKeyBirthScope, OutsideAScopeStampsNothing)
{
  WidgetKeyboardEvent event(true, eKeyDown, nullptr);
  const TimeStamp before = event.mTimeStamp;
  StealthKeyBirthScope::Stamp(event);
  EXPECT_TRUE(event.mTimeStamp == before);
}

TEST(StealthKeyBirthScope, ADeclaredLatencyIsTakenOnceAndStampsTheEventsInside)
{
  StealthKeyBirth declared{60, 0};
  WidgetKeyboardEvent down(true, eKeyDown, nullptr);
  WidgetKeyboardEvent up(true, eKeyUp, nullptr);
  const TimeStamp now = down.mTimeStamp;
  {
    StealthKeyBirthScope scope(declared);
    EXPECT_EQ(declared.mLatencyMs, 0.0);  // used once: the next key declares its own
    StealthKeyBirthScope::Stamp(down);
    StealthKeyBirthScope::Stamp(up);
  }
  EXPECT_TRUE(down.mTimeStamp < now);
  EXPECT_TRUE(down.mTimeStamp >= now - TimeDuration::FromMilliseconds(61));
  // both events of the call carry the one birth
  EXPECT_TRUE(up.mTimeStamp == down.mTimeStamp);

  // the scope is closed: nothing is stamped any more, and a second scope with nothing declared stamps nothing
  WidgetKeyboardEvent after(true, eKeyDown, nullptr);
  const TimeStamp stamp = after.mTimeStamp;
  {
    StealthKeyBirthScope scope(declared);
    StealthKeyBirthScope::Stamp(after);
  }
  EXPECT_TRUE(after.mTimeStamp == stamp);
}

TEST(StealthKeyBirthScope, AScopeThatEndsRestoresTheOneAround)
{
  StealthKeyBirth outer{80, 0}, inner;
  StealthKeyBirthScope scope(outer);
  WidgetKeyboardEvent first(true, eKeyDown, nullptr);
  StealthKeyBirthScope::Stamp(first);
  {
    StealthKeyBirthScope nested(inner);  // nothing declared inside: no birth inside
    WidgetKeyboardEvent plain(true, eKeyDown, nullptr);
    const TimeStamp stamp = plain.mTimeStamp;
    StealthKeyBirthScope::Stamp(plain);
    EXPECT_TRUE(plain.mTimeStamp == stamp);
  }
  WidgetKeyboardEvent second(true, eKeyDown, nullptr);
  StealthKeyBirthScope::Stamp(second);
  EXPECT_TRUE(second.mTimeStamp == first.mTimeStamp);
}

// The cap on a key's latency is gone ([B299]): a client that sends a key at its planned instant and reaches the engine
// seconds late declares those seconds, and the key is born that far back.
TEST(StealthKeyBirthScope, ALatencyOfSecondsIsHonouredWithNoCap)
{
  const TimeStamp before = TimeStamp::Now();
  StealthKeyBirth declared{1728, 201};
  WidgetKeyboardEvent event(true, eKeyDown, nullptr);
  {
    StealthKeyBirthScope scope(declared);
    StealthKeyBirthScope::Stamp(event);
  }
  EXPECT_TRUE(event.mTimeStamp <= TimeStamp::Now() - TimeDuration::FromMilliseconds(1728));
  EXPECT_TRUE(event.mTimeStamp >= before - TimeDuration::FromMilliseconds(1728));

  // what used to be past the cap (an hour) is a birth too, never null and never in the future
  const TimeStamp long_ago = StealthInputEventBirthOrNull(7200000, 202);
  ASSERT_FALSE(long_ago.IsNull());
  EXPECT_TRUE(long_ago <= TimeStamp::Now());
}

// One page is one stream: a birth of a page does not move the births of another page of the same process.
TEST(StealthBirthOrder, TwoPagesAreTwoIndependentStreams)
{
  const TimeStamp first = StealthInputEventBirth(10, 301);
  // another page, a latency of two seconds: on the old process-wide order it was held back to `first`
  const TimeStamp other = StealthInputEventBirth(2000, 302);
  EXPECT_TRUE(other < first);
  EXPECT_TRUE(other <= TimeStamp::Now() - TimeDuration::FromMilliseconds(1999));
  // the first page is not moved by the second, and the second keeps its own order
  const TimeStamp again = StealthInputEventBirth(3000, 301);
  EXPECT_TRUE(again == first);
  const TimeStamp otherAgain = StealthInputEventBirth(1990, 302);
  EXPECT_TRUE(otherAgain >= other);
  EXPECT_TRUE(otherAgain < first);
}

// Keys, mouse and wheel of one page are one stream: in whatever order they come and with whatever latencies, the
// births of the page never go back.
TEST(StealthBirthOrder, KeysMouseAndWheelOfOnePageNeverGoBack)
{
  TimeStamp last;
  for (double latency : {40.0, 900.0, 5.0, 1700.0, 3.0, 250.0, 60.0, 2500.0}) {
    TimeStamp born;
    if (static_cast<int>(latency) % 3 == 0) {
      WidgetEventTime mouse;
      StealthSetInputEventBirth(mouse, latency, 311);
      born = mouse.mTimeStamp;
    } else {
      StealthKeyBirth declared{latency, 311};
      WidgetKeyboardEvent key(true, eKeyDown, nullptr);
      {
        StealthKeyBirthScope scope(declared);
        StealthKeyBirthScope::Stamp(key);
      }
      born = key.mTimeStamp;
    }
    if (!last.IsNull()) {
      EXPECT_TRUE(born >= last);
    }
    last = born;
  }
}

// A key of one page does not hold back the mouse of another page (on the old order a key shared the birth of the
// mouse of every page of the process).
TEST(StealthBirthOrder, AKeyOfOnePageDoesNotMoveTheMouseOfAnother)
{
  StealthKeyBirth declared{5, 321};
  WidgetKeyboardEvent key(true, eKeyDown, nullptr);
  {
    StealthKeyBirthScope scope(declared);
    StealthKeyBirthScope::Stamp(key);
  }
  WidgetEventTime mouse;
  StealthSetInputEventBirth(mouse, 2500, 322);
  EXPECT_TRUE(mouse.mTimeStamp < key.mTimeStamp);
  EXPECT_TRUE(mouse.mTimeStamp <= TimeStamp::Now() - TimeDuration::FromMilliseconds(2499));
}

// The memory is bounded by a few slots: many pages that came and went leave a birth in the past for each, and the one
// that is used again keeps its order.
TEST(StealthBirthOrder, ManyPagesStayBoundedAndInThePast)
{
  for (uint64_t page = 400; page < 600; ++page) {
    const TimeStamp born = StealthInputEventBirth(15, page);
    EXPECT_TRUE(born <= TimeStamp::Now());
  }
  const TimeStamp a = StealthInputEventBirth(8, 700);
  const TimeStamp b = StealthInputEventBirth(900, 700);
  EXPECT_TRUE(b == a);
}

// A latency declared with setNextKeyLatency() and never followed by a key (the caller threw) is taken back by
// setNextKeyLatency(0) of its finally: the next key is not born in the past. The processor itself is not driven
// here (it needs a window and a widget), so this is the field and the scope it feeds.
TEST(StealthKeyBirthScope, ALatencyWithNoKeyThenZeroGivesNoBirthToTheNextKey)
{
  StealthKeyBirth field;
  ASSERT_EQ(StealthSetNextKeyLatency(field, 60, 0, true), NS_OK);
  EXPECT_EQ(field.mLatencyMs, 60.0);
  // no key call follows; the caller takes the latency back
  ASSERT_EQ(StealthSetNextKeyLatency(field, 0, 0, true), NS_OK);
  EXPECT_EQ(field.mLatencyMs, 0.0);

  WidgetKeyboardEvent event(true, eKeyDown, nullptr);
  const TimeStamp before = event.mTimeStamp;
  {
    StealthKeyBirthScope scope(field);  // what keydown() opens
    StealthKeyBirthScope::Stamp(event);
  }
  EXPECT_TRUE(event.mTimeStamp == before);
}

TEST(StealthKeyBirthScope, TheScopeTakesTheLatencyEvenWhenTheCallEndsEarly)
{
  // the scope zeroes the field when it opens, before anything of the call can fail
  StealthKeyBirth field{45, 9};
  { StealthKeyBirthScope scope(field); }
  EXPECT_EQ(field.mLatencyMs, 0.0);
  EXPECT_EQ(field.mPageId, 0u);
}

// The key path with two pages: what setNextKeyLatency() declares (the latency and the page Juggler names) is one
// stream per page, as the mouse and the wheel are.
TEST(StealthKeyBirthScope, TwoPagesAreTwoStreamsThroughTheKeyPath)
{
  WidgetKeyboardEvent first(true, eKeyDown, nullptr), other(true, eKeyDown, nullptr), again(true, eKeyDown, nullptr);
  StealthKeyBirth a{10, 331};
  {
    StealthKeyBirthScope scope(a);
    StealthKeyBirthScope::Stamp(first);
  }
  EXPECT_EQ(a.mPageId, 0u);  // taken once, the page with it
  StealthKeyBirth b{2000, 332};
  {
    StealthKeyBirthScope scope(b);
    StealthKeyBirthScope::Stamp(other);
  }
  // on one stream the 2 s birth would have been held back to the 10 ms one
  EXPECT_TRUE(other.mTimeStamp < first.mTimeStamp);
  EXPECT_TRUE(other.mTimeStamp <= TimeStamp::Now() - TimeDuration::FromMilliseconds(1999));
  // and within a page the births never go back
  StealthKeyBirth c{3000, 331};
  {
    StealthKeyBirthScope scope(c);
    StealthKeyBirthScope::Stamp(again);
  }
  EXPECT_TRUE(again.mTimeStamp == first.mTimeStamp);
}

// The page of a mouse or a wheel event is found from the document or the PresShell the hook has at hand: its browsing
// context, none known is the stream of no page.
namespace {
struct FakeDocument {
  dom::BrowsingContext* GetBrowsingContext() { return nullptr; }
};
struct FakePresShell {
  FakeDocument* GetDocument() { return mDocument; }
  FakeDocument* mDocument = nullptr;
};
}  // namespace

TEST(StealthInputEventBirth, ThePageIsFoundFromTheDocumentOrThePresShellAtHand)
{
  FakeDocument document;
  FakePresShell shell;
  shell.mDocument = &document;
  EXPECT_EQ(StealthPageOfSource(&document, 0), 0u);
  EXPECT_EQ(StealthPageOfSource(&shell, 0), 0u);
  FakePresShell none;
  EXPECT_EQ(StealthPageOfSource(&none, 0), 0u);
  // the overloads of the hooks run, and the births of the stream of no page do not go back
  WidgetEventTime fromDocument, fromShell;
  StealthSetInputEventBirth(fromDocument, 5, &document);
  StealthSetInputEventBirth(fromShell, 4000, &shell);
  EXPECT_TRUE(fromShell.mTimeStamp >= fromDocument.mTimeStamp);
}
