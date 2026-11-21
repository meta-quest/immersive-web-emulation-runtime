/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/image/decode.h"

#include <algorithm>
#include <chrono>
#include <mutex>

namespace iwn::image {

namespace {

std::mutex g_backends_mu;
std::vector<DecoderBackend*>* g_test_backends = nullptr;

bool IsCoreFormat(Format f) {
  return f == Format::kPng || f == Format::kJpeg || f == Format::kGif || f == Format::kWebp || f == Format::kBmp;
}

}  // namespace

std::vector<DecoderBackend*> DefaultBackends() {
  {
    std::lock_guard<std::mutex> lock(g_backends_mu);
    if (g_test_backends) return *g_test_backends;
  }
  std::vector<DecoderBackend*> list;
  for (DecoderBackend* b : {AndroidBackend(), WebpBackend(), StbBackend()}) {
    if (b) list.push_back(b);
  }
  return list;
}

void SetBackendsForTesting(std::vector<DecoderBackend*> backends) {
  std::lock_guard<std::mutex> lock(g_backends_mu);
  delete g_test_backends;
  g_test_backends = backends.empty() ? nullptr : new std::vector<DecoderBackend*>(std::move(backends));
}

DecodeBudget& DecodeBudget::Shared() {
  // Leaked on purpose: pool threads may still use it while static destructors run at exit.
  static DecodeBudget* budget = [] {
    auto* b = new DecodeBudget();
    b->SetLimit(uint64_t{512} << 20);
    return b;
  }();
  return *budget;
}

void DecodeBudget::SetLimit(uint64_t bytes) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    limit_ = bytes;
  }
  cv_.notify_all();
}

uint64_t DecodeBudget::limit() const {
  std::lock_guard<std::mutex> lock(mu_);
  return limit_;
}

uint64_t DecodeBudget::in_flight() const {
  std::lock_guard<std::mutex> lock(mu_);
  return in_flight_;
}

bool DecodeBudget::Acquire(uint64_t bytes, const std::atomic<bool>* cancel) {
  std::unique_lock<std::mutex> lock(mu_);
  for (;;) {
    if (cancel && cancel->load()) return false;
    if (limit_ == 0 || in_flight_ == 0 || in_flight_ + bytes <= limit_) break;
    cv_.wait_for(lock, std::chrono::milliseconds(5));
  }
  in_flight_ += bytes;
  return true;
}

void DecodeBudget::Release(uint64_t bytes) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    in_flight_ -= std::min(in_flight_, bytes);
  }
  cv_.notify_all();
}

namespace {

struct BudgetHold {
  uint64_t bytes = 0;
  ~BudgetHold() {
    if (bytes) DecodeBudget::Shared().Release(bytes);
  }
};

bool Cancelled(const DecodeOptions& o) { return o.cancel && o.cancel->load(); }

}  // namespace

