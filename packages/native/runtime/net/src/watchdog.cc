// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.

#include "iwn/net/watchdog.h"

#include <chrono>
#include <thread>

#include "iwn/net/util.h"

namespace iwn::net {

namespace {
int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
}  // namespace

Watchdog& Watchdog::Shared() {
  static Watchdog* w = new Watchdog();  // never destroyed: network threads may outlive statics
  return *w;
}

Watchdog::Id Watchdog::Arm(int timeout_ms, std::function<void()> fire) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!started_) {
    started_ = true;
    std::thread([this] { Run(); }).detach();
  }
  Id id = next_id_++;
  int64_t deadline = NowMs() + (timeout_ms < 0 ? 0 : timeout_ms);
  timers_.emplace(deadline, std::make_pair(id, std::move(fire)));
  index_[id] = deadline;
  cv_.notify_all();
  return id;
}

bool Watchdog::Disarm(Id id) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = index_.find(id);
  if (it == index_.end()) return true;  // already fired (ids are never reused)
  auto range = timers_.equal_range(it->second);
  for (auto t = range.first; t != range.second; ++t) {
    if (t->second.first == id) {
      timers_.erase(t);
      break;
    }
  }
  index_.erase(it);
  return false;
}

void Watchdog::Run() {
  SetCurrentThreadName("iwn-net-timer");
  std::unique_lock<std::mutex> lock(mu_);
  for (;;) {
    if (timers_.empty()) {
      cv_.wait(lock);
      continue;
    }
    int64_t now = NowMs();
    auto first = timers_.begin();
    if (first->first > now) {
      cv_.wait_for(lock, std::chrono::milliseconds(first->first - now));
      continue;
    }
    std::function<void()> fire = std::move(first->second.second);
    index_.erase(first->second.first);
    timers_.erase(first);
    // Under the lock: Disarm() cannot return while this runs.
    if (fire) fire();
  }
}

}  // namespace iwn::net
