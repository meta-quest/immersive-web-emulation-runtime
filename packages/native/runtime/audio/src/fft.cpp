// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
#include "fft.h"

#include "kiss_fftr.h"

namespace iwn::audio {

static_assert(sizeof(kiss_fft_cpx) == sizeof(std::complex<float>), "layout");

RealFFT::RealFFT(int n)
    : n_(n),
      fwd_(kiss_fftr_alloc(n, 0, nullptr, nullptr)),
      inv_(kiss_fftr_alloc(n, 1, nullptr, nullptr)) {}

RealFFT::~RealFFT() {
  kiss_fftr_free(fwd_);
  kiss_fftr_free(inv_);
}

void RealFFT::forward(const float* in, std::complex<float>* out) const {
  kiss_fftr(static_cast<kiss_fftr_cfg>(fwd_), in, reinterpret_cast<kiss_fft_cpx*>(out));
}

void RealFFT::inverse(const std::complex<float>* in, float* out) const {
  kiss_fftri(static_cast<kiss_fftr_cfg>(inv_), reinterpret_cast<const kiss_fft_cpx*>(in), out);
}

}  // namespace iwn::audio
