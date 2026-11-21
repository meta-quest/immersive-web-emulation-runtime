// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// V8 binding of the net module: globalThis.__iwn.net. Thin: argument
// conversion, posting completions to the isolate's JS thread through
// IwnLoopHooks, zero-copy ArrayBuffers for asset and body bytes (NET-3).
// The JS API it installs (used by web/net):
//
//   config() -> {allow: string[], debug: bool, origin, userAgent, timeoutMs}
//   readAsset(urlPath, cb(status, buffer|null, mime, mapped))   status 200 | 404 | 500
//   httpStart({url, method, headers: string[] (name, value, ...), body?: ArrayBuffer|View,
//              redirect: 0 follow | 1 error | 2 manual, timeoutMs}, onEvent) -> id
//     onEvent(1, status, statusText, headers[], url, flags)  flags: 1 redirected, 2 opaque-redirect
//     onEvent(2, ArrayBuffer)            body chunk (ack with httpAck)
//     onEvent(3)                         end
//     onEvent(4, kind, message)          error (kind: NetErrorName)
//   httpAck(id, bytes)   httpAbort(id)
//   wsConnect(url, protocols[], onEvent) -> id     (only with experimental_websocket)
//     onEvent(1, protocol, extensions)   open
//     onEvent(2, isText, string|ArrayBuffer)
//     onEvent(3, bytes)                  sent (bufferedAmount)
//     onEvent(4, kind, message)          error (a close event follows)
//     onEvent(5, code, reason, wasClean) close
//   wsSend(id, string|ArrayBuffer|View)   wsClose(id, code, reason)   (code 0 = none)
//
// Blocking variants, for worker isolates only (synchronous XHR in workers,
// NET-11); they throw on the page isolate:
//   httpSync({...as httpStart..., totalTimeoutMs}) ->
//     {status, statusText, headers[], url, flags, body: ArrayBuffer} | {errorKind, errorMessage}
//   readAssetSync(urlPath) -> {status, buffer|null, mime}
//
// Header names/values and the status text are byte strings (Fetch): bytes
// map 1:1 to code points U+0000..U+00FF in both directions.

#include <v8.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <condition_variable>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <thread>

#include "iwn/loop_hooks_registry.h"
#include "iwn/net/http.h"
#include "iwn/net/module.h"
#include "iwn/net/websocket.h"
#include "iwn/net/zip_index.h"

#if defined(__ANDROID__)
#include <dlfcn.h>
#include <jni.h>

#include "jni_connector.h"
#endif

#if defined(IWN_HAVE_CORE_RUNTIME)
#include "iwn/core/json.h"
#include "iwn/core/runtime.h"
#endif

namespace {

using namespace iwn::net;

// Small fixed pool for blocking asset reads.
class TaskPool {
 public:
  explicit TaskPool(int n) {
    for (int i = 0; i < n; ++i) threads_.emplace_back([this] { Run(); });
  }
  ~TaskPool() {
    {
      std::lock_guard<std::mutex> l(mu_);
      stop_ = true;
    }
    cv_.notify_all();
    for (auto& t : threads_) t.join();
  }
  void Post(std::function<void()> fn) {
    {
      std::lock_guard<std::mutex> l(mu_);
      q_.push_back(std::move(fn));
    }
    cv_.notify_one();
  }

