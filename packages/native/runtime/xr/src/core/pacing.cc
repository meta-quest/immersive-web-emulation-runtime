/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/xr/pacing.h"

#include <cmath>

namespace iwn::xr {

int FramePacing::observe(int64_t predicted_ns, int64_t period_ns) {
  ++frames_;
  int skipped = 0;
  if (last_predicted_ != 0 && period_ns > 0 && predicted_ns > last_predicted_) {
    const double periods = static_cast<double>(predicted_ns - last_predicted_) / static_cast<double>(period_ns);
    const long steps = std::lround(periods);
    if (steps > 1) skipped = static_cast<int>(steps - 1);
  }
  last_predicted_ = predicted_ns;
  missed_ += static_cast<uint64_t>(skipped);
  return skipped;
}

double FramePacing::strictly_increasing(double ms) {
  if (!(ms > last_ms_)) ms = std::nextafter(last_ms_, INFINITY) + 1e-6;
  last_ms_ = ms;
  return ms;
}

double task_budget_ms(double now_ms, double next_frame_ms, double min_ms, double max_ms) {
  double slack = next_frame_ms - now_ms - 1.0;
  if (!(slack > min_ms)) return min_ms;
  return slack < max_ms ? slack : max_ms;
}

}  // namespace iwn::xr
