// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// decodeAudioData backends (AUD-8): WAV (own RIFF parser: integer PCM 8/16/24/32, IEEE float
// 32/64, A-law, mu-law, WAVE_FORMAT_EXTENSIBLE), MP3 (dr_mp3: MPEG-1/2/2.5 Layer III, ID3 skip,
// LAME/Xing encoder delay + padding trimmed), Ogg Vorbis (libvorbisfile), and on Android every other
// format the platform decoders support (AAC/M4A, FLAC, Ogg Opus, ...) through NDK
// AMediaExtractor/AMediaCodec. The result is resampled to the context rate.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "core.h"

namespace iwn::audio {

struct Pcm {
  int channels = 0;
  double sampleRate = 0;
  std::vector<std::vector<float>> data;  // planar
};

struct DecodeOutcome {
  BufferData* buffer = nullptr;  // one reference, or null on failure
  std::string format;            // "wav", "mp3", "vorbis", "mediacodec:<mime>"
  std::string error;             // reason when buffer is null
};

// Decodes `data` and resamples to targetRate (0 keeps the file's rate). Thread-safe.
DecodeOutcome decodeAudio(const uint8_t* data, size_t size, float targetRate);

// Individual backends (return false and set *err on failure).
bool decodeWav(const uint8_t* d, size_t n, Pcm& out, std::string* err);
bool decodeMp3(const uint8_t* d, size_t n, Pcm& out, std::string* err);
bool decodeVorbis(const uint8_t* d, size_t n, Pcm& out, std::string* err);
bool decodePlatform(const uint8_t* d, size_t n, Pcm& out, std::string* err, std::string* mime);
std::string sniffFormat(const uint8_t* d, size_t n);  // "wav" | "mp3" | "ogg-vorbis" | ... | ""

// Background decoding (PROC-2): jobs run on worker threads; completions are collected on the main
// thread.
struct DecodeJob {
  uint32_t ctx = 0;
  double requestId = 0;
  float targetRate = 0;
  std::shared_ptr<void> keepAlive;  // owns the bytes
  const uint8_t* data = nullptr;
  size_t size = 0;
  uint32_t generation = 0;  // set by submitDecode
};
struct DecodeDone {
  uint32_t ctx;
  double requestId;
  DecodeOutcome outcome;
  uint32_t generation;
};

void submitDecode(DecodeJob job);
void collectDecodes(std::vector<DecodeDone>& out);
uint32_t pendingDecodes();
// A new page (PROC-8): decodes requested before this call are dropped (queued ones are skipped,
// finished ones released) instead of being delivered to the new page's request ids.
void beginDecodeGeneration();
void shutdownDecoders();
// Undoes shutdownDecoders() (a new runtime in the same process).
void restartDecoders();

}  // namespace iwn::audio
