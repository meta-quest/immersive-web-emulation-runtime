// Public interface of the GL module (runtime/gl) for the runtime core and the XR module.
//
//   iwn_register_gl(isolate, context, natives)   installs natives.gl (JS: globalThis.__iwn.gl), the generated
//                                                WebGL 2 natives (fast-API + slow paths). Initialises EGL with
//                                                defaults if iwn::gl::Init was not called first.
//   iwn::gl::Init(options)                       EGL display + root context + blob cache (call once at boot,
//                                                before OpenXR session creation).
//   iwn::gl::RootDisplay/Config/Context()        for XrGraphicsBindingOpenGLESAndroidKHR.
//   iwn::gl::ContextHandle(id)                   EGLContext of a WebGL context id (JS: ctx._id).
//   iwn::gl::FlushShaderCache()                  persist EGL_ANDROID_blob_cache contents (on pause).
#pragma once

#include <EGL/egl.h>

#include <cstdint>
#include <string>

namespace v8 {
class Isolate;
class Context;
class Object;
template <class T>
class Local;
}  // namespace v8

void iwn_register_gl(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);

namespace iwn::gl {

struct InitOptions {
  std::string shaderCacheDir;               // app cache dir; empty = no persistent shader cache
  uint64_t shaderCacheMaxBytes = 32ull << 20;
  std::string shaderCacheKey;               // e.g. ro.build.fingerprint + "|" + versionCode
  bool robustAccess = false;                // GL-11: decision pending (spec open question 4)
};

bool Init(const InitOptions& options);
EGLDisplay RootDisplay();
EGLConfig RootConfig();
EGLContext RootContext();
bool MakeRootCurrent();
EGLContext ContextHandle(uint32_t id);
bool FlushShaderCache();
void Shutdown();

}  // namespace iwn::gl
