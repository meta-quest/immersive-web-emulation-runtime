// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
#include "decode.h"

#include <pthread.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <thread>

#include "notify.h"
#include "resampler.h"

// dr_mp3 (public domain / MIT-0, implementation in third_party_impl.c) and the Xiph reference
// Vorbis decoder (libvorbisfile over libogg, BSD-3-Clause).
#define DR_MP3_NO_STDIO
#include "dr_mp3.h"

#include <vorbis/vorbisfile.h>

namespace iwn::audio {

namespace {
uint16_t rd16(const uint8_t* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }
uint32_t rd32(const uint8_t* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
         (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

// ITU-T G.711.
float alaw(uint8_t a) {
  a ^= 0x55;
  int t = (a & 0x0f) << 4;
  int seg = (a & 0x70) >> 4;
  if (seg == 0) t += 8;
  else if (seg == 1) t += 0x108;
  else t = (t + 0x108) << (seg - 1);
  return static_cast<float>((a & 0x80) ? t : -t) / 32768.f;
}
float mulaw(uint8_t u) {
  u = static_cast<uint8_t>(~u);
  int t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  return static_cast<float>((u & 0x80) ? (0x84 - t) : (t - 0x84)) / 32768.f;
}

bool hasMpegSync(const uint8_t* d, size_t n) {
  // MPEG audio frame sync (11 bits) with layer III (layer bits 01) and a valid bitrate/rate index.
  if (n < 4) return false;
  if (d[0] != 0xFF || (d[1] & 0xE0) != 0xE0) return false;
  if (((d[1] >> 1) & 3) != 1) return false;
  if ((d[2] >> 4) == 0xF || ((d[2] >> 2) & 3) == 3) return false;
  return true;
}
}  // namespace

std::string sniffFormat(const uint8_t* d, size_t n) {
  if (n >= 12 && !memcmp(d, "RIFF", 4) && !memcmp(d + 8, "WAVE", 4)) return "wav";
  if (n >= 4 && !memcmp(d, "OggS", 4)) {
    // First page carries the codec id packet.
    size_t lim = std::min<size_t>(n, 256);
    for (size_t i = 0; i + 8 <= lim; ++i) {
      if (!memcmp(d + i, "\x01vorbis", 7)) return "ogg-vorbis";
      if (!memcmp(d + i, "OpusHead", 8)) return "ogg-opus";
      if (!memcmp(d + i, "\x7f" "FLAC", 5)) return "ogg-flac";
    }
    return "ogg";
  }
  if (n >= 3 && !memcmp(d, "ID3", 3)) return "mp3";
  if (n >= 4 && !memcmp(d, "fLaC", 4)) return "flac";
  if (n >= 12 && !memcmp(d + 4, "ftyp", 4)) return "mp4";
  if (n >= 2 && d[0] == 0xFF && (d[1] & 0xF6) == 0xF0) return "aac-adts";
  if (hasMpegSync(d, n)) return "mp3";
  return "";
}

bool decodeWav(const uint8_t* d, size_t n, Pcm& out, std::string* err) {
  if (n < 12 || memcmp(d, "RIFF", 4) || memcmp(d + 8, "WAVE", 4)) {
    *err = "not a RIFF/WAVE file";
    return false;
  }
  size_t pos = 12;
  int fmtTag = -1, channels = 0, bits = 0, blockAlign = 0;
  uint32_t rate = 0;
  const uint8_t* data = nullptr;
  size_t dataLen = 0;
  while (pos + 8 <= n) {
    const uint8_t* ck = d + pos;
    uint32_t len = rd32(ck + 4);
    size_t body = pos + 8;
    size_t avail = n - body;
    if (!memcmp(ck, "fmt ", 4)) {
      if (len < 16 || avail < 16) {
        *err = "truncated fmt chunk";
        return false;
      }
      fmtTag = rd16(d + body);
      channels = rd16(d + body + 2);
      rate = rd32(d + body + 4);
      blockAlign = rd16(d + body + 12);
      bits = rd16(d + body + 14);
      if (fmtTag == 0xFFFE && len >= 40 && avail >= 40) fmtTag = rd16(d + body + 24);  // SubFormat GUID
    } else if (!memcmp(ck, "data", 4)) {
      data = d + body;
      dataLen = (len == 0 || len == 0xFFFFFFFFu || len > avail) ? avail : len;
      if (fmtTag >= 0) break;
    }
    size_t step = 8 + static_cast<size_t>(len) + (len & 1);
    if (len > n) break;
    pos += step;
  }
  if (fmtTag < 0) {
    *err = "missing fmt chunk";
    return false;
  }
  if (!data) {
    *err = "missing data chunk";
    return false;
  }
  if (channels < 1 || channels > kMaxChannels) {
    *err = "unsupported channel count " + std::to_string(channels);
    return false;
  }
  // 1 kHz floor: a tiny file claiming a 1 Hz rate would otherwise resample into gigabytes.
  if (rate < 1000 || rate > 768000) {
    *err = "unsupported sample rate " + std::to_string(rate);
    return false;
  }
  int bytes = 0;
  enum { kInt, kFloat, kAlaw, kMulaw } kind;
  switch (fmtTag) {
    case 1:
      kind = kInt;
      if (bits != 8 && bits != 16 && bits != 24 && bits != 32) {
        *err = "unsupported PCM bit depth " + std::to_string(bits);
        return false;
      }
      bytes = bits / 8;
      break;
    case 3:
      kind = kFloat;
      if (bits != 32 && bits != 64) {
        *err = "unsupported float bit depth " + std::to_string(bits);
        return false;
      }
      bytes = bits / 8;
      break;
    case 6: kind = kAlaw; bytes = 1; break;
    case 7: kind = kMulaw; bytes = 1; break;
    default:
      *err = "unsupported WAV format tag " + std::to_string(fmtTag);
      return false;
  }
  size_t frameBytes = static_cast<size_t>(blockAlign) >= static_cast<size_t>(bytes * channels)
                          ? static_cast<size_t>(blockAlign)
                          : static_cast<size_t>(bytes * channels);
  size_t frames = dataLen / frameBytes;
  out.channels = channels;
  out.sampleRate = rate;
  out.data.assign(static_cast<size_t>(channels), std::vector<float>(frames));
  for (size_t f = 0; f < frames; ++f) {
    const uint8_t* fp = data + f * frameBytes;
    for (int c = 0; c < channels; ++c) {
      const uint8_t* s = fp + c * bytes;
      float v = 0;
      if (kind == kInt) {
        switch (bytes) {
          case 1: v = (static_cast<int>(s[0]) - 128) / 128.f; break;
          case 2: v = static_cast<int16_t>(rd16(s)) / 32768.f; break;
          case 3: {
            int32_t x = static_cast<int32_t>((s[0] << 8) | (s[1] << 16) | (static_cast<uint32_t>(s[2]) << 24)) >> 8;
            v = static_cast<float>(x / 8388608.0);
            break;
          }
          case 4: v = static_cast<float>(static_cast<int32_t>(rd32(s)) / 2147483648.0); break;
        }
      } else if (kind == kFloat) {
        if (bytes == 4) {
          uint32_t u = rd32(s);
          memcpy(&v, &u, 4);
        } else {
          uint64_t u = static_cast<uint64_t>(rd32(s)) | (static_cast<uint64_t>(rd32(s + 4)) << 32);
          double dv;
          memcpy(&dv, &u, 8);
          v = static_cast<float>(dv);
        }
      } else if (kind == kAlaw) {
        v = alaw(s[0]);
      } else {
        v = mulaw(s[0]);
      }
      out.data[static_cast<size_t>(c)][f] = v;
    }
  }
  return true;
}

bool decodeMp3(const uint8_t* d, size_t n, Pcm& out, std::string* err) {
  drmp3 mp3;
  if (!drmp3_init_memory(&mp3, d, n, nullptr)) {
    *err = "no MPEG audio frames found";
    return false;
  }
  int ch = static_cast<int>(mp3.channels);
  double rate = mp3.sampleRate;
  if (ch < 1 || ch > 2 || rate <= 0) {
    drmp3_uninit(&mp3);
    *err = "MPEG stream decoded to no audio";
    return false;
  }
  // Straight to planar (no interleaved copy of the whole file). A Xing/Info header gives the
  // exact length: reserve it (bounded by what the file size can hold at 8 kbps) so the channel
  // vectors do not grow by doubling.
  out.channels = ch;
  out.sampleRate = rate;
  out.data.assign(static_cast<size_t>(ch), {});
  if (mp3.totalPCMFrameCount != DRMP3_UINT64_MAX && mp3.totalPCMFrameCount > mp3.delayInPCMFrames + mp3.paddingInPCMFrames) {
    drmp3_uint64 total = mp3.totalPCMFrameCount - mp3.delayInPCMFrames - mp3.paddingInPCMFrames;
    double bound = static_cast<double>(n) * 8.0 / 8000.0 * rate + 4096;
    if (static_cast<double>(total) <= bound && total < (static_cast<drmp3_uint64>(1) << 28))
      for (auto& c : out.data) c.reserve(static_cast<size_t>(total));
  }
  std::vector<float> chunk(4096 * static_cast<size_t>(ch));
  for (;;) {
    drmp3_uint64 got = drmp3_read_pcm_frames_f32(&mp3, 4096, chunk.data());
    if (got == 0) break;
    for (int c = 0; c < ch; ++c) {
      std::vector<float>& dst = out.data[static_cast<size_t>(c)];
      size_t at = dst.size();
      dst.resize(at + static_cast<size_t>(got));
      for (drmp3_uint64 f = 0; f < got; ++f) dst[at + f] = chunk[f * static_cast<size_t>(ch) + static_cast<size_t>(c)];
    }
  }
  drmp3_uninit(&mp3);
  if (out.data[0].empty()) {
    *err = "MPEG stream decoded to no audio";
    return false;
  }
  return true;
}

namespace {
struct MemFile {
  const uint8_t* data;
  size_t size;
  size_t pos;
};
size_t memRead(void* ptr, size_t size, size_t nmemb, void* src) {
  auto* m = static_cast<MemFile*>(src);
  size_t want = size * nmemb;
  size_t n = std::min(want, m->size - m->pos);
  memcpy(ptr, m->data + m->pos, n);
  m->pos += n;
  return size ? n / size : 0;
}
int memSeek(void* src, ogg_int64_t off, int whence) {
  auto* m = static_cast<MemFile*>(src);
  long long base = whence == SEEK_SET ? 0 : whence == SEEK_CUR ? static_cast<long long>(m->pos) : static_cast<long long>(m->size);
  long long p = base + off;
  if (p < 0 || p > static_cast<long long>(m->size)) return -1;
  m->pos = static_cast<size_t>(p);
  return 0;
}
long memTell(void* src) { return static_cast<long>(static_cast<MemFile*>(src)->pos); }
}  // namespace

bool decodeVorbis(const uint8_t* d, size_t n, Pcm& out, std::string* err) {
  MemFile mf{d, n, 0};
  ov_callbacks cb{memRead, memSeek, nullptr, memTell};
  OggVorbis_File vf;
  int r = ov_open_callbacks(&mf, &vf, nullptr, 0, cb);
  if (r != 0) {
    *err = "invalid Ogg Vorbis stream (libvorbisfile error " + std::to_string(r) + ")";
    return false;
  }
  vorbis_info* info = ov_info(&vf, -1);
  int ch = info ? info->channels : 0;
  if (ch < 1 || ch > kMaxChannels || !info || info->rate < 1 || info->rate > 768000) {
    ov_clear(&vf);
    *err = "unsupported Vorbis channel count or rate";
    return false;
  }
  out.channels = ch;
  out.sampleRate = static_cast<double>(info->rate);
  out.data.assign(static_cast<size_t>(ch), {});
  ogg_int64_t total = ov_pcm_total(&vf, -1);
  // The total comes from the last page's granule position: trust it only up to a sane bound.
  if (total > 0 && total < (static_cast<ogg_int64_t>(1) << 28))
    for (auto& c : out.data) c.reserve(static_cast<size_t>(total));
  int section = 0;
  int holes = 0;
  for (;;) {
    float** pcm = nullptr;
    long got = ov_read_float(&vf, &pcm, 4096, &section);
    if (got == OV_HOLE && ++holes < 4096) continue;  // a gap in the stream: keep decoding
    if (got <= 0) break;
    vorbis_info* cur = ov_info(&vf, section);
    if (!cur || cur->channels != ch) break;  // chained stream with another layout: stop there
    for (int c = 0; c < ch; ++c)
      out.data[static_cast<size_t>(c)].insert(out.data[static_cast<size_t>(c)].end(), pcm[c], pcm[c] + got);
  }
  ov_clear(&vf);
  if (out.data[0].empty()) {
    *err = "Ogg Vorbis stream decoded to no audio";
    return false;
  }
  return true;
}

#ifndef __ANDROID__
bool decodePlatform(const uint8_t*, size_t, Pcm&, std::string* err, std::string*) {
  *err = "no platform decoder on this host";
  return false;
}
#endif

DecodeOutcome decodeAudio(const uint8_t* data, size_t size, float targetRate) {
  DecodeOutcome r;
  if (!data || size == 0) {
    r.error = "empty buffer";
    return r;
  }
  std::string fmt = sniffFormat(data, size);
  Pcm pcm;
  std::string err;
  bool ok = false;
  if (fmt == "wav") {
    ok = decodeWav(data, size, pcm, &err);
    r.format = "wav";
  } else if (fmt == "ogg-vorbis") {
    ok = decodeVorbis(data, size, pcm, &err);
    r.format = "vorbis";
  } else if (fmt == "mp3") {
    ok = decodeMp3(data, size, pcm, &err);
    r.format = "mp3";
  }
  if (!ok && fmt != "wav" && fmt != "ogg-vorbis" && fmt != "mp3") {
    // AAC/M4A, FLAC, Opus, unknown: platform decoders (Android), then a last MP3 attempt for
    // files with junk before the first frame.
    std::string mime, perr;
    ok = decodePlatform(data, size, pcm, &perr, &mime);
    if (ok) {
      r.format = "mediacodec:" + mime;
    } else if (fmt.empty()) {
      std::string merr;
      ok = decodeMp3(data, size, pcm, &merr);
      if (ok) r.format = "mp3";
    }
    if (!ok) {
      if (fmt.empty()) {
        char hex[64] = {0};
        size_t m = std::min<size_t>(size, 8);
        for (size_t i = 0; i < m; ++i) snprintf(hex + i * 3, 4, "%02x ", data[i]);
        err = std::string("unrecognized audio format (first bytes: ") + hex + ")";
      } else {
        err = fmt + " is not supported here (" + perr + ")";
      }
    }
  }
  if (!ok) {
    r.error = err;
    return r;
  }
  size_t frames = pcm.data.empty() ? 0 : pcm.data[0].size();
  if (frames == 0) {
    r.error = "decoded to no audio";
    return r;
  }
  double outRate = targetRate > 0 ? targetRate : pcm.sampleRate;
  if (!(pcm.sampleRate >= 1000) || outRate / pcm.sampleRate > 64) {
    r.error = "unsupported sample rate " + std::to_string(pcm.sampleRate);
    return r;
  }
  size_t outLen = outRate == pcm.sampleRate ? frames : resampledLength(frames, pcm.sampleRate, outRate);
  // Same ceiling as OfflineAudioContext: 1 GiB of samples.
  if (static_cast<double>(outLen) * pcm.channels * sizeof(float) > static_cast<double>(1u << 30)) {
    r.error = "decoded audio is too large";
    return r;
  }
  BufferData* b = BufferData::create(pcm.channels, outLen, static_cast<float>(outRate));
  if (!b) {
    r.error = "out of memory";
    return r;
  }
  for (int c = 0; c < pcm.channels; ++c) {
    const std::vector<float>& src = pcm.data[static_cast<size_t>(c)];
    if (outRate == pcm.sampleRate) {
      memcpy(b->channel(c), src.data(), frames * sizeof(float));
    } else {
      resampleInto(src.data(), frames, pcm.sampleRate, outRate, b->channel(c), outLen);  // no temporary
    }
    std::vector<float>().swap(pcm.data[static_cast<size_t>(c)]);  // free each source channel as it is done
  }
  r.buffer = b;
  return r;
}

// ---- background decoding ----------------------------------------------------------------------

namespace {
struct DecodePool {
  std::atomic<uint32_t> generation{1};
  std::mutex mu;
  std::condition_variable cv;
  std::deque<DecodeJob> jobs;
  std::vector<DecodeDone> done;
  std::vector<std::thread> threads;
  std::atomic<uint32_t> pending{0};
  bool quit = false;

  void ensureStarted() {
    if (!threads.empty() || quit) return;
    // Two workers: decodes are bursty at load time; more would compete with the main thread.
    for (int i = 0; i < 2; ++i) {
      threads.emplace_back([this, i] {
        char name[16];
        snprintf(name, sizeof name, "iwn-audio-dec%d", i);
        pthread_setname_np(pthread_self(), name);
        for (;;) {
          DecodeJob job;
          {
            std::unique_lock<std::mutex> l(mu);
            cv.wait(l, [&] { return quit || !jobs.empty(); });
            if (quit && jobs.empty()) return;
            job = std::move(jobs.front());
            jobs.pop_front();
          }
          DecodeOutcome o;
          if (job.generation == generation.load()) o = decodeAudio(job.data, job.size, job.targetRate);
          job.keepAlive.reset();
          {
            std::lock_guard<std::mutex> l(mu);
            done.push_back({job.ctx, job.requestId, std::move(o), job.generation});
          }
          Notifier::get().signal();
        }
      });
    }
  }
};
DecodePool& pool() {
  static DecodePool* p = new DecodePool();
  return *p;
}
}  // namespace

void submitDecode(DecodeJob job) {
  DecodePool& p = pool();
  std::lock_guard<std::mutex> l(p.mu);
  p.ensureStarted();
  job.generation = p.generation.load();
  p.pending.fetch_add(1);
  p.jobs.push_back(std::move(job));
  p.cv.notify_one();
}

void collectDecodes(std::vector<DecodeDone>& out) {
  DecodePool& p = pool();
  std::lock_guard<std::mutex> l(p.mu);
  uint32_t gen = p.generation.load();
  for (auto& d : p.done) {
    if (d.generation != gen) {
      // Requested by a previous page (PROC-8): its request ids mean nothing to the new page.
      if (d.outcome.buffer) d.outcome.buffer->release();
      continue;
    }
    out.push_back(std::move(d));
  }
  p.pending.fetch_sub(static_cast<uint32_t>(p.done.size()));
  p.done.clear();
}

uint32_t pendingDecodes() { return pool().pending.load(); }

void beginDecodeGeneration() { pool().generation.fetch_add(1); }

void shutdownDecoders() {
  DecodePool& p = pool();
  {
    std::lock_guard<std::mutex> l(p.mu);
    p.quit = true;
    p.jobs.clear();
    p.cv.notify_all();
  }
  for (auto& t : p.threads) t.join();
  p.threads.clear();
  std::lock_guard<std::mutex> l(p.mu);
  for (auto& d : p.done)
    if (d.outcome.buffer) d.outcome.buffer->release();
  p.done.clear();
  p.pending.store(0);
  p.generation.fetch_add(1);
}

void restartDecoders() {
  DecodePool& p = pool();
  std::lock_guard<std::mutex> l(p.mu);
  p.quit = false;  // workers start again with the next submitDecode()
}

}  // namespace iwn::audio
