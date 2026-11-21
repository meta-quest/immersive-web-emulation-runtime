// Composition layers on the XR thread (docs/spec/08 XR-LAYER-1): WebXR Layers quad and cylinder layers, one OpenXR
// swapchain per layer, submitted as XrCompositionLayerQuad / XrCompositionLayerCylinderKHR in renderState.layers
// order around the projection layer. iwn/xr/layers.h has the buffer the adapter shares with this class.
//
// Images. Every live swapchain keeps one image acquired (and waited) for the page to draw into next; its GL name is
// in the shared buffer before the frame is posted (acquire_pending()). A layer the page drew in a frame (getSubImage:
// the entry's kRedrawn flag) has that image released once the frame's GL work is fenced (collect()), which makes it
// the layer's content, and gets the next image before the next frame. A layer the page did not draw keeps its image
// held and the compositor keeps showing the last released one (OpenXR 1.1 §9.4: "the most recently released image"),
// so content the page draws once stays on screen. A layer whose swapchain never released an image is not submitted
// (its swapchain would have no content). A static layer (XR_SWAPCHAIN_CREATE_STATIC_IMAGE_BIT) is acquired and
// released once. Which images a frame releases and which layers it shows is layers::collect() (iwn/xr/layers.h,
// host-tested); this class makes the OpenXR calls.
//
// Colour. Horizon OS's compositor reads an RGBA8 quad or cylinder swapchain as linear (measured: a page's 0.1 showed as
// sRGB 0.35, washed out), while it reads the RGBA8 projection layer as sRGB, and pages (three.js, IWSDK) write
// sRGB-encoded values into layer textures as they do for Quest Browser. So a layer that asks for RGBA8 gets an
// SRGB8_ALPHA8 swapchain, which the compositor decodes, and the page draws into an RGBA8 texture view of each image
// (EXT/OES_texture_view: the same memory, no encoding on write), whose names it is given. Without texture views the
// swapchain stays RGBA8 (colours washed out; logged once). A mono 'texture-array' layer is drawn through a one-layer
// TEXTURE_2D_ARRAY view of each image too (OpenXR hands out 2D images for an array size of 1).
//
// Sources: OpenXR 1.1 §9 (swapchains, acquire/wait/release, static images), §12.4 (XrCompositionLayerQuad,
// eyeVisibility, XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT with premultiplied colour),
// XR_KHR_composition_layer_cylinder, XR_KHR_opengl_es_enable (GL texture names, bottom-left origin).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "iwn/core/json.h"
#include "iwn/xr/layers.h"
#include "iwn/xr/openxr_headers.h"

namespace iwn::xr {

struct LayerSwapchainRequest {
  layers::Kind kind = layers::kQuad;
  uint32_t width = 0, height = 0, array_size = 1;
  uint32_t format = 0x8058;  // GL_RGBA8
  bool is_static = false;
  uint32_t mip_levels = 1;
  bool texture_array = false;  // the page draws through TEXTURE_2D_ARRAYs (also with array_size 1)
};

struct LayerSwapchainAnswer {
  bool ok = false;
  std::string error;
  uint32_t id = 0;  // slot + 1
  uint32_t width = 0, height = 0, array_size = 0;
};

class CompositionLayers {
 public:
  // XR thread, once the OpenXR session exists. `words`: the shared buffer (layers::kWords words, alive for the
  // process); `cylinder`: XR_KHR_composition_layer_cylinder is enabled; `max_w/h`: the system's swapchain size limits.
  void init(XrSession session, const std::vector<int64_t>& formats, uint32_t* words, bool cylinder, uint32_t max_w,
            uint32_t max_h);

  // --- XR thread ---
  void create(const LayerSwapchainRequest& req, LayerSwapchainAnswer* out);
  // layer.destroy(): the layer leaves the frame plan at once; its swapchain goes now, or once the JS frame in flight
  // (which may still have GL work on its images) is collected (`in_flight`).
  void destroy(uint32_t id, bool in_flight);
  // The WebXR session ended: every layer goes (see destroy()).
  void end_session(bool in_flight);
  // Before a JS frame is posted: an image for every live swapchain that has none.
  void acquire_pending();
  // acquireLayerImage(): the image for one swapchain now (a layer the page draws in the frame it was created in).
  uint32_t acquire_now(uint32_t id);
  // After a JS frame, its GL work fenced: releases the redrawn layers' images, rebuilds the frame plan from the list
  // the frame wrote, destroys swapchains whose destruction waited for the frame.
  void collect();
  // Destroys the swapchains whose destruction waited for a JS frame (also called when no frame is in flight any more).
  void flush();
  // Teardown: everything, now.
  void destroy_all();

