/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "android/xr_permissions.h"

#include <jni.h>

#include <algorithm>
#include <chrono>

#include "android/jni_android.h"
#include "iwn/core/clock.h"
#include "iwn/core/log.h"
#include "iwn/xr/permission_wait.h"

namespace iwn::xr {

namespace {

constexpr jint kPermissionGranted = 0;  // PackageManager.PERMISSION_GRANTED
constexpr jint kRequestCode = 0x1e7a;   // ours alone: nothing reads the result
constexpr auto kPollInterval = std::chrono::milliseconds(150);

bool clear(JNIEnv* env) {
  if (env->ExceptionCheck()) {
    env->ExceptionClear();
    return true;
  }
  return false;
}

std::vector<bool> check_with(JNIEnv* env, jobject context, const std::vector<std::string>& names) {
  std::vector<bool> out(names.size(), false);
  if (!env || !context) return out;
  jclass cls = env->GetObjectClass(context);
  jmethodID check = env->GetMethodID(cls, "checkSelfPermission", "(Ljava/lang/String;)I");
  if (clear(env)) check = nullptr;
  for (size_t i = 0; i < names.size() && check; ++i) {
    jstring name = env->NewStringUTF(names[i].c_str());
    const jint r = env->CallIntMethod(context, check, name);
    out[i] = !clear(env) && r == kPermissionGranted;
    env->DeleteLocalRef(name);
  }
  env->DeleteLocalRef(cls);
  return out;
}

// Activity.requestPermissions(String[], int) (API 23). It only starts the system's permission activity, so a thread
// other than the UI thread may call it.
bool ask(JNIEnv* env, jobject activity, const std::vector<std::string>& names) {
  jclass string_cls = env->FindClass("java/lang/String");
  if (clear(env) || !string_cls) return false;
  jobjectArray arr = env->NewObjectArray(static_cast<jsize>(names.size()), string_cls, nullptr);
  bool ok = arr && !clear(env);
  for (size_t i = 0; ok && i < names.size(); ++i) {
    jstring name = env->NewStringUTF(names[i].c_str());
    env->SetObjectArrayElement(arr, static_cast<jsize>(i), name);
    env->DeleteLocalRef(name);
    ok = !clear(env);
  }
  if (ok) {
    jclass cls = env->GetObjectClass(activity);
    jmethodID request = env->GetMethodID(cls, "requestPermissions", "([Ljava/lang/String;I)V");
    ok = !clear(env) && request;
    if (ok) {
      env->CallVoidMethod(activity, request, arr, kRequestCode);
      ok = !clear(env);
    }
    env->DeleteLocalRef(cls);
  }
  if (arr) env->DeleteLocalRef(arr);
  env->DeleteLocalRef(string_cls);
  return ok;
}

std::string join(const std::vector<std::string>& names, const std::vector<bool>* held = nullptr) {
  std::string out;
  for (size_t i = 0; i < names.size(); ++i) {
    if (!out.empty()) out += ", ";
    out += names[i];
    if (held) out += (*held)[i] ? " granted" : " denied";
  }
  return out;
}

const char* state_name(PermissionWait::State s) {
  switch (s) {
    case PermissionWait::State::kGranted: return "all granted";
    case PermissionWait::State::kAnswered: return "dialog answered";
    case PermissionWait::State::kNoDialog: return "no dialog shown";
    case PermissionWait::State::kWaiting: break;
  }
  return "stopped";
}

// context.getPackageManager().getPackageInfo(context.getPackageName(), GET_PERMISSIONS).requestedPermissions; false
// when it cannot be read.
bool read_declared(JNIEnv* env, jobject context, std::set<std::string>* out) {
  constexpr jint kGetPermissions = 0x00001000;  // PackageManager.GET_PERMISSIONS
  jclass cls = env->GetObjectClass(context);
  jmethodID get_pm = env->GetMethodID(cls, "getPackageManager", "()Landroid/content/pm/PackageManager;");
  jmethodID get_name = env->GetMethodID(cls, "getPackageName", "()Ljava/lang/String;");
  env->DeleteLocalRef(cls);
  if (clear(env) || !get_pm || !get_name) return false;
  jobject pm = env->CallObjectMethod(context, get_pm);
  jobject pkg = clear(env) ? nullptr : env->CallObjectMethod(context, get_name);
  bool ok = false;
  if (!clear(env) && pm && pkg) {
    jclass pm_cls = env->GetObjectClass(pm);
    jmethodID get_info =
        env->GetMethodID(pm_cls, "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;");
    env->DeleteLocalRef(pm_cls);
    jobject info = clear(env) || !get_info ? nullptr : env->CallObjectMethod(pm, get_info, pkg, kGetPermissions);
    if (!clear(env) && info) {
      jclass info_cls = env->GetObjectClass(info);
      jfieldID field = env->GetFieldID(info_cls, "requestedPermissions", "[Ljava/lang/String;");
      env->DeleteLocalRef(info_cls);
      auto arr = clear(env) || !field ? nullptr : static_cast<jobjectArray>(env->GetObjectField(info, field));
      ok = !clear(env);
      const jsize n = arr ? env->GetArrayLength(arr) : 0;
      for (jsize i = 0; ok && i < n; ++i) {
        auto name = static_cast<jstring>(env->GetObjectArrayElement(arr, i));
        if (clear(env)) {
          ok = false;
        } else if (name) {
          const char* chars = env->GetStringUTFChars(name, nullptr);
          if (chars) out->insert(chars);
          if (chars) env->ReleaseStringUTFChars(name, chars);
          env->DeleteLocalRef(name);
        }
      }
      if (arr) env->DeleteLocalRef(arr);
      env->DeleteLocalRef(info);
    }
  }
  if (pm) env->DeleteLocalRef(pm);
  if (pkg) env->DeleteLocalRef(pkg);
  return ok;
}

}  // namespace

PermissionBroker& PermissionBroker::get() {
  static PermissionBroker* b = new PermissionBroker();
  return *b;
}

std::vector<bool> PermissionBroker::check(const std::vector<std::string>& names) {
  JNIEnv* env = attach_current_thread("iwn-perm");
  std::vector<bool> out(names.size(), false);
  if (env) {
    AndroidContext ctx;
    if (find_android_context(env, &ctx)) out = check_with(env, ctx.activity ? ctx.activity : ctx.application, names);
    release_android_context(env, &ctx);
  }
  detach_current_thread();  // only if this call attached it
  return out;
}

std::shared_ptr<const std::set<std::string>> PermissionBroker::declared() {
  std::lock_guard<std::mutex> lock(declared_mu_);
  if (declared_read_) return declared_;
  declared_read_ = true;
  JNIEnv* env = attach_current_thread("iwn-perm");
  if (env) {
    AndroidContext ctx;
    auto names = std::make_shared<std::set<std::string>>();
    if (find_android_context(env, &ctx) && read_declared(env, ctx.activity ? ctx.activity : ctx.application, names.get())) {
      declared_ = std::move(names);
    } else {
      log(LogLevel::kWarn, "xr: permissions: the manifest's permissions could not be read; every one counts as declared");
    }
    release_android_context(env, &ctx);
  }
  detach_current_thread();
  return declared_;
}

bool PermissionBroker::request(std::vector<std::string> names, std::function<bool()> focused,
                               std::function<void(std::vector<bool>)> done) {
  std::lock_guard<std::mutex> lock(mu_);
  if (stopped_) return false;
  callbacks_[queue_.push(std::move(names))] = Callbacks{std::move(focused), std::move(done)};
  // one worker for the process, started on first use: it keeps one request in flight (permission_queue.h)
  if (!worker_.joinable()) worker_ = std::thread([this] { work(); });
  cv_.notify_all();
  return true;
}

void PermissionBroker::work() {
  JNIEnv* env = attach_current_thread("iwn-perm");
  for (;;) {
    std::vector<std::string> names;
    std::function<bool()> focused;
    {
      std::unique_lock<std::mutex> lock(mu_);
      while (!quit_ && !queue_.pending()) cv_.wait(lock);
      if (quit_) break;
      queue_.begin(&names);
      focused = callbacks_.begin()->second.focused;  // every caller passes the XR system's focus
    }
    const std::vector<bool> held = run_batch(env, names, focused);
    std::vector<std::pair<std::function<void(std::vector<bool>)>, std::vector<bool>>> answers;
    {
      std::lock_guard<std::mutex> lock(mu_);
      for (auto& [ticket, states] : queue_.finish(names, held)) {
        answers.emplace_back(std::move(callbacks_[ticket].done), std::move(states));
        callbacks_.erase(ticket);
      }
    }
    for (auto& [done, states] : answers) done(std::move(states));
  }
  detach_current_thread();
}

std::vector<bool> PermissionBroker::run_batch(JNIEnv* env, const std::vector<std::string>& names,
                                              const std::function<bool()>& focused) {
  AndroidContext ctx;
  const bool have_context = env && find_android_context(env, &ctx);
  jobject context = ctx.activity ? ctx.activity : ctx.application;
  std::vector<bool> held = have_context ? check_with(env, context, names) : std::vector<bool>(names.size(), false);
  std::vector<std::string> missing;
  for (size_t i = 0; i < names.size(); ++i) {
    if (!held[i]) missing.push_back(names[i]);
  }
  const auto manifest = declared();
  std::vector<std::string> ask_for;
  {
    std::lock_guard<std::mutex> lock(mu_);
    ask_for = queue_.to_ask(missing, manifest ? std::function<bool(const std::string&)>(
                                                     [&manifest](const std::string& n) { return manifest->count(n) != 0; })
                                               : nullptr);
  }
  for (const std::string& n : missing) {
    if (manifest && manifest->count(n) == 0) {
      log(LogLevel::kWarn, "xr: permissions: %s is not declared in the app's manifest; not asked for (denied)",
          n.c_str());
    }
  }
  if (!ask_for.empty() && !ctx.activity) {
    log(LogLevel::kWarn, "xr: permissions: no Activity to ask from; %s stay denied", join(ask_for).c_str());
  } else if (!ask_for.empty()) {
    const double t0 = now_ms();
    const bool focused_at_start = focused();
    if (!ask(env, ctx.activity, ask_for)) {
      log(LogLevel::kError, "xr: permissions: Activity.requestPermissions failed for %s", join(ask_for).c_str());
    } else {
      log(LogLevel::kInfo, "xr: permissions: asking for %s (system dialog)", join(ask_for).c_str());
      PermissionWait wait(t0, focused_at_start);
      PermissionWait::State state = PermissionWait::State::kWaiting;
      for (;;) {
        {
          std::unique_lock<std::mutex> lock(mu_);
          if (cv_.wait_for(lock, kPollInterval, [this] { return quit_; })) break;
        }
        held = check_with(env, context, names);
        state = wait.poll(now_ms(), std::all_of(held.begin(), held.end(), [](bool h) { return h; }), focused());
        if (state != PermissionWait::State::kWaiting) break;
      }
      log(LogLevel::kInfo, "xr: permissions: %s after %.0f ms (%s%s)", join(names, &held).c_str(), now_ms() - t0,
          state_name(state), wait.dialog_seen() ? ", the app lost the focus to the dialog" : "");
    }
  }
  if (env) release_android_context(env, &ctx);
  return held;
}

void PermissionBroker::start() {
  std::lock_guard<std::mutex> lock(mu_);
  stopped_ = false;
}

void PermissionBroker::stop() {
  {
    std::lock_guard<std::mutex> lock(mu_);
    stopped_ = true;  // refused until the next start(): nothing may outlive the runtime that asked
    quit_ = true;
  }
  cv_.notify_all();
  if (worker_.joinable()) worker_.join();
  std::vector<std::function<void(std::vector<bool>)>> left;
  {
    std::lock_guard<std::mutex> lock(mu_);
    quit_ = false;
    for (uint64_t ticket : queue_.drain()) left.push_back(std::move(callbacks_[ticket].done));
    callbacks_.clear();
  }
  // the requests the worker did not get to are answered as denied, without a dialog (their runtime is going away)
  for (auto& done : left) done({});
}

}  // namespace iwn::xr
