/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Canvas 2D raster core: surfaces, paints, clip masks and the drawing operations behind CanvasRenderingContext2D.
// Plain C++ (no V8). The JS layer (web/canvas2d) keeps the context state and the spec semantics (argument
// validation, save/restore, the current default path); this layer rasterises.
//
// Thread safety: a Surface and its Canvas belong to one thread at a time (the JS thread that owns the context).
// Gradient/Pattern objects are immutable after construction except AddStop (JS thread only).
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "iwn/canvas2d/types.h"

namespace iwn::canvas2d {

// Read-only pixels from any source (a canvas, a decoded image, ImageData). RGBA8, top row first.
struct ImageView {
  const uint8_t* data = nullptr;
  int width = 0;
  int height = 0;
  size_t stride = 0;  // bytes per row
  bool premultiplied = true;
};

// Largest canvas we allocate. HTML leaves the limit to the UA; these are Chrome's (32767 px per side, 2^28 pixels in
// total). Larger canvases still get a context, but their bitmap is 0x0: drawing does nothing and reads are transparent
// black. (IMG-3's decoded-image bound of 16384 px per side is separate.)
constexpr int kMaxDimension = 32767;
constexpr int64_t kMaxPixels = int64_t(16384) * 16384;

class Surface {
 public:
  Surface() = default;
  // Allocates width x height transparent black. A size that cannot be allocated leaves a 0x0 surface and returns
  // false (the canvas then behaves as having no pixels, like a browser's failed backing store).
  bool Resize(int width, int height);
  void Clear();

  int width() const { return width_; }
  int height() const { return height_; }
  size_t stride() const { return static_cast<size_t>(width_) * 4; }
  uint8_t* data() { return pixels_.data(); }
  const uint8_t* data() const { return pixels_.data(); }
  uint8_t* Row(int y) { return pixels_.data() + static_cast<size_t>(y) * stride(); }
  const uint8_t* Row(int y) const { return pixels_.data() + static_cast<size_t>(y) * stride(); }
  size_t byte_size() const { return pixels_.size(); }
  ImageView View() const { return {pixels_.data(), width_, height_, stride(), true}; }
  IntRect Bounds() const { return {0, 0, width_, height_}; }

  // Incremented on every change, so texture uploads (the WebGL binding) can skip unchanged canvases.
  uint64_t generation() const { return generation_; }
  void Touch() { generation_++; }

 private:
  int width_ = 0;
  int height_ = 0;
  std::vector<uint8_t> pixels_;
  uint64_t generation_ = 1;
};

// An owned premultiplied RGBA8 image (pattern snapshots, decoded colour glyphs).
struct OwnedImage {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> pixels;  // premultiplied, stride = width * 4
  ImageView View() const { return {pixels.data(), width, height, static_cast<size_t>(width) * 4, true}; }
  static std::shared_ptr<OwnedImage> CopyFrom(const ImageView& v);  // premultiplies if needed
};

class Gradient {
 public:
  enum class Kind : uint8_t { kLinear = 0, kRadial = 1, kConic = 2 };
  static constexpr int kLutSize = 1024;

  // linear: (x0, y0) -> (x1, y1); radial: (x0, y0, r0) -> (x1, y1, r1); conic: start angle, centre x, y.
  Gradient(Kind kind, const double* params);
  Kind kind() const { return kind_; }
  const double* params() const { return params_; }
  // Unpremultiplied colour, components 0..1. Stops keep insertion order among equal offsets (HTML).
  void AddStop(double offset, float r, float g, float b, float a);
  size_t stop_count() const { return stops_.size(); }
  // Premultiplied RGBA8 lookup table over t in [0, 1] (bytes R G B A per entry).
  const uint8_t* Lut() const;

 private:
  struct Stop {
    double offset;
    float r, g, b, a;
  };
  Kind kind_;
  double params_[6] = {0, 0, 0, 0, 0, 0};
  std::vector<Stop> stops_;
  mutable std::vector<uint8_t> lut_;
  mutable bool lut_dirty_ = true;
};

class Pattern {
 public:
  Pattern(std::shared_ptr<const OwnedImage> image, bool repeat_x, bool repeat_y)
      : image_(std::move(image)), repeat_x_(repeat_x), repeat_y_(repeat_y) {}
  void SetTransform(const Matrix& m) { transform_ = m; }
  const Matrix& transform() const { return transform_; }
  const OwnedImage& image() const { return *image_; }
  bool repeat_x() const { return repeat_x_; }
  bool repeat_y() const { return repeat_y_; }

