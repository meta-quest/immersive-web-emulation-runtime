/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The createImageBitmap pixel pipeline (IMG-6): orientation, source rectangle, resize, flipY, premultiplyAlpha.
#include <cstring>

#include "iwn/image/transform.h"
#include "test_harness.h"
#include "test_images.h"

using namespace iwn::image;
using namespace iwn::image::test;

namespace {

std::unique_ptr<PixelStore> ToStore(const Img& img, AlphaMode alpha = AlphaMode::kUnpremultiplied) {
  auto s = PixelStore::AllocateHeap(img.w, img.h);
  MutablePixelView mv = s->LockWrite();
  for (uint32_t y = 0; y < img.h; ++y) std::memcpy(mv.data + y * mv.stride, img.px(0, y), size_t{img.w} * 4);
  s->UnlockWrite();
  s->set_alpha(alpha);
  ScopedPixels sp = s->Read();
  s->set_opaque(IsOpaque(sp.view()));
  return s;
}

Img Run(const Img& in, const ProcessOptions& o, AlphaMode alpha = AlphaMode::kUnpremultiplied,
        AlphaMode* out_alpha = nullptr) {
  std::unique_ptr<PixelStore> out;
  Status s = Process(ToStore(in, alpha), o, &out);
  CHECK(s == Status::kOk);
  if (s != Status::kOk) return {};
  if (out_alpha) *out_alpha = out->alpha();
  ScopedPixels sp = out->Read();
  return FromView(sp.view());
}

}  // namespace

TEST(orientation_matches_exif_reference_for_all_values) {
  const Img src = Pattern(5, 3, true);
  for (int o = 1; o <= 8; ++o) {
    ProcessOptions opt;
    opt.orientation = o;
    Img got = Run(src, opt);
    Diff d = Compare(got, Orient(src, o));
    CHECK(d.same_size);
    CHECK_EQ(d.max, 0);
  }
}

TEST(orientation_compose_and_inverse) {
  const Img src = Pattern(4, 3, false);
  for (int a = 1; a <= 8; ++a) {
    CHECK_EQ(ComposeOrientation(a, InverseOrientation(a)), 1);
    for (int b = 1; b <= 8; ++b) {
      ProcessOptions oc;
      oc.orientation = ComposeOrientation(a, b);
      Diff d = Compare(Run(src, oc), Orient(Orient(src, a), b));
      CHECK(d.same_size && d.max == 0);
    }
  }
}

TEST(crop_inside_outside_and_flip) {
  const Img src = Pattern(6, 5, true);
  struct C { int64_t x, y, w, h; } cases[] = {{0, 0, 6, 5}, {1, 2, 3, 2}, {-2, -1, 4, 4}, {4, 3, 5, 5}, {-3, -3, 12, 11},
                                             {10, 10, 2, 2}};
  for (const C& c : cases) {
    for (int flip = 0; flip < 2; ++flip) {
      for (int o : {1, 6, 3}) {
        ProcessOptions opt;
        opt.orientation = o;
        opt.has_crop = true;
        opt.crop = Rect{c.x, c.y, c.w, c.h};
        opt.flip_y = flip;
        Img expect = Crop(Orient(src, o), c.x, c.y, c.w, c.h);
        if (flip) expect = FlipY(expect);
        Diff d = Compare(Run(src, opt), expect);
        CHECK(d.same_size && d.max == 0);
      }
    }
  }
}

TEST(premultiply_and_unpremultiply_round_trip_rules) {
  const Img src = Corners4x4();
  ProcessOptions p;
  p.alpha = AlphaRequest::kPremultiplied;
  AlphaMode mode;
  Img pre = Run(src, p, AlphaMode::kUnpremultiplied, &mode);
  CHECK(mode == AlphaMode::kPremultiplied);
  CHECK_EQ(Compare(pre, Premultiply(src)).max, 0);
  // Top-left: red at alpha 128 -> 128 premultiplied.
  CHECK_EQ(pre.px(0, 0)[0], 128);
  ProcessOptions u;
  u.alpha = AlphaRequest::kUnpremultiplied;
  Img back = Run(pre, u, AlphaMode::kPremultiplied, &mode);
  CHECK(mode == AlphaMode::kUnpremultiplied);
  CHECK(Compare(back, src).max <= 1);
  // kKeep leaves the mode alone.
  ProcessOptions k;
  Img same = Run(pre, k, AlphaMode::kPremultiplied, &mode);
  CHECK(mode == AlphaMode::kPremultiplied);
  CHECK_EQ(Compare(same, pre).max, 0);
}

