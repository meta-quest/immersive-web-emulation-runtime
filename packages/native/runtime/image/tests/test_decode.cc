/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Decoding (IMG-1, IMG-2, IMG-3) with the software backends, plus the pipeline's handling of decoders that apply
// EXIF orientation themselves (as AImageDecoder may).
#include <algorithm>
#include <atomic>
#include <map>
#include <cstdlib>
#include <cstring>
#include <random>
#include <thread>

#include "iwn/image/decode.h"
#include "test_harness.h"
#include "lodepng.h"
#include "test_images.h"
#include "jpeg_ref.h"

using namespace iwn::image;
using namespace iwn::image::test;

namespace {

Img DecodeToImg(const Bytes& b, const DecodeOptions& o = DecodeOptions(), Status* status = nullptr,
                AlphaMode* alpha = nullptr) {
  DecodeResult r = Decode(b.data(), b.size(), o);
  if (status) *status = r.status;
  if (r.status != Status::kOk) return {};
  if (alpha) *alpha = r.store->alpha();
  ScopedPixels sp = r.store->Read();
  return FromView(sp.view());
}

}  // namespace

TEST(png_color_types_bit_depths_and_interlace_match_lodepng) {
  const Img rgba = Pattern(13, 9, true);
  Img palette_src = Pattern(13, 9, true);
  for (size_t i = 0; i < palette_src.rgba.size(); i += 4) {  // quantise to a few colours
    for (int c = 0; c < 4; ++c) palette_src.rgba[i + c] &= 0xC0;
  }
  Img palette16 = palette_src;
  for (size_t i = 0; i < palette16.rgba.size(); i += 4) {  // at most 2^3 colours x 2 alphas = 16
    for (int c = 0; c < 3; ++c) palette16.rgba[i + c] &= 0x80;
    palette16.rgba[i + 3] = palette16.rgba[i + 3] & 0x80 ? 255 : 128;
  }
  struct Case { int type, depth; const Img* img; } cases[] = {
      {0, 1, &rgba}, {0, 2, &rgba}, {0, 4, &rgba}, {0, 8, &rgba}, {0, 16, &rgba}, {2, 8, &rgba},
      {2, 16, &rgba}, {3, 8, &palette_src}, {3, 4, &palette16}, {4, 8, &rgba}, {4, 16, &rgba},
      {6, 8, &rgba}, {6, 16, &rgba}};
  for (const Case& c : cases) {
    for (bool interlace : {false, true}) {
      Img src = *c.img;
      if (c.type == 0 && c.depth < 8) {  // low-bit grey: keep values the encoder can represent
        for (size_t i = 0; i < src.rgba.size(); i += 4) {
          uint8_t v = src.rgba[i] >= 128 ? 255 : 0;
          src.rgba[i] = src.rgba[i + 1] = src.rgba[i + 2] = v;
          src.rgba[i + 3] = 255;
        }
      } else if (c.type == 0 || c.type == 4) {
        for (size_t i = 0; i < src.rgba.size(); i += 4) src.rgba[i + 1] = src.rgba[i + 2] = src.rgba[i];
        if (c.type == 0) for (size_t i = 0; i < src.rgba.size(); i += 4) src.rgba[i + 3] = 255;
      } else if (c.type == 2) {
        for (size_t i = 0; i < src.rgba.size(); i += 4) src.rgba[i + 3] = 255;
      }
      Bytes png = EncodePng(src, c.type, c.depth, interlace);
      Img ref = DecodePngReference(png);
      Status st;
      Img got = DecodeToImg(png, DecodeOptions(), &st);
      CHECK(st == Status::kOk);
      Diff d = Compare(got, ref);
      if (!(d.same_size && d.max == 0)) {
        std::printf("  png type %d depth %d interlace %d: max diff %d\n", c.type, c.depth, interlace, d.max);
      }
      CHECK(d.same_size && d.max == 0);
    }
  }
}

// IMG-1: JPEG output within ±1 per channel of libjpeg-turbo's decode (JDCT_ISLOW, fancy upsampling: Skia's and
// Chromium's settings). AImageDecoder (Skia + libjpeg-turbo) must meet it exactly; stb_image (host, and the fallback
// before API 30) has its own IDCT and upsampler and is held to a looser, measured bound.
TEST(jpeg_baseline_and_progressive_match_libjpeg_turbo) {
  if (!HaveLibjpegReference()) {
    std::printf("  skip: built without libjpeg-turbo\n");
    return;
  }
  for (const char* name : {"testorig.jpg", "testimgint.jpg"}) {
    Bytes jpg;
    if (!ReadFile(TestData("libjpeg", name), &jpg)) {
      std::printf("  skip: %s not found\n", name);
      continue;
    }
    Img ref;
    CHECK(LibjpegDecodeRgba(jpg, &ref));
    DecodeResult r = Decode(jpg.data(), jpg.size(), DecodeOptions());
    CHECK(r.status == Status::kOk);
    if (r.status != Status::kOk) continue;
    ScopedPixels sp = r.store->Read();
    Img got = FromView(sp.view());
    Diff d = Compare(got, ref);
    size_t over1 = 0;
    for (size_t i = 0; i < got.rgba.size() && d.same_size; ++i) {
      if (std::abs(int{got.rgba[i]} - int{ref.rgba[i]}) > 1) ++over1;
    }
    const double frac = got.rgba.empty() ? 1.0 : static_cast<double>(over1) / static_cast<double>(got.rgba.size());
    std::printf("  %s (%s) vs libjpeg-turbo islow: max %d, mean %.3f, %.2f%% of channels off by more than 1\n", name,
                r.backend, d.max, d.mean, frac * 100);
    CHECK(d.same_size);
    if (std::strcmp(r.backend, "AImageDecoder") == 0) {
      CHECK(d.max <= 1);
    } else {
      CHECK(d.max <= 4);
      CHECK(frac < 0.03);
    }
  }
}

