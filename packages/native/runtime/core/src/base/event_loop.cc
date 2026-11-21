#include "iwn/core/event_loop.h"

#include <algorithm>
#include <chrono>
#include <cmath>

#include "iwn/core/clock.h"

namespace iwn {

EventLoop::EventLoop() = default;
EventLoop::~EventLoop() = default;

void EventLoop::post(Task task) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (closed_) return;
    normal_.push_back(std::move(task));
    woken_ = true;
  }
  cv_.notify_one();
}

void EventLoop::post_high(Task task) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (closed_) return;
    high_.push_back(std::move(task));
    woken_ = true;
  }
  cv_.notify_one();
}

void EventLoop::post_delayed(Task task, double delay_ms) {
  if (!(delay_ms > 0)) delay_ms = 0;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (closed_) return;
    delayed_.push(Delayed{now_ms() + delay_ms, delayed_seq_++, std::move(task)});
    woken_ = true;
  }
  cv_.notify_one();
}

bool EventLoop::try_post(Task& task) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (closed_) return false;
    normal_.push_back(std::move(task));
    woken_ = true;
  }
  cv_.notify_one();
  return true;
}

bool EventLoop::closed() const {
  std::lock_guard<std::mutex> lock(mu_);
  return closed_;
}

void EventLoop::close() {
  std::deque<Task> normal, high;
  std::priority_queue<Delayed, std::vector<Delayed>, std::greater<Delayed>> delayed;
  {
    std::lock_guard<std::mutex> lock(mu_);
    closed_ = true;
    normal.swap(normal_);
    high.swap(high_);
    delayed.swap(delayed_);
    timers_.reset();
    frame_requested_ = false;
  }
  // Destroyed here, outside the lock (a destructor may post, which is now refused).
}

void EventLoop::wake() {
  {
    std::lock_guard<std::mutex> lock(mu_);
    woken_ = true;
  }
  cv_.notify_one();
}

void EventLoop::request_quit() {
  quit_.store(true, std::memory_order_release);
  wake();
}

void EventLoop::set_task_budget_ms(double with_pump, double without_pump) {
  budget_with_pump_ms_ = with_pump;
  budget_without_pump_ms_ = without_pump;
}

size_t EventLoop::pending_tasks() const {
  std::lock_guard<std::mutex> lock(mu_);
  return normal_.size() + high_.size() + delayed_.size();
}

void EventLoop::invoke(Task& task) {
  if (hooks_.run_task) {
    hooks_.run_task(task);
  } else if (task) {
    task();
  }
}

void EventLoop::run_window_frame(double now) {
  if (!frame_requested_) return;
  frame_requested_ = false;  // callbacks requested during this round set it again (TMR-5 snapshot)
  last_frame_ms_ = now;
  stats_.animation_frames++;
  if (hooks_.run_animation_frame) hooks_.run_animation_frame(now);
}

double EventLoop::next_wake_ms(double now) const {
  double wake = INFINITY;
  if (auto due = timers_.next_due()) wake = std::min(wake, *due);
  if (!delayed_.empty()) wake = std::min(wake, delayed_.top().due);
  if (frame_requested_ && fallback_frame_ms_ > 0 && !frames_suspended_ && !(pump_ && pump_->active())) {
    wake = std::min(wake, std::max(now, last_frame_ms_ + fallback_frame_ms_));
  }
  return wake;
}

