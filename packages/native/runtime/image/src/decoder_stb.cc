/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// stb_image backend (public domain / MIT, v2.30): PNG, JPEG (baseline, progressive, CMYK/YCCK), GIF (first frame),
// BMP. Used for host tests and as a fallback where AImageDecoder is unavailable.
#include <climits>
#include <cstring>
#include <string>
#include <cstdlib>

#include "iwn/image/decode.h"

#if IWN_IMAGE_WITH_STB
#define STBI_NO_STDIO
#define STBI_NO_HDR
#define STBI_NO_LINEAR
#define STBI_NO_PSD
#define STBI_NO_TGA
#define STBI_NO_PIC
#define STBI_NO_PNM
#define STBI_MAX_DIMENSIONS (1 << 16)  // the real limits are checked against stbi_info first
// Zeroed allocations: on corrupt JPEGs stb leaves parts of its component buffers unwritten (found by the valgrind
// fuzz run), which would otherwise surface stale heap bytes as pixels.
#define STBI_MALLOC(sz) std::calloc(1, (sz))
#define STBI_REALLOC(p, newsz) std::realloc((p), (newsz))
#define STBI_FREE(p) std::free(p)
#define STB_IMAGE_STATIC
#define STB_IMAGE_IMPLEMENTATION
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-function"
#pragma GCC diagnostic ignored "-Wsign-compare"
#endif
#include "stb_image.h"
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
#endif

namespace iwn::image {

#if IWN_IMAGE_WITH_STB
namespace {

void StbFree(void* p) { stbi_image_free(p); }

class Stb final : public DecoderBackend {
 public:
  const char* name() const override { return "stb_image"; }
  bool Handles(Format f) const override {
    return f == Format::kPng || f == Format::kJpeg || f == Format::kGif || f == Format::kBmp;
  }
  BackendResult Decode(const BackendRequest& req) override {
    BackendResult r;
    if (req.size > static_cast<size_t>(INT_MAX)) {
      r.status = Status::kTooLarge;
      return r;
    }
    const int len = static_cast<int>(req.size);
    int w = 0, h = 0, comp = 0;
    if (!stbi_info_from_memory(req.data, len, &w, &h, &comp)) {
      r.status = Status::kCorrupt;
      r.message = stbi_failure_reason() ? stbi_failure_reason() : "unreadable header";
      return r;
    }
    if (w <= 0 || h <= 0) {
      r.status = Status::kCorrupt;
      return r;
    }
    // stb returns a cut-off JPEG as a complete image (missing blocks grey); AImageDecoder rejects it. Match that.
    if (req.format == Format::kJpeg && !JpegHasEndAfterScan(req.data, req.size)) {
      r.status = Status::kCorrupt;
      r.message = "truncated JPEG (no end-of-image marker)";
      return r;
    }
    if (static_cast<uint32_t>(w) > req.limits.max_dimension || static_cast<uint32_t>(h) > req.limits.max_dimension ||
        static_cast<uint64_t>(w) * static_cast<uint64_t>(h) > req.limits.max_pixels) {
      r.status = Status::kTooLarge;
      return r;
    }
    int ow = 0, oh = 0, ocomp = 0;
    stbi_uc* pixels = stbi_load_from_memory(req.data, len, &ow, &oh, &ocomp, 4);
    if (!pixels) {
      const char* why = stbi_failure_reason();
      r.status = (why && std::string(why) == "outofmem") ? Status::kOutOfMemory : Status::kCorrupt;
      r.message = why ? why : "decode failed";
      return r;
    }
    std::unique_ptr<PixelStore> store;
    if (req.allocator == HeapAllocator) {
      // Adopted as is: rows are tightly packed (stride width * 4, 4-byte aligned), not 16-byte aligned.
      store = PixelStore::Adopt(pixels, static_cast<uint32_t>(ow), static_cast<uint32_t>(oh),
                                static_cast<size_t>(ow) * 4, &StbFree);
    } else {
      store = req.allocator(static_cast<uint32_t>(ow), static_cast<uint32_t>(oh));
      if (store) {
        MutablePixelView mv = store->LockWrite();
        if (mv.data) {
          for (int y = 0; y < oh; ++y) {
            std::memcpy(mv.data + static_cast<size_t>(y) * mv.stride, pixels + static_cast<size_t>(y) * ow * 4,
                        static_cast<size_t>(ow) * 4);
          }
        }
        store->UnlockWrite();
        if (!mv.data) store.reset();
      }
      stbi_image_free(pixels);
    }
    if (!store) {
      r.status = Status::kOutOfMemory;
      return r;
    }
    store->set_alpha(AlphaMode::kUnpremultiplied);
    ScopedPixels sp = store->Read();
    store->set_opaque(sp.ok() && IsOpaque(sp.view()));
    sp = ScopedPixels();
    if (req.want_premultiplied && !store->opaque()) {
      MutablePixelView mv = store->LockWrite();
      for (uint32_t y = 0; y < mv.height; ++y) PremultiplyRow(mv.data + y * mv.stride, mv.width);
      store->UnlockWrite();
      store->set_alpha(AlphaMode::kPremultiplied);
    }
    r.status = Status::kOk;
    r.store = std::move(store);
    return r;
  }
};

}  // namespace

DecoderBackend* StbBackend() {
  static Stb backend;
  return &backend;
}
#else
DecoderBackend* StbBackend() { return nullptr; }
#endif

}  // namespace iwn::image
