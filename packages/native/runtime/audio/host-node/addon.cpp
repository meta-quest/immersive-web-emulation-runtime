// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Host-only Node addon: loads the real audio binding (binding_v8.cpp) into Node 24 so the
// web/audio TypeScript layer can be tested against the native engine on a Linux host
// (HL-3). `exports.audio` is what `globalThis.__iwn.audio` is on device.
// `exports.enableHooks()` installs host hooks backed by a uv_async handle, so tests can exercise
// the push (posted task) path as well as the polling path.
#include <node.h>
#include <uv.h>

#include <mutex>
#include <utility>
#include <vector>

#include "iwn/audio.h"

void iwn_audio_binding_shutdown_for_test();

namespace {
std::mutex g_mu;
std::vector<std::pair<void (*)(void*), void*>> g_tasks;
uv_async_t g_async;
bool g_asyncInit = false;
v8::Isolate* g_isolate = nullptr;

void onAsync(uv_async_t*) {
  std::vector<std::pair<void (*)(void*), void*>> tasks;
  {
    std::lock_guard<std::mutex> l(g_mu);
    tasks.swap(g_tasks);
  }
  for (auto& t : tasks) t.first(t.second);
  if (g_isolate) g_isolate->PerformMicrotaskCheckpoint();
}

bool postToMain(void*, void (*fn)(void*), void* arg) {
  {
    std::lock_guard<std::mutex> l(g_mu);
    g_tasks.emplace_back(fn, arg);
  }
  uv_async_send(&g_async);
  return true;
}

void EnableHooks(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (!g_asyncInit) {
    uv_async_init(node::GetCurrentEventLoop(info.GetIsolate()), &g_async, onAsync);
    uv_unref(reinterpret_cast<uv_handle_t*>(&g_async));
    g_asyncInit = true;
  }
  iwn::audio::HostHooks h;
  h.postToMain = postToMain;
  iwn::audio::setHostHooks(h);
}

void DisableHooks(const v8::FunctionCallbackInfo<v8::Value>&) { iwn::audio::setHostHooks(iwn::audio::HostHooks{}); }

void SetPaused(const v8::FunctionCallbackInfo<v8::Value>& info) {
  uint32_t reason = static_cast<uint32_t>(info[0].As<v8::Number>()->Value());
  iwn::audio::setOutputPaused(reason, info[1]->BooleanValue(info.GetIsolate()));
}
// shutdownForTest(): what the runtime's shutdown hook does (PROC-7).
void ShutdownForTest(const v8::FunctionCallbackInfo<v8::Value>&) { iwn_audio_binding_shutdown_for_test(); }

// register(): registers the binding again into a fresh object, as a new runtime in the same process
// would (a relaunched activity); returns that object.
void Register(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Object> o = v8::Object::New(iso);
  iwn_register_audio(iso, ctx, o);
  info.GetReturnValue().Set(o->Get(ctx, v8::String::NewFromUtf8(iso, "audio").ToLocalChecked()).ToLocalChecked());
}
}  // namespace

NODE_MODULE_INIT(/* exports, module, context */) {
  v8::Isolate* iso = context->GetIsolate();
  g_isolate = iso;
  iwn_register_audio(iso, context, exports);
  auto add = [&](const char* name, v8::FunctionCallback cb) {
    exports
        ->Set(context, v8::String::NewFromUtf8(iso, name).ToLocalChecked(),
              v8::FunctionTemplate::New(iso, cb)->GetFunction(context).ToLocalChecked())
        .Check();
  };
  add("enableHooks", EnableHooks);
  add("disableHooks", DisableHooks);
  add("setPaused", SetPaused);
  add("shutdownForTest", ShutdownForTest);
  add("register", Register);
}
