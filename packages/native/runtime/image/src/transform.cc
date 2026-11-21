#include "iwn/image/transform.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace iwn::image {

const char* StatusName(Status status) {
  switch (status) {
    case Status::kOk: return "ok";
    case Status::kUnsupported: return "unsupported";
    case Status::kCorrupt: return "corrupt";
    case Status::kTooLarge: return "too-large";
    case Status::kOutOfMemory: return "out-of-memory";
    case Status::kInvalidArgument: return "invalid-argument";
    case Status::kCancelled: return "cancelled";
  }
  return "unknown";
}

namespace {

// 2x2 integer matrices mapping a source vector (x right, y down, centred) to the displayed vector.
struct Mat2 {
  int a, b, c, d;  // [[a, b], [c, d]]
};

constexpr Mat2 kOrientation[9] = {
    {1, 0, 0, 1},    // 0: unused (treated as 1)
    {1, 0, 0, 1},    // 1 identity
    {-1, 0, 0, 1},   // 2 mirror X
    {-1, 0, 0, -1},  // 3 rotate 180
    {1, 0, 0, -1},   // 4 mirror Y
    {0, 1, 1, 0},    // 5 transpose
    {0, -1, 1, 0},   // 6 rotate 90 CW
    {0, -1, -1, 0},  // 7 transverse
    {0, 1, -1, 0},   // 8 rotate 90 CCW
};

int Normalize(int orientation) { return (orientation >= 1 && orientation <= 8) ? orientation : 1; }

int FindOrientation(const Mat2& m) {
  for (int i = 1; i <= 8; ++i) {
    const Mat2& o = kOrientation[i];
    if (o.a == m.a && o.b == m.b && o.c == m.c && o.d == m.d) return i;
  }
  return 1;
}

inline uint8_t Premul(uint8_t c, uint8_t a) {
  const unsigned prod = static_cast<unsigned>(c) * a + 128;
  return static_cast<uint8_t>((prod + (prod >> 8)) >> 8);  // round(c * a / 255)
}

inline uint8_t Unpremul(uint8_t c, uint8_t a) {
  if (a == 0) return 0;
  if (a == 255) return c;
  const unsigned v = (static_cast<unsigned>(c) * 255 + a / 2) / a;
  return static_cast<uint8_t>(v > 255 ? 255 : v);
}

enum class AlphaOp { kNone, kPremultiply, kUnpremultiply };

AlphaOp NeededAlphaOp(AlphaMode in, bool opaque, AlphaRequest want) {
  if (opaque || want == AlphaRequest::kKeep) return AlphaOp::kNone;
  if (want == AlphaRequest::kPremultiplied && in == AlphaMode::kUnpremultiplied) return AlphaOp::kPremultiply;
  if (want == AlphaRequest::kUnpremultiplied && in == AlphaMode::kPremultiplied) return AlphaOp::kUnpremultiply;
  return AlphaOp::kNone;
}

AlphaMode ResultAlpha(AlphaMode in, AlphaRequest want) {
  switch (want) {
    case AlphaRequest::kKeep: return in;
    case AlphaRequest::kPremultiplied: return AlphaMode::kPremultiplied;
    case AlphaRequest::kUnpremultiplied: return AlphaMode::kUnpremultiplied;
  }
  return in;
}

void ApplyAlphaRow(uint8_t* row, uint32_t pixels, AlphaOp op) {
  if (op == AlphaOp::kPremultiply) PremultiplyRow(row, pixels);
  if (op == AlphaOp::kUnpremultiply) UnpremultiplyRow(row, pixels);
}

struct Geometry {
  uint32_t oriented_w = 0, oriented_h = 0;  // after orientation
  Rect crop;                                // in oriented coordinates
  uint32_t out_w = 0, out_h = 0;            // after resize
  bool resize = false;
  bool full_crop = true;
};

Status ComputeGeometry(uint32_t w, uint32_t h, const ProcessOptions& o, Geometry* g) {
  const int orient = Normalize(o.orientation);
  g->oriented_w = OrientationSwapsAxes(orient) ? h : w;
  g->oriented_h = OrientationSwapsAxes(orient) ? w : h;
  if (o.has_crop) {
    if (o.crop.width <= 0 || o.crop.height <= 0) return Status::kInvalidArgument;
    g->crop = o.crop;
  } else {
    g->crop = Rect{0, 0, g->oriented_w, g->oriented_h};
  }
  g->full_crop = g->crop.x == 0 && g->crop.y == 0 && g->crop.width == g->oriented_w &&
                 g->crop.height == g->oriented_h;
  if (g->crop.width > 0x7fffffff || g->crop.height > 0x7fffffff) return Status::kTooLarge;
  g->out_w = o.resize_width ? o.resize_width : static_cast<uint32_t>(g->crop.width);
  g->out_h = o.resize_height ? o.resize_height : static_cast<uint32_t>(g->crop.height);
  g->resize = g->out_w != g->crop.width || g->out_h != g->crop.height;
  return Status::kOk;
}

// Copies the oriented, cropped and (optionally) flipped region of `src` into `dst` (crop.width x crop.height).
void Gather(const PixelView& src, int orientation, const Rect& crop, bool flip_y, const MutablePixelView& dst) {
  const Mat2& m = kOrientation[Normalize(orientation)];
  // Inverse (transpose) maps displayed vectors back to source vectors.
  const int ia = m.a, ib = m.c, ic = m.b, id = m.d;
  const int64_t sw = src.width, sh = src.height;
  const int64_t ow = OrientationSwapsAxes(orientation) ? sh : sw;
  const int64_t oh = OrientationSwapsAxes(orientation) ? sw : sh;
  for (uint32_t y = 0; y < dst.height; ++y) {
    uint8_t* out = dst.data + y * dst.stride;
    const int64_t oy = crop.y + (flip_y ? (dst.height - 1 - y) : y);
    if (oy < 0 || oy >= oh) {
      std::memset(out, 0, static_cast<size_t>(dst.width) * 4);
      continue;
    }
    // Doubled, centred coordinates keep everything integral: X = 2*ox - (ow - 1).
    const int64_t Y = 2 * oy - (oh - 1);
    for (uint32_t x = 0; x < dst.width; ++x) {
      const int64_t ox = crop.x + x;
      uint8_t* px = out + x * 4;
      if (ox < 0 || ox >= ow) {
        std::memset(px, 0, 4);
        continue;
      }
      const int64_t X = 2 * ox - (ow - 1);
      const int64_t SX = ia * X + ib * Y;
      const int64_t SY = ic * X + id * Y;
      const int64_t sx = (SX + (sw - 1)) / 2;
      const int64_t sy = (SY + (sh - 1)) / 2;
      std::memcpy(px, src.data + sy * src.stride + sx * 4, 4);
    }
  }
}

// --- separable resampling ---------------------------------------------------------------------------------------

struct Taps {
  std::vector<int32_t> start;    // first source index per output index
  std::vector<int32_t> count;    // number of taps
  std::vector<int32_t> offset;   // into weights
  std::vector<float> weights;
};

Taps BuildTaps(uint32_t src, uint32_t dst, ResizeQuality q) {
  Taps t;
  t.start.resize(dst);
  t.count.resize(dst);
  t.offset.resize(dst);
  const double scale = static_cast<double>(src) / dst;
  const bool shrink = scale > 1.0;
  std::vector<float> tmp;
  for (uint32_t i = 0; i < dst; ++i) {
    tmp.clear();
    int32_t first = 0;
    if (q == ResizeQuality::kPixelated) {
      int64_t idx = static_cast<int64_t>(std::floor((i + 0.5) * scale));
      first = static_cast<int32_t>(std::clamp<int64_t>(idx, 0, src - 1));
      tmp.push_back(1.0f);
    } else if (!shrink || q == ResizeQuality::kLow) {
      const double c = (i + 0.5) * scale - 0.5;
      double fl = std::floor(c);
      double f = c - fl;
      int64_t i0 = static_cast<int64_t>(fl), i1 = i0 + 1;
      if (i0 < 0) { i0 = 0; f = 0; }
      if (i1 > static_cast<int64_t>(src) - 1) { i1 = src - 1; }
      if (i0 > static_cast<int64_t>(src) - 1) { i0 = src - 1; }
      first = static_cast<int32_t>(i0);
      if (i1 == i0) {
        tmp.push_back(1.0f);
      } else {
        tmp.push_back(static_cast<float>(1.0 - f));
        tmp.push_back(static_cast<float>(f));
      }
    } else if (q == ResizeQuality::kMedium) {
      // Area average over [i*scale, (i+1)*scale).
      const double lo = i * scale, hi = (i + 1) * scale;
      int64_t a = static_cast<int64_t>(std::floor(lo));
      int64_t b = std::min<int64_t>(static_cast<int64_t>(std::ceil(hi)), src);
      first = static_cast<int32_t>(a);
      double sum = 0;
      for (int64_t s = a; s < b; ++s) {
        const double w = std::min<double>(s + 1, hi) - std::max<double>(s, lo);
        tmp.push_back(static_cast<float>(w));
        sum += w;
      }
      for (float& w : tmp) w = static_cast<float>(w / sum);
    } else {
      // Tent of radius `scale` around the output centre.
      const double c = (i + 0.5) * scale;  // in continuous source coordinates
      int64_t a = std::max<int64_t>(0, static_cast<int64_t>(std::floor(c - scale)));
      int64_t b = std::min<int64_t>(src, static_cast<int64_t>(std::ceil(c + scale)));
      first = static_cast<int32_t>(a);
      double sum = 0;
      for (int64_t s = a; s < b; ++s) {
        const double w = std::max(0.0, 1.0 - std::fabs((s + 0.5) - c) / scale);
        tmp.push_back(static_cast<float>(w));
        sum += w;
      }
      if (sum <= 0) {
        tmp.assign(1, 1.0f);
        first = static_cast<int32_t>(std::clamp<int64_t>(static_cast<int64_t>(c), 0, src - 1));
      } else {
        for (float& w : tmp) w = static_cast<float>(w / sum);
      }
    }
    t.start[i] = first;
    t.count[i] = static_cast<int32_t>(tmp.size());
    t.offset[i] = static_cast<int32_t>(t.weights.size());
    t.weights.insert(t.weights.end(), tmp.begin(), tmp.end());
  }
  return t;
}

// Resizes `src` (premultiplied or opaque) into `dst`. Works row by row: for each output row, accumulate the
// contributing source rows (vertical pass) into one float row, then filter it horizontally.
void Resample(const PixelView& src, bool premultiply_input, const MutablePixelView& dst, ResizeQuality q,
              bool unpremultiply_output) {
  const Taps h = BuildTaps(src.width, dst.width, q);
  const Taps v = BuildTaps(src.height, dst.height, q);
  std::vector<float> row(static_cast<size_t>(src.width) * 4);
  std::vector<uint8_t> premul_row(premultiply_input ? static_cast<size_t>(src.width) * 4 : 0);
  for (uint32_t y = 0; y < dst.height; ++y) {
    std::fill(row.begin(), row.end(), 0.0f);
    for (int32_t k = 0; k < v.count[y]; ++k) {
      const float w = v.weights[v.offset[y] + k];
      const uint8_t* s = src.data + static_cast<size_t>(v.start[y] + k) * src.stride;
      if (premultiply_input) {
        std::memcpy(premul_row.data(), s, premul_row.size());
        PremultiplyRow(premul_row.data(), src.width);
        s = premul_row.data();
      }
      for (size_t i = 0; i < row.size(); ++i) row[i] += w * s[i];
    }
    uint8_t* out = dst.data + y * dst.stride;
    for (uint32_t x = 0; x < dst.width; ++x) {
      float acc[4] = {0, 0, 0, 0};
      const float* ws = &h.weights[h.offset[x]];
      const float* sp = &row[static_cast<size_t>(h.start[x]) * 4];
      for (int32_t k = 0; k < h.count[x]; ++k) {
        acc[0] += ws[k] * sp[k * 4 + 0];
        acc[1] += ws[k] * sp[k * 4 + 1];
        acc[2] += ws[k] * sp[k * 4 + 2];
        acc[3] += ws[k] * sp[k * 4 + 3];
      }
      for (int c = 0; c < 4; ++c) {
        const float val = std::round(acc[c]);
        out[x * 4 + c] = static_cast<uint8_t>(val < 0 ? 0 : (val > 255 ? 255 : val));
      }
      // Premultiplied colour can never exceed alpha.
      if (out[x * 4 + 0] > out[x * 4 + 3] || out[x * 4 + 1] > out[x * 4 + 3] || out[x * 4 + 2] > out[x * 4 + 3]) {
        const uint8_t a = out[x * 4 + 3];
        for (int c = 0; c < 3; ++c) out[x * 4 + c] = std::min(out[x * 4 + c], a);
      }
    }
    if (unpremultiply_output) UnpremultiplyRow(out, dst.width);
  }
}

Status ProcessImpl(const PixelView& in, std::unique_ptr<PixelStore> owned, const ProcessOptions& o,
                   std::unique_ptr<PixelStore>* out) {
  Geometry g;
  Status st = ComputeGeometry(in.width, in.height, o, &g);
  if (st != Status::kOk) return st;
  const int orient = Normalize(o.orientation);
  const AlphaMode result_alpha = ResultAlpha(in.alpha, o.alpha);
  const AlphaOp alpha_op = NeededAlphaOp(in.alpha, in.opaque, o.alpha);
  const bool geometry_identity = orient == 1 && g.full_crop && !g.resize;

  // Fast paths that reuse an owned heap store: identity, flip only, alpha change only.
  if (owned && geometry_identity && o.allocator == HeapAllocator && owned->backing() == PixelStore::Backing::kHeap) {
    MutablePixelView mv = owned->LockWrite();
    if (o.flip_y) {
      std::vector<uint8_t> tmp(static_cast<size_t>(mv.width) * 4);
      for (uint32_t y = 0; y < mv.height / 2; ++y) {
        uint8_t* a = mv.data + y * mv.stride;
        uint8_t* b = mv.data + (mv.height - 1 - y) * mv.stride;
        std::memcpy(tmp.data(), a, tmp.size());
        std::memcpy(a, b, tmp.size());
        std::memcpy(b, tmp.data(), tmp.size());
      }
    }
    if (alpha_op != AlphaOp::kNone) {
      for (uint32_t y = 0; y < mv.height; ++y) ApplyAlphaRow(mv.data + y * mv.stride, mv.width, alpha_op);
    }
    owned->UnlockWrite();
    owned->set_alpha(result_alpha);
    *out = std::move(owned);
    return Status::kOk;
  }

  if (g.out_w == 0 || g.out_h == 0) return Status::kInvalidArgument;
  // Output and the intermediate crop-sized stage are both bounded (a huge source rectangle with a tiny resize would
  // otherwise allocate the whole rectangle).
  auto too_big = [](uint64_t w, uint64_t h) { return w > 32768 || h > 32768 || w * h > (uint64_t{1} << 28); };
  if (too_big(g.out_w, g.out_h) || too_big(static_cast<uint64_t>(g.crop.width), static_cast<uint64_t>(g.crop.height))) {
    return Status::kTooLarge;
  }

  // Stage 1: orientation + crop + flip into a store of crop size. Skipped when only resizing (then resample straight
  // from the input and flip afterwards).
  const bool gather_identity = orient == 1 && g.full_crop;
  std::unique_ptr<PixelStore> stage;
  PixelView resample_src = in;
  const bool cropped_has_transparency =
      g.crop.x < 0 || g.crop.y < 0 || g.crop.x + g.crop.width > g.oriented_w || g.crop.y + g.crop.height > g.oriented_h;
  const bool stage_opaque = in.opaque && !cropped_has_transparency;
  // HTML ("cropped to the source rectangle with formatting") scales first and flips afterwards. Nearest sampling is
  // not symmetric at ties, so the order matters for 'pixelated': whenever there is a resize, flip after it.
  const bool flip_after_resample = g.resize && o.flip_y;
  if (!gather_identity || !g.resize) {
    const bool final_stage = !g.resize;
    const uint32_t cw = static_cast<uint32_t>(g.crop.width), ch = static_cast<uint32_t>(g.crop.height);
    stage = final_stage ? o.allocator(cw, ch) : PixelStore::AllocateHeap(cw, ch);
    if (!stage) return Status::kOutOfMemory;
    MutablePixelView mv = stage->LockWrite();
    if (!mv.data) return Status::kOutOfMemory;
    Gather(in, orient, g.crop, o.flip_y && !g.resize, mv);
    if (final_stage && alpha_op != AlphaOp::kNone) {
      for (uint32_t y = 0; y < mv.height; ++y) ApplyAlphaRow(mv.data + y * mv.stride, mv.width, alpha_op);
    }
    stage->UnlockWrite();
    stage->set_alpha(final_stage ? result_alpha : in.alpha);
    stage->set_opaque(stage_opaque);
    if (final_stage) {
      *out = std::move(stage);
      return Status::kOk;
    }
    ScopedPixels sp = stage->Read();
    resample_src = sp.view();  // heap store: the pointer stays valid after the (no-op) lock is dropped
  }

  // Stage 2: resample. Work in premultiplied space unless opaque.
  std::unique_ptr<PixelStore> result = o.allocator(g.out_w, g.out_h);
  if (!result) return Status::kOutOfMemory;
  MutablePixelView rv = result->LockWrite();
  if (!rv.data) return Status::kOutOfMemory;
  const bool opaque = resample_src.opaque;
  const bool premultiply_input = !opaque && resample_src.alpha == AlphaMode::kUnpremultiplied;
  const bool want_premul = (result_alpha == AlphaMode::kPremultiplied);
  Resample(resample_src, premultiply_input, rv, o.quality, !opaque && !want_premul);
  if (flip_after_resample) {
    std::vector<uint8_t> tmp(static_cast<size_t>(rv.width) * 4);
    for (uint32_t y = 0; y < rv.height / 2; ++y) {
      uint8_t* a = rv.data + y * rv.stride;
      uint8_t* b = rv.data + (rv.height - 1 - y) * rv.stride;
      std::memcpy(tmp.data(), a, tmp.size());
      std::memcpy(a, b, tmp.size());
      std::memcpy(b, tmp.data(), tmp.size());
    }
  }
  result->UnlockWrite();
  result->set_alpha(result_alpha);
  result->set_opaque(opaque);
  *out = std::move(result);
  return Status::kOk;
}

}  // namespace

