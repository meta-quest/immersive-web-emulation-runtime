/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CPU/GPU performance levels (docs/spec/08 XR-PERF-1/2, docs/spec/15 PERF-LVL-1), V8-free.
//
// Levels are XR_EXT_performance_settings' (power savings, sustained low, sustained high, boost). The policy starts
// at the configured levels (default: CPU sustained low, the level that gives Quest Browser's CPU level 2 for the
// baseline content; GPU left at the runtime's default) and adapts: when frames are missed it raises the domain that
// looks limiting (CPU when the main thread's frame time is close to the display period, else GPU), and after
// sustained headroom it steps back toward the start. It never pins the maximum by default (boost is not used unless
// configured as the maximum).
#pragma once

#include <cstdint>
#include <string_view>

namespace iwn::xr {

enum class PerfLevel : int { kUnset = -1, kPowerSavings = 0, kSustainedLow = 1, kSustainedHigh = 2, kBoost = 3 };

const char* perf_level_name(PerfLevel level);
// "power-savings" | "sustained-low" | "sustained-high" | "boost" | "default"; `fallback` when unknown.
PerfLevel parse_perf_level(std::string_view text, PerfLevel fallback);

struct PerfPolicyConfig {
  PerfLevel cpu_start = PerfLevel::kSustainedLow;
  PerfLevel gpu_start = PerfLevel::kUnset;  // runtime default until the policy has to raise it
  PerfLevel cpu_max = PerfLevel::kSustainedHigh;
  PerfLevel gpu_max = PerfLevel::kSustainedHigh;
  // First explicit GPU level when raising from the runtime default, and the floor when stepping back down.
  PerfLevel gpu_raise_from_default = PerfLevel::kSustainedHigh;
  PerfLevel gpu_floor = PerfLevel::kSustainedLow;
  bool adaptive = true;
  int misses_to_raise = 3;        // missed display periods within window_ms that trigger a raise
  double window_ms = 1000;
  double cooldown_ms = 2000;      // after a change, no further raise for this long (the level needs to take effect)
  double headroom_ms = 10000;     // no miss for this long: step down one level (never below the start)
  double cpu_bound_ratio = 0.8;   // main-thread frame time above this fraction of the period: CPU-bound
  // Misses in the first moments of a session or after the app becomes visible again (first-frame compiles and
  // uploads, the compositor resuming) are a transient, not a lack of clock: they are not counted.
  double warmup_ms = 3000;
  // A raise soon after a step down means the lower level was too low for this content: the headroom needed before
  // the next step down doubles (up to max_headroom_ms), so the levels do not oscillate. A raise later than
  // relapse_ms after a step down starts over from headroom_ms.
  double relapse_ms = 30000;
  double max_headroom_ms = 300000;
};

class PerfPolicy {
 public:
  explicit PerfPolicy(const PerfPolicyConfig& config = {});

  struct Change {
    bool cpu = false;
    bool gpu = false;
    const char* reason = "";
    bool any() const { return cpu || gpu; }
  };

  // Once per displayed frame. `skipped`: display periods missed since the previous frame (FramePacing::observe);
  // `cpu_ms`: the main thread's time for the frame (0 when no app frame ran); `period_ms`: display period.
  Change on_frame(double now_ms, int skipped, double cpu_ms, double period_ms);
  // A session started or the app became visible again: misses during the next warmup_ms are ignored.
  void restart_warmup(double now_ms);

  PerfLevel cpu() const { return cpu_; }
  PerfLevel gpu() const { return gpu_; }
  const PerfPolicyConfig& config() const { return config_; }
  uint64_t raises() const { return raises_; }
  uint64_t lowers() const { return lowers_; }
  double headroom_ms() const { return headroom_cur_ms_; }

 private:
  static constexpr int kMaxRing = 16;
  bool raise(bool prefer_cpu);
  bool lower();
  PerfPolicyConfig config_;
  PerfLevel cpu_;
  PerfLevel gpu_;
  double miss_times_[kMaxRing] = {};
  int miss_count_ = 0;  // total misses recorded (ring index = count % ring)
  double last_miss_ms_ = -1e300;
  double last_change_ms_ = -1e300;
  double last_lower_ms_ = -1e300;
  double warmup_until_ms_ = -1e300;
  double headroom_cur_ms_ = 0;
  double ema_cpu_ms_ = 0;
  double ema_period_ms_ = 0;
  bool last_raised_cpu_ = true;
  uint64_t raises_ = 0;
  uint64_t lowers_ = 0;
};

}  // namespace iwn::xr
