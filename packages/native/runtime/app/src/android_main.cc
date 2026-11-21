/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The Android shell: a NativeActivity without android_native_app_glue (Android NDK native_activity.h). Activity
// callbacks run on the UI thread and only post inputs to the runtime's JS thread; nothing here ever waits on JS,
// so pausing in the debugger or a long task cannot cause an ANR (PROC-3). Lifecycle mapping: PROC-6, PROC-7.
#include <android/input.h>
#include <android/looper.h>
#include <android/native_activity.h>
#include <android/native_window.h>
#include <jni.h>
#include <sys/system_properties.h>
#include <unistd.h>

#include <atomic>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "apk_assets.h"
#include "iwn/core/clock.h"
#include "iwn/core/log.h"
#include "iwn/core/runtime_host.h"

namespace {

using iwn::LifecycleInput;
using iwn::LogLevel;

// Shared by the UI thread (onDestroy) and the JS thread (exit request): finish() is only called on a live activity.
// The mutex is held across ANativeActivity_finish (a short write to the activity's command pipe), and onDestroy
// takes it before the framework can free the activity, so the two cannot interleave.
struct ActivityGuard {
  std::mutex mu;
  bool destroyed = false;
};

struct AppState {
  ANativeActivity* activity = nullptr;
  std::unique_ptr<iwn::RuntimeHost> host;
  jobject asset_manager_ref = nullptr;
  std::shared_ptr<ActivityGuard> guard = std::make_shared<ActivityGuard>();
  AInputQueue* input_queue = nullptr;
};

// Runtimes whose activity is gone but whose JS thread may still be tearing down: kept alive, never freed.
std::mutex g_retired_mu;
std::vector<std::unique_ptr<iwn::RuntimeHost>>& retired() {
  static std::vector<std::unique_ptr<iwn::RuntimeHost>> v;
  return v;
}

std::string prop(const char* name) {
  // __system_property_read_callback handles values longer than PROP_VALUE_MAX (e.g. ro.build.fingerprint).
  std::string out;
  const prop_info* pi = __system_property_find(name);
  if (!pi) return out;
  __system_property_read_callback(
      pi, [](void* cookie, const char*, const char* value, uint32_t) { *static_cast<std::string*>(cookie) = value; },
      &out);
  return out;
}

// --- JNI helpers (UI thread; activity->env is attached) ----------------------------------------------------------

std::string jstring_to(JNIEnv* env, jstring s) {
  if (!s) return {};
  const char* c = env->GetStringUTFChars(s, nullptr);
  std::string out = c ? c : "";
  if (c) env->ReleaseStringUTFChars(s, c);
  return out;
}

bool clear_exception(JNIEnv* env) {
  if (env->ExceptionCheck()) {
    env->ExceptionClear();
    return true;
  }
  return false;
}

jobject call_object(JNIEnv* env, jobject obj, const char* name, const char* sig) {
  if (!obj) return nullptr;
  jclass cls = env->GetObjectClass(obj);
  jmethodID m = env->GetMethodID(cls, name, sig);
  env->DeleteLocalRef(cls);
  if (!m || clear_exception(env)) return nullptr;
  jobject r = env->CallObjectMethod(obj, m);
  if (clear_exception(env)) return nullptr;
  return r;
}

std::string file_path(JNIEnv* env, jobject file) {
  if (!file) return {};
  auto s = static_cast<jstring>(call_object(env, file, "getAbsolutePath", "()Ljava/lang/String;"));
  std::string out = jstring_to(env, s);
  if (s) env->DeleteLocalRef(s);
  return out;
}

struct IntentExtras {
  std::string v8_flags;
  std::string query;
  int inspect_brk = -1;
  int inspector = -1;
};

IntentExtras read_extras(JNIEnv* env, jobject activity) {
  IntentExtras out;
  jobject intent = call_object(env, activity, "getIntent", "()Landroid/content/Intent;");
  if (!intent) return out;
  jclass cls = env->GetObjectClass(intent);
  jmethodID has = env->GetMethodID(cls, "hasExtra", "(Ljava/lang/String;)Z");
  jmethodID get_str = env->GetMethodID(cls, "getStringExtra", "(Ljava/lang/String;)Ljava/lang/String;");
  jmethodID get_bool = env->GetMethodID(cls, "getBooleanExtra", "(Ljava/lang/String;Z)Z");
  clear_exception(env);
  auto has_extra = [&](const char* key) {
    jstring k = env->NewStringUTF(key);
    bool r = has && env->CallBooleanMethod(intent, has, k);
    clear_exception(env);
    env->DeleteLocalRef(k);
    return r;
  };
  auto bool_extra = [&](const char* key) -> int {
    if (!has_extra(key)) return -1;
    jstring k = env->NewStringUTF(key);
    bool r = get_bool && env->CallBooleanMethod(intent, get_bool, k, JNI_FALSE);
    clear_exception(env);
    env->DeleteLocalRef(k);
    return r ? 1 : 0;
  };
  if (has_extra("iwn.v8flags") && get_str) {
    jstring k = env->NewStringUTF("iwn.v8flags");
    auto v = static_cast<jstring>(env->CallObjectMethod(intent, get_str, k));
    clear_exception(env);
    out.v8_flags = jstring_to(env, v);
    if (v) env->DeleteLocalRef(v);
    env->DeleteLocalRef(k);
  }
  if (has_extra("iwn.query") && get_str) {
    jstring k = env->NewStringUTF("iwn.query");
    auto v = static_cast<jstring>(env->CallObjectMethod(intent, get_str, k));
    clear_exception(env);
    out.query = jstring_to(env, v);
    if (v) env->DeleteLocalRef(v);
    env->DeleteLocalRef(k);
  }
  out.inspect_brk = bool_extra("iwn.inspectBrk");
  out.inspector = bool_extra("iwn.inspector");
  env->DeleteLocalRef(cls);
  env->DeleteLocalRef(intent);
  return out;
}

void read_package(JNIEnv* env, jobject activity, iwn::RuntimeOptions& o) {
  auto pkg = static_cast<jstring>(call_object(env, activity, "getPackageName", "()Ljava/lang/String;"));
  o.package_name = jstring_to(env, pkg);
  jobject pm = call_object(env, activity, "getPackageManager", "()Landroid/content/pm/PackageManager;");
  if (pm && pkg) {
    jclass pm_cls = env->GetObjectClass(pm);
    jmethodID get_info =
        env->GetMethodID(pm_cls, "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;");
    jobject info = get_info ? env->CallObjectMethod(pm, get_info, pkg, 0) : nullptr;
    if (!clear_exception(env) && info) {
      jclass info_cls = env->GetObjectClass(info);
      jfieldID vn = env->GetFieldID(info_cls, "versionName", "Ljava/lang/String;");
      jmethodID lvc = env->GetMethodID(info_cls, "getLongVersionCode", "()J");
      clear_exception(env);
      if (vn) {
        auto s = static_cast<jstring>(env->GetObjectField(info, vn));
        o.version_name = jstring_to(env, s);
        if (s) env->DeleteLocalRef(s);
      }
      if (lvc) o.version_code = env->CallLongMethod(info, lvc);
      clear_exception(env);
      env->DeleteLocalRef(info_cls);
      env->DeleteLocalRef(info);
    }
    env->DeleteLocalRef(pm_cls);
  }
  jobject ai = call_object(env, activity, "getApplicationInfo", "()Landroid/content/pm/ApplicationInfo;");
  if (ai) {
    jclass ai_cls = env->GetObjectClass(ai);
    jfieldID flags = env->GetFieldID(ai_cls, "flags", "I");
    if (flags && !clear_exception(env)) o.debuggable = (env->GetIntField(ai, flags) & 2 /* FLAG_DEBUGGABLE */) != 0;
    env->DeleteLocalRef(ai_cls);
    env->DeleteLocalRef(ai);
  }
  if (pm) env->DeleteLocalRef(pm);
  if (pkg) env->DeleteLocalRef(pkg);
  // Locale: java.util.Locale.getDefault().toLanguageTag()
  jclass locale_cls = env->FindClass("java/util/Locale");
  if (locale_cls && !clear_exception(env)) {
    jmethodID get_default = env->GetStaticMethodID(locale_cls, "getDefault", "()Ljava/util/Locale;");
    jobject loc = get_default ? env->CallStaticObjectMethod(locale_cls, get_default) : nullptr;
    clear_exception(env);
    auto tag = static_cast<jstring>(call_object(env, loc, "toLanguageTag", "()Ljava/lang/String;"));
    std::string t = jstring_to(env, tag);
    if (!t.empty()) o.device.locale = t;
    if (tag) env->DeleteLocalRef(tag);
    if (loc) env->DeleteLocalRef(loc);
    env->DeleteLocalRef(locale_cls);
  }
  clear_exception(env);
}

// --- Window and input ---------------------------------------------------------------------------------------------

void paint_black(ANativeWindow* window) {
  // M1 shows no 2D content: fill the activity window with opaque black once. (XR presentation is M3.)
  ANativeWindow_setBuffersGeometry(window, 0, 0, WINDOW_FORMAT_RGBA_8888);
  ANativeWindow_Buffer buf;
  if (ANativeWindow_lock(window, &buf, nullptr) != 0) return;
  auto* row = static_cast<uint8_t*>(buf.bits);
  for (int y = 0; y < buf.height; ++y) {
    auto* px = reinterpret_cast<uint32_t*>(row);
    for (int x = 0; x < buf.width; ++x) px[x] = 0xFF000000u;
    row += buf.stride * 4;
  }
  ANativeWindow_unlockAndPost(window);
}

int on_input_events(int, int, void* data) {
  auto* queue = static_cast<AInputQueue*>(data);
  AInputEvent* event = nullptr;
  while (AInputQueue_getEvent(queue, &event) >= 0) {
    if (AInputQueue_preDispatchEvent(queue, event)) continue;
    AInputQueue_finishEvent(queue, event, 0);  // not handled: the system keeps its default behaviour
  }
  return 1;
}

AppState* state_of(ANativeActivity* a) { return static_cast<AppState*>(a->instance); }

void post(ANativeActivity* a, LifecycleInput in) {
  AppState* s = state_of(a);
  if (s && s->host) s->host->post_lifecycle(in);
}

void on_start(ANativeActivity* a) { post(a, LifecycleInput::kStart); }
void on_resume(ANativeActivity* a) { post(a, LifecycleInput::kResume); }
void on_pause(ANativeActivity* a) { post(a, LifecycleInput::kPause); }
void on_stop(ANativeActivity* a) { post(a, LifecycleInput::kStop); }
void on_focus(ANativeActivity* a, int has_focus) {
  post(a, has_focus ? LifecycleInput::kFocusGained : LifecycleInput::kFocusLost);
}
void on_low_memory(ANativeActivity* a) {
  AppState* s = state_of(a);
  if (s && s->host) s->host->post_low_memory();
}
void* on_save_state(ANativeActivity*, size_t* out_len) {
  *out_len = 0;
  return nullptr;
}
void on_window_created(ANativeActivity*, ANativeWindow* window) { paint_black(window); }
void on_window_redraw(ANativeActivity*, ANativeWindow* window) { paint_black(window); }
void on_input_created(ANativeActivity* a, AInputQueue* queue) {
  AppState* s = state_of(a);
  s->input_queue = queue;
  AInputQueue_attachLooper(queue, ALooper_forThread(), 1, on_input_events, queue);
}
void on_input_destroyed(ANativeActivity* a, AInputQueue* queue) {
  AInputQueue_detachLooper(queue);
  state_of(a)->input_queue = nullptr;
}

void on_destroy(ANativeActivity* a) {
  AppState* s = state_of(a);
  iwn::log(LogLevel::kInfo, "activity onDestroy");
  {
    std::lock_guard<std::mutex> lock(s->guard->mu);
    s->guard->destroyed = true;  // from here no finish() starts; one in progress has completed
  }
  if (s->host) {
    s->host->request_quit();  // pagehide + shutdown hooks + teardown on the JS thread; never waited on here
    // Give a quick teardown a moment so the next onCreate can bind the inspector port; never block > 100 ms.
    s->host->join(80);
    std::lock_guard<std::mutex> lock(g_retired_mu);
    retired().push_back(std::move(s->host));
  }
  // The AssetManager global ref stays: a still-running JS thread may read assets until it exits.
  a->instance = nullptr;
  delete s;
}

}  // namespace

