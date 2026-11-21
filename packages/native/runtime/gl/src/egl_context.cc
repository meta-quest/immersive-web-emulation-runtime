#include "egl_context.h"

#include <atomic>
#include <chrono>
#include <cstring>
#include <memory>
#include <thread>
#include <unordered_map>
#include <vector>

#include "../generated/gl_api.gen.h"
#include "blob_cache.h"
#include "log.h"
#include "stats.h"

#ifndef EGL_PLATFORM_SURFACELESS_MESA
#define EGL_PLATFORM_SURFACELESS_MESA 0x31DD
#endif
#ifndef EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT
#define EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT 0x30BF
#endif
#ifndef EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY_EXT
#define EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY_EXT 0x3138
#endif
#ifndef EGL_LOSE_CONTEXT_ON_RESET_EXT
#define EGL_LOSE_CONTEXT_ON_RESET_EXT 0x31BF
#endif
#ifndef EGL_NO_CONFIG_KHR
#define EGL_NO_CONFIG_KHR ((EGLConfig)0)
#endif

namespace iwn::gl {

namespace {

struct ContextEntry {
  EGLContext ctx;
  bool robust;
};

std::unordered_map<uint32_t, ContextEntry>& Contexts() {
  static std::unordered_map<uint32_t, ContextEntry> map;
  return map;
}
uint32_t g_next_id = 1;
std::unique_ptr<BlobCache> g_blob_cache;
std::thread g_flush_thread;
std::atomic<bool> g_flushing{false};
std::chrono::steady_clock::time_point g_last_flush{};

bool HasExt(const char* list, const char* name) {
  if (!list) return false;
  const size_t n = strlen(name);
  for (const char* p = list; (p = strstr(p, name)) != nullptr; p += n) {
    if ((p == list || p[-1] == ' ') && (p[n] == ' ' || p[n] == '\0')) return true;
  }
  return false;
}

typedef void (*SetBlobFn)(const void*, EGLsizeiANDROID, const void*, EGLsizeiANDROID);
typedef EGLsizeiANDROID (*GetBlobFn)(const void*, EGLsizeiANDROID, void*, EGLsizeiANDROID);
typedef void (*SetBlobCacheFuncsFn)(EGLDisplay, SetBlobFn, GetBlobFn);

void BlobSet(const void* k, EGLsizeiANDROID ks, const void* v, EGLsizeiANDROID vs) {
  BlobCache::EglSet(k, long(ks), v, long(vs));
}
EGLsizeiANDROID BlobGet(const void* k, EGLsizeiANDROID ks, void* v, EGLsizeiANDROID vs) {
  return EGLsizeiANDROID(BlobCache::EglGet(k, long(ks), v, long(vs)));
}

}  // namespace

EglEnvironment& EglEnvironment::Get() {
  static EglEnvironment env;
  return env;
}

bool EglEnvironment::Init(const EglInitOptions& options) {
  if (initialized()) return true;
  const char* clientExts = eglQueryString(EGL_NO_DISPLAY, EGL_EXTENSIONS);
  if (options.preferSurfacelessPlatform && HasExt(clientExts, "EGL_MESA_platform_surfaceless")) {
    auto getPlatformDisplay =
        reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(eglGetProcAddress("eglGetPlatformDisplayEXT"));
    if (getPlatformDisplay) display_ = getPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, nullptr);
  }
  if (display_ == EGL_NO_DISPLAY) display_ = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  if (display_ == EGL_NO_DISPLAY) return false;
  EGLint major = 0, minor = 0;
  if (!eglInitialize(display_, &major, &minor)) {
    IWN_GL_LOG_ERROR("eglInitialize failed: 0x%x", eglGetError());
    display_ = EGL_NO_DISPLAY;
    return false;
  }
  const char* exts = eglQueryString(display_, EGL_EXTENSIONS);
  surfaceless_ = HasExt(exts, "EGL_KHR_surfaceless_context");
  robust_available_ = HasExt(exts, "EGL_EXT_create_context_robustness");

  // GL-22: the blob cache must be installed before the first context is created on the display.
  const bool blobExt = HasExt(exts, "EGL_ANDROID_blob_cache");
  IWN_GL_LOG_INFO("blob cache: dir='%s' EGL_ANDROID_blob_cache=%d", options.shaderCacheDir.c_str(), blobExt ? 1 : 0);
  if (!options.shaderCacheDir.empty() && blobExt) {
    auto setFuncs = reinterpret_cast<SetBlobCacheFuncsFn>(eglGetProcAddress("eglSetBlobCacheFuncsANDROID"));
    if (setFuncs) {
      g_blob_cache = std::make_unique<BlobCache>(options.shaderCacheDir + "/iwn-gl-blobs.bin",
                                                 options.shaderCacheKey, options.shaderCacheMaxBytes);
      g_blob_cache->Load();
      BlobCache::SetGlobal(g_blob_cache.get());
      setFuncs(display_, BlobSet, BlobGet);
    }
  }

