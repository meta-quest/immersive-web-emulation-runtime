// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Offline band-limited resampler for decodeAudioData (AUD-8: "resamples to the context's rate
// with a quality resampler"). Kaiser-windowed sinc, 32 zero crossings per side, stopband
// attenuation > 90 dB; the cutoff follows the lower of the two Nyquist frequencies.
//
// Integer rates whose ratio reduces to at most 4096 output phases (all common pairs, e.g. 44.1 ->
// 48 kHz = 160/147) use an exact polyphase bank: per-phase float taps computed once, a vectorizable
// dot product per output sample. Other ratios interpolate linearly in a 512-phase kernel table.
#pragma once

#include <cstddef>
#include <vector>

namespace iwn::audio {

// Output length = ceil(inLen * outRate / inRate).
size_t resampledLength(size_t inLen, double inRate, double outRate);
// Resamples one channel into `out` (outLen samples, normally resampledLength(...)).
void resampleInto(const float* in, size_t inLen, double inRate, double outRate, float* out, size_t outLen);
// Convenience wrapper returning a vector.
std::vector<float> resampleChannel(const float* in, size_t inLen, double inRate, double outRate);
// The general (table) path regardless of the ratio, for tests.
void resampleTableIntoForTest(const float* in, size_t inLen, double inRate, double outRate, float* out, size_t outLen);

}  // namespace iwn::audio
