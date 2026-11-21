// Test image builders: encoders (lodepng, stb_image_write, libwebp), EXIF insertion, a tiny GIF writer and a PPM
// reader, so tests generate their inputs instead of shipping binary fixtures.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "iwn/image/pixels.h"

namespace iwn::image::test {

struct Img {
  uint32_t w = 0, h = 0;
  std::vector<uint8_t> rgba;  // tightly packed
  uint8_t* px(uint32_t x, uint32_t y) { return &rgba[(size_t{y} * w + x) * 4]; }
  const uint8_t* px(uint32_t x, uint32_t y) const { return &rgba[(size_t{y} * w + x) * 4]; }
};

using Bytes = std::vector<uint8_t>;

// Deterministic pattern: distinct corner colours, gradients, alpha varying when `alpha`.
Img Pattern(uint32_t w, uint32_t h, bool alpha);
// 4x4 with four distinct, half-transparent corners (IMG-6's check image).
Img Corners4x4();
Img FromView(const PixelView& v);

// lodepng: colortype 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA; bitdepth 1..16; interlace 0/1.
Bytes EncodePng(const Img& img, int colortype, int bitdepth, bool interlace);
Img DecodePngReference(const Bytes& png);  // lodepng decode to RGBA8
Bytes EncodeJpeg(const Img& img, int quality);
Bytes EncodeWebp(const Img& img, bool lossless, float quality);
Bytes EncodeGif(const Img& img);  // palette from the image (<= 255 colours), alpha 0 -> transparent index

Bytes InsertJpegExif(const Bytes& jpeg, int orientation, bool little_endian);
Bytes InsertPngExif(const Bytes& png, int orientation);
Bytes InsertWebpExif(const Bytes& webp, uint32_t w, uint32_t h, int orientation, bool has_alpha);

// Test data from libjpeg-turbo's testimages/ and libwebp's examples/. $IWN_IMAGE_TEST_DATA (one directory holding
// both sets, used on device) overrides the compiled-in host paths.
std::string TestData(const char* which /* "libjpeg" | "libwebp" */, const char* file);

bool ReadPpm(const std::string& path, Img* out);
bool ReadFile(const std::string& path, Bytes* out);

// Reference orientation (EXIF semantics written out per value, independent of transform.cc's matrices).
Img Orient(const Img& src, int orientation);
Img Crop(const Img& src, int64_t x, int64_t y, int64_t w, int64_t h);  // transparent outside
Img FlipY(const Img& src);
Img Premultiply(const Img& src);

struct Diff {
  int max = 0;
  double mean = 0;
  bool same_size = false;
};
Diff Compare(const Img& a, const Img& b);

}  // namespace iwn::image::test
