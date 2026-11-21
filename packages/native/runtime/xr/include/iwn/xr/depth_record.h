/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The depth record (XR-DEPTH-2): what the XR thread hands the JS thread about each frame's environment depth image,
// next to the frame record but in a buffer of its own (the frame record's layout stays as it is). V8-free and
// OpenXR-call-free, so the writer is host-tested. web/xr's depth.ts reads it with the same layout (kDepthVersion).
//
// Doubles, so GL names and +inf far planes need no packing. The XR thread writes it in the same window as the frame
// record (after the image is acquired, before the frame is posted, never while a JS frame is in flight), so a frame's
// JS always reads the depth of its own frame.
#pragma once

#include <cstddef>
#include <cstdint>

#include "iwn/xr/openxr_headers.h"

namespace iwn::xr {

namespace depth_layout {
constexpr uint32_t kDepthVersion = 1;
constexpr size_t kVersion = 0;     // kDepthVersion
constexpr size_t kValid = 1;       // 1: the frame has a depth image; 0: none (not started, not available yet)
constexpr size_t kTexture = 2;     // GL name of the swapchain image: a 2D array texture, layer i = view i
constexpr size_t kWidth = 3;       // one layer, pixels
constexpr size_t kHeight = 4;
constexpr size_t kNear = 5;        // metres
constexpr size_t kFar = 6;         // metres, +inf for an infinite far plane
constexpr size_t kViews = 7;       // 2 x 11: position xyz, orientation xyzw, FOV left right up down (as XRF views)
constexpr size_t kViewStride = 11;
constexpr size_t kAcquireMs = kViews + 2 * kViewStride;  // what xrAcquireEnvironmentDepthImageMETA cost this frame
constexpr size_t kSerial = kAcquireMs + 1;               // counts images handed over (diagnostics)
constexpr size_t kCount = kSerial + 1;
}  // namespace depth_layout

// One acquired image, as XR_META_environment_depth reports it, with the GL name of its swapchain image.
struct DepthImage {
  uint32_t texture = 0;
  uint32_t width = 0, height = 0;
  float near_z = 0, far_z = 0;
  XrPosef pose[2];
  XrFovf fov[2];
};

// Writes `image` into `record` (depth_layout::kCount doubles) as valid.
void write_depth_record(double* record, const DepthImage& image, double acquire_ms);
// Marks the frame as having no depth image (the rest stays as it was).
void clear_depth_record(double* record, double acquire_ms);

}  // namespace iwn::xr
