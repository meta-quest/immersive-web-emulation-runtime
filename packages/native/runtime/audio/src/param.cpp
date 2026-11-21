// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
#include "param.h"

#include <algorithm>
#include <cmath>

namespace iwn::audio {

std::atomic<uint64_t>& rtAllocationCounter() {
  static std::atomic<uint64_t> c{0};
  return c;
}
std::atomic<uint64_t>& paramMergeCounter() {
  static std::atomic<uint64_t> c{0};
  return c;
}

namespace {
// setTargetAtTime is treated as having reached its target once the remaining distance is below
// float resolution (relative 1e-7, absolute floor 1e-10): the param then costs nothing per sample.
inline bool targetSettled(double remaining, float target) {
  return std::fabs(remaining) <= std::max(std::fabs(static_cast<double>(target)) * 1e-7, 1e-10);
}
bool isRamp(const ParamEvent& e) {
  return e.type == ParamEvent::LinearRamp || e.type == ParamEvent::ExpRamp;
}
void freeCurve(ParamEvent& e, Garbage* g) {
  if (!e.curve) return;
  if (e.curve->release_rt()) {
    if (g) g->dispose(e.curve);
    else e.curve->destroy();
  }
  e.curve = nullptr;
}
float curveValue(const ParamEvent& e, double t) {
  const BufferData* c = e.curve;
  size_t n = c ? c->length() : 0;
  if (n == 0) return e.value;
  const float* v = c->channel(0);
  if (t >= e.cutTime) return e.cutValue;
  if (t >= e.time + e.duration || e.duration <= 0) return v[n - 1];
  if (n == 1) return v[0];
  double pos = (t - e.time) / e.duration * static_cast<double>(n - 1);
  if (pos < 0) pos = 0;
  size_t k = static_cast<size_t>(pos);
  if (k >= n - 1) return v[n - 1];
  double frac = pos - static_cast<double>(k);
  return static_cast<float>(v[k] + (v[k + 1] - v[k]) * frac);
}
float rampValue(const ParamEvent& e, double t) {
  double t1 = e.time;
  if (t >= t1 || t1 <= e.t0) return e.value;
  double f = (t - e.t0) / (t1 - e.t0);
  if (f < 0) f = 0;
  if (e.type == ParamEvent::LinearRamp) return static_cast<float>(e.v0 + (e.value - e.v0) * f);
  // Exponential: hold V0 when V0 is 0 or the signs differ (spec), else V0 (V1/V0)^f.
  if (e.v0 == 0.f || (e.v0 < 0) != (e.value < 0)) return e.v0;
  return static_cast<float>(e.v0 * std::pow(static_cast<double>(e.value) / e.v0, f));
}
}  // namespace

ParamTimeline::ParamTimeline(float defaultValue, float minValue, float maxValue)
    : default_(defaultValue), min_(minValue), max_(maxValue), initial_(defaultValue) {
  events_.reserve(4);
  hint.publish(events_);
}

ParamTimeline::~ParamTimeline() {
  for (auto& e : events_) freeCurve(e, nullptr);
}

size_t ParamTimeline::upperBound(double t) const {
  // Events are sorted by time; cursor_ makes sequential sample queries O(1) amortised.
  size_t n = events_.size();
  size_t i = cursor_ <= n ? cursor_ : n;
  if (i > 0 && events_[i - 1].time > t) {
    auto it = std::upper_bound(events_.begin(), events_.end(), t,
                               [](double v, const ParamEvent& e) { return v < e.time; });
    i = static_cast<size_t>(it - events_.begin());
  } else {
    while (i < n && events_[i].time <= t) ++i;
  }
  cursor_ = i;
  return i;
}

double ParamTimeline::endTime(size_t k) const {
  const ParamEvent& e = events_[k];
  if (e.type == ParamEvent::SetCurve) return std::min(e.time + e.duration, e.cutTime);
  return e.time;
}

float ParamTimeline::endValue(size_t k) const {
  const ParamEvent& e = events_[k];
  if (e.type == ParamEvent::SetCurve) return curveValue(e, endTime(k));
  if (e.type == ParamEvent::SetTarget) return stateAt(k, e.time);
  return e.value;
}

float ParamTimeline::stateAt(size_t k, double t) const {
  const ParamEvent& e = events_[k];
  switch (e.type) {
    case ParamEvent::SetValue:
    case ParamEvent::LinearRamp:
    case ParamEvent::ExpRamp:
      return e.value;
    case ParamEvent::SetTarget: {
      if (e.timeConstant <= 0) return e.value;
      double dt = t - e.time;
      if (dt <= 0) return e.v0;
      double rem = (static_cast<double>(e.v0) - e.value) * std::exp(-dt / e.timeConstant);
      if (targetSettled(rem, e.value)) return e.value;
      return static_cast<float>(e.value + rem);
    }
    case ParamEvent::SetCurve:
      return curveValue(e, t);
  }
  return e.value;
}

void ParamTimeline::recompute(size_t from) {
  for (size_t k = from; k < events_.size(); ++k) computeOne(k);
}

void ParamTimeline::recomputeLocal(size_t from) {
  // Event k+1's derived start depends on event k's end state, which depends on k's own derived
  // fields only when k is a setTarget (its end value is its start value). So after the changed
  // event, the chain continues only through setTargets: O(1) per insert in practice, instead of
  // O(n) (three.js appends mid-list every frame).
  for (size_t k = from; k < events_.size(); ++k) {
    computeOne(k);
    if (k > from && events_[k].type != ParamEvent::SetTarget) break;
  }
}

void ParamTimeline::computeOne(size_t k) {
  {
    ParamEvent& e = events_[k];
    if (e.frozen) return;
    if (isRamp(e)) {
      if (k == 0) {
        e.t0 = e.insertTime;
        e.v0 = initial_;
      } else if (events_[k - 1].type == ParamEvent::SetTarget) {
        // The ramp replaces the setTarget from the later of its start and the call time.
        e.t0 = std::max(events_[k - 1].time, e.insertTime);
        e.v0 = stateAt(k - 1, e.t0);
      } else {
        e.t0 = endTime(k - 1);
        e.v0 = endValue(k - 1);
      }
    } else if (e.type == ParamEvent::SetTarget) {
      e.v0 = k == 0 ? initial_ : stateAt(k - 1, e.time);
    }
  }
}

float ParamTimeline::valueAt(double t) const {
  size_t next = upperBound(t);
  if (next < events_.size() && isRamp(events_[next])) {
    const ParamEvent& r = events_[next];
    if (t >= r.t0) return rampValue(r, t);
  }
  if (next == 0) return initial_;
  return stateAt(next - 1, t);
}

bool ParamTimeline::compute(double startTime, double dt, int n, float* out) {
  if (events_.empty()) {
    for (int i = 0; i < n; ++i) out[i] = initial_;
    return true;
  }
  // Constant fast path: last event fully in the past and not time-varying.
  double endT = startTime + dt * (n - 1);
  size_t next = upperBound(startTime);
  bool constant = false;
  if (next > 0) {
    const ParamEvent& prev = events_[next - 1];
    bool prevConstant =
        prev.type == ParamEvent::SetValue || isRamp(prev) ||
        (prev.type == ParamEvent::SetCurve && endTime(next - 1) <= startTime) ||
        (prev.type == ParamEvent::SetTarget &&
         (prev.timeConstant <= 0 ||
          (startTime > prev.time &&
           targetSettled((static_cast<double>(prev.v0) - prev.value) *
                             std::exp(-(startTime - prev.time) / prev.timeConstant),
                         prev.value))));
    bool nextOutside = next >= events_.size() ||
                       (events_[next].time > endT &&
                        !(isRamp(events_[next]) && events_[next].t0 <= endT));
    constant = prevConstant && nextOutside;
  } else {
    bool nextOutside = events_[0].time > endT && !(isRamp(events_[0]) && events_[0].t0 <= endT);
    constant = nextOutside;
  }
  if (constant) {
    float v = valueAt(startTime);
    for (int i = 0; i < n; ++i) out[i] = v;
    return true;
  }
  // Inside a linear ramp (three.js ramps every listener and panner param each frame): the same
  // formula as rampValue() without a search per sample, up to the ramp's end.
  int i = 0;
  if (next < events_.size() && events_[next].type == ParamEvent::LinearRamp && events_[next].t0 <= startTime) {
    const ParamEvent& r = events_[next];
    double span = r.time - r.t0;
    if (span > 0) {
      double dv = static_cast<double>(r.value - r.v0);  // as rampValue() rounds it
      double slope = dv / span;                          // within an ulp of rampValue()
      // stop: the first sample at or after the ramp's end (exact, so the loop below has no exit
      // test and vectorizes). t0 <= startTime, so t - t0 >= 0 for every sample.
      int stop = n;
      double last = startTime + dt * (n - 1);
      if (last >= r.time) {
        stop = std::max(0, std::min(n, static_cast<int>(std::ceil((r.time - startTime) / dt))));
        while (stop > 0 && startTime + dt * (stop - 1) >= r.time) --stop;
        while (stop < n && startTime + dt * stop < r.time) ++stop;
      }
      const double v0 = r.v0, t0 = r.t0;
      for (int k = 0; k < stop; ++k) out[k] = static_cast<float>(v0 + slope * ((startTime + dt * k) - t0));
      i = stop;
    }
  }
  for (; i < n; ++i) out[i] = valueAt(startTime + dt * i);
  return false;
}

void ParamTimeline::eraseFrom(size_t idx, Garbage* g) {
  for (size_t k = idx; k < events_.size(); ++k) freeCurve(events_[k], g);
  events_.erase(events_.begin() + static_cast<std::ptrdiff_t>(idx), events_.end());
  cursor_ = 0;
}

void ParamTimeline::insert(const ParamEvent& in, Garbage* g) {
  ParamEvent e = in;
  e.frozen = false;
  // Placed after events with the same time, before later ones (spec ordering rule).
  auto it = std::upper_bound(events_.begin(), events_.end(), e.time,
                             [](double v, const ParamEvent& x) { return v < x.time; });
  size_t idx = static_cast<size_t>(it - events_.begin());
  cursor_ = 0;
  if (idx > 0 && events_[idx - 1].time == e.time) {
    ParamEvent& prev = events_[idx - 1];
    // A setValueAtTime right after another one at the same time supersedes it with no observable
    // difference; overwrite so `param.value = x` in a loop does not grow the list.
    if (e.type == ParamEvent::SetValue && prev.type == ParamEvent::SetValue) {
      prev.value = e.value;
      recomputeLocal(idx - 1);
      return;
    }
    // Same for setTargetAtTime: the later one starts from the earlier one's start value (which has
    // zero duration), so replacing it is exact. IWSDK calls setTargetAtTime(v, currentTime, tc)
    // every frame during fades, which repeats the time while the context is suspended.
    if (e.type == ParamEvent::SetTarget && prev.type == ParamEvent::SetTarget) {
      if (prev.frozen) {
        e.v0 = prev.v0;
        e.frozen = true;
      }
      prev = e;
      recomputeLocal(idx - 1);
      return;
    }
  }
  if (events_.size() >= kMaxEvents) {
    // Bounded: replace the neighbour in time (keeps the order; never index 0, which may hold the
    // current state, unless it is the only choice).
    size_t r = idx >= 2 ? idx - 1 : std::min(idx, events_.size() - 1);
    freeCurve(events_[r], g);
    events_[r] = e;
    paramMergeCounter().fetch_add(1, std::memory_order_relaxed);
    recomputeLocal(r);
    return;
  }
  if (events_.size() == events_.capacity()) rtAllocationCounter().fetch_add(1, std::memory_order_relaxed);
  events_.insert(it, e);
  hint.publish(events_);
  recomputeLocal(idx);
}

void ParamTimeline::adoptStorage(std::vector<ParamEvent>& storage) {
  if (storage.capacity() <= events_.capacity() || storage.capacity() < events_.size()) return;
  storage.assign(events_.begin(), events_.end());  // fits: no allocation
  events_.swap(storage);
  cursor_ = 0;
  hint.publish(events_);
}

void ParamTimeline::cancelScheduledValues(double t, Garbage* g, double now) {
  float held = std::isnan(now) ? initial_ : valueAt(now);
  // Remove events with time >= t, and a curve still running at t.
  size_t keep = 0;
  while (keep < events_.size() && events_[keep].time < t) ++keep;
  if (keep > 0) {
    ParamEvent& last = events_[keep - 1];
    if (last.type == ParamEvent::SetCurve && last.time + last.duration > t) --keep;
  }
  eraseFrom(keep, g);
  // Nothing left before `now`: the param stays at the value it had instead of falling back to
  // its default (e.g. `value = 0.3; cancelScheduledValues(0)` keeps 0.3, as browsers do).
  if (!std::isnan(now) && (events_.empty() || events_[0].time > now)) initial_ = held;
  hint.publish(events_);
  recompute();
}

void ParamTimeline::cancelAndHoldAtTime(double t, Garbage* g) {
  float held = valueAt(t);
  size_t next = upperBound(t);
  if (next < events_.size() && isRamp(events_[next]) && events_[next].t0 <= t) {
    // A ramp in progress at t: truncate it so it ends at t with the value it has there.
    ParamEvent r = events_[next];
    eraseFrom(next, g);
    r.time = t;
    r.value = held;
    r.frozen = true;  // keep its start point, so the truncated ramp follows the original line
    events_.push_back(r);
    cursor_ = 0;
    return;
  }
  eraseFrom(next, g);
  if (next > 0) {
    ParamEvent& prev = events_[next - 1];
    if (prev.type == ParamEvent::SetTarget) {
      ParamEvent s;
      s.type = ParamEvent::SetValue;
      s.time = t;
      s.value = held;
      events_.push_back(s);
    } else if (prev.type == ParamEvent::SetCurve && t < prev.time + prev.duration) {
      prev.cutTime = t;
      prev.cutValue = held;
    }
  }
  cursor_ = 0;
  recompute();
}

void ParamTimeline::prune(double now, Garbage* g) {
  // Keep the last event at or before `now` (it defines the current state) and everything after.
  size_t firstFuture = upperBound(now);
  if (firstFuture < 2) return;
  size_t drop = firstFuture - 1;
  // The kept event's derived start point (ramp / setTarget) depends on the events being dropped:
  // freeze it. A running curve depends only on itself.
  events_[drop].frozen = true;
  for (size_t k = 0; k < drop; ++k) freeCurve(events_[k], g);
  events_.erase(events_.begin(), events_.begin() + static_cast<std::ptrdiff_t>(drop));
  cursor_ = 0;
  hint.publish(events_);
}

}  // namespace iwn::audio
