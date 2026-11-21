/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/xr/camera_convert.h"

namespace iwn::xr {

namespace {

// Full-range BT.601 in 16.16 fixed point: R = Y + 1.402 V', G = Y - 0.344136 U' - 0.714136 V', B = Y + 1.772 U'.
constexpr int kRV = 91881;
constexpr int kGU = 22554;
constexpr int kGV = 46802;
constexpr int kBU = 116130;
constexpr int kHalf = 1 << 15;

inline uint8_t clamp8(int v) { return static_cast<uint8_t>(v < 0 ? 0 : v > 255 ? 255 : v); }

// One output row. PS is the chroma pixel stride as a constant, so the compiler can vectorise the common layouts.
template <int PS>
void convert_row(const uint8_t* y, const uint8_t* u, const uint8_t* v, int width, int ps, uint8_t* out) {
  const int step = PS > 0 ? PS : ps;
  for (int x = 0; x < width; ++x) {
    const int c = (x >> 1) * step;
    const int yy = y[x] << 16;
    const int uu = u[c] - 128;
    const int vv = v[c] - 128;
    out[0] = clamp8((yy + kRV * vv + kHalf) >> 16);
    out[1] = clamp8((yy - kGU * uu - kGV * vv + kHalf) >> 16);
    out[2] = clamp8((yy + kBU * uu + kHalf) >> 16);
    out[3] = 255;
    out += 4;
  }
}

}  // namespace

void yuv420_to_rgba(const YuvPlanes& src, int width, int height, uint8_t* dst, size_t dst_stride) {
  if (!src.y || !src.u || !src.v || !dst || width <= 0 || height <= 0) return;
  for (int row = 0; row < height; ++row) {
    const uint8_t* y = src.y + static_cast<size_t>(row) * src.y_row_stride;
    const size_t crow = static_cast<size_t>(row >> 1) * src.uv_row_stride;
    uint8_t* out = dst + static_cast<size_t>(row) * dst_stride;
    if (src.uv_pixel_stride == 2) {
      convert_row<2>(y, src.u + crow, src.v + crow, width, 2, out);
    } else if (src.uv_pixel_stride == 1) {
      convert_row<1>(y, src.u + crow, src.v + crow, width, 1, out);
    } else {
      convert_row<0>(y, src.u + crow, src.v + crow, width, src.uv_pixel_stride, out);
    }
  }
}

std::string camera_label(const std::string& id, int position, LensFacing facing) {
  const char* f = facing == LensFacing::kFront ? "front" : facing == LensFacing::kBack ? "back" : "external";
  std::string out;
  if (position == 0 || position == 1) {
    out = std::string(position == 0 ? "Left" : "Right") + " passthrough camera (id " + id + ")";
  } else {
    out = "Camera " + id;
  }
  return out + ", facing " + f;
}

}  // namespace iwn::xr
