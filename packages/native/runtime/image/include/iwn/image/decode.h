/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Image decoding: format sniffing, EXIF orientation, decoder backends (Android AImageDecoder, stb_image, libwebp)
// and the decode-then-process pipeline that createImageBitmap / HTMLImageElement use. Plain C++, no V8.
// Decode() is synchronous and thread-safe; the binding runs it on the decode pool, never on a JS thread (PROC-2).
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "iwn/image/pixels.h"
#include "iwn/image/transform.h"

namespace iwn::image {

enum class Format : uint8_t { kUnknown, kPng, kJpeg, kGif, kWebp, kBmp, kIco, kHeif, kAvif };
const char* FormatMime(Format format);

// Recognises the format from its signature bytes (the MIME type of the response is ignored, as browsers sniff).
Format SniffFormat(const uint8_t* data, size_t size);

// Reads the EXIF orientation (1..8) from JPEG APP1, PNG eXIf or WebP EXIF; 1 when absent or malformed. Never reads
// outside [data, data + size).
int ReadExifOrientation(const uint8_t* data, size_t size, Format format);
// Parses a TIFF structure ("II*\0" / "MM\0*") and returns tag 0x0112, or 1. Same acceptance rules as Skia (the
// decoder behind AImageDecoder) and Chromium: type SHORT, count 1, value 1..8, in IFD0 or the Exif sub-IFD. Other
// encodings (e.g. a LONG-typed value) are ignored, as those decoders ignore them.
int ReadTiffOrientation(const uint8_t* tiff, size_t size);

// What the container header says, read without decoding (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X, GIF logical
// screen, BMP info header). Width/height are the stored size, before EXIF orientation.
struct HeaderInfo {
  bool known = false;
  uint32_t width = 0;
  uint32_t height = 0;
  // A complete file of this size cannot be smaller than this (PNG: the image data at deflate's best ratio); 0 when
  // there is no useful bound. Lets an absurd header ("16384 x 16384" in 300 bytes) fail before a 1 GiB allocation.
  uint64_t min_file_size = 0;
};
HeaderInfo ReadHeaderInfo(const uint8_t* data, size_t size, Format format);

// JPEG: true when an EOI marker follows the first start-of-scan. A file cut short has none; AImageDecoder rejects
// such files and the stb backend uses this to do the same (stb would return the missing part as grey).
bool JpegHasEndAfterScan(const uint8_t* data, size_t size);

// WHATWG Infra forgiving-base64 decode (data: URLs). False on invalid input.
bool ForgivingBase64Decode(const uint8_t* in, size_t n, std::vector<uint8_t>* out);

// IMG-3: images above 16384 px in either dimension or 256 MP (256 x 10^6 pixels) in total are rejected (kTooLarge).
struct Limits {
  uint32_t max_dimension = 16384;
  uint64_t max_pixels = uint64_t{256} * 1000 * 1000;
};

// Bounds the memory of decodes in flight across all pool threads: a decode reserves its estimated output size before
// it allocates and waits while the total would exceed the budget. A single decode larger than the whole budget still
// runs, alone. Thread-safe.
class DecodeBudget {
 public:
  static DecodeBudget& Shared();
  void SetLimit(uint64_t bytes);  // 0: no limit
  uint64_t limit() const;
  uint64_t in_flight() const;
  // Blocks until `bytes` fit or `cancel` becomes true (checked every few ms). Returns false when cancelled.
  bool Acquire(uint64_t bytes, const std::atomic<bool>* cancel);
  void Release(uint64_t bytes);

 private:
  mutable std::mutex mu_;
  std::condition_variable cv_;
  uint64_t limit_ = 0;
  uint64_t in_flight_ = 0;
};

struct BackendRequest {
  const uint8_t* data = nullptr;
  size_t size = 0;
  Format format = Format::kUnknown;
  int exif_orientation = 1;  // as parsed by ReadExifOrientation
  bool want_premultiplied = false;  // the backend may return premultiplied pixels directly
  Limits limits;
  StoreAllocator allocator = HeapAllocator;
  // Downscaled decode hint: the caller resizes to this size afterwards (0: full size). A backend that can decode
  // smaller cheaply and with proper filtering (libjpeg-turbo DCT scaling, libwebp's rescaler) may return any size
  // with both sides >= 2x the target; others ignore it. Given in stored (pre-EXIF) orientation.
  uint32_t min_width = 0;
  uint32_t min_height = 0;
};

struct BackendResult {
  Status status = Status::kUnsupported;
  std::unique_ptr<PixelStore> store;
  bool orientation_applied = false;  // the backend believes it applied the EXIF orientation (Decode() verifies 5..8)
  std::string message;
};

class DecoderBackend {
 public:
  virtual ~DecoderBackend() = default;
  virtual const char* name() const = 0;
  // Whether this backend should be tried for `format` (kUnknown: only backends that sniff by themselves).
  virtual bool Handles(Format format) const = 0;
  virtual BackendResult Decode(const BackendRequest& request) = 0;
  // Whether this backend honours BackendRequest::min_width/min_height for `format` (decodes at most ~2x the target
  // per side instead of full size). Decode() reserves memory budget for the full size unless this is true.
  virtual bool DownscalesFormat(Format format) const { return false; }
};

// Software backends, always compiled where enabled (host tests; Android fallback before API 30).
DecoderBackend* StbBackend();   // PNG, JPEG, GIF (first frame), BMP; nullptr if built without stb
DecoderBackend* WebpBackend();  // WebP (lossy, lossless, alpha, first frame of animations); nullptr if not built
// Android AImageDecoder (API 30+, resolved with dlopen so the library also loads on API 29). nullptr elsewhere or
// when libjnigraphics lacks it.
DecoderBackend* AndroidBackend();

struct DecodeOptions {
  bool apply_exif_orientation = true;  // imageOrientation 'from-image' / 'flipY' (and <img>); false for 'none'
  ProcessOptions process;              // crop / resize / flipY / alpha; `orientation` is computed and ignored here
  Limits limits;
  // HEIF / AVIF / ICO and other formats the OS decoder accepts beyond PNG/JPEG/GIF/WebP/BMP (IMG-1 requires only
  // those). When false, they fail with kUnsupported.
  bool allow_os_formats = true;
  // Set by the caller (any thread) to abandon the job: checked before decoding and while waiting for the budget.
  const std::atomic<bool>* cancel = nullptr;
  // Reserve the output size in DecodeBudget::Shared() before decoding.
  bool use_budget = true;
};

struct DecodeResult {
  Status status = Status::kUnsupported;
  std::unique_ptr<PixelStore> store;
  Format format = Format::kUnknown;
  int exif_orientation = 1;
  const char* backend = "";
  std::string message;
};

// Decodes with the first backend that handles the format, then applies the options. The result's store is
// immutable from here on.
DecodeResult Decode(const uint8_t* data, size_t size, const DecodeOptions& options);

// Backend order used by Decode(). Default: Android (if available), then WebP and stb. Tests may replace it.
std::vector<DecoderBackend*> DefaultBackends();
void SetBackendsForTesting(std::vector<DecoderBackend*> backends);  // empty: restore defaults

}  // namespace iwn::image
