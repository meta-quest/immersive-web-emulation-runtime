/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "test_images.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>

#include "lodepng.h"
#include "webp/encode.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STB_IMAGE_WRITE_STATIC
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-function"
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#endif
#include "stb_image_write.h"
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

namespace iwn::image::test {

Img Pattern(uint32_t w, uint32_t h, bool alpha) {
  Img img{w, h, std::vector<uint8_t>(size_t{w} * h * 4)};
  for (uint32_t y = 0; y < h; ++y) {
    for (uint32_t x = 0; x < w; ++x) {
      uint8_t* p = img.px(x, y);
      p[0] = static_cast<uint8_t>(w > 1 ? x * 255 / (w - 1) : 0);
      p[1] = static_cast<uint8_t>(h > 1 ? y * 255 / (h - 1) : 0);
      p[2] = static_cast<uint8_t>(((x / 4) + (y / 4)) % 2 ? 200 : 40);
      p[3] = alpha ? static_cast<uint8_t>(255 - ((x * 7 + y * 13) % 256)) : 255;
    }
  }
  return img;
}

Img Corners4x4() {
  Img img{4, 4, std::vector<uint8_t>(64)};
  for (uint32_t y = 0; y < 4; ++y) {
    for (uint32_t x = 0; x < 4; ++x) {
      uint8_t* p = img.px(x, y);
      p[0] = 60; p[1] = 60; p[2] = 60; p[3] = 255;
    }
  }
  auto set = [&](uint32_t x, uint32_t y, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    uint8_t* p = img.px(x, y);
    p[0] = r; p[1] = g; p[2] = b; p[3] = a;
  };
  set(0, 0, 255, 0, 0, 128);    // top-left red
  set(3, 0, 0, 255, 0, 128);    // top-right green
  set(0, 3, 0, 0, 255, 128);    // bottom-left blue
  set(3, 3, 255, 255, 0, 128);  // bottom-right yellow
  return img;
}

Img FromView(const PixelView& v) {
  Img img{v.width, v.height, std::vector<uint8_t>(size_t{v.width} * v.height * 4)};
  for (uint32_t y = 0; y < v.height; ++y) std::memcpy(img.px(0, y), v.data + y * v.stride, size_t{v.width} * 4);
  return img;
}

Bytes EncodePng(const Img& img, int colortype, int bitdepth, bool interlace) {
  lodepng::State state;
  state.encoder.auto_convert = 0;
  state.info_png.interlace_method = interlace ? 1 : 0;
  state.info_png.color.colortype = static_cast<LodePNGColorType>(colortype);
  state.info_png.color.bitdepth = bitdepth;
  state.info_raw.colortype = LCT_RGBA;
  state.info_raw.bitdepth = 8;
  std::vector<uint8_t> raw = img.rgba;
  if (colortype == 3) {
    std::map<uint32_t, int> palette;
    for (size_t i = 0; i < raw.size(); i += 4) {
      uint32_t key = (uint32_t{raw[i]} << 24) | (raw[i + 1] << 16) | (raw[i + 2] << 8) | raw[i + 3];
      if (!palette.count(key) && palette.size() < (1u << bitdepth)) {
        palette[key] = static_cast<int>(palette.size());
        lodepng_palette_add(&state.info_png.color, raw[i], raw[i + 1], raw[i + 2], raw[i + 3]);
        lodepng_palette_add(&state.info_raw, raw[i], raw[i + 1], raw[i + 2], raw[i + 3]);
      }
    }
  }
  if (bitdepth == 16) {
    // Feed 16-bit raw data so the file really holds 16-bit samples (value * 257).
    state.info_raw.bitdepth = 16;
    const int ch = colortype == 0 ? 1 : colortype == 2 ? 3 : colortype == 4 ? 2 : 4;
    state.info_raw.colortype = static_cast<LodePNGColorType>(colortype);
    std::vector<uint8_t> wide;
    for (size_t i = 0; i < raw.size(); i += 4) {
      uint8_t samples[4];
      if (ch == 1) samples[0] = raw[i];
      if (ch == 2) { samples[0] = raw[i]; samples[1] = raw[i + 3]; }
      if (ch == 3) { samples[0] = raw[i]; samples[1] = raw[i + 1]; samples[2] = raw[i + 2]; }
      if (ch == 4) std::memcpy(samples, &raw[i], 4);
      for (int c = 0; c < ch; ++c) {
        wide.push_back(samples[c]);
        wide.push_back(samples[c]);
      }
    }
    raw.swap(wide);
  }
  std::vector<uint8_t> out;
  unsigned err = lodepng::encode(out, raw, img.w, img.h, state);
  if (err) {
    std::fprintf(stderr, "lodepng encode error %u: %s\n", err, lodepng_error_text(err));
    std::abort();
  }
  return out;
}

Img DecodePngReference(const Bytes& png) {
  Img img;
  unsigned w = 0, h = 0;
  if (lodepng::decode(img.rgba, w, h, png, LCT_RGBA, 8)) std::abort();
  img.w = w;
  img.h = h;
  return img;
}

namespace {
void AppendBytes(void* ctx, void* data, int size) {
  auto* out = static_cast<Bytes*>(ctx);
  out->insert(out->end(), static_cast<uint8_t*>(data), static_cast<uint8_t*>(data) + size);
}

void Put16(Bytes& b, uint16_t v, bool le) {
  if (le) { b.push_back(v & 0xff); b.push_back(v >> 8); }
  else { b.push_back(v >> 8); b.push_back(v & 0xff); }
}
void Put32(Bytes& b, uint32_t v, bool le) {
  if (le) { for (int i = 0; i < 4; ++i) b.push_back((v >> (8 * i)) & 0xff); }
  else { for (int i = 3; i >= 0; --i) b.push_back((v >> (8 * i)) & 0xff); }
}

// TIFF header + IFD0 with one entry: Orientation (0x0112, SHORT, 1).
Bytes Tiff(int orientation, bool le) {
  Bytes t;
  t.push_back(le ? 'I' : 'M');
  t.push_back(le ? 'I' : 'M');
  Put16(t, 42, le);
  Put32(t, 8, le);
  Put16(t, 1, le);  // one entry
  Put16(t, 0x0112, le);
  Put16(t, 3, le);
  Put32(t, 1, le);
  Put16(t, static_cast<uint16_t>(orientation), le);
  Put16(t, 0, le);
  Put32(t, 0, le);  // next IFD
  return t;
}
}  // namespace

Bytes EncodeJpeg(const Img& img, int quality) {
  Bytes out;
  stbi_write_jpg_to_func(AppendBytes, &out, static_cast<int>(img.w), static_cast<int>(img.h), 4, img.rgba.data(),
                         quality);
  return out;
}

Bytes EncodeWebp(const Img& img, bool lossless, float quality) {
  uint8_t* out = nullptr;
  size_t size = lossless ? WebPEncodeLosslessRGBA(img.rgba.data(), static_cast<int>(img.w), static_cast<int>(img.h),
                                                  static_cast<int>(img.w * 4), &out)
                         : WebPEncodeRGBA(img.rgba.data(), static_cast<int>(img.w), static_cast<int>(img.h),
                                          static_cast<int>(img.w * 4), quality, &out);
  Bytes b(out, out + size);
  WebPFree(out);
  return b;
}

Bytes EncodeGif(const Img& img) {
  // Palette.
  std::map<uint32_t, int> index;
  std::vector<uint32_t> colors;
  bool transparent = false;
  for (size_t i = 0; i < img.rgba.size(); i += 4) {
    if (img.rgba[i + 3] < 128) { transparent = true; continue; }
    uint32_t key = (uint32_t{img.rgba[i]} << 16) | (img.rgba[i + 1] << 8) | img.rgba[i + 2];
    if (!index.count(key)) {
      index[key] = static_cast<int>(colors.size());
      colors.push_back(key);
    }
  }
  const int trans_index = static_cast<int>(colors.size());
  if (transparent) colors.push_back(0);
  int bits = 1;
  while ((1u << bits) < colors.size()) ++bits;
  if (bits > 8) std::abort();
  Bytes g = {'G', 'I', 'F', '8', '9', 'a'};
  Put16(g, static_cast<uint16_t>(img.w), true);
  Put16(g, static_cast<uint16_t>(img.h), true);
  g.push_back(static_cast<uint8_t>(0x80 | ((bits - 1) << 4) | (bits - 1)));
  g.push_back(0);
  g.push_back(0);
  for (int i = 0; i < (1 << bits); ++i) {
    uint32_t c = i < static_cast<int>(colors.size()) ? colors[i] : 0;
    g.push_back(c >> 16); g.push_back((c >> 8) & 0xff); g.push_back(c & 0xff);
  }
  if (transparent) {
    g.insert(g.end(), {0x21, 0xF9, 0x04, 0x01, 0, 0, static_cast<uint8_t>(trans_index), 0});
  }
  g.push_back(0x2C);
  Put16(g, 0, true); Put16(g, 0, true);
  Put16(g, static_cast<uint16_t>(img.w), true);
  Put16(g, static_cast<uint16_t>(img.h), true);
  g.push_back(0);
  const int min_code = bits < 2 ? 2 : bits;
  g.push_back(static_cast<uint8_t>(min_code));
  // LZW without compression: a clear code before every pixel keeps the code width at min_code + 1.
  const int clear = 1 << min_code, eoi = clear + 1, width = min_code + 1;
  Bytes data;
  uint32_t acc = 0;
  int nbits = 0;
  auto emit = [&](int code) {
    acc |= static_cast<uint32_t>(code) << nbits;
    nbits += width;
    while (nbits >= 8) { data.push_back(acc & 0xff); acc >>= 8; nbits -= 8; }
  };
  for (size_t i = 0; i < img.rgba.size(); i += 4) {
    emit(clear);
    if (img.rgba[i + 3] < 128) emit(trans_index);
    else emit(index[(uint32_t{img.rgba[i]} << 16) | (img.rgba[i + 1] << 8) | img.rgba[i + 2]]);
  }
  emit(eoi);
  if (nbits) data.push_back(acc & 0xff);
  for (size_t off = 0; off < data.size(); off += 255) {
    const size_t n = std::min<size_t>(255, data.size() - off);
    g.push_back(static_cast<uint8_t>(n));
    g.insert(g.end(), data.begin() + off, data.begin() + off + n);
  }
  g.push_back(0);
  g.push_back(0x3B);
  return g;
}

Bytes InsertJpegExif(const Bytes& jpeg, int orientation, bool le) {
  Bytes tiff = Tiff(orientation, le);
  Bytes seg = {0xFF, 0xE1};
  Put16(seg, static_cast<uint16_t>(2 + 6 + tiff.size()), false);
  seg.insert(seg.end(), {'E', 'x', 'i', 'f', 0, 0});
  seg.insert(seg.end(), tiff.begin(), tiff.end());
  Bytes out(jpeg.begin(), jpeg.begin() + 2);  // SOI
  out.insert(out.end(), seg.begin(), seg.end());
  out.insert(out.end(), jpeg.begin() + 2, jpeg.end());
  return out;
}

Bytes InsertPngExif(const Bytes& png, int orientation) {
  Bytes tiff = Tiff(orientation, false);
  Bytes chunk;
  Put32(chunk, static_cast<uint32_t>(tiff.size()), false);
  chunk.insert(chunk.end(), {'e', 'X', 'I', 'f'});
  chunk.insert(chunk.end(), tiff.begin(), tiff.end());
  Put32(chunk, lodepng_crc32(chunk.data() + 4, tiff.size() + 4), false);
  const size_t after_ihdr = 8 + 25;
  Bytes out(png.begin(), png.begin() + after_ihdr);
  out.insert(out.end(), chunk.begin(), chunk.end());
  out.insert(out.end(), png.begin() + after_ihdr, png.end());
  return out;
}

Bytes InsertWebpExif(const Bytes& webp, uint32_t w, uint32_t h, int orientation, bool has_alpha) {
  // Re-wrap a simple-format file (RIFF, one VP8/VP8L chunk) as the extended format: VP8X + image + EXIF.
  Bytes image_chunk(webp.begin() + 12, webp.end());
  Bytes body = {'W', 'E', 'B', 'P', 'V', 'P', '8', 'X'};
  Put32(body, 10, true);
  body.push_back(static_cast<uint8_t>(0x08 | (has_alpha ? 0x10 : 0)));  // EXIF flag, alpha flag
  body.push_back(0); body.push_back(0); body.push_back(0);
  for (int i = 0; i < 3; ++i) body.push_back(((w - 1) >> (8 * i)) & 0xff);
  for (int i = 0; i < 3; ++i) body.push_back(((h - 1) >> (8 * i)) & 0xff);
  body.insert(body.end(), image_chunk.begin(), image_chunk.end());
  Bytes tiff = Tiff(orientation, true);
  body.insert(body.end(), {'E', 'X', 'I', 'F'});
  Put32(body, static_cast<uint32_t>(tiff.size()), true);
  body.insert(body.end(), tiff.begin(), tiff.end());
  if (tiff.size() & 1) body.push_back(0);
  Bytes out = {'R', 'I', 'F', 'F'};
  Put32(out, static_cast<uint32_t>(body.size()), true);
  out.insert(out.end(), body.begin(), body.end());
  return out;
}

std::string TestData(const char* which, const char* file) {
  if (const char* dir = std::getenv("IWN_IMAGE_TEST_DATA")) return std::string(dir) + "/" + file;
#if defined(IWN_IMAGE_TEST_DATA_LIBJPEG) && defined(IWN_IMAGE_TEST_DATA_LIBWEBP)
  return std::string(std::strcmp(which, "libjpeg") == 0 ? IWN_IMAGE_TEST_DATA_LIBJPEG : IWN_IMAGE_TEST_DATA_LIBWEBP) +
         "/" + file;
#else
  return file;
#endif
}

bool ReadFile(const std::string& path, Bytes* out) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  out->assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
  return true;
}

