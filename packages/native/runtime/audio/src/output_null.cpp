// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Host output: a thread that pulls audio at real-time pace and discards it (no sound card on a
// build host). Lets host tests exercise the realtime path: control batches, currentTime advancing
// with rendered frames, pause/resume, ended events.
#include <pthread.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <ctime>
#include <mutex>
#include <thread>
#include <vector>

#include "output.h"

namespace iwn::audio {

namespace {
class NullOutput final : public AudioOutput {
 public:
  ~NullOutput() override { close(); }
  bool open(int channels, float requestedRate, int, RenderCallback* cb) override {
    channels_ = channels;
    rate_ = requestedRate > 0 ? requestedRate : 48000.f;
    cb_ = cb;
    buf_.assign(static_cast<size_t>(kBurst * channels_), 0.f);
    thread_ = std::thread([this] { run(); });
    return true;
  }
  float sampleRate() const override { return rate_; }
  double baseLatency() const override { return kBurst / rate_; }
  double outputLatency() const override { return 2.0 * kBurst / rate_; }
  bool start() override {
    std::lock_guard<std::mutex> l(mu_);
    running_ = true;
    cv_.notify_all();
    return true;
  }
  void pause() override {
    std::lock_guard<std::mutex> l(mu_);
    running_ = false;
  }
  void close() override {
    {
      std::lock_guard<std::mutex> l(mu_);
      quit_ = true;
      cv_.notify_all();
    }
    if (thread_.joinable()) thread_.join();
  }
  uint64_t xruns() const override { return 0; }
  bool timestamp(int64_t& frame, int64_t& nanos) const override {
    frame = lastFrame_.load();
    nanos = lastNanos_.load() + static_cast<int64_t>(outputLatency() * 1e9);
    return lastNanos_.load() != 0;
  }

 private:
  static constexpr int kBurst = 192;  // 4 ms at 48 kHz, like a typical AAudio burst
  void run() {
    pthread_setname_np(pthread_self(), "iwn-audio-null");
    auto next = std::chrono::steady_clock::now();
    int64_t frames = 0;
    for (;;) {
      {
        std::unique_lock<std::mutex> l(mu_);
        if (!running_ && !quit_) {
          cv_.wait(l, [&] { return running_ || quit_; });
          next = std::chrono::steady_clock::now();
        }
        if (quit_) return;
      }
      cb_->render(buf_.data(), channels_, kBurst);
      frames += kBurst;
      lastFrame_.store(frames);
      lastNanos_.store(monotonicNanos());
      next += std::chrono::nanoseconds(static_cast<int64_t>(kBurst * 1e9 / rate_));
      std::this_thread::sleep_until(next);
    }
  }
  int channels_ = 2;
  float rate_ = 48000;
  RenderCallback* cb_ = nullptr;
  std::vector<float> buf_;
  std::thread thread_;
  std::mutex mu_;
  std::condition_variable cv_;
  bool running_ = false;
  bool quit_ = false;
  std::atomic<int64_t> lastFrame_{0};
  std::atomic<int64_t> lastNanos_{0};
};
}  // namespace

std::unique_ptr<AudioOutput> createPlatformOutput() { return std::make_unique<NullOutput>(); }

int64_t monotonicNanos() {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<int64_t>(ts.tv_sec) * 1000000000 + ts.tv_nsec;
}

}  // namespace iwn::audio