// IMG-1 "JPEG ... CMYK": Adobe CMYK and YCCK files. Adobe stores inverted CMYK (255 = no ink); browsers (Chromium,
// Skia) convert with R = C * K / 255 on those stored values. The reference applies that to libjpeg-turbo's raw CMYK
// decode of the same file, so only the conversion and the decoder's IDCT are compared.
TEST(jpeg_cmyk_and_ycck_match_libjpeg_turbo_conversion) {
  if (!HaveLibjpegReference()) {
    std::printf("  skip: built without libjpeg-turbo\n");
    return;
  }
  const uint32_t w = 32, h = 16;
  std::vector<uint8_t> cmyk(size_t{w} * h * 4);
  for (uint32_t y = 0; y < h; ++y) {
    for (uint32_t x = 0; x < w; ++x) {
      uint8_t* p = &cmyk[(size_t{y} * w + x) * 4];
      // 8x8-aligned flat patches plus a gentle gradient, in stored (inverted) values.
      p[0] = static_cast<uint8_t>(255 - ((x / 8) * 60));
      p[1] = static_cast<uint8_t>(255 - ((y / 8) * 100));
      p[2] = static_cast<uint8_t>(200 + (x + y) % 40);
      p[3] = static_cast<uint8_t>(255 - ((x / 16) * 90 + (y / 8) * 20));
    }
  }
  for (bool ycck : {false, true}) {
    Bytes jpg = LibjpegEncodeCmyk(w, h, cmyk, 95, ycck);
    CHECK(!jpg.empty());
    uint32_t rw = 0, rh = 0;
    std::vector<uint8_t> stored;
    CHECK(LibjpegDecodeCmyk(jpg, &rw, &rh, &stored));
    Img ref{rw, rh, std::vector<uint8_t>(size_t{rw} * rh * 4)};
    for (size_t i = 0; i < size_t{rw} * rh; ++i) {
      const int k = stored[i * 4 + 3];
      for (int c = 0; c < 3; ++c) ref.rgba[i * 4 + c] = static_cast<uint8_t>((stored[i * 4 + c] * k + 127) / 255);
      ref.rgba[i * 4 + 3] = 255;
    }
    DecodeResult r = Decode(jpg.data(), jpg.size(), DecodeOptions());
    CHECK(r.status == Status::kOk);
    if (r.status != Status::kOk) continue;
    ScopedPixels sp = r.store->Read();
    Diff d = Compare(FromView(sp.view()), ref);
    std::printf("  %s (%s) vs libjpeg-turbo + inverted-CMYK conversion: max %d, mean %.3f\n", ycck ? "YCCK" : "CMYK",
                r.backend, d.max, d.mean);
    CHECK(d.same_size);
    CHECK(r.store->opaque());
    CHECK(d.max <= (std::strcmp(r.backend, "AImageDecoder") == 0 ? 1 : 4));
  }
}

TEST(jpeg_generated_roundtrip_is_close) {
  const Img src = Pattern(32, 16, false);
  Status st;
  Img got = DecodeToImg(EncodeJpeg(src, 100), DecodeOptions(), &st);
  CHECK(st == Status::kOk);
  Diff d = Compare(got, src);
  CHECK(d.same_size && d.mean < 3.0);
}

TEST(webp_lossy_matches_dwebp_reference) {
  Bytes webp;
  Img ref;
  if (!ReadFile(TestData("libwebp", "test.webp"), &webp) || !ReadPpm(TestData("libwebp", "test_ref.ppm"), &ref)) {
    std::printf("  skip: libwebp examples not found\n");
    return;
  }
  Status st;
  Img got = DecodeToImg(webp, DecodeOptions(), &st);
  CHECK(st == Status::kOk);
  Diff d = Compare(got, ref);
  std::printf("  test.webp vs test_ref.ppm: max %d, mean %.3f\n", d.max, d.mean);
  CHECK(d.same_size && d.max <= 1);
}

