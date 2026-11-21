/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Sniffing and EXIF orientation parsing.
#include <cstring>
#include <string>

#include "iwn/image/decode.h"
#include "test_harness.h"
#include "test_images.h"

using namespace iwn::image;
using namespace iwn::image::test;

TEST(sniff_recognises_signatures) {
  const Img img = Pattern(4, 4, true);
  CHECK(SniffFormat(EncodePng(img, 6, 8, false).data(), 60) == Format::kPng);
  Bytes jpg = EncodeJpeg(img, 90);
  CHECK(SniffFormat(jpg.data(), jpg.size()) == Format::kJpeg);
  Bytes webp = EncodeWebp(img, true, 100);
  CHECK(SniffFormat(webp.data(), webp.size()) == Format::kWebp);
  Bytes gif = EncodeGif(img);
  CHECK(SniffFormat(gif.data(), gif.size()) == Format::kGif);
  const uint8_t bmp[] = {'B', 'M', 0, 0};
  CHECK(SniffFormat(bmp, sizeof bmp) == Format::kBmp);
  const uint8_t avif[] = {0, 0, 0, 0x1c, 'f', 't', 'y', 'p', 'a', 'v', 'i', 'f', 0, 0, 0, 0};
  CHECK(SniffFormat(avif, sizeof avif) == Format::kAvif);
  const uint8_t heic[] = {0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'h', 'e', 'i', 'c', 0, 0, 0, 0};
  CHECK(SniffFormat(heic, sizeof heic) == Format::kHeif);
  const uint8_t mif1avif[] = {0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'm', 'i', 'f', '1', 0, 0, 0, 0,
                              'm', 'i', 'f', '1', 'a', 'v', 'i', 'f'};
  CHECK(SniffFormat(mif1avif, sizeof mif1avif) == Format::kAvif);
  const uint8_t junk[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};
  CHECK(SniffFormat(junk, sizeof junk) == Format::kUnknown);
  CHECK(SniffFormat(junk, 0) == Format::kUnknown);
}

TEST(exif_orientation_jpeg_both_byte_orders) {
  Bytes jpg = EncodeJpeg(Pattern(8, 4, false), 90);
  CHECK_EQ(ReadExifOrientation(jpg.data(), jpg.size(), Format::kJpeg), 1);
  for (int o = 1; o <= 8; ++o) {
    for (bool le : {true, false}) {
      Bytes with = InsertJpegExif(jpg, o, le);
      CHECK_EQ(ReadExifOrientation(with.data(), with.size(), Format::kJpeg), o);
    }
  }
}

TEST(exif_orientation_png_and_webp) {
  const Img img = Pattern(8, 4, true);
  Bytes png = InsertPngExif(EncodePng(img, 6, 8, false), 6);
  CHECK_EQ(ReadExifOrientation(png.data(), png.size(), Format::kPng), 6);
  Bytes webp = InsertWebpExif(EncodeWebp(img, true, 100), 8, 4, 8, true);
  CHECK_EQ(ReadExifOrientation(webp.data(), webp.size(), Format::kWebp), 8);
}

TEST(exif_parser_survives_every_truncation_and_bad_values) {
  Bytes jpg = InsertJpegExif(EncodeJpeg(Pattern(8, 4, false), 90), 6, true);
  for (size_t n = 0; n <= 64 && n <= jpg.size(); ++n) {
    int o = ReadExifOrientation(jpg.data(), n, Format::kJpeg);
    CHECK(o >= 1 && o <= 8);
  }
  Bytes bad = InsertJpegExif(EncodeJpeg(Pattern(8, 4, false), 90), 9, true);
  CHECK_EQ(ReadExifOrientation(bad.data(), bad.size(), Format::kJpeg), 1);
  // IFD offset pointing outside the buffer.
  const uint8_t tiff[] = {'I', 'I', 42, 0, 0xff, 0xff, 0, 0};
  CHECK_EQ(ReadTiffOrientation(tiff, sizeof tiff), 1);
}