 private:
  void Run() {
    for (;;) {
      std::function<void()> fn;
      {
        std::unique_lock<std::mutex> l(mu_);
        cv_.wait(l, [&] { return stop_ || !q_.empty(); });
        if (q_.empty()) return;
        fn = std::move(q_.front());
        q_.pop_front();
      }
      fn();
    }
  }
  std::mutex mu_;
  std::condition_variable cv_;
  std::deque<std::function<void()>> q_;
  bool stop_ = false;
  std::vector<std::thread> threads_;
};

struct Global {
  std::mutex mu;
  IwnNetOptions options;
  OriginAllowlist allowlist;
  std::shared_ptr<Connector> connector;
  std::unique_ptr<HttpClient> client;
  std::unique_ptr<TaskPool> pool;
  bool configured = false;
};
Global& G() {
  static Global* g = new Global();  // never destroyed: worker threads may outlive statics
  return *g;
}

struct IsolateState;

struct HttpEntry {
  v8::Global<v8::Function> cb;
  std::shared_ptr<HttpJob> job;
};
struct WsEntry {
  v8::Global<v8::Function> cb;
  std::shared_ptr<WsConnection> conn;
};

struct IsolateState : std::enable_shared_from_this<IsolateState> {
  v8::Isolate* isolate = nullptr;
  // The core runtime when this is the page isolate (posting and callbacks go
  // through it: scopes, error reporting, microtask checkpoint). Null for
  // isolates the core does not own (workers): those use IwnLoopHooks.
  void* runtime = nullptr;
  v8::Global<v8::Context> context;
  std::atomic<bool> alive{true};
  // JS thread only.
  uint32_t next_id = 1;
  std::map<uint32_t, HttpEntry> http;
  std::map<uint32_t, WsEntry> ws;
  std::map<uint32_t, v8::Global<v8::Function>> assets;
};

std::mutex g_states_mu;
std::map<v8::Isolate*, std::shared_ptr<IsolateState>> g_states;

// Every live WebSocket of every isolate, for iwn_net_abort_all() (any thread).
std::mutex g_ws_mu;
std::vector<std::weak_ptr<WsConnection>> g_ws_all;
void TrackWs(const std::shared_ptr<WsConnection>& c) {
  std::lock_guard<std::mutex> l(g_ws_mu);
  g_ws_all.erase(std::remove_if(g_ws_all.begin(), g_ws_all.end(), [](const auto& w) { return w.expired(); }),
                 g_ws_all.end());
  g_ws_all.push_back(c);
}

// Ends everything an isolate state owns (JS thread of that isolate): aborts
// requests and sockets, drops callbacks and the context. Afterwards the state
// holds no V8 handles, so whichever thread drops its last reference may
// destroy it.
void DisposeState(const std::shared_ptr<IsolateState>& st) {
  st->alive = false;
  for (auto& [id, e] : st->http) {
    if (e.job) e.job->Abort();
    e.cb.Reset();
  }
  for (auto& [id, e] : st->ws) {
    if (e.conn) e.conn->Abort();  // its listener then finds no entry: no events
    e.cb.Reset();
  }
  for (auto& [id, cb] : st->assets) cb.Reset();
  st->http.clear();  // also breaks conn -> listener -> state cycles
  st->ws.clear();
  st->assets.clear();
  st->context.Reset();
}

// The state whose posted task is running on this thread (Call() uses its runtime).
[[maybe_unused]] thread_local IsolateState* t_calling_state = nullptr;

void RunTask(void* arg) {
  std::unique_ptr<std::function<void()>> fn(static_cast<std::function<void()>*>(arg));
  (*fn)();
}

// Runs `fn(isolate, context)` on the isolate's JS thread inside its scopes.
void PostToJs(const std::shared_ptr<IsolateState>& st,
              std::function<void(v8::Isolate*, v8::Local<v8::Context>)> fn) {
  if (!st->alive) return;
#if defined(IWN_HAVE_CORE_RUNTIME)
  if (st->runtime) {
    static_cast<iwn::Runtime*>(st->runtime)->post_task([st, fn = std::move(fn)] {
      if (!st->alive) return;
      v8::Isolate* iso = st->isolate;
      t_calling_state = st.get();
      fn(iso, iso->GetCurrentContext());
      t_calling_state = nullptr;
    });
    return;
  }
#endif
  const IwnLoopHooks* hooks = iwn::LoopHooksFor(st->isolate);
  if (!hooks) return;
  auto* task = new std::function<void()>([st, fn = std::move(fn)] {
    if (!st->alive) return;
    v8::Isolate* iso = st->isolate;
    v8::HandleScope hs(iso);
    v8::Local<v8::Context> ctx = st->context.Get(iso);
    v8::Context::Scope cs(ctx);
    fn(iso, ctx);
  });
  if (!hooks->post(hooks->user, &RunTask, task)) delete task;
}

void Ref(IsolateState* st) {
  if (st->runtime) return;  // the page loop runs until the app exits
  if (const IwnLoopHooks* h = iwn::LoopHooksFor(st->isolate)) h->ref(h->user);
}
void Unref(IsolateState* st) {
  if (st->runtime) return;
  if (const IwnLoopHooks* h = iwn::LoopHooksFor(st->isolate)) h->unref(h->user);
}

// Calls a JS callback; exceptions are reported (page error / console) and do
// not propagate.
void Call(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Function> fn, int argc, v8::Local<v8::Value>* argv) {
#if defined(IWN_HAVE_CORE_RUNTIME)
  if (t_calling_state && t_calling_state->runtime) {
    (void)static_cast<iwn::Runtime*>(t_calling_state->runtime)->call_function(fn, v8::Undefined(iso), argc, argv);
    return;
  }
#endif
  v8::TryCatch tc(iso);
  tc.SetVerbose(true);
  (void)fn->Call(ctx, v8::Undefined(iso), argc, argv);
}

v8::Local<v8::String> Str(v8::Isolate* iso, const std::string& s) {
  return v8::String::NewFromUtf8(iso, s.data(), v8::NewStringType::kNormal, static_cast<int>(s.size())).ToLocalChecked();
}

std::string Utf8(v8::Isolate* iso, v8::Local<v8::Value> v) {
  if (v.IsEmpty() || v->IsUndefined() || v->IsNull()) return std::string();
  v8::String::Utf8Value u(iso, v);
  return *u ? std::string(*u, static_cast<size_t>(u.length())) : std::string();
}

// Byte string → JS string (each byte one code point, Fetch "isomorphic decode").
v8::Local<v8::String> Latin1Str(v8::Isolate* iso, const std::string& s) {
  return v8::String::NewFromOneByte(iso, reinterpret_cast<const uint8_t*>(s.data()), v8::NewStringType::kNormal,
                                    static_cast<int>(s.size()))
      .ToLocalChecked();
}

// JS string → bytes ("isomorphic encode"). False if a code point is above U+00FF
// (the JS Headers class already rejects those).
bool Latin1Bytes(v8::Isolate* iso, v8::Local<v8::Value> v, std::string* out) {
  out->clear();
  if (v.IsEmpty() || v->IsUndefined() || v->IsNull()) return true;
  v8::Local<v8::String> s;
  if (!v->ToString(iso->GetCurrentContext()).ToLocal(&s)) return false;
  if (!s->ContainsOnlyOneByte()) return false;
  out->resize(static_cast<size_t>(s->Length()));
  if (!out->empty()) s->WriteOneByte(iso, 0, static_cast<uint32_t>(out->size()), reinterpret_cast<uint8_t*>(out->data()));
  return true;
}

// USVString → UTF-8 (lone surrogates become U+FFFD).
std::vector<uint8_t> Utf8Bytes(v8::Isolate* iso, v8::Local<v8::String> s) {
  size_t len = s->Utf8Length(iso);
  std::vector<uint8_t> out(len);
  if (len) s->WriteUtf8(iso, reinterpret_cast<char*>(out.data()), len, v8::String::WriteFlags::kReplaceInvalidUtf8);
  return out;
}

bool BufferBytes(v8::Local<v8::Value> v, std::vector<uint8_t>* out) {
  if (v->IsArrayBuffer()) {
    auto ab = v.As<v8::ArrayBuffer>();
    auto bs = ab->GetBackingStore();
    const uint8_t* p = static_cast<const uint8_t*>(bs->Data());
    out->assign(p, p + ab->ByteLength());
    return true;
  }
  if (v->IsArrayBufferView()) {
    auto view = v.As<v8::ArrayBufferView>();
    out->resize(view->ByteLength());
    if (!out->empty()) view->CopyContents(out->data(), out->size());
    return true;
  }
  return false;
}

v8::Local<v8::ArrayBuffer> AdoptVector(v8::Isolate* iso, std::vector<uint8_t> v) {
  if (v.empty()) return v8::ArrayBuffer::New(iso, 0);
  auto* holder = new std::vector<uint8_t>(std::move(v));
  auto bs = v8::ArrayBuffer::NewBackingStore(
      holder->data(), holder->size(),
      [](void*, size_t, void* d) { delete static_cast<std::vector<uint8_t>*>(d); }, holder);
  return v8::ArrayBuffer::New(iso, std::shared_ptr<v8::BackingStore>(std::move(bs)));
}

v8::Local<v8::ArrayBuffer> AdoptBlob(v8::Isolate* iso, std::unique_ptr<AssetBlob> blob) {
  if (!blob || blob->size() == 0) return v8::ArrayBuffer::New(iso, 0);
  AssetBlob* raw = blob.release();
  auto bs = v8::ArrayBuffer::NewBackingStore(
      raw->data(), raw->size(), [](void*, size_t, void* d) { delete static_cast<AssetBlob*>(d); }, raw);
  return v8::ArrayBuffer::New(iso, std::shared_ptr<v8::BackingStore>(std::move(bs)));
}

std::shared_ptr<IsolateState> StateFrom(const v8::FunctionCallbackInfo<v8::Value>& info) {
  std::lock_guard<std::mutex> l(g_states_mu);
  auto it = g_states.find(info.GetIsolate());
  return it == g_states.end() ? nullptr : it->second;
}

void ThrowType(v8::Isolate* iso, const char* msg) {
  iso->ThrowException(v8::Exception::TypeError(Str(iso, msg)));
}

// ---- config / assets ------------------------------------------------------

void Config(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  Global& g = G();
  std::lock_guard<std::mutex> l(g.mu);
  v8::Local<v8::Object> o = v8::Object::New(iso);
  v8::Local<v8::Array> allow = v8::Array::New(iso, static_cast<int>(g.options.allow.size()));
  for (uint32_t i = 0; i < g.options.allow.size(); ++i) (void)allow->Set(ctx, i, Str(iso, g.options.allow[i]));
  (void)o->Set(ctx, Str(iso, "allow"), allow);
  (void)o->Set(ctx, Str(iso, "debug"), v8::Boolean::New(iso, g.options.debug_build));
  (void)o->Set(ctx, Str(iso, "origin"), Str(iso, g.options.app_origin));
  (void)o->Set(ctx, Str(iso, "userAgent"), Str(iso, g.options.user_agent));
  (void)o->Set(ctx, Str(iso, "timeoutMs"), v8::Integer::New(iso, g.options.timeout_ms));
  info.GetReturnValue().Set(o);
}

void ReadAsset(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  auto st = StateFrom(info);
  if (!st || info.Length() < 2 || !info[1]->IsFunction()) return ThrowType(iso, "readAsset(path, cb)");
  std::string url_path = Utf8(iso, info[0]);
  uint32_t id = st->next_id++;
  st->assets[id].Reset(iso, info[1].As<v8::Function>());
  Ref(st.get());
  std::shared_ptr<AssetSource> source;
  {
    std::lock_guard<std::mutex> l(G().mu);
    source = G().options.assets;
  }
  G().pool->Post([st, id, url_path, source] {
    std::string rel;
    int status = 404;
    std::unique_ptr<AssetBlob> blob;
    if (source && AssetPathFromUrlPath(url_path, &rel)) {
      AssetStatus s = source->Open(rel, &blob);
      status = s == AssetStatus::kOk ? 200 : s == AssetStatus::kNotFound ? 404 : 500;
    }
    std::string mime = MimeTypeForPath(rel);
    auto shared_blob = std::make_shared<std::unique_ptr<AssetBlob>>(std::move(blob));
    PostToJs(st, [st, id, status, mime, shared_blob](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
      auto it = st->assets.find(id);
      if (it == st->assets.end()) return;
      v8::Local<v8::Function> cb = it->second.Get(iso);
      st->assets.erase(it);
      Unref(st.get());
      bool mapped = *shared_blob && (*shared_blob)->mapped();
      v8::Local<v8::Value> argv[] = {
          v8::Integer::New(iso, status),
          status == 200 ? v8::Local<v8::Value>(AdoptBlob(iso, std::move(*shared_blob))) : v8::Null(iso).As<v8::Value>(),
          Str(iso, mime), v8::Boolean::New(iso, mapped)};
      Call(iso, ctx, cb, 4, argv);
    });
  });
}

// ---- HTTP -----------------------------------------------------------------

class JsHttpListener : public HttpListener {
 public:
  JsHttpListener(std::shared_ptr<IsolateState> st, uint32_t id) : st_(std::move(st)), id_(id) {}
  void OnHead(HttpResponseHead head) override {
    auto st = st_;
    uint32_t id = id_;
    auto h = std::make_shared<HttpResponseHead>(std::move(head));
    PostToJs(st, [st, id, h](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
      auto it = st->http.find(id);
      if (it == st->http.end()) return;
      v8::Local<v8::Array> headers = v8::Array::New(iso, static_cast<int>(h->headers.size() * 2));
      for (uint32_t i = 0; i < h->headers.size(); ++i) {
        (void)headers->Set(ctx, 2 * i, Latin1Str(iso, h->headers[i].first));
        (void)headers->Set(ctx, 2 * i + 1, Latin1Str(iso, h->headers[i].second));
      }
      int flags = (h->redirected ? 1 : 0) | (h->opaque_redirect ? 2 : 0);
      v8::Local<v8::Value> argv[] = {v8::Integer::New(iso, 1), v8::Integer::New(iso, h->status),
                                     Latin1Str(iso, h->status_text), headers, Str(iso, h->url), v8::Integer::New(iso, flags)};
      Call(iso, ctx, it->second.cb.Get(iso), 6, argv);
    });
  }
  void OnData(std::vector<uint8_t> chunk) override {
    auto st = st_;
    uint32_t id = id_;
    auto data = std::make_shared<std::vector<uint8_t>>(std::move(chunk));
    PostToJs(st, [st, id, data](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
      auto it = st->http.find(id);
      if (it == st->http.end()) return;
      v8::Local<v8::Value> argv[] = {v8::Integer::New(iso, 2), AdoptVector(iso, std::move(*data))};
      Call(iso, ctx, it->second.cb.Get(iso), 2, argv);
    });
  }
  void OnEnd() override { Finish(3, NetError{}); }
  void OnError(NetError error) override { Finish(4, std::move(error)); }

