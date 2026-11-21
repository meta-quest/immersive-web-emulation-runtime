/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "android/xr_loading.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "iwn/core/log.h"
#if defined(IWN_XR_HAVE_IMAGE)
#include "iwn/image/decode.h"
#endif

namespace iwn::xr {

namespace {

constexpr int64_t kRGBA8 = 0x8058;         // GL_RGBA8
constexpr int64_t kSRGB8_ALPHA8 = 0x8C43;  // GL_SRGB8_ALPHA8

void flip_rows(std::vector<uint8_t>* px, int w, int h) {
  const size_t row = static_cast<size_t>(w) * 4;
  std::vector<uint8_t> tmp(row);
  for (int y = 0; y < h / 2; ++y) {
    uint8_t* a = px->data() + static_cast<size_t>(y) * row;
    uint8_t* b = px->data() + static_cast<size_t>(h - 1 - y) * row;
    std::memcpy(tmp.data(), a, row);
    std::memcpy(a, b, row);
    std::memcpy(b, tmp.data(), row);
  }
}

XrPosef pose_of(const XrVector3f& p, const XrQuaternionf& q) {
  XrPosef out;
  out.position = p;
  out.orientation = q;
  return out;
}

}  // namespace

LoadingImage decode_loading_image(const uint8_t* data, size_t size, int max_side) {
  LoadingImage out;
#if defined(IWN_XR_HAVE_IMAGE)
  namespace img = iwn::image;
  img::DecodeOptions opts;
  opts.use_budget = false;
  opts.allow_os_formats = false;
  opts.limits.max_dimension = 4096;  // the packer refuses larger splash images (at most 64 MiB while decoding)
  opts.process.flip_y = true;  // GL's origin is the bottom-left corner
  opts.process.alpha = img::AlphaRequest::kPremultiplied;
  const img::HeaderInfo hi = img::ReadHeaderInfo(data, size, img::SniffFormat(data, size));
  if (hi.known && (hi.width > static_cast<uint32_t>(max_side) || hi.height > static_cast<uint32_t>(max_side))) {
    const double s = static_cast<double>(max_side) / std::max(hi.width, hi.height);
    opts.process.resize_width = std::max<uint32_t>(1, static_cast<uint32_t>(std::lround(hi.width * s)));
    opts.process.resize_height = std::max<uint32_t>(1, static_cast<uint32_t>(std::lround(hi.height * s)));
    opts.process.quality = img::ResizeQuality::kHigh;
  }
  img::DecodeResult r = img::Decode(data, size, opts);
  if (r.status != img::Status::kOk || !r.store) {
    out.error = std::string("cannot decode the splash image (") + img::StatusName(r.status) +
                (r.message.empty() ? "" : ": " + r.message) + ")";
    return out;
  }
  img::ScopedPixels px = r.store->Read();
  if (!px.ok()) {
    out.error = "cannot read the decoded splash image";
    return out;
  }
  const img::PixelView& v = px.view();
  out.width = static_cast<int>(v.width);
  out.height = static_cast<int>(v.height);
  out.pixels.resize(static_cast<size_t>(out.width) * out.height * 4);
  for (uint32_t y = 0; y < v.height; ++y) {
    std::memcpy(out.pixels.data() + static_cast<size_t>(y) * v.width * 4, v.data + y * v.stride, v.width * 4u);
  }
  if (v.alpha == img::AlphaMode::kUnpremultiplied && !v.opaque) premultiply_rgba(out.pixels.data(), out.pixels.size() / 4);
#else
  (void)data;
  (void)size;
  (void)max_side;
  out.error = "this build has no image decoder";
#endif
  return out;
}

bool LoadingLayers::make_image(XrSession session, int64_t format, int w, int h, int mips, const uint8_t* pixels,
                               Image* out, const char* what) {
  XrSwapchainCreateInfo ci{XR_TYPE_SWAPCHAIN_CREATE_INFO};
  ci.createFlags = XR_SWAPCHAIN_CREATE_STATIC_IMAGE_BIT;
  ci.usageFlags = XR_SWAPCHAIN_USAGE_SAMPLED_BIT | XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT |
                  XR_SWAPCHAIN_USAGE_TRANSFER_DST_BIT;
  ci.format = format;
  ci.sampleCount = 1;
  ci.width = static_cast<uint32_t>(w);
  ci.height = static_cast<uint32_t>(h);
  ci.faceCount = 1;
  ci.arraySize = 1;
  ci.mipCount = static_cast<uint32_t>(mips);
  XrSwapchain sc = XR_NULL_HANDLE;
  XrResult r = xrCreateSwapchain(session, &ci, &sc);
  if (XR_FAILED(r)) {
    ci.createFlags = 0;  // a runtime that refuses static swapchains: one acquire/release still holds the image
    r = xrCreateSwapchain(session, &ci, &sc);
  }
  if (XR_FAILED(r) && mips > 1) {
    ci.mipCount = 1;
    mips = 1;
    r = xrCreateSwapchain(session, &ci, &sc);
  }
  if (XR_FAILED(r)) {
    log(LogLevel::kWarn, "xr: loading screen: xrCreateSwapchain (%s %dx%d) failed: %d", what, w, h, r);
    return false;
  }
  uint32_t count = 0;
  xrEnumerateSwapchainImages(sc, 0, &count, nullptr);
  std::vector<XrSwapchainImageOpenGLESKHR> imgs(count, {XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_ES_KHR});
  xrEnumerateSwapchainImages(sc, count, &count, reinterpret_cast<XrSwapchainImageBaseHeader*>(imgs.data()));
  uint32_t index = 0;
  XrSwapchainImageAcquireInfo ai{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};
  XrSwapchainImageWaitInfo wi{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO};
  wi.timeout = 1000000000;  // 1 s: a fresh swapchain's image is free at once
  if (count == 0 || XR_FAILED(xrAcquireSwapchainImage(sc, &ai, &index)) || index >= count ||
      XR_FAILED(xrWaitSwapchainImage(sc, &wi))) {
    log(LogLevel::kWarn, "xr: loading screen: could not acquire the %s image", what);
    xrDestroySwapchain(sc);
    return false;
  }
  // The XR thread's context also reads back eye buffers (shot) and applies foveation: leave its state as found.
  GLint prev_tex = 0, prev_align = 4;
  glGetIntegerv(GL_TEXTURE_BINDING_2D, &prev_tex);
  glGetIntegerv(GL_UNPACK_ALIGNMENT, &prev_align);
  while (glGetError() != GL_NO_ERROR) {
  }
  glBindTexture(GL_TEXTURE_2D, imgs[index].image);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
  glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
  if (mips > 1) glGenerateMipmap(GL_TEXTURE_2D);
  const GLenum err = glGetError();
  glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(prev_tex));
  glPixelStorei(GL_UNPACK_ALIGNMENT, prev_align);
  glFlush();
  XrSwapchainImageReleaseInfo ri{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO};
  xrReleaseSwapchainImage(sc, &ri);
  if (err != GL_NO_ERROR) {
    log(LogLevel::kWarn, "xr: loading screen: uploading the %s image failed: GL error 0x%x", what, err);
    xrDestroySwapchain(sc);
    return false;
  }
  out->swapchain = sc;
  out->w = w;
  out->h = h;
  return true;
}

