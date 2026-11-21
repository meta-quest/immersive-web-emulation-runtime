#include "android/egl_xr.h"

#include <EGL/eglext.h>

#include <cstring>

#include "iwn/core/log.h"

namespace iwn::xr {

namespace {
bool has_ext(const char* list, const char* name) {
  if (!list) return false;
  const size_t n = std::strlen(name);
  for (const char* p = list; (p = std::strstr(p, name)) != nullptr; p += n) {
    if ((p == list || p[-1] == ' ') && (p[n] == ' ' || p[n] == '\0')) return true;
  }
  return false;
}
}  // namespace

bool EglXrContext::create(EGLDisplay display, EGLConfig config, EGLContext share) {
  display_ = display;
  config_ = config;
  const EGLint attribs[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 2, EGL_NONE};
  context_ = eglCreateContext(display, config, share, attribs);
  if (context_ == EGL_NO_CONTEXT) {
    const EGLint es30[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 0, EGL_NONE};
    context_ = eglCreateContext(display, config, share, es30);
  }
  if (context_ == EGL_NO_CONTEXT) {
    log(LogLevel::kError, "xr: eglCreateContext for the XR thread failed: 0x%x", eglGetError());
    return false;
  }
  const char* exts = eglQueryString(display, EGL_EXTENSIONS);
  if (!has_ext(exts, "EGL_KHR_surfaceless_context") && config) {
    const EGLint pb[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
    surface_ = eglCreatePbufferSurface(display, config, pb);
  }
  if (!eglMakeCurrent(display, surface_, surface_, context_)) {
    log(LogLevel::kError, "xr: eglMakeCurrent (XR thread) failed: 0x%x", eglGetError());
    destroy();
    return false;
  }
  return true;
}

void EglXrContext::destroy() {
  if (display_ == EGL_NO_DISPLAY) return;
  eglMakeCurrent(display_, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
  if (surface_ != EGL_NO_SURFACE) eglDestroySurface(display_, surface_);
  if (context_ != EGL_NO_CONTEXT) eglDestroyContext(display_, context_);
  surface_ = EGL_NO_SURFACE;
  context_ = EGL_NO_CONTEXT;
}

FoveationQuery query_foveation(GLuint texture, GLenum target, bool own_context) {
  FoveationQuery q;
  if (!own_context &&
      !has_ext(reinterpret_cast<const char*>(glGetString(GL_EXTENSIONS)), "GL_QCOM_texture_foveated")) {
    return q;
  }
  GLint prev = 0;
  glGetIntegerv(target == GL_TEXTURE_2D_ARRAY ? GL_TEXTURE_BINDING_2D_ARRAY : GL_TEXTURE_BINDING_2D, &prev);
  glBindTexture(target, texture);
  if (own_context) {
    while (glGetError() != GL_NO_ERROR) {
    }
  }
  glGetTexParameteriv(target, 0x8BFB /* FEATURE_BITS */, &q.feature_bits);
  glGetTexParameteriv(target, 0x8BFD /* FEATURE_QUERY */, &q.supported);
  glGetTexParameterfv(target, 0x8BFC /* MIN_PIXEL_DENSITY */, &q.min_density);
  if (own_context && glGetError() != GL_NO_ERROR) q = FoveationQuery{};
  glBindTexture(target, static_cast<GLuint>(prev));
  return q;
}

GLsync gl_fence_and_flush() {
  GLsync s = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
  glFlush();  // the fence must reach the GPU before another context waits on it
  return s;
}

void gl_wait_and_delete(GLsync sync) {
  if (!sync) return;
  glWaitSync(sync, 0, GL_TIMEOUT_IGNORED);
  glDeleteSync(sync);  // deletion is deferred until the wait no longer uses it
}

}  // namespace iwn::xr