 private:
  void Finish(int type, NetError error) {
    auto st = st_;
    uint32_t id = id_;
    auto err = std::make_shared<NetError>(std::move(error));
    PostToJs(st, [st, id, type, err](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
      auto it = st->http.find(id);
      if (it == st->http.end()) return;
      v8::Local<v8::Function> cb = it->second.cb.Get(iso);
      st->http.erase(it);
      Unref(st.get());
      if (type == 3) {
        v8::Local<v8::Value> argv[] = {v8::Integer::New(iso, 3)};
        Call(iso, ctx, cb, 1, argv);
      } else {
        v8::Local<v8::Value> argv[] = {v8::Integer::New(iso, 4), Str(iso, NetErrorName(err->kind)), Str(iso, err->message)};
        Call(iso, ctx, cb, 3, argv);
      }
    });
  }
  std::shared_ptr<IsolateState> st_;
  uint32_t id_;
};

v8::Local<v8::Value> Prop(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, const char* name) {
  v8::Local<v8::Value> v;
  if (!o->Get(ctx, Str(iso, name)).ToLocal(&v)) return v8::Undefined(iso);
  return v;
}

// Reads the request object shared by httpStart and httpSync. Throws (and
// returns false) on bad input.
bool RequestFromJs(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, HttpRequest* req) {
  req->url = Utf8(iso, Prop(iso, ctx, o, "url"));
  std::string method;
  if (!Latin1Bytes(iso, Prop(iso, ctx, o, "method"), &method)) {
    ThrowType(iso, "httpStart: method must be a byte string");
    return false;
  }
  if (!method.empty()) req->method = method;
  v8::Local<v8::Value> headers = Prop(iso, ctx, o, "headers");
  if (headers->IsArray()) {
    v8::Local<v8::Array> arr = headers.As<v8::Array>();
    for (uint32_t i = 0; i + 1 < arr->Length(); i += 2) {
      v8::Local<v8::Value> n, v;
      if (!arr->Get(ctx, i).ToLocal(&n) || !arr->Get(ctx, i + 1).ToLocal(&v)) continue;
      std::string name, value;
      if (!Latin1Bytes(iso, n, &name) || !Latin1Bytes(iso, v, &value)) {
        ThrowType(iso, "httpStart: header names and values must be byte strings");
        return false;
      }
      req->headers.emplace_back(std::move(name), std::move(value));
    }
  }
  v8::Local<v8::Value> body = Prop(iso, ctx, o, "body");
  std::vector<uint8_t> bytes;
  if (BufferBytes(body, &bytes)) req->body = std::make_shared<std::vector<uint8_t>>(std::move(bytes));
  int redirect = Prop(iso, ctx, o, "redirect")->Int32Value(ctx).FromMaybe(0);
  req->redirect = redirect == 1 ? RedirectMode::kError : redirect == 2 ? RedirectMode::kManual : RedirectMode::kFollow;
  int timeout = Prop(iso, ctx, o, "timeoutMs")->Int32Value(ctx).FromMaybe(0);
  {
    std::lock_guard<std::mutex> l(G().mu);
    req->timeout_ms = timeout > 0 ? timeout : G().options.timeout_ms;
  }
  return true;
}

void HttpStart(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  auto st = StateFrom(info);
  if (!st || info.Length() < 2 || !info[0]->IsObject() || !info[1]->IsFunction()) {
    return ThrowType(iso, "httpStart(request, onEvent)");
  }
  HttpRequest req;
  if (!RequestFromJs(iso, ctx, info[0].As<v8::Object>(), &req)) return;
  uint32_t id = st->next_id++;
  HttpEntry& e = st->http[id];
  e.cb.Reset(iso, info[1].As<v8::Function>());
  Ref(st.get());
  e.job = G().client->Start(std::move(req), std::make_shared<JsHttpListener>(st, id));
  info.GetReturnValue().Set(v8::Integer::NewFromUnsigned(iso, id));
}

// ---- blocking requests (worker isolates) ------------------------------------

bool RefuseOnPage(v8::Isolate* iso, const std::shared_ptr<IsolateState>& st, const char* what) {
  if (st && !st->runtime) return false;
  iso->ThrowException(v8::Exception::TypeError(
      Str(iso, std::string(what) + " blocks the calling thread and is only available in workers")));
  return true;
}

void HttpSync(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  auto st = StateFrom(info);
  if (!st || info.Length() < 1 || !info[0]->IsObject()) return ThrowType(iso, "httpSync(request)");
  if (RefuseOnPage(iso, st, "httpSync")) return;
  v8::Local<v8::Object> o = info[0].As<v8::Object>();
  HttpRequest req;
  if (!RequestFromJs(iso, ctx, o, &req)) return;
  int total = Prop(iso, ctx, o, "totalTimeoutMs")->Int32Value(ctx).FromMaybe(0);
  BlockingResult res = FetchBlocking(*G().client, std::move(req), total);
  v8::Local<v8::Object> r = v8::Object::New(iso);
  if (res.error) {
    (void)r->Set(ctx, Str(iso, "errorKind"), Str(iso, NetErrorName(res.error.kind)));
    (void)r->Set(ctx, Str(iso, "errorMessage"), Str(iso, res.error.message));
    info.GetReturnValue().Set(r);
    return;
  }
  const HttpResponseHead& h = res.head;
  v8::Local<v8::Array> headers = v8::Array::New(iso, static_cast<int>(h.headers.size() * 2));
  for (uint32_t i = 0; i < h.headers.size(); ++i) {
    (void)headers->Set(ctx, 2 * i, Latin1Str(iso, h.headers[i].first));
    (void)headers->Set(ctx, 2 * i + 1, Latin1Str(iso, h.headers[i].second));
  }
  (void)r->Set(ctx, Str(iso, "status"), v8::Integer::New(iso, h.status));
  (void)r->Set(ctx, Str(iso, "statusText"), Latin1Str(iso, h.status_text));
  (void)r->Set(ctx, Str(iso, "headers"), headers);
  (void)r->Set(ctx, Str(iso, "url"), Str(iso, h.url));
  (void)r->Set(ctx, Str(iso, "flags"), v8::Integer::New(iso, (h.redirected ? 1 : 0) | (h.opaque_redirect ? 2 : 0)));
  (void)r->Set(ctx, Str(iso, "body"), AdoptVector(iso, std::move(res.body)));
  info.GetReturnValue().Set(r);
}

void ReadAssetSync(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  auto st = StateFrom(info);
  if (!st || info.Length() < 1) return ThrowType(iso, "readAssetSync(path)");
  if (RefuseOnPage(iso, st, "readAssetSync")) return;
  std::string url_path = Utf8(iso, info[0]);
  std::shared_ptr<AssetSource> source;
  {
    std::lock_guard<std::mutex> l(G().mu);
    source = G().options.assets;
  }
  std::string rel;
  int status = 404;
  std::unique_ptr<AssetBlob> blob;
  if (source && AssetPathFromUrlPath(url_path, &rel)) {
    AssetStatus s = source->Open(rel, &blob);
    status = s == AssetStatus::kOk ? 200 : s == AssetStatus::kNotFound ? 404 : 500;
  }
  v8::Local<v8::Object> r = v8::Object::New(iso);
  (void)r->Set(ctx, Str(iso, "status"), v8::Integer::New(iso, status));
  (void)r->Set(ctx, Str(iso, "buffer"),
               status == 200 ? v8::Local<v8::Value>(AdoptBlob(iso, std::move(blob))) : v8::Null(iso).As<v8::Value>());
  (void)r->Set(ctx, Str(iso, "mime"), Str(iso, MimeTypeForPath(rel)));
  info.GetReturnValue().Set(r);
}

void HttpAck(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto st = StateFrom(info);
  if (!st || info.Length() < 2) return;
  v8::Local<v8::Context> ctx = info.GetIsolate()->GetCurrentContext();
  uint32_t id = info[0]->Uint32Value(ctx).FromMaybe(0);
  double bytes = info[1]->NumberValue(ctx).FromMaybe(0);
  auto it = st->http.find(id);
  if (it != st->http.end() && it->second.job && bytes > 0) it->second.job->Ack(static_cast<size_t>(bytes));
}

void HttpAbort(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto st = StateFrom(info);
  if (!st || info.Length() < 1) return;
  uint32_t id = info[0]->Uint32Value(info.GetIsolate()->GetCurrentContext()).FromMaybe(0);
  auto it = st->http.find(id);
  if (it != st->http.end() && it->second.job) it->second.job->Abort();
}

// ---- WebSocket ------------------------------------------------------------

class JsWsListener : public WsListener {
 public:
  JsWsListener(std::shared_ptr<IsolateState> st, uint32_t id) : st_(std::move(st)), id_(id) {}
  void OnOpen(std::string protocol, std::string extensions) override {
    Post([protocol, extensions](v8::Isolate* iso, v8::Local<v8::Context>, std::vector<v8::Local<v8::Value>>* a) {
      *a = {v8::Integer::New(iso, 1), Str(iso, protocol), Str(iso, extensions)};
    }, false);
  }
  void OnMessage(bool text, std::vector<uint8_t> data) override {
    auto d = std::make_shared<std::vector<uint8_t>>(std::move(data));
    Post([text, d](v8::Isolate* iso, v8::Local<v8::Context>, std::vector<v8::Local<v8::Value>>* a) {
      v8::Local<v8::Value> payload;
      if (text) {
        payload = v8::String::NewFromUtf8(iso, reinterpret_cast<const char*>(d->data()), v8::NewStringType::kNormal,
                                          static_cast<int>(d->size()))
                      .ToLocalChecked();
      } else {
        payload = AdoptVector(iso, std::move(*d));
      }
      *a = {v8::Integer::New(iso, 2), v8::Boolean::New(iso, text), payload};
    }, false);
  }
  void OnSent(size_t bytes) override {
    Post([bytes](v8::Isolate* iso, v8::Local<v8::Context>, std::vector<v8::Local<v8::Value>>* a) {
      *a = {v8::Integer::New(iso, 3), v8::Number::New(iso, static_cast<double>(bytes))};
    }, false);
  }
  void OnError(NetError error) override {
    auto e = std::make_shared<NetError>(std::move(error));
    Post([e](v8::Isolate* iso, v8::Local<v8::Context>, std::vector<v8::Local<v8::Value>>* a) {
      *a = {v8::Integer::New(iso, 4), Str(iso, NetErrorName(e->kind)), Str(iso, e->message)};
    }, false);
  }
  void OnClose(int code, std::string reason, bool was_clean) override {
    Post([code, reason, was_clean](v8::Isolate* iso, v8::Local<v8::Context>, std::vector<v8::Local<v8::Value>>* a) {
      *a = {v8::Integer::New(iso, 5), v8::Integer::New(iso, code), Str(iso, reason), v8::Boolean::New(iso, was_clean)};
    }, true);
  }

