#include "iwn/core/clock.h"

#include <ctime>
#include <mutex>

namespace iwn {
namespace {

struct ClockZero {
  int64_t mono_ns;
  double epoch_ms;
};

ClockZero make_zero() {
  timespec mono{}, real{};
  clock_gettime(CLOCK_MONOTONIC, &mono);
  clock_gettime(CLOCK_REALTIME, &real);
  return {static_cast<int64_t>(mono.tv_sec) * 1000000000LL + mono.tv_nsec,
          static_cast<double>(real.tv_sec) * 1000.0 + static_cast<double>(real.tv_nsec) / 1e6};
}

const ClockZero& zero() {
  static const ClockZero z = make_zero();
  return z;
}

}  // namespace

int64_t monotonic_ns() {
  timespec ts{};
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<int64_t>(ts.tv_sec) * 1000000000LL + ts.tv_nsec;
}

void init_clock() { (void)zero(); }

double now_ms() { return static_cast<double>(monotonic_ns() - zero().mono_ns) / 1e6; }

double time_origin_ms() { return zero().epoch_ms; }

}  // namespace iwn
