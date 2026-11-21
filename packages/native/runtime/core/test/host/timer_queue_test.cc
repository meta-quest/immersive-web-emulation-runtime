/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// TMR-1, TMR-2: ids, ordering, nesting clamp, interval re-arming, clearing inside a callback.
#include "iwn/core/timer_queue.h"
#include "iwn_test.h"

using iwn::TimerQueue;

IWN_TEST(TimerQueue, IdsArePositiveAndUnique) {
  TimerQueue q;
  int a = q.add(10, false, 0);
  int b = q.add(10, true, 0);
  IWN_CHECK(a > 0);
  IWN_CHECK(b > 0);
  IWN_CHECK(a != b);
  IWN_CHECK(q.contains(a) && q.contains(b));
}

IWN_TEST(TimerQueue, EqualDelaysFireInCreationOrder) {
  TimerQueue q;
  int a = q.add(5, false, 100);
  int b = q.add(5, false, 100);
  int c = q.add(5, false, 100);
  IWN_CHECK(!q.pop_due(104.9).has_value());  // never early
  IWN_CHECK_EQ(q.pop_due(105)->id, a);
  IWN_CHECK_EQ(q.pop_due(105)->id, b);
  IWN_CHECK_EQ(q.pop_due(105)->id, c);
  IWN_CHECK(!q.pop_due(1e9).has_value());
}

IWN_TEST(TimerQueue, ShorterDelayFiresFirst) {
  TimerQueue q;
  int slow = q.add(20, false, 0);
  int fast = q.add(1, false, 0);
  IWN_CHECK_EQ(q.pop_due(30)->id, fast);
  IWN_CHECK_EQ(q.pop_due(30)->id, slow);
}

IWN_TEST(TimerQueue, NegativeAndNaNTimeoutsAreZero) {
  TimerQueue q;
  q.add(-50, false, 10);
  q.add(0.0 / 0.0, false, 10);
  IWN_CHECK_EQ(*q.next_due(), 10.0);
}

IWN_TEST(TimerQueue, ClearUnknownIsNoop) {
  TimerQueue q;
  IWN_CHECK(!q.clear(12345));
  int a = q.add(1, false, 0);
  IWN_CHECK(q.clear(a));
  IWN_CHECK(!q.contains(a));
  IWN_CHECK(!q.pop_due(100).has_value());
}

IWN_TEST(TimerQueue, NestingClampAfterLevelFive) {
  // A chain of setTimeout(f, 0) where each callback schedules the next: levels 1..5 unclamped, then 4 ms.
  TimerQueue q;
  double now = 0;
  q.add(0, false, now);
  std::vector<double> gaps;
  for (int i = 0; i < 8; ++i) {
    double due = *q.next_due();
    gaps.push_back(due - now);
    now = due;
    auto f = q.pop_due(now);
    IWN_CHECK(f.has_value());
    q.begin_callback(*f);
    q.add(0, false, now);
    q.end_callback(now);
  }
  // gaps[i] is the delay of the timer created at nesting level i (0 = top level).
  for (int i = 0; i <= 5; ++i) IWN_CHECK_EQ(gaps[i], 0.0);
  IWN_CHECK_EQ(gaps[6], 4.0);
  IWN_CHECK_EQ(gaps[7], 4.0);
}

IWN_TEST(TimerQueue, IntervalRearmsAndClampsWhenNested) {
  TimerQueue q;
  int id = q.add(0, true, 0);
  double now = 0;
  std::vector<double> dues;
  for (int i = 0; i < 8; ++i) {
    now = *q.next_due();
    dues.push_back(now);
    auto f = q.pop_due(now);
    IWN_CHECK_EQ(f->id, id);
    q.begin_callback(*f);
    q.end_callback(now);
  }
  // setInterval(f, 0): the first 6 runs come back immediately, then clamped to 4 ms.
  IWN_CHECK_EQ(dues[5], 0.0);
  IWN_CHECK_EQ(dues[6], 4.0);
  IWN_CHECK_EQ(dues[7], 8.0);
}

IWN_TEST(TimerQueue, ClearInsideOwnCallbackStopsInterval) {
  TimerQueue q;
  int id = q.add(10, true, 0);
  auto f = q.pop_due(10);
  q.begin_callback(*f);
  IWN_CHECK(q.clear(id));
  q.end_callback(10);
  IWN_CHECK(!q.contains(id));
  IWN_CHECK(!q.next_due().has_value());
}

IWN_TEST(TimerQueue, ClearAnotherInsideCallback) {
  TimerQueue q;
  int a = q.add(1, false, 0);
  int b = q.add(1, false, 0);
  auto f = q.pop_due(5);
  IWN_CHECK_EQ(f->id, a);
  q.begin_callback(*f);
  q.clear(b);
  q.end_callback(5);
  IWN_CHECK(!q.pop_due(5).has_value());
}

IWN_TEST(TimerQueue, ResetDropsEverythingButKeepsIdsIncreasing) {
  TimerQueue q;
  int a = q.add(1, false, 0);
  q.reset();
  IWN_CHECK_EQ(q.size(), size_t(0));
  int b = q.add(1, false, 0);
  IWN_CHECK(b > a);
}
