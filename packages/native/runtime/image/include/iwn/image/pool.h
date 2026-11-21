// Background threads for decode and pixel jobs (PROC-2: the JS thread only receives finished pixels), and the
// process-wide registry that moves pixel stores between isolates when an ImageBitmap is transferred (WRK-5).
#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <vector>

#include "iwn/image/pixels.h"

namespace iwn::image {

class TaskPool {
 public:
  explicit TaskPool(int threads);
  ~TaskPool();  // finishes queued jobs, then joins
  TaskPool(const TaskPool&) = delete;
  TaskPool& operator=(const TaskPool&) = delete;

  void Post(std::function<void()> job);
  size_t queued() const;
  int threads() const { return static_cast<int>(workers_.size()); }

  // The pool used by the binding. Created on first use with `DefaultThreadCount()` threads unless configured.
  static TaskPool& Shared();
  // Must be called before the first Shared() (later calls are ignored). 0 = default.
  static void ConfigureShared(int threads);
  // min(2, cores - 1), at least 1: decode should not starve the JS, render and audio threads.
  static int DefaultThreadCount();

 private:
  void Run();
  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::deque<std::function<void()>> queue_;
  std::vector<std::thread> workers_;
  bool stopping_ = false;
};

class TransferRegistry {
 public:
  static TransferRegistry& Shared();
  // Parks `store` and returns a non-zero id another isolate can Take() exactly once.
  uint64_t Put(std::shared_ptr<const PixelStore> store);
  std::shared_ptr<const PixelStore> Take(uint64_t id);  // nullptr if unknown or already taken
  void Discard(uint64_t id);
  size_t size() const;

 private:
  mutable std::mutex mu_;
  uint64_t next_ = 1;
  std::unordered_map<uint64_t, std::shared_ptr<const PixelStore>> parked_;
};

}  // namespace iwn::image