bool EventLoop::run_once(double max_wait_ms) {
  stats_.iterations++;
  bool did_work = false;

  // 1. High-priority (V8 platform) tasks queued so far, plus delayed tasks that are due.
  {
    std::deque<Task> high;
    std::vector<Task> due_delayed;
    {
      std::lock_guard<std::mutex> lock(mu_);
      high.swap(high_);
      double now = now_ms();
      while (!delayed_.empty() && delayed_.top().due <= now) {
        due_delayed.push_back(std::move(const_cast<Delayed&>(delayed_.top()).task));
        delayed_.pop();
      }
      woken_ = false;
    }
    for (auto& t : high) {
      invoke(t);
      stats_.high_tasks_run++;
      did_work = true;
      if (quit_requested()) return true;
    }
    for (auto& t : due_delayed) {
      invoke(t);
      stats_.tasks_run++;
      did_work = true;
      if (quit_requested()) return true;
    }
  }

  // 2. Timers due at the start of the iteration and the normal tasks queued at that point share one budget. Both
  //    make progress in every iteration (LOOP-2: no starvation): each phase runs at least one item even when the
  //    other phase already used the whole budget, and a phase that was cut short goes first in the next iteration.
  const bool pumping = pump_ && pump_->active();
  const double start = now_ms();
  const double budget = pumping ? budget_with_pump_ms_ : budget_without_pump_ms_;
  size_t snapshot;
  {
    std::lock_guard<std::mutex> lock(mu_);
    snapshot = normal_.size();
  }
  bool timers_cut = false, tasks_cut = false, quit = false;
  auto run_timers = [&] {
    for (int n = 0; n < 1000; ++n) {
      if (n > 0 && now_ms() - start > budget) {
        timers_cut = timers_.next_due().has_value() && *timers_.next_due() <= start;
        return;
      }
      auto fired = timers_.pop_due(start);
      if (!fired) return;
      stats_.timers_fired++;
      did_work = true;
      if (hooks_.fire_timer) hooks_.fire_timer(*fired);
      if (quit_requested()) {
        quit = true;
        return;
      }
    }
  };
  auto run_tasks = [&] {
    for (size_t i = 0; i < snapshot; ++i) {
      if (i > 0 && now_ms() - start > budget) {
        tasks_cut = true;
        return;
      }
      Task task;
      {
        std::lock_guard<std::mutex> lock(mu_);
        if (normal_.empty()) return;
        task = std::move(normal_.front());
        normal_.pop_front();
      }
      invoke(task);
      stats_.tasks_run++;
      did_work = true;
      if (quit_requested()) {
        quit = true;
        return;
      }
    }
  };
  if (tasks_first_) {
    run_tasks();
    if (quit) return true;
    run_timers();
  } else {
    run_timers();
    if (quit) return true;
    run_tasks();
  }
  if (quit) return true;
  if (tasks_cut && !timers_cut) {
    tasks_first_ = true;
  } else if (timers_cut && !tasks_cut) {
    tasks_first_ = false;
  } else if (timers_cut && tasks_cut) {
    tasks_first_ = !tasks_first_;
  }
  if (timers_cut || tasks_cut) stats_.budget_carryovers++;

  // 3. Frames.
  if (pump_ && pump_->active()) {
    pump_->run_frame([this](double now) { run_window_frame(now); });
    did_work = true;
  } else if (frame_requested_ && fallback_frame_ms_ > 0 && !frames_suspended_) {
    double now = now_ms();
    if (now >= last_frame_ms_ + fallback_frame_ms_) {
      run_window_frame(now);
      did_work = true;
    }
  }

  if (hooks_.after_iteration) hooks_.after_iteration();
  if (quit_requested()) return did_work;

  // 4. Sleep until the next due item or a post. Never sleep if work is already waiting.
  if (max_wait_ms > 0 && !(pump_ && pump_->active())) {
    std::unique_lock<std::mutex> lock(mu_);
    if (woken_ || !high_.empty() || !normal_.empty()) return did_work;
    double now = now_ms();
    double wake = std::min(next_wake_ms(now), now + max_wait_ms);
    if (wake > now) {
      auto deadline = std::chrono::steady_clock::now() +
                      std::chrono::microseconds(static_cast<int64_t>(std::ceil((wake - now) * 1000.0)));
      cv_.wait_until(lock, deadline, [this] { return woken_ || quit_requested(); });
    }
  }
  return did_work;
}

void EventLoop::run() {
  while (!quit_requested()) {
    run_once(1000.0 * 60);
  }
}

void EventLoop::reset_for_reload() {
  // Only the page's own scheduling state goes. Posted and delayed tasks stay: they belong to V8's platform
  // (MemoryReducer, heartbeats), DevTools and the debug endpoint (drains, eval timeouts), the host (lifecycle
  // inputs, quit) or are page completions that Runtime::post_task tagged with the context generation and that drop
  // themselves when they run in a newer page.
  std::lock_guard<std::mutex> lock(mu_);
  timers_.reset();
  frame_requested_ = false;
  tasks_first_ = false;
}

}  // namespace iwn
