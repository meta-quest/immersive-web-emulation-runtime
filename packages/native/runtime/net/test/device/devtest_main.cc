// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Device test for the net + storage modules, standalone (without the runtime core): a NativeActivity that embeds V8 15.5 with a minimal
// event loop (IwnLoopHooks), registers __iwn.net and __iwn.storage through the
// real V8 bindings, evaluates the shipped preludes from the APK's assets
// (glue, net, storage, idb) and then assets/devtest/test.js, and logs one
// result line (logcat tag iwn-devtest: "IWN_DEVTEST_RESULT {json}"). Run it
// twice to check persistence across launches.
//
// Phase 2 reproduces location.reload() as the core implements it: a new
// context in the same isolate, iwn_register_net/storage called again, the
// preludes re-run, then assets/devtest/reload.js. Its result is merged into
// the same JSON under "reload".
//
// A silent TLS peer (127.0.0.1:28443: accepts TCP, never sends a byte) checks
// that handshakes are bounded by the request timeout and abortable.
//
// Not shipped; test only.

#include <android/asset_manager.h>
#include <android/log.h>
#include <android/native_activity.h>
#include <arpa/inet.h>
#include <libplatform/libplatform.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>
#include <v8.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "android_assets.h"
#include "iwn/loop_hooks_registry.h"
#include "iwn/net/module.h"
#include "iwn/storage/module.h"

#define LOG(...) __android_log_print(ANDROID_LOG_INFO, "iwn-devtest", __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, "iwn-devtest", __VA_ARGS__)

namespace {

ANativeActivity* g_activity = nullptr;

std::string ReadAsset(const char* path) {
  AAsset* a = AAssetManager_open(g_activity->assetManager, path, AASSET_MODE_BUFFER);
  if (!a) return std::string();
  std::string out(static_cast<const char*>(AAsset_getBuffer(a)), static_cast<size_t>(AAsset_getLength(a)));
  AAsset_close(a);
  return out;
}

// --- a minimal event loop ---------------------------------------------------
struct Loop {
  std::mutex mu;
  std::condition_variable cv;
  std::deque<std::pair<IwnTaskFn, void*>> tasks;
  int refs = 0;  // JS thread only
  bool quitting = false;

  struct Timer {
    v8::Global<v8::Function> fn;
    std::vector<v8::Global<v8::Value>> args;
  };
  std::multimap<int64_t, int> due;  // due ms → timer id
  std::map<int, Timer> timers;
  int next_timer = 1;
};
Loop g_loop;
std::atomic<bool> g_done{false};
std::string g_result;

int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

int Post(void*, IwnTaskFn fn, void* arg) {
  {
    std::lock_guard<std::mutex> l(g_loop.mu);
    if (g_loop.quitting) return 0;
    g_loop.tasks.emplace_back(fn, arg);
  }
  g_loop.cv.notify_one();
  return 1;
}
void Ref(void*) { ++g_loop.refs; }
void Unref(void*) { --g_loop.refs; }
IwnLoopHooks g_hooks = {nullptr, &Post, &Ref, &Unref};

v8::Local<v8::String> Str(v8::Isolate* iso, const std::string& s) {
  return v8::String::NewFromUtf8(iso, s.data(), v8::NewStringType::kNormal, static_cast<int>(s.size())).ToLocalChecked();
}

void ConsoleLog(const v8::FunctionCallbackInfo<v8::Value>& info) {
  std::string line;
  for (int i = 0; i < info.Length(); ++i) {
    v8::String::Utf8Value u(info.GetIsolate(), info[i]);
    if (i) line += ' ';
    line += *u ? *u : "<?>";
  }
  LOG("js: %s", line.c_str());
}

void SetTimeout(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  if (info.Length() < 1 || !info[0]->IsFunction()) return;
  double ms = info.Length() > 1 ? info[1]->NumberValue(iso->GetCurrentContext()).FromMaybe(0) : 0;
  int id = g_loop.next_timer++;
  Loop::Timer& t = g_loop.timers[id];
  t.fn.Reset(iso, info[0].As<v8::Function>());
  for (int i = 2; i < info.Length(); ++i) t.args.emplace_back(iso, info[i]);
  g_loop.due.emplace(NowMs() + static_cast<int64_t>(ms < 0 ? 0 : ms), id);
  info.GetReturnValue().Set(id);
}

void ClearTimeout(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1) return;
  int id = info[0]->Int32Value(info.GetIsolate()->GetCurrentContext()).FromMaybe(0);
  g_loop.timers.erase(id);
}

void CryptoRandom(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1 || !info[0]->IsArrayBufferView()) return;
  auto view = info[0].As<v8::ArrayBufferView>();
  auto bs = view->Buffer()->GetBackingStore();
  arc4random_buf(static_cast<uint8_t*>(bs->Data()) + view->ByteOffset(), view->ByteLength());
}

