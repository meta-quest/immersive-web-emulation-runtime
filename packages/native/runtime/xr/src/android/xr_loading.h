/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The loading screen's OpenXR side (iwn/xr/loading.h has the policy, placement, images and the frame plan). XR thread
// only: static swapchains for the card (the app's splash image), the spinner and the opaque background colour (black
// by default), filled once with GL in the XR thread's context, and the composition layers for each frame that shows
// them. The passthrough background's layer belongs to the XR thread's passthrough (xr_system.cc), shared with
// immersive-ar.
//
// Sources: OpenXR 1.1 §9 (swapchains: XR_SWAPCHAIN_CREATE_STATIC_IMAGE_BIT, "the most recently released image is
// used"), §12 (XrCompositionLayerQuad, XrCompositionLayerProjection, premultiplied alpha and
// XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT), XR_KHR_composition_layer_color_scale_bias (fades),
// XR_KHR_opengl_es_enable (GL texture names, bottom-left origin), OpenGL ES 3.2 (texture uploads, mipmaps).
#pragma once

#include <GLES3/gl3.h>

#include <cstdint>
#include <string>
#include <vector>

#include "iwn/xr/loading.h"
#include "iwn/xr/openxr_headers.h"

namespace iwn::xr {

// An image ready for upload: premultiplied RGBA8, tightly packed, bottom row first (GL's origin).
struct LoadingImage {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> pixels;
  std::string error;  // why there is no image (logged once)
};

// Decodes the splash PNG (any thread): premultiplied, flipped for GL, scaled down to at most `max_side` pixels.
LoadingImage decode_loading_image(const uint8_t* data, size_t size, int max_side = 2048);

class LoadingLayers {
 public:
  // XR thread, the session's GL context current. `card` may be null or empty (spinner only). False when nothing
  // could be created (the runtime then shows the plain idle presentation).
  bool create(XrSession session, const std::vector<int64_t>& formats, const LoadingConfig& config,
              const LoadingImage* card);
  void destroy();
  bool ready() const { return ready_; }
  bool has_card() const { return card_.swapchain != XR_NULL_HANDLE; }
  bool has_background() const { return bg_.swapchain != XR_NULL_HANDLE; }
  int card_width() const { return card_.w; }
  int card_height() const { return card_.h; }

  // This frame's layers (plan_frame_layers() decides which), appended to `out` (at most `max`; the structs stay
  // valid until the next call of the same function). Each returns how many it appended.
  //   build_cover: the opaque background projection layer, head-locked in `view_space` (both views at its origin,
  //   wider than any field of view: it needs no head pose and covers the view from the first frame).
  //   build_quads: the card and the spinner quads in `space` around `anchor`; `alpha` < 1 fades them (premultiplied
  //   colour scale) when `scale_bias` (the extension) is enabled.
  uint32_t build_cover(XrSpace view_space, const XrCompositionLayerBaseHeader** out, uint32_t max);
  uint32_t build_quads(XrSpace space, const XrPosef& anchor, double now_ms, float alpha, bool scale_bias,
                       const XrCompositionLayerBaseHeader** out, uint32_t max);

 private:
  struct Image {
    XrSwapchain swapchain = XR_NULL_HANDLE;
    int w = 0;
    int h = 0;
  };
  // A static swapchain (one image, acquired and released once), filled with `pixels` (bottom row first) and, when
  // `mips` > 1, mipmapped. Falls back to an ordinary swapchain where the static flag is refused.
  bool make_image(XrSession session, int64_t format, int w, int h, int mips, const uint8_t* pixels, Image* out,
                  const char* what);

  LoadingConfig config_;
  LoadingLayout layout_;
  bool ready_ = false;
  Image card_, spinner_, bg_;
  XrCompositionLayerQuad card_layer_{XR_TYPE_COMPOSITION_LAYER_QUAD};
  XrCompositionLayerQuad spinner_layer_{XR_TYPE_COMPOSITION_LAYER_QUAD};
  XrCompositionLayerColorScaleBiasKHR card_fade_{XR_TYPE_COMPOSITION_LAYER_COLOR_SCALE_BIAS_KHR};
  XrCompositionLayerColorScaleBiasKHR spinner_fade_{XR_TYPE_COMPOSITION_LAYER_COLOR_SCALE_BIAS_KHR};
  XrCompositionLayerProjection bg_layer_{XR_TYPE_COMPOSITION_LAYER_PROJECTION};
  XrCompositionLayerProjectionView bg_views_[2] = {{XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW},
                                                   {XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW}};
};

}  // namespace iwn::xr
