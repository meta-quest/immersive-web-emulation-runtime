/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Decode cost per format and option set on the decode pool's thread (the JS thread pays none of it: PROC-2,
// REG-16). Usage: iwn_image_bench [size=2048] [iterations=5]
// Peak memory of one decode (a fresh process per measurement; VmHWM is process-wide):
//   iwn_image_bench gen <dir>                 writes big8k.jpg (8192x8192) and claim.png (header 16000x16000, 70 B)
//   iwn_image_bench peak <file> [w h]          decodes once (resized to w x h if given), prints status, time, VmHWM
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <utility>
#include <vector>

#include "iwn/image/decode.h"
#include "test_images.h"

using namespace iwn::image;
using namespace iwn::image::test;

namespace {

long VmHwmKb() {
  long kb = 0;
  if (FILE* f = std::fopen("/proc/self/status", "r")) {
    char line[256];
    while (std::fgets(line, sizeof line, f)) {
      if (std::sscanf(line, "VmHWM: %ld kB", &kb) == 1) break;
    }
    std::fclose(f);
  }
  return kb;
}

int Gen(const std::string& dir) {
  Img big = Pattern(8192, 8192, false);
  Bytes jpg = EncodeJpeg(big, 90);
  Bytes png = EncodePng(Pattern(1, 1, true), 6, 8, false);
  for (int i = 0; i < 4; ++i) {
    png[16 + i] = (16000u >> (24 - 8 * i)) & 0xff;
    png[20 + i] = (16000u >> (24 - 8 * i)) & 0xff;
  }
  for (const auto& [name, bytes] : {std::pair<const char*, Bytes*>{"big8k.jpg", &jpg}, {"claim.png", &png}}) {
    FILE* f = std::fopen((dir + "/" + name).c_str(), "wb");
    if (!f) return 1;
    std::fwrite(bytes->data(), 1, bytes->size(), f);
    std::fclose(f);
  }
  return 0;
}

int Peak(const std::string& path, uint32_t w, uint32_t h) {
  Bytes bytes;
  if (!ReadFile(path, &bytes)) return 2;
  DecodeOptions o;
  o.process.resize_width = w;
  o.process.resize_height = h;
  o.process.quality = ResizeQuality::kLow;
  const long before = VmHwmKb();
  auto t0 = std::chrono::steady_clock::now();
  DecodeResult r = Decode(bytes.data(), bytes.size(), o);
  const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  std::printf("%s (%zu B)%s: %s %ux%u via %s, %.0f ms, VmHWM %.0f MB -> %.0f MB\n", path.c_str(), bytes.size(),
              w ? " resized" : "", StatusName(r.status), r.store ? r.store->width() : 0, r.store ? r.store->height() : 0,
              r.backend, ms, before / 1024.0, VmHwmKb() / 1024.0);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc > 2 && std::string(argv[1]) == "gen") return Gen(argv[2]);
  if (argc > 2 && std::string(argv[1]) == "peak") {
    return Peak(argv[2], argc > 4 ? static_cast<uint32_t>(std::atoi(argv[3])) : 0,
                argc > 4 ? static_cast<uint32_t>(std::atoi(argv[4])) : 0);
  }
  const uint32_t size = argc > 1 ? static_cast<uint32_t>(std::atoi(argv[1])) : 2048;
  const int iterations = argc > 2 ? std::atoi(argv[2]) : 5;
  Img img = Pattern(size, size, true);
  // Add noise so the encoders cannot collapse the image.
  uint32_t seed = 12345;
  for (size_t i = 0; i < img.rgba.size(); ++i) {
    seed = seed * 1664525u + 1013904223u;
    img.rgba[i] = static_cast<uint8_t>(img.rgba[i] ^ ((seed >> 24) & 0x1f));
  }
  Img opaque = img;
  for (size_t i = 3; i < opaque.rgba.size(); i += 4) opaque.rgba[i] = 255;
  struct File { const char* name; Bytes bytes; };
  std::vector<File> files = {
      {"jpeg q90", EncodeJpeg(opaque, 90)},
      {"png rgba", EncodePng(img, 6, 8, false)},
      {"webp lossy alpha", EncodeWebp(img, false, 80)},
  };
  struct Opt { const char* name; DecodeOptions o; };
  std::vector<Opt> opts(3);
  opts[0].name = "default";
  opts[1].name = "flipY + premultiplyAlpha none (three.js)";
  opts[1].o.process.flip_y = true;
  opts[1].o.process.alpha = AlphaRequest::kUnpremultiplied;
  opts[2].name = "premultiply";
  opts[2].o.process.alpha = AlphaRequest::kPremultiplied;
  std::printf("backends:");
  for (DecoderBackend* b : DefaultBackends()) std::printf(" %s", b->name());
  std::printf("\n%ux%u, best of %d\n", size, size, iterations);
  for (const File& f : files) {
    for (const Opt& o : opts) {
      double best = 1e9;
      for (int i = 0; i < iterations; ++i) {
        auto t0 = std::chrono::steady_clock::now();
        DecodeResult r = Decode(f.bytes.data(), f.bytes.size(), o.o);
        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        if (r.status != Status::kOk) {
          std::printf("%s: decode failed (%s)\n", f.name, StatusName(r.status));
          return 1;
        }
        best = std::min(best, ms);
      }
      std::printf("  %-18s %8zu B  %-42s %7.1f ms\n", f.name, f.bytes.size(), o.name, best);
    }
  }
  return 0;
}
