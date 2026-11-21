/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The `xr` section of assets/iwn/config.json (written by the packer from iwsdk.config.json's native section, PKG-CFG)
// and the fixed-foveation level mapping (XR-FOV-1). V8-free.
//
//   "xr": {
//     "frameRate": 90,                      // XR-RATE-1 / XR-LIFE-6: requested at session start; 0 = runtime default
//     "foveation": "medium",                // or 0..1, or {"level": "medium", "dynamic": true}; XR-FOV-1 default
//     "grant": "auto",                      // XR-LIFE-2: "explicit" holds offerSession until __iwnXR.grantSession()
//     "endGraceMs": 2000,                   // XR-LIFE-5 (open question 11); < 0 never exits
//     "neverOffered": {"errorMs": 10000, "exitMs": 30000},   // XR-LIFE-7
//     "perf": {"cpu": "sustained-low", "gpu": "default", "cpuMax": "sustained-high", "gpuMax": "sustained-high",
//              "adaptive": true},           // XR-PERF-1
//     "eyeBufferScale": 1.0,                // multiplies the runtime's recommended eye-buffer size (XR-SC-1)
//     "colorSpace": "rec709",               // XR_FB_color_space (XR-LIFE-6); "" leaves the runtime default
//     "frameDeadlinePeriods": 1.0,          // how long the XR thread waits for a JS frame before re-submitting
//     "disableExtensions": [],              // XR-INIT-1 debug switch, debuggable builds only
//     "immersiveAr": false,                 // XR-AR-1 (later milestone): opt in to immersive-ar over passthrough
//     "loading": {...},                     // the loading screen before the first WebXR frame (iwn/xr/loading.h)
//     "features": {...}                     // the packer's record of declared manifest features (not used here)
//   },
//   "stats": {"logIntervalMs": 2000}         // LOG-3 periodic line (shared with the core)
#pragma once

#include <string>
#include <string_view>
#include <vector>

#include "iwn/core/json.h"
#include "iwn/xr/loading.h"
#include "iwn/xr/perf_policy.h"
#include "iwn/xr/session_policy.h"

namespace iwn::xr {

enum class FoveationLevel : int { kNone = 0, kLow = 1, kMedium = 2, kHigh = 3 };

// WebXR fixedFoveation 0..1 -> level: round(value * 3) (0, 1/3, 2/3, 1 are exact); NaN -> none.
FoveationLevel foveation_level_for(double fixed_foveation);
// The 0..1 value a level reports back (0, 1/3, 2/3, 1).
double foveation_value_for(FoveationLevel level);
const char* foveation_level_name(FoveationLevel level);
// "none" | "low" | "medium" | "high"; false when unknown.
bool parse_foveation_level(std::string_view text, FoveationLevel* out);

// QCOM_texture_foveated settings for a fixed foveation level, applied by the runtime from the context that renders
// into the swapchain (xr_system.cc, "Foveation"). With the extension's density function
// density = max(minDensity, 1 / max(1, (dx * gain)^2 + (dy * gain)^2 - area)), dx/dy in NDC from the focal point,
// full density reaches out to sqrt(1 + area) / gain. Our own choice (documented in runtime/xr/README.md): low keeps
// full density within 0.5 NDC of the focal point and never drops below 1/2, medium within 0.33 and high within 0.25,
// both down to 1/4 (the minimum the OpenXR runtime itself sets for those two levels on Quest 3S). none: gain 0,
// full density everywhere.
struct FoveationParams {
  float gain = 0;
  float area = 0;
  float min_density = 1;
};
FoveationParams foveation_params_for(FoveationLevel level);
// Where an eye looks straight ahead in an image rendered with an asymmetric OpenXR FOV: the projection centre in NDC
// (-1..1, +y up), i.e. view direction (0, 0, -1) through the OpenXR/GL frustum of the four angles (radians).
void foveation_focal_point(float angle_left, float angle_right, float angle_up, float angle_down, float* x, float* y);

struct XrConfig {
  double frame_rate = 0;
  // immersive-ar over XR_FB_passthrough (XR-AR-1, a later milestone): off unless the config opts in, so the alpha's
  // isSessionSupported('immersive-ar') is false and requestSession('immersive-ar') rejects with NotSupportedError.
  bool immersive_ar = false;
  double foveation = -1;  // < 0: not configured (the app's request or none)
  bool foveation_dynamic = false;
  bool explicit_grant = false;
  LifePolicyConfig life;
  PerfPolicyConfig perf;
  double eye_buffer_scale = 1.0;
  std::string color_space = "rec709";
  double frame_deadline_periods = 1.0;
  double stats_interval_ms = 0;
  std::vector<std::string> disabled_extensions;
  LoadingConfig loading;
};

// Reads `xr` and `stats` from the whole runtime config; unknown keys and wrong types become warnings.
XrConfig parse_xr_config(const Json& root, std::vector<std::string>* warnings);

}  // namespace iwn::xr
