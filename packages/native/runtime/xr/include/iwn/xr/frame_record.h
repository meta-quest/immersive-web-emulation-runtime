/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The XR frame record (docs/spec/09, XRF-1..7), V8-free. One block of native memory, allocated once per process,
// that the XR thread writes before each XR frame and JS reads in place through typed-array views over an
// ArrayBuffer with an external backing store (the V8 sandbox is off). Offsets come from the generated layout
// (layout/frame-record.json, XRF-4). Poses and FOVs are float32: a position 50 m from the origin keeps a step of
// ~4 µm (XRF-5); times are float64 milliseconds on the performance.now() clock.
//
// Threading: the writer and the reader never overlap: the XR thread writes only while no JS frame is in flight and
// hands the frame over with a release/acquire handshake (src/android/frame_slot.h).
#pragma once

#include <cstddef>
#include <cstdint>

#include "iwn/xr/frame_record_layout.gen.h"
#include "iwn/xr/openxr_headers.h"

namespace iwn::xr {

enum RecordFlags : uint32_t {
  kFlagShouldRender = 1u << 0,
  kFlagBaseIsStage = 1u << 1,
};

enum InputFlags : uint32_t {
  kInputTargetRayValid = 1u << 0,
  kInputGripValid = 1u << 1,
  kInputPalmValid = 1u << 2,
};

class FrameRecord {
 public:
  FrameRecord();
  ~FrameRecord();
  FrameRecord(const FrameRecord&) = delete;
  FrameRecord& operator=(const FrameRecord&) = delete;

  uint8_t* data() { return data_; }
  const uint8_t* data() const { return data_; }
  static constexpr size_t size() { return layout::kBytes; }

  template <typename T>
  T* at(size_t byte_offset) {
    return reinterpret_cast<T*>(data_ + byte_offset);
  }
  template <typename T>
  const T* at(size_t byte_offset) const {
    return reinterpret_cast<const T*>(data_ + byte_offset);
  }

  void set_u32(size_t off, uint32_t v) { *at<uint32_t>(off) = v; }
  void set_f32(size_t off, float v) { *at<float>(off) = v; }
  void set_f64(size_t off, double v) { *at<double>(off) = v; }
  uint32_t u32(size_t off) const { return *at<uint32_t>(off); }
  float f32(size_t off) const { return *at<float>(off); }
  double f64(size_t off) const { return *at<double>(off); }

  // 7 floats: position xyz, orientation xyzw.
  void write_pose(size_t off, const XrPosef& pose);
  void write_identity_pose(size_t off);
  // View i (0 or 1): pose then the four FOV angles (HOST_VIEW_STRIDE = 11 floats).
  void write_view(int index, const XrPosef& pose, const XrFovf& fov);

  // Frame header fields (flags, counts, times, texture name).
  void write_header(bool should_render, bool base_is_stage, uint32_t view_count, uint32_t color_texture,
                    uint32_t image_array_size, double predicted_display_ms, double frame_start_ms,
                    double display_period_ms, float frame_rate, float foveation);
  uint32_t next_serial();

  // Clears one hand's input block (mode none, identity poses, zero buttons/axes/joints).
  void clear_hand(int hand);

 private:
  uint8_t* data_ = nullptr;
  uint32_t serial_ = 0;
};

}  // namespace iwn::xr
