/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The pixel pipeline behind createImageBitmap's options (HTML "create an ImageBitmap" + "cropped to the source
// rectangle with formatting"): orientation, source rectangle, resize, flipY, alpha mode. Plain C++, thread-safe
// (no shared state), run on decode-pool threads.
#pragma once

#include <cstdint>
#include <memory>

#include "iwn/image/pixels.h"

namespace iwn::image {

enum class Status : uint8_t {
  kOk = 0,
  kUnsupported,      // format not recognised / not decodable here
  kCorrupt,          // recognised but malformed or truncated
  kTooLarge,         // above the size limits (IMG-3)
  kOutOfMemory,
  kInvalidArgument,  // bad options (callers validate first; this is a backstop)
  kCancelled,
};
const char* StatusName(Status status);

enum class ResizeQuality : uint8_t {
  kPixelated = 0,  // nearest neighbour
  kLow = 1,        // bilinear
  kMedium = 2,     // area average when shrinking, bilinear when growing
  kHigh = 3,       // tent filter sized to the scale when shrinking, bilinear when growing
};

enum class AlphaRequest : uint8_t {
  kKeep = 0,  // keep the source's mode (decoders: unpremultiplied); createImageBitmap's 'default' asks kPremultiplied
  kPremultiplied = 1,
  kUnpremultiplied = 2,
};

struct Rect {
  int64_t x = 0;
  int64_t y = 0;
  int64_t width = 0;   // > 0
  int64_t height = 0;  // > 0
};

// EXIF orientation values 1..8 (TIFF tag 0x0112): how the stored pixels must be transformed to display upright.
// 1 none, 2 mirror X, 3 rotate 180, 4 mirror Y, 5 transpose, 6 rotate 90 CW, 7 transverse, 8 rotate 90 CCW.
inline bool OrientationSwapsAxes(int orientation) { return orientation >= 5 && orientation <= 8; }
// The orientation that undoes `orientation` (6 <-> 8; the others are their own inverse).
int InverseOrientation(int orientation);
// The single orientation equal to applying `first`, then `second`.
int ComposeOrientation(int first, int second);

struct ProcessOptions {
  int orientation = 1;  // applied first to the input
  bool has_crop = false;
  Rect crop;  // in post-orientation coordinates; parts outside the image are transparent black
  uint32_t resize_width = 0;  // 0: keep the (cropped) size
  uint32_t resize_height = 0;
  ResizeQuality quality = ResizeQuality::kLow;
  bool flip_y = false;
  AlphaRequest alpha = AlphaRequest::kKeep;
  StoreAllocator allocator = HeapAllocator;  // for the final output
};

// True when Process() would return its input unchanged (no allocation, no pixel work).
bool IsIdentity(uint32_t width, uint32_t height, AlphaMode input_alpha, bool input_opaque,
                const ProcessOptions& options);

// Applies `options` to an owned store. May reuse `input` (in place flip / alpha change) and return it.
Status Process(std::unique_ptr<PixelStore> input, const ProcessOptions& options, std::unique_ptr<PixelStore>* out);

// Same, reading from a view the caller keeps alive (the view is never modified).
Status ProcessView(const PixelView& input, const ProcessOptions& options, std::unique_ptr<PixelStore>* out);

// Premultiply / unpremultiply helpers with the rounding Skia uses (round(c * a / 255), round(c * 255 / a)).
void PremultiplyRow(uint8_t* rgba, uint32_t pixels);
void UnpremultiplyRow(uint8_t* rgba, uint32_t pixels);

// Upload helper for the WebGL binding (UNPACK_FLIP_Y_WEBGL / UNPACK_PREMULTIPLY_ALPHA_WEBGL on non-ImageBitmap
// sources): copies `src` into `dst` (tightly packed rows of width*4 bytes, `dst_size` >= width*height*4), flipping
// rows if `flip_y` and converting to the requested alpha mode.
bool CopyForUpload(const PixelView& src, bool flip_y, bool premultiply, uint8_t* dst, size_t dst_size);

}  // namespace iwn::image