  eglBindAPI(EGL_OPENGL_ES_API);
  // A config is needed for a pbuffer (no surfaceless support) and by OpenXR's graphics binding.
  const EGLint cfgAttribs[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT_KHR,
                               EGL_SURFACE_TYPE,    EGL_PBUFFER_BIT,
                               EGL_RED_SIZE,        8,
                               EGL_GREEN_SIZE,      8,
                               EGL_BLUE_SIZE,       8,
                               EGL_ALPHA_SIZE,      8,
                               EGL_NONE};
  EGLint n = 0;
  if (!eglChooseConfig(display_, cfgAttribs, &config_, 1, &n) || n == 0) config_ = EGL_NO_CONFIG_KHR;
  if (config_ == EGL_NO_CONFIG_KHR && !HasExt(exts, "EGL_KHR_no_config_context")) {
    IWN_GL_LOG_ERROR("no ES3 EGL config");
    return false;
  }
  root_ = NewContext(EGL_NO_CONTEXT, options.robustAccess && robust_available_);
  if (root_ == EGL_NO_CONTEXT && options.robustAccess) root_ = NewContext(EGL_NO_CONTEXT, false);
  if (root_ == EGL_NO_CONTEXT) {
    IWN_GL_LOG_ERROR("cannot create the root ES 3.2 context: 0x%x", eglGetError());
    return false;
  }
  if (!surfaceless_ && config_ != EGL_NO_CONFIG_KHR) {
    const EGLint pb[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
    pbuffer_ = eglCreatePbufferSurface(display_, config_, pb);
  }
  IWN_GL_LOG_INFO("EGL %d.%d, surfaceless=%d robust=%d blobcache=%d", major, minor, surfaceless_ ? 1 : 0,
                  robust_available_ ? 1 : 0, g_blob_cache ? 1 : 0);
  return Bind(root_);
}

EGLContext EglEnvironment::NewContext(EGLContext share, bool robust) {
  std::vector<EGLint> attribs = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 2};
  if (robust) {
    attribs.insert(attribs.end(), {EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT, EGL_TRUE,
                                   EGL_CONTEXT_OPENGL_RESET_NOTIFICATION_STRATEGY_EXT, EGL_LOSE_CONTEXT_ON_RESET_EXT});
  }
  attribs.push_back(EGL_NONE);
  EGLContext ctx = eglCreateContext(display_, config_, share, attribs.data());
  if (ctx == EGL_NO_CONTEXT) {
    // ES 3.1/3.0 drivers: WebGL 2 needs ES 3.0.
    attribs[3] = 0;
    ctx = eglCreateContext(display_, config_, share, attribs.data());
  }
  return ctx;
}

bool EglEnvironment::Bind(EGLContext ctx) {
  Stats().contextSwitches++;
  EGLSurface s = surfaceless_ ? EGL_NO_SURFACE : pbuffer_;
  return eglMakeCurrent(display_, s, s, ctx) == EGL_TRUE;
}

bool EglEnvironment::MakeRootCurrent() {
  if (!initialized()) return false;
  current_ = 0;
  return Bind(root_);
}

uint32_t EglEnvironment::CreateContext(const WebGLContextOptions& options) {
  if (!initialized() && !Init(EglInitOptions{})) return 0;
  const bool robust = options.robustAccess && robust_available_;
  EGLContext ctx = NewContext(root_, robust);
  if (ctx == EGL_NO_CONTEXT) return 0;
  const uint32_t id = g_next_id++;
  Contexts()[id] = {ctx, robust};
  return id;
}

bool EglEnvironment::MakeCurrent(uint32_t id) {
  if (id == current_) return true;
  auto it = Contexts().find(id);
  if (it == Contexts().end()) return false;
  if (!Bind(it->second.ctx)) return false;
  current_ = id;
  return true;
}

void EglEnvironment::DestroyContext(uint32_t id) {
  auto it = Contexts().find(id);
  if (it == Contexts().end()) return;
  if (current_ == id) MakeRootCurrent();
  eglDestroyContext(display_, it->second.ctx);
  Contexts().erase(it);
}

std::vector<uint32_t> EglEnvironment::ContextIds() const {
  std::vector<uint32_t> ids;
  ids.reserve(Contexts().size());
  for (const auto& [id, e] : Contexts()) ids.push_back(id);
  return ids;
}

EGLContext EglEnvironment::Handle(uint32_t id) const {
  auto it = Contexts().find(id);
  return it == Contexts().end() ? EGL_NO_CONTEXT : it->second.ctx;
}

uint32_t EglEnvironment::ResetStatus(uint32_t id) {
  auto it = Contexts().find(id);
  if (it == Contexts().end() || !it->second.robust || !Api().GetGraphicsResetStatusEXT) return GL_NO_ERROR;
  if (!MakeCurrent(id)) return GL_NO_ERROR;
  return Api().GetGraphicsResetStatusEXT();
}

void EglEnvironment::Terminate() {
  FlushShaderCache();
  for (auto& [id, e] : Contexts()) eglDestroyContext(display_, e.ctx);
  Contexts().clear();
  if (display_ != EGL_NO_DISPLAY) {
    eglMakeCurrent(display_, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (pbuffer_ != EGL_NO_SURFACE) eglDestroySurface(display_, pbuffer_);
    if (root_ != EGL_NO_CONTEXT) eglDestroyContext(display_, root_);
    eglTerminate(display_);
  }
  BlobCache::SetGlobal(nullptr);
  g_blob_cache.reset();
  display_ = EGL_NO_DISPLAY;
  root_ = EGL_NO_CONTEXT;
  pbuffer_ = EGL_NO_SURFACE;
  current_ = 0;
}

bool FlushShaderCache() {
  if (g_flush_thread.joinable()) g_flush_thread.join();
  return g_blob_cache ? g_blob_cache->Flush() : true;
}

void MaybeFlushShaderCacheAsync() {
  if (!g_blob_cache || !g_blob_cache->dirty()) return;
  const auto now = std::chrono::steady_clock::now();
  if (now - g_last_flush < std::chrono::seconds(2)) return;
  if (g_flushing.load()) return;
  if (g_flush_thread.joinable()) g_flush_thread.join();
  g_last_flush = now;
  g_flushing = true;
  g_flush_thread = std::thread([] {
    g_blob_cache->Flush();
    g_flushing = false;
  });
}
const BlobCache* ShaderCache() { return g_blob_cache.get(); }

}  // namespace iwn::gl
