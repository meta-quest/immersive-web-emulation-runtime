// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// AUD-8 fuzz check: mutates the fixture files (bit flips, byte runs, truncation, splices) and
// feeds them to decodeAudio for a fixed time. Build with -fsanitize=address,undefined for the
// CPU-hour run:  iwn_audio_fuzz <seconds> <seed> <files...>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <random>
#include <string>
#include <vector>

#include "decode.h"

int main(int argc, char** argv) {
  if (argc < 4) {
    std::fprintf(stderr, "usage: %s <seconds> <seed> <files...>\n", argv[0]);
    return 2;
  }
  double seconds = std::atof(argv[1]);
  std::mt19937_64 rng(std::strtoull(argv[2], nullptr, 10));
  std::vector<std::vector<uint8_t>> seeds;
  for (int i = 3; i < argc; ++i) {
    std::ifstream f(argv[i], std::ios::binary);
    seeds.emplace_back((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  }
  auto t0 = std::chrono::steady_clock::now();
  uint64_t iters = 0, decoded = 0;
  while (std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count() < seconds) {
    std::vector<uint8_t> d = seeds[rng() % seeds.size()];
    int muts = 1 + int(rng() % 16);
    for (int m = 0; m < muts && !d.empty(); ++m) {
      size_t pos = rng() % d.size();
      switch (rng() % 6) {
        case 0: d[pos] ^= uint8_t(1u << (rng() % 8)); break;
        case 1: d[pos] = uint8_t(rng()); break;
        case 2: d.resize(pos + 1); break;
        case 3: {
          size_t len = std::min<size_t>(d.size() - pos, 1 + rng() % 64);
          uint8_t v = uint8_t(rng());
          for (size_t k = 0; k < len; ++k) d[pos + k] = v;
          break;
        }
        case 4: {
          const auto& o = seeds[rng() % seeds.size()];
          size_t from = rng() % o.size(), len = std::min<size_t>(o.size() - from, 1 + rng() % 512);
          d.insert(d.begin() + long(pos), o.begin() + long(from), o.begin() + long(from + len));
          break;
        }
        case 5: {  // header field corruption near the start
          size_t p = rng() % std::min<size_t>(d.size(), 64);
          d[p] = uint8_t(rng());
          break;
        }
      }
    }
    iwn::audio::DecodeOutcome o = iwn::audio::decodeAudio(d.data(), d.size(), (rng() & 1) ? 48000.f : 0.f);
    if (o.buffer) {
      ++decoded;
      o.buffer->release();
    }
    ++iters;
  }
  std::printf("fuzz: %llu inputs, %llu decoded, no crash\n", (unsigned long long)iters, (unsigned long long)decoded);
  return 0;
}
