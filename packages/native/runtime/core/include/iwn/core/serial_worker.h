/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// One background thread that runs jobs in order (V8-free, host-tested).
//
// Used for blocking file work the JS thread must not do (PROC-2), such as reading an import()'s module graph out
// of the APK. It replaces "one detached std::thread per request": the number of threads is bounded (one), the
// queue is bounded (post() refuses past max_pending so the caller falls back), the thread runs at a priority set
// by the owner (below the JS thread), and stop() joins it so no job outlives its owner.
//
// Jobs must not capture anything that has to be destroyed on another thread (for example v8::Global): stop()
// destroys the jobs that never ran on the calling thread, and a job is destroyed on the worker thread after it ran.
#pragma once

#include <atomic>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

#include "iwn/core/monotonic_cv.h"

namespace iwn {

class SerialWorker {
 public:
  // `stop` turns true when stop() is called; long jobs should check it between steps and return early.
  using Job = std::function<void(const std::atomic<bool>& stop)>;

  // `name`: thread name (<= 15 chars). `nice`: the thread's nice value, set when it starts (Linux/Android per-thread
  // nice; a thread inherits its creator's value otherwise). INT_MIN keeps the inherited value.
  SerialWorker(std::string name, int nice, size_t max_pending = 1024);
  ~SerialWorker();  // stop()
  SerialWorker(const SerialWorker&) = delete;
  SerialWorker& operator=(const SerialWorker&) = delete;

  // Queues a job; the thread starts on the first post. Returns false (and leaves `job` untouched) when stopped,
  // when the queue is full or when the thread could not be created; the caller then does the work another way.
  bool post(Job& job);
  // Asks the running job to stop, drops the queued ones and joins the thread. Later posts are refused.
  void stop();

  size_t pending() const;
  bool started() const;

 private:
  void run();

  const std::string name_;
  const int nice_;
  const size_t max_pending_;
  mutable std::mutex mu_;
  MonotonicCondVar cv_;
  std::deque<Job> jobs_;
  std::thread thread_;
  std::atomic<bool> stop_{false};
};

}  // namespace iwn
