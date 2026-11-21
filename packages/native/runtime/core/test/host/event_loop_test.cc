// LOOP-1..3, TMR-5 at the scheduler level: task order, timers vs tasks, cross-thread posts wake the loop, budget
// carry-over, the 60 Hz window rAF fallback, frame pumps.
#include <atomic>
#include <functional>
#include <memory>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include "iwn/core/clock.h"
#include "iwn/core/event_loop.h"
#include "iwn_test.h"

using iwn::EventLoop;

namespace {
struct Recorder {
  std::vector<std::string> log;
};
}  // namespace

IWN_TEST(EventLoop, RunsPostedTasksInOrder) {
  EventLoop loop;
  Recorder r;
  loop.post([&] { r.log.push_back("a"); });
  loop.post([&] { r.log.push_back("b"); });
  loop.run_once(0);
  IWN_CHECK_EQ(r.log.size(), size_t(2));
  IWN_CHECK_EQ(r.log[0], std::string("a"));
  IWN_CHECK_EQ(r.log[1], std::string("b"));
}

IWN_TEST(EventLoop, TasksPostedDuringIterationRunNextIteration) {
  EventLoop loop;
  Recorder r;
  loop.post([&] {
    r.log.push_back("first");
    loop.post([&] { r.log.push_back("second"); });
  });
  loop.run_once(0);
  IWN_CHECK_EQ(r.log.size(), size_t(1));
  loop.run_once(0);
  IWN_CHECK_EQ(r.log.size(), size_t(2));
}

IWN_TEST(EventLoop, HookWrapsEveryTask) {
  EventLoop loop;
  int wrapped = 0;
  EventLoop::Hooks h;
  h.run_task = [&](EventLoop::Task& t) {
    ++wrapped;
    t();
  };
  loop.set_hooks(h);
  loop.post([] {});
  loop.post_high([] {});
  loop.run_once(0);
  IWN_CHECK_EQ(wrapped, 2);
}

IWN_TEST(EventLoop, TimersFireViaHookAfterDelay) {
  EventLoop loop;
  std::vector<int> fired;
  EventLoop::Hooks h;
  h.fire_timer = [&](const iwn::TimerQueue::Fired& f) {
    loop.timers().begin_callback(f);
    fired.push_back(f.id);
    loop.timers().end_callback(iwn::now_ms());
  };
  loop.set_hooks(h);
  int id = loop.timers().add(20, false, iwn::now_ms());
  auto start = std::chrono::steady_clock::now();
  while (fired.empty() && std::chrono::steady_clock::now() - start < std::chrono::seconds(2)) loop.run_once(100);
  IWN_CHECK_EQ(fired.size(), size_t(1));
  IWN_CHECK_EQ(fired[0], id);
  auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
  IWN_CHECK(elapsed >= 19.0);
}

IWN_TEST(EventLoop, CrossThreadPostWakesSleepingLoop) {
  EventLoop loop;
  std::atomic<bool> ran{false};
  std::thread t([&] {
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    loop.post([&] { ran = true; });
  });
  auto start = std::chrono::steady_clock::now();
  loop.run_once(5000);  // sleeps until the post arrives
  loop.run_once(0);
  t.join();
  auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
  IWN_CHECK(ran.load());
  IWN_CHECK(elapsed < 1000);
}

IWN_TEST(EventLoop, BudgetCarriesOverLeftoverTasks) {
  EventLoop loop;
  loop.set_task_budget_ms(1, 1);
  int count = 0;
  for (int i = 0; i < 10; ++i) {
    loop.post([&] {
      ++count;
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    });
  }
  loop.run_once(0);
  IWN_CHECK(count < 10);
  IWN_CHECK(loop.stats().budget_carryovers >= 1);
  for (int i = 0; i < 20 && count < 10; ++i) loop.run_once(0);
  IWN_CHECK_EQ(count, 10);
}

