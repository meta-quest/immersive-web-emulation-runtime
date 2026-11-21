/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/xr/frame_record.h"

#include <cstdlib>
#include <cstring>
#include <new>

namespace iwn::xr {

static_assert(layout::kBytes % layout::kAlign == 0, "record size is a multiple of its alignment");
static_assert(layout::kLayoutVersion == 0, "XRF-4: the record starts with its layout version");
static_assert(layout::kViewsCount == 22, "two views of 11 floats (HOST_VIEW_STRIDE)");
static_assert(layout::kJointsCount == 25 * 8, "HOST-INPUT: 25 joints x 8 floats");
static_assert(layout::kPredictedDisplayTime % 8 == 0, "f64 fields are 8-byte aligned");

FrameRecord::FrameRecord() {
  data_ = static_cast<uint8_t*>(std::aligned_alloc(layout::kAlign, layout::kBytes));
  if (!data_) throw std::bad_alloc();
  std::memset(data_, 0, layout::kBytes);
  set_u32(layout::kLayoutVersion, layout::kVersion);
  write_identity_pose(layout::kLocalPose);
  write_identity_pose(layout::kViewerPose);
  write_identity_pose(layout::kGazePose);
  for (int v = 0; v < 2; ++v) {
    XrPosef identity{{0, 0, 0, 1}, {0, 0, 0}};
    XrFovf fov{-0.785398f, 0.785398f, 0.785398f, -0.785398f};
    write_view(v, identity, fov);
  }
  set_f32(layout::kViewportScale, 1.0f);
  set_f32(layout::kViewportScale + 4, 1.0f);
  clear_hand(0);
  clear_hand(1);
}

FrameRecord::~FrameRecord() { std::free(data_); }

void FrameRecord::write_pose(size_t off, const XrPosef& pose) {
  float* f = at<float>(off);
  f[0] = pose.position.x;
  f[1] = pose.position.y;
  f[2] = pose.position.z;
  f[3] = pose.orientation.x;
  f[4] = pose.orientation.y;
  f[5] = pose.orientation.z;
  f[6] = pose.orientation.w;
}

void FrameRecord::write_identity_pose(size_t off) {
  float* f = at<float>(off);
  f[0] = f[1] = f[2] = 0.0f;
  f[3] = f[4] = f[5] = 0.0f;
  f[6] = 1.0f;
}

void FrameRecord::write_view(int index, const XrPosef& pose, const XrFovf& fov) {
  const size_t off = layout::kViews + static_cast<size_t>(index) * 11 * sizeof(float);
  write_pose(off, pose);
  float* f = at<float>(off) + 7;
  f[0] = fov.angleLeft;
  f[1] = fov.angleRight;
  f[2] = fov.angleUp;
  f[3] = fov.angleDown;
}

void FrameRecord::write_header(bool should_render, bool base_is_stage, uint32_t view_count, uint32_t color_texture,
                               uint32_t image_array_size, double predicted_display_ms, double frame_start_ms,
                               double display_period_ms, float frame_rate, float foveation) {
  uint32_t flags = 0;
  if (should_render) flags |= kFlagShouldRender;
  if (base_is_stage) flags |= kFlagBaseIsStage;
  set_u32(layout::kFlags, flags);
  set_u32(layout::kViewCount, view_count);
  set_u32(layout::kColorTexture, color_texture);
  set_u32(layout::kImageArraySize, image_array_size);
  set_f64(layout::kPredictedDisplayTime, predicted_display_ms);
  set_f64(layout::kFrameStartTime, frame_start_ms);
  set_f64(layout::kDisplayPeriod, display_period_ms);
  set_f32(layout::kFrameRate, frame_rate);
  set_f32(layout::kFoveation, foveation);
}

uint32_t FrameRecord::next_serial() {
  ++serial_;
  set_u32(layout::kFrameSerial, serial_);
  return serial_;
}

void FrameRecord::clear_hand(int hand) {
  set_u32(layout::kInputMode[hand], 0);
  set_u32(layout::kInputFlags[hand], 0);
  set_u32(layout::kInputProfile[hand], 0);
  write_identity_pose(layout::kTargetRay[hand]);
  write_identity_pose(layout::kGrip[hand]);
  write_identity_pose(layout::kPalm[hand]);
  std::memset(at<float>(layout::kButtonValues[hand]), 0, layout::kButtonValuesCount * sizeof(float));
  std::memset(at<float>(layout::kAxes[hand]), 0, layout::kAxesCount * sizeof(float));
  float* joints = at<float>(layout::kJoints[hand]);
  std::memset(joints, 0, layout::kJointsCount * sizeof(float));
  for (int j = 0; j < 25; ++j) joints[j * 8 + 6] = 1.0f;
  std::memset(at<uint8_t>(layout::kButtonPressed[hand]), 0, layout::kButtonPressedCount);
  std::memset(at<uint8_t>(layout::kButtonTouched[hand]), 0, layout::kButtonTouchedCount);
  std::memset(at<uint8_t>(layout::kJointValid[hand]), 0, layout::kJointValidCount);
}

}  // namespace iwn::xr
