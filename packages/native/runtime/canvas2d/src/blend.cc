/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "blend.h"

#include <algorithm>
#include <cmath>

namespace iwn::canvas2d {

namespace {

inline float Clamp01(float v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

// Separable blend functions B(cb, cs) on unpremultiplied components.
inline float BlendChannel(CompositeOp op, float cb, float cs) {
  switch (op) {
    case CompositeOp::kMultiply:
      return cb * cs;
    case CompositeOp::kScreen:
      return cb + cs - cb * cs;
    case CompositeOp::kOverlay:  // hard-light with the layers swapped
      return cb <= 0.5f ? cs * 2 * cb : (cs + (2 * cb - 1) - cs * (2 * cb - 1));
    case CompositeOp::kDarken:
      return std::min(cb, cs);
    case CompositeOp::kLighten:
      return std::max(cb, cs);
    case CompositeOp::kColorDodge:
      if (cb == 0) return 0;
      if (cs >= 1) return 1;
      return std::min(1.0f, cb / (1 - cs));
    case CompositeOp::kColorBurn:
      if (cb >= 1) return 1;
      if (cs <= 0) return 0;
      return 1 - std::min(1.0f, (1 - cb) / cs);
    case CompositeOp::kHardLight:
      return cs <= 0.5f ? cb * 2 * cs : (cb + (2 * cs - 1) - cb * (2 * cs - 1));
    case CompositeOp::kSoftLight: {
      if (cs <= 0.5f) return cb - (1 - 2 * cs) * cb * (1 - cb);
      float d = cb <= 0.25f ? ((16 * cb - 12) * cb + 4) * cb : std::sqrt(cb);
      return cb + (2 * cs - 1) * (d - cb);
    }
    case CompositeOp::kDifference:
      return std::fabs(cb - cs);
    case CompositeOp::kExclusion:
      return cb + cs - 2 * cb * cs;
    default:
      return cs;
  }
}

inline float Lum(const float c[3]) { return 0.3f * c[0] + 0.59f * c[1] + 0.11f * c[2]; }

inline void ClipColor(float c[3]) {
  float l = Lum(c);
  float n = std::min({c[0], c[1], c[2]});
  float x = std::max({c[0], c[1], c[2]});
  if (n < 0) {
    for (int i = 0; i < 3; i++) c[i] = l + (c[i] - l) * l / (l - n);
  }
  if (x > 1) {
    for (int i = 0; i < 3; i++) c[i] = l + (c[i] - l) * (1 - l) / (x - l);
  }
}

inline void SetLum(float c[3], float l) {
  float d = l - Lum(c);
  for (int i = 0; i < 3; i++) c[i] += d;
  ClipColor(c);
}

inline float Sat(const float c[3]) { return std::max({c[0], c[1], c[2]}) - std::min({c[0], c[1], c[2]}); }

inline void SetSat(float c[3], float s) {
  int imax = 0, imin = 0;
  for (int i = 1; i < 3; i++) {
    if (c[i] > c[imax]) imax = i;
    if (c[i] < c[imin]) imin = i;
  }
  if (imax == imin) {
    c[0] = c[1] = c[2] = 0;
    return;
  }
  int imid = 3 - imax - imin;
  float cmax = c[imax], cmin = c[imin], cmid = c[imid];
  c[imid] = (cmid - cmin) * s / (cmax - cmin);
  c[imax] = s;
  c[imin] = 0;
}

inline void NonSeparable(CompositeOp op, const float cb[3], const float cs[3], float out[3]) {
  float t[3];
  switch (op) {
    case CompositeOp::kHue:
      t[0] = cs[0], t[1] = cs[1], t[2] = cs[2];
      SetSat(t, Sat(cb));
      SetLum(t, Lum(cb));
      break;
    case CompositeOp::kSaturation:
      t[0] = cb[0], t[1] = cb[1], t[2] = cb[2];
      SetSat(t, Sat(cs));
      SetLum(t, Lum(cb));
      break;
    case CompositeOp::kColor:
      t[0] = cs[0], t[1] = cs[1], t[2] = cs[2];
      SetLum(t, Lum(cb));
      break;
    default:  // luminosity
      t[0] = cb[0], t[1] = cb[1], t[2] = cb[2];
      SetLum(t, Lum(cs));
      break;
  }
  out[0] = t[0], out[1] = t[1], out[2] = t[2];
}

// s, d premultiplied 0..1 -> r premultiplied.
inline void Composite(CompositeOp op, const float s[4], const float d[4], float r[4]) {
  float sa = s[3], da = d[3];
  switch (op) {
    case CompositeOp::kSourceOver:
      for (int i = 0; i < 4; i++) r[i] = s[i] + d[i] * (1 - sa);
      return;
    case CompositeOp::kSourceIn:
      for (int i = 0; i < 4; i++) r[i] = s[i] * da;
      return;
    case CompositeOp::kSourceOut:
      for (int i = 0; i < 4; i++) r[i] = s[i] * (1 - da);
      return;
    case CompositeOp::kSourceAtop:
      for (int i = 0; i < 4; i++) r[i] = s[i] * da + d[i] * (1 - sa);
      return;
    case CompositeOp::kDestinationOver:
      for (int i = 0; i < 4; i++) r[i] = s[i] * (1 - da) + d[i];
      return;
    case CompositeOp::kDestinationIn:
      for (int i = 0; i < 4; i++) r[i] = d[i] * sa;
      return;
    case CompositeOp::kDestinationOut:
    case CompositeOp::kClear:
      for (int i = 0; i < 4; i++) r[i] = d[i] * (1 - sa);
      return;
    case CompositeOp::kDestinationAtop:
      for (int i = 0; i < 4; i++) r[i] = s[i] * (1 - da) + d[i] * sa;
      return;
    case CompositeOp::kLighter:
      for (int i = 0; i < 4; i++) r[i] = std::min(1.0f, s[i] + d[i]);
      return;
    case CompositeOp::kCopy:
      for (int i = 0; i < 4; i++) r[i] = s[i];
      return;
    case CompositeOp::kXor:
      for (int i = 0; i < 4; i++) r[i] = s[i] * (1 - da) + d[i] * (1 - sa);
      return;
    default:
      break;
  }
  // Blend modes: co = cs(1 - ab) + cb(1 - as) + as*ab*B(Cb, Cs), ao = as + ab - as*ab.
  float cs[3], cb[3], bl[3];
  for (int i = 0; i < 3; i++) {
    cs[i] = sa > 0 ? Clamp01(s[i] / sa) : 0;
    cb[i] = da > 0 ? Clamp01(d[i] / da) : 0;
  }
  if (op >= CompositeOp::kHue && op <= CompositeOp::kLuminosity) {
    NonSeparable(op, cb, cs, bl);
  } else {
    for (int i = 0; i < 3; i++) bl[i] = BlendChannel(op, cb[i], cs[i]);
  }
  for (int i = 0; i < 3; i++) r[i] = s[i] * (1 - da) + d[i] * (1 - sa) + sa * da * bl[i];
  r[3] = sa + da - sa * da;
}

}  // namespace

void CompositeSpan(CompositeOp op, uint8_t* dst, const uint8_t* src, const uint8_t solid[4], const uint8_t* coverage,
                   const uint8_t* clip, float alpha, int n) {
  const bool unbounded = IsUnbounded(op);
  const uint32_t alpha255 = static_cast<uint32_t>(std::lround(Clamp01(alpha) * 255));
  if (op == CompositeOp::kSourceOver && !clip) {
    // Solid colour at full coverage (the inside of shapes): precomputed once.
    uint32_t fr = 0, fg = 0, fb = 0, fa = 0, finv = 255;
    if (!src) {
      fr = Div255(solid[0] * alpha255);
      fg = Div255(solid[1] * alpha255);
      fb = Div255(solid[2] * alpha255);
      fa = Div255(solid[3] * alpha255);
      finv = 255 - fa;
    }
    for (int i = 0; i < n; i++) {
      uint32_t cov = coverage ? coverage[i] : 255;
      if (cov == 0) continue;
      if (!src && cov == 255) {
        uint8_t* d = dst + 4 * i;
        if (finv == 0) {
          d[0] = static_cast<uint8_t>(fr), d[1] = static_cast<uint8_t>(fg), d[2] = static_cast<uint8_t>(fb), d[3] = 255;
        } else {
          d[0] = static_cast<uint8_t>(fr + Div255(d[0] * finv));
          d[1] = static_cast<uint8_t>(fg + Div255(d[1] * finv));
          d[2] = static_cast<uint8_t>(fb + Div255(d[2] * finv));
          d[3] = static_cast<uint8_t>(fa + Div255(d[3] * finv));
        }
        continue;
      }
      uint32_t scale = Div255(cov * alpha255);
      if (scale == 0) continue;
      const uint8_t* s = src ? src + 4 * i : solid;
      if (s[3] == 0) continue;
      uint8_t* d = dst + 4 * i;
      if (scale == 255 && s[3] == 255) {
        d[0] = s[0], d[1] = s[1], d[2] = s[2], d[3] = 255;
        continue;
      }
      uint32_t sr = Div255(s[0] * scale), sg = Div255(s[1] * scale), sb = Div255(s[2] * scale),
               sa = Div255(s[3] * scale);
      uint32_t inv = 255 - sa;
      d[0] = static_cast<uint8_t>(sr + Div255(d[0] * inv));
      d[1] = static_cast<uint8_t>(sg + Div255(d[1] * inv));
      d[2] = static_cast<uint8_t>(sb + Div255(d[2] * inv));
      d[3] = static_cast<uint8_t>(sa + Div255(d[3] * inv));
    }
    return;
  }
  if (op == CompositeOp::kDestinationOut && !clip) {
    // clearRect and erasing: d *= 1 - sa, integer.
    for (int i = 0; i < n; i++) {
      uint32_t cov = coverage ? coverage[i] : 255;
      if (cov == 0) continue;
      const uint8_t* s = src ? src + 4 * i : solid;
      uint32_t sa = Div255(s[3] * Div255(cov * alpha255));
      uint8_t* d = dst + 4 * i;
      if (sa == 255) {
        d[0] = d[1] = d[2] = d[3] = 0;
        continue;
      }
      uint32_t inv = 255 - sa;
      d[0] = static_cast<uint8_t>(Div255(d[0] * inv));
      d[1] = static_cast<uint8_t>(Div255(d[1] * inv));
      d[2] = static_cast<uint8_t>(Div255(d[2] * inv));
      d[3] = static_cast<uint8_t>(Div255(d[3] * inv));
    }
    return;
  }
  const float af = alpha255 / 255.0f;
  for (int i = 0; i < n; i++) {
    uint32_t cov = coverage ? coverage[i] : 255;
    uint32_t cl = clip ? clip[i] : 255;
    if (cl == 0) continue;
    if (cov == 0 && !unbounded) continue;
    const uint8_t* sp = src ? src + 4 * i : solid;
    uint8_t* dp = dst + 4 * i;
    float k = cov / 255.0f * af / 255.0f;
    float s[4] = {sp[0] * k, sp[1] * k, sp[2] * k, sp[3] * k};
    float d[4] = {dp[0] / 255.0f, dp[1] / 255.0f, dp[2] / 255.0f, dp[3] / 255.0f};
    float r[4];
    Composite(op, s, d, r);
    if (cl != 255) {
      float c = cl / 255.0f;
      for (int j = 0; j < 4; j++) r[j] = d[j] + (r[j] - d[j]) * c;
    }
    float a = Clamp01(r[3]);
    for (int j = 0; j < 3; j++) {
      float v = std::min(Clamp01(r[j]), a);  // keep premultiplied invariant
      dp[j] = static_cast<uint8_t>(std::lround(v * 255));
    }
    dp[3] = static_cast<uint8_t>(std::lround(a * 255));
  }
}

}  // namespace iwn::canvas2d
