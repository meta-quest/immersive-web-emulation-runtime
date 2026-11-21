// libwebp backend (BSD-3-Clause, v1.5.0): lossy, lossless, alpha; the first frame of animated files through the
// demux library's animation decoder (which composites onto the canvas as the WebP container spec says).
#include <cstring>

#include "iwn/image/decode.h"

#if IWN_IMAGE_WITH_WEBP
#include "webp/decode.h"
#include "webp/demux.h"
#endif

namespace iwn::image {

#if IWN_IMAGE_WITH_WEBP
namespace {

class Webp final : public DecoderBackend {
 public:
  const char* name() const override { return "libwebp"; }
  bool Handles(Format f) const override { return f == Format::kWebp; }

  BackendResult Decode(const BackendRequest& req) override {
    BackendResult r;
    WebPBitstreamFeatures features;
    const VP8StatusCode fs = WebPGetFeatures(req.data, req.size, &features);
    if (fs != VP8_STATUS_OK || features.width <= 0 || features.height <= 0) {
      r.status = fs == VP8_STATUS_UNSUPPORTED_FEATURE ? Status::kUnsupported : Status::kCorrupt;
      r.message = "WebPGetFeatures failed";
      return r;
    }
    uint32_t w = static_cast<uint32_t>(features.width), h = static_cast<uint32_t>(features.height);
    if (w > req.limits.max_dimension || h > req.limits.max_dimension ||
        static_cast<uint64_t>(w) * h > req.limits.max_pixels) {
      r.status = Status::kTooLarge;
      return r;
    }
    // Downscaled decode through libwebp's rescaler (area filter, alpha-aware) when a later resize allows it.
    bool scaled = false;
    if (req.min_width && req.min_height && !features.has_animation) {
      for (uint32_t sample : {8u, 4u, 2u}) {
        const uint32_t sw = (w + sample - 1) / sample, sh = (h + sample - 1) / sample;
        if (uint64_t{sw} >= uint64_t{req.min_width} * 2 && uint64_t{sh} >= uint64_t{req.min_height} * 2) {
          w = sw;
          h = sh;
          scaled = true;
          break;
        }
      }
    }
    std::unique_ptr<PixelStore> store = req.allocator(w, h);
    if (!store) {
      r.status = Status::kOutOfMemory;
      return r;
    }
    MutablePixelView mv = store->LockWrite();
    if (!mv.data) {
      r.status = Status::kOutOfMemory;
      return r;
    }
    bool ok = false;
    if (features.has_animation) {
      ok = DecodeFirstFrame(req, mv);
    } else {
      // RGBA = straight alpha, rgbA = premultiplied (libwebp's MODE_rgbA).
      const WEBP_CSP_MODE mode = req.want_premultiplied ? MODE_rgbA : MODE_RGBA;
      WebPDecoderConfig config;
      if (WebPInitDecoderConfig(&config)) {
        config.output.colorspace = mode;
        if (scaled) {
          config.options.use_scaling = 1;
          config.options.scaled_width = static_cast<int>(w);
          config.options.scaled_height = static_cast<int>(h);
        }
        config.output.is_external_memory = 1;
        config.output.u.RGBA.rgba = mv.data;
        config.output.u.RGBA.stride = static_cast<int>(mv.stride);
        config.output.u.RGBA.size = mv.stride * h;
        ok = WebPDecode(req.data, req.size, &config) == VP8_STATUS_OK;
        WebPFreeDecBuffer(&config.output);
      }
    }
    store->UnlockWrite();
    if (!ok) {
      r.status = Status::kCorrupt;
      r.message = "WebP decode failed";
      return r;
    }
    const bool premul = req.want_premultiplied && !features.has_animation;
    store->set_alpha(premul ? AlphaMode::kPremultiplied : AlphaMode::kUnpremultiplied);
    if (!features.has_alpha) {
      store->set_opaque(true);
    } else {
      ScopedPixels sp = store->Read();
      store->set_opaque(sp.ok() && IsOpaque(sp.view()));
    }
    r.status = Status::kOk;
    r.store = std::move(store);
    return r;
  }

 private:
  static bool DecodeFirstFrame(const BackendRequest& req, const MutablePixelView& mv) {
    WebPAnimDecoderOptions options;
    if (!WebPAnimDecoderOptionsInit(&options)) return false;
    options.color_mode = MODE_RGBA;
    options.use_threads = 0;
    WebPData data = {req.data, req.size};
    WebPAnimDecoder* dec = WebPAnimDecoderNew(&data, &options);
    if (!dec) return false;
    WebPAnimInfo info;
    bool ok = WebPAnimDecoderGetInfo(dec, &info) && info.canvas_width == mv.width && info.canvas_height == mv.height;
    uint8_t* frame = nullptr;
    int timestamp = 0;
    if (ok) ok = WebPAnimDecoderGetNext(dec, &frame, &timestamp) && frame;
    if (ok) {
      for (uint32_t y = 0; y < mv.height; ++y) {
        std::memcpy(mv.data + y * mv.stride, frame + static_cast<size_t>(y) * mv.width * 4,
                    static_cast<size_t>(mv.width) * 4);
      }
    }
    WebPAnimDecoderDelete(dec);
    return ok;
  }
};

}  // namespace

DecoderBackend* WebpBackend() {
  static Webp backend;
  return &backend;
}
#else
DecoderBackend* WebpBackend() { return nullptr; }
#endif

}  // namespace iwn::image
