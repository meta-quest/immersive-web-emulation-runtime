// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Android output over Oboe 1.9 (Apache-2.0): AAudio low-latency stream, float stereo, exclusive
// sharing when the device grants it.
//
// AUD-12: disconnects and routing changes (headphones, Bluetooth, USB) close the stream. A
// reopener thread then opens a new stream on the new route and starts it if output is wanted,
// retrying with backoff until it succeeds or the output is closed. The new stream is opened at
// the original sample rate (Oboe resamples when the route's native rate differs), because the
// graph, AudioBuffers and currentTime are all in the context's rate. A failed requestStart (e.g.
// a stream disconnected while paused, which delivers no callback) also triggers a reopen.
//
// While no stream is running although output is wanted (between a disconnect and the reopen),
// the reopener thread services the graph in place of the render callback (control batches, state
// requests: RenderCallback::serviceWithoutDevice), so close()/resume() still settle and batches do
// not pile up; nothing renders, so currentTime holds.
//
// Lifetime: Oboe calls onErrorAfterClose on a thread of its own that may still be running when the
// output is destroyed (reload, exit). The callbacks therefore live in a shared object (Impl) that
// the streams hold through Oboe's shared_ptr callback API; the error thread holds the stream, the
// stream holds Impl, so Impl outlives every callback. The stream -> Impl reference cycle is broken
// whenever a stream is dropped or closed.
#include <android/log.h>
#include <oboe/Oboe.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <ctime>
#include <mutex>
#include <pthread.h>
#include <memory>
#include <thread>

#include "output.h"