 private:
  using Builder = std::function<void(v8::Isolate*, v8::Local<v8::Context>, std::vector<v8::Local<v8::Value>>*)>;
  void Post(Builder build, bool terminal) {
    auto st = st_;
    uint32_t id = id_;
    PostToJs(st, [st, id, build = std::move(build), terminal](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
      auto it = st->ws.find(id);
      if (it == st->ws.end()) return;
      v8::Local<v8::Function> cb = it->second.cb.Get(iso);
      if (terminal) {
        st->ws.erase(it);
        Unref(st.get());
      }
      std::vector<v8::Local<v8::Value>> argv;
      build(iso, ctx, &argv);
      Call(iso, ctx, cb, static_cast<int>(argv.size()), argv.data());
    });
  }
  std::shared_ptr<IsolateState> st_;
  uint32_t id_;
};

void WsConnect(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  auto st = StateFrom(info);
  if (!st || info.Length() < 3 || !info[2]->IsFunction()) return ThrowType(iso, "wsConnect(url, protocols, onEvent)");
  std::string url = Utf8(iso, info[0]);
  std::vector<std::string> protocols;
  if (info[1]->IsArray()) {
    v8::Local<v8::Array> arr = info[1].As<v8::Array>();
    for (uint32_t i = 0; i < arr->Length(); ++i) {
      v8::Local<v8::Value> v;
      if (arr->Get(ctx, i).ToLocal(&v)) protocols.push_back(Utf8(iso, v));
    }
  }
  WsOptions opts;
  OriginAllowlist allowlist;
  std::shared_ptr<Connector> connector;
  {
    std::lock_guard<std::mutex> l(G().mu);
    opts.origin = G().options.app_origin;
    opts.user_agent = G().options.user_agent;
    allowlist = G().allowlist;
    connector = G().connector;
  }
  uint32_t id = st->next_id++;
  WsEntry& e = st->ws[id];
  e.cb.Reset(iso, info[2].As<v8::Function>());
  Ref(st.get());
  e.conn = WsConnection::Start(connector, allowlist, url, protocols, std::make_shared<JsWsListener>(st, id), opts);
  TrackWs(e.conn);
  info.GetReturnValue().Set(v8::Integer::NewFromUnsigned(iso, id));
}

void WsSend(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  auto st = StateFrom(info);
  if (!st || info.Length() < 2) return;
  uint32_t id = info[0]->Uint32Value(iso->GetCurrentContext()).FromMaybe(0);
  auto it = st->ws.find(id);
  if (it == st->ws.end() || !it->second.conn) return;
  if (info[1]->IsString()) {
    it->second.conn->Send(true, Utf8Bytes(iso, info[1].As<v8::String>()));
    return;
  }
  std::vector<uint8_t> bytes;
  if (!BufferBytes(info[1], &bytes)) return ThrowType(iso, "wsSend: expected string or buffer");
  it->second.conn->Send(false, std::move(bytes));
}

void WsClose(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  auto st = StateFrom(info);
  if (!st || info.Length() < 1) return;
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  uint32_t id = info[0]->Uint32Value(ctx).FromMaybe(0);
  int code = info.Length() > 1 ? info[1]->Int32Value(ctx).FromMaybe(0) : 0;
  std::string reason = info.Length() > 2 ? Utf8(iso, info[2]) : std::string();
  auto it = st->ws.find(id);
  if (it != st->ws.end() && it->second.conn) it->second.conn->Close(code, reason);
}

void SetFn(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Object> target, const char* name,
           v8::FunctionCallback cb) {
  v8::Local<v8::Function> fn = v8::Function::New(ctx, cb).ToLocalChecked();
  fn->SetName(Str(iso, name));
  (void)target->Set(ctx, Str(iso, name), fn);
}

#if defined(IWN_HAVE_CORE_RUNTIME)
// Assets through the core's AssetSource (the dist lives under config.appRoot).
// Its AssetBytes are read-only (AAsset_getBuffer maps them PROT_READ), so
// they cannot back a writable ArrayBuffer. For NET-3, large entries the APK
// stores uncompressed are mapped privately (copy-on-write) straight from
// base.apk through a central-directory index; everything else is copied once
// into a heap blob on the reader thread.
class CoreAssetAdapter : public AssetSource {
 public:
  CoreAssetAdapter(iwn::AssetSource* core, std::string root) : core_(core), root_(std::move(root)) {
    std::string apk = FindOwnApkPath();
    if (!apk.empty()) {
      std::string err;
      zip_ = ZipIndex::Open(apk, "assets/", &err);
    }
  }
  AssetStatus Open(const std::string& rel, std::unique_ptr<AssetBlob>* out) override {
    if (zip_) {
      ZipIndex::Entry e;
      if (zip_->Find("assets/" + Full(rel), &e) && e.stored && e.size >= kAssetMapThreshold) {
        if ((*out = MapFileRange(zip_->fd(), e.data_offset, static_cast<size_t>(e.size)))) return AssetStatus::kOk;
      }
    }
    std::shared_ptr<iwn::AssetBytes> bytes = core_->read(Full(rel));
    if (!bytes) return AssetStatus::kNotFound;
    auto blob = MakeHeapBlob(bytes->size());
    if (bytes->size()) std::memcpy(blob->data(), bytes->data(), bytes->size());
    *out = std::move(blob);
    return AssetStatus::kOk;
  }
  AssetStatus Stat(const std::string& rel, uint64_t* size) override {
    std::shared_ptr<iwn::AssetBytes> bytes = core_->read(Full(rel));
    if (!bytes) return AssetStatus::kNotFound;
    *size = bytes->size();
    return AssetStatus::kOk;
  }

