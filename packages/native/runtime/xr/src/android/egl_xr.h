// The XR thread's EGL context (Android). Created in the GL module's share group (runtime/gl: one display, a root
// ES 3.2 context owning the share group, one context per WebGL context), so the swapchain textures OpenXR creates
// for this context are GL names every WebGL context can use. This context is the one handed to xrCreateSession
// (XrGraphicsBindingOpenGLESAndroidKHR) and it is current on the XR thread only, which keeps OpenXR's rule for the
// session's graphics context: never bound on another thread while the frame/swapchain functions run.
//
// Cross-context ordering (GLES 3.0 shared sync objects): the JS thread ends a frame with glFenceSync + glFlush in
// the WebGL context that rendered; the XR thread makes its context wait for that fence (glWaitSync) before
// xrReleaseSwapchainImage, so whatever fence the runtime inserts at release/end is ordered after the app's
// rendering. Sources: EGL 1.5, EGL_KHR_surfaceless_context, OpenGL ES 3.0 §5.2 (sync objects), Appendix D (shared
// objects), OpenXR 1.1 XR_KHR_opengl_es_enable.
#pragma once

#include <EGL/egl.h>
#include <GLES3/gl3.h>

namespace iwn::xr {

class EglXrContext {
 public:
  // On the XR thread: creates the context sharing with `share` and makes it current (surfaceless when available,
  // else a 1x1 pbuffer). False (with an EGL error logged) on failure.
  bool create(EGLDisplay display, EGLConfig config, EGLContext share);
  // On the XR thread: releases and destroys the context.
  void destroy();
  bool valid() const { return context_ != EGL_NO_CONTEXT; }
  EGLDisplay display() const { return display_; }
  EGLConfig config() const { return config_; }
  EGLContext context() const { return context_; }

 private:
  EGLDisplay display_ = EGL_NO_DISPLAY;
  EGLConfig config_ = nullptr;
  EGLContext context_ = EGL_NO_CONTEXT;
  EGLSurface surface_ = EGL_NO_SURFACE;
};

// QCOM_texture_foveated state of `texture` (a live texture of `target`: TEXTURE_2D_ARRAY or TEXTURE_2D) as the
// calling thread's current context sees it (diagnostics). The binding of the active unit's `target` is restored.
// `own_context`: the context is the XR thread's own, so GL errors may be read and cleared. Otherwise (the page's
// WebGL context) glGetError is never called, since the WebGL binding reports that context's driver errors to the
// page later (GL-9), and nothing is queried unless the context offers GL_QCOM_texture_foveated, so every call made is
// one that cannot fail.
struct FoveationQuery {
  int feature_bits = -1;   // GL_TEXTURE_FOVEATED_FEATURE_BITS_QCOM
  int supported = -1;      // GL_TEXTURE_FOVEATED_FEATURE_QUERY_QCOM
  float min_density = -1;  // GL_TEXTURE_FOVEATED_MIN_PIXEL_DENSITY_QCOM
};
FoveationQuery query_foveation(GLuint texture, GLenum target, bool own_context);

// GL sync helpers (calls on the thread whose context should be fenced / should wait).
GLsync gl_fence_and_flush();
void gl_wait_and_delete(GLsync sync);

}  // namespace iwn::xr
