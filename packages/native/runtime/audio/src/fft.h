// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Real FFT wrapper over KISS FFT (third_party/kissfft, BSD-3-Clause).
#pragma once

#include <complex>

namespace iwn::audio {

class RealFFT {
 public:
  explicit RealFFT(int n);  // n must be even (we only use powers of two)
  ~RealFFT();
  RealFFT(const RealFFT&) = delete;
  RealFFT& operator=(const RealFFT&) = delete;
  int size() const { return n_; }
  // out has n/2 + 1 bins.
  void forward(const float* in, std::complex<float>* out) const;
  // Unnormalised inverse (result is n times the signal).
  void inverse(const std::complex<float>* in, float* out) const;

 private:
  int n_;
  void* fwd_;
  void* inv_;
};

}  // namespace iwn::audio
