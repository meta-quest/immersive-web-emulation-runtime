/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Counters the GL module keeps natively (JS thread only, no atomics). Exposed to JS through the
// `stats` native as a Float64Array in this field order (see web/webgl/stats.ts).
#pragma once

#include <cstdint>

namespace iwn::gl {

struct GlStats {
  double nativeCalls = 0;        // JS -> native transitions into the GL module (fast + slow)
  double rejected = 0;           // natives skipped by a bounds / null-entry check (JS should have caught it)
  double getErrorCalls = 0;      // glGetError issued on behalf of the app (GL-10)
  double syncQueries = 0;        // natives that returned driver state synchronously (GL-21 counting)
  double programInfoCalls = 0;   // reflection records built (one per linked program)
  double shaderInfoCalls = 0;    // shader status + log fetches
  double reflectionGlCalls = 0;  // GLES queries made internally to build reflection records (reported only)
  double contextSwitches = 0;    // eglMakeCurrent calls
  double zeroInits = 0;          // GL-3 zero-initialisations performed
  double multiDrawSubDraws = 0;  // sub-draws issued by multi-draw natives
};

inline constexpr int kGlStatsFields = sizeof(GlStats) / sizeof(double);

GlStats& Stats();

}  // namespace iwn::gl