// Accepts TCP connections on 127.0.0.1:28443 and never answers (a TLS server
// that hangs in the handshake).
void StartSilentPeer() {
  std::thread([] {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(28443);
    if (bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr) != 0 || listen(fd, 64) != 0) {
      LOGE("silent peer: bind/listen failed");
      return;
    }
    std::vector<int> held;
    for (;;) {
      int c = accept(fd, nullptr, nullptr);
      if (c >= 0) held.push_back(c);  // kept open, never read or written
    }
  }).detach();
}

void TestDone(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::String::Utf8Value u(info.GetIsolate(), info[0]);
  g_result = *u ? *u : "{}";
  g_done = true;
}

void SetFn(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, const char* name, v8::FunctionCallback cb) {
  (void)o->Set(ctx, Str(iso, name), v8::Function::New(ctx, cb).ToLocalChecked());
}

void ReportException(v8::Isolate* iso, v8::TryCatch& tc) {
  v8::String::Utf8Value msg(iso, tc.Exception());
  std::string stack;
  v8::Local<v8::Value> st;
  if (tc.StackTrace(iso->GetCurrentContext()).ToLocal(&st)) {
    v8::String::Utf8Value s(iso, st);
    if (*s) stack = *s;
  }
  LOGE("uncaught: %s\n%s", *msg ? *msg : "?", stack.c_str());
}

bool RunScript(v8::Isolate* iso, v8::Local<v8::Context> ctx, const char* asset) {
  std::string src = ReadAsset(asset);
  if (src.empty()) {
    LOGE("missing asset %s", asset);
    return false;
  }
  v8::TryCatch tc(iso);
  v8::ScriptOrigin origin(Str(iso, std::string("https://app.local/") + asset));
  v8::Local<v8::Script> script;
  if (!v8::Script::Compile(ctx, Str(iso, src), &origin).ToLocal(&script) || script->Run(ctx).IsEmpty()) {
    ReportException(iso, tc);
    return false;
  }
  return true;
}

// A page context: console, timers, __iwn (crypto, test, net, storage).
v8::Local<v8::Context> MakePageContext(v8::Isolate* iso) {
  v8::EscapableHandleScope ehs(iso);
  v8::Local<v8::Context> ctx = v8::Context::New(iso);
  v8::Context::Scope cs(ctx);
  v8::Local<v8::Object> global = ctx->Global();
  v8::Local<v8::Object> console = v8::Object::New(iso);
  for (const char* n : {"log", "warn", "error", "info", "debug"}) SetFn(iso, ctx, console, n, ConsoleLog);
  (void)global->Set(ctx, Str(iso, "console"), console);
  SetFn(iso, ctx, global, "setTimeout", SetTimeout);
  SetFn(iso, ctx, global, "clearTimeout", ClearTimeout);
  v8::Local<v8::Object> natives = v8::Object::New(iso);
  v8::Local<v8::Object> crypto = v8::Object::New(iso);
  SetFn(iso, ctx, crypto, "random", CryptoRandom);
  (void)natives->Set(ctx, Str(iso, "crypto"), crypto);
  v8::Local<v8::Object> test = v8::Object::New(iso);
  SetFn(iso, ctx, test, "done", TestDone);
  (void)natives->Set(ctx, Str(iso, "test"), test);
  (void)global->Set(ctx, Str(iso, "__iwn"), natives);
  // Registering again for a new context of the same isolate is the reload path.
  iwn_register_net(iso, ctx, natives);
  iwn_register_storage(iso, ctx, natives);
  return ehs.Escape(ctx);
}

// Runs scripts, then the loop until test.done() or the deadline.
void RunPhase(v8::Platform* platform, v8::Isolate* iso, v8::Local<v8::Context> ctx,
              std::initializer_list<const char*> scripts, int64_t budget_ms) {
  v8::Context::Scope cs(ctx);
  g_done = false;
  for (const char* s : scripts) {
    if (!RunScript(iso, ctx, s)) break;
    iso->PerformMicrotaskCheckpoint();
  }
  int64_t deadline = NowMs() + budget_ms;
  while (!g_done && NowMs() < deadline) {
    while (v8::platform::PumpMessageLoop(platform, iso)) {
    }
    std::deque<std::pair<IwnTaskFn, void*>> batch;
    {
      std::unique_lock<std::mutex> l(g_loop.mu);
      int64_t wait = 20;
      if (!g_loop.due.empty()) wait = std::max<int64_t>(0, std::min<int64_t>(wait, g_loop.due.begin()->first - NowMs()));
      if (g_loop.tasks.empty()) g_loop.cv.wait_for(l, std::chrono::milliseconds(wait));
      batch.swap(g_loop.tasks);
    }
    for (auto& [fn, arg] : batch) {
      fn(arg);
      iso->PerformMicrotaskCheckpoint();
    }
    int64_t now = NowMs();
    while (!g_loop.due.empty() && g_loop.due.begin()->first <= now) {
      int id = g_loop.due.begin()->second;
      g_loop.due.erase(g_loop.due.begin());
      auto it = g_loop.timers.find(id);
      if (it == g_loop.timers.end()) continue;
      Loop::Timer t = std::move(it->second);
      g_loop.timers.erase(it);
      v8::HandleScope ths(iso);
      std::vector<v8::Local<v8::Value>> argv;
      for (auto& a : t.args) argv.push_back(a.Get(iso));
      v8::TryCatch tc(iso);
      if (t.fn.Get(iso)->Call(ctx, v8::Undefined(iso), static_cast<int>(argv.size()), argv.data()).IsEmpty()) {
        ReportException(iso, tc);
      }
      iso->PerformMicrotaskCheckpoint();
    }
  }
  if (!g_done) g_result = "{\"error\":\"timed out after " + std::to_string(budget_ms / 1000) + " s\"}";
  g_loop.timers.clear();
  g_loop.due.clear();
}

