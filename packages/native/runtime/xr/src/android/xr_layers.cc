/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// See xr_layers.h.
#include "android/xr_layers.h"

#include <EGL/egl.h>
#include <GLES3/gl3.h>

#include <algorithm>
#include <cinttypes>
#include <cmath>
#include <cstring>

#include "iwn/core/log.h"

namespace iwn::xr {

namespace {

constexpr int64_t kGlRGBA8 = 0x8058;
constexpr int64_t kGlSRGB8Alpha8 = 0x8C43;

const char* kind_name(layers::Kind k) { return k == layers::kCylinder ? "cylinder" : "quad"; }

XrEyeVisibility eye_visibility(int eye) {
  return eye == 1 ? XR_EYE_VISIBILITY_LEFT : eye == 2 ? XR_EYE_VISIBILITY_RIGHT : XR_EYE_VISIBILITY_BOTH;
}

XrPosef pose_of(const float p[7]) {
  // valid_pose() let the quaternion within 1 % of unit length; OpenXR wants it normalised
  const float len = std::sqrt(p[3] * p[3] + p[4] * p[4] + p[5] * p[5] + p[6] * p[6]);
  XrPosef pose;
  pose.orientation = {p[3] / len, p[4] / len, p[5] / len, p[6] / len};
  pose.position = {p[0], p[1], p[2]};
  return pose;
}

}  // namespace

void CompositionLayers::init(XrSession session, const std::vector<int64_t>& formats, uint32_t* words, bool cylinder,
                             uint32_t max_w, uint32_t max_h) {
  session_ = session;
  formats_ = formats;
  words_ = words;
  cylinder_ = cylinder;
  max_w_ = max_w;
  max_h_ = max_h;
  // the header was written before the page could read it (XrSystem::start()); no image is held yet
  std::fill(words_ + layers::kNamesAt, words_ + layers::kNamesAt + layers::kMaxSwapchains, 0u);
  // Colour (xr_layers.h): sRGB swapchains drawn through RGBA8 views, when the GL (this thread's context) has views
  const char* exts = reinterpret_cast<const char*>(glGetString(GL_EXTENSIONS));
  const bool ext = exts && std::strstr(exts, "GL_EXT_texture_view") != nullptr;
  const bool oes = exts && std::strstr(exts, "GL_OES_texture_view") != nullptr;
  using ViewFn = void (*)(uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
  if (ext) texture_view_ = reinterpret_cast<ViewFn>(eglGetProcAddress("glTextureViewEXT"));
  if (!texture_view_ && oes) texture_view_ = reinterpret_cast<ViewFn>(eglGetProcAddress("glTextureViewOES"));
  srgb_ = std::find(formats_.begin(), formats_.end(), kGlSRGB8Alpha8) != formats_.end();
  if (!texture_view_ || !srgb_) {
    log(LogLevel::kWarn, "xr: quad and cylinder layers use RGBA8 swapchains (%s): the compositor reads them as linear, "
        "so their colours look washed out", !texture_view_ ? "no GL texture views" : "no SRGB8_ALPHA8 swapchains");
  }
}

size_t CompositionLayers::live() const {
  size_t n = 0;
  for (const layers::SlotState& b : book_) n += b.live ? 1 : 0;
  return n;
}

void CompositionLayers::create(const LayerSwapchainRequest& req, LayerSwapchainAnswer* out) {
  if (session_ == XR_NULL_HANDLE) {
    out->error = "no OpenXR session";
    return;
  }
  if (req.kind == layers::kCylinder && !cylinder_) {
    out->error = "cylinder layers need XR_KHR_composition_layer_cylinder, which the runtime does not offer";
    return;
  }
  if (req.width == 0 || req.height == 0 || (max_w_ && req.width > max_w_) || (max_h_ && req.height > max_h_)) {
    out->error = "layer image " + std::to_string(req.width) + "x" + std::to_string(req.height) +
                 " is outside the system's swapchain limits (" + std::to_string(max_w_) + "x" +
                 std::to_string(max_h_) + ")";
    return;
  }
  uint32_t slot = layers::kMaxSwapchains;
  for (uint32_t i = 0; i < layers::kMaxSwapchains; ++i) {
    if (slots_[i].handle == XR_NULL_HANDLE) {
      slot = i;
      break;
    }
  }
  if (slot == layers::kMaxSwapchains) {
    out->error = "too many quad and cylinder layers (at most " + std::to_string(layers::kMaxSwapchains) + ")";
    return;
  }
  // A mono 'texture-array' layer is a one-layer TEXTURE_2D_ARRAY, which OpenXR does not hand out (an array size of 1
  // gives 2D images): it is drawn through array views of them.
  const bool array_views = req.texture_array && req.array_size < 2;
  if (array_views && texture_view_ == nullptr) {
    out->error = "a mono 'texture-array' layer needs GL texture views (EXT/OES_texture_view), which the GL lacks";
    return;
  }
  int64_t format = static_cast<int64_t>(req.format ? req.format : kGlRGBA8);
  if (std::find(formats_.begin(), formats_.end(), format) == formats_.end()) {
    log(LogLevel::kWarn, "xr: layer swapchain format 0x%" PRIx64 " unsupported; using RGBA8", format);
    format = kGlRGBA8;
  }
  // RGBA8 content is sRGB-encoded: an sRGB swapchain drawn through RGBA8 views (Colour, xr_layers.h)
  bool viewed = format == kGlRGBA8 && srgb_ && texture_view_ != nullptr;
  if (viewed) format = kGlSRGB8Alpha8;
  const GLenum view_target = req.texture_array || req.array_size >= 2 ? GL_TEXTURE_2D_ARRAY : GL_TEXTURE_2D;
  XrSwapchainCreateInfo ci{XR_TYPE_SWAPCHAIN_CREATE_INFO};
  ci.createFlags = req.is_static ? XR_SWAPCHAIN_CREATE_STATIC_IMAGE_BIT : 0;
  ci.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT | XR_SWAPCHAIN_USAGE_SAMPLED_BIT;
  ci.format = format;
  ci.sampleCount = 1;  // three's multisampled render-to-texture resolves into it (as for the projection layer)
  ci.width = req.width;
  ci.height = req.height;
  ci.faceCount = 1;
  ci.arraySize = req.array_size >= 2 ? 2 : 1;
  ci.mipCount = 1;  // XRCompositionLayer.mipLevels reports 1
  Swapchain& s = slots_[slot];
  XrResult r = xrCreateSwapchain(session_, &ci, &s.handle);
  if (XR_FAILED(r) && req.is_static) {
    // the static flag may be refused: an ordinary swapchain drawn once behaves the same
    ci.createFlags = 0;
    r = xrCreateSwapchain(session_, &ci, &s.handle);
  }
  if (XR_FAILED(r)) {
    s.handle = XR_NULL_HANDLE;
    out->error = "xrCreateSwapchain failed: " + std::to_string(r);
    return;
  }
  uint32_t count = 0;
  xrEnumerateSwapchainImages(s.handle, 0, &count, nullptr);
  std::vector<XrSwapchainImageOpenGLESKHR> imgs(count, {XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_ES_KHR});
  xrEnumerateSwapchainImages(s.handle, count, &count, reinterpret_cast<XrSwapchainImageBaseHeader*>(imgs.data()));
  s.w = req.width;
  s.h = req.height;
  s.array = ci.arraySize;
  s.images.clear();
  for (auto& i : imgs) s.images.push_back(i.image);
  s.views.clear();
  bool views_ok = !(viewed || array_views) || make_views(s, view_target, viewed ? GL_RGBA8 : static_cast<GLenum>(format));
  if (!views_ok && viewed) {
    // the runtime's images do not allow views: an RGBA8 swapchain (washed-out colours) rather than none
    log(LogLevel::kWarn, "xr: layer swapchain %u: no texture views of its images; RGBA8 instead", slot + 1);
    xrDestroySwapchain(s.handle);
    s.handle = XR_NULL_HANDLE;
    viewed = false;
    ci.format = format = kGlRGBA8;
    r = xrCreateSwapchain(session_, &ci, &s.handle);
    if (XR_FAILED(r)) {
      s.handle = XR_NULL_HANDLE;
      out->error = "xrCreateSwapchain failed: " + std::to_string(r);
      return;
    }
    count = 0;
    xrEnumerateSwapchainImages(s.handle, 0, &count, nullptr);
    imgs.assign(count, {XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_ES_KHR});
    xrEnumerateSwapchainImages(s.handle, count, &count, reinterpret_cast<XrSwapchainImageBaseHeader*>(imgs.data()));
    s.images.clear();
    for (auto& i : imgs) s.images.push_back(i.image);
    views_ok = !array_views || make_views(s, view_target, GL_RGBA8);
  }
  if (!views_ok) {
    xrDestroySwapchain(s.handle);
    s = Swapchain{};
    out->error = "no texture views of the layer swapchain's images (a mono 'texture-array' layer draws through them)";
    return;
  }
  layers::SlotState& b = book_[slot];
  b = layers::SlotState{};
  b.live = true;
  b.kind = req.kind;
  b.is_static = ci.createFlags != 0;
  s.srgb = viewed;
  s.acquired = false;
  s.redraws = 0;
  words_[layers::kNamesAt + slot] = 0;
  glFinish();  // the new textures are complete before the page's WebGL context uses them
  ++created_;
  ++version_;
  out->ok = true;
  out->id = slot + 1;
  out->width = s.w;
  out->height = s.h;
  out->array_size = s.array;
  log(LogLevel::kInfo, "xr: layer swapchain %u: %s %ux%u x%u format 0x%" PRIx64 ", %zu images%s%s", out->id,
      kind_name(b.kind), s.w, s.h, s.array, format, s.images.size(),
      s.views.empty() ? "" : viewed ? " (drawn through RGBA8 views)" : " (drawn through array views)",
      b.is_static ? ", static" : "");
}

bool CompositionLayers::make_views(Swapchain& s, uint32_t target, uint32_t format) {
  // the image's format class and levels, its layers as `target`: RGBA8 for sRGB images so the page's writes are not
  // encoded again; a 2D image may be viewed as a one-layer 2D array
  while (glGetError() != GL_NO_ERROR) {
  }
  for (uint32_t image : s.images) {
    GLuint view = 0;
    glGenTextures(1, &view);
    texture_view_(view, target, image, format, 0, 1, 0, s.array);
    s.views.push_back(view);
  }
  if (glGetError() == GL_NO_ERROR) return true;
  glDeleteTextures(static_cast<GLsizei>(s.views.size()), s.views.data());
  s.views.clear();
  return false;
}

bool CompositionLayers::acquire(uint32_t slot) {
  Swapchain& s = slots_[slot];
  layers::SlotState& b = book_[slot];
  if (!b.live || b.held || b.static_done) return b.held;
  XrResult r = XR_SUCCESS;
  if (!s.acquired) {
    XrSwapchainImageAcquireInfo ai{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};
    r = xrAcquireSwapchainImage(s.handle, &ai, &s.index);
    if (XR_FAILED(r)) {
      log(LogLevel::kWarn, "xr: layer swapchain %u: xrAcquireSwapchainImage: %d", slot + 1, r);
      return false;
    }
    s.acquired = true;
  }
  XrSwapchainImageWaitInfo wi{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO};
  wi.timeout = 100000000;  // 100 ms per try, 1 s at most: the compositor gives an image back within a frame or two
  for (int tries = 0; tries < 10; ++tries) {
    r = xrWaitSwapchainImage(s.handle, &wi);
    if (r != XR_TIMEOUT_EXPIRED) break;
  }
  if (r != XR_SUCCESS) {
    // the image stays acquired; the next attempt waits for it again
    log(LogLevel::kWarn, "xr: layer swapchain %u: xrWaitSwapchainImage: %d", slot + 1, r);
    return false;
  }
  b.held = true;
  words_[layers::kNamesAt + slot] = page_name(s);
  return true;
}

void CompositionLayers::acquire_pending() {
  for (uint32_t i = 0; i < layers::kMaxSwapchains; ++i) {
    if (book_[i].live && !book_[i].held) acquire(i);
  }
}

uint32_t CompositionLayers::acquire_now(uint32_t id) {
  if (id == 0 || id > layers::kMaxSwapchains) return 0;
  const uint32_t slot = id - 1;
  return acquire(slot) ? page_name(slots_[slot]) : 0;
}

void CompositionLayers::collect() {
  layers::Entry list[layers::kMaxEntries];
  const int n = words_ ? layers::read_entries(words_, list) : -1;
  bool had_content[layers::kMaxSwapchains];
  for (uint32_t i = 0; i < layers::kMaxSwapchains; ++i) had_content[i] = book_[i].released_once;
  // Redrawn layers get their image released, which makes it their content (the frame's GL work is fenced before
  // this); the plan is the listed layers that can be shown (layers::collect()).
  uint32_t release = 0;
  plan_count_ = layers::collect(list, n, book_, &release, plan_);
  has_list_ = n >= 0;
  for (uint32_t i = 0; i < layers::kMaxSwapchains; ++i) {
    if (!(release & (1u << i))) continue;
    Swapchain& s = slots_[i];
    XrSwapchainImageReleaseInfo ri{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO};
    const XrResult r = xrReleaseSwapchainImage(s.handle, &ri);
    if (XR_FAILED(r)) log(LogLevel::kWarn, "xr: layer swapchain %u: xrReleaseSwapchainImage: %d", i + 1, r);
    s.acquired = false;
    words_[layers::kNamesAt + i] = 0;
    if (!had_content[i]) {
      log(LogLevel::kInfo, "xr: layer swapchain %u: first content", i + 1);
      ++version_;
    }
    ++s.redraws;
  }
  flush();
}

void CompositionLayers::drop_from_plan(uint32_t id) {
  int k = 0;
  for (int i = 0; i < plan_count_; ++i) {
    if (plan_[i].kind == layers::kProjection || plan_[i].id != id) plan_[k++] = plan_[i];
  }
  plan_count_ = k;
}

void CompositionLayers::destroy_slot(uint32_t slot) {
  Swapchain& s = slots_[slot];
  if (!s.views.empty()) glDeleteTextures(static_cast<GLsizei>(s.views.size()), s.views.data());
  if (s.handle != XR_NULL_HANDLE) {
    xrDestroySwapchain(s.handle);
    ++destroyed_;
    ++version_;
    log(LogLevel::kInfo, "xr: layer swapchain %u destroyed (%" PRIu64 " redraws)", slot + 1, s.redraws);
  }
  s = Swapchain{};
  book_[slot] = layers::SlotState{};
  if (words_) words_[layers::kNamesAt + slot] = 0;
}

void CompositionLayers::destroy(uint32_t id, bool in_flight) {
  if (id == 0 || id > layers::kMaxSwapchains) return;
  const uint32_t slot = id - 1;
  if (slots_[slot].handle == XR_NULL_HANDLE) return;
  drop_from_plan(id);
  book_[slot].live = false;
  words_[layers::kNamesAt + slot] = 0;
  if (!in_flight) destroy_slot(slot);
}

void CompositionLayers::end_session(bool in_flight) {
  has_list_ = false;
  plan_count_ = 0;
  if (words_) words_[layers::kCountAt] = layers::kNoList;
  for (uint32_t i = 0; i < layers::kMaxSwapchains; ++i) {
    if (slots_[i].handle == XR_NULL_HANDLE) continue;
    book_[i].live = false;
    words_[layers::kNamesAt + i] = 0;
    if (!in_flight) destroy_slot(i);
  }
}

void CompositionLayers::flush() {
  for (uint32_t i = 0; i < layers::kMaxSwapchains; ++i) {
    if (doomed(i)) destroy_slot(i);
  }
}

void CompositionLayers::destroy_all() {
  has_list_ = false;
  plan_count_ = 0;
  for (uint32_t i = 0; i < layers::kMaxSwapchains; ++i) destroy_slot(i);
}

uint32_t CompositionLayers::append(XrSpace base, XrSpace view, const XrCompositionLayerBaseHeader* projection,
                                   const XrCompositionLayerBaseHeader** out, uint32_t max) {
  uint32_t n = 0, nq = 0, nc = 0, content = 0;
  for (int i = 0; i < plan_count_; ++i) {
    const layers::Entry& e = plan_[i];
    if (e.kind == layers::kProjection) {
      if (projection && n < max) out[n++] = projection;
      continue;
    }
    const Swapchain& s = slots_[e.id - 1];
    layers::EntryView views[2];
    const uint32_t count = layers::entry_views(e.layout, s.w, s.h, views);
    if (n + count > max) break;  // the compositor's layer limit: the rest of the list is left out
    const XrPosef pose = pose_of(e.pose);
    const XrSpace space = (e.flags & layers::kViewer) ? view : base;
    const XrCompositionLayerFlags flags =
        (e.flags & layers::kBlendAlpha) ? XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT : 0;
    for (uint32_t v = 0; v < count; ++v) {
      XrSwapchainSubImage sub{};
      sub.swapchain = s.handle;
      sub.imageRect = {{views[v].x, views[v].y}, {views[v].w, views[v].h}};
      sub.imageArrayIndex = views[v].array_index;
      if (e.kind == layers::kQuad) {
        XrCompositionLayerQuad& q = quads_[nq++];
        q = XrCompositionLayerQuad{XR_TYPE_COMPOSITION_LAYER_QUAD};
        q.layerFlags = flags;
        q.space = space;
        q.eyeVisibility = eye_visibility(views[v].eye);
        q.subImage = sub;
        q.pose = pose;
        q.size = {e.a, e.b};
        out[n++] = reinterpret_cast<const XrCompositionLayerBaseHeader*>(&q);
      } else {
        XrCompositionLayerCylinderKHR& c = cylinders_[nc++];
        c = XrCompositionLayerCylinderKHR{XR_TYPE_COMPOSITION_LAYER_CYLINDER_KHR};
        c.layerFlags = flags;
        c.space = space;
        c.eyeVisibility = eye_visibility(views[v].eye);
        c.subImage = sub;
        c.pose = pose;
        c.radius = e.a;
        c.centralAngle = e.b;
        c.aspectRatio = e.c;
        out[n++] = reinterpret_cast<const XrCompositionLayerBaseHeader*>(&c);
      }
    }
    ++content;
  }
  last_submitted_ = content;
  if (content > 0) ++frames_with_layers_;
  return n;
}

Json CompositionLayers::stats() const {
  Json j = Json::object();
  Json list = Json::array();
  for (uint32_t i = 0; i < layers::kMaxSwapchains; ++i) {
    const Swapchain& s = slots_[i];
    if (s.handle == XR_NULL_HANDLE) continue;
    Json o = Json::object();
    o.set("id", static_cast<int64_t>(i + 1));
    o.set("kind", kind_name(book_[i].kind));
    o.set("width", static_cast<int64_t>(s.w));
    o.set("height", static_cast<int64_t>(s.h));
    o.set("arraySize", static_cast<int64_t>(s.array));
    o.set("images", static_cast<int64_t>(s.images.size()));
    o.set("static", book_[i].is_static);
    o.set("srgbViews", s.srgb);
    o.set("content", book_[i].released_once);
    list.push(std::move(o));
  }
  j.set("swapchains", list);
  j.set("created", created_);
  j.set("destroyed", destroyed_);
  return j;
}

}  // namespace iwn::xr