TEST(webp_lossless_with_alpha_is_exact) {
  const Img src = Pattern(17, 11, true);
  Status st;
  AlphaMode alpha;
  Img got = DecodeToImg(EncodeWebp(src, true, 100), DecodeOptions(), &st, &alpha);
  CHECK(st == Status::kOk);
  CHECK(alpha == AlphaMode::kUnpremultiplied);
  // Lossless keeps every RGBA value except colour under alpha 0 (the encoder may clear it, as browsers allow).
  Img a = got, b = src;
  for (size_t i = 0; i < a.rgba.size(); i += 4) {
    if (b.rgba[i + 3] == 0) { std::memset(&a.rgba[i], 0, 3); std::memset(&b.rgba[i], 0, 3); }
  }
  CHECK_EQ(Compare(a, b).max, 0);
}

TEST(gif_first_frame_with_transparency) {
  Img src{3, 2, {255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0}};
  Status st;
  Img got = DecodeToImg(EncodeGif(src), DecodeOptions(), &st);
  CHECK(st == Status::kOk);
  CHECK(got.w == 3 && got.h == 2);
  CHECK(std::memcmp(got.px(0, 0), src.px(0, 0), 4) == 0);
  CHECK(std::memcmp(got.px(1, 1), src.px(1, 1), 4) == 0);
  CHECK_EQ(got.px(2, 0)[3], 0);
}

TEST(premultiplied_output_on_request) {
  const Img src = Corners4x4();
  DecodeOptions o;
  o.process.alpha = AlphaRequest::kPremultiplied;
  for (const Bytes& b : {EncodePng(src, 6, 8, false), EncodeWebp(src, true, 100)}) {
    AlphaMode alpha;
    Status st;
    Img got = DecodeToImg(b, o, &st, &alpha);
    CHECK(st == Status::kOk && alpha == AlphaMode::kPremultiplied);
    CHECK(Compare(got, Premultiply(src)).max <= 1);
  }
}

TEST(exif_orientation_applied_or_ignored) {
  const Img src = Pattern(6, 4, false);
  for (int o = 1; o <= 8; ++o) {
    // PNG (lossless) with eXIf, JPEG with APP1, WebP with EXIF.
    std::vector<Bytes> files = {InsertPngExif(EncodePng(src, 2, 8, false), o),
                                InsertWebpExif(EncodeWebp(src, true, 100), 6, 4, o, false)};
    for (const Bytes& f : files) {
      DecodeOptions apply;
      Status st;
      Img got = DecodeToImg(f, apply, &st);
      CHECK(st == Status::kOk);
      Diff applied = Compare(got, Orient(src, o));
      DecodeOptions ignore;
      ignore.apply_exif_orientation = false;
      Diff ignored = Compare(DecodeToImg(f, ignore), src);
      if (!(applied.same_size && applied.max == 0 && ignored.same_size && ignored.max == 0)) {
        std::printf("  %s orientation %d: applied ok %d, ignored ok %d\n", f[0] == 0x89 ? "png" : "webp", o,
                    applied.same_size && applied.max == 0, ignored.same_size && ignored.max == 0);
      }
      CHECK(applied.same_size && applied.max == 0);
      CHECK(ignored.same_size && ignored.max == 0);
    }
    Bytes jpg = InsertJpegExif(EncodeJpeg(src, 100), o, o % 2);
    Img j = DecodeToImg(jpg);
    CHECK(j.w == (o >= 5 ? 4u : 6u));
    DecodeOptions ignore;
    ignore.apply_exif_orientation = false;
    CHECK(DecodeToImg(jpg, ignore).w == 6u);
    // Lossy, so compare loosely against the oriented source.
    Diff dj = Compare(j, Orient(src, o));
    CHECK(dj.same_size && dj.mean < 4.0);
  }
}

namespace {
// Pretends to be a decoder that applies EXIF orientation itself (as AImageDecoder may).
class OrientingBackend final : public DecoderBackend {
 public:
  const char* name() const override { return "orienting-fake"; }
  bool Handles(Format f) const override { return f == Format::kPng; }
  BackendResult Decode(const BackendRequest& req) override {
    BackendResult r = StbBackend()->Decode(req);
    if (r.status != Status::kOk) return r;
    ProcessOptions p;
    p.orientation = ReadExifOrientation(req.data, req.size, req.format);
    std::unique_ptr<PixelStore> out;
    Process(std::move(r.store), p, &out);
    r.store = std::move(out);
    r.orientation_applied = true;
    return r;
  }
};
}  // namespace

TEST(decoder_that_applies_orientation_is_undone_for_none) {
  OrientingBackend fake;
  SetBackendsForTesting({&fake});
  const Img src = Pattern(6, 4, false);
  for (int o = 1; o <= 8; ++o) {
    Bytes f = InsertPngExif(EncodePng(src, 2, 8, false), o);
    CHECK_EQ(Compare(DecodeToImg(f), Orient(src, o)).max, 0);
    DecodeOptions ignore;
    ignore.apply_exif_orientation = false;
    CHECK_EQ(Compare(DecodeToImg(f, ignore), src).max, 0);
    DecodeOptions flip;
    flip.process.flip_y = true;
    CHECK_EQ(Compare(DecodeToImg(f, flip), FlipY(Orient(src, o))).max, 0);
  }
  SetBackendsForTesting({});
}