 private:
  std::string Full(const std::string& rel) const { return root_.empty() ? rel : root_ + "/" + rel; }
  iwn::AssetSource* core_;
  std::string root_;
  std::unique_ptr<ZipIndex> zip_;
};

// Builds IwnNetOptions from the core runtime: assets, origin, and the
// "network" section of assets/iwn/config.json written by the packer:
//   "network": { "allow": ["https://cdn.jsdelivr.net"], "debug": false, "timeoutMs": 60000 }
IwnNetOptions OptionsFromRuntime(iwn::Runtime* rt) {
  IwnNetOptions o;
  o.assets = std::make_shared<CoreAssetAdapter>(&rt->assets(), rt->config().app_root);
  o.app_origin = rt->config().origin;
  if (std::shared_ptr<iwn::AssetBytes> cfg = rt->assets().read("iwn/config.json")) {
    if (auto json = iwn::Json::parse(cfg->view())) {
      const iwn::Json& net = (*json)["network"];
      for (const iwn::Json& e : net["allow"].items()) {
        if (e.is_string()) o.allow.push_back(e.as_string());
      }
      o.debug_build = net["debug"].as_bool(false);
      o.timeout_ms = static_cast<int>(net["timeoutMs"].as_int(60000));
      o.experimental_websocket = net["experimentalWebSocket"].as_bool(false);
      if (net["userAgent"].is_string()) o.user_agent = net["userAgent"].as_string();
    }
  }
#if defined(__ANDROID__)
  // JNI_GetCreatedJavaVMs is exported by libnativehelper on API 31+.
  using GetVMs = jint (*)(JavaVM**, jsize, jsize*);
  for (const char* lib : {"libnativehelper.so", "libart.so"}) {
    void* h = dlopen(lib, RTLD_NOW | RTLD_NOLOAD);
    if (!h) h = dlopen(lib, RTLD_NOW);
    auto fn = h ? reinterpret_cast<GetVMs>(dlsym(h, "JNI_GetCreatedJavaVMs")) : nullptr;
    JavaVM* vm = nullptr;
    jsize n = 0;
    if (fn && fn(&vm, 1, &n) == JNI_OK && n > 0) {
      o.java_vm = vm;
      break;
    }
  }
#endif
  return o;
}
#endif

}  // namespace

