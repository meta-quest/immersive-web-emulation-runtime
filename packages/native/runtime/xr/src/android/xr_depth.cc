/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Environment depth (xr_depth.h). Written from the XR_META_environment_depth specification: provider and swapchain
// creation, xrStartEnvironmentDepthProviderMETA, xrAcquireEnvironmentDepthImageMETA
// (XR_ENVIRONMENT_DEPTH_NOT_AVAILABLE_META until the first image), hand removal, and teardown in reverse order.
#include "android/xr_depth.h"

#include <GLES3/gl3.h>

#include <cinttypes>
#include <cstdio>

#include "iwn/core/clock.h"
#include "iwn/core/log.h"

namespace iwn::xr {

namespace {

template <typename F>
void load_fn(XrInstance instance, const char* name, F* fn) {
  *fn = nullptr;
  xrGetInstanceProcAddr(instance, name, reinterpret_cast<PFN_xrVoidFunction*>(fn));
}

}  // namespace

const char* EnvironmentDepth::result(XrResult r) const {
  static thread_local char buf[XR_MAX_RESULT_STRING_SIZE];
  if (instance_ == XR_NULL_HANDLE || XR_FAILED(xrResultToString(instance_, r, buf))) {
    std::snprintf(buf, sizeof(buf), "XrResult(%d)", r);
  }
  return buf;
}

void EnvironmentDepth::load(XrInstance instance) {
  instance_ = instance;
  load_fn(instance, "xrCreateEnvironmentDepthProviderMETA", &create_provider_);
  load_fn(instance, "xrDestroyEnvironmentDepthProviderMETA", &destroy_provider_);
  load_fn(instance, "xrStartEnvironmentDepthProviderMETA", &start_provider_);
  load_fn(instance, "xrStopEnvironmentDepthProviderMETA", &stop_provider_);
  load_fn(instance, "xrCreateEnvironmentDepthSwapchainMETA", &create_swapchain_);
  load_fn(instance, "xrDestroyEnvironmentDepthSwapchainMETA", &destroy_swapchain_);
  load_fn(instance, "xrEnumerateEnvironmentDepthSwapchainImagesMETA", &enumerate_images_);
  load_fn(instance, "xrGetEnvironmentDepthSwapchainStateMETA", &get_swapchain_state_);
  load_fn(instance, "xrAcquireEnvironmentDepthImageMETA", &acquire_image_);
  load_fn(instance, "xrSetEnvironmentDepthHandRemovalMETA", &set_hand_removal_);
  loaded_ = create_provider_ && destroy_provider_ && start_provider_ && stop_provider_ && create_swapchain_ &&
            destroy_swapchain_ && enumerate_images_ && get_swapchain_state_ && acquire_image_;
}

void* EnvironmentDepth::chain_properties(void* next) {
  props_ = XrSystemEnvironmentDepthPropertiesMETA{XR_TYPE_SYSTEM_ENVIRONMENT_DEPTH_PROPERTIES_META};
  props_.next = next;
  return &props_;
}

bool EnvironmentDepth::start(XrSession session, bool hand_removal) {
  if (running_) return true;
  if (!supported() || session == XR_NULL_HANDLE) return false;
  const double t0 = now_ms();
  XrEnvironmentDepthProviderCreateInfoMETA pci{XR_TYPE_ENVIRONMENT_DEPTH_PROVIDER_CREATE_INFO_META};
  XrResult r = create_provider_(session, &pci, &provider_);
  if (XR_FAILED(r)) {
    provider_ = XR_NULL_HANDLE;
    log(LogLevel::kWarn, "xr: depth: xrCreateEnvironmentDepthProviderMETA: %s (the manifest needs "
        "com.oculus.permission.USE_SCENE, granted); 'depth-sensing' gets no data", result(r));
    return false;
  }
  XrEnvironmentDepthSwapchainCreateInfoMETA sci{XR_TYPE_ENVIRONMENT_DEPTH_SWAPCHAIN_CREATE_INFO_META};
  r = create_swapchain_(provider_, &sci, &swapchain_);
  XrEnvironmentDepthSwapchainStateMETA st{XR_TYPE_ENVIRONMENT_DEPTH_SWAPCHAIN_STATE_META};
  if (XR_SUCCEEDED(r)) r = get_swapchain_state_(swapchain_, &st);
  uint32_t count = 0;
  if (XR_SUCCEEDED(r)) r = enumerate_images_(swapchain_, 0, &count, nullptr);
  std::vector<XrSwapchainImageOpenGLESKHR> imgs(count, {XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_ES_KHR});
  if (XR_SUCCEEDED(r)) {
    r = enumerate_images_(swapchain_, count, &count, reinterpret_cast<XrSwapchainImageBaseHeader*>(imgs.data()));
  }
  if (XR_FAILED(r) || count == 0) {
    log(LogLevel::kWarn, "xr: depth: the depth swapchain could not be created: %s", result(r));
    stop();
    return false;
  }
  images_.clear();
  for (const auto& i : imgs) images_.push_back(i.image);
  width_ = st.width;
  height_ = st.height;
  // NEAREST: a depth texture sampled with compare mode NONE is incomplete with a LINEAR filter (GLES 3.0 §3.8.13), and
  // WebGL leaves external textures to the driver. The XR thread's context shares objects with the WebGL contexts; the
  // glFinish makes the state visible to them before the first frame uses it (as for the colour swapchain).
  GLint prev = 0;
  glGetIntegerv(GL_TEXTURE_BINDING_2D_ARRAY, &prev);
  for (uint32_t name : images_) {
    glBindTexture(GL_TEXTURE_2D_ARRAY, name);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_COMPARE_MODE, GL_NONE);
  }
  glBindTexture(GL_TEXTURE_2D_ARRAY, static_cast<GLuint>(prev));
  glFinish();
  hand_removal_ = false;
  if (hand_removal && hand_removal_supported() && set_hand_removal_) {
    XrEnvironmentDepthHandRemovalSetInfoMETA hi{XR_TYPE_ENVIRONMENT_DEPTH_HAND_REMOVAL_SET_INFO_META};
    hi.enabled = XR_TRUE;
    const XrResult hr = set_hand_removal_(provider_, &hi);
    hand_removal_ = XR_SUCCEEDED(hr);
    if (!hand_removal_) log(LogLevel::kWarn, "xr: depth: hand removal: %s", result(hr));
  }
  r = start_provider_(provider_);
  if (XR_FAILED(r)) {
    log(LogLevel::kWarn, "xr: depth: xrStartEnvironmentDepthProviderMETA: %s", result(r));
    stop();
    return false;
  }
  running_ = true;
  skip_acquire_ = true;
  first_logged_ = false;
  log(LogLevel::kInfo, "xr: depth: environment depth started in %.1f ms: %ux%u x2, %zu images, hand removal %s",
      now_ms() - t0, width_, height_, images_.size(),
      hand_removal_ ? "on" : (hand_removal_supported() ? "off" : "unavailable"));
  return true;
}

