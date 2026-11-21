// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Audio device abstraction. Android: Oboe (AAudio, low-latency, exclusive when available) in
// output_oboe.cpp. Host: a clock-driven thread that consumes audio at real-time pace
// (output_null.cpp), used by host tests of the realtime path.
#pragma once

#include <cstdint>
#include <memory>

namespace iwn::audio {

class RenderCallback {
 public:
  virtual ~RenderCallback() = default;
  // Realtime thread. Fill `frames` interleaved frames of `channels` channels.
  virtual void render(float* interleaved, int channels, int frames) = 0;
  // Non-realtime thread of the output, while no stream is running although output is wanted (a
  // disconnected device being reopened, AUD-12): apply control batches and answer state requests
  // without rendering. Never concurrent with render() for the same callback.
  virtual void serviceWithoutDevice() {}
};

class AudioOutput {
 public:
  virtual ~AudioOutput() = default;
  // Opens the stream (not started). requestedRate 0 = device rate. Returns false on failure.
  virtual bool open(int channels, float requestedRate, int latencyHint, RenderCallback* cb) = 0;
  virtual float sampleRate() const = 0;
  virtual double baseLatency() const = 0;    // seconds (burst / buffer size)
  virtual double outputLatency() const = 0;  // seconds (estimated device pipeline latency)
  virtual bool start() = 0;
  virtual void pause() = 0;
  virtual void close() = 0;
  virtual uint64_t xruns() const = 0;
  // Presentation timestamp: the frame index (in frames given to render()) presented at
  // monotonic time `nanos`. False if unknown.
  virtual bool timestamp(int64_t& frame, int64_t& nanos) const = 0;
};

std::unique_ptr<AudioOutput> createPlatformOutput();
int64_t monotonicNanos();

}  // namespace iwn::audio
