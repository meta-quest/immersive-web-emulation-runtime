/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The workers module's V8 binding: iwn_register_workers (NATIVE MODULE CONTRACT) installs globalThis.__iwn.workers
// in the page and in every worker global. JS side: web/workers (Worker, MessageChannel, MessagePort, the worker
// global's postMessage/close/importScripts). Spec: 05-workers.md (WRK-1..12), JS-2, PROC-7, CC-5.
//
// __iwn.workers (both kinds of global):
//   setHooks({dispatch, hostWrite, hostRead, hostPrototypes})
//   info() -> {isWorker, id, name, url, type, insidePort, maxWorkers, live, crossOriginIsolated, hardwareConcurrency}
//   create(url, type, name, sourceBytes|null, deviceInfo) -> [workerId, outsidePort]
//   terminate(workerId)
//   channel() -> [portA, portB]
//   serialize(value, arrayBuffersToTransfer) -> pendingId          (throws DataCloneError; nothing detached then)
//   post(port, pendingId, transferredPortIds, bitmapTokens) -> bool (false: no peer / unknown port, message dropped)
//   discard(pendingId), start(port), close(port), stats()
// worker globals only:
//   readScript(url) -> string (throws NetworkError), evalScript(source, url), closeSelf(),
//   forwardError(message, filename, lineno, colno)  (a child's error nobody handled here goes one level up)
// dispatch(kind, ...): 'message' (port, data, portIds), 'messageerror' (port, portIds), 'error' (workerId, info),
//   'loaderror' (workerId, message), 'exit' (workerId).
#include <algorithm>
#include <cstring>

#include "iwn/core/clock.h"
#include "iwn/core/log.h"
#include "v8/internal.h"