void iwn_net_configure(const IwnNetOptions& options) {
  Global& g = G();
  std::lock_guard<std::mutex> l(g.mu);
  g.options = options;
  g.allowlist.Set(options.allow);
  g.allowlist.SetDebugBuild(options.debug_build);
#if defined(__ANDROID__)
  if (options.java_vm && InitJniNet(static_cast<JavaVM*>(options.java_vm))) {
    g.connector = std::shared_ptr<Connector>(MakeJniConnector());
  }
#endif
  if (!g.connector) g.connector = std::shared_ptr<Connector>(MakePosixConnector());
  if (!g.client) {
    HttpClientOptions ho;
    ho.user_agent = options.user_agent;
    g.client = std::make_unique<HttpClient>(g.connector, ho);
  }
  g.client->SetAllowlist(g.allowlist);
  if (!g.pool) g.pool = std::make_unique<TaskPool>(4);
  g.configured = true;
}

void iwn_register_net(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  auto st = std::make_shared<IsolateState>();
  st->isolate = isolate;
#if defined(IWN_HAVE_CORE_RUNTIME)
  if (iwn::Runtime* rt = iwn::Runtime::From(isolate)) {
    st->runtime = rt;
    if (!G().configured) iwn_net_configure(OptionsFromRuntime(rt));
    static bool shutdown_hook_added = false;  // one page runtime per process
    if (!shutdown_hook_added) {
      shutdown_hook_added = true;
      // PROC-7: requests and sockets end, callbacks are released before the
      // context and isolate go away.
      rt->add_shutdown_hook([isolate] { iwn_net_dispose_isolate(isolate); });
    }
  }
#endif
  if (!G().configured) iwn_net_configure(IwnNetOptions{});
  st->context.Reset(isolate, ctx);
  std::shared_ptr<IsolateState> old;
  {
    std::lock_guard<std::mutex> l(g_states_mu);
    auto& slot = g_states[isolate];
    old = std::move(slot);
    slot = st;
  }
  // A new context in the same isolate (location.reload(), PROC-8): the old
  // page's requests and sockets end now, on this (the JS) thread.
  if (old) DisposeState(old);
  v8::Local<v8::Object> net = v8::Object::New(isolate);
  SetFn(isolate, ctx, net, "config", Config);
  SetFn(isolate, ctx, net, "readAsset", ReadAsset);
  SetFn(isolate, ctx, net, "httpStart", HttpStart);
  SetFn(isolate, ctx, net, "httpAck", HttpAck);
  SetFn(isolate, ctx, net, "httpAbort", HttpAbort);
  bool websocket;
  {
    std::lock_guard<std::mutex> l(G().mu);
    websocket = G().options.experimental_websocket;
  }
  if (websocket) {
    // Not part of the alpha surface: absent unless the app opts in, so
    // `typeof WebSocket === 'undefined'` (web/net installs it only over these).
    SetFn(isolate, ctx, net, "wsConnect", WsConnect);
    SetFn(isolate, ctx, net, "wsSend", WsSend);
    SetFn(isolate, ctx, net, "wsClose", WsClose);
  }
  if (!st->runtime) {
    // Blocking variants exist only where blocking is allowed (workers).
    SetFn(isolate, ctx, net, "httpSync", HttpSync);
    SetFn(isolate, ctx, net, "readAssetSync", ReadAssetSync);
  }
  (void)natives->Set(ctx, Str(isolate, "net"), net);
}

void iwn_net_abort_all() {
  if (G().client) G().client->AbortAll();
  std::vector<std::shared_ptr<WsConnection>> conns;
  {
    std::lock_guard<std::mutex> l(g_ws_mu);
    for (auto& w : g_ws_all) {
      if (auto c = w.lock()) conns.push_back(std::move(c));
    }
    g_ws_all.clear();
  }
  for (auto& c : conns) c->Abort();
}

void iwn_net_dispose_isolate(v8::Isolate* isolate) {
  std::shared_ptr<IsolateState> st;
  {
    std::lock_guard<std::mutex> l(g_states_mu);
    auto it = g_states.find(isolate);
    if (it == g_states.end()) return;
    st = it->second;
    g_states.erase(it);
  }
  DisposeState(st);
}