bool ReadPpm(const std::string& path, Img* out) {
  Bytes b;
  if (!ReadFile(path, &b)) return false;
  size_t pos = 0;
  auto token = [&]() {
    std::string t;
    while (pos < b.size()) {
      if (b[pos] == '#') { while (pos < b.size() && b[pos] != '\n') ++pos; continue; }
      if (std::isspace(b[pos])) { if (!t.empty()) break; ++pos; continue; }
      t.push_back(static_cast<char>(b[pos++]));
    }
    return t;
  };
  if (token() != "P6") return false;
  const uint32_t w = std::stoul(token()), h = std::stoul(token());
  if (std::stoul(token()) != 255) return false;
  ++pos;  // single whitespace
  if (b.size() - pos < size_t{w} * h * 3) return false;
  out->w = w;
  out->h = h;
  out->rgba.resize(size_t{w} * h * 4);
  for (size_t i = 0; i < size_t{w} * h; ++i) {
    out->rgba[i * 4 + 0] = b[pos + i * 3 + 0];
    out->rgba[i * 4 + 1] = b[pos + i * 3 + 1];
    out->rgba[i * 4 + 2] = b[pos + i * 3 + 2];
    out->rgba[i * 4 + 3] = 255;
  }
  return true;
}

Img Orient(const Img& s, int o) {
  const bool swap = o >= 5 && o <= 8;
  Img d{swap ? s.h : s.w, swap ? s.w : s.h, std::vector<uint8_t>(s.rgba.size())};
  for (uint32_t y = 0; y < d.h; ++y) {
    for (uint32_t x = 0; x < d.w; ++x) {
      uint32_t sx = x, sy = y;
      switch (o) {
        case 2: sx = s.w - 1 - x; sy = y; break;                  // mirror horizontal
        case 3: sx = s.w - 1 - x; sy = s.h - 1 - y; break;        // rotate 180
        case 4: sx = x; sy = s.h - 1 - y; break;                  // mirror vertical
        case 5: sx = y; sy = x; break;                            // transpose
        case 6: sx = y; sy = s.h - 1 - x; break;                  // rotate 90 CW
        case 7: sx = s.w - 1 - y; sy = s.h - 1 - x; break;        // transverse
        case 8: sx = s.w - 1 - y; sy = x; break;                  // rotate 90 CCW
        default: break;
      }
      std::memcpy(d.px(x, y), s.px(sx, sy), 4);
    }
  }
  return d;
}