namespace iwn::workers {

// --- helpers -----------------------------------------------------------------------------------------------------

v8::Local<v8::String> v8str(v8::Isolate* isolate, std::string_view s) {
  return v8::String::NewFromUtf8(isolate, s.data(), v8::NewStringType::kNormal, static_cast<int>(s.size()))
      .ToLocalChecked();
}

std::string utf8(v8::Isolate* isolate, v8::Local<v8::Value> value) {
  if (value.IsEmpty()) return {};
  v8::String::Utf8Value u(isolate, value);
  return *u ? std::string(*u, static_cast<size_t>(u.length())) : std::string();
}

void throw_dom_exception(v8::Isolate* isolate, std::string_view message, const char* name) {
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  v8::Local<v8::Object> ex;
  {
    // Only the construction runs under this TryCatch; the throw happens after it is gone (an exception thrown
    // while a TryCatch is active would be caught by it and lost).
    v8::TryCatch tc(isolate);
    v8::Local<v8::Value> ctor;
    if (ctx->Global()->Get(ctx, v8str(isolate, "DOMException")).ToLocal(&ctor) && ctor->IsFunction()) {
      v8::Local<v8::Value> args[] = {v8str(isolate, message), v8str(isolate, name)};
      if (!ctor.As<v8::Function>()->NewInstance(ctx, 2, args).ToLocal(&ex)) ex.Clear();
    }
  }
  if (ex.IsEmpty()) {
    v8::Local<v8::Value> err = v8::Exception::Error(v8str(isolate, message));
    (void)err.As<v8::Object>()->Set(ctx, v8str(isolate, "name"), v8str(isolate, name));
    isolate->ThrowException(err);
    return;
  }
  isolate->ThrowException(ex);
}

void throw_type_error(v8::Isolate* isolate, std::string_view message) {
  isolate->ThrowException(v8::Exception::TypeError(v8str(isolate, message)));
}

void set_fn(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> target, const char* name,
            v8::FunctionCallback cb, v8::Local<v8::Value> data) {
  v8::Local<v8::Function> fn =
      v8::Function::New(ctx, cb, data, 0, v8::ConstructorBehavior::kThrow).ToLocalChecked();
  fn->SetName(v8str(isolate, name));
  target->Set(ctx, v8str(isolate, name), fn).Check();
}

void set_val(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> target, const char* name,
             v8::Local<v8::Value> value) {
  target->Set(ctx, v8str(isolate, name), value).Check();
}

std::string exception_text(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Value> exception) {
  if (exception.IsEmpty()) return "<no exception>";
  if (exception->IsObject()) {
    v8::TryCatch tc(isolate);
    v8::Local<v8::Value> stack;
    if (exception.As<v8::Object>()->Get(ctx, v8str(isolate, "stack")).ToLocal(&stack) && stack->IsString()) {
      return utf8(isolate, stack);
    }
  }
  v8::TryCatch tc(isolate);
  v8::Local<v8::String> s;
  if (exception->ToString(ctx).ToLocal(&s)) return utf8(isolate, s);
  return "<unprintable exception>";
}

// --- process-wide state -----------------------------------------------------------------------------------------

namespace {
std::mutex g_env_mu;
std::shared_ptr<const WorkerEnv> g_env;

std::mutex g_workers_mu;
std::map<uint64_t, std::weak_ptr<WorkerHandle>> g_workers;
std::atomic<uint64_t> g_next_worker_id{1};

std::mutex g_bindings_mu;
std::unordered_map<v8::Isolate*, std::shared_ptr<IsolateBinding>> g_bindings;
}  // namespace

std::shared_ptr<const WorkerEnv> worker_env() {
  std::lock_guard<std::mutex> lock(g_env_mu);
  return g_env;
}
void set_worker_env(std::shared_ptr<const WorkerEnv> env) {
  std::lock_guard<std::mutex> lock(g_env_mu);
  g_env = std::move(env);
}
WorkerLimiter& worker_limiter() {
  static WorkerLimiter* limiter = new WorkerLimiter(32);
  return *limiter;
}
void register_worker(const std::shared_ptr<WorkerHandle>& handle) {
  std::lock_guard<std::mutex> lock(g_workers_mu);
  g_workers[handle->id] = handle;
}
void unregister_worker(uint64_t id) {
  std::lock_guard<std::mutex> lock(g_workers_mu);
  g_workers.erase(id);
}
std::vector<std::shared_ptr<WorkerHandle>> live_workers() {
  std::lock_guard<std::mutex> lock(g_workers_mu);
  std::vector<std::shared_ptr<WorkerHandle>> out;
  for (auto& [id, w] : g_workers) {
    if (auto h = w.lock()) out.push_back(std::move(h));
  }
  return out;
}
uint64_t next_worker_id() { return g_next_worker_id++; }

std::shared_ptr<IsolateBinding> binding_for(v8::Isolate* isolate) {
  std::lock_guard<std::mutex> lock(g_bindings_mu);
  auto it = g_bindings.find(isolate);
  return it == g_bindings.end() ? nullptr : it->second;
}
void set_binding_for(v8::Isolate* isolate, std::shared_ptr<IsolateBinding> binding) {
  std::shared_ptr<IsolateBinding> old;
  {
    std::lock_guard<std::mutex> lock(g_bindings_mu);
    auto& slot = g_bindings[isolate];
    old = std::move(slot);
    slot = std::move(binding);
  }
  // `old` is released here, on the isolate's JS thread (the caller).
}
std::shared_ptr<IsolateBinding> take_binding_for(v8::Isolate* isolate) {
  std::lock_guard<std::mutex> lock(g_bindings_mu);
  auto it = g_bindings.find(isolate);
  if (it == g_bindings.end()) return nullptr;
  auto b = std::move(it->second);
  g_bindings.erase(it);
  return b;
}

// --- BindingOwner ------------------------------------------------------------------------------------------------

bool BindingOwner::post(std::function<void(IsolateBinding&)> fn) {
  std::lock_guard<std::mutex> lock(mu_);
  if (!alive_) return false;
  std::weak_ptr<IsolateBinding> weak = binding_;
  return poster_([weak, fn = std::move(fn)] {
    if (auto b = weak.lock()) fn(*b);
  });
}

bool BindingOwner::schedule_delivery(PortId port) {
  return post([port](IsolateBinding& b) { b.deliver(port); });
}

void BindingOwner::set_binding(std::weak_ptr<IsolateBinding> binding) {
  std::lock_guard<std::mutex> lock(mu_);
  binding_ = std::move(binding);
}

void BindingOwner::kill() {
  std::lock_guard<std::mutex> lock(mu_);
  alive_ = false;
}

// --- IsolateBinding -------------------------------------------------------------------------------------------

IsolateBinding::IsolateBinding(v8::Isolate* isolate, v8::Local<v8::Context> ctx, JsHost* host, WorkerRuntime* worker)
    : isolate_(isolate), context_(isolate, ctx), host_(host), worker_(worker) {}

IsolateBinding::~IsolateBinding() = default;

void IsolateBinding::set_hooks(v8::Local<v8::Object> hooks) {
  v8::Local<v8::Context> ctx = context();
  hooks_.Reset(isolate_, hooks);
  auto fn = [&](const char* name, v8::Global<v8::Function>& slot) {
    v8::Local<v8::Value> v;
    if (hooks->Get(ctx, v8str(isolate_, name)).ToLocal(&v) && v->IsFunction()) slot.Reset(isolate_, v.As<v8::Function>());
  };
  fn("dispatch", dispatch_);
  fn("hostWrite", host_write_);
  fn("hostRead", host_read_);
  host_protos_.clear();
  v8::Local<v8::Value> protos;
  if (hooks->Get(ctx, v8str(isolate_, "hostPrototypes")).ToLocal(&protos) && protos->IsArray()) {
    auto arr = protos.As<v8::Array>();
    for (uint32_t i = 0; i < arr->Length(); ++i) {
      v8::Local<v8::Value> p;
      if (arr->Get(ctx, i).ToLocal(&p) && p->IsObject()) host_protos_.emplace_back(isolate_, p.As<v8::Object>());
    }
  }
}

bool IsolateBinding::is_host_object(v8::Local<v8::Object> object) {
  // Native-backed wrappers (internal fields: image handles, canvas2d handles) always go to the host hook, which
  // refuses what it does not know (DataCloneError), as V8's default delegate would.
  if (object->InternalFieldCount() > 0) return true;
  if (host_protos_.empty()) return false;
  v8::Local<v8::Value> proto = object->GetPrototype();
  for (int depth = 0; depth < 16 && proto->IsObject(); ++depth) {
    v8::Local<v8::Object> p = proto.As<v8::Object>();
    for (const auto& g : host_protos_) {
      if (g == p) return true;
    }
    proto = p->GetPrototype();
  }
  return false;
}

void IsolateBinding::dispatch(const char* kind, std::vector<v8::Local<v8::Value>> args) {
  if (dispatch_.IsEmpty() || shut_down_) return;
  v8::HandleScope hs(isolate_);
  args.insert(args.begin(), v8str(isolate_, kind));
  (void)host_->call(dispatch_.Get(isolate_), v8::Undefined(isolate_), static_cast<int>(args.size()), args.data());
}

uint32_t IsolateBinding::keep_pending(std::unique_ptr<SerializedMessage> m) {
  uint32_t id = next_pending_++;
  if (next_pending_ == 0) next_pending_ = 1;
  pending_[id] = std::move(m);
  // A pending message that JS never posted or discarded (an exception between serialize and post) is bounded.
  if (pending_.size() > 64) pending_.erase(pending_.begin());
  return id;
}

std::unique_ptr<SerializedMessage> IsolateBinding::take_pending(uint32_t id) {
  auto it = pending_.find(id);
  if (it == pending_.end()) return nullptr;
  auto m = std::move(it->second);
  pending_.erase(it);
  return m;
}

void IsolateBinding::deliver(PortId port) {
  if (shut_down_) return;
  std::unique_ptr<Payload> payload = PortHub::shared().pop(port, owner_.get());
  if (!payload) return;
  auto* m = static_cast<SerializedMessage*>(payload.get());
  v8::HandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = context();
  v8::Context::Scope cs(ctx);
  // The transferred ports become this isolate's (HTML: new MessagePort objects in the receiving realm).
  v8::Local<v8::Array> ports = v8::Array::New(isolate_, static_cast<int>(m->ports.size()));
  for (size_t i = 0; i < m->ports.size(); ++i) {
    PortHub::shared().adopt(m->ports[i], owner_);
    (void)ports->Set(ctx, static_cast<uint32_t>(i), v8::Number::New(isolate_, static_cast<double>(m->ports[i])));
  }
  v8::Local<v8::Array> bitmaps = v8::Array::New(isolate_, static_cast<int>(m->bitmaps.size()));
  for (size_t i = 0; i < m->bitmaps.size(); ++i) {
    (void)bitmaps->Set(ctx, static_cast<uint32_t>(i), v8::Number::New(isolate_, static_cast<double>(m->bitmaps[i])));
  }
  m->delivered = true;  // ports and bitmap tokens are now the receiver's (JS discards tokens it did not import)
  v8::Local<v8::Value> value;
  bool ok;
  {
    v8::TryCatch tc(isolate_);
    ok = deserialize_message(*this, ctx, *m, ports, bitmaps).ToLocal(&value);
    if (!ok && tc.HasTerminated()) return;
  }
  payload.reset();  // the message's memory is released before the listeners run
  if (ok) {
    dispatch("message", {v8::Number::New(isolate_, static_cast<double>(port)), value, ports, bitmaps});
  } else {
    dispatch("messageerror", {v8::Number::New(isolate_, static_cast<double>(port)), ports, bitmaps});
  }
}

void IsolateBinding::add_child(std::shared_ptr<WorkerHandle> handle) { children_[handle->id] = std::move(handle); }

std::shared_ptr<WorkerHandle> IsolateBinding::child(uint64_t id) {
  auto it = children_.find(id);
  return it == children_.end() ? nullptr : it->second;
}

void IsolateBinding::remove_child(uint64_t id) {
  auto it = children_.find(id);
  if (it == children_.end()) return;
  terminated_children_.push_back(it->second);
  children_.erase(it);
  // Keep the list short: finished workers need no join.
  terminated_children_.erase(std::remove_if(terminated_children_.begin(), terminated_children_.end(),
                                            [](const auto& h) { return h->done(); }),
                             terminated_children_.end());
}

std::vector<std::shared_ptr<WorkerHandle>> IsolateBinding::children() {
  std::vector<std::shared_ptr<WorkerHandle>> out;
  for (auto& [id, h] : children_) out.push_back(h);
  return out;
}

void IsolateBinding::child_error(uint64_t id, const std::string& message, const std::string& filename, int line,
                                 int col) {
  if (shut_down_) return;
  v8::HandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = context();
  v8::Local<v8::Object> info = v8::Object::New(isolate_);
  set_val(isolate_, ctx, info, "message", v8str(isolate_, message));
  set_val(isolate_, ctx, info, "filename", v8str(isolate_, filename));
  set_val(isolate_, ctx, info, "lineno", v8::Integer::New(isolate_, line));
  set_val(isolate_, ctx, info, "colno", v8::Integer::New(isolate_, col));
  auto h = child(id);
  std::string label = h ? h->label : "worker " + std::to_string(id);
  set_val(isolate_, ctx, info, "label", v8str(isolate_, label));
  dispatch("error", {v8::Number::New(isolate_, static_cast<double>(id)), info});
}

void IsolateBinding::child_load_error(uint64_t id, const std::string& message) {
  if (shut_down_) return;
  v8::HandleScope hs(isolate_);
  dispatch("loaderror", {v8::Number::New(isolate_, static_cast<double>(id)), v8str(isolate_, message)});
}

void IsolateBinding::child_exit(uint64_t id) {
  auto it = children_.find(id);
  if (it != children_.end()) children_.erase(it);
  terminated_children_.erase(std::remove_if(terminated_children_.begin(), terminated_children_.end(),
                                            [id](const auto& h) { return h->id == id; }),
                             terminated_children_.end());
  if (shut_down_) return;
  v8::HandleScope hs(isolate_);
  dispatch("exit", {v8::Number::New(isolate_, static_cast<double>(id))});
}

void IsolateBinding::shutdown() {
  if (shut_down_) return;
  shut_down_ = true;
  if (owner_) owner_->kill();
  for (auto& [id, h] : children_) {
    h->terminate();
    PortHub::shared().close(h->outside_port);
    terminated_children_.push_back(h);
  }
  children_.clear();
  if (owner_) PortHub::shared().close_owned_by(owner_.get());
  pending_.clear();
  dispatch_.Reset();
  host_write_.Reset();
  host_read_.Reset();
  host_protos_.clear();
  hooks_.Reset();
}

void IsolateBinding::join_children(double timeout_ms) {
  double deadline = now_ms() + timeout_ms;
  for (auto& h : terminated_children_) {
    double left = deadline - now_ms();
    if (!h->wait_done(left > 0 ? left : 0)) {
      log(LogLevel::kWarn, "%s did not stop within %.0f ms of terminate()", h->label.c_str(), timeout_ms);
    }
  }
  terminated_children_.clear();
}

// --- natives -------------------------------------------------------------------------------------------------------

namespace {

std::shared_ptr<IsolateBinding> binding_of(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto b = binding_for(info.GetIsolate());
  if (!b) throw_dom_exception(info.GetIsolate(), "workers: this global is shutting down", "InvalidStateError");
  return b;
}

uint64_t id_arg(const v8::FunctionCallbackInfo<v8::Value>& info, int i) {
  if (info.Length() <= i) return 0;
  double d = info[i]->NumberValue(info.GetIsolate()->GetCurrentContext()).FromMaybe(0);
  return d > 0 ? static_cast<uint64_t>(d) : 0;
}

void js_set_hooks(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto b = binding_of(info);
  if (!b) return;
  if (info.Length() < 1 || !info[0]->IsObject()) return throw_type_error(info.GetIsolate(), "setHooks(object)");
  b->set_hooks(info[0].As<v8::Object>());
}

void js_info(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto b = binding_of(info);
  if (!b) return;
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  auto env = worker_env();
  v8::Local<v8::Object> o = v8::Object::New(isolate);
  WorkerRuntime* w = b->worker();
  set_val(isolate, ctx, o, "isWorker", v8::Boolean::New(isolate, w != nullptr));
  if (w) {
    WorkerHandle& h = w->handle();
    set_val(isolate, ctx, o, "id", v8::Number::New(isolate, static_cast<double>(h.id)));
    set_val(isolate, ctx, o, "name", v8str(isolate, h.name));
    set_val(isolate, ctx, o, "url", v8str(isolate, h.url));
    set_val(isolate, ctx, o, "type", v8str(isolate, h.module ? "module" : "classic"));
    set_val(isolate, ctx, o, "insidePort", v8::Number::New(isolate, static_cast<double>(h.inside_port)));
    set_val(isolate, ctx, o, "origin", v8str(isolate, w->origin()));
  } else if (env) {
    set_val(isolate, ctx, o, "origin", v8str(isolate, env->origin));
  }
  WorkersConfig cfg = env ? env->config : WorkersConfig{};
  set_val(isolate, ctx, o, "maxWorkers", v8::Integer::New(isolate, worker_limiter().max()));
  set_val(isolate, ctx, o, "live", v8::Integer::New(isolate, worker_limiter().live()));
  set_val(isolate, ctx, o, "crossOriginIsolated", v8::Boolean::New(isolate, cfg.cross_origin_isolated));
  set_val(isolate, ctx, o, "hardwareConcurrencyCap", v8::Integer::New(isolate, cfg.hardware_concurrency));
  info.GetReturnValue().Set(o);
}

void js_create(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto b = binding_of(info);
  if (!b) return;
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  auto env = worker_env();
  if (!env) return throw_dom_exception(isolate, "Workers are not available: no page runtime", "InvalidStateError");
  std::string url_text = info.Length() > 0 ? utf8(isolate, info[0]) : "";
  std::string type = info.Length() > 1 ? utf8(isolate, info[1]) : "classic";
  std::string name = info.Length() > 2 && !info[2]->IsUndefined() ? utf8(isolate, info[2]) : "";
  auto url = parse_url(url_text);
  if (!url) return throw_dom_exception(isolate, "The URL '" + url_text + "' is invalid.", "SyntaxError");
  std::string creator_origin = b->worker() ? b->worker()->origin() : env->origin;
  switch (check_worker_url(*url, creator_origin)) {
    case WorkerUrlCheck::kOk:
      break;
    case WorkerUrlCheck::kCrossOrigin:
      return throw_dom_exception(isolate,
                                 "Script at '" + url_text + "' cannot be accessed from origin '" + creator_origin + "'.",
                                 "SecurityError");
    case WorkerUrlCheck::kUnsupportedScheme:
      return throw_dom_exception(isolate, "Worker scripts must be same-origin, data: or blob: URLs: " + url_text,
                                 "SecurityError");
  }
  WorkerStart start;
  start.env = env;
  if (info.Length() > 3 && info[3]->IsArrayBufferView()) {
    auto view = info[3].As<v8::ArrayBufferView>();
    start.source.resize(view->ByteLength());
    view->CopyContents(start.source.data(), start.source.size());
    start.have_source = true;
  } else if (url->scheme == "blob") {
    return throw_dom_exception(isolate, "blob: worker URL could not be resolved: " + url_text, "NetworkError");
  }
  if (info.Length() > 4 && info[4]->IsObject()) {
    v8::Local<v8::String> json;
    if (v8::JSON::Stringify(ctx, info[4]).ToLocal(&json)) start.device_info_json = utf8(isolate, json);
  }
  WorkerLimiter& limiter = worker_limiter();
  if (!limiter.try_acquire()) {
    return throw_dom_exception(isolate,
                               "Failed to construct 'Worker': at most " + std::to_string(limiter.max()) +
                                   " workers can run at once (config workers.maxWorkers); terminate() idle workers",
                               "NotSupportedError");
  }
  auto h = std::make_shared<WorkerHandle>();
  h->id = next_worker_id();
  h->name = name;
  h->url = url->href();
  h->module = type == "module";
  h->label = worker_label(h->id, name, h->url);
  h->parent = b->owner();
  auto [outside, inside] = PortHub::shared().create_pair(b->owner(), nullptr);
  h->outside_port = outside;
  h->inside_port = inside;
  PortHub::shared().set_label(outside, b->owner()->label());
  PortHub::shared().set_label(inside, h->label);
  PortHub::shared().start(outside);
  start.handle = h;
  register_worker(h);
  b->add_child(h);
  if (!WorkerRuntime::start(std::move(start))) {
    b->remove_child(h->id);
    unregister_worker(h->id);
    PortHub::shared().close(outside);
    PortHub::shared().close(inside);
    limiter.release();
    return throw_dom_exception(isolate, "Failed to construct 'Worker': could not start a thread", "OperationError");
  }
  v8::Local<v8::Value> pair[] = {v8::Number::New(isolate, static_cast<double>(h->id)),
                                 v8::Number::New(isolate, static_cast<double>(outside))};
  info.GetReturnValue().Set(v8::Array::New(isolate, pair, 2));
}

void js_terminate(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto b = binding_of(info);
  if (!b) return;
  uint64_t id = id_arg(info, 0);
  auto h = b->child(id);
  if (!h) return;
  h->terminate();
  // HTML "terminate a worker": its queued messages are dropped; the Worker object gets no further events.
  PortHub::shared().close(h->outside_port);
  b->remove_child(id);
}

void js_channel(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto b = binding_of(info);
  if (!b) return;
  v8::Isolate* isolate = info.GetIsolate();
  auto [a, c] = PortHub::shared().create_pair(b->owner(), b->owner());
  v8::Local<v8::Value> pair[] = {v8::Number::New(isolate, static_cast<double>(a)),
                                 v8::Number::New(isolate, static_cast<double>(c))};
  info.GetReturnValue().Set(v8::Array::New(isolate, pair, 2));
}

void js_serialize(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto b = binding_of(info);
  if (!b) return;
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  std::vector<v8::Local<v8::ArrayBuffer>> transfer;
  if (info.Length() > 1 && info[1]->IsArray()) {
    auto arr = info[1].As<v8::Array>();
    for (uint32_t i = 0; i < arr->Length(); ++i) {
      v8::Local<v8::Value> v;
      if (!arr->Get(ctx, i).ToLocal(&v)) return;
      if (!v->IsArrayBuffer()) {
        return throw_dom_exception(isolate, "Value at index " + std::to_string(i) + " does not have a transferable type.",
                                   "DataCloneError");
      }
      transfer.push_back(v.As<v8::ArrayBuffer>());
    }
  }
  auto env = worker_env();
  bool allow_shared = env ? env->config.cross_origin_isolated : false;
  v8::Local<v8::Value> value = info.Length() > 0 ? info[0] : v8::Undefined(isolate).As<v8::Value>();
  auto m = serialize_message(*b, ctx, value, transfer, allow_shared);
  if (!m) return;  // exception pending
  info.GetReturnValue().Set(b->keep_pending(std::move(m)));
}

void read_id_list(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Value> v, std::vector<uint64_t>* out) {
  if (!v->IsArray()) return;
  auto arr = v.As<v8::Array>();
  for (uint32_t i = 0; i < arr->Length(); ++i) {
    v8::Local<v8::Value> item;
    if (arr->Get(ctx, i).ToLocal(&item)) {
      double d = item->NumberValue(ctx).FromMaybe(0);
      if (d > 0) out->push_back(static_cast<uint64_t>(d));
    }
  }
  (void)isolate;
}

void js_post(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto b = binding_of(info);
  if (!b) return;
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  PortId port = id_arg(info, 0);
  auto m = b->take_pending(static_cast<uint32_t>(id_arg(info, 1)));
  if (!m) return throw_dom_exception(isolate, "workers.post: unknown serialized message", "InvalidStateError");
  if (info.Length() > 2) read_id_list(isolate, ctx, info[2], &m->ports);
  if (info.Length() > 3) read_id_list(isolate, ctx, info[3], &m->bitmaps);
  // Transferred ports leave this isolate now (their queues travel with them).
  for (PortId p : m->ports) PortHub::shared().detach_for_transfer(p, b->owner().get());
  auto r = PortHub::shared().post(port, std::move(m));
  info.GetReturnValue().Set(r == PortHub::PostResult::kQueued);
}

void js_discard(const v8::FunctionCallbackInfo<v8::Value>& info) {
  auto b = binding_of(info);
  if (!b) return;
  b->take_pending(static_cast<uint32_t>(id_arg(info, 0)));
}

void js_start(const v8::FunctionCallbackInfo<v8::Value>& info) { PortHub::shared().start(id_arg(info, 0)); }
void js_close(const v8::FunctionCallbackInfo<v8::Value>& info) { PortHub::shared().close(id_arg(info, 0)); }

void js_stats(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  PortHubStats s = PortHub::shared().stats();
  auto cache = ScriptCache::shared().stats();
  v8::Local<v8::Object> o = v8::Object::New(isolate);
  set_val(isolate, ctx, o, "live", v8::Integer::New(isolate, worker_limiter().live()));
  set_val(isolate, ctx, o, "created", v8::Number::New(isolate, static_cast<double>(worker_limiter().created())));
  set_val(isolate, ctx, o, "ports", v8::Number::New(isolate, static_cast<double>(s.live_ports)));
  set_val(isolate, ctx, o, "queued", v8::Number::New(isolate, static_cast<double>(s.queued_messages)));
  set_val(isolate, ctx, o, "posted", v8::Number::New(isolate, static_cast<double>(s.posted)));
  set_val(isolate, ctx, o, "delivered", v8::Number::New(isolate, static_cast<double>(s.delivered)));
  set_val(isolate, ctx, o, "dropped", v8::Number::New(isolate, static_cast<double>(s.dropped)));
  set_val(isolate, ctx, o, "codeCacheHits", v8::Number::New(isolate, static_cast<double>(cache.hits)));
  set_val(isolate, ctx, o, "codeCacheMisses", v8::Number::New(isolate, static_cast<double>(cache.misses)));
  info.GetReturnValue().Set(o);
}

// --- worker-only natives ---------------------------------------------------------------------------------------

WorkerRuntime* worker_of(const v8::FunctionCallbackInfo<v8::Value>& info) {
  WorkerRuntime* w = WorkerRuntime::current();
  if (!w || w->isolate() != info.GetIsolate()) {
    throw_dom_exception(info.GetIsolate(), "only available in a worker", "InvalidStateError");
    return nullptr;
  }
  return w;
}

void js_read_script(const v8::FunctionCallbackInfo<v8::Value>& info) {
  WorkerRuntime* w = worker_of(info);
  if (!w) return;
  v8::Isolate* isolate = info.GetIsolate();
  std::string url = info.Length() > 0 ? utf8(isolate, info[0]) : "";
  std::string source, error;
  if (!w->fetch(url, false, &source, &error)) {
    return throw_dom_exception(isolate, "Failed to execute 'importScripts': The script at '" + url +
                                            "' failed to load (" + error + ").",
                               "NetworkError");
  }
  info.GetReturnValue().Set(v8str(isolate, source));
}

void js_eval_script(const v8::FunctionCallbackInfo<v8::Value>& info) {
  WorkerRuntime* w = worker_of(info);
  if (!w) return;
  v8::Isolate* isolate = info.GetIsolate();
  std::string source = info.Length() > 0 ? utf8(isolate, info[0]) : "";
  std::string url = info.Length() > 1 ? utf8(isolate, info[1]) : "";
  v8::Local<v8::Value> result;
  // Exceptions propagate to importScripts' caller (HTML: "rethrow errors").
  v8::Local<v8::Script> script;
  if (!compile_classic(isolate, isolate->GetCurrentContext(), url, source).ToLocal(&script)) return;
  if (script->Run(isolate->GetCurrentContext()).ToLocal(&result)) info.GetReturnValue().Set(result);
}

void js_close_self(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (WorkerRuntime* w = worker_of(info)) w->request_close();
}

void js_forward_error(const v8::FunctionCallbackInfo<v8::Value>& info) {
  WorkerRuntime* w = worker_of(info);
  if (!w) return;
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  std::string message = info.Length() > 0 ? utf8(isolate, info[0]) : "";
  std::string filename = info.Length() > 1 ? utf8(isolate, info[1]) : "";
  int line = info.Length() > 2 ? info[2]->Int32Value(ctx).FromMaybe(0) : 0;
  int col = info.Length() > 3 ? info[3]->Int32Value(ctx).FromMaybe(0) : 0;
  WorkerHandle& h = w->handle();
  uint64_t id = h.id;
  bool posted = h.parent && h.parent->post([id, message, filename, line, col](IsolateBinding& b) {
    b.child_error(id, message, filename, line, col);
  });
  if (!posted) log_js(LogLevel::kError, "[" + h.label + "] Uncaught " + message);
}

}  // namespace

void install_workers_natives(IsolateBinding& binding, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  v8::Isolate* isolate = binding.isolate();
  v8::Local<v8::Object> w = v8::Object::New(isolate);
  set_fn(isolate, ctx, w, "setHooks", js_set_hooks);
  set_fn(isolate, ctx, w, "info", js_info);
  set_fn(isolate, ctx, w, "create", js_create);
  set_fn(isolate, ctx, w, "terminate", js_terminate);
  set_fn(isolate, ctx, w, "channel", js_channel);
  set_fn(isolate, ctx, w, "serialize", js_serialize);
  set_fn(isolate, ctx, w, "post", js_post);
  set_fn(isolate, ctx, w, "discard", js_discard);
  set_fn(isolate, ctx, w, "start", js_start);
  set_fn(isolate, ctx, w, "close", js_close);
  set_fn(isolate, ctx, w, "stats", js_stats);
  if (binding.worker()) {
    set_fn(isolate, ctx, w, "readScript", js_read_script);
    set_fn(isolate, ctx, w, "evalScript", js_eval_script);
    set_fn(isolate, ctx, w, "closeSelf", js_close_self);
    set_fn(isolate, ctx, w, "forwardError", js_forward_error);
  }
  set_val(isolate, ctx, natives, "workers", w);
}

}  // namespace iwn::workers