bool LoadingLayers::create(XrSession session, const std::vector<int64_t>& formats, const LoadingConfig& config,
                           const LoadingImage* card) {
  destroy();
  config_ = config;
  if (!config.enabled) return false;
  // The images are sRGB-encoded (a PNG, hex colours). Horizon OS's compositor reads a quad's GL_RGBA8 texture as
  // linear and encodes it again (measured: the splash's #1d65c1 showed as about #54acd0), so an sRGB swapchain is
  // what shows the same colours as the system splash; RGBA8 only where the runtime lacks it.
  const bool srgb = std::find(formats.begin(), formats.end(), kSRGB8_ALPHA8) != formats.end();
  const int64_t format = srgb ? kSRGB8_ALPHA8 : kRGBA8;
  if (!srgb && std::find(formats.begin(), formats.end(), kRGBA8) == formats.end()) {
    log(LogLevel::kWarn, "xr: loading screen: the runtime offers neither sRGB nor RGBA8 swapchains; not shown");
    return false;
  }
  if (!srgb) log(LogLevel::kWarn, "xr: loading screen: no sRGB swapchain format; colours will look washed out");
  // Single-level images. Horizon OS's compositor draws a single-level quad with a shader it always has, from the
  // first frame; for a mipmapped quad it first compiles a shader (~200 ms, "PSO : MISSING ... No fallback" in the
  // log, the first time it meets one), during which the quad is not drawn: on a first launch the card blinked out
  // when the system splash faded. Bilinear sampling is enough here: the card is minified ~1.3x at its default size
  // and the spinner image is sized for the 3.2 degrees it covers.
  auto make = [&](int w, int h, const uint8_t* px, Image* out, const char* what) {
    return make_image(session, format, w, h, 1, px, out, what) ||
           (format != kRGBA8 && make_image(session, kRGBA8, w, h, 1, px, out, what));
  };
  if (card && card->width > 0 && card->height > 0 &&
      card->pixels.size() == static_cast<size_t>(card->width) * card->height * 4) {
    make(card->width, card->height, card->pixels.data(), &card_, "card");
  }
  if (config.spinner) {
    // 3.2 degrees on a display of 20-25 pixels per degree (Quest 3S, Quest 3): 96 px, minified at most ~1.5x.
    constexpr int kSpinner = 96;
    std::vector<uint8_t> px = spinner_image(kSpinner);
    flip_rows(&px, kSpinner, kSpinner);
    make(kSpinner, kSpinner, px.data(), &spinner_, "spinner");
  }
  {
    // The opaque background, also when black: what shows behind a frame without an opaque layer is up to the system
    // (Horizon OS can show passthrough there). A uniform colour needs no resolution: 16 x 16 per eye, side by side.
    constexpr int kW = 32, kH = 16;
    std::vector<uint8_t> px(static_cast<size_t>(kW) * kH * 4);
    for (size_t i = 0; i < px.size(); i += 4) {
      for (int c = 0; c < 3; ++c) px[i + c] = static_cast<uint8_t>(std::lround(config.background[c] * 255.0f));
      px[i + 3] = 255;
    }
    if (!make_image(session, format, kW, kH, 1, px.data(), &bg_, "background") && format != kRGBA8)
      make_image(session, kRGBA8, kW, kH, 1, px.data(), &bg_, "background");
  }
  layout_ = loading_layout(config, card_.w, card_.h);
  ready_ = card_.swapchain != XR_NULL_HANDLE || spinner_.swapchain != XR_NULL_HANDLE || bg_.swapchain != XR_NULL_HANDLE;
  return ready_;
}

