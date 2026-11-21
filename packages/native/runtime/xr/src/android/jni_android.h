// JavaVM / Activity lookup for the OpenXR loader and instance (XR_KHR_loader_init_android needs the VM and an
// android.content.Context; XR_KHR_android_create_instance needs the VM and the Activity).
//
// The app shell (runtime/app/src/android_main.cc) receives ANativeActivity but does not hand vm/clazz to
// native modules yet, so this module finds them itself: the VM through JNI_GetCreatedJavaVMs (libnativehelper,
// API 31+, else libart), the Activity through android.app.ActivityThread's activity records (unsupported/greylist
// SDK members, accessible to apps; the lookup logs which path worked), the Application context through
// ActivityThread.currentApplication() as the fallback. Proposed follow-up for the app shell: pass ANativeActivity::vm
// and a global ref of ANativeActivity::clazz to modules through the Runtime API, which makes this file trivial.
// Sources: JNI specification (Invocation API), Android NDK native_activity.h, Android SDK reference.
#pragma once

#include <jni.h>

#include <string>

namespace iwn::xr {

JavaVM* find_java_vm();
// Attaches the calling thread (with `name`) if it is not attached yet; nullptr without a VM.
JNIEnv* attach_current_thread(const char* name);
// Detaches the calling thread if attach_current_thread attached it.
void detach_current_thread();

struct AndroidContext {
  JavaVM* vm = nullptr;
  jobject activity = nullptr;     // global ref, may be null
  jobject application = nullptr;  // global ref, may be null
  std::string how;                // which lookup path found the activity (logged)
};

// Fills `out` with global refs (release with release_android_context). False when no Context was found at all.
bool find_android_context(JNIEnv* env, AndroidContext* out);
void release_android_context(JNIEnv* env, AndroidContext* ctx);

// The activity's launch intent extra `key` as a string ("true"/"false" for boolean extras); "" when absent.
std::string activity_intent_extra(JNIEnv* env, jobject activity, const char* key);

}  // namespace iwn::xr
