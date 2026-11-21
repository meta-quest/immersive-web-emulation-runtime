// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Minimal host test harness (no dependencies).
#pragma once

#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

#include "graph.h"
#include "protocol.h"

// Sanitizer builds (ASan/UBSan/TSan) run several times slower and unevenly so: absolute timing
// budgets and speed ratios are only checked in plain builds.
#if defined(__SANITIZE_THREAD__) || defined(__SANITIZE_ADDRESS__)
#define IWN_TEST_SANITIZED 1
#elif defined(__has_feature)
#if __has_feature(thread_sanitizer) || __has_feature(address_sanitizer)
#define IWN_TEST_SANITIZED 1
#endif
#endif
#ifndef IWN_TEST_SANITIZED
#define IWN_TEST_SANITIZED 0
#endif

namespace iwntest {

struct Case {
  const char* name;
  std::function<void()> fn;
};
std::vector<Case>& cases();
struct Reg {
  Reg(const char* n, std::function<void()> f) { cases().push_back({n, std::move(f)}); }
};
extern int g_failures;
extern const char* g_current;

#define IWN_CAT2(a, b) a##b
#define IWN_CAT(a, b) IWN_CAT2(a, b)
#define TEST(name)                                                        \
  static void IWN_CAT(test_, name)();                                     \
  static ::iwntest::Reg IWN_CAT(reg_, name)(#name, IWN_CAT(test_, name)); \
  static void IWN_CAT(test_, name)()

#define CHECK(cond)                                                                       \
  do {                                                                                    \
    if (!(cond)) {                                                                        \
      std::fprintf(stderr, "  FAIL %s:%d [%s] %s\n", __FILE__, __LINE__, ::iwntest::g_current, #cond); \
      ++::iwntest::g_failures;                                                            \
    }                                                                                     \
  } while (0)

#define CHECK_NEAR(a, b, tol)                                                              \
  do {                                                                                     \
    double _a = (a), _b = (b);                                                             \
    if (!(std::fabs(_a - _b) <= (tol))) {                                                  \
      std::fprintf(stderr, "  FAIL %s:%d [%s] %s = %.9g, expected %.9g (tol %g)\n", __FILE__, \
                   __LINE__, ::iwntest::g_current, #a, _a, _b, static_cast<double>(tol));  \
      ++::iwntest::g_failures;                                                             \
    }                                                                                      \
  } while (0)

// Builds control batches for a Graph the way the JS layer does, and renders offline.
class Rig {
 public:
  explicit Rig(float sampleRate = 48000.f, int channels = 2)
      : params_(32768, 0.f),
        graph_(sampleRate, channels, shared_, params_.data(), 32768, 4096) {}
  ~Rig() {
    graph_.drainGarbage();
    for (uint32_t id : buffers_) iwn::audio::BufferRegistry::get().remove(id);
  }
  iwn::audio::Graph& graph() { return graph_; }
  float sampleRate() const { return graph_.sampleRate(); }

  uint32_t create(int type, int channelCount = 2, int mode = 0, int interp = 0, double opt0 = 0) {
    uint32_t id = nextId_++;
    int slot = nextSlot_;
    slots_[id] = slot;
    nextSlot_ += iwn::audio::proto::paramCount(type);
    w_.insert(w_.end(), {double(iwn::audio::proto::kCreateNode), double(id), double(type), double(slot),
                         double(channelCount), double(mode), double(interp), opt0, 0, 0, 0});
    return id;
  }
  int slot(uint32_t id, int param) { return slots_[id] + param; }
  void connect(uint32_t a, uint32_t b, int out = 0, int in = 0) {
    w_.insert(w_.end(), {double(iwn::audio::proto::kConnect), double(a), double(out), double(b), double(in)});
  }
  void connectParam(uint32_t a, int slot, int out = 0) {
    w_.insert(w_.end(), {double(iwn::audio::proto::kConnectParam), double(a), double(out), double(slot)});
  }
  void disconnect(uint32_t a, int out = -1, int dst = -1, int in = -1) {
    w_.insert(w_.end(), {double(iwn::audio::proto::kDisconnect), double(a), double(out), double(dst), double(in)});
  }
  void release(uint32_t id) { w_.insert(w_.end(), {double(iwn::audio::proto::kReleaseNode), double(id)}); }
  void setValue(int slot, double v, double t, double insertTime = 0) {
    event(slot, 0, t, v, 0, insertTime);
  }
  void event(int slot, int kind, double t, double v, double tcOrDur, double insertTime,
             const std::vector<double>& curve = {}) {
    w_.insert(w_.end(), {double(iwn::audio::proto::kParamEvent), double(slot), double(kind), t, v,
                         tcOrDur, insertTime, double(curve.size())});
    w_.insert(w_.end(), curve.begin(), curve.end());
  }
  void prop(uint32_t id, int prop, double v) {
    w_.insert(w_.end(), {double(iwn::audio::proto::kSetProp), double(id), double(prop), v});
  }
  void buffer(uint32_t id, uint32_t bufferId) {
    w_.insert(w_.end(), {double(iwn::audio::proto::kSetBuffer), double(id), double(bufferId)});
  }
  void start(uint32_t id, double when = 0, double offset = 0, double duration = -1) {
    w_.insert(w_.end(), {double(iwn::audio::proto::kStart), double(id), when, offset, duration});
  }
  void stop(uint32_t id, double when) {
    w_.insert(w_.end(), {double(iwn::audio::proto::kStop), double(id), when});
  }
  void raw(std::initializer_list<double> words) { w_.insert(w_.end(), words); }
  // Registers sample data as an AudioBuffer (as createBuffer + copyToChannel would).
  uint32_t makeBuffer(const std::vector<std::vector<float>>& chans, float rate = 0) {
    auto* b = iwn::audio::BufferData::create(int(chans.size()), chans[0].size(), rate > 0 ? rate : sampleRate());
    for (size_t c = 0; c < chans.size(); ++c)
      for (size_t i = 0; i < chans[c].size(); ++i) b->channel(int(c))[i] = chans[c][i];
    uint32_t id = iwn::audio::BufferRegistry::get().add(b);
    buffers_.push_back(id);
    return id;
  }
  void commit() {
    if (w_.empty()) return;
    auto* b = new iwn::audio::Batch();
    b->words = w_;
    b->seq = ++seq_;
    w_.clear();
    bool ok = graph_.prepare(*b);
    CHECK(ok);
    if (ok) graph_.pushBatch(b);
    else delete b;
  }
  // Prepares the pending words without expecting success (for malformed / hostile batches).
  bool tryCommit() {
    auto* b = new iwn::audio::Batch();
    b->words = w_;
    b->seq = ++seq_;
    w_.clear();
    bool ok = graph_.prepare(*b);
    if (ok) graph_.pushBatch(b);
    else delete b;
    return ok;
  }
  // Renders `quanta` quanta; returns per-channel output.
  std::vector<std::vector<float>> render(int quanta) {
    commit();
    int ch = graph_.destination()->channelCount;
    std::vector<std::vector<float>> out(static_cast<size_t>(ch));
    for (int q = 0; q < quanta; ++q) {
      graph_.applyPending();
      graph_.render();
      const auto& m = graph_.destination()->mixed();
      for (int c = 0; c < ch; ++c)
        for (int i = 0; i < iwn::audio::kQuantum; ++i)
          out[size_t(c)].push_back(m.silent() ? 0.f : m.channel(c)[i]);
      iwn::audio::GraphEvent e;
      while (graph_.events.pop(e)) events.push_back(e);
      graph_.drainGarbage();
    }
    return out;
  }
  std::vector<iwn::audio::GraphEvent> events;
  float paramValue(int slot) const { return params_[size_t(slot)]; }

 private:
  double shared_[iwn::audio::proto::kSharedCount] = {};
  std::vector<float> params_;
  iwn::audio::Graph graph_;
  std::vector<double> w_;
  uint32_t nextId_ = 2;
  int nextSlot_ = iwn::audio::proto::kListenerSlots;
  std::unordered_map<uint32_t, int> slots_;
  uint64_t seq_ = 0;
  std::vector<uint32_t> buffers_;
};

}  // namespace iwntest