TEST(decode_with_crop_resize_flip_in_one_job) {
  const Img src = Pattern(20, 10, true);
  DecodeOptions o;
  o.process.has_crop = true;
  o.process.crop = Rect{2, 1, 8, 6};
  o.process.flip_y = true;
  o.process.alpha = AlphaRequest::kPremultiplied;
  Img got = DecodeToImg(EncodePng(src, 6, 8, false), o);
  CHECK_EQ(Compare(got, Premultiply(FlipY(Crop(src, 2, 1, 8, 6)))).max, 0);
  o.process.resize_width = 4;
  o.process.resize_height = 3;
  Img small = DecodeToImg(EncodePng(src, 6, 8, false), o);
  CHECK(small.w == 4 && small.h == 3);
}

TEST(size_limits_reject_before_allocating) {
  // IHDR claims 20000 x 10 (above 16384): rejected as too large from the header.
  Bytes png = EncodePng(Pattern(1, 1, false), 2, 8, false);
  auto patch = [&](uint32_t w, uint32_t h) {
    Bytes p = png;
    for (int i = 0; i < 4; ++i) {
      p[16 + i] = (w >> (24 - 8 * i)) & 0xff;
      p[20 + i] = (h >> (24 - 8 * i)) & 0xff;
    }
    const unsigned crc = lodepng_crc32(p.data() + 12, 17);  // IHDR type + data
    for (int i = 0; i < 4; ++i) p[29 + i] = (crc >> (24 - 8 * i)) & 0xff;
    return p;
  };
  Status st;
  DecodeToImg(patch(20000, 10), DecodeOptions(), &st);
  CHECK(st == Status::kTooLarge);
  DecodeToImg(patch(10, 16385), DecodeOptions(), &st);
  CHECK(st == Status::kTooLarge);
  DecodeOptions small;
  small.limits.max_pixels = 100;
  DecodeToImg(EncodePng(Pattern(11, 10, false), 2, 8, false), small, &st);
  CHECK(st == Status::kTooLarge);
  DecodeToImg(EncodePng(Pattern(10, 10, false), 2, 8, false), small, &st);
  CHECK(st == Status::kOk);
}

TEST(undecodable_and_truncated_inputs_fail_cleanly) {
  Status st;
  DecodeToImg(Bytes{}, DecodeOptions(), &st);
  CHECK(st == Status::kCorrupt);
  DecodeToImg(Bytes{'h', 'e', 'l', 'l', 'o', ' ', 'w', 'o', 'r', 'l', 'd', '!'}, DecodeOptions(), &st);
  CHECK(st == Status::kUnsupported);
  const Img src = Pattern(16, 16, true);
  std::vector<Bytes> files = {EncodePng(src, 6, 8, true), EncodeJpeg(src, 80), EncodeWebp(src, false, 80),
                              EncodeWebp(src, true, 100), EncodeGif(src)};
  for (const Bytes& f : files) {
    int failures = 0;
    int ok = 0;
    for (size_t n = 1; n < f.size(); n += (f.size() / 97) + 1) {
      Bytes cut(f.begin(), f.begin() + n);
      DecodeResult r = Decode(cut.data(), cut.size(), DecodeOptions());
      if (r.status != Status::kOk) ++failures;
      else {
        ++ok;
        CHECK(r.store && r.store->width() == 16 && r.store->height() == 16);  // a decoder may pad a cut file
      }
    }
    CHECK(failures > 0);
    if (f[0] == 0xFF) CHECK_EQ(ok, 0);  // JPEG: every cut is rejected, on every backend (no EOI)
  }
}

TEST(os_formats_can_be_disabled) {
  const uint8_t avif[] = {0, 0, 0, 0x1c, 'f', 't', 'y', 'p', 'a', 'v', 'i', 'f', 0, 0, 0, 0, 0, 0, 0, 0};
  DecodeOptions o;
  o.allow_os_formats = false;
  DecodeResult r = Decode(avif, sizeof avif, o);
  CHECK(r.status == Status::kUnsupported);
  CHECK(r.format == Format::kAvif);
}

TEST(truncated_jpeg_photo_is_rejected) {
  // A cut-off JPEG decodes on stb as a full image with grey blocks; it must fail like AImageDecoder does.
  Bytes jpg = EncodeJpeg(Pattern(227, 149, false), 85);
  for (double keep : {0.3, 0.6, 0.95}) {
    Bytes cut(jpg.begin(), jpg.begin() + static_cast<long>(jpg.size() * keep));
    DecodeResult r = Decode(cut.data(), cut.size(), DecodeOptions());
    CHECK(r.status == Status::kCorrupt);
  }
  // Trailing bytes after the EOI are fine.
  Bytes tail = jpg;
  tail.insert(tail.end(), {0, 0, 0, 0});
  CHECK(Decode(tail.data(), tail.size(), DecodeOptions()).status == Status::kOk);
}

