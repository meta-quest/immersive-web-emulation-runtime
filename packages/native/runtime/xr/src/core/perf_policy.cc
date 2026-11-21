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

bool PerfPolicy::raise(bool prefer_cpu) {
  auto try_cpu = [&] {
    if (cpu_ != PerfLevel::kUnset && as_int(cpu_) >= as_int(config_.cpu_max)) return false;
    cpu_ = cpu_ == PerfLevel::kUnset ? PerfLevel::kSustainedHigh : static_cast<PerfLevel>(as_int(cpu_) + 1);
    last_raised_cpu_ = true;
    return true;
  };
  auto try_gpu = [&] {
    if (gpu_ == PerfLevel::kUnset) {
      gpu_ = config_.gpu_raise_from_default;
      last_raised_cpu_ = false;
      return true;
    }
    if (as_int(gpu_) >= as_int(config_.gpu_max)) return false;
    gpu_ = static_cast<PerfLevel>(as_int(gpu_) + 1);
    last_raised_cpu_ = false;
    return true;
  };
  return prefer_cpu ? (try_cpu() || try_gpu()) : (try_gpu() || try_cpu());
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

PerfPolicy::Change PerfPolicy::on_frame(double now, int skipped, double cpu_ms, double period_ms) {
  Change change;
  if (period_ms > 0) ema_period_ms_ = ema_period_ms_ == 0 ? period_ms : ema_period_ms_ * 0.95 + period_ms * 0.05;
  if (cpu_ms > 0) ema_cpu_ms_ = ema_cpu_ms_ == 0 ? cpu_ms : ema_cpu_ms_ * 0.9 + cpu_ms * 0.1;
  if (!config_.adaptive) return change;
  if (now < warmup_until_ms_) skipped = 0;  // a transient (session start, resume), not a lack of clock
  for (int i = 0; i < skipped && i < kMaxRing; ++i) {
    miss_times_[miss_count_ % kMaxRing] = now;
    ++miss_count_;
  }
  if (skipped > 0) last_miss_ms_ = now;
  const int n = config_.misses_to_raise;
  if (miss_count_ >= n && now - last_change_ms_ >= config_.cooldown_ms) {
    const double oldest = miss_times_[(miss_count_ - n) % kMaxRing];
    if (now - oldest <= config_.window_ms) {
      const PerfLevel cpu_before = cpu_, gpu_before = gpu_;
      const bool cpu_bound = ema_period_ms_ > 0 && ema_cpu_ms_ > config_.cpu_bound_ratio * ema_period_ms_;
      if (raise(cpu_bound)) {
        change.cpu = cpu_ != cpu_before;
        change.gpu = gpu_ != gpu_before;
        change.reason = cpu_bound ? "missed frames, CPU-bound" : "missed frames, GPU-bound";
        // Relapse after a step down: wait longer before the next one.
        headroom_cur_ms_ = now - last_lower_ms_ <= config_.relapse_ms
                               ? std::min(headroom_cur_ms_ * 2, std::max(config_.max_headroom_ms, config_.headroom_ms))
                               : config_.headroom_ms;
        last_change_ms_ = now;
        miss_count_ = 0;
        ++raises_;
      }
      return change;
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
