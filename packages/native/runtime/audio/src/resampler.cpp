// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
#include "resampler.h"

#include <cmath>
#include <cstdint>
#include <numeric>

namespace iwn::audio {

namespace {
constexpr double kPi = 3.14159265358979323846;
constexpr int kZeroCrossings = 32;
constexpr int kPhases = 512;
constexpr double kBeta = 9.0;
// Rational ratios up to this many output phases get an exact polyphase bank (phases x taps
// floats: 160 x 72 for 44.1 -> 48 kHz, 46 KB).
constexpr int64_t kMaxBankPhases = 4096;

double besselI0(double x) {
  double sum = 1, term = 1, k = 1;
  double y = x * x / 4;
  while (term > 1e-12 * sum) {
    term *= y / (k * k);
    sum += term;
    k += 1;
  }
  return sum;
}

struct Kernel {
  double fc;         // cutoff relative to the input Nyquist
  double halfWidth;  // in input samples
  int L;             // taps per side: input samples i0 - L + 1 .. i0 + L
  double i0b;
  explicit Kernel(double ratio) {
    fc = (ratio < 1 ? ratio : 1.0) * 0.96;
    halfWidth = kZeroCrossings / fc;
    L = static_cast<int>(std::ceil(halfWidth));
    i0b = besselI0(kBeta);
  }
  // Kaiser-windowed sinc at x input samples from the output instant.
  double at(double x) const {
    x = std::fabs(x);
    double u = x / halfWidth;
    if (u >= 1) return 0;
    double s = x == 0 ? 1.0 : std::sin(kPi * fc * x) / (kPi * fc * x);
    return fc * s * besselI0(kBeta * std::sqrt(1 - u * u)) / i0b;
  }
};

// Exact polyphase path for integer rates whose ratio reduces to a small fraction (every pair
// decodeAudioData meets in practice: 44.1/22.05/32/16/... kHz -> 48 kHz and back). Output o sits at
// input position o * M / U: integer part (o * M) / U, phase (o * M) % U. Each phase's taps are
// computed once (in double, stored as float), so the inner loop is a plain float dot product with
// independent partial sums, which the compiler vectorizes (NEON on device).
bool resamplePolyphase(const float* in, size_t inLen, double inRate, double outRate, float* out, size_t outLen) {
  if (inRate != std::floor(inRate) || outRate != std::floor(outRate) || inRate <= 0 || outRate <= 0) return false;
  int64_t a = static_cast<int64_t>(inRate), b = static_cast<int64_t>(outRate);
  int64_t g = std::gcd(a, b);
  int64_t U = b / g, M = a / g;  // output step = M / U input samples
  if (U > kMaxBankPhases) return false;
  Kernel k(outRate / inRate);
  const int taps = 2 * k.L;
  const int stride = (taps + 7) & ~7;  // padded to a multiple of 8 (zero taps)
  std::vector<float> bank(static_cast<size_t>(U) * static_cast<size_t>(stride), 0.f);
  for (int64_t p = 0; p < U; ++p) {
    double frac = static_cast<double>(p) / static_cast<double>(U);
    float* c = &bank[static_cast<size_t>(p) * static_cast<size_t>(stride)];
    for (int t = 0; t < taps; ++t) c[t] = static_cast<float>(k.at(static_cast<double>(t - k.L + 1) - frac));
  }
  const long long n = static_cast<long long>(inLen);
  for (size_t o = 0; o < outLen; ++o) {
    unsigned long long pos = static_cast<unsigned long long>(o) * static_cast<unsigned long long>(M);
    long long i0 = static_cast<long long>(pos / static_cast<unsigned long long>(U));
    size_t phase = static_cast<size_t>(pos % static_cast<unsigned long long>(U));
    const float* c = &bank[phase * static_cast<size_t>(stride)];
    long long first = i0 - k.L + 1;  // input index of tap 0
    if (first >= 0 && first + stride <= n) {
      const float* x = in + first;
      float acc[8] = {0, 0, 0, 0, 0, 0, 0, 0};
      for (int t = 0; t < stride; t += 8)
        for (int j = 0; j < 8; ++j) acc[j] += x[t + j] * c[t + j];
      out[o] = ((acc[0] + acc[4]) + (acc[1] + acc[5])) + ((acc[2] + acc[6]) + (acc[3] + acc[7]));
    } else {
      // Edges: taps outside the input are zero.
      double acc = 0;
      for (int t = 0; t < taps; ++t) {
        long long i = first + t;
        if (i >= 0 && i < n) acc += static_cast<double>(in[i]) * c[t];
      }
      out[o] = static_cast<float>(acc);
    }
  }
  return true;
}

// General path (non-integer rates, very fine ratios): kernel table with linear interpolation
// between kPhases phases per input sample.
void resampleTable(const float* in, size_t inLen, double inRate, double outRate, float* out, size_t outLen) {
  double ratio = outRate / inRate;
  Kernel k(ratio);
  int tableLen = static_cast<int>(std::ceil(k.halfWidth * kPhases)) + 2;
  std::vector<double> table(static_cast<size_t>(tableLen));
  for (int i = 0; i < tableLen; ++i) table[static_cast<size_t>(i)] = k.at(static_cast<double>(i) / kPhases);
  auto h = [&](double x) {
    double p = std::fabs(x) * kPhases;
    int i = static_cast<int>(p);
    if (i + 1 >= tableLen) return 0.0;
    double f = p - i;
    return table[static_cast<size_t>(i)] + (table[static_cast<size_t>(i + 1)] - table[static_cast<size_t>(i)]) * f;
  };
  int L = k.L;
  long long n = static_cast<long long>(inLen);
  for (size_t o = 0; o < outLen; ++o) {
    double t = static_cast<double>(o) / ratio;
    long long i0 = static_cast<long long>(std::floor(t));
    double frac = t - static_cast<double>(i0);
    double acc = 0;
    long long kb = i0 - L + 1 < 0 ? -i0 : -L + 1;
    long long ke = i0 + L >= n ? n - 1 - i0 : L;
    for (long long j = kb; j <= ke; ++j) acc += in[i0 + j] * h(static_cast<double>(j) - frac);
    out[o] = static_cast<float>(acc);
  }
}
}  // namespace

size_t resampledLength(size_t inLen, double inRate, double outRate) {
  return static_cast<size_t>(std::ceil(static_cast<double>(inLen) * outRate / inRate - 1e-9));
}

void resampleInto(const float* in, size_t inLen, double inRate, double outRate, float* out, size_t outLen) {
  if (outLen == 0) return;
  if (inLen == 0) {
    for (size_t i = 0; i < outLen; ++i) out[i] = 0.f;
    return;
  }
  if (inRate == outRate) {
    for (size_t i = 0; i < outLen; ++i) out[i] = i < inLen ? in[i] : 0.f;
    return;
  }
  if (!resamplePolyphase(in, inLen, inRate, outRate, out, outLen)) resampleTable(in, inLen, inRate, outRate, out, outLen);
}

void resampleTableIntoForTest(const float* in, size_t inLen, double inRate, double outRate, float* out, size_t outLen) {
  resampleTable(in, inLen, inRate, outRate, out, outLen);
}

std::vector<float> resampleChannel(const float* in, size_t inLen, double inRate, double outRate) {
  std::vector<float> out(resampledLength(inLen, inRate, outRate), 0.f);
  resampleInto(in, inLen, inRate, outRate, out.data(), out.size());
  return out;
}

}  // namespace iwn::audio
