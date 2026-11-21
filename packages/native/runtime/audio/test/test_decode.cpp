// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// AUD-8 / AUD-9 checks: every fixture decodes to the expected tones; when ffmpeg is on PATH the
// decode is also compared with ffmpeg's decoder (SNR >= 60 dB after alignment); the resampler is
// checked against an analytic sine; garbage is rejected with a reason.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>

#include "decode.h"
#include "resampler.h"
#include "test.h"

using namespace iwn::audio;

namespace {
constexpr double kPi = 3.14159265358979323846;

std::vector<uint8_t> readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

// Goertzel power at frequency f (normalised by length).
double tonePower(const float* x, size_t n, double f, double sr) {
  double w = 2 * kPi * f / sr, c = 2 * std::cos(w), s1 = 0, s2 = 0;
  for (size_t i = 0; i < n; ++i) {
    double s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  double p = s1 * s1 + s2 * s2 - c * s1 * s2;
  return p / (double(n) * n);
}

bool haveFfmpeg() {
  static int have = -1;
  if (have < 0) have = std::system("ffmpeg -version > /dev/null 2>&1") == 0 ? 1 : 0;
  return have == 1;
}

// ffmpeg reference decode at the file's own rate, planar.
std::vector<std::vector<float>> ffmpegDecode(const std::string& path, int channels) {
  std::string cmd = "ffmpeg -hide_banner -loglevel error -i '" + path + "' -f f32le -acodec pcm_f32le -";
  FILE* p = popen(cmd.c_str(), "r");
  std::vector<float> inter;
  float buf[4096];
  size_t got;
  while ((got = fread(buf, sizeof(float), 4096, p)) > 0) inter.insert(inter.end(), buf, buf + got);
  pclose(p);
  std::vector<std::vector<float>> out(static_cast<size_t>(channels));
  for (size_t i = 0; i + size_t(channels) <= inter.size(); i += size_t(channels))
    for (int c = 0; c < channels; ++c) out[size_t(c)].push_back(inter[i + size_t(c)]);
  return out;
}

// Best SNR (dB) over lags in [-maxLag, maxLag], ignoring `edge` samples at both ends.
double alignedSnr(const float* a, size_t na, const std::vector<float>& ref, int maxLag, size_t edge) {
  double best = -1e9;
  for (int lag = -maxLag; lag <= maxLag; ++lag) {
    double sig = 0, err = 0;
    for (size_t i = edge; i + edge < ref.size(); ++i) {
      long j = long(i) + lag;
      if (j < 0 || size_t(j) >= na) continue;
      double r = ref[i];
      double d = r - a[j];
      sig += r * r;
      err += d * d;
    }
    if (sig <= 0) continue;
    double snr = err > 0 ? 10 * std::log10(sig / err) : 200;
    best = std::max(best, snr);
  }
  return best;
}

struct Fixture {
  const char* file;
  int channels;
  double rate;
};

void checkFixture(const Fixture& fx) {
  std::string path = std::string(IWN_AUDIO_FIXTURES) + "/" + fx.file;
  std::vector<uint8_t> bytes = readFile(path);
  CHECK(!bytes.empty());
  DecodeOutcome o = decodeAudio(bytes.data(), bytes.size(), 0);
  if (!o.buffer) {
    std::fprintf(stderr, "  decode %s failed: %s\n", fx.file, o.error.c_str());
    CHECK(o.buffer != nullptr);
    return;
  }
  BufferData* b = o.buffer;
  CHECK(b->channels() == fx.channels);
  CHECK_NEAR(b->sampleRate(), fx.rate, 0);
  double dur = double(b->length()) / b->sampleRate();
  bool isWav = std::strncmp(fx.file, "wav", 3) == 0;
  CHECK_NEAR(dur, isWav ? 0.25 : 1.0, isWav ? 0.001 : 0.06);
  // Tones: left 440 Hz, right 660 Hz.
  size_t n = std::min<size_t>(b->length(), size_t(b->sampleRate() / 5));
  const float* l = b->channel(0) + b->length() / 2 - n / 2;
  double p440 = tonePower(l, n, 440, b->sampleRate()), p660 = tonePower(l, n, 660, b->sampleRate());
  CHECK(p440 > 0.05);       // 0.5 amplitude -> 0.0625
  CHECK(p660 < p440 * 1e-3);
  if (fx.channels == 2) {
    const float* r = b->channel(1) + b->length() / 2 - n / 2;
    CHECK(tonePower(r, n, 660, b->sampleRate()) > 0.05);
  }
  if (haveFfmpeg()) {
    auto ref = ffmpegDecode(path, fx.channels);
    for (int c = 0; c < fx.channels; ++c) {
      double snr = alignedSnr(b->channel(c), b->length(), ref[size_t(c)], 1200, 2400);
      std::printf("    %s ch%d: SNR vs ffmpeg %.1f dB (%s)\n", fx.file, c, snr, o.format.c_str());
      CHECK(snr >= 60);
    }
  }
  b->release();
}
}  // namespace

TEST(decode_fixtures_wav) {
  checkFixture({"wav-22050-mono-s16.wav", 1, 22050});
  checkFixture({"wav-44100-stereo-s24.wav", 2, 44100});
  checkFixture({"wav-48000-stereo-f32.wav", 2, 48000});
}

TEST(decode_fixtures_mp3) {
  checkFixture({"mp3-44100-stereo-cbr.mp3", 2, 44100});
  checkFixture({"mp3-22050-mono-vbr.mp3", 1, 22050});
  checkFixture({"mp3-48000-stereo-vbr-id3.mp3", 2, 48000});
}

TEST(decode_fixtures_vorbis) {
  checkFixture({"vorbis-44100-stereo.ogg", 2, 44100});
  checkFixture({"vorbis-48000-mono.ogg", 1, 48000});
  checkFixture({"vorbis-22050-mono.ogg", 1, 22050});
}

TEST(decode_platform_formats_rejected_cleanly_on_host) {
  // Android decodes these through MediaCodec; the host has no platform decoder.
  for (const char* f : {"aac-44100-stereo.m4a", "flac-44100-stereo.flac", "opus-48000-stereo.ogg"}) {
    auto bytes = readFile(std::string(IWN_AUDIO_FIXTURES) + "/" + f);
    DecodeOutcome o = decodeAudio(bytes.data(), bytes.size(), 48000);
    CHECK(o.buffer == nullptr);
    CHECK(!o.error.empty());
  }
}

TEST(decode_garbage_reports_reason) {
  for (const char* f : {"garbage.mp3", "html-404.mp3"}) {
    auto bytes = readFile(std::string(IWN_AUDIO_FIXTURES) + "/" + f);
    DecodeOutcome o = decodeAudio(bytes.data(), bytes.size(), 48000);
    CHECK(o.buffer == nullptr);
    CHECK(!o.error.empty());
    std::printf("    %s -> %s\n", f, o.error.c_str());
  }
  DecodeOutcome e = decodeAudio(nullptr, 0, 48000);
  CHECK(e.buffer == nullptr);
}

TEST(decode_resamples_to_context_rate) {
  auto bytes = readFile(std::string(IWN_AUDIO_FIXTURES) + "/vorbis-22050-mono.ogg");
  DecodeOutcome o = decodeAudio(bytes.data(), bytes.size(), 48000);
  CHECK(o.buffer != nullptr);
  if (!o.buffer) return;
  CHECK_NEAR(o.buffer->sampleRate(), 48000, 0);
  CHECK_NEAR(double(o.buffer->length()) / 48000, 1.0, 0.06);
  size_t n = 9600;
  const float* x = o.buffer->channel(0) + o.buffer->length() / 2 - n / 2;
  CHECK(tonePower(x, n, 440, 48000) > 0.05);
  o.buffer->release();
}

TEST(resampler_quality_sine) {
  for (auto rates : {std::pair<double, double>{44100, 48000}, {22050, 48000}, {48000, 44100}, {96000, 48000}}) {
    double fin = rates.first, fout = rates.second, f = 1000;
    std::vector<float> x(static_cast<size_t>(fin));
    for (size_t i = 0; i < x.size(); ++i) x[i] = float(0.5 * std::sin(2 * kPi * f * double(i) / fin));
    std::vector<float> y = resampleChannel(x.data(), x.size(), fin, fout);
    CHECK(y.size() == resampledLength(x.size(), fin, fout));
    double sig = 0, err = 0;
    for (size_t i = 200; i + 200 < y.size(); ++i) {
      double ref = 0.5 * std::sin(2 * kPi * f * double(i) / fout);
      sig += ref * ref;
      err += (ref - y[i]) * (ref - y[i]);
    }
    double snr = 10 * std::log10(sig / err);
    std::printf("    %g -> %g: SNR %.1f dB\n", fin, fout, snr);
    CHECK(snr > 80);
  }
}

TEST(resampler_polyphase_matches_table_and_is_fast) {
  // The polyphase bank (integer rates) and the general table path compute the same kernel; the
  // bank is exact per phase, the table interpolates between 512 phases.
  double fin = 44100, fout = 48000;
  std::vector<float> x(44100 * 2);
  uint32_t seed = 1;
  for (auto& v : x) {
    seed = seed * 1664525u + 1013904223u;
    v = float((seed >> 8) / 16777216.0 - 0.5);
  }
  size_t outLen = resampledLength(x.size(), fin, fout);
  std::vector<float> a(outLen), b(outLen);
  auto t0 = std::chrono::steady_clock::now();
  resampleInto(x.data(), x.size(), fin, fout, a.data(), outLen);
  auto t1 = std::chrono::steady_clock::now();
  resampleTableIntoForTest(x.data(), x.size(), fin, fout, b.data(), outLen);
  auto t2 = std::chrono::steady_clock::now();
  double maxDiff = 0;
  for (size_t i = 0; i < outLen; ++i) maxDiff = std::max(maxDiff, double(std::fabs(a[i] - b[i])));
  double polyMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
  double tableMs = std::chrono::duration<double, std::milli>(t2 - t1).count();
  std::printf("    2 s mono 44.1 -> 48 kHz: polyphase %.1f ms, table %.1f ms, max diff %.2g\n", polyMs, tableMs, maxDiff);
  CHECK(maxDiff < 2e-4);
  if (!IWN_TEST_SANITIZED) CHECK(polyMs * 3 < tableMs);
  // A non-integer rate takes the table path and keeps its quality.
  std::vector<float> s(44100);
  for (size_t i = 0; i < s.size(); ++i) s[i] = float(0.5 * std::sin(2 * kPi * 1000 * double(i) / 44100.5));
  std::vector<float> y = resampleChannel(s.data(), s.size(), 44100.5, 48000);
  double sig = 0, err = 0;
  for (size_t i = 200; i + 200 < y.size(); ++i) {
    double ref = 0.5 * std::sin(2 * kPi * 1000 * double(i) / 48000);
    sig += ref * ref;
    err += (ref - y[i]) * (ref - y[i]);
  }
  CHECK(10 * std::log10(sig / err) > 80);
}

TEST(wav_synthetic_formats) {
  // 8-bit unsigned, mu-law and A-law, extensible float: hand-built headers.
  auto make = [](uint16_t tag, uint16_t bits, const std::vector<uint8_t>& data, bool extensible) {
    std::vector<uint8_t> f;
    auto p32 = [&](uint32_t v) { for (int i = 0; i < 4; ++i) f.push_back(uint8_t(v >> (8 * i))); };
    auto p16 = [&](uint16_t v) { f.push_back(uint8_t(v)); f.push_back(uint8_t(v >> 8)); };
    uint32_t fmtLen = extensible ? 40 : 16;
    f.insert(f.end(), {'R', 'I', 'F', 'F'});
    p32(uint32_t(4 + 8 + fmtLen + 8 + data.size()));
    f.insert(f.end(), {'W', 'A', 'V', 'E', 'f', 'm', 't', ' '});
    p32(fmtLen);
    p16(extensible ? 0xFFFE : tag);
    p16(1);
    p32(8000);
    p32(8000 * bits / 8);
    p16(bits / 8);
    p16(bits);
    if (extensible) {
      p16(22);
      p16(bits);
      p32(0);
      p16(tag);
      for (int i = 0; i < 14; ++i) f.push_back(0);
    }
    f.insert(f.end(), {'d', 'a', 't', 'a'});
    p32(uint32_t(data.size()));
    f.insert(f.end(), data.begin(), data.end());
    return f;
  };
  Pcm pcm;
  std::string err;
  CHECK(decodeWav(make(1, 8, {0, 128, 255}, false).data(), make(1, 8, {0, 128, 255}, false).size(), pcm, &err));
  CHECK_NEAR(pcm.data[0][0], -1, 1e-6);
  CHECK_NEAR(pcm.data[0][1], 0, 1e-6);
  CHECK_NEAR(pcm.data[0][2], 127.0 / 128, 1e-6);
  auto mu = make(7, 8, {0xFF, 0x80, 0x00}, false);
  CHECK(decodeWav(mu.data(), mu.size(), pcm, &err));
  CHECK_NEAR(pcm.data[0][0], 0, 1e-6);           // 0xFF = +0
  CHECK_NEAR(pcm.data[0][1], 32124.0 / 32768, 1e-4);   // max positive
  CHECK_NEAR(pcm.data[0][2], -32124.0 / 32768, 1e-4);  // max negative
  auto al = make(6, 8, {0xD5, 0x55}, false);
  CHECK(decodeWav(al.data(), al.size(), pcm, &err));
  CHECK_NEAR(pcm.data[0][0], 8.0 / 32768, 1e-6);
  CHECK_NEAR(pcm.data[0][1], -8.0 / 32768, 1e-6);
  float fv[2] = {0.25f, -0.75f};
  std::vector<uint8_t> fd(8);
  std::memcpy(fd.data(), fv, 8);
  auto ext = make(3, 32, fd, true);
  CHECK(decodeWav(ext.data(), ext.size(), pcm, &err));
  CHECK_NEAR(pcm.data[0][1], -0.75, 0);
  auto bad = make(2, 4, {0}, false);  // ADPCM: unsupported
  CHECK(!decodeWav(bad.data(), bad.size(), pcm, &err));
  CHECK(!err.empty());
}
