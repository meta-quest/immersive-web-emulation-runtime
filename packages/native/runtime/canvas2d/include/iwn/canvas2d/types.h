/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Canvas 2D core types. Plain C++ (no V8): builds and is unit-tested on the x86_64 host.
//
// Conventions (HTML "the canvas element", CanvasRenderingContext2D):
//  - Device space: canvas pixels, origin top-left, y down. Pixel (x, y) covers [x, x+1) x [y, y+1).
//  - Matrices are the canvas 2D affine form [a c e; b d f]: x' = a*x + c*y + e, y' = b*x + d*y + f.
//  - Surfaces store premultiplied RGBA8 (bytes R, G, B, A in memory order), top row first: the same layout Chrome's
//    canvas keeps, so getImageData() round trips lose precision the way they do there.
#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>

namespace iwn::canvas2d {

struct Matrix {
  double a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;

  static Matrix Identity() { return {}; }
  static Matrix Translate(double x, double y) { return {1, 0, 0, 1, x, y}; }
  static Matrix Scale(double sx, double sy) { return {sx, 0, 0, sy, 0, 0}; }

  void Map(double x, double y, double* ox, double* oy) const {
    *ox = a * x + c * y + e;
    *oy = b * x + d * y + f;
  }
  // this * m: apply m first, then this.
  Matrix operator*(const Matrix& m) const {
    return {a * m.a + c * m.b,       b * m.a + d * m.b,       a * m.c + c * m.d,
            b * m.c + d * m.d,       a * m.e + c * m.f + e,   b * m.e + d * m.f + f};
  }
  double Determinant() const { return a * d - b * c; }
  bool IsFinite() const {
    return std::isfinite(a) && std::isfinite(b) && std::isfinite(c) && std::isfinite(d) && std::isfinite(e) &&
           std::isfinite(f);
  }
  bool Invertible() const {
    double det = Determinant();
    return IsFinite() && det != 0 && std::isfinite(1.0 / det);
  }
  // Undefined when !Invertible().
  Matrix Inverse() const {
    double det = Determinant();
    double id = 1.0 / det;
    return {d * id, -b * id, -c * id, a * id, (c * f - d * e) * id, (b * e - a * f) * id};
  }
  // Largest stretch factor (largest singular value): device pixels per user unit along the worst axis.
  double MaxScale() const {
    double s1 = a * a + b * b, s2 = c * c + d * d, s12 = a * c + b * d;
    double tr = s1 + s2, dif = s1 - s2;
    double root = std::sqrt(dif * dif + 4 * s12 * s12);
    return std::sqrt(std::fmax(0.0, (tr + root) * 0.5));
  }
  bool IsIdentity() const { return a == 1 && b == 0 && c == 0 && d == 1 && e == 0 && f == 0; }
};

// Premultiplied colour, components 0..1.
struct Color {
  float r = 0, g = 0, b = 0, a = 0;
  static Color FromUnpremultiplied(float r, float g, float b, float a) { return {r * a, g * a, b * a, a}; }
};

enum class FillRule : uint8_t { kNonZero = 0, kEvenOdd = 1 };

// Values are the wire codes the JS layer sends (web/canvas2d/src/constants.ts must match).
enum class CompositeOp : uint8_t {
  kSourceOver = 0,
  kSourceIn,
  kSourceOut,
  kSourceAtop,
  kDestinationOver,
  kDestinationIn,
  kDestinationOut,
  kDestinationAtop,
  kLighter,
  kCopy,
  kXor,
  kMultiply,
  kScreen,
  kOverlay,
  kDarken,
  kLighten,
  kColorDodge,
  kColorBurn,
  kHardLight,
  kSoftLight,
  kDifference,
  kExclusion,
  kHue,
  kSaturation,
  kColor,
  kLuminosity,
  kClear,  // internal: clearRect()
  kCount
};

// Ops whose result differs from the destination where the source is fully transparent: they affect every pixel inside
// the clip, not just the shape (HTML: "the shape is composited ... with transparent black outside it").
inline bool IsUnbounded(CompositeOp op) {
  switch (op) {
    case CompositeOp::kSourceIn:
    case CompositeOp::kSourceOut:
    case CompositeOp::kDestinationIn:
    case CompositeOp::kDestinationAtop:
    case CompositeOp::kCopy:
      return true;
    default:
      return false;
  }
}

enum class LineCap : uint8_t { kButt = 0, kRound = 1, kSquare = 2 };
enum class LineJoin : uint8_t { kMiter = 0, kRound = 1, kBevel = 2 };

struct IntRect {
  int x0 = 0, y0 = 0, x1 = 0, y1 = 0;  // half-open
  bool Empty() const { return x1 <= x0 || y1 <= y0; }
  IntRect Intersect(const IntRect& o) const {
    IntRect r{x0 > o.x0 ? x0 : o.x0, y0 > o.y0 ? y0 : o.y0, x1 < o.x1 ? x1 : o.x1, y1 < o.y1 ? y1 : o.y1};
    if (r.Empty()) r = IntRect{};
    return r;
  }
};

// Path commands: a flat float array, each command a verb followed by its points (in the path's own space).
// The JS Path2D / default-path builders emit exactly this, so a path crosses the binding as one typed array.
enum PathVerb : int {
  kVerbMove = 0,   // x y
  kVerbLine = 1,   // x y
  kVerbQuad = 2,   // cx cy x y
  kVerbCubic = 3,  // c1x c1y c2x c2y x y
  kVerbClose = 4,  // (none)
};

struct PathView {
  const float* data = nullptr;
  size_t length = 0;  // number of floats
};

}  // namespace iwn::canvas2d
