/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The main JS thread's event loop (LOOP-1..3, TMR-5) without V8. Thread-safe task posting, native delayed tasks,
// HTML timers, a window animation-frame driver and a hook point for the XR frame loop (FramePump).
//
// One iteration:
//   1. run every high-priority task queued so far (V8 platform foreground tasks: GC steps, compile finalisation);
//   2. run due timers and the normal tasks that were queued when the iteration started, within a shared time budget;
//      each of the two phases runs at least one item per iteration and a phase cut short goes first next time, so
//      neither can starve the other (leftovers carry over to the next iteration, LOOP-2);
//   3. if a FramePump is installed and active, let it run one frame (it blocks in xrWaitFrame and runs the XR
//      and window rAF callbacks); otherwise run a window animation frame when one is requested and due (60 Hz);
//   4. sleep until the next timer, delayed task, animation frame or post (never busy-waits, LOOP-3).
// The V8 layer supplies Hooks that wrap each callback in scopes, a TryCatch and a microtask checkpoint.
#pragma once

#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <queue>
#include <vector>

#include "iwn/core/monotonic_cv.h"
#include "iwn/core/timer_queue.h"

namespace iwn {

// Installed by the XR module (M3). While active() is true the loop calls run_frame() once per iteration instead of
// sleeping; run_frame blocks in xrWaitFrame, then runs the frame's callbacks (and window rAF, through the hook the
// loop passes in) between xrBeginFrame and xrEndFrame.
class FramePump {
 public:
  virtual ~FramePump() = default;
  virtual bool active() = 0;
  // `run_window_frame(now_ms)` runs one round of window requestAnimationFrame callbacks; call it after the session's
  // own callbacks (TMR-5, XR-LOOP-1). It is a no-op when no window rAF is pending.
  virtual void run_frame(const std::function<void(double now_ms)>& run_window_frame) = 0;
};

class EventLoop {
 public:
  using Task = std::function<void()>;

  struct Hooks {
    // Runs a posted task (scopes, TryCatch, microtask checkpoint). Default: call it.
    std::function<void(Task&)> run_task;
    // Runs a fired JS timer (the JS side looks up the callback by id).
    std::function<void(const TimerQueue::Fired&)> fire_timer;
    // Runs one round of window rAF callbacks with the frame's timestamp.
    std::function<void(double now_ms)> run_animation_frame;
    // Called at the end of every iteration (stats, idle work).
    std::function<void()> after_iteration;
  };

  struct Stats {
    uint64_t iterations = 0;
    uint64_t tasks_run = 0;
    uint64_t high_tasks_run = 0;
    uint64_t timers_fired = 0;
    uint64_t animation_frames = 0;
    uint64_t budget_carryovers = 0;
  };

  EventLoop();
  ~EventLoop();

  // --- any thread ---
  // After close() these drop the task (destroyed on the posting thread, so only for closures without v8 handles).
  void post(Task task);
  void post_high(Task task);
  void post_delayed(Task task, double delay_ms);
  // Like post(), but after close() returns false and leaves `task` with the caller (for closures that must not be
  // destroyed off the JS thread, e.g. ones holding v8::Global handles).
  bool try_post(Task& task);
  bool closed() const;
  void wake();
  void request_quit();
  bool quit_requested() const { return quit_.load(std::memory_order_acquire); }

  // --- JS thread only ---
  void set_hooks(Hooks hooks) { hooks_ = std::move(hooks); }
  TimerQueue& timers() { return timers_; }
  void set_frame_pump(FramePump* pump) { pump_ = pump; }
  FramePump* frame_pump() const { return pump_; }
  void request_animation_frame() { frame_requested_ = true; }
  bool animation_frame_requested() const { return frame_requested_; }
  // Per-iteration budget for normal tasks + timers (ms). Default 8 ms with a frame pump, 50 ms without.
  void set_task_budget_ms(double with_pump, double without_pump);
  // Window rAF period when no frame pump drives frames (TMR-5: 60 Hz). 0 disables the fallback.
  void set_fallback_frame_interval_ms(double ms) { fallback_frame_ms_ = ms; }
  // While the page is hidden (PROC-6) the 60 Hz window-rAF fallback stops, as in browsers; the request stays
  // pending and the next frame runs after unsuspending. Timers keep running at their normal rate.
  void set_window_frames_suspended(bool suspended) { frames_suspended_ = suspended; }
  bool window_frames_suspended() const { return frames_suspended_; }

  // Runs until request_quit().
  void run();
  // One iteration; waits at most max_wait_ms when idle (0 = do not wait). Returns true if any work ran.
  bool run_once(double max_wait_ms);
  // Runs one window animation frame now (used by frame pumps and by the fallback driver).
  void run_window_frame(double now_ms);
  // Reload: drops the page's timers and its pending animation-frame request. Posted, high-priority and delayed tasks
  // are kept (platform, DevTools, host work); page-owned completions are generation-tagged by Runtime::post_task.
  void reset_for_reload();
  // Teardown, before the isolate is disposed: refuses later posts and destroys every queued task, delayed task and
  // timer here on the JS thread, so nothing queued (file bytes, handles) outlives the page (PROC-7).
  void close();

  size_t pending_tasks() const;
  size_t pending_timers() const { return timers_.size(); }
  const Stats& stats() const { return stats_; }

 private:
  struct Delayed {
    double due;
    uint64_t seq;
    Task task;
    bool operator>(const Delayed& o) const { return due != o.due ? due > o.due : seq > o.seq; }
  };
  void invoke(Task& task);
  double next_wake_ms(double now) const;

  mutable std::mutex mu_;
  MonotonicCondVar cv_;  // CLOCK_MONOTONIC timed waits (see monotonic_cv.h)
  std::deque<Task> normal_;
  std::deque<Task> high_;
  std::priority_queue<Delayed, std::vector<Delayed>, std::greater<Delayed>> delayed_;
  uint64_t delayed_seq_ = 0;
  bool woken_ = false;
  std::atomic<bool> quit_{false};
  bool closed_ = false;  // guarded by mu_

  Hooks hooks_;
  TimerQueue timers_;
  FramePump* pump_ = nullptr;
  bool frame_requested_ = false;
  bool tasks_first_ = false;  // the task phase was cut short last iteration: run it before timers
  bool frames_suspended_ = false;
  double last_frame_ms_ = -1e9;
  double fallback_frame_ms_ = 1000.0 / 60.0;
  double budget_with_pump_ms_ = 8.0;
  double budget_without_pump_ms_ = 50.0;
  Stats stats_;
};

}  // namespace iwn