void RunTests() {
  int64_t t0 = NowMs();
  StartSilentPeer();
  std::string snapshot = ReadAsset("devtest/snapshot_blob.bin");
  static v8::StartupData blob{snapshot.data(), static_cast<int>(snapshot.size())};
  v8::V8::SetSnapshotDataBlob(&blob);
  std::unique_ptr<v8::Platform> platform = v8::platform::NewDefaultPlatform();
  v8::V8::InitializePlatform(platform.get());
  v8::V8::Initialize();
  v8::Isolate::CreateParams params;
  params.array_buffer_allocator = v8::ArrayBuffer::Allocator::NewDefaultAllocator();
  v8::Isolate* iso = v8::Isolate::New(params);
  iso->SetMicrotasksPolicy(v8::MicrotasksPolicy::kExplicit);
  std::string phase1, phase2;
  {
    v8::Isolate::Scope is(iso);
    v8::HandleScope hs(iso);
    iwn::BindLoopHooks(iso, &g_hooks);
    IwnNetOptions net;
    net.assets = std::make_shared<iwn::net::AndroidAssetSource>(g_activity->assetManager, "app");
    net.allow = {"http://localhost:18080", "https://localhost:18443", "http://localhost:18081",
                 "https://localhost:28443", "https://www.google.com", "https://www.gstatic.com",
                 "https://cdn.jsdelivr.net", "https://registry.npmjs.org", "https://echo.websocket.org"};
    net.debug_build = true;
    net.experimental_websocket = true;  // the ws/wss checks exercise the flagged-off transport
    net.user_agent = "iwer-native-devtest";
    net.timeout_ms = 8000;  // bounds the silent-peer checks; public requests finish well within it
    net.java_vm = g_activity->vm;
    iwn_net_configure(net);
    IwnStorageOptions storage;
    storage.data_dir = g_activity->internalDataPath;
    iwn_storage_configure(storage);

    {
      v8::HandleScope phs(iso);
      v8::Local<v8::Context> ctx = MakePageContext(iso);
      RunPhase(platform.get(), iso, ctx,
               {"devtest/glue.min.js", "devtest/net.min.js", "devtest/storage.min.js", "devtest/idb.min.js", "devtest/test.js"},
               150000);
      phase1 = g_result;
    }
    {
      // location.reload(): same isolate, new context, modules registered again.
      v8::HandleScope phs(iso);
      v8::Local<v8::Context> ctx = MakePageContext(iso);
      RunPhase(platform.get(), iso, ctx,
               {"devtest/glue.min.js", "devtest/net.min.js", "devtest/storage.min.js", "devtest/idb.min.js", "devtest/reload.js"},
               60000);
      phase2 = g_result;
    }
    iwn_storage_flush_all();  // PROC-7 exit path
    {
      std::lock_guard<std::mutex> l(g_loop.mu);
      g_loop.quitting = true;
    }
    iwn_net_abort_all();
    iwn_net_dispose_isolate(iso);
    iwn_storage_dispose_isolate(iso);
    iwn::UnbindLoopHooks(iso);
  }
  if (!phase1.empty() && phase1.back() == '}') {
    g_result = phase1.substr(0, phase1.size() - 1) + ",\"reload\":" + (phase2.empty() ? "null" : phase2) + "}";
  } else {
    g_result = phase1;
  }
  // logcat truncates long lines: print the JSON in numbered chunks.
  for (size_t off = 0, i = 0; off < g_result.size(); off += 900, ++i) {
    LOG("IWN_DEVTEST_RESULT[%zu] %s", i, g_result.substr(off, 900).c_str());
  }
  LOG("IWN_DEVTEST_RESULT_END %zu", g_result.size());
  LOG("IWN_DEVTEST_TIME %lld ms", static_cast<long long>(NowMs() - t0));
  // Leave V8/isolate alive: the process exits with the activity.
  ANativeActivity_finish(g_activity);
}

}  // namespace

extern "C" JNIEXPORT void ANativeActivity_onCreate(ANativeActivity* activity, void*, size_t) {
  g_activity = activity;
  LOG("devtest starting; data dir %s", activity->internalDataPath);
  std::thread([] { RunTests(); }).detach();
}