DecodeResult Decode(const uint8_t* data, size_t size, const DecodeOptions& options) {
  DecodeResult result;
  if (!data || size == 0) {
    result.status = Status::kCorrupt;
    result.message = "empty input";
    return result;
  }
  if (Cancelled(options)) {
    result.status = Status::kCancelled;
    return result;
  }
  result.format = SniffFormat(data, size);
  if (!options.allow_os_formats && !IsCoreFormat(result.format)) {
    result.status = Status::kUnsupported;
    result.message = "unsupported image format";
    return result;
  }
  result.exif_orientation = ReadExifOrientation(data, size, result.format);
  const int desired = options.apply_exif_orientation ? result.exif_orientation : 1;

  // Header checks before any decoder allocates (IMG-3; absurd headers in tiny files).
  const HeaderInfo header = ReadHeaderInfo(data, size, result.format);
  if (header.known) {
    if (header.width > options.limits.max_dimension || header.height > options.limits.max_dimension ||
        uint64_t{header.width} * header.height > options.limits.max_pixels) {
      result.status = Status::kTooLarge;
      result.message = "image dimensions above the limits";
      return result;
    }
    if (size < header.min_file_size) {
      result.status = Status::kCorrupt;
      result.message = "image data truncated (file too small for its dimensions)";
      return result;
    }
  }

  // Let the backend write into the final allocator when nothing is left to do afterwards.
  const ProcessOptions& p = options.process;
  const bool no_geometry = result.exif_orientation == 1 && !p.has_crop && p.resize_width == 0 &&
                           p.resize_height == 0 && !p.flip_y;
  BackendRequest req;
  req.data = data;
  req.size = size;
  req.format = result.format;
  req.exif_orientation = result.exif_orientation;
  req.want_premultiplied = p.alpha == AlphaRequest::kPremultiplied;
  req.limits = options.limits;
  req.allocator = no_geometry ? p.allocator : HeapAllocator;
  // Downscaled decode: only for a plain resize (a source rectangle is in full-size coordinates; 'pixelated' must
  // pick source pixels). The target is in the final orientation; the hint is in stored orientation.
  if (!p.has_crop && p.resize_width && p.resize_height && p.quality != ResizeQuality::kPixelated) {
    const bool swap = OrientationSwapsAxes(desired);
    req.min_width = swap ? p.resize_height : p.resize_width;
    req.min_height = swap ? p.resize_width : p.resize_height;
  }

  // Budget: decode size + output size. The decode size is the full image unless the backend that will run honours
  // the downscale hint for this format (then the worst case it may still pick: 2x the target per side, or full). A
  // fallthrough to another backend (kUnsupported) re-reserves for that backend before it runs.
  BudgetHold hold;
  const bool budget = options.use_budget && header.known;
  uint64_t full_decode_bytes = 0, scaled_decode_bytes = 0, out_bytes = 0;
  if (budget) {
    full_decode_bytes = uint64_t{header.width} * header.height * 4;
    scaled_decode_bytes = full_decode_bytes;
    if (req.min_width && req.min_height) {
      scaled_decode_bytes = std::min(full_decode_bytes, uint64_t{req.min_width} * req.min_height * 4 * 64);
    }
    if (!no_geometry || p.alpha != AlphaRequest::kKeep) {
      if (p.resize_width && p.resize_height) out_bytes = uint64_t{p.resize_width} * p.resize_height * 4;
      else if (p.has_crop) out_bytes = static_cast<uint64_t>(p.crop.width) * static_cast<uint64_t>(p.crop.height) * 4;
      else out_bytes = uint64_t{header.width} * header.height * 4;
    }
  }
  // Returns false when cancelled while waiting. Never waits while holding a reservation (no hold-and-wait deadlock
  // between jobs): a larger reservation releases the current one first.
  auto reserve_for = [&](const DecoderBackend* backend) {
    if (!budget) return true;
    const bool scaled = req.min_width && req.min_height && backend->DownscalesFormat(result.format);
    const uint64_t want = (scaled ? scaled_decode_bytes : full_decode_bytes) + out_bytes;
    if (want <= hold.bytes) return true;
    if (hold.bytes) {
      DecodeBudget::Shared().Release(hold.bytes);
      hold.bytes = 0;
    }
    if (!DecodeBudget::Shared().Acquire(want, options.cancel)) return false;
    hold.bytes = want;
    return true;
  };
  if (Cancelled(options)) {
    result.status = Status::kCancelled;
    return result;
  }

  BackendResult decoded;
  decoded.status = Status::kUnsupported;
  decoded.message = "no decoder for this format";
  for (DecoderBackend* backend : DefaultBackends()) {
    if (!backend->Handles(result.format)) continue;
    if (!reserve_for(backend)) {
      result.status = Status::kCancelled;
      return result;
    }
    decoded = backend->Decode(req);
    result.backend = backend->name();
    if (decoded.status != Status::kUnsupported) break;
  }
  if (decoded.status != Status::kOk) {
    result.status = decoded.status;
    result.message = decoded.message;
    return result;
  }

  // For the axis-swapping orientations the decoder's claim is checked against the shapes: the parser and the OS
  // decoder could still disagree about a file (e.g. a malformed EXIF block one of them accepts).
  bool applied = decoded.orientation_applied;
  if (OrientationSwapsAxes(result.exif_orientation) && header.known && header.width != header.height) {
    const int64_t sw = decoded.store->width(), sh = decoded.store->height();
    const int64_t rw = header.width, rh = header.height;
    if (sw != sh) applied = (sw > sh) != (rw > rh);
  }
  const int current = applied ? result.exif_orientation : 1;
  ProcessOptions process = p;
  process.orientation = ComposeOrientation(InverseOrientation(current), desired);
  std::unique_ptr<PixelStore> out;
  result.status = Process(std::move(decoded.store), process, &out);
  if (result.status == Status::kOk) result.store = std::move(out);
  return result;
}

}  // namespace iwn::image
