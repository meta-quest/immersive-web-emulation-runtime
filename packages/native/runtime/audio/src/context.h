// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Owner of one (Offline)AudioContext on the native side: the graph, its render thread (device
// callback or offline thread), the shared state block JS reads without calling native, and the
// state machine behind resume/suspend/close. V8-free; the binding (binding_v8.cpp) and the host
// tests drive it through the functions at the bottom.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "graph.h"
#include "output.h"

namespace iwn::audio {

// Memory shared with JS (Float64Array over `shared`, Float32Array over `params`). Refcounted so the
// JS views may outlive the context object.
struct SharedBlock {
  static constexpr int kParamCapacity = 65536;  // 2 x Context::kNodeCapacity (web/audio PARAM_CAPACITY)
  static SharedBlock* create();
  void ref() { refs.fetch_add(1); }
  void release() {
    if (refs.fetch_sub(1) == 1) delete this;
  }
  std::atomic<int> refs{1};
  alignas(64) double shared[proto::kSharedCount] = {};
  alignas(64) float params[kParamCapacity] = {};
};

struct OutEvent {
  int type = 0;
  uint32_t ctx = 0;
  double a = 0;
  double b = 0;
  std::string message;
};

class Context final : public RenderCallback {
 public:
  static constexpr int kNodeCapacity = 32768;

  ~Context() override;
  uint32_t id() const { return id_; }
  bool offline() const { return offline_; }
  float sampleRate() const { return sampleRate_; }
  int channels() const { return channels_; }
  uint32_t length() const { return length_; }
  SharedBlock* block() { return block_; }
  Graph& graph() { return *graph_; }

  // Main thread. Prepares and queues one control batch. Returns the batch sequence number, or 0
  // if the word stream is malformed.
  uint64_t submit(const double* words, size_t n);
  // Offline: starts rendering on a background thread. False if already started.
  bool startRendering();
  // Main thread: drains render-side events and garbage.
  void collect(std::vector<OutEvent>& out);
  // AUD-2 (any thread).
  void setOutputPaused(bool paused);
  // getOutputTimestamp: contextTime (s) and CLOCK_MONOTONIC (ms) of its presentation.
  bool outputTimestamp(double& contextTime, double& monotonicMs) const;
  // Stops the device / joins the offline thread. Idempotent.
  void stop();
  bool hasPendingWork() const;
  uint64_t xruns() const { return output_ ? output_->xruns() : 0; }

  // RenderCallback (realtime thread).
  void render(float* interleaved, int channels, int frames) override;
  void serviceWithoutDevice() override;

  // Module-level factories.
  static Context* createRealtime(float requestedRate, int latencyHint, std::string* err,
                                 std::unique_ptr<AudioOutput> output = nullptr);
  static Context* createOffline(int channels, uint32_t length, float sampleRate, std::string* err);

 private:
  Context() = default;
  void handleStateRequests();
  void flushPending();
  void servicePaused();
  void offlineThread();

  uint32_t id_ = 0;
  bool offline_ = false;
  float sampleRate_ = 48000;
  int channels_ = 2;
  uint32_t length_ = 0;
  SharedBlock* block_ = nullptr;
  std::unique_ptr<Graph> graph_;
  std::unique_ptr<AudioOutput> output_;
  uint64_t nextSeq_ = 1;
  std::vector<Batch*> pending_;  // main side: batches that did not fit the queue yet

  // Render-side state.
  std::atomic<bool> running_{false};
  std::atomic<bool> closed_{false};
  float fifo_[kQuantum * 2] = {};
  int fifoPos_ = kQuantum;
  std::atomic<int64_t> deviceFrames_{0};
  std::atomic<int64_t> contextFramesOut_{0};
  double load_ = 0;
  std::atomic<bool> paused_{false};
  // Try-lock between the render callback and servicePaused() (main thread, output paused only).
  std::atomic<bool> renderBusy_{false};
  // State acknowledgement that did not fit the event queue (render side / servicePaused).
  bool ackPending_ = false;
  int ackState_ = 0;
  double ackRequest_ = 0;

  // Offline.
  std::thread thread_;
  BufferData* result_ = nullptr;
  std::atomic<bool> renderStarted_{false};
  std::atomic<bool> renderDone_{false};
  bool stopped_ = false;
};

// ---- module API (main thread unless noted) ----------------------------------------------------

Context* findContext(uint32_t id);
uint32_t registerContext(Context* c);
void destroyContext(uint32_t id);
// Drains every context's events plus finished decodes (registering decoded buffers in the
// BufferRegistry).
void collectAllEvents(std::vector<OutEvent>& out);
bool anyPendingWork();
void forEachContext(void (*fn)(Context*, void*), void* arg);
bool moduleShutDown();
// Stops and frees every context (a new page, PROC-8; shutdown).
void destroyAllContexts();
// After shutdown(): lets a new runtime in the same process use the module again (decoder and
// notifier threads restart on demand, pause reasons are cleared). No-op unless shut down.
void rearmAfterShutdown();

}  // namespace iwn::audio
