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
// baseline content; GPU left at the runtime's default) and adapts: when frames keep being missed it raises the domain
// the misses point at, and after sustained headroom it steps back toward the start. It never pins the maximum by
// default (boost is not used unless configured as the maximum).
//
// Each frame with missed display periods is one miss, attributed when it happens:
//   CPU     the JS thread explains it: the app's frame was late or never began (a long task, a GC pause), the JS
//           thread was in such a stall within js_stall_memory_ms, or the JS frame time is above cpu_bound_ratio
//           of the period;
//   GPU     the JS frames were on time and short, and the frame missed fewer than stall_periods periods (a GPU
//           that cannot finish a frame in one period misses one or two at a time, steadily);
//   stall   none of the above and stall_periods or more at once: a system stall (the compositor, a system
//           service), which no clock level fixes: not counted.
// A raise needs misses_to_raise misses within window_ms that are spread over at least min_span_ms (one burst, such
// as a single GC pause or a system hitch, is not a lack of clock), and goes to the domain with the most misses; the
// GPU is raised only when at least misses_to_raise of them are GPU misses. There is no GPU timer here: "GPU" means
// the frame loop and JS kept up while frames were still missed, steadily.
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
  int misses_to_raise = 3;        // missed frames (each with one or more missed periods) within window_ms to raise
  double window_ms = 1000;
  double min_span_ms = 500;       // ... spread over at least this long (a single burst is not sustained)
  int stall_periods = 4;          // a miss of this many periods at once, not explained by JS: a system stall
  double js_stall_memory_ms = 100;  // a miss this soon after a late or never-begun JS frame is the JS thread's
  double cooldown_ms = 2000;      // after a change, no further raise for this long (the level needs to take effect)
  double headroom_ms = 10000;     // no miss for this long: step down one level (never below the start)
  double cpu_bound_ratio = 0.8;   // JS frame time above this fraction of the period: a CPU miss
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

  struct Frame {
    int skipped = 0;         // display periods missed since the previous frame (FramePacing::observe)
    double js_ms = 0;        // the JS thread's time for the app frame collected in this frame (0: none)
    double period_ms = 0;    // display period
    bool js_stalled = false; // the app's frame was late or never began (JS in a long task or a GC pause)
  };
  // Once per displayed frame.
  Change on_frame(double now_ms, const Frame& frame);
  Change on_frame(double now_ms, int skipped, double js_ms, double period_ms) {
    return on_frame(now_ms, Frame{skipped, js_ms, period_ms, false});
  }
  // A session started or the app became visible again: misses during the next warmup_ms are ignored.
  void restart_warmup(double now_ms);

  PerfLevel cpu() const { return cpu_; }
  PerfLevel gpu() const { return gpu_; }
  const PerfPolicyConfig& config() const { return config_; }
  uint64_t raises() const { return raises_; }
  uint64_t lowers() const { return lowers_; }
  uint64_t stalls_ignored() const { return stalls_ignored_; }  // misses attributed to a system stall
  double headroom_ms() const { return headroom_cur_ms_; }

 private:
  // Enough for every miss of a window at 120 Hz with every other frame missed; a full ring inside the window is
  // sustained by itself.
  static constexpr int kMaxRing = 64;
  bool raise(bool cpu);
  bool lower();
  PerfPolicyConfig config_;
  PerfLevel cpu_;
  PerfLevel gpu_;
  double miss_times_[kMaxRing] = {};
  bool miss_cpu_[kMaxRing] = {};
  int miss_count_ = 0;  // misses recorded since the last raise or warm-up (ring index = count % ring)
  double last_js_stall_ms_ = -1e300;
  uint64_t stalls_ignored_ = 0;
  double last_miss_ms_ = -1e300;
  double last_change_ms_ = -1e300;
  double last_lower_ms_ = -1e300;
  double warmup_until_ms_ = -1e300;
  double headroom_cur_ms_ = 0;
  bool last_raised_cpu_ = true;
  uint64_t raises_ = 0;
  uint64_t lowers_ = 0;
};

}  // namespace iwn::xr