 private:
  std::shared_ptr<const OwnedImage> image_;
  bool repeat_x_, repeat_y_;
  Matrix transform_;
};

// Anti-aliased clip region: one coverage byte per canvas pixel; zero outside `bounds`.
// Coverage of the clip region. Only `area` (device pixels) is stored; `bounds` (inside `area`) is where the coverage
// is non-zero, and drawing is limited to it, so At() is only called for pixels inside `area`.
struct ClipMask {
  int width = 0;   // canvas size when the clip was made
  int height = 0;
  IntRect bounds;
  IntRect area;
  int stride = 0;
  std::vector<uint8_t> alpha;  // stride * (area.y1 - area.y0)
  const uint8_t* At(int y, int x) const {
    return alpha.data() + static_cast<size_t>(y - area.y0) * stride + (x - area.x0);
  }
  uint8_t* At(int y, int x) { return alpha.data() + static_cast<size_t>(y - area.y0) * stride + (x - area.x0); }
};

struct Paint {
  enum class Kind : uint8_t { kSolid = 0, kGradient = 1, kPattern = 2 };
  Kind kind = Kind::kSolid;
  Color color;  // premultiplied (solid)
  const Gradient* gradient = nullptr;
  const Pattern* pattern = nullptr;
};

struct Shadow {
  Color color;  // premultiplied
  double blur = 0;
  double offset_x = 0;
  double offset_y = 0;
  bool Active() const { return color.a > 0 && (blur > 0 || offset_x != 0 || offset_y != 0); }
};

struct DrawParams {
  Matrix ctm;
  float global_alpha = 1;
  CompositeOp op = CompositeOp::kSourceOver;
  bool smoothing = true;
  uint8_t smoothing_quality = 0;  // 0 low, 1 medium, 2 high
  Shadow shadow;
  const ClipMask* clip = nullptr;
};

struct StrokeStyle {
  double width = 1;
  LineCap cap = LineCap::kButt;
  LineJoin join = LineJoin::kMiter;
  double miter_limit = 10;
  std::vector<float> dash;  // even length (already duplicated if odd)
  double dash_offset = 0;
};

class Rasterizer;

class Canvas {
 public:
  explicit Canvas(Surface* surface);
  ~Canvas();
  Canvas(const Canvas&) = delete;
  Canvas& operator=(const Canvas&) = delete;

  Surface* surface() { return surface_; }

  // path_in_device: the points are already in device space (the context's current default path, transformed as it
  // was built); otherwise they are in user space and params.ctm applies (Path2D, rects, text).
  void Fill(PathView path, bool path_in_device, FillRule rule, const Paint& paint, const DrawParams& params);
  void Stroke(PathView path, bool path_in_device, const StrokeStyle& style, const Paint& paint,
              const DrawParams& params);
  // clearRect: transformed by ctm, clipped; ignores alpha, shadows and the composite operation.
  void ClearRect(double x, double y, double w, double h, const DrawParams& params);
  // Draws src rect of `image` into dst rect (user space). Rects may have negative sizes (normalised here). The source
  // rect is clipped to the image, the destination proportionally (HTML drawImage).
  void DrawImage(const ImageView& image, double sx, double sy, double sw, double sh, double dx, double dy, double dw,
                 double dh, const DrawParams& params);
  // Draws `image` mapped by image_to_user (colour glyph bitmaps).
  void DrawImageTransformed(const ImageView& image, const Matrix& image_to_user, const DrawParams& params);

  std::unique_ptr<ClipMask> MakeClip(PathView path, bool path_in_device, FillRule rule, const Matrix& ctm,
                                     const ClipMask* parent);

  bool IsPointInPath(PathView path, bool path_in_device, const Matrix& ctm, double x, double y, FillRule rule);
  bool IsPointInStroke(PathView path, bool path_in_device, const Matrix& ctm, const StrokeStyle& style, double x,
                       double y);

  // Unpremultiplied RGBA8 of the rect into out (w*h*4); pixels outside the surface read as transparent black.
  void GetImageData(int x, int y, int w, int h, uint8_t* out) const;
  // HTML putImageData: unpremultiplied source; dirty rect in image-data space; no compositing, transform or clip.
  void PutImageData(const uint8_t* data, int data_w, int data_h, int dx, int dy, int dirty_x, int dirty_y,
                    int dirty_w, int dirty_h);

 private:
  // `regeom` re-adds the shape's geometry to a rasterizer: used when a shadow's source area is far from the drawable
  // box and is rasterised separately (see ComputeShadowBoxes in canvas.cc).
  void DrawCoverage(FillRule rule, double alpha_scale, const Paint& paint, const ImageView* image,
                    const Matrix* device_to_image, const IntRect* image_clamp, const DrawParams& params,
                    const std::function<void(Rasterizer*)>& regeom);
  IntRect DrawBox(const DrawParams& params) const;
  // Every public drawing operation runs inside an OpScope: it binds the calling thread's shared raster scratch
  // (canvases keep no raster memory of their own) and trims that scratch after unusually large draws.
  void BeginOp();
  void EndOp();
  struct OpScope {
    explicit OpScope(Canvas* c) : c_(c) { c_->BeginOp(); }
    ~OpScope() { c_->EndOp(); }
    Canvas* c_;
  };

  Surface* surface_;
  Rasterizer* raster_ = nullptr;
  std::vector<uint8_t>* scratch_src_ = nullptr;
  std::vector<uint8_t>* scratch_cov_ = nullptr;
};

// Reads the surface as RGBA8 for uploads/encoders. premultiplied=false unpremultiplies; flip_y writes bottom row
// first. out must hold width*height*4 bytes.
void ReadPixels(const Surface& s, uint8_t* out, bool premultiplied, bool flip_y);

// Encodes the surface. mime: "image/png" (default), "image/jpeg" (quality 0..1; composited on black). Returns false
// on failure.
bool EncodeImage(const Surface& s, const std::string& mime, double quality, std::vector<uint8_t>* out,
                 std::string* used_mime);

}  // namespace iwn::canvas2d
