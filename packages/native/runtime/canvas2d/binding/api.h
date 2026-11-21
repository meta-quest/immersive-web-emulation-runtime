/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Engine-neutral half of the canvas2d binding. The V8 binding (device) and the Node-API addon (headless tests) only
// decode JS arguments and wrap handles; every operation lives here, so both expose identical behaviour to the JS
// layer in web/canvas2d.
//
// JS-facing API (globalThis.__iwn.canvas2d), documented in web/canvas2d/src/natives.ts:
//   createSurface(w, h) -> surface              resize(surface, w, h) -> bool
//   fill(s, state, cmds, len, paint, clip)       stroke(s, state, cmds, len, paint, clip, dash)
//   clearRect(s, state, x, y, w, h, clip)        clip(s, state, cmds, len, parentClip) -> clip
//   isPointInPath(s, state, cmds, len, x, y)     isPointInStroke(s, state, cmds, len, x, y, dash)
//   drawSurface(s, state, src, sx..dh, clip)     drawPixels(s, state, data, w, h, premul, sx..dh, clip)
//   getImageData(s, x, y, w, h, out)             putImageData(s, data, dw, dh, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH)
//   readPixels(s, out, premultiplied, flipY)     encode(s, mime, quality) -> [ArrayBuffer, mime] | null
//   createGradient(kind, p0..p5) -> gradient     addColorStop(g, offset, r, g, b, a)
//   createPatternFromSurface(src, rx, ry)        createPatternFromPixels(data, w, h, premul, rx, ry)
//   setPatternTransform(p, a, b, c, d, e, f)
//   loadFace(bytes, index) -> face | "error"     loadFaceFile(path, index) -> face | null
//   faceInfo(face) -> {...}                      defaultFaces() -> [[generic, face], ...]
//   systemFamilies() -> [{name, fonts: [{path, weight, italic, index}]}]
//   createFont(faces, synth, size, weight, italic, smallCaps, kerning, letterSpacing, wordSpacing, lang) -> font
//   measureText(font, text, align, baseline, direction, out)
//   fillText(s, state, font, text, x, y, maxWidth, paint, clip)
//   strokeText(s, state, font, text, x, y, maxWidth, paint, clip, dash)
//   configureSystemFonts(fontsXmlPath, fontDir)  setAssetRoot(dir)   (host/testing)
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "iwn/canvas2d/canvas.h"
#include "iwn/canvas2d/text.h"