IWN_TEST(EventLoop, DelayedTasks) {
  EventLoop loop;
  bool ran = false;
  loop.post_delayed([&] { ran = true; }, 15);
  loop.run_once(0);
  IWN_CHECK(!ran);
  auto start = std::chrono::steady_clock::now();
  while (!ran && std::chrono::steady_clock::now() - start < std::chrono::seconds(2)) loop.run_once(100);
  IWN_CHECK(ran);
}

IWN_TEST(EventLoop, WindowFrameFallbackAt60Hz) {
  EventLoop loop;
  std::vector<double> frames;
  EventLoop::Hooks h;
  h.run_animation_frame = [&](double now) {
    frames.push_back(now);
    if (frames.size() < 6) loop.request_animation_frame();
  };
  loop.set_hooks(h);
  loop.request_animation_frame();
  auto start = std::chrono::steady_clock::now();
  while (frames.size() < 6 && std::chrono::steady_clock::now() - start < std::chrono::seconds(3)) loop.run_once(100);
  IWN_CHECK_EQ(frames.size(), size_t(6));
  for (size_t i = 1; i < frames.size(); ++i) IWN_CHECK(frames[i] - frames[i - 1] >= 16.0);
  // No frame without a request (no busy loop).
  loop.run_once(50);
  IWN_CHECK_EQ(frames.size(), size_t(6));
}

namespace {
class TestPump : public iwn::FramePump {
 public:
  bool on = true;
  int frames = 0;
  bool active() override { return on; }
  void run_frame(const std::function<void(double)>& window_frame) override {
    ++frames;
    window_frame(iwn::now_ms());
    if (frames >= 3) on = false;
  }
};
}  // namespace

IWN_TEST(EventLoop, FramePumpDrivesWindowFrames) {
  EventLoop loop;
  TestPump pump;
  loop.set_frame_pump(&pump);
  int raf = 0;
  EventLoop::Hooks h;
  h.run_animation_frame = [&](double) {
    ++raf;
    loop.request_animation_frame();
  };
  loop.set_hooks(h);
  loop.request_animation_frame();
  for (int i = 0; i < 3; ++i) loop.run_once(0);
  IWN_CHECK_EQ(pump.frames, 3);
  IWN_CHECK_EQ(raf, 3);
}

IWN_TEST(EventLoop, QuitStopsRun) {
  EventLoop loop;
  std::thread t([&] {
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    loop.request_quit();
  });
  loop.run();
  t.join();
  IWN_CHECK(loop.quit_requested());
}

IWN_TEST(EventLoop, ResetForReloadDropsTimersAndFrameButKeepsTasks) {
  // Regression: the reset threw away DevTools drains, V8 delayed platform tasks, eval timeouts and host inputs.
  EventLoop loop;
  bool ran = false, delayed_ran = false;
  int frames = 0;
  EventLoop::Hooks h;
  h.run_animation_frame = [&](double) { ++frames; };
  loop.set_hooks(h);
  loop.post([&] { ran = true; });
  loop.post_delayed([&] { delayed_ran = true; }, 1);
  loop.timers().add(0, false, 0);
  loop.request_animation_frame();
  loop.reset_for_reload();
  IWN_CHECK(!loop.animation_frame_requested());
  IWN_CHECK_EQ(loop.pending_timers(), size_t(0));
  std::this_thread::sleep_for(std::chrono::milliseconds(3));
  loop.run_once(0);
  IWN_CHECK(ran);
  IWN_CHECK(delayed_ran);
  IWN_CHECK_EQ(frames, 0);
}