namespace iwn::audio {

namespace {
constexpr const char* kTag = "iwn.audio";

class Impl final : public oboe::AudioStreamDataCallback,
                   public oboe::AudioStreamErrorCallback,
                   public std::enable_shared_from_this<Impl> {
 public:
  bool open(int channels, float requestedRate, int latencyHint, RenderCallback* cb) {
    channels_ = channels;
    requestedRate_ = requestedRate;
    latencyHint_ = latencyHint;
    cb_ = cb;
    std::lock_guard<std::mutex> l(mu_);
    if (!openStreamLocked()) return false;
    // Every later reopen uses the rate the context was created with.
    requestedRate_ = rate_;
    reopener_ = std::thread([this] { reopenLoop(); });
    return true;
  }
  float sampleRate() const { return rate_; }
  double baseLatency() const { return baseLatency_.load(); }
  double outputLatency() const { return outputLatency_.load(); }

  bool start() {
    std::lock_guard<std::mutex> l(mu_);
    wantRunning_ = true;
    if (stream_) {
      oboe::Result r = stream_->requestStart();
      if (r == oboe::Result::OK) return true;
      __android_log_print(ANDROID_LOG_WARN, kTag, "requestStart failed (%s); reopening",
                          oboe::convertToText(r));
      dropStreamLocked(true);
    }
    needReopen_ = true;  // the reopener opens a stream and starts it
    cv_.notify_all();
    return false;
  }
  void pause() {
    std::lock_guard<std::mutex> l(mu_);
    wantRunning_ = false;
    if (stream_) stream_->requestPause();
  }
  void close() {
    {
      std::lock_guard<std::mutex> l(mu_);
      closing_ = true;
      wantRunning_ = false;
      cv_.notify_all();
      if (stream_) {
        stream_->stop();
        stream_->close();
        stream_.reset();
      }
    }
    if (reopener_.joinable() && reopener_.get_id() != std::this_thread::get_id()) reopener_.join();
  }
  uint64_t xruns() const {
    std::lock_guard<std::mutex> l(mu_);
    uint64_t x = xrunBase_;
    if (stream_) {
      auto r = stream_->getXRunCount();
      if (r) x += static_cast<uint64_t>(r.value());
    }
    return x;
  }
  bool timestamp(int64_t& frame, int64_t& nanos) const {
    std::lock_guard<std::mutex> l(mu_);
    if (!stream_) return false;
    auto r = stream_->getTimestamp(CLOCK_MONOTONIC);
    if (!r) return false;
    frame = r.value().position + frameBase_;
    nanos = r.value().timestamp;
    return true;
  }

  oboe::DataCallbackResult onAudioReady(oboe::AudioStream*, void* data, int32_t frames) override {
    cb_->render(static_cast<float*>(data), channels_, frames);
    delivered_.fetch_add(frames, std::memory_order_relaxed);
    return oboe::DataCallbackResult::Continue;
  }

  void onErrorAfterClose(oboe::AudioStream* s, oboe::Result error) override {
    __android_log_print(ANDROID_LOG_WARN, kTag, "audio stream closed (%s); reopening",
                        oboe::convertToText(error));
    std::lock_guard<std::mutex> l(mu_);
    if (closing_) return;
    if (stream_ && stream_.get() == s) dropStreamLocked(false);  // Oboe closed it already
    needReopen_ = true;
    cv_.notify_all();
  }

 private:
  // Forgets the current stream (Oboe closes it, or it is already closed), keeping frame
  // numbering and xrun counts continuous across the reopen.
  void dropStreamLocked(bool closeIt) {
    frameBase_ = delivered_.load();
    auto r = stream_->getXRunCount();
    if (r) xrunBase_ += static_cast<uint64_t>(r.value());
    if (closeIt) stream_->close();
    stream_.reset();
  }

  void reopenLoop() {
    pthread_setname_np(pthread_self(), "iwn.audioReopen");  // PROC-4 (15 chars + NUL)
    std::unique_lock<std::mutex> l(mu_);
    int attempt = 0;
    for (;;) {
      cv_.wait(l, [&] { return closing_ || needReopen_; });
      if (closing_) return;
      if (!stream_ && openStreamLocked()) {
        if (wantRunning_) {
          oboe::Result r = stream_->requestStart();
          if (r != oboe::Result::OK) {
            __android_log_print(ANDROID_LOG_WARN, kTag, "requestStart after reopen failed (%s)",
                                oboe::convertToText(r));
            dropStreamLocked(true);
          }
        }
      }
      if (stream_) {
        needReopen_ = false;
        attempt = 0;
        continue;
      }
      // No device right now (route switching): retry with backoff, 50 ms up to 2 s. Meanwhile
      // stand in for the render callback every 50 ms (control batches, state requests).
      int ms = std::min(2000, 50 << std::min(attempt, 6));
      ++attempt;
      auto retryAt = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
      for (;;) {
        if (cb_) {
          // Serviced without mu_ so that stats, getOutputTimestamp() and visibility changes on the
          // JS thread do not wait for it. No stream exists here, so no render callback races it;
          // close() sets closing_ and joins this thread before the callback goes away.
          l.unlock();
          cb_->serviceWithoutDevice();
          l.lock();
          if (closing_) return;
          if (stream_) break;  // start() cannot open one, but stay defensive
        }
        if (cv_.wait_until(l, std::min(retryAt, std::chrono::steady_clock::now() + std::chrono::milliseconds(50)),
                           [&] { return closing_; }))
          return;
        if (std::chrono::steady_clock::now() >= retryAt) break;
      }
    }
  }

  bool openStreamLocked() {
    oboe::AudioStreamBuilder b;
    b.setDirection(oboe::Direction::Output)
        ->setFormat(oboe::AudioFormat::Float)
        ->setChannelCount(channels_)
        ->setPerformanceMode(latencyHint_ == 1 ? oboe::PerformanceMode::None
                                               : oboe::PerformanceMode::LowLatency)
        ->setSharingMode(oboe::SharingMode::Exclusive)
        ->setUsage(oboe::Usage::Game)
        ->setContentType(oboe::ContentType::Sonification)
        ->setDataCallback(shared_from_this())
        ->setErrorCallback(shared_from_this());
    if (requestedRate_ > 0) {
      b.setSampleRate(static_cast<int32_t>(requestedRate_));
      b.setSampleRateConversionQuality(oboe::SampleRateConversionQuality::Medium);
    }
    std::shared_ptr<oboe::AudioStream> s;
    oboe::Result r = b.openStream(s);
    if (r != oboe::Result::OK) {
      __android_log_print(ANDROID_LOG_ERROR, kTag, "openStream failed: %s", oboe::convertToText(r));
      return false;
    }
    // Double-buffer at the burst size: the lowest latency that stays glitch-free in practice.
    int32_t burst = s->getFramesPerBurst();
    if (burst > 0) s->setBufferSizeInFrames(burst * 2);
    // ADPF performance hint (Android 12+): Oboe reports each callback's duration so the system
    // keeps the render thread on a core and clock that fit the graph's load (PERF-AUDIO-1);
    // without it, the same graph measured 12 % or 26 % of the period from run to run on Quest 3S.
    s->setPerformanceHintEnabled(true);
    stream_ = s;
    float rate = static_cast<float>(s->getSampleRate());
    if (!opened_) {
      rate_ = rate;  // fixed for the stream's lifetime: reopens request this rate
      opened_ = true;
    }
    baseLatency_.store(burst > 0 ? static_cast<double>(burst) / rate : 0.01);
    auto lat = s->calculateLatencyMillis();
    outputLatency_.store(lat ? lat.value() / 1000.0 : static_cast<double>(s->getBufferSizeInFrames()) / rate);
    __android_log_print(ANDROID_LOG_INFO, kTag,
                        "audio stream open: %d Hz, %d ch, burst %d, buffer %d, sharing %s, mode %s",
                        s->getSampleRate(), s->getChannelCount(), burst, s->getBufferSizeInFrames(),
                        s->getSharingMode() == oboe::SharingMode::Exclusive ? "exclusive" : "shared",
                        s->getPerformanceMode() == oboe::PerformanceMode::LowLatency ? "low-latency"
                                                                                       : "other");
    return true;
  }

  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::thread reopener_;
  std::shared_ptr<oboe::AudioStream> stream_;
  RenderCallback* cb_ = nullptr;
  int channels_ = 2;
  float requestedRate_ = 0;
  int latencyHint_ = 0;
  float rate_ = 48000;
  std::atomic<double> baseLatency_{0};
  std::atomic<double> outputLatency_{0};
  std::atomic<int64_t> delivered_{0};
  int64_t frameBase_ = 0;
  uint64_t xrunBase_ = 0;
  bool wantRunning_ = false;
  bool needReopen_ = false;
  bool closing_ = false;
  bool opened_ = false;
};

class OboeOutput final : public AudioOutput {
 public:
  ~OboeOutput() override { impl_->close(); }
  bool open(int channels, float requestedRate, int latencyHint, RenderCallback* cb) override {
    return impl_->open(channels, requestedRate, latencyHint, cb);
  }
  float sampleRate() const override { return impl_->sampleRate(); }
  double baseLatency() const override { return impl_->baseLatency(); }
  double outputLatency() const override { return impl_->outputLatency(); }
  bool start() override { return impl_->start(); }
  void pause() override { impl_->pause(); }
  void close() override { impl_->close(); }
  uint64_t xruns() const override { return impl_->xruns(); }
  bool timestamp(int64_t& frame, int64_t& nanos) const override { return impl_->timestamp(frame, nanos); }

 private:
  std::shared_ptr<Impl> impl_ = std::make_shared<Impl>();
};
}  // namespace

std::unique_ptr<AudioOutput> createPlatformOutput() { return std::make_unique<OboeOutput>(); }

int64_t monotonicNanos() {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<int64_t>(ts.tv_sec) * 1000000000 + ts.tv_nsec;
}

}  // namespace iwn::audio