namespace iwn::canvas2d::api {

// JS number -> int for sizes and offsets: truncated, clamped to the int range, NaN -> def (a plain cast of an
// out-of-range double is undefined behaviour).
inline int ToInt(double d, int def = 0) {
  if (!(d == d)) return def;
  if (d >= 2147483647.0) return 2147483647;
  if (d <= -2147483648.0) return -2147483647 - 1;
  return static_cast<int>(d);
}

// True when `n` bytes hold w x h RGBA pixels (w, h >= 0), without overflowing the product.
inline bool PixelBytesFit(size_t n, int w, int h) {
  return w >= 0 && h >= 0 && uint64_t(w) * uint64_t(h) <= uint64_t(n) / 4;
}

// Layout of the per-context state block (a Float64Array the JS context owns and fills before each call).
// web/canvas2d/src/natives.ts mirrors these indices.
enum StateIndex : int {
  kCtmA = 0,
  kCtmB,
  kCtmC,
  kCtmD,
  kCtmE,
  kCtmF,
  kGlobalAlpha = 6,
  kCompositeOp = 7,
  kSmoothing = 8,
  kSmoothingQuality = 9,
  kShadowOffsetX = 10,
  kShadowOffsetY = 11,
  kShadowBlur = 12,
  kShadowR = 13,
  kShadowG,
  kShadowB,
  kShadowA,
  kLineWidth = 17,
  kLineCap = 18,
  kLineJoin = 19,
  kMiterLimit = 20,
  kDashOffset = 21,
  kColorR = 22,
  kColorG,
  kColorB,
  kColorA,
  kPaintKind = 26,
  kFillRule = 27,
  kPathSpace = 28,  // 0: user space (Path2D, rects), 1: device space (the current default path)
  kTextAlign = 29,
  kTextBaseline = 30,
  kDirection = 31,
  kStateSize = 32
};

enum class HandleKind : uint32_t { kSurface = 0x43324453, kGradient, kPattern, kClip, kFace, kFont };

struct Handle {
  explicit Handle(HandleKind k) : kind(k) {}
  virtual ~Handle() = default;
  // Bytes outside the JS heap, reported to the engine as external memory (IMG-7).
  virtual size_t ExternalBytes() const { return 0; }
  HandleKind kind;
};

struct SurfaceHandle : Handle {
  SurfaceHandle() : Handle(HandleKind::kSurface), canvas(&surface) {}
  size_t ExternalBytes() const override { return surface.byte_size(); }
  Surface surface;
  Canvas canvas;
};

struct GradientHandle : Handle {
  GradientHandle(Gradient::Kind k, const double* p) : Handle(HandleKind::kGradient), gradient(k, p) {}
  Gradient gradient;
};

struct PatternHandle : Handle {
  PatternHandle(std::shared_ptr<const OwnedImage> img, bool rx, bool ry)
      : Handle(HandleKind::kPattern), pattern(img, rx, ry), bytes(img ? img->pixels.size() : 0) {}
  size_t ExternalBytes() const override { return bytes; }
  Pattern pattern;
  size_t bytes;
};

struct ClipHandle : Handle {
  ClipHandle() : Handle(HandleKind::kClip) {}
  size_t ExternalBytes() const override { return mask ? mask->alpha.size() : 0; }
  std::unique_ptr<ClipMask> mask;
};

struct FaceHandle : Handle {
  explicit FaceHandle(std::shared_ptr<Face> f) : Handle(HandleKind::kFace), face(std::move(f)) {}
  std::shared_ptr<Face> face;
};

struct FontHandle : Handle {
  explicit FontHandle(std::shared_ptr<Font> f) : Handle(HandleKind::kFont), font(std::move(f)) {}
  std::shared_ptr<Font> font;
};

// Decoders for the state block. `state` must have kStateSize doubles.
DrawParams DecodeDraw(const double* state, const ClipHandle* clip);
StrokeStyle DecodeStroke(const double* state, const float* dash, size_t dash_len);
Paint DecodePaint(const double* state, const Handle* paint);

struct Span {
  const float* data = nullptr;
  size_t length = 0;
};

// Operations. Invalid handles of the wrong kind must be filtered out by the binding (it passes nullptr).
void Fill(SurfaceHandle* s, const double* state, Span cmds, const Handle* paint, const ClipHandle* clip);
void Stroke(SurfaceHandle* s, const double* state, Span cmds, const Handle* paint, const ClipHandle* clip, Span dash);
void ClearRect(SurfaceHandle* s, const double* state, double x, double y, double w, double h, const ClipHandle* clip);
std::unique_ptr<ClipHandle> Clip(SurfaceHandle* s, const double* state, Span cmds, const ClipHandle* parent);
bool IsPointInPath(SurfaceHandle* s, const double* state, Span cmds, double x, double y);
bool IsPointInStroke(SurfaceHandle* s, const double* state, Span cmds, double x, double y, Span dash);
void DrawImage(SurfaceHandle* s, const double* state, const ImageView& src, const double* rect8, const ClipHandle* clip);
std::unique_ptr<PatternHandle> CreatePattern(const ImageView& src, bool repeat_x, bool repeat_y);
std::unique_ptr<FontHandle> CreateFont(const std::vector<FaceHandle*>& faces, const std::vector<int>& synth,
                                       double size, int weight, bool italic, bool small_caps, bool kerning,
                                       double letter_spacing, double word_spacing, const std::string& lang);
void MeasureText(FontHandle* f, std::u16string_view text, int align, int baseline, int direction, double* out12);
void DrawText(SurfaceHandle* s, const double* state, FontHandle* f, std::u16string_view text, double x, double y,
              double max_width, const Handle* paint, const ClipHandle* clip, bool stroke, Span dash);

// Host testing: bundled fonts read from a directory instead of APK assets.
void SetAssetRoot(const std::string& dir);

// Optional hook so other native modules (images, WebGL canvases) can make their JS objects drawable without a
// dependency on this module: return true and fill `view` if `object` is one of theirs. `keepalive` receives an owner
// that must stay alive while the view is used. Engine-specific: the V8 binding passes a v8::Local<v8::Value>* as
// `object`.
using ExternalImageResolver = bool (*)(void* object, ImageView* view, std::shared_ptr<void>* keepalive);
void SetExternalImageResolver(ExternalImageResolver resolver);
ExternalImageResolver GetExternalImageResolver();

}  // namespace iwn::canvas2d::api