int InverseOrientation(int orientation) {
  const Mat2& m = kOrientation[Normalize(orientation)];
  return FindOrientation(Mat2{m.a, m.c, m.b, m.d});
}

int ComposeOrientation(int first, int second) {
  const Mat2& f = kOrientation[Normalize(first)];
  const Mat2& s = kOrientation[Normalize(second)];
  // second * first
  return FindOrientation(Mat2{s.a * f.a + s.b * f.c, s.a * f.b + s.b * f.d, s.c * f.a + s.d * f.c,
                              s.c * f.b + s.d * f.d});
}

bool IsIdentity(uint32_t width, uint32_t height, AlphaMode input_alpha, bool input_opaque,
                const ProcessOptions& o) {
  Geometry g;
  if (ComputeGeometry(width, height, o, &g) != Status::kOk) return false;
  return Normalize(o.orientation) == 1 && g.full_crop && !g.resize && !o.flip_y &&
         NeededAlphaOp(input_alpha, input_opaque, o.alpha) == AlphaOp::kNone;
}

Status Process(std::unique_ptr<PixelStore> input, const ProcessOptions& options, std::unique_ptr<PixelStore>* out) {
  if (!input) return Status::kInvalidArgument;
  if (IsIdentity(input->width(), input->height(), input->alpha(), input->opaque(), options) &&
      (options.allocator == HeapAllocator || input->backing() != PixelStore::Backing::kHeap)) {
    *out = std::move(input);
    return Status::kOk;
  }
  ScopedPixels sp = input->Read();
  if (!sp.ok()) return Status::kOutOfMemory;
  PixelView view = sp.view();
  if (input->backing() == PixelStore::Backing::kHeap) {
    sp = ScopedPixels();  // heap memory needs no lock; the owned store may be reused in place
    return ProcessImpl(view, std::move(input), options, out);
  }
  return ProcessImpl(view, nullptr, options, out);
}

