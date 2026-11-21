/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Environment depth for WebXR Depth Sensing (XR-DEPTH-2) over XR_META_environment_depth: one depth provider and its
// swapchain (a 2D array texture per image, one layer per eye), started when a session enables 'depth-sensing' and
// stopped when it ends; each WebXR frame acquires the newest image for the frame's predicted display time in the base
// space and hands it to JS through the depth record (iwn/xr/depth_record.h). XR thread only.
//
// The images are what Quest Browser hands a page for 'gpu-optimized' depth: a depth texture whose values are window
// depth for the depth view's own projection with near plane nearZ and (normally) an infinite far plane, so metres are
// nearZ / (1 - d), the formula IWSDK's occlusion shaders use. They are sampled with NEAREST filters (a depth texture
// with compare mode NONE and a LINEAR filter is incomplete in OpenGL ES 3.0, §3.8.13), set once on each image.
// Source: the XR_META_environment_depth specification (OpenXR registry) and Meta's OpenXR SDK samples' call sequence.
#pragma once

#include <cstdint>
#include <vector>

#include "iwn/core/json.h"
#include "iwn/xr/depth_record.h"
#include "iwn/xr/openxr_headers.h"
#include "iwn/xr/pacing.h"

namespace iwn::xr {

class EnvironmentDepth {
 public:
  // After xrCreateInstance: loads the entry points (the extension was enabled).
  void load(XrInstance instance);
  // Chains XrSystemEnvironmentDepthPropertiesMETA in front of `next` for xrGetSystemProperties.
  void* chain_properties(void* next);
  // After xrGetSystemProperties: whether the system offers depth (and hand removal).
  bool supported() const { return loaded_ && props_.supportsEnvironmentDepth == XR_TRUE; }
  bool hand_removal_supported() const { return supported() && props_.supportsHandRemoval == XR_TRUE; }
  bool running() const { return running_; }

  // Creates the provider and swapchain and starts the provider; false (logged) when the runtime refuses, e.g. without
  // com.oculus.permission.USE_SCENE.
  bool start(XrSession session, bool hand_removal);
  void stop();
  // The newest image for `time` in `space`, written into `record`; false (record marked invalid) when there is none
  // yet. Never blocks: XR_ENVIRONMENT_DEPTH_NOT_AVAILABLE_META until the provider produced its first image.
  bool acquire(XrSpace space, XrTime time, double* record);
  // Statistics: a copy the XR thread publishes under the system's stats lock (stats() runs on another thread), and
  // the periodic log line (the window since the previous one).
  struct Stats {
    bool supported = false, running = false, hand_removal = false;
    uint32_t width = 0, height = 0, images = 0;
    uint64_t acquired = 0, unavailable = 0, failed = 0;
    double acquire_ms = 0, acquire_max_ms = 0;
  };
  Stats stats() const;
  static Json stats_json(const Stats& s);
  void log_window(double window_ms);

 private:
  const char* result(XrResult r) const;

  XrInstance instance_ = XR_NULL_HANDLE;
  bool loaded_ = false;
  XrSystemEnvironmentDepthPropertiesMETA props_{XR_TYPE_SYSTEM_ENVIRONMENT_DEPTH_PROPERTIES_META};
  PFN_xrCreateEnvironmentDepthProviderMETA create_provider_ = nullptr;
  PFN_xrDestroyEnvironmentDepthProviderMETA destroy_provider_ = nullptr;
  PFN_xrStartEnvironmentDepthProviderMETA start_provider_ = nullptr;
  PFN_xrStopEnvironmentDepthProviderMETA stop_provider_ = nullptr;
  PFN_xrCreateEnvironmentDepthSwapchainMETA create_swapchain_ = nullptr;
  PFN_xrDestroyEnvironmentDepthSwapchainMETA destroy_swapchain_ = nullptr;
  PFN_xrEnumerateEnvironmentDepthSwapchainImagesMETA enumerate_images_ = nullptr;
  PFN_xrGetEnvironmentDepthSwapchainStateMETA get_swapchain_state_ = nullptr;
  PFN_xrAcquireEnvironmentDepthImageMETA acquire_image_ = nullptr;
  PFN_xrSetEnvironmentDepthHandRemovalMETA set_hand_removal_ = nullptr;

  XrEnvironmentDepthProviderMETA provider_ = XR_NULL_HANDLE;
  XrEnvironmentDepthSwapchainMETA swapchain_ = XR_NULL_HANDLE;
  std::vector<uint32_t> images_;
  uint32_t width_ = 0, height_ = 0;
  bool running_ = false;
  // Started inside the current frame (a command run after xrBeginFrame): the runtime refuses an acquire until the
  // next frame (XR_ERROR_CALL_ORDER_INVALID), so the first frame goes without.
  bool skip_acquire_ = false;
  bool hand_removal_ = false;
  DepthImage image_;

  // whole run (stats()) and the window since the last log line
  uint64_t acquired_ = 0, unavailable_ = 0, failed_ = 0;
  WindowStat acquire_ms_, log_acquire_ms_;
  uint64_t log_acquired_ = 0, log_unavailable_ = 0;
  bool first_logged_ = false;
};

}  // namespace iwn::xr