TEST(corners_every_orientation_flip_premultiply_combination) {
  // IMG-6's check image through each imageOrientation x premultiplyAlpha combination (pre-upload pixels).
  const Img src = Corners4x4();
  for (int flip = 0; flip < 2; ++flip) {
    for (int alpha = 0; alpha < 3; ++alpha) {
      ProcessOptions o;
      o.flip_y = flip;
      o.alpha = static_cast<AlphaRequest>(alpha);
      Img got = Run(src, o);
      Img expect = flip ? FlipY(src) : src;
      if (alpha == 1) expect = Premultiply(expect);
      CHECK_EQ(Compare(got, expect).max, 0);
      const uint8_t* tl = got.px(0, 0);
      if (!flip) CHECK(tl[0] > 0 && tl[1] == 0 && tl[2] == 0);       // red stays top-left
      if (flip) CHECK(tl[2] > 0 && tl[0] == 0 && tl[1] == 0);        // blue moves to the top
    }
  }
}

TEST(resize_pixelated_is_exact_replication) {
  const Img src = Pattern(3, 2, false);
  ProcessOptions o;
  o.resize_width = 6;
  o.resize_height = 4;
  o.quality = ResizeQuality::kPixelated;
  Img got = Run(src, o);
  CHECK(got.w == 6 && got.h == 4);
  for (uint32_t y = 0; y < 4; ++y)
    for (uint32_t x = 0; x < 6; ++x) CHECK(std::memcmp(got.px(x, y), src.px(x / 2, y / 2), 4) == 0);
}

TEST(resize_constant_image_stays_constant_for_all_qualities) {
  Img src{7, 5, std::vector<uint8_t>(7 * 5 * 4)};
  for (size_t i = 0; i < src.rgba.size(); i += 4) {
    src.rgba[i] = 10; src.rgba[i + 1] = 200; src.rgba[i + 2] = 99; src.rgba[i + 3] = 255;
  }
  for (int q = 0; q < 4; ++q) {
    for (auto [w, h] : {std::pair{3u, 2u}, std::pair{20u, 13u}, std::pair{7u, 1u}}) {
      ProcessOptions o;
      o.resize_width = w;
      o.resize_height = h;
      o.quality = static_cast<ResizeQuality>(q);
      Img got = Run(src, o);
      CHECK(got.w == w && got.h == h);
      for (size_t i = 0; i < got.rgba.size(); i += 4) {
        CHECK(got.rgba[i] == 10 && got.rgba[i + 1] == 200 && got.rgba[i + 2] == 99 && got.rgba[i + 3] == 255);
      }
    }
  }
}

TEST(resize_medium_halving_is_box_average) {
  Img src{4, 2, std::vector<uint8_t>(32)};
  const uint8_t v[8] = {0, 100, 50, 150, 10, 20, 30, 40};
  for (int i = 0; i < 8; ++i) {
    uint8_t* p = &src.rgba[i * 4];
    p[0] = p[1] = p[2] = v[i];
    p[3] = 255;
  }
  ProcessOptions o;
  o.resize_width = 2;
  o.resize_height = 1;
  o.quality = ResizeQuality::kMedium;
  Img got = Run(src, o);
  CHECK_EQ(got.px(0, 0)[0], (0 + 100 + 10 + 20 + 2) / 4);
  CHECK_EQ(got.px(1, 0)[0], (50 + 150 + 30 + 40 + 2) / 4);
}

