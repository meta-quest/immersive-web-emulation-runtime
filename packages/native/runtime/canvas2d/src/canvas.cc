#include "iwn/canvas2d/canvas.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>

#include "blend.h"
#include "codec.h"
#include "geometry.h"
#include "raster.h"
#include "shader.h"

namespace iwn::canvas2d {

// ---------------------------------------------------------------------------------------------------------------
// Surface

bool Surface::Resize(int width, int height) {
  pixels_.clear();
  pixels_.shrink_to_fit();
  width_ = height_ = 0;
  generation_++;
  if (width < 0 || height < 0) return false;
  if (width > kMaxDimension || height > kMaxDimension || int64_t(width) * height > kMaxPixels) return false;
  try {
    pixels_.assign(static_cast<size_t>(width) * height * 4, 0);
  } catch (...) {
    return false;
  }
  width_ = width;
  height_ = height;
  return true;
}

void Surface::Clear() {
  std::fill(pixels_.begin(), pixels_.end(), 0);
  generation_++;
}

// ---------------------------------------------------------------------------------------------------------------
// Blur for shadows: three box blurs approximate a Gaussian (the approximation the Filter Effects spec describes for
// feGaussianBlur: box size d = floor(sigma * 3 * sqrt(2 * pi) / 4 + 0.5)).

namespace {

int BoxSize(double sigma) {
  int d = static_cast<int>(std::floor(sigma * 3 * std::sqrt(2 * M_PI) / 4 + 0.5));
  return std::max(d, 1);
}

// Box of `left + right + 1` pixels around each output pixel.
void BoxBlurLine(const uint8_t* in, uint8_t* out, int n, int stride, int left, int right) {
  int d = left + right + 1;
  uint32_t sum = 0;
  for (int i = -left; i <= right; i++) {
    if (i >= 0 && i < n) sum += in[i * stride];
  }
  for (int i = 0; i < n; i++) {
    out[i * stride] = static_cast<uint8_t>((sum + d / 2) / d);
    int add = i + right + 1, sub = i - left;
    if (add < n) sum += in[add * stride];
    if (sub >= 0) sum -= in[sub * stride];
  }
}

// Filter Effects: for odd d three centred boxes of size d; for even d one box offset left, one offset right, and
// one of size d + 1 centred, so the result is not shifted.
void BoxParams(int d, int pass, int* left, int* right) {
  if (d % 2 == 1) {
    *left = *right = d / 2;
  } else if (pass == 0) {
    *left = d / 2;
    *right = d / 2 - 1;
  } else if (pass == 1) {
    *left = d / 2 - 1;
    *right = d / 2;
  } else {
    *left = *right = d / 2;
  }
}

void BlurPlane(std::vector<uint8_t>* plane, int w, int h, double sigma) {
  if (sigma <= 0) return;
  int d = BoxSize(sigma);
  if (d <= 1) return;
  std::vector<uint8_t> tmp(plane->size());
  for (int pass = 0; pass < 3; pass++) {
    int l, r;
    BoxParams(d, pass, &l, &r);
    for (int y = 0; y < h; y++) BoxBlurLine(plane->data() + y * w, tmp.data() + y * w, w, 1, l, r);
    plane->swap(tmp);
  }
  for (int pass = 0; pass < 3; pass++) {
    int l, r;
    BoxParams(d, pass, &l, &r);
    for (int x = 0; x < w; x++) BoxBlurLine(plane->data() + x, tmp.data() + x, h, w, l, r);
    plane->swap(tmp);
  }
}

int BlurExtent(double sigma) {
  if (sigma <= 0) return 0;
  return 3 * (BoxSize(sigma) / 2 + 1);
}

// Shadow blur bounds. HTML: sigma = shadowBlur / 2. Very large blurs are capped (as Skia does; beyond this the shadow
// is a faint uniform wash) and blurs above kFullResSigma run on a plane downsampled by ceil(sigma / kFullResSigma),
// so the work and memory of one shadowed draw stay bounded whatever shadowBlur is.
constexpr double kMaxShadowSigma = 532;
constexpr double kFullResSigma = 32;

double ShadowSigma(const DrawParams& p) { return std::min(p.shadow.blur / 2, kMaxShadowSigma); }

int FloorDiv(int a, int b) { return a >= 0 ? a / b : -((-a + b - 1) / b); }
int CeilDiv(int a, int b) { return -FloorDiv(-a, b); }

// Per-thread scratch shared by every canvas drawn on that thread (a canvas keeps no raster memory of its own).
struct Scratch {
  Rasterizer raster;
  std::vector<uint8_t> src;
  std::vector<uint8_t> cov;
};
Scratch& ThreadScratch() {
  static thread_local Scratch s;
  return s;
}

// Gives large scratch buffers back after an unusually big draw.
template <class T>
void TrimVector(std::vector<T>* v, size_t max_bytes) {
  if (v->capacity() * sizeof(T) > max_bytes) {
    v->clear();
    v->shrink_to_fit();
  }
}

}  // namespace

// ---------------------------------------------------------------------------------------------------------------
// Canvas

Canvas::Canvas(Surface* surface) : surface_(surface), raster_(&ThreadScratch().raster) {}
Canvas::~Canvas() = default;

void Canvas::BeginOp() {
  Scratch& s = ThreadScratch();
  raster_ = &s.raster;
  scratch_src_ = &s.src;
  scratch_cov_ = &s.cov;
}

void Canvas::EndOp() {
  constexpr size_t kKeep = size_t(4) << 20;
  raster_->Trim(kKeep);
  TrimVector(scratch_src_, kKeep);
  TrimVector(scratch_cov_, kKeep);
}

IntRect Canvas::DrawBox(const DrawParams& params) const {
  IntRect box = surface_->Bounds();
  if (params.clip) box = box.Intersect(params.clip->bounds);
  return box;
}

namespace {

// Where a shadowed draw needs coverage: the drawable box (the shape) and where shadow sources come from (src). Both
// are rasterised in one pass over their bounding box, unless that box is mostly neither (a large shadow offset puts
// src far from the canvas): then `split`, and the shape and the shadow source are rasterised separately, so the work
// stays proportional to the two boxes instead of the empty area between them.
struct ShadowBoxes {
  IntRect raster;  // what the caller rasterises first
  IntRect src;     // shadow source area (empty: no shadow can reach the box)
  bool split = false;
};

int64_t Area(const IntRect& r) { return r.Empty() ? 0 : int64_t(r.x1 - r.x0) * (r.y1 - r.y0); }

ShadowBoxes ComputeShadowBoxes(const IntRect& draw_box, const DrawParams& params) {
  ShadowBoxes out{draw_box, IntRect{}, false};
  if (!params.shadow.Active() || draw_box.Empty()) return out;
  int ox = static_cast<int>(std::lround(std::clamp(params.shadow.offset_x, -1e7, 1e7)));
  int oy = static_cast<int>(std::lround(std::clamp(params.shadow.offset_y, -1e7, 1e7)));
  int ext = BlurExtent(ShadowSigma(params));
  IntRect src{draw_box.x0 - ox - ext, draw_box.y0 - oy - ext, draw_box.x1 - ox + ext, draw_box.y1 - oy + ext};
  // Shadow sources farther than 4 * kMaxDimension from the drawable box are ignored: this bounds the raster box,
  // and the "draw off-canvas, show only the shadow" idiom keeps working for any offset a canvas can use.
  constexpr int kReach = 4 * kMaxDimension;
  IntRect src_clip =
      src.Intersect(IntRect{draw_box.x0 - kReach, draw_box.y0 - kReach, draw_box.x1 + kReach, draw_box.y1 + kReach});
  if (src_clip.Empty()) return out;
  out.src = src_clip;
  IntRect u{std::min(draw_box.x0, src_clip.x0), std::min(draw_box.y0, src_clip.y0), std::max(draw_box.x1, src_clip.x1),
            std::max(draw_box.y1, src_clip.y1)};
  if (Area(u) > 2 * (Area(draw_box) + Area(src_clip))) {
    out.split = true;
  } else {
    out.raster = u;
  }
  return out;
}

// The area to rasterise first: the drawable box, plus where shadow sources come from when not split.
IntRect RasterBox(const IntRect& draw_box, const DrawParams& params) { return ComputeShadowBoxes(draw_box, params).raster; }

}  // namespace

void Canvas::DrawCoverage(FillRule rule, double alpha_scale, const Paint& paint, const ImageView* image,
                          const Matrix* device_to_image, const IntRect* image_clamp, const DrawParams& params,
                          const std::function<void(Rasterizer*)>& regeom) {
  IntRect box = DrawBox(params);
  if (box.Empty()) return;
  Shader shader = image ? Shader::ForImage(*image, *device_to_image, *image_clamp, params.smoothing)
                        : Shader::ForPaint(paint, params.ctm, params.smoothing);
  if (!shader.valid()) shader = Shader::ForSolid(Color{});  // "paint nothing": a transparent shape
  const float alpha = static_cast<float>(params.global_alpha * alpha_scale);
  const CompositeOp op = params.op;
  const uint8_t* solid = shader.is_solid() ? shader.solid() : nullptr;
  std::vector<uint8_t>& scratch_src = *scratch_src_;
  std::vector<uint8_t>& scratch_cov = *scratch_cov_;
  surface_->Touch();

  if (params.shadow.Active()) {
    // Render the shape (premultiplied colour, only where it can be seen) and its alpha (the shadow's source, on a
    // plane padded by the blur extent and downsampled for large blurs); draw the blurred, tinted, offset alpha as
    // the shadow, then the shape.
    const ShadowBoxes sbx = ComputeShadowBoxes(box, params);
    const bool split = sbx.split && regeom;
    const double sigma = ShadowSigma(params);
    const int k = sigma > kFullResSigma ? static_cast<int>(std::ceil(sigma / kFullResSigma)) : 1;
    const double grid_sigma = sigma / k;
    const int ext = BlurExtent(grid_sigma);
    // The shape's pixels: from the current rasterisation, inside the box.
    IntRect pb = box.Intersect(raster_->Bounds());
    const int pw = pb.Empty() ? 0 : pb.x1 - pb.x0, ph = pb.Empty() ? 0 : pb.y1 - pb.y0;
    std::vector<uint8_t> pix(static_cast<size_t>(pw) * ph * 4, 0);
    // The shadow source plane covers lb (grid of k x k pixel cells, padded by the blur extent).
    IntRect lb;
    int gx0 = 0, gy0 = 0, gw = 0, gh = 0;
    std::vector<uint8_t> sh;
    std::vector<uint32_t> acc;
    auto setup_plane = [&] {
      if (lb.Empty()) return;
      gx0 = FloorDiv(lb.x0, k) - ext;
      gy0 = FloorDiv(lb.y0, k) - ext;
      gw = CeilDiv(lb.x1, k) + ext - gx0;
      gh = CeilDiv(lb.y1, k) + ext - gy0;
      if (k == 1) sh.assign(static_cast<size_t>(gw) * gh, 0);
      else acc.assign(static_cast<size_t>(gw) * gh, 0);
    };
    std::vector<uint8_t> tmp;
    // One sweep of the current rasterisation: the shape's pixels (rows of pb) and/or the plane (rows of lb).
    auto sweep = [&](bool want_pix, bool want_plane) {
      const bool plane = want_plane && gw > 0 && gh > 0;
      if (!plane && (!want_pix || pw == 0)) return;
      raster_->Sweep(rule, [&](int y, int x0, int x1, const uint8_t* cov) {
        const bool in_plane = plane && y >= lb.y0 && y < lb.y1;
        const bool in_pix = want_pix && y >= pb.y0 && y < pb.y1;
        if (!in_plane && !in_pix) return;
        int lo = in_plane ? lb.x0 : pb.x0, hi = in_plane ? lb.x1 : pb.x1;
        if (in_plane && in_pix) lo = std::min(lb.x0, pb.x0), hi = std::max(lb.x1, pb.x1);
        int a = std::max(x0, lo), b = std::min(x1, hi);
        if (b <= a) return;
        int n = b - a;
        const uint8_t* src = nullptr;
        if (!solid) {
          scratch_src.resize(static_cast<size_t>(n) * 4);
          shader.ShadeRow(y, a, n, scratch_src.data());
          src = scratch_src.data();
        }
        tmp.assign(static_cast<size_t>(n) * 4, 0);
        CompositeSpan(CompositeOp::kSourceOver, tmp.data(), src, solid, cov + (a - x0), nullptr, 1.0f, n);
        if (in_plane) {
          int c0 = std::max(a, lb.x0), c1 = std::min(b, lb.x1);
          if (k == 1) {
            uint8_t* row = sh.data() + static_cast<size_t>(y - gy0) * gw;
            for (int x = c0; x < c1; x++) row[x - gx0] = tmp[4 * (x - a) + 3];
          } else {
            uint32_t* row = acc.data() + static_cast<size_t>(FloorDiv(y, k) - gy0) * gw;
            for (int x = c0; x < c1; x++) row[FloorDiv(x, k) - gx0] += tmp[4 * (x - a) + 3];
          }
        }
        if (in_pix) {
          int c0 = std::max(a, pb.x0), c1 = std::min(b, pb.x1);
          if (c1 > c0) {
            std::memcpy(pix.data() + (static_cast<size_t>(y - pb.y0) * pw + (c0 - pb.x0)) * 4, tmp.data() + (c0 - a) * 4,
                        static_cast<size_t>(c1 - c0) * 4);
          }
        }
      });
    };
    if (!split) {
      lb = raster_->Bounds().Intersect(sbx.raster);
      setup_plane();
      sweep(true, true);
    } else {
      // The shape first, then the shadow source rasterised on its own box.
      sweep(true, false);
      raster_->Reset(sbx.src);
      regeom(raster_);
      raster_->Finish();
      lb = raster_->Bounds().Intersect(sbx.src);
      setup_plane();
      sweep(false, true);
    }
    if (gw > 0 && gh > 0) {
      if (k > 1) {
        sh.resize(acc.size());
        const uint32_t kk = static_cast<uint32_t>(k * k);
        for (size_t i = 0; i < acc.size(); i++) sh[i] = static_cast<uint8_t>(std::min<uint32_t>(255, (acc[i] + kk / 2) / kk));
        acc.clear();
        acc.shrink_to_fit();
      }
      BlurPlane(&sh, gw, gh, grid_sigma);
      const Color& c = params.shadow.color;
      uint8_t shadow_solid[4] = {static_cast<uint8_t>(std::lround(c.r * 255)), static_cast<uint8_t>(std::lround(c.g * 255)),
                                 static_cast<uint8_t>(std::lround(c.b * 255)), static_cast<uint8_t>(std::lround(c.a * 255))};
      const double oxd = std::clamp(params.shadow.offset_x, -1e7, 1e7), oyd = std::clamp(params.shadow.offset_y, -1e7, 1e7);
      int ox = static_cast<int>(std::lround(oxd));
      int oy = static_cast<int>(std::lround(oyd));
      auto at = [&](int gx, int gy) -> int {
        return (gx >= 0 && gx < gw && gy >= 0 && gy < gh) ? sh[static_cast<size_t>(gy) * gw + gx] : 0;
      };
      // Bounded operators only touch the shadow's footprint (the blurred plane, offset; one grid cell of margin for
      // the bilinear taps), so a small shadowed shape costs its own area, not the canvas's. Unbounded operators
      // composite every pixel of the box (zero coverage outside the footprint clears it).
      IntRect sbox = box;
      if (!IsUnbounded(op)) {
        auto clampi = [](int64_t v) { return static_cast<int>(std::clamp<int64_t>(v, INT32_MIN / 2, INT32_MAX / 2)); };
        IntRect foot{clampi((int64_t(gx0) - 1) * k + ox), clampi((int64_t(gy0) - 1) * k + oy),
                     clampi((int64_t(gx0) + gw + 1) * k + ox), clampi((int64_t(gy0) + gh + 1) * k + oy)};
        sbox = box.Intersect(foot);
      }
      const int sw = sbox.Empty() ? 0 : sbox.x1 - sbox.x0;
      if (sw > 0) scratch_cov.resize(sw);
      for (int y = sbox.y0; sw > 0 && y < sbox.y1; y++) {
        bool any = false;
        if (k == 1) {
          int sy = y - oy - gy0;
          for (int x = sbox.x0; x < sbox.x1; x++) {
            uint8_t v = static_cast<uint8_t>(at(x - ox - gx0, sy));
            scratch_cov[x - sbox.x0] = v;
            any |= v != 0;
          }
        } else {
          // Bilinear sample of the downsampled plane at the pixel centre.
          double gyf = (y - oy + 0.5) / k - 0.5 - gy0;
          int gyi = static_cast<int>(std::floor(gyf));
          double fy = gyf - gyi;
          for (int x = sbox.x0; x < sbox.x1; x++) {
            double gxf = (x - ox + 0.5) / k - 0.5 - gx0;
            int gxi = static_cast<int>(std::floor(gxf));
            double fx = gxf - gxi;
            double v = (at(gxi, gyi) * (1 - fx) + at(gxi + 1, gyi) * fx) * (1 - fy) +
                       (at(gxi, gyi + 1) * (1 - fx) + at(gxi + 1, gyi + 1) * fx) * fy;
            uint8_t b = static_cast<uint8_t>(std::lround(v));
            scratch_cov[x - sbox.x0] = b;
            any |= b != 0;
          }
        }
        if (!any && !IsUnbounded(op)) continue;
        const uint8_t* clip = params.clip ? params.clip->At(y, sbox.x0) : nullptr;
        CompositeSpan(op, surface_->Row(y) + 4 * sbox.x0, nullptr, shadow_solid, scratch_cov.data(), clip, alpha, sw);
      }
    }
    // The shape itself. Bounded operators: only the rows and columns the shape was rendered into (pb); the rest of
    // the box would composite transparent pixels, which bounded operators leave unchanged.
    if (!IsUnbounded(op)) {
      for (int y = pb.y0; pw > 0 && y < pb.y1; y++) {
        const uint8_t* clip = params.clip ? params.clip->At(y, pb.x0) : nullptr;
        CompositeSpan(op, surface_->Row(y) + 4 * pb.x0, pix.data() + static_cast<size_t>(y - pb.y0) * pw * 4, nullptr,
                      nullptr, clip, alpha, pw);
      }
      return;
    }
    std::vector<uint8_t> row(static_cast<size_t>(box.x1 - box.x0) * 4);
    for (int y = box.y0; y < box.y1; y++) {
      std::fill(row.begin(), row.end(), 0);
      if (pw > 0 && y >= pb.y0 && y < pb.y1) {
        std::memcpy(row.data() + (pb.x0 - box.x0) * 4, pix.data() + static_cast<size_t>(y - pb.y0) * pw * 4,
                    static_cast<size_t>(pw) * 4);
      }
      const uint8_t* clip = params.clip ? params.clip->At(y, box.x0) : nullptr;
      CompositeSpan(op, surface_->Row(y) + 4 * box.x0, row.data(), nullptr, nullptr, clip, alpha, box.x1 - box.x0);
    }
    return;
  }

  if (!IsUnbounded(op)) {
    raster_->Sweep(rule, [&](int y, int x0, int x1, const uint8_t* cov) {
      int n = x1 - x0;
      const uint8_t* clip = params.clip ? params.clip->At(y, x0) : nullptr;
      const uint8_t* src = nullptr;
      if (!solid) {
        scratch_src.resize(static_cast<size_t>(n) * 4);
        shader.ShadeRow(y, x0, n, scratch_src.data());
        src = scratch_src.data();
      }
      CompositeSpan(op, surface_->Row(y) + 4 * x0, src, solid, cov, clip, alpha, n);
    });
    return;
  }

  // Unbounded operators touch every pixel inside the clip: build the full coverage plane first.
  int bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  std::vector<uint8_t> plane(static_cast<size_t>(bw) * bh, 0);
  raster_->Sweep(rule, [&](int y, int x0, int x1, const uint8_t* cov) {
    if (y < box.y0 || y >= box.y1) return;
    int a = std::max(x0, box.x0), b = std::min(x1, box.x1);
    if (b > a) std::memcpy(plane.data() + static_cast<size_t>(y - box.y0) * bw + (a - box.x0), cov + (a - x0), b - a);
  });
  for (int y = box.y0; y < box.y1; y++) {
    const uint8_t* clip = params.clip ? params.clip->At(y, box.x0) : nullptr;
    const uint8_t* src = nullptr;
    if (!solid) {
      scratch_src.resize(static_cast<size_t>(bw) * 4);
      shader.ShadeRow(y, box.x0, bw, scratch_src.data());
      src = scratch_src.data();
    }
    CompositeSpan(op, surface_->Row(y) + 4 * box.x0, src, solid, plane.data() + static_cast<size_t>(y - box.y0) * bw,
                  clip, alpha, bw);
  }
}

void Canvas::Fill(PathView path, bool path_in_device, FillRule rule, const Paint& paint, const DrawParams& params) {
  OpScope op_scope(this);
  if (!params.ctm.IsFinite()) return;
  if (!path_in_device && !params.ctm.Invertible()) return;
  IntRect box = DrawBox(params);
  if (box.Empty()) return;
  raster_->Reset(RasterBox(box, params));
  AddPathToRasterizer(path, path_in_device ? Matrix::Identity() : params.ctm, raster_);
  raster_->Finish();
  // (A split shadow source is rasterised later: no coverage in the box can still cast a visible shadow.)
  if (!raster_->HasCoverage() && !IsUnbounded(params.op) && !ComputeShadowBoxes(box, params).split) return;
  DrawCoverage(rule, 1.0, paint, nullptr, nullptr, nullptr, params, [&](Rasterizer* r) {
    AddPathToRasterizer(path, path_in_device ? Matrix::Identity() : params.ctm, r);
  });
}

namespace {
StrokeParams ToParams(const StrokeStyle& s) {
  StrokeParams p;
  p.width = s.width;
  p.cap = s.cap;
  p.join = s.join;
  p.miter_limit = s.miter_limit;
  p.dash = s.dash.empty() ? nullptr : s.dash.data();
  p.dash_count = static_cast<int>(s.dash.size());
  p.dash_offset = s.dash_offset;
  return p;
}
}  // namespace

void Canvas::Stroke(PathView path, bool path_in_device, const StrokeStyle& style, const Paint& paint,
                    const DrawParams& params) {
  OpScope op_scope(this);
  if (!params.ctm.Invertible()) return;
  IntRect box = DrawBox(params);
  if (box.Empty()) return;
  raster_->Reset(RasterBox(box, params));
  Matrix to_user = path_in_device ? params.ctm.Inverse() : Matrix::Identity();
  double alpha = StrokeToRasterizer(path, to_user, params.ctm, ToParams(style), raster_);
  raster_->Finish();
  if (alpha <= 0) return;
  // (A split shadow source is rasterised later: no coverage in the box can still cast a visible shadow.)
  if (!raster_->HasCoverage() && !IsUnbounded(params.op) && !ComputeShadowBoxes(box, params).split) return;
  DrawCoverage(FillRule::kNonZero, alpha, paint, nullptr, nullptr, nullptr, params, [&](Rasterizer* r) {
    StrokeToRasterizer(path, to_user, params.ctm, ToParams(style), r);
  });
}

void Canvas::ClearRect(double x, double y, double w, double h, const DrawParams& params) {
  if (!params.ctm.Invertible()) return;
  float rect[] = {kVerbMove,
                  static_cast<float>(x),
                  static_cast<float>(y),
                  kVerbLine,
                  static_cast<float>(x + w),
                  static_cast<float>(y),
                  kVerbLine,
                  static_cast<float>(x + w),
                  static_cast<float>(y + h),
                  kVerbLine,
                  static_cast<float>(x),
                  static_cast<float>(y + h),
                  kVerbClose};
  DrawParams p;
  p.ctm = params.ctm;
  p.clip = params.clip;
  p.op = CompositeOp::kDestinationOut;
  Paint black;
  black.color = Color{0, 0, 0, 1};
  Fill(PathView{rect, sizeof(rect) / sizeof(rect[0])}, false, FillRule::kNonZero, black, p);
}

void Canvas::DrawImageTransformed(const ImageView& image, const Matrix& image_to_user, const DrawParams& params) {
  OpScope op_scope(this);
  if (image.width <= 0 || image.height <= 0) return;
  Matrix image_to_device = params.ctm * image_to_user;
  if (!image_to_device.Invertible()) return;
  IntRect box = DrawBox(params);
  if (box.Empty()) return;
  // Drawing a canvas onto itself: snapshot first.
  std::shared_ptr<OwnedImage> copy;
  ImageView src = image;
  const uint8_t* sb = surface_->data();
  if (image.data >= sb && image.data < sb + surface_->byte_size()) {
    copy = OwnedImage::CopyFrom(image);
    src = copy->View();
  }
  float w = static_cast<float>(image.width), h = static_cast<float>(image.height);
  float rect[] = {kVerbMove, 0, 0, kVerbLine, w, 0, kVerbLine, w, h, kVerbLine, 0, h, kVerbClose};
  raster_->Reset(RasterBox(box, params));
  AddPathToRasterizer(PathView{rect, sizeof(rect) / sizeof(rect[0])}, image_to_device, raster_);
  raster_->Finish();
  // (A split shadow source is rasterised later: no coverage in the box can still cast a visible shadow.)
  if (!raster_->HasCoverage() && !IsUnbounded(params.op) && !ComputeShadowBoxes(box, params).split) return;
  Matrix inv = image_to_device.Inverse();
  IntRect clamp{0, 0, image.width, image.height};
  Paint none;
  DrawCoverage(FillRule::kNonZero, 1.0, none, &src, &inv, &clamp, params, [&](Rasterizer* r) {
    AddPathToRasterizer(PathView{rect, sizeof(rect) / sizeof(rect[0])}, image_to_device, r);
  });
}

void Canvas::DrawImage(const ImageView& image, double sx, double sy, double sw, double sh, double dx, double dy,
                       double dw, double dh, const DrawParams& params) {
  OpScope op_scope(this);
  if (image.width <= 0 || image.height <= 0) return;
  if (sw < 0) sx += sw, sw = -sw;
  if (sh < 0) sy += sh, sh = -sh;
  if (dw < 0) dx += dw, dw = -dw;
  if (dh < 0) dy += dh, dh = -dh;
  if (sw == 0 || sh == 0 || dw == 0 || dh == 0) return;
  // Clip the source rect to the image; shrink the destination in proportion.
  double kx = dw / sw, ky = dh / sh;
  double cx0 = std::max(sx, 0.0), cy0 = std::max(sy, 0.0);
  double cx1 = std::min(sx + sw, double(image.width)), cy1 = std::min(sy + sh, double(image.height));
  if (cx1 <= cx0 || cy1 <= cy0) return;
  double ndx = dx + (cx0 - sx) * kx, ndy = dy + (cy0 - sy) * ky;
  double ndw = (cx1 - cx0) * kx, ndh = (cy1 - cy0) * ky;
  Matrix image_to_device = params.ctm * Matrix{kx, 0, 0, ky, ndx - cx0 * kx, ndy - cy0 * ky};
  if (!image_to_device.Invertible()) return;
  IntRect box = DrawBox(params);
  if (box.Empty()) return;
  std::shared_ptr<OwnedImage> copy;
  ImageView src = image;
  const uint8_t* sb = surface_->data();
  if (image.data >= sb && image.data < sb + surface_->byte_size()) {
    copy = OwnedImage::CopyFrom(image);
    src = copy->View();
  }
  float rect[] = {kVerbMove,
                  static_cast<float>(ndx),
                  static_cast<float>(ndy),
                  kVerbLine,
                  static_cast<float>(ndx + ndw),
                  static_cast<float>(ndy),
                  kVerbLine,
                  static_cast<float>(ndx + ndw),
                  static_cast<float>(ndy + ndh),
                  kVerbLine,
                  static_cast<float>(ndx),
                  static_cast<float>(ndy + ndh),
                  kVerbClose};
  raster_->Reset(RasterBox(box, params));
  AddPathToRasterizer(PathView{rect, sizeof(rect) / sizeof(rect[0])}, params.ctm, raster_);
  raster_->Finish();
  // (A split shadow source is rasterised later: no coverage in the box can still cast a visible shadow.)
  if (!raster_->HasCoverage() && !IsUnbounded(params.op) && !ComputeShadowBoxes(box, params).split) return;
  Matrix inv = image_to_device.Inverse();
  IntRect clamp{static_cast<int>(std::floor(cx0)), static_cast<int>(std::floor(cy0)),
                static_cast<int>(std::ceil(cx1)), static_cast<int>(std::ceil(cy1))};
  Paint none;
  DrawCoverage(FillRule::kNonZero, 1.0, none, &src, &inv, &clamp, params, [&](Rasterizer* r) {
    AddPathToRasterizer(PathView{rect, sizeof(rect) / sizeof(rect[0])}, params.ctm, r);
  });
}

std::unique_ptr<ClipMask> Canvas::MakeClip(PathView path, bool path_in_device, FillRule rule, const Matrix& ctm,
                                           const ClipMask* parent) {
  OpScope op_scope(this);
  auto mask = std::make_unique<ClipMask>();
  mask->width = surface_->width();
  mask->height = surface_->height();
  IntRect box = surface_->Bounds();
  if (parent) box = box.Intersect(parent->bounds);
  bool ok = ctm.IsFinite() && (path_in_device || ctm.Invertible());
  if (box.Empty() || !ok) return mask;
  raster_->Reset(box);
  AddPathToRasterizer(path, path_in_device ? Matrix::Identity() : ctm, raster_);
  raster_->Finish();
  // The mask stores only the area the path can cover (not the whole canvas).
  IntRect area = raster_->Bounds().Intersect(box);
  if (area.Empty()) return mask;
  mask->area = area;
  mask->stride = area.x1 - area.x0;
  mask->alpha.assign(static_cast<size_t>(mask->stride) * (area.y1 - area.y0), 0);
  int minx = area.x1, miny = area.y1, maxx = -1, maxy = -1;
  raster_->Sweep(rule, [&](int y, int x0, int x1, const uint8_t* cov) {
    if (y < area.y0 || y >= area.y1) return;
    int a = std::max(x0, area.x0), b = std::min(x1, area.x1);
    if (b <= a) return;
    uint8_t* row = mask->At(y, a);
    const uint8_t* prow = parent ? parent->At(y, a) : nullptr;
    for (int x = a; x < b; x++) {
      uint8_t v = cov[x - x0];
      if (prow) v = static_cast<uint8_t>(Div255(v * prow[x - a]));
      row[x - a] = v;
      if (v) {
        minx = std::min(minx, x);
        maxx = std::max(maxx, x);
        miny = std::min(miny, y);
        maxy = std::max(maxy, y);
      }
    }
  });
  mask->bounds = maxx >= 0 ? IntRect{minx, miny, maxx + 1, maxy + 1} : IntRect{};
  return mask;
}

bool Canvas::IsPointInPath(PathView path, bool path_in_device, const Matrix& ctm, double x, double y, FillRule rule) {
  if (!std::isfinite(x) || !std::isfinite(y)) return false;
  if (!path_in_device && !ctm.Invertible()) return false;
  return PointInPath(path, path_in_device ? Matrix::Identity() : ctm, x, y, rule);
}

bool Canvas::IsPointInStroke(PathView path, bool path_in_device, const Matrix& ctm, const StrokeStyle& style, double x,
                             double y) {
  if (!std::isfinite(x) || !std::isfinite(y) || !ctm.Invertible()) return false;
  std::vector<std::vector<double>> polys;
  StrokeStyle s = style;
  StrokeToPolygons(path, path_in_device ? ctm.Inverse() : Matrix::Identity(), ctm, ToParams(s), &polys);
  return PointInPolygons(polys, x, y);
}

void Canvas::GetImageData(int x, int y, int w, int h, uint8_t* out) const {
  std::memset(out, 0, static_cast<size_t>(w) * h * 4);
  int sw = surface_->width(), sh = surface_->height();
  for (int j = 0; j < h; j++) {
    int64_t sy = int64_t(y) + j;
    if (sy < 0 || sy >= sh) continue;
    const uint8_t* row = surface_->Row(static_cast<int>(sy));
    uint8_t* o = out + static_cast<size_t>(j) * w * 4;
    for (int i = 0; i < w; i++) {
      int64_t sx = int64_t(x) + i;
      if (sx < 0 || sx >= sw) continue;
      const uint8_t* p = row + sx * 4;
      uint32_t a = p[3];
      if (a == 0) continue;
      if (a == 255) {
        std::memcpy(o + 4 * i, p, 4);
        continue;
      }
      for (int c = 0; c < 3; c++) o[4 * i + c] = static_cast<uint8_t>(std::min<uint32_t>(255, (p[c] * 255 + a / 2) / a));
      o[4 * i + 3] = static_cast<uint8_t>(a);
    }
  }
}

void Canvas::PutImageData(const uint8_t* data, int data_w, int data_h, int dx, int dy, int dirty_x, int dirty_y,
                          int dirty_w, int dirty_h) {
  int64_t x0 = dirty_x, y0 = dirty_y, w = dirty_w, h = dirty_h;
  if (w < 0) x0 += w, w = -w;
  if (h < 0) y0 += h, h = -h;
  if (x0 < 0) w += x0, x0 = 0;
  if (y0 < 0) h += y0, y0 = 0;
  if (x0 + w > data_w) w = data_w - x0;
  if (y0 + h > data_h) h = data_h - y0;
  if (w <= 0 || h <= 0) return;
  int sw = surface_->width(), sh = surface_->height();
  surface_->Touch();
  for (int64_t j = y0; j < y0 + h; j++) {
    int64_t ty = dy + j;
    if (ty < 0 || ty >= sh) continue;
    uint8_t* row = surface_->Row(static_cast<int>(ty));
    const uint8_t* src = data + static_cast<size_t>(j) * data_w * 4;
    for (int64_t i = x0; i < x0 + w; i++) {
      int64_t tx = dx + i;
      if (tx < 0 || tx >= sw) continue;
      const uint8_t* s = src + i * 4;
      uint8_t* d = row + tx * 4;
      uint32_t a = s[3];
      d[0] = static_cast<uint8_t>(Div255(s[0] * a));
      d[1] = static_cast<uint8_t>(Div255(s[1] * a));
      d[2] = static_cast<uint8_t>(Div255(s[2] * a));
      d[3] = static_cast<uint8_t>(a);
    }
  }
}

void ReadPixels(const Surface& s, uint8_t* out, bool premultiplied, bool flip_y) {
  int w = s.width(), h = s.height();
  for (int y = 0; y < h; y++) {
    const uint8_t* row = s.Row(y);
    uint8_t* o = out + static_cast<size_t>(flip_y ? h - 1 - y : y) * w * 4;
    if (premultiplied) {
      std::memcpy(o, row, static_cast<size_t>(w) * 4);
      continue;
    }
    for (int x = 0; x < w; x++) {
      const uint8_t* p = row + 4 * x;
      uint32_t a = p[3];
      if (a == 255 || a == 0) {
        std::memcpy(o + 4 * x, p, 4);
        continue;
      }
      for (int c = 0; c < 3; c++) o[4 * x + c] = static_cast<uint8_t>(std::min<uint32_t>(255, (p[c] * 255 + a / 2) / a));
      o[4 * x + 3] = static_cast<uint8_t>(a);
    }
  }
}

bool EncodeImage(const Surface& s, const std::string& mime, double quality, std::vector<uint8_t>* out,
                 std::string* used_mime) {
  int w = s.width(), h = s.height();
  out->clear();
  if (w == 0 || h == 0) return false;
  std::vector<uint8_t> rgba(static_cast<size_t>(w) * h * 4);
  if (mime == "image/jpeg") {
    // No alpha in JPEG: composite onto opaque black (premultiplied colour is exactly that).
    ReadPixels(s, rgba.data(), true, false);
    std::vector<uint8_t> rgb(static_cast<size_t>(w) * h * 3);
    for (size_t i = 0, n = static_cast<size_t>(w) * h; i < n; i++) {
      rgb[3 * i] = rgba[4 * i];
      rgb[3 * i + 1] = rgba[4 * i + 1];
      rgb[3 * i + 2] = rgba[4 * i + 2];
    }
    int q = (quality >= 0 && quality <= 1) ? static_cast<int>(std::lround(quality * 100)) : 92;
    if (q < 1) q = 1;
    if (EncodeJpeg(rgb.data(), w, h, q, out)) {
      *used_mime = "image/jpeg";
      return true;
    }
  }
  ReadPixels(s, rgba.data(), false, false);
  if (!EncodePng(rgba.data(), w, h, out)) return false;
  *used_mime = "image/png";
  return true;
}

}  // namespace iwn::canvas2d
