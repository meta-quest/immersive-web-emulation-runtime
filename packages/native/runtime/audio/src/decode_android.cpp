// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Platform decoding through the NDK media APIs (AMediaExtractor + AMediaCodec, API 28+ for the
// in-memory data source). Covers AAC/M4A (AUD-8 SHOULD), FLAC and Ogg Opus, or whatever the
// device's codecs support.
#ifdef __ANDROID__

#include <android/log.h>
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaDataSource.h>
#include <media/NdkMediaExtractor.h>
#include <media/NdkMediaFormat.h>

#include <linux/memfd.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <cstring>
#include <string>

#include "decode.h"

namespace iwn::audio {

namespace {
struct Mem {
  const uint8_t* data;
  size_t size;
};
ssize_t memRead(void* user, off64_t offset, void* buffer, size_t size) {
  auto* m = static_cast<Mem*>(user);
  if (offset < 0 || static_cast<size_t>(offset) >= m->size) return -1;  // EOS
  size_t n = std::min(size, m->size - static_cast<size_t>(offset));
  memcpy(buffer, m->data + offset, n);
  return static_cast<ssize_t>(n);
}
ssize_t memSize(void* user) { return static_cast<ssize_t>(static_cast<Mem*>(user)->size); }
void memClose(void*) {}
}  // namespace

bool decodePlatform(const uint8_t* d, size_t n, Pcm& out, std::string* err, std::string* mimeOut) {
  if (__builtin_available(android 28, *)) {
    Mem mem{d, n};
    AMediaDataSource* src = AMediaDataSource_new();
    if (!src) {
      *err = "AMediaDataSource_new failed";
      return false;
    }
    AMediaDataSource_setUserdata(src, &mem);
    AMediaDataSource_setReadAt(src, memRead);
    AMediaDataSource_setGetSize(src, memSize);
    AMediaDataSource_setClose(src, memClose);
    AMediaExtractor* ex = AMediaExtractor_new();
    bool ok = false;
    AMediaCodec* codec = nullptr;
    do {
      // Prefer an in-memory file (memfd): the extractor runs out of process and, with a custom
      // callback source, stopped reading after the first ~20 KB on Horizon OS (measured 2026-10-20).
      int fd = -1;
      // The raw syscall: the libc wrapper is declared only from API 30, and the template builds
      // for API 29. Kernels without memfd (or a policy denying it) fall back to the custom source.
      fd = static_cast<int>(syscall(__NR_memfd_create, "iwn-audio-decode", MFD_CLOEXEC));
      media_status_t st = AMEDIA_ERROR_UNKNOWN;
      if (fd >= 0) {
        size_t done = 0;
        while (done < n) {
          ssize_t w = write(fd, d + done, n - done);
          if (w <= 0) break;
          done += static_cast<size_t>(w);
        }
        if (done == n) st = AMediaExtractor_setDataSourceFd(ex, fd, 0, static_cast<off64_t>(n));
        close(fd);
      }
      if (st != AMEDIA_OK) st = AMediaExtractor_setDataSourceCustom(ex, src);
      if (st != AMEDIA_OK) {
        *err = "the platform extractor does not recognise the data";
        break;
      }
      size_t tracks = AMediaExtractor_getTrackCount(ex);
      __android_log_print(ANDROID_LOG_VERBOSE, "iwn.audio", "platform decode: %zu bytes, %zu tracks", n, tracks);
      int track = -1;
      std::string mime;
      AMediaFormat* fmt = nullptr;
      for (size_t i = 0; i < tracks; ++i) {
        AMediaFormat* f = AMediaExtractor_getTrackFormat(ex, i);
        const char* m = nullptr;
        bool got = AMediaFormat_getString(f, AMEDIAFORMAT_KEY_MIME, &m);
        __android_log_print(ANDROID_LOG_VERBOSE, "iwn.audio", "  track %zu: %s (%s)", i, got && m ? m : "?", AMediaFormat_toString(f));
        if (got && m && !strncmp(m, "audio/", 6)) {
          track = static_cast<int>(i);
          mime = m;
          fmt = f;
          break;
        }
        AMediaFormat_delete(f);
      }
      if (track < 0) {
        *err = "no audio track";
        break;
      }
      *mimeOut = mime;
      // Gapless metadata (MP4 edit list / iTunSMPB as exposed by the extractor): trimmed below.
      int32_t encDelay = 0, encPadding = 0;
      AMediaFormat_getInt32(fmt, "encoder-delay", &encDelay);
      AMediaFormat_getInt32(fmt, "encoder-padding", &encPadding);
      if (mime == "audio/mp4a-latm") {
        // decodeAudioData returns the signal as encoded: no loudness normalisation or DRC.
        AMediaFormat_setInt32(fmt, "aac-target-ref-level", -1);
        AMediaFormat_setInt32(fmt, "aac-drc-effect-type", -1);
        AMediaFormat_setInt32(fmt, "aac-drc-boost-level", 0);
        AMediaFormat_setInt32(fmt, "aac-drc-cut-level", 0);
      }
      AMediaExtractor_selectTrack(ex, static_cast<size_t>(track));
      codec = AMediaCodec_createDecoderByType(mime.c_str());
      if (!codec || AMediaCodec_configure(codec, fmt, nullptr, nullptr, 0) != AMEDIA_OK ||
          AMediaCodec_start(codec) != AMEDIA_OK) {
        AMediaFormat_delete(fmt);
        *err = "no decoder for " + mime;
        break;
      }
      AMediaFormat_delete(fmt);
      int32_t channels = 0, rate = 0, encoding = 2;  // 2 = PCM 16-bit, 4 = float
      std::vector<std::vector<float>> planes;
      bool inputDone = false, outputDone = false;
      int idleSpins = 0;
      int inSamples = 0;
      while (!outputDone && idleSpins < 2000) {
        if (!inputDone) {
          ssize_t ib = AMediaCodec_dequeueInputBuffer(codec, 5000);
          if (ib >= 0) {
            size_t cap = 0;
            uint8_t* buf = AMediaCodec_getInputBuffer(codec, static_cast<size_t>(ib), &cap);
            ssize_t sz = AMediaExtractor_readSampleData(ex, buf, cap);
            ++inSamples;
            if (sz < 0) {
              __android_log_print(ANDROID_LOG_VERBOSE, "iwn.audio", "  input EOS after %d samples (cap %zu, next size %lld)", inSamples,
                                  cap, static_cast<long long>(AMediaExtractor_getSampleSize(ex)));
              AMediaCodec_queueInputBuffer(codec, static_cast<size_t>(ib), 0, 0, 0,
                                           AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM);
              inputDone = true;
            } else {
              int64_t pts = AMediaExtractor_getSampleTime(ex);
              AMediaCodec_queueInputBuffer(codec, static_cast<size_t>(ib), 0, static_cast<size_t>(sz),
                                           static_cast<uint64_t>(pts < 0 ? 0 : pts), 0);
              AMediaExtractor_advance(ex);
            }
          }
        }
        AMediaCodecBufferInfo info;
        ssize_t ob = AMediaCodec_dequeueOutputBuffer(codec, &info, 5000);
        if (ob >= 0) {
          idleSpins = 0;
          if (channels == 0) {
            AMediaFormat* of = AMediaCodec_getOutputFormat(codec);
            AMediaFormat_getInt32(of, AMEDIAFORMAT_KEY_CHANNEL_COUNT, &channels);
            AMediaFormat_getInt32(of, AMEDIAFORMAT_KEY_SAMPLE_RATE, &rate);
            AMediaFormat_getInt32(of, "pcm-encoding", &encoding);
            AMediaFormat_delete(of);
            if (channels < 1 || channels > kMaxChannels) channels = 0;
            else planes.assign(static_cast<size_t>(channels), {});
          }
          size_t cap = 0;
          uint8_t* buf = AMediaCodec_getOutputBuffer(codec, static_cast<size_t>(ob), &cap);
          if (buf && channels > 0 && info.size > 0) {
            const uint8_t* p = buf + info.offset;
            if (encoding == 4) {
              size_t frames = static_cast<size_t>(info.size) / (4 * static_cast<size_t>(channels));
              const float* s = reinterpret_cast<const float*>(p);
              for (size_t f = 0; f < frames; ++f)
                for (int c = 0; c < channels; ++c) planes[static_cast<size_t>(c)].push_back(s[f * static_cast<size_t>(channels) + static_cast<size_t>(c)]);
            } else {
              size_t frames = static_cast<size_t>(info.size) / (2 * static_cast<size_t>(channels));
              const int16_t* s = reinterpret_cast<const int16_t*>(p);
              for (size_t f = 0; f < frames; ++f)
                for (int c = 0; c < channels; ++c)
                  planes[static_cast<size_t>(c)].push_back(s[f * static_cast<size_t>(channels) + static_cast<size_t>(c)] / 32768.f);
            }
          }
          AMediaCodec_releaseOutputBuffer(codec, static_cast<size_t>(ob), false);
          if (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) outputDone = true;
        } else if (ob == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
          AMediaFormat* of = AMediaCodec_getOutputFormat(codec);
          AMediaFormat_getInt32(of, AMEDIAFORMAT_KEY_CHANNEL_COUNT, &channels);
          AMediaFormat_getInt32(of, AMEDIAFORMAT_KEY_SAMPLE_RATE, &rate);
          AMediaFormat_getInt32(of, "pcm-encoding", &encoding);
          AMediaFormat_delete(of);
          if (channels >= 1 && channels <= kMaxChannels && planes.size() != static_cast<size_t>(channels))
            planes.assign(static_cast<size_t>(channels), {});
        } else {
          ++idleSpins;
        }
      }
      __android_log_print(ANDROID_LOG_VERBOSE, "iwn.audio", "  output: %d ch, %d Hz, enc %d, %zu frames, eos %d, idle %d", channels, rate,
                          encoding, planes.empty() ? 0 : planes[0].size(), outputDone ? 1 : 0, idleSpins);
      if (channels < 1 || rate <= 0 || planes.empty() || planes[0].empty()) {
        *err = "platform decoder produced no audio";
        break;
      }
      size_t total = planes[0].size();
      size_t front = encDelay > 0 ? static_cast<size_t>(encDelay) : 0;
      size_t back = encPadding > 0 ? static_cast<size_t>(encPadding) : 0;
      if (front + back < total) {
        for (auto& p : planes) {
          p.erase(p.begin() + static_cast<std::ptrdiff_t>(total - back), p.end());
          p.erase(p.begin(), p.begin() + static_cast<std::ptrdiff_t>(front));
        }
      }
      out.channels = channels;
      out.sampleRate = rate;
      out.data = std::move(planes);
      ok = true;
    } while (false);
    if (codec) {
      AMediaCodec_stop(codec);
      AMediaCodec_delete(codec);
    }
    AMediaExtractor_delete(ex);
    AMediaDataSource_delete(src);
    return ok;
  }
  *err = "platform decoding needs Android 9 (API 28)";
  return false;
}

}  // namespace iwn::audio

#endif  // __ANDROID__