extern "C" JNIEXPORT void ANativeActivity_onCreate(ANativeActivity* activity, void*, size_t) {
  iwn::init_clock();
  iwn::redirect_stdio_to_log();
  iwn::log(LogLevel::kInfo, "activity onCreate (sdk %d)", activity->sdkVersion);

  auto* state = new AppState();
  state->activity = activity;
  activity->instance = state;
  ANativeActivityCallbacks* cb = activity->callbacks;
  cb->onStart = on_start;
  cb->onResume = on_resume;
  cb->onPause = on_pause;
  cb->onStop = on_stop;
  cb->onDestroy = on_destroy;
  cb->onWindowFocusChanged = on_focus;
  cb->onLowMemory = on_low_memory;
  cb->onSaveInstanceState = on_save_state;
  cb->onNativeWindowCreated = on_window_created;
  cb->onNativeWindowRedrawNeeded = on_window_redraw;
  cb->onInputQueueCreated = on_input_created;
  cb->onInputQueueDestroyed = on_input_destroyed;

  JNIEnv* env = activity->env;
  iwn::RuntimeOptions o;
  // Keep the Java AssetManager alive for the process (the JS thread may outlive this activity).
  jobject am = call_object(env, activity->clazz, "getAssets", "()Landroid/content/res/AssetManager;");
  if (am) {
    state->asset_manager_ref = env->NewGlobalRef(am);
    env->DeleteLocalRef(am);
  }
  AAssetManager* mgr = state->asset_manager_ref ? AAssetManager_fromJava(env, state->asset_manager_ref)
                                                : activity->assetManager;
  o.assets = iwn::make_apk_asset_source(mgr);
  o.files_dir = activity->internalDataPath ? activity->internalDataPath : "";
  jobject cache = call_object(env, activity->clazz, "getCacheDir", "()Ljava/io/File;");
  o.cache_dir = file_path(env, cache);
  if (cache) env->DeleteLocalRef(cache);
  if (o.cache_dir.empty() && !o.files_dir.empty()) o.cache_dir = o.files_dir + "/../cache";
  read_package(env, activity->clazz, o);
  IntentExtras extras = read_extras(env, activity->clazz);
  o.extra_v8_flags = extras.v8_flags;
  o.extra_query = extras.query;
  o.inspect_brk = extras.inspect_brk;
  o.inspector = extras.inspector;
  o.device.model = prop("ro.product.model");
  o.device.manufacturer = prop("ro.product.manufacturer");
  o.device.fingerprint = prop("ro.build.fingerprint");
  o.device.android_release = prop("ro.build.version.release");
  o.device.sdk_int = activity->sdkVersion;
  o.device.cpu_count = static_cast<int>(sysconf(_SC_NPROCESSORS_CONF));
  long pages = sysconf(_SC_PHYS_PAGES), page = sysconf(_SC_PAGESIZE);
  if (pages > 0 && page > 0) o.device.memory_gib = static_cast<double>(pages) * page / (1024.0 * 1024 * 1024);
  std::shared_ptr<ActivityGuard> guard = state->guard;
  o.on_exit_requested = [activity, guard] {
    std::lock_guard<std::mutex> lock(guard->mu);
    if (!guard->destroyed) ANativeActivity_finish(activity);  // documented as callable from any thread
  };

  state->host = iwn::create_runtime_host(std::move(o));
  state->host->start();
}