TEST(absurd_header_in_a_tiny_file_fails_before_allocating) {
  // IHDR claims 15000 x 15000 RGBA (900 MB decoded, within the limits) in a ~70-byte file: rejected from the header.
  Bytes png = EncodePng(Pattern(1, 1, true), 6, 8, false);
  for (int i = 0; i < 4; ++i) {
    png[16 + i] = (15000u >> (24 - 8 * i)) & 0xff;
    png[20 + i] = (15000u >> (24 - 8 * i)) & 0xff;
  }
  const unsigned crc = lodepng_crc32(png.data() + 12, 17);
  for (int i = 0; i < 4; ++i) png[29 + i] = (crc >> (24 - 8 * i)) & 0xff;
  // No backend is even asked (stb or AImageDecoder would allocate the full 900 MB before finding the data short).
  struct Counting final : DecoderBackend {
    int calls = 0;
    const char* name() const override { return "counting"; }
    bool Handles(Format) const override { return true; }
    BackendResult Decode(const BackendRequest& req) override {
      ++calls;
      return StbBackend()->Decode(req);
    }
  } counting;
  SetBackendsForTesting({&counting});
  DecodeResult r = Decode(png.data(), png.size(), DecodeOptions());
  SetBackendsForTesting({});
  CHECK(r.status == Status::kCorrupt);
  CHECK_EQ(counting.calls, 0);
}

TEST(pixel_limit_is_256_megapixels) {
  Bytes png = EncodePng(Pattern(1, 1, false), 2, 8, false);
  auto patch = [&](uint32_t w, uint32_t h) {
    Bytes p = png;
    for (int i = 0; i < 4; ++i) {
      p[16 + i] = (w >> (24 - 8 * i)) & 0xff;
      p[20 + i] = (h >> (24 - 8 * i)) & 0xff;
    }
    const unsigned crc = lodepng_crc32(p.data() + 12, 17);
    for (int i = 0; i < 4; ++i) p[29 + i] = (crc >> (24 - 8 * i)) & 0xff;
    return p;
  };
  Bytes over = patch(16000, 16384);  // 262.1 MP: within the per-side limit, above 256 x 10^6
  CHECK(Decode(over.data(), over.size(), DecodeOptions()).status == Status::kTooLarge);
  Bytes under = patch(15625, 16384);  // exactly 256 x 10^6: allowed by the limits (then truncated data)
  CHECK(Decode(under.data(), under.size(), DecodeOptions()).status == Status::kCorrupt);
}

namespace {
// Claims it applied the EXIF orientation but did not (a parser disagreement between us and the OS decoder).
class LyingBackend final : public DecoderBackend {
 public:
  const char* name() const override { return "lying-fake"; }
  bool Handles(Format f) const override { return f == Format::kPng; }
  BackendResult Decode(const BackendRequest& req) override {
    BackendResult r = StbBackend()->Decode(req);
    r.orientation_applied = true;
    return r;
  }
};

// Records the size the wrapped backend decoded at.
class SpyBackend final : public DecoderBackend {
 public:
  explicit SpyBackend(DecoderBackend* inner) : inner_(inner) {}
  const char* name() const override { return inner_->name(); }
  bool Handles(Format f) const override { return inner_->Handles(f); }
  bool DownscalesFormat(Format f) const override { return inner_->DownscalesFormat(f); }
  BackendResult Decode(const BackendRequest& req) override {
    BackendResult r = inner_->Decode(req);
    if (r.store) {
      w = r.store->width();
      h = r.store->height();
    }
    return r;
  }
  uint32_t w = 0, h = 0;

 private:
  DecoderBackend* inner_;
};
}  // namespace

TEST(orientation_claim_is_checked_against_the_decoded_shape) {
  LyingBackend fake;
  SetBackendsForTesting({&fake});
  const Img src = Pattern(6, 4, false);
  for (int o : {5, 6, 7, 8}) {
    Bytes f = InsertPngExif(EncodePng(src, 2, 8, false), o);
    CHECK_EQ(Compare(DecodeToImg(f), Orient(src, o)).max, 0);
    DecodeOptions ignore;
    ignore.apply_exif_orientation = false;
    Img raw = DecodeToImg(f, ignore);
    CHECK(raw.w == 6 && raw.h == 4);
    CHECK_EQ(Compare(raw, src).max, 0);
  }
  SetBackendsForTesting({});
}