IWN_TEST(EventLoop, ExpensiveTimersDoNotStarvePostedTasks) {
  // Starvation probe: a repeating 0 ms timer that takes longer than the budget plus a self-re-requesting
  // rAF. Posted tasks must still run (LOOP-2, DBG-7).
  EventLoop loop;
  loop.set_task_budget_ms(8, 8);
  int timer_fires = 0, tasks = 0;
  EventLoop::Hooks h;
  h.fire_timer = [&](const iwn::TimerQueue::Fired& f) {
    loop.timers().begin_callback(f);
    ++timer_fires;
    std::this_thread::sleep_for(std::chrono::milliseconds(12));
    loop.timers().end_callback(iwn::now_ms());
  };
  h.run_animation_frame = [&](double) { loop.request_animation_frame(); };
  loop.set_hooks(h);
  loop.timers().add(0, true, iwn::now_ms());
  loop.request_animation_frame();
  for (int i = 0; i < 20; ++i) loop.post([&] { ++tasks; });
  for (int i = 0; i < 25 && tasks < 20; ++i) loop.run_once(0);
  IWN_CHECK_EQ(tasks, 20);
  IWN_CHECK(timer_fires >= 2);  // and timers keep making progress too
}

IWN_TEST(EventLoop, ManyTasksDoNotStarveTimers) {
  EventLoop loop;
  loop.set_task_budget_ms(2, 2);
  int timer_fires = 0;
  EventLoop::Hooks h;
  h.fire_timer = [&](const iwn::TimerQueue::Fired& f) {
    loop.timers().begin_callback(f);
    ++timer_fires;
    loop.timers().end_callback(iwn::now_ms());
  };
  loop.set_hooks(h);
  // Each task re-posts itself and takes 3 ms: the task phase is always over budget.
  std::function<void()> task = [&] {
    std::this_thread::sleep_for(std::chrono::milliseconds(3));
    loop.post(task);
  };
  for (int i = 0; i < 5; ++i) loop.post(task);
  loop.timers().add(0, false, iwn::now_ms());
  for (int i = 0; i < 4 && timer_fires == 0; ++i) loop.run_once(0);
  IWN_CHECK_EQ(timer_fires, 1);
}

IWN_TEST(EventLoop, HiddenPageSuspendsWindowFrames) {
  EventLoop loop;
  int frames = 0;
  EventLoop::Hooks h;
  h.run_animation_frame = [&](double) { ++frames; };
  loop.set_hooks(h);
  loop.set_window_frames_suspended(true);
  loop.request_animation_frame();
  auto start = std::chrono::steady_clock::now();
  while (std::chrono::steady_clock::now() - start < std::chrono::milliseconds(60)) loop.run_once(20);
  IWN_CHECK_EQ(frames, 0);
  IWN_CHECK(loop.animation_frame_requested());
  loop.set_window_frames_suspended(false);
  loop.run_once(0);
  IWN_CHECK_EQ(frames, 1);
}

// PROC-7 teardown: close() destroys queued work on the closing thread and refuses later posts, so a completion
// posted after the page closed cannot stay queued (and keep its memory) forever.
IWN_TEST(EventLoop, CloseDropsQueuedWorkAndRefusesLaterPosts) {
  EventLoop loop;
  auto payload = std::make_shared<std::vector<char>>(1 << 20);
  std::weak_ptr<std::vector<char>> weak = payload;
  bool ran = false;
  loop.post([payload, &ran] { ran = true; });
  loop.post_high([payload] {});
  loop.post_delayed([payload] {}, 10000);
  loop.timers().add(10000, false, iwn::now_ms());
  payload.reset();
  IWN_CHECK(!weak.expired());
  loop.close();
  IWN_CHECK(weak.expired());
  IWN_CHECK(loop.closed());
  IWN_CHECK_EQ(loop.pending_tasks(), size_t(0));
  IWN_CHECK_EQ(loop.pending_timers(), size_t(0));

  auto late = std::make_shared<int>(1);
  std::weak_ptr<int> late_weak = late;
  std::thread([&loop, late]() mutable { loop.post([late] {}); }).join();
  late.reset();
  IWN_CHECK(late_weak.expired());  // refused and destroyed by the poster, not queued

  auto kept = std::make_shared<int>(2);
  EventLoop::Task t = [kept] {};
  IWN_CHECK(!loop.try_post(t));
  IWN_CHECK(static_cast<bool>(t));  // try_post leaves a refused task with the caller
  loop.run_once(0);
  IWN_CHECK(!ran);
}
