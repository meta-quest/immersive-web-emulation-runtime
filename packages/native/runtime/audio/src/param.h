// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// AudioParam automation timeline (Web Audio API, "AudioParam" and "Computation of Value").
// Written from the spec's formulas: setValueAtTime, linear/exponential ramps (with the
// "hold until the end time" rule for exponential ramps from 0 or across zero), setTargetAtTime,
// setValueCurveAtTime, cancelScheduledValues and cancelAndHoldAtTime.
#pragma once

#include <atomic>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

#include "core.h"

namespace iwn::audio {

struct ParamEvent {
  enum Type : uint8_t { SetValue = 0, LinearRamp = 1, ExpRamp = 2, SetTarget = 3, SetCurve = 4 };
  Type type = SetValue;
  double time = 0;          // Event time (ramp: end time; curve: start time).
  float value = 0;          // Target / set value (curve: unused).
  double timeConstant = 0;  // SetTarget.
  double duration = 0;      // SetCurve.
  BufferData* curve = nullptr;  // SetCurve values (1 channel). Owned (one reference).
  double insertTime = 0;    // Context time when the call was made (ramp after setTarget / first ramp).
  double cutTime = std::numeric_limits<double>::infinity();  // cancelAndHold inside a curve.
  float cutValue = 0;
  // Derived by ParamTimeline::recompute().
  double t0 = 0;  // Ramp start time.
  float v0 = 0;   // Ramp start value / setTarget start value.
  bool frozen = false;  // Derived fields were fixed when earlier events were pruned.
};

// Size/capacity of a render-owned vector, published by the render thread so the main thread can
// hand over larger storage in a control batch before the render thread would have to grow it
// (AUD-10: the render thread does not allocate). The main-thread fields are touched only while a
// batch is prepared.
struct GrowHint {
  std::atomic<uint32_t> size{0};
  std::atomic<uint32_t> cap{0};
  uint32_t mainPending = 0;  // main: additions counted in the batch being prepared
  uint32_t mainGranted = 0;  // main: largest capacity handed over so far
  template <typename V>
  void publish(const V& v) {
    size.store(static_cast<uint32_t>(v.size()), std::memory_order_relaxed);
    cap.store(static_cast<uint32_t>(v.capacity()), std::memory_order_relaxed);
  }
};

// Render-thread push_back into a vector whose growth the main thread provides. Growing here is a
// fallback (counted in Stats::rtAllocations), not the normal path.
std::atomic<uint64_t>& rtAllocationCounter();
std::atomic<uint64_t>& paramMergeCounter();
template <typename V, typename T>
inline void rtPush(V& v, const T& x, GrowHint& h) {
  if (v.size() == v.capacity()) rtAllocationCounter().fetch_add(1, std::memory_order_relaxed);
  v.push_back(x);
  h.publish(v);
}

// Collects objects the audio thread must not free; drained on a non-realtime thread.
class Garbage {
 public:
  virtual ~Garbage() = default;
  virtual void dispose(BufferData* b) = 0;
};

class ParamTimeline {
 public:
  // Pending events per param. Beyond this the newest event replaces its neighbour in time
  // (counted in Stats::paramEventsMerged) instead of growing the list: a suspended context with
  // three.js-style per-frame ramps (currentTime frozen) would otherwise grow it forever.
  static constexpr size_t kMaxEvents = 512;

  ParamTimeline(float defaultValue, float minValue, float maxValue);
  ~ParamTimeline();

  float defaultValue() const { return default_; }
  float minValue() const { return min_; }
  float maxValue() const { return max_; }
  void setRange(float mn, float mx) {
    min_ = mn;
    max_ = mx;
  }

  // Inserts an event. Ownership of e.curve passes to the timeline.
  void insert(const ParamEvent& e, Garbage* g);
  // `now` = context time at which the cancel applies: with every earlier event removed the
  // param keeps the value it had (spec: the intrinsic value stays at its previous value).
  void cancelScheduledValues(double t, Garbage* g, double now = std::nan(""));
  void cancelAndHoldAtTime(double t, Garbage* g);

  // Value of the automation (no inputs, no clamping) at time t.
  float valueAt(double t) const;
  // Fills out[0..n) with the automation value at startTime + i*dt. Returns true when the value is
  // the same for all n samples (out is still fully written).
  bool compute(double startTime, double dt, int n, float* out);
  // Drops events that can no longer influence values at or after time `now`.
  void prune(double now, Garbage* g);
  bool hasEvents() const { return !events_.empty(); }
  size_t eventCount() const { return events_.size(); }
  size_t capacity() const { return events_.capacity(); }
  // Main thread, before the timeline is visible to the render thread.
  void reserve(size_t n) {
    if (n > events_.capacity()) events_.reserve(n);
    hint.publish(events_);
  }
  // Render thread: moves the events into `storage` (already reserved larger) and hands the old
  // storage back in `storage` for disposal on the main thread.
  void adoptStorage(std::vector<ParamEvent>& storage);
  GrowHint hint;

 private:
  void recompute(size_t from = 0);       // from `from` to the end
  void recomputeLocal(size_t from);      // `from` and the events whose start depends on it
  void computeOne(size_t k);
  float stateAt(size_t k, double t) const;  // State of event k for t >= its time.
  double endTime(size_t k) const;
  float endValue(size_t k) const;
  size_t upperBound(double t) const;  // First event with time > t.
  void eraseFrom(size_t idx, Garbage* g);

  float default_, min_, max_;
  float initial_;  // Value before any event.
  std::vector<ParamEvent> events_;
  mutable size_t cursor_ = 0;
};

}  // namespace iwn::audio
