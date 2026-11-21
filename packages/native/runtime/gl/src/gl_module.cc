/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Registration of the GL natives on the per-context natives object, and the public C++ interface.

#include <dlfcn.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <fstream>
#include <string>
#if defined(__ANDROID__)
#include <sys/system_properties.h>
#endif
#include <v8-function.h>
#include <v8-template.h>

#include "../generated/gl_api.gen.h"
#include "../include/iwn/gl.h"
#include "composites.h"
#include "egl_context.h"
#include "log.h"
#include "v8_support.h"
#if defined(IWN_GL_HAVE_CORE_RUNTIME)
#include "iwn/core/runtime.h"
#endif

namespace iwn::gl {
namespace gen {
extern const NativeDesc kNatives[];
extern const int kNativeCount;
}  // namespace gen

namespace {

void* GetProc(const char* name, void* user) {
  void* lib = user;
  void* p = lib ? dlsym(lib, name) : nullptr;
  if (!p) p = reinterpret_cast<void*>(eglGetProcAddress(name));
  return p;
}

bool g_api_loaded = false;

#if defined(__ANDROID__)
std::string ReadFile(const char* path) {
  std::ifstream f(path, std::ios::binary);
  return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

// Defaults when the runtime did not call iwn::gl::Init: the app's cache directory from the process name, and an
// invalidation key from the OS build fingerprint + the installed APK (path, size, mtime change on every update).
InitOptions AndroidDefaults() {
  InitOptions o;
  std::string pkg = ReadFile("/proc/self/cmdline");
  pkg = pkg.substr(0, pkg.find('\0'));
  if (pkg.find(':') != std::string::npos) pkg = pkg.substr(0, pkg.find(':'));
  for (const std::string dir : {"/data/user/0/" + pkg + "/cache", "/data/data/" + pkg + "/cache"}) {
    if (!pkg.empty() && access(dir.c_str(), W_OK) == 0) {
      o.shaderCacheDir = dir;
      break;
    }
  }
  char fp[PROP_VALUE_MAX] = {};
  __system_property_get("ro.build.fingerprint", fp);
  std::string apk;
  std::ifstream maps("/proc/self/maps");
  for (std::string line; std::getline(maps, line);) {
    const size_t at = line.find('/');
    if (at != std::string::npos && line.size() > 9 && line.compare(line.size() - 9, 9, "/base.apk") == 0) {
      apk = line.substr(at);
      break;
    }
  }
  struct stat st {};
  if (!apk.empty()) stat(apk.c_str(), &st);
  o.shaderCacheKey = std::string(fp) + "|" + apk + "|" + std::to_string(st.st_size) + "|" + std::to_string(st.st_mtime);
  return o;
}
#endif

bool EnsureApi() {
  if (g_api_loaded) return true;
#if defined(__ANDROID__)
  void* lib = dlopen("libGLESv3.so", RTLD_NOW | RTLD_LOCAL);
  if (!lib) lib = dlopen("libGLESv2.so", RTLD_NOW | RTLD_LOCAL);
#else
  void* lib = dlopen("libGLESv2.so.2", RTLD_NOW | RTLD_LOCAL);
  if (!lib) lib = dlopen("libGLESv2.so", RTLD_NOW | RTLD_LOCAL);
#endif
  const int missing = LoadGlApi(&Api(), GetProc, lib);
  if (missing) IWN_GL_LOG_WARN("%d core GLES entry points missing", missing);
  g_api_loaded = true;
  return true;
}

#if defined(IWN_GL_HAVE_CORE_RUNTIME)
// DBG-6: the debug endpoint's info{} and the boot line name the GL renderer. Read once per process, from the root
// context, when the first page registers the module (no WebGL context exists yet, so rebinding the root is free).
void ReportRenderer(v8::Isolate* isolate) {
  static bool reported = false;
  iwn::Runtime* rt = iwn::Runtime::From(isolate);
  if (reported || !rt || !Api().GetString || !EglEnvironment::Get().MakeRootCurrent()) return;
  const GLubyte* renderer = Api().GetString(GL_RENDERER);
  const GLubyte* version = Api().GetString(GL_VERSION);
  if (!renderer || !*renderer) return;
  rt->set_info_field("glRenderer", reinterpret_cast<const char*>(renderer));
  if (version) rt->set_info_field("glVersion", reinterpret_cast<const char*>(version));
  reported = true;
}
#endif

}  // namespace

bool Init(const InitOptions& options) {
  EglInitOptions e;
  e.shaderCacheDir = options.shaderCacheDir;
  e.shaderCacheMaxBytes = options.shaderCacheMaxBytes;
  e.shaderCacheKey = options.shaderCacheKey;
  e.robustAccess = options.robustAccess;
  if (!EglEnvironment::Get().Init(e)) return false;
  return EnsureApi();
}

EGLDisplay RootDisplay() { return EglEnvironment::Get().display(); }
EGLConfig RootConfig() { return EglEnvironment::Get().config(); }
EGLContext RootContext() { return EglEnvironment::Get().rootContext(); }
bool MakeRootCurrent() { return EglEnvironment::Get().MakeRootCurrent(); }
EGLContext ContextHandle(uint32_t id) { return EglEnvironment::Get().Handle(id); }
void Shutdown() { EglEnvironment::Get().Terminate(); }

}  // namespace iwn::gl

void iwn_register_gl(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  using namespace iwn::gl;
#if defined(__ANDROID__)
  if (!EglEnvironment::Get().initialized()) Init(AndroidDefaults());
#else
  if (!EglEnvironment::Get().initialized()) Init(InitOptions{});
#endif
  EnsureApi();
  // The module is registered once per page context (workers exclude it: one GL thread). A new registration
  // means the previous page is gone (location.reload, PROC-8): free its WebGL contexts and their objects.
  if (const size_t n = DestroyAllWebGLContexts()) IWN_GL_LOG_INFO("page reload: destroyed %zu WebGL context(s)", n);
#if defined(IWN_GL_HAVE_CORE_RUNTIME)
  ReportRenderer(isolate);
#endif
  v8::Local<v8::Object> gl = v8::Object::New(isolate);
  for (int i = 0; i < gen::kNativeCount; ++i) {
    const NativeDesc& d = gen::kNatives[i];
    v8::Local<v8::FunctionTemplate> t = v8::FunctionTemplate::New(
        isolate, d.slow, v8::Local<v8::Value>(), v8::Local<v8::Signature>(), d.length,
        v8::ConstructorBehavior::kThrow, v8::SideEffectType::kHasSideEffect, d.fast);
    v8::Local<v8::Function> fn = t->GetFunction(ctx).ToLocalChecked();
    v8::Local<v8::String> name = v8::String::NewFromUtf8(isolate, d.name).ToLocalChecked();
    fn->SetName(name);
    gl->Set(ctx, name, fn).Check();
  }
  gl->Set(ctx, v8::String::NewFromUtf8Literal(isolate, "statsFields"), v8::Integer::New(isolate, kGlStatsFields))
      .Check();
  natives->Set(ctx, v8::String::NewFromUtf8Literal(isolate, "gl"), gl).Check();
}