void EnvironmentDepth::stop() {
  if (provider_ != XR_NULL_HANDLE && running_) {
    const XrResult r = stop_provider_(provider_);
    if (XR_FAILED(r)) log(LogLevel::kWarn, "xr: depth: xrStopEnvironmentDepthProviderMETA: %s", result(r));
  }
  if (swapchain_ != XR_NULL_HANDLE) destroy_swapchain_(swapchain_);
  if (provider_ != XR_NULL_HANDLE) destroy_provider_(provider_);
  const bool was_running = running_;
  swapchain_ = XR_NULL_HANDLE;
  provider_ = XR_NULL_HANDLE;
  images_.clear();
  running_ = false;
  if (was_running) {
    log(LogLevel::kInfo, "xr: depth: environment depth stopped (%" PRIu64 " images, %" PRIu64 " frames without one)",
        acquired_, unavailable_);
  }
}

bool EnvironmentDepth::acquire(XrSpace space, XrTime time, double* record) {
  if (!running_ || skip_acquire_) {
    skip_acquire_ = false;
    clear_depth_record(record, 0);
    return false;
  }
  const double t0 = now_ms();
  XrEnvironmentDepthImageAcquireInfoMETA ai{XR_TYPE_ENVIRONMENT_DEPTH_IMAGE_ACQUIRE_INFO_META};
  ai.space = space;
  ai.displayTime = time;
  XrEnvironmentDepthImageMETA img{XR_TYPE_ENVIRONMENT_DEPTH_IMAGE_META};
  img.views[0].type = XR_TYPE_ENVIRONMENT_DEPTH_IMAGE_VIEW_META;
  img.views[1].type = XR_TYPE_ENVIRONMENT_DEPTH_IMAGE_VIEW_META;
  const XrResult r = acquire_image_(provider_, &ai, &img);
  const double ms = now_ms() - t0;
  acquire_ms_.add(ms);
  log_acquire_ms_.add(ms);
  if (r != XR_SUCCESS || img.swapchainIndex >= images_.size()) {
    if (r == XR_ENVIRONMENT_DEPTH_NOT_AVAILABLE_META) {
      ++unavailable_;
      ++log_unavailable_;
    } else {
      if (failed_++ < 5) log(LogLevel::kWarn, "xr: depth: xrAcquireEnvironmentDepthImageMETA: %s", result(r));
    }
    clear_depth_record(record, ms);
    return false;
  }
  image_.texture = images_[img.swapchainIndex];
  image_.width = width_;
  image_.height = height_;
  image_.near_z = img.nearZ;
  image_.far_z = img.farZ;
  for (int v = 0; v < 2; ++v) {
    image_.pose[v] = img.views[v].pose;
    image_.fov[v] = img.views[v].fov;
  }
  write_depth_record(record, image_, ms);
  ++acquired_;
  ++log_acquired_;
  if (!first_logged_) {
    first_logged_ = true;
    log(LogLevel::kInfo, "xr: depth: first image after %" PRIu64 " frames without one: near %.3f far %g m, image %u",
        unavailable_, static_cast<double>(img.nearZ), static_cast<double>(img.farZ), image_.texture);
  }
  return true;
}