Img Crop(const Img& s, int64_t cx, int64_t cy, int64_t w, int64_t h) {
  Img d{static_cast<uint32_t>(w), static_cast<uint32_t>(h), std::vector<uint8_t>(size_t(w) * h * 4, 0)};
  for (int64_t y = 0; y < h; ++y) {
    for (int64_t x = 0; x < w; ++x) {
      const int64_t sx = cx + x, sy = cy + y;
      if (sx < 0 || sy < 0 || sx >= s.w || sy >= s.h) continue;
      std::memcpy(d.px(x, y), s.px(sx, sy), 4);
    }
  }
  return d;
}

Img FlipY(const Img& s) {
  Img d = s;
  for (uint32_t y = 0; y < s.h; ++y) std::memcpy(d.px(0, y), s.px(0, s.h - 1 - y), size_t{s.w} * 4);
  return d;
}

Img Premultiply(const Img& s) {
  Img d = s;
  for (size_t i = 0; i < d.rgba.size(); i += 4) {
    const int a = d.rgba[i + 3];
    for (int c = 0; c < 3; ++c) d.rgba[i + c] = static_cast<uint8_t>(std::lround(d.rgba[i + c] * a / 255.0));
  }
  return d;
}

Diff Compare(const Img& a, const Img& b) {
  Diff d;
  d.same_size = a.w == b.w && a.h == b.h;
  if (!d.same_size) {
    d.max = 9999;  // never passes a max check
    return d;
  }
  double sum = 0;
  for (size_t i = 0; i < a.rgba.size(); ++i) {
    const int e = std::abs(int(a.rgba[i]) - int(b.rgba[i]));
    d.max = std::max(d.max, e);
    sum += e;
  }
  d.mean = a.rgba.empty() ? 0 : sum / a.rgba.size();
  return d;
}

}  // namespace iwn::image::test