void LoadingLayers::destroy() {
  for (Image* i : {&card_, &spinner_, &bg_}) {
    if (i->swapchain != XR_NULL_HANDLE) xrDestroySwapchain(i->swapchain);
    *i = Image{};
  }
  ready_ = false;
}

uint32_t LoadingLayers::build_cover(XrSpace view_space, const XrCompositionLayerBaseHeader** out, uint32_t max) {
  if (bg_.swapchain == XR_NULL_HANDLE || view_space == XR_NULL_HANDLE || max == 0) return 0;
  // Head-locked (the view space, both views at its origin) and wider than any headset's field of view: a uniform
  // colour needs neither the eyes' poses nor tracking, so it covers the view from the first frame, before the head
  // pose is known too. No blend flags: opaque, so nothing the system would put behind the app shows through.
  constexpr float kHalfFov = 1.3f;  // radians (74.5 degrees) on each side
  for (int i = 0; i < 2; ++i) {
    XrCompositionLayerProjectionView& v = bg_views_[i];
    v = XrCompositionLayerProjectionView{XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW};
    v.pose = pose_of({0, 0, 0}, {0, 0, 0, 1});
    v.fov = {-kHalfFov, kHalfFov, kHalfFov, -kHalfFov};
    v.subImage.swapchain = bg_.swapchain;
    v.subImage.imageRect = {{i * (bg_.w / 2), 0}, {bg_.w / 2, bg_.h}};
    v.subImage.imageArrayIndex = 0;
  }
  bg_layer_ = XrCompositionLayerProjection{XR_TYPE_COMPOSITION_LAYER_PROJECTION};
  bg_layer_.space = view_space;
  bg_layer_.viewCount = 2;
  bg_layer_.views = bg_views_;
  out[0] = reinterpret_cast<const XrCompositionLayerBaseHeader*>(&bg_layer_);
  return 1;
}

uint32_t LoadingLayers::build_quads(XrSpace space, const XrPosef& anchor, double now_ms, float alpha, bool scale_bias,
                                    const XrCompositionLayerBaseHeader** out, uint32_t max) {
  uint32_t n = 0;
  if (!ready_) return 0;
  const bool fade = scale_bias && alpha < 1.0f;
  const float a = std::clamp(alpha, 0.0f, 1.0f);
  auto quad = [&](XrCompositionLayerQuad& layer, XrCompositionLayerColorScaleBiasKHR& csb, const Image& img,
                  const XrPosef& local, float w, float h) {
    if (img.swapchain == XR_NULL_HANDLE || n >= max) return;
    layer = XrCompositionLayerQuad{XR_TYPE_COMPOSITION_LAYER_QUAD};
    layer.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;  // premultiplied (no UNPREMULTIPLIED bit)
    layer.space = space;
    layer.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
    layer.subImage.swapchain = img.swapchain;
    layer.subImage.imageRect = {{0, 0}, {img.w, img.h}};
    layer.subImage.imageArrayIndex = 0;
    layer.pose = compose(anchor, local);
    layer.size = {w, h};
    if (fade) {
      csb = XrCompositionLayerColorScaleBiasKHR{XR_TYPE_COMPOSITION_LAYER_COLOR_SCALE_BIAS_KHR};
      csb.colorScale = {a, a, a, a};
      csb.colorBias = {0, 0, 0, 0};
      layer.next = &csb;
    }
    out[n++] = reinterpret_cast<const XrCompositionLayerBaseHeader*>(&layer);
  };
  if (layout_.card) {
    quad(card_layer_, card_fade_, card_, pose_of(layout_.card_center, {0, 0, 0, 1}), layout_.card_w, layout_.card_h);
  }
  if (layout_.spinner_size > 0) {
    quad(spinner_layer_, spinner_fade_, spinner_, pose_of(layout_.spinner_center, spinner_roll(now_ms)),
         layout_.spinner_size, layout_.spinner_size);
  }
  return n;
}

}  // namespace iwn::xr
