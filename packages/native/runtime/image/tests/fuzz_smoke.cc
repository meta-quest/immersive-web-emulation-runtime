// Mutation fuzz smoke test for the decode pipeline (IMG-2). Build with -DIWN_IMAGE_SANITIZE=ON (ASan + UBSan) and
// run for a time budget:  iwn_image_fuzz_smoke <seconds> [seed]
// Seeds are generated PNG (all colour types, interlaced), JPEG (+EXIF), WebP (lossy, lossless, EXIF), GIF, BMP-ish
// headers. Also feeds every input to the base64 decoder and the header reader. Mutations: bit flips, byte sets, truncation, chunk duplication, length-field corruption.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <random>

#include "iwn/image/decode.h"
#include "test_images.h"

using namespace iwn::image;
using namespace iwn::image::test;

int main(int argc, char** argv) {
  const double seconds = argc > 1 ? std::atof(argv[1]) : 10.0;
  const unsigned seed = argc > 2 ? static_cast<unsigned>(std::atoi(argv[2])) : 1234u;
  std::mt19937 rng(seed);
  const Img a = Pattern(23, 17, true), b = Pattern(8, 8, false);
  std::vector<Bytes> seeds = {
      EncodePng(a, 6, 8, false), EncodePng(a, 6, 16, true), EncodePng(b, 0, 1, false), EncodePng(b, 2, 8, true),
      InsertPngExif(EncodePng(b, 2, 8, false), 6), EncodeJpeg(a, 75), InsertJpegExif(EncodeJpeg(b, 90), 8, true),
      EncodeWebp(a, false, 70), EncodeWebp(a, true, 100), InsertWebpExif(EncodeWebp(b, true, 100), 8, 8, 5, false),
      EncodeGif(a)};
  Bytes progressive;
  if (ReadFile(TestData("libjpeg", "testimgint.jpg"), &progressive)) {
    seeds.push_back(progressive);
  }
  DecodeOptions opts[4];
  opts[1].process.flip_y = true;
  opts[1].process.alpha = AlphaRequest::kPremultiplied;
  opts[2].process.has_crop = true;
  opts[2].process.crop = Rect{-3, 2, 9, 40};
  opts[2].process.resize_width = 5;
  opts[2].process.resize_height = 7;
  opts[2].process.quality = ResizeQuality::kHigh;
  opts[3].process.resize_width = 3;  // plain resize: the downscaled-decode hint (libwebp rescaler, AImageDecoder)
  opts[3].process.resize_height = 2;
  opts[3].process.quality = ResizeQuality::kMedium;
  opts[3].apply_exif_orientation = false;

  const auto start = std::chrono::steady_clock::now();
  uint64_t iterations = 0, decoded = 0;
  while (std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count() < seconds) {
    Bytes in = seeds[rng() % seeds.size()];
    const int mutations = 1 + static_cast<int>(rng() % 8);
    for (int m = 0; m < mutations && !in.empty(); ++m) {
      switch (rng() % 6) {
        case 0: in[rng() % in.size()] ^= static_cast<uint8_t>(1u << (rng() % 8)); break;
        case 1: in[rng() % in.size()] = static_cast<uint8_t>(rng()); break;
        case 2: in.resize(rng() % in.size()); break;
        case 3: {  // duplicate a slice
          size_t from = rng() % in.size(), len = std::min<size_t>(rng() % 64, in.size() - from);
          size_t at = rng() % in.size();
          Bytes slice(in.begin() + from, in.begin() + from + len);
          in.insert(in.begin() + at, slice.begin(), slice.end());
          break;
        }
        case 4: {  // big-endian length field set to an extreme
          size_t at = rng() % in.size();
          for (size_t i = 0; i < 4 && at + i < in.size(); ++i) in[at + i] = (rng() % 2) ? 0xff : 0x00;
          break;
        }
        case 5: in.erase(in.begin() + (rng() % in.size())); break;
      }
    }
    DecodeResult r = Decode(in.data(), in.size(), opts[iterations % 4]);
    {
      Bytes b64;
      (void)ForgivingBase64Decode(in.data(), in.size(), &b64);
      (void)ReadHeaderInfo(in.data(), in.size(), SniffFormat(in.data(), in.size()));
    }
    if (r.status == Status::kOk) {
      ++decoded;
      ScopedPixels sp = r.store->Read();
      volatile uint8_t sink = 0;
      const PixelView& v = sp.view();
      for (uint32_t y = 0; y < v.height; ++y) sink = sink + v.data[y * v.stride + (v.width - 1) * 4 + 3];
      (void)sink;
    }
    ++iterations;
  }
  std::printf("fuzz smoke: %llu inputs in %.0f s (seed %u), %llu decoded, no crash\n",
              static_cast<unsigned long long>(iterations), seconds, seed, static_cast<unsigned long long>(decoded));
  return 0;
}