EnvironmentDepth::Stats EnvironmentDepth::stats() const {
  Stats s;
  s.supported = supported();
  s.running = running_;
  s.hand_removal = hand_removal_;
  s.width = width_;
  s.height = height_;
  s.images = static_cast<uint32_t>(images_.size());
  s.acquired = acquired_;
  s.unavailable = unavailable_;
  s.failed = failed_;
  s.acquire_ms = acquire_ms_.mean();
  s.acquire_max_ms = acquire_ms_.max();
  return s;
}

Json EnvironmentDepth::stats_json(const Stats& s) {
  Json j = Json::object();
  j.set("supported", s.supported);
  j.set("running", s.running);
  j.set("width", static_cast<int64_t>(s.width));
  j.set("height", static_cast<int64_t>(s.height));
  j.set("images", static_cast<int64_t>(s.images));
  j.set("handRemoval", s.hand_removal);
  j.set("acquired", s.acquired);
  j.set("unavailable", s.unavailable);
  j.set("failed", s.failed);
  j.set("acquireMs", s.acquire_ms);  // mean over the whole run
  j.set("acquireMaxMs", s.acquire_max_ms);
  return j;
}

void EnvironmentDepth::log_window(double window_ms) {
  if (running_ && window_ms > 0 && log_acquire_ms_.count() > 0) {
    log(LogLevel::kInfo, "xr-depth images=%" PRIu64 " unavailable=%" PRIu64 " acquireMs=%.3f acquireMaxMs=%.3f",
        log_acquired_, log_unavailable_, log_acquire_ms_.mean(), log_acquire_ms_.max());
  }
  log_acquired_ = 0;
  log_unavailable_ = 0;
  log_acquire_ms_.reset();
}

}  // namespace iwn::xr
