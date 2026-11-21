#include "android/jni_android.h"

#include <dlfcn.h>

#include "iwn/core/log.h"

namespace iwn::xr {

namespace {

thread_local bool t_attached_here = false;

bool clear(JNIEnv* env) {
  if (env->ExceptionCheck()) {
    env->ExceptionClear();
    return true;
  }
  return false;
}

std::string to_string(JNIEnv* env, jstring s) {
  if (!s) return {};
  const char* c = env->GetStringUTFChars(s, nullptr);
  std::string out = c ? c : "";
  if (c) env->ReleaseStringUTFChars(s, c);
  return out;
}

}  // namespace

JavaVM* find_java_vm() {
  static JavaVM* vm = [] {
    using GetVMs = jint (*)(JavaVM**, jsize, jsize*);
    for (const char* lib : {"libnativehelper.so", "libart.so"}) {
      void* h = dlopen(lib, RTLD_NOW | RTLD_NOLOAD);
      if (!h) h = dlopen(lib, RTLD_NOW);
      auto fn = h ? reinterpret_cast<GetVMs>(dlsym(h, "JNI_GetCreatedJavaVMs")) : nullptr;
      JavaVM* found = nullptr;
      jsize n = 0;
      if (fn && fn(&found, 1, &n) == JNI_OK && n > 0) return found;
    }
    return static_cast<JavaVM*>(nullptr);
  }();
  return vm;
}

JNIEnv* attach_current_thread(const char* name) {
  JavaVM* vm = find_java_vm();
  if (!vm) return nullptr;
  JNIEnv* env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) == JNI_OK) return env;
  JavaVMAttachArgs args{JNI_VERSION_1_6, name, nullptr};
  if (vm->AttachCurrentThread(&env, &args) != JNI_OK) return nullptr;
  t_attached_here = true;
  return env;
}

void detach_current_thread() {
  if (!t_attached_here) return;
  if (JavaVM* vm = find_java_vm()) vm->DetachCurrentThread();
  t_attached_here = false;
}

bool find_android_context(JNIEnv* env, AndroidContext* out) {
  out->vm = find_java_vm();
  jclass at = env->FindClass("android/app/ActivityThread");
  if (!at || clear(env)) {
    log(LogLevel::kError, "xr: android.app.ActivityThread not found");
    return false;
  }
  jmethodID current_thread = env->GetStaticMethodID(at, "currentActivityThread", "()Landroid/app/ActivityThread;");
  jmethodID current_app = env->GetStaticMethodID(at, "currentApplication", "()Landroid/app/Application;");
  clear(env);
  jobject thread = current_thread ? env->CallStaticObjectMethod(at, current_thread) : nullptr;
  clear(env);
  jobject app = current_app ? env->CallStaticObjectMethod(at, current_app) : nullptr;
  clear(env);
  if (app) {
    out->application = env->NewGlobalRef(app);
    env->DeleteLocalRef(app);
  }
  // ActivityThread.mActivities: ArrayMap<IBinder, ActivityClientRecord>; the record's `activity` field.
  if (thread) {
    jfieldID f_activities = env->GetFieldID(at, "mActivities", "Landroid/util/ArrayMap;");
    if (clear(env)) f_activities = nullptr;
    jobject map = f_activities ? env->GetObjectField(thread, f_activities) : nullptr;
    clear(env);
    jclass record_cls = env->FindClass("android/app/ActivityThread$ActivityClientRecord");
    if (clear(env)) record_cls = nullptr;
    jfieldID f_activity = record_cls ? env->GetFieldID(record_cls, "activity", "Landroid/app/Activity;") : nullptr;
    if (clear(env)) f_activity = nullptr;
    if (map && f_activity) {
      jclass map_cls = env->GetObjectClass(map);
      jmethodID size = env->GetMethodID(map_cls, "size", "()I");
      jmethodID value_at = env->GetMethodID(map_cls, "valueAt", "(I)Ljava/lang/Object;");
      clear(env);
      jint n = size ? env->CallIntMethod(map, size) : 0;
      clear(env);
      for (jint i = 0; i < n && !out->activity && value_at; ++i) {
        jobject record = env->CallObjectMethod(map, value_at, i);
        if (clear(env) || !record) continue;
        jobject activity = env->GetObjectField(record, f_activity);
        clear(env);
        if (activity) {
          out->activity = env->NewGlobalRef(activity);
          out->how = "ActivityThread.mActivities";
          env->DeleteLocalRef(activity);
        }
        env->DeleteLocalRef(record);
      }
      env->DeleteLocalRef(map_cls);
    }
    if (map) env->DeleteLocalRef(map);
    if (record_cls) env->DeleteLocalRef(record_cls);
    env->DeleteLocalRef(thread);
  }
  env->DeleteLocalRef(at);
  if (!out->activity && out->application) out->how = "Application (no Activity record readable)";
  return out->activity || out->application;
}

void release_android_context(JNIEnv* env, AndroidContext* ctx) {
  if (!env) return;
  if (ctx->activity) env->DeleteGlobalRef(ctx->activity);
  if (ctx->application) env->DeleteGlobalRef(ctx->application);
  ctx->activity = nullptr;
  ctx->application = nullptr;
}

std::string activity_intent_extra(JNIEnv* env, jobject activity, const char* key) {
  if (!env || !activity) return {};
  jclass act_cls = env->GetObjectClass(activity);
  jmethodID get_intent = env->GetMethodID(act_cls, "getIntent", "()Landroid/content/Intent;");
  clear(env);
  jobject intent = get_intent ? env->CallObjectMethod(activity, get_intent) : nullptr;
  clear(env);
  env->DeleteLocalRef(act_cls);
  if (!intent) return {};
  std::string out;
  jclass cls = env->GetObjectClass(intent);
  jmethodID has = env->GetMethodID(cls, "hasExtra", "(Ljava/lang/String;)Z");
  jmethodID get_extras = env->GetMethodID(cls, "getExtras", "()Landroid/os/Bundle;");
  clear(env);
  jstring k = env->NewStringUTF(key);
  if (has && env->CallBooleanMethod(intent, has, k) && !clear(env) && get_extras) {
    jobject bundle = env->CallObjectMethod(intent, get_extras);
    clear(env);
    if (bundle) {
      jclass bcls = env->GetObjectClass(bundle);
      jmethodID get = env->GetMethodID(bcls, "get", "(Ljava/lang/String;)Ljava/lang/Object;");
      clear(env);
      jobject value = get ? env->CallObjectMethod(bundle, get, k) : nullptr;
      clear(env);
      if (value) {
        jclass ocls = env->FindClass("java/lang/Object");
        jmethodID to_str = env->GetMethodID(ocls, "toString", "()Ljava/lang/String;");
        auto s = static_cast<jstring>(env->CallObjectMethod(value, to_str));
        clear(env);
        out = to_string(env, s);
        if (s) env->DeleteLocalRef(s);
        env->DeleteLocalRef(ocls);
        env->DeleteLocalRef(value);
      }
      env->DeleteLocalRef(bcls);
      env->DeleteLocalRef(bundle);
    }
  }
  clear(env);
  env->DeleteLocalRef(k);
  env->DeleteLocalRef(cls);
  env->DeleteLocalRef(intent);
  return out;
}

}  // namespace iwn::xr
