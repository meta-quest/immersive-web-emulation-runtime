// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
#include "core.h"

#include <cstdint>
#include <cstdlib>
#include <new>

namespace iwn::audio {

BufferData* BufferData::create(int channels, size_t length, float sampleRate) {
  auto* b = new (std::nothrow) BufferData();
  if (!b) return nullptr;
  b->channels_ = channels;
  b->length_ = length;
  b->sampleRate_ = sampleRate;
  // Pad each channel to a 16-float boundary so channel views stay 64-byte aligned.
  b->stride_ = (length + 15) & ~static_cast<size_t>(15);
  size_t total = b->stride_ * static_cast<size_t>(channels);
  if (total == 0) total = 16;
  if (total > kMaxBytes / sizeof(float)) {
    delete b;
    return nullptr;
  }
  // calloc rather than posix_memalign + memset: large blocks come zeroed from mmap, so a big
  // buffer only commits the pages that get written. Over-allocate to align the samples to 64 bytes.
  void* p = std::calloc(total * sizeof(float) + 64, 1);
  if (!p) {
    delete b;
    return nullptr;
  }
  b->base_ = p;
  auto addr = (reinterpret_cast<uintptr_t>(p) + 63) & ~static_cast<uintptr_t>(63);
  b->data_ = reinterpret_cast<float*>(addr);
  return b;
}

BufferData::~BufferData() { std::free(base_); }

void BufferData::release() {
  if (refs_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete this;
}

void BufferData::destroy() { delete this; }

AudioBus::AudioBus(int capacity)
    : capacity_(capacity < 1 ? 1 : capacity),
      channels_(1),
      data_(static_cast<size_t>(capacity_) * kQuantum, 0.f) {}

void AudioBus::zero() {
  // Invariant: a silent bus holds zeros in every channel of its capacity, so silent buses (most
  // of them, most of the time) need no memset.
  if (silent_) return;
  std::memset(data_.data(), 0, data_.size() * sizeof(float));
  silent_ = true;
}

void AudioBus::sumFrom(const AudioBus& src, ChannelInterpretation interp) {
  if (src.silent()) return;
  const float* in[kMaxChannels];
  float* out[kMaxChannels];
  for (int c = 0; c < src.channels(); ++c) in[c] = src.channel(c);
  for (int c = 0; c < channels_; ++c) out[c] = channel(c);
  mixChannels(in, src.channels(), out, channels_, interp);
  silent_ = false;
}

void AudioBus::copyFrom(const AudioBus& src, ChannelInterpretation interp) {
  zero();
  sumFrom(src, interp);
}

namespace {

inline void addScaled(float* out, const float* in, float g, int n) {
  for (int i = 0; i < n; ++i) out[i] += in[i] * g;
}

}  // namespace

void mixChannels(const float* const* in, int inCh, float* const* out, int outCh,
                 ChannelInterpretation interp, int n) {
  if (inCh == outCh) {
    for (int c = 0; c < inCh; ++c) addScaled(out[c], in[c], 1.f, n);
    return;
  }
  const float kSqrtHalf = 0.70710678118654752f;
  if (interp == ChannelInterpretation::Speakers) {
    // Up-mixing.
    if (inCh == 1 && outCh == 2) {  // L = M, R = M
      addScaled(out[0], in[0], 1.f, n);
      addScaled(out[1], in[0], 1.f, n);
      return;
    }
    if (inCh == 1 && outCh == 4) {  // L = M, R = M, SL = SR = 0
      addScaled(out[0], in[0], 1.f, n);
      addScaled(out[1], in[0], 1.f, n);
      return;
    }
    if (inCh == 1 && outCh == 6) {  // C = M
      addScaled(out[2], in[0], 1.f, n);
      return;
    }
    if (inCh == 2 && (outCh == 4 || outCh == 6)) {  // L, R; others 0
      addScaled(out[0], in[0], 1.f, n);
      addScaled(out[1], in[1], 1.f, n);
      return;
    }
    if (inCh == 4 && outCh == 6) {  // L, R, C=0, LFE=0, SL, SR
      addScaled(out[0], in[0], 1.f, n);
      addScaled(out[1], in[1], 1.f, n);
      addScaled(out[4], in[2], 1.f, n);
      addScaled(out[5], in[3], 1.f, n);
      return;
    }
    // Down-mixing.
    if (inCh == 2 && outCh == 1) {  // M = 0.5 (L + R)
      addScaled(out[0], in[0], 0.5f, n);
      addScaled(out[0], in[1], 0.5f, n);
      return;
    }
    if (inCh == 4 && outCh == 1) {  // M = 0.25 (L + R + SL + SR)
      for (int c = 0; c < 4; ++c) addScaled(out[0], in[c], 0.25f, n);
      return;
    }
    if (inCh == 6 && outCh == 1) {  // M = sqrt(0.5)(L + R) + C + 0.5 (SL + SR)
      addScaled(out[0], in[0], kSqrtHalf, n);
      addScaled(out[0], in[1], kSqrtHalf, n);
      addScaled(out[0], in[2], 1.f, n);
      addScaled(out[0], in[4], 0.5f, n);
      addScaled(out[0], in[5], 0.5f, n);
      return;
    }
    if (inCh == 4 && outCh == 2) {  // L = 0.5 (L + SL), R = 0.5 (R + SR)
      addScaled(out[0], in[0], 0.5f, n);
      addScaled(out[0], in[2], 0.5f, n);
      addScaled(out[1], in[1], 0.5f, n);
      addScaled(out[1], in[3], 0.5f, n);
      return;
    }
    if (inCh == 6 && outCh == 2) {  // L = L + sqrt(0.5)(C + SL), R = R + sqrt(0.5)(C + SR)
      addScaled(out[0], in[0], 1.f, n);
      addScaled(out[0], in[2], kSqrtHalf, n);
      addScaled(out[0], in[4], kSqrtHalf, n);
      addScaled(out[1], in[1], 1.f, n);
      addScaled(out[1], in[2], kSqrtHalf, n);
      addScaled(out[1], in[5], kSqrtHalf, n);
      return;
    }
    if (inCh == 6 && outCh == 4) {  // L = L + sqrt(0.5) C, R = R + sqrt(0.5) C, SL, SR
      addScaled(out[0], in[0], 1.f, n);
      addScaled(out[0], in[2], kSqrtHalf, n);
      addScaled(out[1], in[1], 1.f, n);
      addScaled(out[1], in[2], kSqrtHalf, n);
      addScaled(out[2], in[4], 1.f, n);
      addScaled(out[3], in[5], 1.f, n);
      return;
    }
    // Other layouts fall back to discrete.
  }
  // Discrete: fill up with silence or drop extra channels.
  int m = inCh < outCh ? inCh : outCh;
  for (int c = 0; c < m; ++c) addScaled(out[c], in[c], 1.f, n);
}

}  // namespace iwn::audio