TEST(resize_decodes_downscaled_where_the_backend_filters) {
  if (!WebpBackend()) {
    std::printf("  skip: built without libwebp\n");
    return;
  }
  SpyBackend spy(WebpBackend());
  SetBackendsForTesting({&spy});
  const Img src = Pattern(512, 256, true);
  Bytes webp = EncodeWebp(src, true, 100);
  DecodeOptions o;
  o.process.resize_width = 64;
  o.process.resize_height = 32;
  o.process.quality = ResizeQuality::kMedium;
  DecodeResult r = Decode(webp.data(), webp.size(), o);
  CHECK(r.status == Status::kOk);
  CHECK(r.store && r.store->width() == 64 && r.store->height() == 32);
  CHECK(spy.w == 128 && spy.h == 64);  // sampled by 4: still 2x the target
  // Close to resizing the full decode.
  DecodeOptions full_opts;
  full_opts.process = o.process;
  full_opts.process.quality = ResizeQuality::kMedium;
  SetBackendsForTesting({WebpBackend()});
  DecodeOptions no_hint = full_opts;
  no_hint.process.has_crop = true;  // a crop disables the hint
  no_hint.process.crop = Rect{0, 0, 512, 256};
  DecodeResult full = Decode(webp.data(), webp.size(), no_hint);
  CHECK(full.status == Status::kOk);
  if (r.store && full.store) {
    ScopedPixels a = r.store->Read(), b = full.store->Read();
    Diff d = Compare(FromView(a.view()), FromView(b.view()));
    std::printf("  downscaled decode vs full decode + resize: max %d, mean %.3f\n", d.max, d.mean);
    CHECK(d.same_size && d.mean < 2.0);
  }
  // pixelated and crops never use it.
  spy.w = spy.h = 0;
  SetBackendsForTesting({&spy});
  o.process.quality = ResizeQuality::kPixelated;
  CHECK(Decode(webp.data(), webp.size(), o).status == Status::kOk);
  CHECK(spy.w == 512 && spy.h == 256);
  SetBackendsForTesting({});
}

TEST(cancelled_decode_stops_before_decoding) {
  Bytes png = EncodePng(Pattern(64, 64, true), 6, 8, false);
  std::atomic<bool> cancel{true};
  DecodeOptions o;
  o.cancel = &cancel;
  CHECK(Decode(png.data(), png.size(), o).status == Status::kCancelled);
  cancel = false;
  CHECK(Decode(png.data(), png.size(), o).status == Status::kOk);
}

