// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Wakes the main JS thread when render or decoder threads have results (PROC-2). The realtime
// thread only posts a semaphore (non-blocking, allocation-free); a notifier thread turns that into
// one task on the main loop through the host's postToMain hook, coalescing bursts.
//
// At most one drain task is in flight. The host may drop a posted task (the core drops tasks of a
// page that has since reloaded), so the in-flight flag is cleared when a new page installs its
// drain function, and a task that has not run within kRepostAfterNs is posted again.
#pragma once

#include <semaphore.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <thread>

#include "iwn/audio.h"

namespace iwn::audio {

class Notifier {
 public:
  static constexpr int64_t kRepostAfterNs = 1000000000;  // 1 s

  static Notifier& get();
  // Any thread, realtime-safe.
  void signal();
  void setHooks(const HostHooks& h);
  bool hasHooks() const;
  // The function the posted task runs on the main thread (installed by the binding). Installing
  // one (a new page) forgets a task that may have been dropped and re-checks for results.
  void setDrain(void (*fn)(void*), void* arg);
  // Joins the notifier thread and forgets the hooks (PROC-7). restart() undoes it: the thread
  // starts again with the next setHooks().
  void shutdown();
  void restart();
  // Tests.
  uint64_t postsForTest() const { return posts_.load(); }

 private:
  Notifier();
  void run();
  void post();
  static void thunk(void* self);
  sem_t sem_;
  mutable std::mutex mu_;
  HostHooks hooks_;
  void (*drain_)(void*) = nullptr;
  void* drainArg_ = nullptr;
  std::atomic<bool> posted_{false};
  std::atomic<int64_t> postedAt_{0};
  std::atomic<bool> quit_{false};
  std::atomic<uint64_t> posts_{0};
  std::thread thread_;
};

}  // namespace iwn::audio
