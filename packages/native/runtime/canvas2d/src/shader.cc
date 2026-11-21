/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "shader.h"

#include <algorithm>
#include <cmath>

#include "blend.h"

namespace iwn::canvas2d {

namespace {
inline uint8_t ToByte(float v) { return static_cast<uint8_t>(std::lround(std::clamp(v, 0.0f, 1.0f) * 255)); }
}  // namespace

// ---------------------------------------------------------------------------------------------------------------
// Gradient

Gradient::Gradient(Kind kind, const double* params) : kind_(kind) {
  for (int i = 0; i < 6; i++) params_[i] = params[i];
}

void Gradient::AddStop(double offset, float r, float g, float b, float a) {
  Stop s{offset, r, g, b, a};
  auto it = std::upper_bound(stops_.begin(), stops_.end(), offset,
                             [](double o, const Stop& st) { return o < st.offset; });
  stops_.insert(it, s);
  lut_dirty_ = true;
}

const uint8_t* Gradient::Lut() const {
  if (!lut_dirty_) return lut_.data();
  lut_.assign(kLutSize * 4, 0);
  lut_dirty_ = false;
  if (stops_.empty()) return lut_.data();  // transparent black (HTML: a gradient without stops)
  size_t k = 0;
  for (int i = 0; i < kLutSize; i++) {
    double t = double(i) / (kLutSize - 1);
    float r, g, b, a;
    if (t <= stops_.front().offset) {
      const Stop& s = stops_.front();
      // With several stops at the first offset, t below it uses the first one.
      r = s.r, g = s.g, b = s.b, a = s.a;
      if (t == s.offset) {
        size_t j = 0;
        while (j + 1 < stops_.size() && stops_[j + 1].offset == s.offset) j++;
        const Stop& l = stops_[j];
        r = l.r, g = l.g, b = l.b, a = l.a;
      }
    } else if (t >= stops_.back().offset) {
      const Stop& s = stops_.back();
      r = s.r, g = s.g, b = s.b, a = s.a;
    } else {
      while (k + 1 < stops_.size() && stops_[k + 1].offset <= t) k++;
      const Stop& s0 = stops_[k];
      const Stop& s1 = stops_[k + 1];
      double span = s1.offset - s0.offset;
      float f = span > 0 ? static_cast<float>((t - s0.offset) / span) : 1.0f;
      // Chrome interpolates canvas gradients in unpremultiplied space, then premultiplies.
      r = s0.r + (s1.r - s0.r) * f;
      g = s0.g + (s1.g - s0.g) * f;
      b = s0.b + (s1.b - s0.b) * f;
      a = s0.a + (s1.a - s0.a) * f;
    }
    uint8_t* e = &lut_[i * 4];
    e[0] = ToByte(r * a);
    e[1] = ToByte(g * a);
    e[2] = ToByte(b * a);
    e[3] = ToByte(a);
  }
  return lut_.data();
}

std::shared_ptr<OwnedImage> OwnedImage::CopyFrom(const ImageView& v) {
  auto img = std::make_shared<OwnedImage>();
  img->width = v.width;
  img->height = v.height;
  img->pixels.resize(static_cast<size_t>(v.width) * v.height * 4);
  for (int y = 0; y < v.height; y++) {
    const uint8_t* s = v.data + y * v.stride;
    uint8_t* d = img->pixels.data() + static_cast<size_t>(y) * v.width * 4;
    if (v.premultiplied) {
      std::copy(s, s + v.width * 4, d);
    } else {
      for (int x = 0; x < v.width; x++) {
        uint32_t a = s[4 * x + 3];
        d[4 * x] = static_cast<uint8_t>(Div255(s[4 * x] * a));
        d[4 * x + 1] = static_cast<uint8_t>(Div255(s[4 * x + 1] * a));
        d[4 * x + 2] = static_cast<uint8_t>(Div255(s[4 * x + 2] * a));
        d[4 * x + 3] = static_cast<uint8_t>(a);
      }
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------------------------
// Shader

Shader Shader::ForSolid(const Color& c) {
  Shader s;
  s.kind_ = Kind::kSolid;
  s.solid_[0] = ToByte(c.r);
  s.solid_[1] = ToByte(c.g);
  s.solid_[2] = ToByte(c.b);
  s.solid_[3] = ToByte(c.a);
  return s;
}

Shader Shader::ForPaint(const Paint& paint, const Matrix& ctm, bool smoothing) {
  if (paint.kind == Paint::Kind::kSolid) return ForSolid(paint.color);
  Shader s;
  if (!ctm.Invertible()) {
    s.valid_ = false;
    return s;
  }
  if (paint.kind == Paint::Kind::kGradient && paint.gradient) {
    const Gradient* g = paint.gradient;
    const double* p = g->params();
    s.gradient_ = g;
    s.inv_ = ctm.Inverse();
    switch (g->kind()) {
      case Gradient::Kind::kLinear:
        s.kind_ = Kind::kLinear;
        if (p[0] == p[2] && p[1] == p[3]) s.valid_ = false;  // HTML: paint nothing
        break;
      case Gradient::Kind::kRadial:
        s.kind_ = Kind::kRadial;
        if (p[0] == p[3] && p[1] == p[4] && p[2] == p[5]) s.valid_ = false;
        break;
      case Gradient::Kind::kConic:
        s.kind_ = Kind::kConic;
        break;
    }
    s.lut_ = g->Lut();
    return s;
  }
  if (paint.kind == Paint::Kind::kPattern && paint.pattern) {
    const Pattern* pt = paint.pattern;
    Matrix m = ctm * pt->transform();
    if (!m.Invertible() || pt->image().width == 0 || pt->image().height == 0) {
      s.valid_ = false;
      return s;
    }
    s.kind_ = Kind::kImage;
    s.inv_ = m.Inverse();
    s.image_ = pt->image().View();
    s.wrap_x_ = pt->repeat_x() ? Wrap::kRepeat : Wrap::kDecal;
    s.wrap_y_ = pt->repeat_y() ? Wrap::kRepeat : Wrap::kDecal;
    s.clamp_ = IntRect{0, 0, s.image_.width, s.image_.height};
    s.smooth_ = smoothing;
    return s;
  }
  s.valid_ = false;
  return s;
}

Shader Shader::ForImage(const ImageView& image, const Matrix& device_to_image, const IntRect& clamp, bool smoothing) {
  Shader s;
  s.kind_ = Kind::kImage;
  s.inv_ = device_to_image;
  s.image_ = image;
  s.wrap_x_ = s.wrap_y_ = Wrap::kClamp;
  s.clamp_ = clamp;
  s.smooth_ = smoothing;
  s.valid_ = !clamp.Empty() && device_to_image.IsFinite();
  return s;
}

void Shader::Fetch(int x, int y, float* acc, float w) const {
  if (w == 0) return;
  auto wrap = [](int v, Wrap mode, int lo, int hi, bool* out) {
    switch (mode) {
      case Wrap::kRepeat: {
        int n = hi - lo;
        int r = (v - lo) % n;
        if (r < 0) r += n;
        return lo + r;
      }
      case Wrap::kDecal:
        if (v < lo || v >= hi) *out = true;
        return v;
      case Wrap::kClamp:
      default:
        return v < lo ? lo : (v >= hi ? hi - 1 : v);
    }
  };
  bool outside = false;
  int ix = wrap(x, wrap_x_, clamp_.x0, clamp_.x1, &outside);
  int iy = wrap(y, wrap_y_, clamp_.y0, clamp_.y1, &outside);
  if (outside) return;
  const uint8_t* p = image_.data + static_cast<size_t>(iy) * image_.stride + static_cast<size_t>(ix) * 4;
  if (image_.premultiplied) {
    acc[0] += p[0] * w;
    acc[1] += p[1] * w;
    acc[2] += p[2] * w;
    acc[3] += p[3] * w;
  } else {
    float a = p[3] / 255.0f;
    acc[0] += p[0] * a * w;
    acc[1] += p[1] * a * w;
    acc[2] += p[2] * a * w;
    acc[3] += p[3] * w;
  }
}

namespace {
// Brings a texel coordinate into int range before any floor/cast (extreme pattern transforms or CTMs give huge or
// non-finite coordinates; converting those to int is undefined behaviour). Repeat axes reduce modulo the tile
// (the texel it maps to is the same); clamp/decal axes saturate a few texels outside the image (same result).
double ReduceCoord(double f, Shader::Wrap mode, int lo, int hi) {
  if (!std::isfinite(f)) return lo - 4.0;
  if (mode == Shader::Wrap::kRepeat && hi > lo) {
    double n = hi - lo;
    double r = std::fmod(f - lo, n);
    if (r < 0) r += n;
    return lo + r;
  }
  return std::clamp(f, lo - 4.0, hi + 4.0);
}
}  // namespace

void Shader::Sample(double u, double v, uint8_t* out) const {
  float acc[4] = {0, 0, 0, 0};
  u = ReduceCoord(u, wrap_x_, clamp_.x0, clamp_.x1);
  v = ReduceCoord(v, wrap_y_, clamp_.y0, clamp_.y1);
  if (!smooth_) {
    Fetch(static_cast<int>(std::floor(u)), static_cast<int>(std::floor(v)), acc, 1);
  } else {
    double fx = u - 0.5, fy = v - 0.5;
    double x0 = std::floor(fx), y0 = std::floor(fy);
    float wx = static_cast<float>(fx - x0), wy = static_cast<float>(fy - y0);
    int ix = static_cast<int>(x0), iy = static_cast<int>(y0);
    Fetch(ix, iy, acc, (1 - wx) * (1 - wy));
    Fetch(ix + 1, iy, acc, wx * (1 - wy));
    Fetch(ix, iy + 1, acc, (1 - wx) * wy);
    Fetch(ix + 1, iy + 1, acc, wx * wy);
  }
  for (int i = 0; i < 4; i++) out[i] = static_cast<uint8_t>(std::lround(std::clamp(acc[i], 0.0f, 255.0f)));
  if (out[0] > out[3]) out[0] = out[3];
  if (out[1] > out[3]) out[1] = out[3];
  if (out[2] > out[3]) out[2] = out[3];
}

void Shader::ShadeRow(int y, int x0, int n, uint8_t* out) const {
  const double py = y + 0.5;
  constexpr int kLast = Gradient::kLutSize - 1;
  auto lut_at = [&](double t, uint8_t* o) {
    if (!(t >= 0)) t = 0;  // also NaN
    if (t > 1) t = 1;
    const uint8_t* e = lut_ + 4 * static_cast<int>(t * kLast + 0.5);
    o[0] = e[0], o[1] = e[1], o[2] = e[2], o[3] = e[3];
  };
  switch (kind_) {
    case Kind::kSolid:
      for (int i = 0; i < n; i++) {
        out[4 * i] = solid_[0], out[4 * i + 1] = solid_[1], out[4 * i + 2] = solid_[2], out[4 * i + 3] = solid_[3];
      }
      return;
    case Kind::kLinear: {
      const double* p = gradient_->params();
      double dx = p[2] - p[0], dy = p[3] - p[1];
      double inv_len2 = 1.0 / (dx * dx + dy * dy);
      for (int i = 0; i < n; i++) {
        double u, v;
        inv_.Map(x0 + i + 0.5, py, &u, &v);
        lut_at(((u - p[0]) * dx + (v - p[1]) * dy) * inv_len2, out + 4 * i);
      }
      return;
    }
    case Kind::kRadial: {
      // HTML: the largest omega with r(omega) >= 0 whose circle passes through the point.
      const double* p = gradient_->params();
      double cdx = p[3] - p[0], cdy = p[4] - p[1], dr = p[5] - p[2], r0 = p[2];
      double a = cdx * cdx + cdy * cdy - dr * dr;
      for (int i = 0; i < n; i++) {
        double u, v;
        inv_.Map(x0 + i + 0.5, py, &u, &v);
        double pdx = u - p[0], pdy = v - p[1];
        double b = pdx * cdx + pdy * cdy + r0 * dr;
        double c = pdx * pdx + pdy * pdy - r0 * r0;
        double omega;
        bool ok = false;
        if (std::fabs(a) < 1e-12) {
          if (b != 0) {
            omega = c / (2 * b);
            ok = r0 + omega * dr >= 0;
          }
        } else {
          double disc = b * b - a * c;
          if (disc >= 0) {
            double sq = std::sqrt(disc);
            double w1 = (b + sq) / a, w2 = (b - sq) / a;
            double hi = std::max(w1, w2), lo = std::min(w1, w2);
            if (r0 + hi * dr >= 0) {
              omega = hi;
              ok = true;
            } else if (r0 + lo * dr >= 0) {
              omega = lo;
              ok = true;
            }
          }
        }
        uint8_t* o = out + 4 * i;
        if (ok) {
          lut_at(omega, o);
        } else {
          o[0] = o[1] = o[2] = o[3] = 0;
        }
      }
      return;
    }
    case Kind::kConic: {
      const double* p = gradient_->params();
      double start = p[0], cx = p[1], cy = p[2];
      for (int i = 0; i < n; i++) {
        double u, v;
        inv_.Map(x0 + i + 0.5, py, &u, &v);
        double ang = std::atan2(v - cy, u - cx) - start;
        double t = ang / (2 * M_PI);
        t -= std::floor(t);
        lut_at(t, out + 4 * i);
      }
      return;
    }
    case Kind::kImage: {
      for (int i = 0; i < n; i++) {
        double u, v;
        inv_.Map(x0 + i + 0.5, py, &u, &v);
        Sample(u, v, out + 4 * i);
      }
      return;
    }
  }
}

}  // namespace iwn::canvas2d
