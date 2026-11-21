/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Frame timing helpers, V8-free (docs/spec/08 XR-LOOP-4/5, docs/spec/15 PERF-JS-3, LOG-3).
#pragma once

#include <cstdint>

namespace iwn::xr {

// OpenXR XrTime (nanoseconds on the runtime's clock) <-> the performance.now() clock (ms, TMR-4). Calibrated from
// one simultaneous sample of both clocks (XR_KHR_convert_timespec_time on CLOCK_MONOTONIC, or XrTime taken as
// CLOCK_MONOTONIC nanoseconds when that extension is missing, which is what Android runtimes use).
class XrClock {
 public:
  void calibrate(double perf_now_ms, int64_t xr_now_ns) {
    perf_at_ = perf_now_ms;
    xr_at_ = xr_now_ns;
    calibrated_ = true;
  }
  bool calibrated() const { return calibrated_; }
  double to_perf_ms(int64_t xr_ns) const { return perf_at_ + static_cast<double>(xr_ns - xr_at_) / 1e6; }
  int64_t to_xr_ns(double perf_ms) const { return xr_at_ + static_cast<int64_t>((perf_ms - perf_at_) * 1e6); }

 private:
  double perf_at_ = 0;
  int64_t xr_at_ = 0;
  bool calibrated_ = false;
};

// Watches xrWaitFrame's predicted display times: periods skipped between consecutive frames (missed frames, the
// input of the perf-level policy) and a strictly increasing millisecond value for the frame record (XR-LOOP-5).
class FramePacing {
 public:
  // Returns how many display periods were skipped since the previous frame (0 when on time, and for the first).
  int observe(int64_t predicted_ns, int64_t period_ns);
  uint64_t frames() const { return frames_; }
  uint64_t missed() const { return missed_; }
  // Returns `ms`, or a value just above the previous one if `ms` would not increase.
  double strictly_increasing(double ms);
  void reset() {
    last_predicted_ = 0;
    last_ms_ = -1e300;
  }

 private:
  int64_t last_predicted_ = 0;
  double last_ms_ = -1e300;
  uint64_t frames_ = 0;
  uint64_t missed_ = 0;
};

// PERF-JS-3: the between-frame task budget is the predicted slack minus 1 ms, clamped to [min_ms, max_ms].
double task_budget_ms(double now_ms, double next_frame_ms, double min_ms = 1.0, double max_ms = 8.0);

// Averages of per-frame durations over a stats window (LOG-3, DBG-STATS): count, mean, max.
class WindowStat {
 public:
  void add(double v) {
    sum_ += v;
    if (v > max_) max_ = v;
    ++n_;
  }
  double mean() const { return n_ ? sum_ / static_cast<double>(n_) : 0.0; }
  double max() const { return max_; }
  uint64_t count() const { return n_; }
  void reset() {
    sum_ = 0;
    max_ = 0;
    n_ = 0;
  }

 private:
  double sum_ = 0;
  double max_ = 0;
  uint64_t n_ = 0;
};

}  // namespace iwn::xr
