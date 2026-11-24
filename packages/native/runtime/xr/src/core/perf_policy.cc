/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/xr/perf_policy.h"

#include <algorithm>

namespace iwn::xr {

const char* perf_level_name(PerfLevel level) {
  switch (level) {
    case PerfLevel::kUnset: return "default";
    case PerfLevel::kPowerSavings: return "power-savings";
    case PerfLevel::kSustainedLow: return "sustained-low";
    case PerfLevel::kSustainedHigh: return "sustained-high";
    case PerfLevel::kBoost: return "boost";
  }
  return "?";
}

PerfLevel parse_perf_level(std::string_view t, PerfLevel fallback) {
  if (t == "default" || t == "unset") return PerfLevel::kUnset;
  if (t == "power-savings") return PerfLevel::kPowerSavings;
  if (t == "sustained-low") return PerfLevel::kSustainedLow;
  if (t == "sustained-high") return PerfLevel::kSustainedHigh;
  if (t == "boost") return PerfLevel::kBoost;
  return fallback;
}

PerfPolicy::PerfPolicy(const PerfPolicyConfig& config)
    : config_(config), cpu_(config.cpu_start), gpu_(config.gpu_start), headroom_cur_ms_(config.headroom_ms) {
  config_.misses_to_raise = std::clamp(config_.misses_to_raise, 1, kMaxRing);
}

void PerfPolicy::restart_warmup(double now) {
  warmup_until_ms_ = now + config_.warmup_ms;
  miss_count_ = 0;
}

static int as_int(PerfLevel l) { return static_cast<int>(l); }

bool PerfPolicy::raise(bool cpu) {
  // Only the domain the misses point at: raising the other one would cost power without helping.
  if (cpu) {
    if (cpu_ != PerfLevel::kUnset && as_int(cpu_) >= as_int(config_.cpu_max)) return false;
    cpu_ = cpu_ == PerfLevel::kUnset ? PerfLevel::kSustainedHigh : static_cast<PerfLevel>(as_int(cpu_) + 1);
    last_raised_cpu_ = true;
    return true;
  }
  if (gpu_ == PerfLevel::kUnset) {
    gpu_ = config_.gpu_raise_from_default;
  } else {
    if (as_int(gpu_) >= as_int(config_.gpu_max)) return false;
    gpu_ = static_cast<PerfLevel>(as_int(gpu_) + 1);
  }
  last_raised_cpu_ = false;
  return true;
}

bool PerfPolicy::lower() {
  // Never below the start level; a domain that started at the runtime default stops at its floor (a level, once
  // set, cannot be handed back to the runtime through XR_EXT_performance_settings).
  auto lower_cpu = [&] {
    const PerfLevel floor = config_.cpu_start == PerfLevel::kUnset ? PerfLevel::kSustainedLow : config_.cpu_start;
    if (cpu_ == PerfLevel::kUnset || as_int(cpu_) <= as_int(floor)) return false;
    cpu_ = static_cast<PerfLevel>(as_int(cpu_) - 1);
    return true;
  };
  auto lower_gpu = [&] {
    const PerfLevel floor = config_.gpu_start == PerfLevel::kUnset ? config_.gpu_floor : config_.gpu_start;
    if (gpu_ == PerfLevel::kUnset || as_int(gpu_) <= as_int(floor)) return false;
    gpu_ = static_cast<PerfLevel>(as_int(gpu_) - 1);
    return true;
  };
  // Step back the domain raised last first.
  return last_raised_cpu_ ? (lower_cpu() || lower_gpu()) : (lower_gpu() || lower_cpu());
}

PerfPolicy::Change PerfPolicy::on_frame(double now, const Frame& f) {
  Change change;
  if (!config_.adaptive) return change;
  if (f.js_stalled) last_js_stall_ms_ = now;
  // Misses during the warm-up are a transient (session start, resume, rate switch), not a lack of clock.
  if (f.skipped > 0 && now >= warmup_until_ms_) {
    const bool js = f.js_stalled || now - last_js_stall_ms_ <= config_.js_stall_memory_ms ||
                    (f.period_ms > 0 && f.js_ms > config_.cpu_bound_ratio * f.period_ms);
    if (!js && f.skipped >= config_.stall_periods) {
      ++stalls_ignored_;  // a system stall: no clock level fixes it
    } else {
      miss_times_[miss_count_ % kMaxRing] = now;
      miss_cpu_[miss_count_ % kMaxRing] = js;
      ++miss_count_;
      last_miss_ms_ = now;
    }
  }
  if (miss_count_ >= config_.misses_to_raise && now - last_change_ms_ >= config_.cooldown_ms) {
    // The misses inside the window, newest first.
    int in_window = 0, cpu_misses = 0;
    double oldest = now, newest = now;
    const int stored = std::min(miss_count_, kMaxRing);
    for (int k = 1; k <= stored; ++k) {
      const int idx = (miss_count_ - k) % kMaxRing;
      if (now - miss_times_[idx] > config_.window_ms) break;
      if (in_window++ == 0) newest = miss_times_[idx];
      if (miss_cpu_[idx]) ++cpu_misses;
      oldest = miss_times_[idx];
    }
    const int gpu_misses = in_window - cpu_misses;
    const bool sustained = newest - oldest >= config_.min_span_ms || in_window == kMaxRing;
    if (in_window >= config_.misses_to_raise && sustained) {
      const bool cpu_bound = cpu_misses >= gpu_misses;
      if (cpu_bound || gpu_misses >= config_.misses_to_raise) {
        const PerfLevel cpu_before = cpu_, gpu_before = gpu_;
        if (raise(cpu_bound)) {
          change.cpu = cpu_ != cpu_before;
          change.gpu = gpu_ != gpu_before;
          change.reason = cpu_bound ? "missed frames, CPU-bound: JS frames late or near the display period"
                                    : "missed frames, GPU-bound: JS frames on time";
          // Relapse after a step down: wait longer before the next one.
          const double max_headroom = std::max(config_.max_headroom_ms, config_.headroom_ms);
          headroom_cur_ms_ = now - last_lower_ms_ <= config_.relapse_ms ? std::min(headroom_cur_ms_ * 2, max_headroom)
                                                                        : config_.headroom_ms;
          last_change_ms_ = now;
          miss_count_ = 0;
          ++raises_;
        }
        return change;
      }
    }
  }
  if (now - last_miss_ms_ >= headroom_cur_ms_ && now - last_change_ms_ >= headroom_cur_ms_) {
    const PerfLevel cpu_before = cpu_, gpu_before = gpu_;
    if (lower()) {
      change.cpu = cpu_ != cpu_before;
      change.gpu = gpu_ != gpu_before;
      change.reason = "sustained headroom";
      last_change_ms_ = now;
      last_lower_ms_ = now;
      ++lowers_;
    }
  }
  return change;
}

}  // namespace iwn::xr