TEST(decode_budget_bounds_memory_in_flight) {
  DecodeBudget& b = DecodeBudget::Shared();
  const uint64_t saved = b.limit();
  b.SetLimit(1000);
  CHECK(b.Acquire(600, nullptr));
  std::atomic<bool> second{false};
  std::thread t([&] {
    CHECK(b.Acquire(600, nullptr));  // waits: 1200 > 1000
    second = true;
    b.Release(600);
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  CHECK(!second.load());
  b.Release(600);
  t.join();
  CHECK(second.load());
  // A request larger than the whole budget runs alone; a cancelled waiter gives up.
  CHECK(b.Acquire(5000, nullptr));
  std::atomic<bool> cancel{false};
  std::thread c([&] { CHECK(!b.Acquire(10, &cancel)); });
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  cancel = true;
  c.join();
  b.Release(5000);
  CHECK_EQ(b.in_flight(), uint64_t{0});
  b.SetLimit(saved);
}

// The budget reserves the full decode size unless the backend that runs honours the downscale hint for the format;
// a fallthrough to another backend re-reserves for that one.
namespace {
struct BudgetProbe final : DecoderBackend {
  DecoderBackend* inner = nullptr;
  bool downscales = false;
  bool unsupported = false;
  uint64_t seen = 0;
  const char* name() const override { return "budget-probe"; }
  bool Handles(Format f) const override { return inner ? inner->Handles(f) : true; }
  bool DownscalesFormat(Format) const override { return downscales; }
  BackendResult Decode(const BackendRequest& req) override {
    seen = DecodeBudget::Shared().in_flight();
    if (unsupported || !inner) return BackendResult{};  // kUnsupported
    return inner->Decode(req);
  }
};
}  // namespace

TEST(budget_reserves_full_size_unless_the_backend_downscales) {
  if (!StbBackend()) {
    std::printf("  skip: built without stb\n");
    return;
  }
  const Bytes png = EncodePng(Pattern(1024, 1024, true), 6, 8, false);
  DecodeOptions o;
  o.process.resize_width = 16;
  o.process.resize_height = 16;
  o.process.quality = ResizeQuality::kMedium;
  const uint64_t full = uint64_t{1024} * 1024 * 4, out = 16 * 16 * 4, scaled = uint64_t{16} * 16 * 4 * 64;
  BudgetProbe probe;
  probe.inner = StbBackend();
  SetBackendsForTesting({&probe});
  CHECK(Decode(png.data(), png.size(), o).status == Status::kOk);
  CHECK_EQ(probe.seen, full + out);  // stb decodes PNG at full size: reserve all of it
  probe.downscales = true;
  CHECK(Decode(png.data(), png.size(), o).status == Status::kOk);
  CHECK_EQ(probe.seen, scaled + out);
  // A downscaling backend that turns the file down hands over to a full-size one: the reservation grows first.
  BudgetProbe first, second;
  first.downscales = true;
  first.unsupported = true;
  second.inner = StbBackend();
  SetBackendsForTesting({&first, &second});
  CHECK(Decode(png.data(), png.size(), o).status == Status::kOk);
  CHECK_EQ(first.seen, scaled + out);
  CHECK_EQ(second.seen, full + out);
  CHECK_EQ(DecodeBudget::Shared().in_flight(), uint64_t{0});
  SetBackendsForTesting({});
}

// Downscaled decode on whichever backend decodes JPEG first: AImageDecoder samples by 2/4/8 with libjpeg-turbo's DCT
// scaling; stb_image has no such mode and decodes at full size. Either way the result is the requested size and
// orientation.
TEST(jpeg_resize_with_downscaled_decode_and_exif) {
  std::vector<DecoderBackend*> list = DefaultBackends();
  DecoderBackend* first = nullptr;
  for (DecoderBackend* b : list) {
    if (b->Handles(Format::kJpeg)) {
      first = b;
      break;
    }
  }
  CHECK(first != nullptr);
  if (!first) return;
  SpyBackend spy(first);
  SetBackendsForTesting({&spy});
  const bool scales = std::strcmp(first->name(), "AImageDecoder") == 0;
  const Img src = Pattern(512, 256, false);
  for (int o : {1, 6}) {
    Bytes jpg = InsertJpegExif(EncodeJpeg(src, 95), o, true);
    const Img want = Orient(src, o);  // 512x256 or 256x512
    DecodeOptions opts;
    opts.process.resize_width = want.w / 8;
    opts.process.resize_height = want.h / 8;
    opts.process.quality = ResizeQuality::kHigh;
    DecodeResult r = Decode(jpg.data(), jpg.size(), opts);
    CHECK(r.status == Status::kOk);
    if (r.status != Status::kOk) continue;
    CHECK(r.store->width() == want.w / 8 && r.store->height() == want.h / 8);
    std::printf("  jpeg exif %d via %s: decoded at %ux%u for a %ux%u result\n", o, first->name(), spy.w, spy.h,
                r.store->width(), r.store->height());
    if (scales) CHECK(uint64_t{spy.w} * spy.h == uint64_t{want.w} * want.h / 16);  // sampled by 4
    else CHECK(uint64_t{spy.w} * spy.h == uint64_t{want.w} * want.h);
    // Same picture as a full decode + resize (smooth pattern: small differences only).
    DecodeOptions full = opts;
    full.process.has_crop = true;  // disables the hint
    full.process.crop = Rect{0, 0, want.w, want.h};
    DecodeResult f = Decode(jpg.data(), jpg.size(), full);
    CHECK(f.status == Status::kOk);
    if (f.status == Status::kOk) {
      ScopedPixels a = r.store->Read(), b = f.store->Read();
      Diff d = Compare(FromView(a.view()), FromView(b.view()));
      std::printf("  vs full decode + resize: max %d, mean %.3f\n", d.max, d.mean);
      CHECK(d.same_size && d.mean < 3.0);
    }
  }
  SetBackendsForTesting({});
}

namespace {

// A flat GIF compressed with real (greedy) LZW and no clear codes once the table is full: the best case LZW gets,
// so the size bound in ReadHeaderInfo is checked against the smallest file a real encoder makes.
Bytes FlatLzwGif(uint16_t w, uint16_t h) {
  Bytes g = {'G', 'I', 'F', '8', '9', 'a', static_cast<uint8_t>(w & 0xff), static_cast<uint8_t>(w >> 8),
             static_cast<uint8_t>(h & 0xff), static_cast<uint8_t>(h >> 8), 0x81, 0, 0};
  for (int i = 0; i < 4; ++i) g.insert(g.end(), {static_cast<uint8_t>(i * 60), 90, 200});  // 4-entry colour table
  g.insert(g.end(), {0x2C, 0, 0, 0, 0, static_cast<uint8_t>(w & 0xff), static_cast<uint8_t>(w >> 8),
                     static_cast<uint8_t>(h & 0xff), static_cast<uint8_t>(h >> 8), 0, 2});
  const int min_code = 2, clear = 1 << min_code, eoi = clear + 1;
  std::map<std::pair<int, int>, int> dict;
  int next = eoi + 1, width = min_code + 1;
  Bytes data;
  uint32_t acc = 0;
  int nbits = 0;
  auto emit = [&](int code) {
    acc |= static_cast<uint32_t>(code) << nbits;
    nbits += width;
    while (nbits >= 8) { data.push_back(acc & 0xff); acc >>= 8; nbits -= 8; }
  };
  emit(clear);
  const uint64_t total = uint64_t{w} * h;
  int prefix = 1;  // colour index 1 everywhere
  for (uint64_t i = 1; i < total; ++i) {
    auto it = dict.find({prefix, 1});
    if (it != dict.end()) {
      prefix = it->second;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict[{prefix, 1}] = next++;
      if (next > (1 << width) && width < 12) ++width;
    }
    prefix = 1;
  }
  emit(prefix);
  emit(eoi);
  if (nbits > 0) data.push_back(acc & 0xff);
  for (size_t i = 0; i < data.size(); i += 255) {
    const size_t n = std::min<size_t>(255, data.size() - i);
    g.push_back(static_cast<uint8_t>(n));
    g.insert(g.end(), data.begin() + i, data.begin() + i + n);
  }
  g.push_back(0);
  g.push_back(0x3B);
  return g;
}

struct CountingBackend final : DecoderBackend {
  int calls = 0;
  const char* name() const override { return "counting"; }
  bool Handles(Format) const override { return true; }
  BackendResult Decode(const BackendRequest& req) override {
    ++calls;
    return StbBackend()->Decode(req);
  }
};

}  // namespace

TEST(jpeg_and_gif_size_bounds_never_reject_real_files) {
  // JPEG: flat images with optimised Huffman tables, grey and 4:2:0, baseline and progressive, are the smallest
  // files libjpeg-turbo writes; real photos are far above the bound.
  if (HaveLibjpegReference()) {
    for (int comps : {1, 3}) {
      for (bool progressive : {false, true}) {
        for (uint32_t side : {1u, 8u, 999u, 4096u}) {
          Bytes jpg = LibjpegEncodeFlat(side, side, comps, 128, 50, progressive);
          CHECK(!jpg.empty());
          HeaderInfo h = ReadHeaderInfo(jpg.data(), jpg.size(), Format::kJpeg);
          CHECK(h.known && h.width == side && jpg.size() >= h.min_file_size);
          if (side == 4096) {
            CHECK(h.min_file_size > 0);
            std::printf("  info: flat %ux%u %s %s JPEG: %zu bytes, bound %llu\n", side, side, comps == 1 ? "grey" : "4:2:0",
                        progressive ? "progressive" : "baseline", jpg.size(),
                        static_cast<unsigned long long>(h.min_file_size));
          }
        }
      }
    }
  } else {
    std::printf("  skip (libjpeg-turbo part): built without libjpeg-turbo\n");
  }
  for (const char* name : {"testorig.jpg", "testimgint.jpg"}) {
    Bytes jpg;
    if (!ReadFile(TestData("libjpeg", name), &jpg)) continue;
    HeaderInfo h = ReadHeaderInfo(jpg.data(), jpg.size(), Format::kJpeg);
    CHECK(h.known && jpg.size() >= h.min_file_size);
  }
  Img flat{2048, 2048, std::vector<uint8_t>(size_t{2048} * 2048 * 4, 200)};
  Bytes stbjpg = EncodeJpeg(flat, 1);
  HeaderInfo hs = ReadHeaderInfo(stbjpg.data(), stbjpg.size(), Format::kJpeg);
  CHECK(hs.known && stbjpg.size() >= hs.min_file_size);
  // GIF: greedy LZW of a flat frame, which decodes.
  for (uint16_t side : {uint16_t{1}, uint16_t{64}, uint16_t{2000}, uint16_t{4096}}) {
    Bytes gif = FlatLzwGif(side, side);
    HeaderInfo h = ReadHeaderInfo(gif.data(), gif.size(), Format::kGif);
    CHECK(h.known && h.width == side && gif.size() >= h.min_file_size);
    if (side == 2000) {
      DecodeResult r = Decode(gif.data(), gif.size(), DecodeOptions());
      CHECK(r.status == Status::kOk && r.store && r.store->width() == side);
      std::printf("  info: flat %ux%u LZW GIF: %zu bytes, bound %llu\n", side, side, gif.size(),
                  static_cast<unsigned long long>(h.min_file_size));
    }
  }
}

TEST(absurd_jpeg_and_gif_headers_fail_before_allocating) {
  // A small JPEG with its SOF patched to 15000 x 15000 (a 5.7 KB "claim15k.jpg" case): no backend runs.
  Bytes jpg = EncodeJpeg(Pattern(64, 64, false), 90);
  size_t sof = 0;
  for (size_t i = 2; i + 9 < jpg.size(); ++i) {
    if (jpg[i] == 0xFF && (jpg[i + 1] == 0xC0 || jpg[i + 1] == 0xC2)) {
      sof = i;
      break;
    }
  }
  CHECK(sof > 0);
  jpg[sof + 5] = 15000 >> 8;
  jpg[sof + 6] = 15000 & 0xff;
  jpg[sof + 7] = 15000 >> 8;
  jpg[sof + 8] = 15000 & 0xff;
  // The same for a GIF claiming a 16000 x 16000 frame in a few dozen bytes (a 29-byte "claim16k.gif").
  Bytes gif = FlatLzwGif(4, 4);
  const size_t desc = 13 + 12;
  CHECK(gif[desc] == 0x2C);
  for (size_t at : {size_t{6}, desc + 5}) {
    gif[at] = 16000 & 0xff;
    gif[at + 1] = 16000 >> 8;
    gif[at + 2] = 16000 & 0xff;
    gif[at + 3] = 16000 >> 8;
  }
  for (const Bytes* file : {&jpg, &gif}) {
    CountingBackend counting;
    SetBackendsForTesting({&counting});
    DecodeResult r = Decode(file->data(), file->size(), DecodeOptions());
    SetBackendsForTesting({});
    CHECK(r.status == Status::kCorrupt);
    CHECK_EQ(counting.calls, 0);
  }
  // A large screen with a small frame is a valid GIF (the rest is transparent) and is not rejected by the bound.
  Bytes sparse = FlatLzwGif(4, 4);
  sparse[6] = 4000 & 0xff;
  sparse[7] = 4000 >> 8;
  sparse[8] = 4000 & 0xff;
  sparse[9] = 4000 >> 8;
  HeaderInfo h = ReadHeaderInfo(sparse.data(), sparse.size(), Format::kGif);
  CHECK(h.known && h.width == 4000 && sparse.size() >= h.min_file_size);
}
