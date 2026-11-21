/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The JS clock (TMR-4): milliseconds since the process's JS clock zero on CLOCK_MONOTONIC, as a double. Timers,
// window rAF time and performance.now() all use it. time_origin_ms() is the Unix-epoch time of that zero.
#pragma once

#include <cstdint>

namespace iwn {

// Monotonic milliseconds since clock zero (first call in the process, or init_clock()).
double now_ms();
// Unix-epoch milliseconds of clock zero.
double time_origin_ms();
// Fixes clock zero now (called once at process start so boot marks are measured from it).
void init_clock();
// Raw CLOCK_MONOTONIC in nanoseconds (for deadlines).
int64_t monotonic_ns();

}  // namespace iwn