namespace {
// A TIFF block (little endian) with one IFD0 entry for tag 0x0112 of the given type/count/value.
Bytes Tiff(uint16_t type, uint32_t count, uint32_t value) {
  Bytes t = {'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01};
  t.push_back(type & 0xff);
  t.push_back(type >> 8);
  for (int i = 0; i < 4; ++i) t.push_back((count >> (8 * i)) & 0xff);
  for (int i = 0; i < 4; ++i) t.push_back((value >> (8 * i)) & 0xff);
  for (int i = 0; i < 4; ++i) t.push_back(0);  // next IFD
  return t;
}
}  // namespace

TEST(exif_orientation_accepts_only_what_skia_and_chromium_accept) {
  CHECK_EQ(ReadTiffOrientation(Tiff(3, 1, 6).data(), Tiff(3, 1, 6).size()), 6);  // SHORT, count 1
  Bytes long_typed = Tiff(4, 1, 6);  // LONG: ignored (the OS decoder ignores it too)
  CHECK_EQ(ReadTiffOrientation(long_typed.data(), long_typed.size()), 1);
  Bytes count2 = Tiff(3, 2, 6);
  CHECK_EQ(ReadTiffOrientation(count2.data(), count2.size()), 1);
  Bytes zero = Tiff(3, 1, 0);
  CHECK_EQ(ReadTiffOrientation(zero.data(), zero.size()), 1);
  // Orientation in the Exif sub-IFD (tag 0x8769) is followed, as Skia does.
  Bytes sub = {'M', 'M', 0, 42, 0, 0, 0, 8,
               0, 1, 0x87, 0x69, 0, 4, 0, 0, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0,
               0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 8, 0, 0, 0, 0, 0, 0};
  CHECK_EQ(ReadTiffOrientation(sub.data(), sub.size()), 8);
  // An entry count larger than the block is clamped, not rejected.
  Bytes big = Tiff(3, 1, 3);
  big[8] = 0xff;
  CHECK_EQ(ReadTiffOrientation(big.data(), big.size()), 3);
}

TEST(header_info_reads_stored_dimensions) {
  const Img img = Pattern(37, 21, true);
  Bytes png = EncodePng(img, 6, 8, false);
  HeaderInfo h = ReadHeaderInfo(png.data(), png.size(), Format::kPng);
  CHECK(h.known && h.width == 37 && h.height == 21);
  Bytes jpg = InsertJpegExif(EncodeJpeg(Pattern(37, 21, false), 90), 6, true);
  h = ReadHeaderInfo(jpg.data(), jpg.size(), Format::kJpeg);
  CHECK(h.known && h.width == 37 && h.height == 21);  // stored size, EXIF not applied
  for (bool lossless : {false, true}) {
    Bytes webp = EncodeWebp(img, lossless, 90);
    h = ReadHeaderInfo(webp.data(), webp.size(), Format::kWebp);
    CHECK(h.known && h.width == 37 && h.height == 21);
  }
  Bytes webpx = InsertWebpExif(EncodeWebp(img, true, 100), 37, 21, 6, true);  // VP8X container
  h = ReadHeaderInfo(webpx.data(), webpx.size(), Format::kWebp);
  CHECK(h.known && h.width == 37 && h.height == 21);
  Bytes gif = EncodeGif(Pattern(5, 3, false));
  h = ReadHeaderInfo(gif.data(), gif.size(), Format::kGif);
  CHECK(h.known && h.width == 5 && h.height == 3);
  for (size_t n = 0; n < 40; ++n) (void)ReadHeaderInfo(png.data(), n, Format::kPng);  // no out-of-bounds reads
}

TEST(png_minimum_size_bound_holds_for_real_files) {
  // The bound must never reject a real file: flat images compress best.
  for (uint32_t side : {1u, 64u, 1024u, 2048u}) {
    Img flat{side, side, std::vector<uint8_t>(size_t{side} * side * 4, 0)};
    Bytes png = EncodePng(flat, 6, 8, false);
    HeaderInfo h = ReadHeaderInfo(png.data(), png.size(), Format::kPng);
    CHECK(h.known && png.size() >= h.min_file_size);
    Bytes grey1 = EncodePng(flat, 0, 1, false);
    h = ReadHeaderInfo(grey1.data(), grey1.size(), Format::kPng);
    CHECK(h.known && grey1.size() >= h.min_file_size);
  }
}

TEST(jpeg_end_marker_detection) {
  Bytes jpg = EncodeJpeg(Pattern(40, 30, false), 80);
  CHECK(JpegHasEndAfterScan(jpg.data(), jpg.size()));
  CHECK(!JpegHasEndAfterScan(jpg.data(), jpg.size() - 2));
  CHECK(!JpegHasEndAfterScan(jpg.data(), jpg.size() / 2));
  // An EXIF thumbnail's EOI before the main scan does not count.
  Bytes with_exif = InsertJpegExif(jpg, 6, true);
  CHECK(!JpegHasEndAfterScan(with_exif.data(), with_exif.size() - 2));
  for (size_t n = 0; n < 64; ++n) (void)JpegHasEndAfterScan(jpg.data(), n);
}

TEST(forgiving_base64_follows_infra) {
  auto dec = [](const char* s, std::string* out) {
    std::vector<uint8_t> v;
    bool ok = ForgivingBase64Decode(reinterpret_cast<const uint8_t*>(s), std::strlen(s), &v);
    out->assign(v.begin(), v.end());
    return ok;
  };
  std::string o;
  CHECK(dec("", &o) && o.empty());
  CHECK(dec("YQ", &o) && o == "a");
  CHECK(dec("YQ==", &o) && o == "a");
  CHECK(dec("YWI=", &o) && o == "ab");
  CHECK(dec("YWJj", &o) && o == "abc");
  CHECK(dec(" Y W\nJ j\t", &o) && o == "abc");
  CHECK(dec("YQ= =", &o) && o == "a");  // whitespace between padding is removed first
  CHECK(!dec("Y", &o));
  CHECK(!dec("YQ=", &o));   // length 3 after whitespace removal: not a multiple of 4, '=' stays and is invalid
  CHECK(!dec("YQ===", &o));
  CHECK(!dec("Y=Q=", &o));
  CHECK(!dec("YQ-_", &o));  // base64url alphabet is not accepted
  CHECK(dec("/+==", &o) && o.size() == 1 && static_cast<uint8_t>(o[0]) == 0xff);
}
