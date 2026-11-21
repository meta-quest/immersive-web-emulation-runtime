// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Bounded lock-free single-producer/single-consumer ring (wait-free push/pop, no allocation after
// construction). Used for every hand-off between the main thread and the render thread.
#pragma once

#include <atomic>
#include <cstddef>
#include <vector>

namespace iwn::audio {

template <typename T>
class Spsc {
 public:
  explicit Spsc(size_t capacityPow2) : mask_(capacityPow2 - 1), slots_(capacityPow2) {}
  bool push(const T& v) {
    size_t h = head_.load(std::memory_order_relaxed);
    size_t t = tail_.load(std::memory_order_acquire);
    if (h - t > mask_) return false;
    slots_[h & mask_] = v;
    head_.store(h + 1, std::memory_order_release);
    return true;
  }
  bool pop(T& out) {
    size_t t = tail_.load(std::memory_order_relaxed);
    size_t h = head_.load(std::memory_order_acquire);
    if (t == h) return false;
    out = slots_[t & mask_];
    tail_.store(t + 1, std::memory_order_release);
    return true;
  }
  bool peek(T& out) const {
    size_t t = tail_.load(std::memory_order_relaxed);
    size_t h = head_.load(std::memory_order_acquire);
    if (t == h) return false;
    out = slots_[t & mask_];
    return true;
  }
  // Producer side: slots that can be pushed right now (a lower bound).
  size_t freeSlots() const {
    size_t h = head_.load(std::memory_order_relaxed);
    size_t t = tail_.load(std::memory_order_acquire);
    return mask_ + 1 - (h - t);
  }
  bool empty() const {
    return head_.load(std::memory_order_acquire) == tail_.load(std::memory_order_acquire);
  }

 private:
  const size_t mask_;
  std::vector<T> slots_;
  alignas(64) std::atomic<size_t> head_{0};
  alignas(64) std::atomic<size_t> tail_{0};
};

}  // namespace iwn::audio