TEST(resize_with_alpha_has_no_colour_bleed_from_transparent_pixels) {
  // Transparent red next to opaque blue: browsers resample premultiplied, so no red appears.
  Img src{2, 1, {255, 0, 0, 0, 0, 0, 255, 255}};
  for (int q = 1; q < 4; ++q) {
    ProcessOptions o;
    o.resize_width = 1;
    o.resize_height = 1;
    o.quality = static_cast<ResizeQuality>(q);
    Img got = Run(src, o);
    CHECK_EQ(got.px(0, 0)[0], 0);
    CHECK(got.px(0, 0)[2] >= 254);  // unpremultiplied blue
    CHECK(got.px(0, 0)[3] >= 127 && got.px(0, 0)[3] <= 128);
  }
}

TEST(resize_then_flip_equals_flip_then_resize) {
  const Img src = Pattern(9, 7, true);
  ProcessOptions a;
  a.resize_width = 4;
  a.resize_height = 3;
  a.quality = ResizeQuality::kHigh;
  a.flip_y = true;
  ProcessOptions b = a;
  b.flip_y = false;
  Img ra = Run(src, a);
  Img rb = FlipY(Run(src, b));
  CHECK_EQ(Compare(ra, rb).max, 0);
}

// HTML scales first and flips afterwards. 'pixelated' (nearest) is not symmetric at ties, so with a source rectangle
// or an orientation the flip must still come after the resample: result == FlipY(same options without flipY).
TEST(pixelated_resize_flips_after_scaling_with_crop_and_orientation) {
  const Img src = Pattern(8, 4, true);
  int cases = 0;
  for (int orient = 1; orient <= 8; ++orient) {
    for (int crop = 0; crop < 2; ++crop) {
      for (ResizeQuality q : {ResizeQuality::kPixelated, ResizeQuality::kLow, ResizeQuality::kHigh}) {
        ProcessOptions b;
        b.orientation = orient;
        if (crop) {
          b.has_crop = true;
          b.crop = Rect{1, 0, 6, 4};
        }
        b.resize_width = 4;
        b.resize_height = 2;
        b.quality = q;
        ProcessOptions a = b;
        a.flip_y = true;
        Diff d = Compare(Run(src, a), FlipY(Run(src, b)));
        CHECK(d.same_size);
        CHECK_EQ(d.max, 0);
        ++cases;
      }
    }
  }
  CHECK_EQ(cases, 48);
}

TEST(identity_returns_the_same_store) {
  auto s = ToStore(Pattern(3, 3, false));
  const PixelStore* raw = s.get();
  std::unique_ptr<PixelStore> out;
  ProcessOptions o;
  CHECK(Process(std::move(s), o, &out) == Status::kOk);
  CHECK(out.get() == raw);
  ProcessOptions f;
  f.flip_y = true;  // flip only: done in place
  std::unique_ptr<PixelStore> out2;
  CHECK(Process(std::move(out), f, &out2) == Status::kOk);
  CHECK(out2.get() == raw);
}

TEST(copy_for_upload_flips_and_premultiplies) {
  const Img src = Corners4x4();
  auto s = ToStore(src);
  ScopedPixels sp = s->Read();
  std::vector<uint8_t> buf(64);
  CHECK(CopyForUpload(sp.view(), true, true, buf.data(), buf.size()));
  Img got{4, 4, buf};
  CHECK_EQ(Compare(got, Premultiply(FlipY(src))).max, 0);
  CHECK(!CopyForUpload(sp.view(), false, false, buf.data(), 63));
}

TEST(invalid_crop_is_rejected) {
  ProcessOptions o;
  o.has_crop = true;
  o.crop = Rect{0, 0, 0, 3};
  std::unique_ptr<PixelStore> out;
  CHECK(Process(ToStore(Pattern(2, 2, false)), o, &out) == Status::kInvalidArgument);
}

TEST(huge_source_rectangle_is_rejected_not_allocated) {
  ProcessOptions o;
  o.has_crop = true;
  o.crop = Rect{0, 0, 40000, 40000};
  o.resize_width = 4;
  o.resize_height = 4;
  std::unique_ptr<PixelStore> out;
  CHECK(Process(ToStore(Pattern(2, 2, false)), o, &out) == Status::kTooLarge);
  o.crop = Rect{-100, -100, 300, 300};  // large but sane: fine
  CHECK(Process(ToStore(Pattern(2, 2, false)), o, &out) == Status::kOk);
}