  // The last collected frame wrote a layer list (else the projection layer is shown alone).
  bool has_list() const { return has_list_; }
  // The plan shows quad or cylinder content (a session may show only such layers), and some of it comes before the
  // projection layer (which must then blend by its alpha).
  bool has_content() const { return layers::plan_has_content(plan_, plan_count_); }
  bool content_under_projection() const { return layers::content_under_projection(plan_, plan_count_); }
  // Appends the plan's layers to `out` in list order, `projection` where the list has the projection layer (left out
  // when null). At most `max` structs (a stereo layer takes two). Returns the number appended.
  uint32_t append(XrSpace base, XrSpace view, const XrCompositionLayerBaseHeader* projection,
                  const XrCompositionLayerBaseHeader** out, uint32_t max);

  size_t live() const;
  // Stats for DBG-STATS (`xr.layers`), from the XR thread's state (the caller holds the stats lock).
  Json stats() const;
  uint64_t frames_with_layers() const { return frames_with_layers_; }
  // Changes whenever stats() would (a swapchain created, destroyed or given its first content).
  uint64_t version() const { return version_; }
  uint32_t last_submitted() const { return last_submitted_; }

 private:
  // A slot's OpenXR side; what decides a frame's list is in book_ (layers::SlotState: the image held after
  // xrWaitSwapchainImage, content released, static, live until the page destroys it).
  struct Swapchain {
    XrSwapchain handle = XR_NULL_HANDLE;
    uint32_t w = 0, h = 0, array = 1;
    std::vector<uint32_t> images;
    std::vector<uint32_t> views;  // views of the images (see Colour), the names the page draws into
    bool srgb = false;            // SRGB8_ALPHA8 images drawn through RGBA8 views
    bool acquired = false;        // xrAcquireSwapchainImage done (book_ held: and waited)
    uint32_t index = 0;
    uint64_t redraws = 0;
  };
  bool acquire(uint32_t slot);
  // A swapchain the page destroyed, kept until no JS frame can draw into it (flush()).
  bool doomed(uint32_t slot) const { return slots_[slot].handle != XR_NULL_HANDLE && !book_[slot].live; }
  uint32_t page_name(const Swapchain& s) const { return s.views.empty() ? s.images[s.index] : s.views[s.index]; }
  // Views (`target`, `format`) of the swapchain's images; false (and none) when a view cannot be made.
  bool make_views(Swapchain& s, uint32_t target, uint32_t format);
  void destroy_slot(uint32_t slot);
  void drop_from_plan(uint32_t id);

  XrSession session_ = XR_NULL_HANDLE;
  std::vector<int64_t> formats_;
  uint32_t* words_ = nullptr;
  bool cylinder_ = false;
  uint32_t max_w_ = 0, max_h_ = 0;
  // glTextureViewEXT / glTextureViewOES, when the GL offers texture views (see Colour)
  void (*texture_view_)(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t) = nullptr;
  bool srgb_ = false;  // SRGB8_ALPHA8 is a swapchain format
  Swapchain slots_[layers::kMaxSwapchains];
  layers::SlotState book_[layers::kMaxSwapchains];
  bool has_list_ = false;
  layers::Entry plan_[layers::kMaxEntries];
  int plan_count_ = 0;
  // the structs of the last append() (valid until the next call)
  XrCompositionLayerQuad quads_[layers::kMaxEntries * 2];
  XrCompositionLayerCylinderKHR cylinders_[layers::kMaxEntries * 2];
  uint64_t frames_with_layers_ = 0;
  uint32_t last_submitted_ = 0;
  uint64_t created_ = 0, destroyed_ = 0;
  uint64_t version_ = 0;
};

}  // namespace iwn::xr
