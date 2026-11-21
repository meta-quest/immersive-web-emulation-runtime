// EGL environment for the WebGL binding: one display, one root ES 3.2 context that owns the share group
// (the OpenXR session is created with it: XrGraphicsBindingOpenGLESAndroidKHR takes Display(), Config(),
// RootContext()), and one context per WebGL context, created in the root's share group so swapchain
// textures created for the session are usable from whichever WebGL context the app hands to WebXR.
// WebGL objects stay per-context in JS (GL-5, C2D-2); only GL names share a namespace.
//
// Thread: all calls on the JS thread. Sources: EGL 1.5, EGL_KHR_create_context, EGL_KHR_no_config_context,
// EGL_KHR_surfaceless_context, EGL_EXT_create_context_robustness, EGL_ANDROID_blob_cache.
#pragma once

#include <vector>

#include <EGL/egl.h>
#include <EGL/eglext.h>

#include <cstdint>
#include <string>

namespace iwn::gl {

struct EglInitOptions {
  // EGL_ANDROID_blob_cache (GL-22). Empty dir: no persistent cache.
  std::string shaderCacheDir;
  uint64_t shaderCacheMaxBytes = 32ull << 20;
  // Invalidation key: driver/OS build fingerprint + APK version code (GL-22). Mixed into the cache file.
  std::string shaderCacheKey;
  // Prefer a robust-access context (GL-11) when the driver offers it.
  bool robustAccess = false;
  // Host tests: use EGL_PLATFORM_SURFACELESS_MESA when available.
  bool preferSurfacelessPlatform = true;
};

struct WebGLContextOptions {
  bool robustAccess = false;
};

// Context attribute keys accepted by the `contextCreate` native (Int32Array of key/value pairs).
enum ContextAttrib : int32_t {
  kAttribEnd = 0,
  kAttribRobustAccess = 1,
};

class EglEnvironment {
 public:
  static EglEnvironment& Get();

  // Idempotent. Returns false if no ES 3.x context can be created.
  bool Init(const EglInitOptions& options);
  bool initialized() const { return display_ != EGL_NO_DISPLAY && root_ != EGL_NO_CONTEXT; }

  EGLDisplay display() const { return display_; }
  EGLConfig config() const { return config_; }
  EGLContext rootContext() const { return root_; }
  bool robustAvailable() const { return robust_available_; }

  // Make the root context current (OpenXR setup, frame-end work outside any WebGL context).
  bool MakeRootCurrent();

  // WebGL contexts. Ids start at 1; 0 = failure / none.
  uint32_t CreateContext(const WebGLContextOptions& options);
  bool MakeCurrent(uint32_t id);
  void DestroyContext(uint32_t id);
  // Ids of the live WebGL contexts (not the root).
  std::vector<uint32_t> ContextIds() const;
  EGLContext Handle(uint32_t id) const;
  uint32_t current() const { return current_; }
  // GL_NO_ERROR, or the reset status the driver reported for this context (robust contexts only).
  uint32_t ResetStatus(uint32_t id);

  void Terminate();

 private:
  EGLContext NewContext(EGLContext share, bool robust);
  bool Bind(EGLContext ctx);

  EGLDisplay display_ = EGL_NO_DISPLAY;
  EGLConfig config_ = nullptr;
  EGLContext root_ = EGL_NO_CONTEXT;
  EGLSurface pbuffer_ = EGL_NO_SURFACE;  // only when surfaceless contexts are unavailable
  bool robust_available_ = false;
  bool surfaceless_ = false;
  uint32_t current_ = 0;
};

class BlobCache;
// Writes the shader blob cache if it changed (call on pause / a few seconds after the first XR frame).
bool FlushShaderCache();
// Writes a changed cache on a background thread, at most every 2 s (called after program links).
void MaybeFlushShaderCacheAsync();
const BlobCache* ShaderCache();

}  // namespace iwn::gl