Status ProcessView(const PixelView& input, const ProcessOptions& options, std::unique_ptr<PixelStore>* out) {
  return ProcessImpl(input, nullptr, options, out);
}

void PremultiplyRow(uint8_t* p, uint32_t pixels) {
  for (uint32_t i = 0; i < pixels; ++i, p += 4) {
    const uint8_t a = p[3];
    if (a == 255) continue;
    p[0] = Premul(p[0], a);
    p[1] = Premul(p[1], a);
    p[2] = Premul(p[2], a);
  }
}

void UnpremultiplyRow(uint8_t* p, uint32_t pixels) {
  for (uint32_t i = 0; i < pixels; ++i, p += 4) {
    const uint8_t a = p[3];
    if (a == 255) continue;
    p[0] = Unpremul(p[0], a);
    p[1] = Unpremul(p[1], a);
    p[2] = Unpremul(p[2], a);
  }
}

bool CopyForUpload(const PixelView& src, bool flip_y, bool premultiply, uint8_t* dst, size_t dst_size) {
  const size_t row = static_cast<size_t>(src.width) * 4;
  if (dst_size < row * src.height) return false;
  AlphaOp op = AlphaOp::kNone;
  if (!src.opaque) {
    if (premultiply && src.alpha == AlphaMode::kUnpremultiplied) op = AlphaOp::kPremultiply;
    if (!premultiply && src.alpha == AlphaMode::kPremultiplied) op = AlphaOp::kUnpremultiply;
  }
  for (uint32_t y = 0; y < src.height; ++y) {
    const uint8_t* s = src.data + (flip_y ? (src.height - 1 - y) : y) * src.stride;
    uint8_t* d = dst + y * row;
    std::memcpy(d, s, row);
    ApplyAlphaRow(d, src.width, op);
  }
  return true;
}

}  // namespace iwn::image
