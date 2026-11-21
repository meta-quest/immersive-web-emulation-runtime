// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Web Audio core: constants, refcounted sample storage, render-quantum buses and the
// Web Audio API channel up/down-mixing rules ("Channel Up-Mixing and Down-Mixing").
// Plain C++ (no V8, no Android) so it runs in host tests.
#pragma once

#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace iwn::audio {

constexpr int kQuantum = 128;          // Web Audio render quantum size (frames).
constexpr int kMaxChannels = 32;       // Minimum the spec requires implementations to support.
constexpr float kMinSampleRate = 3000.f;
constexpr float kMaxSampleRate = 768000.f;

enum class ChannelCountMode : uint8_t { Max = 0, ClampedMax = 1, Explicit = 2 };
enum class ChannelInterpretation : uint8_t { Speakers = 0, Discrete = 1 };

// Sample storage shared between JS (Float32Array views over it), the audio thread and decoders.
// Refcounted; `release_rt` is used on the audio thread, where freeing is not allowed: the last
// reference dropped there is handed to a garbage list that a non-realtime thread empties.
class BufferData {
 public:
  static BufferData* create(int channels, size_t length, float sampleRate);
  int channels() const { return channels_; }
  size_t length() const { return length_; }
  float sampleRate() const { return sampleRate_; }
  float* channel(int c) { return data_ + static_cast<size_t>(c) * stride_; }
  const float* channel(int c) const { return data_ + static_cast<size_t>(c) * stride_; }
  size_t channelBytes() const { return length_ * sizeof(float); }

  void ref() { refs_.fetch_add(1, std::memory_order_relaxed); }
  void release();  // May free; never call on the audio thread.
  // Returns true when the caller held the last reference and must hand the object to a
  // non-realtime thread for `destroy()`.
  bool release_rt() { return refs_.fetch_sub(1, std::memory_order_acq_rel) == 1; }
  void destroy();
  int refCountForTest() const { return refs_.load(); }
  // Largest allocation create() accepts (the same 1 GiB of samples decode and OfflineAudioContext allow).
  static constexpr size_t kMaxBytes = size_t{1} << 30;

 private:
  BufferData() = default;
  ~BufferData();
  std::atomic<int> refs_{1};
  int channels_ = 0;
  size_t length_ = 0;
  size_t stride_ = 0;
  float sampleRate_ = 0;
  float* data_ = nullptr;  // 64-byte aligned, inside base_
  void* base_ = nullptr;   // calloc'd block (pages stay uncommitted until written)
};

// A bus of up to kMaxChannels channels of one render quantum each. Storage is allocated once
// for the bus's capacity (never on the audio thread after construction).
class AudioBus {
 public:
  explicit AudioBus(int capacity = 2);
  AudioBus(const AudioBus&) = delete;
  AudioBus& operator=(const AudioBus&) = delete;

  int channels() const { return channels_; }
  int capacity() const { return capacity_; }
  // Sets the active channel count (clamped to capacity). Does not clear.
  void setChannels(int n) { channels_ = n < 1 ? 1 : (n > capacity_ ? capacity_ : n); }
  float* channel(int c) { return &data_[static_cast<size_t>(c) * kQuantum]; }
  const float* channel(int c) const { return &data_[static_cast<size_t>(c) * kQuantum]; }
  void zero();
  bool silent() const { return silent_; }
  // Writers call zero() first, write, then setSilent(false). Never set true on a bus holding data.
  void setSilent(bool s) { silent_ = s; }
  // Mixes `src` into this bus (sum), converting channel layout per `interp`.
  void sumFrom(const AudioBus& src, ChannelInterpretation interp);
  // Copies `src` into this bus, converting channel layout per `interp`.
  void copyFrom(const AudioBus& src, ChannelInterpretation interp);

 private:
  int capacity_;
  int channels_;
  bool silent_ = true;
  std::vector<float> data_;
};

// Up/down-mix one quantum from `in` (inCh channels) and add into `out` (outCh channels).
// Implements the spec's speaker layouts (1, 2, 4, 6) and discrete fallback.
void mixChannels(const float* const* in, int inCh, float* const* out, int outCh,
                 ChannelInterpretation interp, int frames = kQuantum);

inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline bool isPow2(uint32_t v) { return v && !(v & (v - 1)); }

}  // namespace iwn::audio
