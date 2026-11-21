/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/image/pool.h"

#include <algorithm>
#include <atomic>

#if defined(__ANDROID__)
#include <pthread.h>
#include <sys/prctl.h>
#endif

namespace iwn::image {

TaskPool::TaskPool(int threads) {
  threads = std::max(1, threads);
  workers_.reserve(threads);
  for (int i = 0; i < threads; ++i) workers_.emplace_back([this] { Run(); });
}

TaskPool::~TaskPool() {
  {
    std::lock_guard<std::mutex> lock(mu_);
    stopping_ = true;
  }
  cv_.notify_all();
  for (std::thread& t : workers_) t.join();
}

void TaskPool::Post(std::function<void()> job) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    queue_.push_back(std::move(job));
  }
  cv_.notify_one();
}

size_t TaskPool::queued() const {
  std::lock_guard<std::mutex> lock(mu_);
  return queue_.size();
}

void TaskPool::Run() {
#if defined(__ANDROID__)
  prctl(PR_SET_NAME, "iwn-image", 0, 0, 0);
#endif
  for (;;) {
    std::function<void()> job;
    {
      std::unique_lock<std::mutex> lock(mu_);
      cv_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (queue_.empty()) return;  // stopping and drained
      job = std::move(queue_.front());
      queue_.pop_front();
    }
    job();
  }
}

namespace {
std::atomic<int> g_configured_threads{0};
}

void TaskPool::ConfigureShared(int threads) { g_configured_threads.store(threads); }

int TaskPool::DefaultThreadCount() {
  const int cores = static_cast<int>(std::thread::hardware_concurrency());
  return std::max(1, std::min(2, cores - 1));
}

TaskPool& TaskPool::Shared() {
  // Intentionally leaked: worker threads must outlive every isolate that may still post completions at exit.
  static TaskPool* pool = new TaskPool(g_configured_threads.load() > 0 ? g_configured_threads.load()
                                                                       : DefaultThreadCount());
  return *pool;
}

TransferRegistry& TransferRegistry::Shared() {
  static TransferRegistry* registry = new TransferRegistry();
  return *registry;
}

uint64_t TransferRegistry::Put(std::shared_ptr<const PixelStore> store) {
  std::lock_guard<std::mutex> lock(mu_);
  const uint64_t id = next_++;
  parked_.emplace(id, std::move(store));
  return id;
}

std::shared_ptr<const PixelStore> TransferRegistry::Take(uint64_t id) {
  std::lock_guard<std::mutex> lock(mu_);
  auto it = parked_.find(id);
  if (it == parked_.end()) return nullptr;
  auto store = std::move(it->second);
  parked_.erase(it);
  return store;
}

void TransferRegistry::Discard(uint64_t id) {
  std::lock_guard<std::mutex> lock(mu_);
  parked_.erase(id);
}

size_t TransferRegistry::size() const {
  std::lock_guard<std::mutex> lock(mu_);
  return parked_.size();
}

}  // namespace iwn::image
