/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/xr/handoff.h"

namespace iwn::xr {

bool FrameSlot::post() {
  int expected = kIdle;
  return state_.compare_exchange_strong(expected, kPosted, std::memory_order_acq_rel);
}

bool FrameSlot::begin() {
  int expected = kPosted;
  return state_.compare_exchange_strong(expected, kRunning, std::memory_order_acq_rel);
}

void FrameSlot::finish() {
  {
    std::lock_guard<std::mutex> lock(mu_);
    state_.store(kDone, std::memory_order_release);
  }
  cv_.notify_all();
}

bool FrameSlot::cancel() {
  int expected = kPosted;
  return state_.compare_exchange_strong(expected, kCancelled, std::memory_order_acq_rel);
}

void FrameSlot::reset() {
  int s = state_.load(std::memory_order_acquire);
  if (s == kDone || s == kCancelled) state_.store(kIdle, std::memory_order_release);
}

bool FrameSlot::withdraw() {
  if (!cancel()) return false;
  reset();
  return true;
}

FrameSlot::Outcome FrameSlot::conclude() {
  if (withdraw()) return Outcome::kCancelled;  // still posted: JS never began it
  // Only the XR thread moves the slot into or out of kIdle and kCancelled, so those reads are stable here; JS may
  // still move kRunning to kDone, which the caller handles by collecting the frame later.
  switch (state()) {
    case kDone: return Outcome::kDone;
    case kRunning: return Outcome::kRunning;
    case kCancelled:
      reset();
      return Outcome::kWithdrawn;
    default: return Outcome::kWithdrawn;  // kIdle: a command withdrew the frame while the XR thread waited
  }
}

void FrameSlot::kick() {
  {
    std::lock_guard<std::mutex> lock(mu_);
    kicked_ = true;
  }
  cv_.notify_all();
}

FrameSlot::State FrameSlot::wait_done(std::chrono::steady_clock::time_point deadline, CommandQueue* commands) {
  for (;;) {
    if (commands) commands->run_pending();
    std::unique_lock<std::mutex> lock(mu_);
    const State s = state();
    // Done, or no frame left to wait for (a command withdrew it, or collected it): stop waiting.
    if (s != kPosted && s != kRunning) return s;
    if (kicked_) {
      kicked_ = false;
      continue;  // run the commands that woke us, then look again
    }
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) return s;
    cv_.wait_once_for(lock, std::chrono::duration_cast<std::chrono::nanoseconds>(deadline - now));
    if (state() == kDone) return kDone;
  }
}

bool CommandQueue::push(Command command) {
  FrameSlot* slot;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (closed_) return false;
    queue_.push_back(std::move(command));
    slot = slot_;
  }
  cv_.notify_all();
  if (slot) slot->kick();
  return true;
}

bool CommandQueue::call(Command command, std::chrono::milliseconds timeout) {
  struct Done {
    std::mutex mu;
    MonotonicCondVar cv;
    bool done = false;
  };
  auto done = std::make_shared<Done>();
  const bool queued = push([done, command = std::move(command)] {
    command();
    {
      std::lock_guard<std::mutex> lock(done->mu);
      done->done = true;
    }
    done->cv.notify_all();
  });
  if (!queued) return false;
  std::unique_lock<std::mutex> lock(done->mu);
  return done->cv.wait_for(lock, timeout, [&] { return done->done; });
}

int CommandQueue::run_pending() {
  std::deque<Command> batch;
  {
    std::lock_guard<std::mutex> lock(mu_);
    batch.swap(queue_);
  }
  int n = 0;
  for (auto& c : batch) {
    if (c) c();
    ++n;
  }
  return n;
}

void CommandQueue::wait(std::chrono::milliseconds timeout) {
  std::unique_lock<std::mutex> lock(mu_);
  if (!queue_.empty() || closed_) return;
  cv_.wait_for(lock, timeout, [this] { return !queue_.empty() || closed_; });
}

bool CommandQueue::empty() const {
  std::lock_guard<std::mutex> lock(mu_);
  return queue_.empty();
}

void CommandQueue::close() {
  run_pending();
  {
    std::lock_guard<std::mutex> lock(mu_);
    closed_ = true;
  }
  run_pending();  // anything pushed between the two runs
  cv_.notify_all();
}

void CommandQueue::reopen() {
  std::lock_guard<std::mutex> lock(mu_);
  queue_.clear();
  closed_ = false;
}

void FrameSlot::force_idle() {
  std::lock_guard<std::mutex> lock(mu_);
  kicked_ = false;
  state_.store(kIdle, std::memory_order_release);
}

}  // namespace iwn::xr
