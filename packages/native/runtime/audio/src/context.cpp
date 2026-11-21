// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
#include "context.h"

#include <pthread.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <mutex>
#include <unordered_map>

#include "decode.h"
#include "iwn/audio.h"
#include "notify.h"

namespace iwn::audio {

using namespace proto;

namespace {
struct Registry {
  std::mutex mu;
  std::unordered_map<uint32_t, Context*> map;
  uint32_t next = 1;
  std::atomic<uint32_t> pausedReasons{0};
  std::atomic<bool> shutDown{false};
};
Registry& registry() {
  static Registry* r = new Registry();
  return *r;
}

void discardBatch(Batch* b) { deleteBatch(b); }

std::vector<OutEvent>& mainEvents() {
  static std::vector<OutEvent>* v = new std::vector<OutEvent>();
  return *v;
}
}  // namespace

SharedBlock* SharedBlock::create() { return new SharedBlock(); }

// ---- construction -----------------------------------------------------------------------------

Context* Context::createRealtime(float requestedRate, int latencyHint, std::string* err,
                                 std::unique_ptr<AudioOutput> output) {
  if (registry().shutDown.load()) {
    *err = "audio module is shut down";
    return nullptr;
  }
  auto* c = new Context();
  c->offline_ = false;
  c->channels_ = 2;
  c->output_ = output ? std::move(output) : createPlatformOutput();
  if (!c->output_->open(2, requestedRate, latencyHint, c)) {
    *err = "could not open the audio output device";
    delete c;
    return nullptr;
  }
  c->sampleRate_ = c->output_->sampleRate();
  c->block_ = SharedBlock::create();
  c->graph_.reset(new Graph(c->sampleRate_, 2, c->block_->shared, c->block_->params,
                            SharedBlock::kParamCapacity, kNodeCapacity));
  Graph::storeShared(&c->block_->shared[kSharedBaseLatency], c->output_->baseLatency());
  Graph::storeShared(&c->block_->shared[kSharedOutputLatency], c->output_->outputLatency());
  c->id_ = registerContext(c);
  // AUD-1 (decision): no user activation needed; the context starts rendering immediately and
  // reports `running` through a statechange, as Quest Browser does after a gesture.
  c->running_.store(true);
  Graph::storeShared(&c->block_->shared[kSharedState], 1);
  mainEvents().push_back({kEvState, c->id_, 1, 0, {}});
  if (registry().pausedReasons.load() != 0) {
    c->paused_.store(true);
    Graph::storeShared(&c->block_->shared[kSharedPaused], 1);
  } else {
    c->output_->start();
  }
  return c;
}

Context* Context::createOffline(int channels, uint32_t length, float sampleRate, std::string* err) {
  if (registry().shutDown.load()) {
    *err = "audio module is shut down";
    return nullptr;
  }
  // The rendered buffer is allocated up front: refuse sizes that cannot be (1 GiB of samples).
  if (static_cast<double>(length) * channels * sizeof(float) > static_cast<double>(1u << 30)) {
    *err = "OfflineAudioContext is too large (numberOfChannels x length)";
    return nullptr;
  }
  auto* c = new Context();
  c->offline_ = true;
  c->channels_ = channels;
  c->length_ = length;
  c->sampleRate_ = sampleRate;
  c->block_ = SharedBlock::create();
  c->graph_.reset(new Graph(sampleRate, std::min(channels, kBusChannels), c->block_->shared,
                            c->block_->params, SharedBlock::kParamCapacity, kNodeCapacity));
  c->id_ = registerContext(c);
  return c;
}

Context::~Context() {
  stop();
  for (Batch* b : pending_) discardBatch(b);
  pending_.clear();
  graph_.reset();
  output_.reset();
  if (result_) result_->release();
  if (block_) block_->release();
}

void Context::stop() {
  if (stopped_) return;
  stopped_ = true;
  closed_.store(true);
  running_.store(false);
  if (output_) output_->close();
  if (thread_.joinable()) thread_.join();
}

// ---- main thread ------------------------------------------------------------------------------

uint64_t Context::submit(const double* words, size_t n) {
  auto* b = new Batch();
  b->words.assign(words, words + n);
  if (!graph_->prepare(*b)) {
    discardBatch(b);
    return 0;
  }
  b->seq = nextSeq_++;
  flushPending();
  if (!pending_.empty() || !graph_->pushBatch(b)) pending_.push_back(b);
  servicePaused();
  return b->seq;
}

void Context::servicePaused() {
  // AUD-2: while output is paused no render callback runs, so batches would pile up (three.js
  // keeps scheduling ramps) and state requests (close(), resume()) would never be answered.
  // Apply them here instead, under the try-lock the render callback also takes; nothing renders,
  // so currentTime stays put.
  if (offline_ || !paused_.load(std::memory_order_acquire) || stopped_) return;
  bool expected = false;
  if (!renderBusy_.compare_exchange_strong(expected, true, std::memory_order_acquire)) return;
  flushPending();
  graph_->applyPending();
  handleStateRequests();
  renderBusy_.store(false, std::memory_order_release);
  if (!graph_->events.empty()) Notifier::get().signal();
}

void Context::serviceWithoutDevice() {
  // AUD-12: the output's reopener thread, while the stream is down. Same try-lock as the render
  // callback and servicePaused(); nothing renders, so currentTime holds. Batches that did not fit
  // the queue (pending_, main side) follow with the next submit/collect.
  if (offline_) return;
  bool expected = false;
  if (!renderBusy_.compare_exchange_strong(expected, true, std::memory_order_acquire)) return;
  graph_->applyPending();
  handleStateRequests();
  renderBusy_.store(false, std::memory_order_release);
  if (!graph_->events.empty()) Notifier::get().signal();
}

void Context::flushPending() {
  size_t i = 0;
  while (i < pending_.size() && graph_->pushBatch(pending_[i])) ++i;
  pending_.erase(pending_.begin(), pending_.begin() + static_cast<std::ptrdiff_t>(i));
}

bool Context::startRendering() {
  if (!offline_ || renderStarted_.exchange(true)) return false;
  result_ = BufferData::create(channels_, length_, sampleRate_);
  if (!result_) return false;
  flushPending();
  thread_ = std::thread([this] { offlineThread(); });
  return true;
}

void Context::offlineThread() {
  pthread_setname_np(pthread_self(), "iwn-audio-offl");
  running_.store(true);
  Graph::storeShared(&block_->shared[kSharedState], 1);
  for (uint32_t f = 0; f < length_ && !closed_.load(std::memory_order_relaxed); f += kQuantum) {
    graph_->applyPending();
    Graph::StateRequest r;
    while (graph_->popStateRequest(r)) {
    }
    graph_->render();
    const AudioBus& m = graph_->destination()->mixed();
    uint32_t n = std::min<uint32_t>(kQuantum, length_ - f);
    for (int c = 0; c < channels_; ++c) {
      float* dst = result_->channel(c) + f;
      if (c < m.channels() && !m.silent()) memcpy(dst, m.channel(c), n * sizeof(float));
    }
    if (!graph_->events.empty()) Notifier::get().signal();
    // Not realtime: let the main thread catch up instead of running far ahead of a full queue.
    while (graph_->events.freeSlots() < 64 && !closed_.load(std::memory_order_relaxed)) {
      Notifier::get().signal();
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
  running_.store(false);
  Graph::storeShared(&block_->shared[kSharedState], 0);
  renderDone_.store(true);
  while (!graph_->events.push({kEvRenderDone, 0, 0}) && !closed_.load(std::memory_order_relaxed)) {
    Notifier::get().signal();
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  Notifier::get().signal();
}

void Context::collect(std::vector<OutEvent>& out) {
  flushPending();
  servicePaused();
  graph_->drainGarbage();
  if (!offline_ && output_) {
    // The device may have been reopened on another route (AUD-12): keep the latencies current.
    Graph::storeShared(&block_->shared[kSharedBaseLatency], output_->baseLatency());
    Graph::storeShared(&block_->shared[kSharedOutputLatency], output_->outputLatency());
  }
  GraphEvent e;
  while (graph_->events.pop(e)) {
    switch (e.type) {
      case kEvRenderDone: {
        if (thread_.joinable()) thread_.join();
        uint32_t bid = 0;
        if (result_) {
          bid = BufferRegistry::get().add(result_);
          result_ = nullptr;
        }
        out.push_back({kEvRenderDone, id_, static_cast<double>(bid), 0, {}});
        break;
      }
      case kEvState:
        out.push_back({kEvState, id_, e.a, e.b, {}});
        if (static_cast<int>(e.a) == 2 && output_) output_->close();  // close(): release the device
        break;
      default:
        out.push_back({e.type, id_, e.a, e.b, {}});
        break;
    }
  }
  graph_->drainGarbage();
}

void Context::setOutputPaused(bool paused) {
  if (offline_ || closed_.load()) return;
  if (paused_.exchange(paused) == paused) return;
  Graph::storeShared(&block_->shared[kSharedPaused], paused ? 1 : 0);
  // A failed start (e.g. the stream was disconnected while paused) is handled by the output: it
  // reopens the stream and starts it (AUD-12).
  if (paused) output_->pause();
  else output_->start();
}

bool Context::outputTimestamp(double& contextTime, double& monotonicMs) const {
  if (offline_ || !output_) return false;
  int64_t devFrame = 0, nanos = 0;
  if (!output_->timestamp(devFrame, nanos)) return false;
  int64_t behind = deviceFrames_.load() - devFrame;
  int64_t ctxFrame = contextFramesOut_.load() - behind;
  if (ctxFrame < 0) ctxFrame = 0;
  contextTime = static_cast<double>(ctxFrame) / sampleRate_;
  monotonicMs = static_cast<double>(nanos) / 1e6;
  return true;
}

bool Context::hasPendingWork() const {
  return !graph_->events.empty() || !pending_.empty() || (renderStarted_.load() && result_);
}

// ---- render thread ----------------------------------------------------------------------------

void Context::handleStateRequests() {
  // Acknowledgements are cumulative: an ack for request id N settles every request up to N (JS
  // side: BaseAudioContext.onState). An ack that does not fit the event queue is kept and retried
  // here (every quantum); later requests replace it until it is out, so the order never inverts.
  if (ackPending_ && graph_->events.push({kEvState, static_cast<double>(ackState_), ackRequest_})) ackPending_ = false;
  Graph::StateRequest r;
  while (graph_->popStateRequest(r)) {
    int state = 0;
    if (r.desired == 0) {
      running_.store(false);
      state = closed_.load() ? 2 : 0;
    } else if (r.desired == 1) {
      if (!closed_.load()) running_.store(true);
      state = closed_.load() ? 2 : 1;
    } else {
      running_.store(false);
      closed_.store(true);
      state = 2;
    }
    Graph::storeShared(&block_->shared[kSharedState], state);
    if (ackPending_ || !graph_->events.push({kEvState, static_cast<double>(state), r.requestId})) {
      ackPending_ = true;
      ackState_ = state;
      ackRequest_ = r.requestId;
    }
  }
}

void Context::render(float* out, int ch, int frames) {
  bool expected = false;
  if (!renderBusy_.compare_exchange_strong(expected, true, std::memory_order_acquire)) {
    // The main thread is servicing the graph while output is paused (servicePaused): emit
    // silence for this callback rather than wait.
    memset(out, 0, static_cast<size_t>(frames) * static_cast<size_t>(ch) * sizeof(float));
    deviceFrames_.fetch_add(frames, std::memory_order_relaxed);
    return;
  }
  int64_t t0 = monotonicNanos();
  int w = 0;
  while (w < frames) {
    if (fifoPos_ >= kQuantum) {
      // Control batches land only here: at a render-quantum boundary (AUD-10).
      graph_->applyPending();
      handleStateRequests();
      if (!running_.load(std::memory_order_relaxed)) break;
      graph_->render();
      const AudioBus& m = graph_->destination()->mixed();
      if (m.silent()) {
        memset(fifo_, 0, sizeof fifo_);
      } else {
        const float* l = m.channel(0);
        const float* r = m.channel(m.channels() > 1 ? 1 : 0);
        for (int i = 0; i < kQuantum; ++i) {
          fifo_[2 * i] = l[i];
          fifo_[2 * i + 1] = r[i];
        }
      }
      fifoPos_ = 0;
    }
    int n = std::min(frames - w, kQuantum - fifoPos_);
    for (int i = 0; i < n; ++i) {
      float* o = out + static_cast<size_t>(w + i) * static_cast<size_t>(ch);
      const float* s = fifo_ + 2 * (fifoPos_ + i);
      o[0] = s[0];
      if (ch > 1) o[1] = s[1];
      for (int c = 2; c < ch; ++c) o[c] = 0.f;
    }
    w += n;
    fifoPos_ += n;
    contextFramesOut_.fetch_add(n, std::memory_order_relaxed);
  }
  if (w < frames) memset(out + static_cast<size_t>(w) * static_cast<size_t>(ch), 0,
                         static_cast<size_t>(frames - w) * static_cast<size_t>(ch) * sizeof(float));
  deviceFrames_.fetch_add(frames, std::memory_order_relaxed);
  if (!graph_->events.empty()) Notifier::get().signal();
  int64_t t1 = monotonicNanos();
  double period = frames / static_cast<double>(sampleRate_) * 1e9;
  double inst = period > 0 ? static_cast<double>(t1 - t0) / period : 0;
  load_ = load_ * 0.95 + inst * 0.05;
  Graph::storeShared(&block_->shared[kSharedLoad], load_);
  renderBusy_.store(false, std::memory_order_release);
  // Output was paused while this callback ran: have the main thread service the queue.
  if (paused_.load(std::memory_order_relaxed)) Notifier::get().signal();
}

// ---- module -------------------------------------------------------------------------------------

uint32_t registerContext(Context* c) {
  Registry& r = registry();
  std::lock_guard<std::mutex> l(r.mu);
  uint32_t id = r.next++;
  r.map[id] = c;
  return id;
}

Context* findContext(uint32_t id) {
  Registry& r = registry();
  std::lock_guard<std::mutex> l(r.mu);
  auto it = r.map.find(id);
  return it == r.map.end() ? nullptr : it->second;
}

void destroyContext(uint32_t id) {
  Context* c = nullptr;
  {
    Registry& r = registry();
    std::lock_guard<std::mutex> l(r.mu);
    auto it = r.map.find(id);
    if (it == r.map.end()) return;
    c = it->second;
    r.map.erase(it);
  }
  delete c;
}

void forEachContext(void (*fn)(Context*, void*), void* arg) {
  Registry& r = registry();
  std::lock_guard<std::mutex> l(r.mu);
  for (auto& kv : r.map) fn(kv.second, arg);
}

void collectAllEvents(std::vector<OutEvent>& out) {
  std::vector<OutEvent>& m = mainEvents();
  for (auto& e : m) out.push_back(std::move(e));
  m.clear();
  std::vector<Context*> list;
  {
    Registry& r = registry();
    std::lock_guard<std::mutex> l(r.mu);
    for (auto& kv : r.map) list.push_back(kv.second);
  }
  for (Context* c : list) c->collect(out);
  std::vector<DecodeDone> done;
  collectDecodes(done);
  for (auto& d : done) {
    if (d.outcome.buffer) {
      uint32_t bid = BufferRegistry::get().add(d.outcome.buffer);
      out.push_back({kEvDecodeDone, d.ctx, d.requestId, static_cast<double>(bid), d.outcome.format});
    } else {
      out.push_back({kEvDecodeError, d.ctx, d.requestId, 0, d.outcome.error});
    }
  }
}

bool anyPendingWork() {
  if (!mainEvents().empty() || pendingDecodes() > 0) return true;
  Registry& r = registry();
  std::lock_guard<std::mutex> l(r.mu);
  for (auto& kv : r.map)
    if (kv.second->hasPendingWork()) return true;
  return false;
}

bool moduleShutDown() { return registry().shutDown.load(); }

// ---- public API (iwn/audio.h) -----------------------------------------------------------------

void setHostHooks(const HostHooks& hooks) { Notifier::get().setHooks(hooks); }

void setOutputPaused(uint32_t reason, bool paused) {
  Registry& r = registry();
  uint32_t now = paused ? (r.pausedReasons.fetch_or(reason) | reason)
                        : (r.pausedReasons.fetch_and(~reason) & ~reason);
  bool p = now != 0;
  forEachContext([](Context* c, void* arg) { c->setOutputPaused(*static_cast<bool*>(arg)); }, &p);
}

uint32_t outputPausedReasons() { return registry().pausedReasons.load(); }

void shutdown() {
  Registry& r = registry();
  if (r.shutDown.exchange(true)) return;
  forEachContext([](Context* c, void*) { c->stop(); }, nullptr);
  shutdownDecoders();
  Notifier::get().shutdown();
  // Free everything the runtime's pages created: the process may live on and host a new runtime
  // (a new activity in a cached process), which re-arms the module (rearmAfterShutdown).
  destroyAllContexts();
  BufferRegistry::get().clear();
  mainEvents().clear();
}

void destroyAllContexts() {
  std::vector<uint32_t> ids;
  forEachContext([](Context* c, void* arg) { static_cast<std::vector<uint32_t>*>(arg)->push_back(c->id()); }, &ids);
  for (uint32_t id : ids) destroyContext(id);
}

void rearmAfterShutdown() {
  Registry& r = registry();
  if (!r.shutDown.load()) return;
  restartDecoders();
  Notifier::get().restart();
  // Pause reasons belonged to the previous runtime's activity.
  r.pausedReasons.store(0);
  r.shutDown.store(false);
}

Stats stats() {
  Stats s{};
  Registry& r = registry();
  {
    std::lock_guard<std::mutex> l(r.mu);
    for (auto& kv : r.map) {
      Context* c = kv.second;
      if (c->offline()) {
        ++s.offlineContexts;
      } else {
        ++s.realtimeContexts;
        s.renderLoad = std::max(s.renderLoad, Graph::loadShared(&c->block()->shared[kSharedLoad]));
        s.xruns += c->xruns();
      }
      s.liveNodes += static_cast<uint32_t>(c->graph().activeNodeCount());
    }
  }
  s.liveBuffers = static_cast<uint32_t>(BufferRegistry::get().size());
  s.pendingDecodes = pendingDecodes();
  s.rtAllocations = rtAllocationCounter().load(std::memory_order_relaxed);
  s.paramEventsMerged = paramMergeCounter().load(std::memory_order_relaxed);
  return s;
}

}  // namespace iwn::audio
