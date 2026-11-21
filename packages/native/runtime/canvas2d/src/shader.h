/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Per-pixel paint evaluation (solid colours, gradients, patterns, drawImage sources) into premultiplied RGBA8 rows.
// Pixels are evaluated at their centres, mapped back from device space to the paint's space.
#pragma once

#include <cstdint>

#include "iwn/canvas2d/canvas.h"

namespace iwn::canvas2d {

class Shader {
 public:
  enum class Wrap : uint8_t { kRepeat, kDecal, kClamp };

  // valid() is false when nothing must be painted (degenerate gradient, singular matrix).
  static Shader ForPaint(const Paint& paint, const Matrix& ctm, bool smoothing);
  static Shader ForImage(const ImageView& image, const Matrix& device_to_image, const IntRect& clamp, bool smoothing);
  static Shader ForSolid(const Color& c);

  bool valid() const { return valid_; }
  bool is_solid() const { return kind_ == Kind::kSolid; }
  const uint8_t* solid() const { return solid_; }
  void ShadeRow(int y, int x0, int n, uint8_t* out) const;

 private:
  enum class Kind : uint8_t { kSolid, kLinear, kRadial, kConic, kImage };
  void Sample(double u, double v, uint8_t* out) const;
  void Fetch(int x, int y, float* acc, float w) const;

  Kind kind_ = Kind::kSolid;
  bool valid_ = true;
  uint8_t solid_[4] = {0, 0, 0, 0};
  Matrix inv_;  // device -> paint space
  const Gradient* gradient_ = nullptr;
  const uint8_t* lut_ = nullptr;
  ImageView image_;
  Wrap wrap_x_ = Wrap::kClamp, wrap_y_ = Wrap::kClamp;
  IntRect clamp_;
  bool smooth_ = true;
};

}  // namespace iwn::canvas2d
