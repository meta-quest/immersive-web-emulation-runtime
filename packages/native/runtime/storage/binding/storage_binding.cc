// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// V8 binding of the storage module: globalThis.__iwn.storage. JS API (used
// by web/storage):
//
//   kvOpen() -> {entries: string[] (key, value, ...), warning, persistent}
//       page context; the current contents (also after a reload in the same
//       process). The file is read on a background thread started when the
//       module is registered, so kvOpen normally does no I/O.
//   kvSet(key, value)  kvRemove(key)  kvClear()  kvFlush()
//   sqlOpen(area, name) -> handle          area: "idb" | "cache"; throws TypeError on a bad name
//   sqlExec(handle, sql: string[], args: any[][], readOnly: bool,
//           cb(results: {error?, insertId, rowsAffected, rows?: object[]}[]), atomic?: bool)
//       atomic: the batch is one transaction, rolled back entirely on any error
//   sqlClose(handle, cb(error))   sqlDelete(area, name, cb(error))
//   estimate() -> {usage, quota}
//
// SQL values: null/undefined → NULL, boolean → 0/1, integral safe number or
// BigInt → INTEGER, other number → REAL, string → TEXT, ArrayBuffer/View → BLOB.
// Results: INTEGER → number, REAL → number, TEXT → string, BLOB → ArrayBuffer.

#include <v8.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <future>
#include <map>
#include <thread>
#include <memory>
#include <mutex>
#include <system_error>

#include "iwn/loop_hooks_registry.h"
#include "iwn/storage/fs_util.h"
#include "iwn/storage/kv_store.h"
#include "iwn/storage/module.h"
#include "iwn/storage/sql_database.h"

#if defined(IWN_HAVE_CORE_RUNTIME)
#include "iwn/core/runtime.h"
#endif

namespace {

using namespace iwn::storage;

struct Global {
  std::mutex mu;
  IwnStorageOptions options;
  std::unique_ptr<KvStore> kv;
  std::shared_future<bool> kv_load;  // valid once the load started
  std::string kv_warning;            // written by the load thread before it completes
  std::unique_ptr<SqlService> idb;
  std::unique_ptr<SqlService> cache;
};
Global& G() {
  static Global* g = new Global();
  return *g;
}

struct IsolateState {
  v8::Isolate* isolate = nullptr;
  void* runtime = nullptr;  // iwn::Runtime* for the page isolate (see net_binding.cc)
  v8::Global<v8::Context> context;
  std::atomic<bool> alive{true};
  uint32_t next_id = 1;
  std::map<uint32_t, v8::Global<v8::Function>> callbacks;  // JS thread only
  std::map<int, SqlService*> handles;                       // handle → service
};
std::mutex g_states_mu;
std::map<v8::Isolate*, std::shared_ptr<IsolateState>> g_states;

std::string DataRoot() { return G().options.data_dir + "/iwn"; }

[[maybe_unused]] thread_local IsolateState* t_calling_state = nullptr;

void RunTask(void* arg) {
  std::unique_ptr<std::function<void()>> fn(static_cast<std::function<void()>*>(arg));
  (*fn)();
}

void PostToJs(const std::shared_ptr<IsolateState>& st, std::function<void(v8::Isolate*, v8::Local<v8::Context>)> fn) {
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
  if (st->runtime) return;
  if (const IwnLoopHooks* h = iwn::LoopHooksFor(st->isolate)) h->ref(h->user);
}
void Unref(IsolateState* st) {
  if (st->runtime) return;
  if (const IwnLoopHooks* h = iwn::LoopHooksFor(st->isolate)) h->unref(h->user);
}

v8::Local<v8::String> Str(v8::Isolate* iso, const std::string& s) {
  return v8::String::NewFromUtf8(iso, s.data(), v8::NewStringType::kNormal, static_cast<int>(s.size())).ToLocalChecked();
}

std::string Utf8(v8::Isolate* iso, v8::Local<v8::Value> v) {
  v8::String::Utf8Value u(iso, v);
  return *u ? std::string(*u, static_cast<size_t>(u.length())) : std::string();
}

std::u16string Utf16(v8::Isolate* iso, v8::Local<v8::Value> v) {
  v8::Local<v8::String> s;
  if (!v->ToString(iso->GetCurrentContext()).ToLocal(&s)) return std::u16string();
  std::u16string out(static_cast<size_t>(s->Length()), u'\0');
  if (!out.empty()) s->Write(iso, 0, static_cast<uint32_t>(out.size()), reinterpret_cast<uint16_t*>(out.data()));
  return out;
}

v8::Local<v8::String> FromUtf16(v8::Isolate* iso, const std::u16string& s) {
  return v8::String::NewFromTwoByte(iso, reinterpret_cast<const uint16_t*>(s.data()), v8::NewStringType::kNormal,
                                    static_cast<int>(s.size()))
      .ToLocalChecked();
}

std::shared_ptr<IsolateState> StateFrom(const v8::FunctionCallbackInfo<v8::Value>& info) {
  std::lock_guard<std::mutex> l(g_states_mu);
  auto it = g_states.find(info.GetIsolate());
  return it == g_states.end() ? nullptr : it->second;
}

void ThrowType(v8::Isolate* iso, const std::string& msg) {
  iso->ThrowException(v8::Exception::TypeError(Str(iso, msg)));
}

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

uint32_t Keep(IsolateState* st, v8::Isolate* iso, v8::Local<v8::Value> fn) {
  uint32_t id = st->next_id++;
  st->callbacks[id].Reset(iso, fn.As<v8::Function>());
  Ref(st);
  return id;
}

// Returns the callback for `id` and forgets it (JS thread).
bool Take(IsolateState* st, v8::Isolate* iso, uint32_t id, v8::Local<v8::Function>* out) {
  auto it = st->callbacks.find(id);
  if (it == st->callbacks.end()) return false;
  *out = it->second.Get(iso);
  st->callbacks.erase(it);
  Unref(st);
  return true;
}

// ---- localStorage KV --------------------------------------------------------

// Starts reading local-storage.kv on a background thread (once per process),
// so neither the read nor the file initialisation runs on the JS thread
// inside a frame (NET-STORE-2).
void StartKvLoad() {
  Global& g = G();
  std::lock_guard<std::mutex> l(g.mu);
  if (g.kv) return;
  KvStore::Options o;
  o.path = DataRoot() + "/local-storage.kv";
  g.kv = std::make_unique<KvStore>(o);
  auto promise = std::make_shared<std::promise<bool>>();
  g.kv_load = promise->get_future().share();
  KvStore* kv = g.kv.get();
  auto load = [kv, promise] {
    std::string warning;
    bool ok = kv->Load(nullptr, &warning);
    G().kv_warning = warning;  // published by the promise (happens-before get())
    promise->set_value(ok);
  };
  try {
    std::thread(load).detach();
  } catch (const std::system_error&) {
    load();
  }
}

// The store once loaded successfully; null while loading or when unavailable.
KvStore* Kv(bool wait_for_load = false) {
  Global& g = G();
  std::shared_future<bool> load;
  KvStore* kv;
  {
    std::lock_guard<std::mutex> l(g.mu);
    load = g.kv_load;
    kv = g.kv.get();
  }
  if (!load.valid()) return nullptr;
  if (!wait_for_load && load.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return nullptr;
  return load.get() ? kv : nullptr;
}

void KvOpen(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  StartKvLoad();
  KvStore* kv = Kv(/*wait_for_load=*/true);  // normally finished long ago
  // Snapshot, not the file's initial contents: after a reload (new context,
  // same process) the page must see what the previous context wrote.
  KvEntries entries = kv ? kv->Snapshot() : KvEntries{};
  v8::Local<v8::Array> arr = v8::Array::New(iso, static_cast<int>(entries.size() * 2));
  for (uint32_t i = 0; i < entries.size(); ++i) {
    (void)arr->Set(ctx, 2 * i, FromUtf16(iso, entries[i].first));
    (void)arr->Set(ctx, 2 * i + 1, FromUtf16(iso, entries[i].second));
  }
  const std::string& warning = G().kv_warning;
  v8::Local<v8::Object> o = v8::Object::New(iso);
  (void)o->Set(ctx, Str(iso, "entries"), arr);
  (void)o->Set(ctx, Str(iso, "warning"), Str(iso, kv ? warning : "storage unavailable: " + warning));
  (void)o->Set(ctx, Str(iso, "persistent"), v8::Boolean::New(iso, kv != nullptr));
  info.GetReturnValue().Set(o);
}

// Mutations come only after kvOpen() (the JS map is built from it), so the
// load has completed; Kv(true) does not block in practice.
void KvSet(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 2) return;
  if (KvStore* kv = Kv(true)) kv->Set(Utf16(info.GetIsolate(), info[0]), Utf16(info.GetIsolate(), info[1]));
}
void KvRemove(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1) return;
  if (KvStore* kv = Kv(true)) kv->Remove(Utf16(info.GetIsolate(), info[0]));
}
void KvClear(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (KvStore* kv = Kv(true)) kv->Clear();
}
void KvFlush(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (KvStore* kv = Kv()) kv->Flush(false);  // never block the JS thread
}

// ---- SQLite -----------------------------------------------------------------

SqlService* Area(const std::string& area) {
  Global& g = G();
  std::lock_guard<std::mutex> l(g.mu);
  if (area == "idb") {
    if (!g.idb) g.idb = std::make_unique<SqlService>(DataRoot() + "/idb");
    return g.idb.get();
  }
  if (area == "cache") {
    if (!g.cache) g.cache = std::make_unique<SqlService>(DataRoot() + "/cache");
    return g.cache.get();
  }
  return nullptr;
}

void SqlOpen(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  auto st = StateFrom(info);
  if (!st || info.Length() < 2) return ThrowType(iso, "sqlOpen(area, name)");
  SqlService* svc = Area(Utf8(iso, info[0]));
  if (!svc) return ThrowType(iso, "sqlOpen: unknown area");
  std::string err;
  int h = svc->Open(Utf8(iso, info[1]), &err);
  if (!h) return ThrowType(iso, "sqlOpen: " + err);
  st->handles[h] = svc;
  info.GetReturnValue().Set(v8::Integer::New(iso, h));
}

bool ToSqlValue(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Value> v, SqlValue* out) {
  if (v->IsNullOrUndefined()) {
    *out = std::monostate{};
  } else if (v->IsBoolean()) {
    *out = int64_t(v->BooleanValue(iso) ? 1 : 0);
  } else if (v->IsNumber()) {
    double d = v.As<v8::Number>()->Value();
    if (std::isfinite(d) && std::floor(d) == d && std::fabs(d) <= 9007199254740991.0) *out = static_cast<int64_t>(d);
    else *out = d;
  } else if (v->IsBigInt()) {
    *out = v.As<v8::BigInt>()->Int64Value();
  } else if (v->IsString()) {
    *out = Utf8(iso, v);
  } else if (v->IsArrayBuffer()) {
    auto ab = v.As<v8::ArrayBuffer>();
    const uint8_t* p = static_cast<const uint8_t*>(ab->GetBackingStore()->Data());
    *out = std::vector<uint8_t>(p, p + ab->ByteLength());
  } else if (v->IsArrayBufferView()) {
    auto view = v.As<v8::ArrayBufferView>();
    std::vector<uint8_t> bytes(view->ByteLength());
    if (!bytes.empty()) view->CopyContents(bytes.data(), bytes.size());
    *out = std::move(bytes);
  } else {
    *out = Utf8(iso, v);  // WebSQL stringifies other values
  }
  return true;
}

v8::Local<v8::Value> FromSqlValue(v8::Isolate* iso, SqlValue& v) {
  if (auto* n = std::get_if<int64_t>(&v)) return v8::Number::New(iso, static_cast<double>(*n));
  if (auto* d = std::get_if<double>(&v)) return v8::Number::New(iso, *d);
  if (auto* s = std::get_if<std::string>(&v)) return Str(iso, *s);
  if (auto* b = std::get_if<std::vector<uint8_t>>(&v)) {
    if (b->empty()) return v8::ArrayBuffer::New(iso, 0);
    auto* holder = new std::vector<uint8_t>(std::move(*b));
    auto bs = v8::ArrayBuffer::NewBackingStore(
        holder->data(), holder->size(),
        [](void*, size_t, void* d) { delete static_cast<std::vector<uint8_t>*>(d); }, holder);
    return v8::ArrayBuffer::New(iso, std::shared_ptr<v8::BackingStore>(std::move(bs)));
  }
  return v8::Null(iso);
}

void SqlExec(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  auto st = StateFrom(info);
  if (!st || info.Length() < 5 || !info[1]->IsArray() || !info[4]->IsFunction()) {
    return ThrowType(iso, "sqlExec(handle, sql[], args[][], readOnly, cb)");
  }
  int h = info[0]->Int32Value(ctx).FromMaybe(0);
  auto hit = st->handles.find(h);
  v8::Local<v8::Array> sqls = info[1].As<v8::Array>();
  v8::Local<v8::Array> args = info[2]->IsArray() ? info[2].As<v8::Array>() : v8::Array::New(iso, 0);
  std::vector<SqlStatement> batch(sqls->Length());
  for (uint32_t i = 0; i < sqls->Length(); ++i) {
    v8::Local<v8::Value> s, a;
    if (sqls->Get(ctx, i).ToLocal(&s)) batch[i].sql = Utf8(iso, s);
    if (i < args->Length() && args->Get(ctx, i).ToLocal(&a) && a->IsArray()) {
      v8::Local<v8::Array> arr = a.As<v8::Array>();
      batch[i].args.resize(arr->Length());
      for (uint32_t j = 0; j < arr->Length(); ++j) {
        v8::Local<v8::Value> v;
        if (arr->Get(ctx, j).ToLocal(&v)) ToSqlValue(iso, ctx, v, &batch[i].args[j]);
      }
    }
  }
  bool read_only = info[3]->BooleanValue(iso);
  bool atomic = info.Length() > 5 && info[5]->BooleanValue(iso);
  uint32_t id = Keep(st.get(), iso, info[4]);
  auto deliver = [st, id](std::vector<SqlResult> results) {
    auto shared = std::make_shared<std::vector<SqlResult>>(std::move(results));
    PostToJs(st, [st, id, shared](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
      v8::Local<v8::Function> cb;
      if (!Take(st.get(), iso, id, &cb)) return;
      v8::Local<v8::Array> out = v8::Array::New(iso, static_cast<int>(shared->size()));
      v8::Local<v8::String> k_error = Str(iso, "error"), k_insert = Str(iso, "insertId"),
                            k_rows_affected = Str(iso, "rowsAffected"), k_rows = Str(iso, "rows");
      for (uint32_t i = 0; i < shared->size(); ++i) {
        SqlResult& r = (*shared)[i];
        v8::Local<v8::Object> o = v8::Object::New(iso);
        if (!r.error.empty()) {
          (void)o->Set(ctx, k_error, Str(iso, r.error));
        } else {
          (void)o->Set(ctx, k_insert, v8::Number::New(iso, static_cast<double>(r.insert_id)));
          (void)o->Set(ctx, k_rows_affected, v8::Number::New(iso, static_cast<double>(r.rows_affected)));
          v8::Local<v8::Array> rows = v8::Array::New(iso, static_cast<int>(r.rows.size()));
          std::vector<v8::Local<v8::String>> names;
          for (auto& c : r.columns) names.push_back(Str(iso, c));
          for (uint32_t ri = 0; ri < r.rows.size(); ++ri) {
            v8::Local<v8::Object> row = v8::Object::New(iso);
            for (size_t ci = 0; ci < names.size(); ++ci) (void)row->Set(ctx, names[ci], FromSqlValue(iso, r.rows[ri][ci]));
            (void)rows->Set(ctx, ri, row);
          }
          (void)o->Set(ctx, k_rows, rows);
        }
        (void)out->Set(ctx, i, o);
      }
      v8::Local<v8::Value> argv[] = {out};
      Call(iso, ctx, cb, 1, argv);
    });
  };
  if (hit == st->handles.end()) {
    std::vector<SqlResult> results(batch.size());
    for (auto& r : results) r.error = "database is closed";
    deliver(std::move(results));
    return;
  }
  hit->second->Exec(h, std::move(batch), read_only, deliver, atomic);
}

void DeliverError(const std::shared_ptr<IsolateState>& st, uint32_t id, std::string error) {
  PostToJs(st, [st, id, error](v8::Isolate* iso, v8::Local<v8::Context> ctx) {
    v8::Local<v8::Function> cb;
    if (!Take(st.get(), iso, id, &cb)) return;
    v8::Local<v8::Value> argv[] = {error.empty() ? v8::Null(iso).As<v8::Value>() : Str(iso, error).As<v8::Value>()};
    Call(iso, ctx, cb, 1, argv);
  });
}

void SqlClose(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  auto st = StateFrom(info);
  if (!st || info.Length() < 2 || !info[1]->IsFunction()) return ThrowType(iso, "sqlClose(handle, cb)");
  int h = info[0]->Int32Value(iso->GetCurrentContext()).FromMaybe(0);
  uint32_t id = Keep(st.get(), iso, info[1]);
  auto it = st->handles.find(h);
  if (it == st->handles.end()) return DeliverError(st, id, "");
  SqlService* svc = it->second;
  st->handles.erase(it);
  svc->Close(h, [st, id](std::string e) { DeliverError(st, id, std::move(e)); });
}

void SqlDelete(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  auto st = StateFrom(info);
  if (!st || info.Length() < 3 || !info[2]->IsFunction()) return ThrowType(iso, "sqlDelete(area, name, cb)");
  SqlService* svc = Area(Utf8(iso, info[0]));
  if (!svc) return ThrowType(iso, "sqlDelete: unknown area");
  uint32_t id = Keep(st.get(), iso, info[2]);
  svc->Delete(Utf8(iso, info[1]), [st, id](std::string e) { DeliverError(st, id, std::move(e)); });
}

void Estimate(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  std::string root = DataRoot();
  uint64_t usage = DirectorySize(root) + DirectorySize(root + "/idb") + DirectorySize(root + "/cache");
  uint64_t quota;
  {
    std::lock_guard<std::mutex> l(G().mu);
    quota = G().options.quota_bytes;
  }
  uint64_t free_bytes = FreeBytes(G().options.data_dir.empty() ? "." : G().options.data_dir);
  if (free_bytes && usage + free_bytes < quota) quota = usage + free_bytes;
  v8::Local<v8::Object> o = v8::Object::New(iso);
  (void)o->Set(ctx, Str(iso, "usage"), v8::Number::New(iso, static_cast<double>(usage)));
  (void)o->Set(ctx, Str(iso, "quota"), v8::Number::New(iso, static_cast<double>(quota)));
  info.GetReturnValue().Set(o);
}

void SetFn(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Object> target, const char* name,
           v8::FunctionCallback cb) {
  v8::Local<v8::Function> fn = v8::Function::New(ctx, cb).ToLocalChecked();
  fn->SetName(Str(iso, name));
  (void)target->Set(ctx, Str(iso, name), fn);
}

// App-private files dir when the shell did not call iwn_storage_configure():
// /data/data/<package>/files (the package from /proc/self/cmdline).
std::string DefaultDataDir() {
#if defined(__ANDROID__)
  std::string cmdline;
  if (ReadWholeFile("/proc/self/cmdline", &cmdline)) {
    std::string pkg = cmdline.substr(0, cmdline.find('\0'));
    size_t colon = pkg.find(':');  // ":process" suffix
    if (colon != std::string::npos) pkg.erase(colon);
    if (!pkg.empty() && pkg.find('/') == std::string::npos) return "/data/data/" + pkg + "/files";
  }
#endif
  const char* home = getenv("IWN_DATA_DIR");
  return home ? home : "./iwn-data";
}

[[maybe_unused]] bool g_shutdown_hook_added = false;

// Ends what an isolate state owns (on its JS thread). Pending completions find
// alive == false and drop their results without touching V8.
void DisposeState(const std::shared_ptr<IsolateState>& st) {
  st->alive = false;
  for (auto& [h, svc] : st->handles) svc->Close(h, [](std::string) {});
  st->handles.clear();
  for (auto& [id, cb] : st->callbacks) cb.Reset();
  st->callbacks.clear();
  st->context.Reset();
}

}  // namespace

void iwn_storage_configure(const IwnStorageOptions& options) {
  std::lock_guard<std::mutex> l(G().mu);
  G().options = options;
  EnsureDir(options.data_dir + "/iwn");
}

void iwn_register_storage(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  auto st = std::make_shared<IsolateState>();
  st->isolate = isolate;
  st->context.Reset(isolate, ctx);
  bool configured;
  {
    std::lock_guard<std::mutex> l(G().mu);
    configured = !G().options.data_dir.empty();
  }
  if (!configured) {
    IwnStorageOptions o;
    o.data_dir = DefaultDataDir();
    iwn_storage_configure(o);
  }
#if defined(IWN_HAVE_CORE_RUNTIME)
  if (iwn::Runtime* rt = iwn::Runtime::From(isolate)) {
    st->runtime = rt;
    if (!g_shutdown_hook_added) {
      g_shutdown_hook_added = true;
      // PROC-7 / NET-STORE-2: localStorage is durable before teardown.
      rt->add_shutdown_hook([] { iwn_storage_flush_all(); });
    }
  }
#endif
  std::shared_ptr<IsolateState> old;
  {
    std::lock_guard<std::mutex> l(g_states_mu);
    auto& slot = g_states[isolate];
    old = std::move(slot);
    slot = st;
  }
  // A new context in the same isolate (location.reload()): the old page's SQL
  // connections close (open transactions roll back, so they cannot lock the
  // reloaded page out) and its callbacks are released, on this JS thread.
  if (old) DisposeState(old);
  StartKvLoad();
  v8::Local<v8::Object> s = v8::Object::New(isolate);
  SetFn(isolate, ctx, s, "kvOpen", KvOpen);
  SetFn(isolate, ctx, s, "kvSet", KvSet);
  SetFn(isolate, ctx, s, "kvRemove", KvRemove);
  SetFn(isolate, ctx, s, "kvClear", KvClear);
  SetFn(isolate, ctx, s, "kvFlush", KvFlush);
  SetFn(isolate, ctx, s, "sqlOpen", SqlOpen);
  SetFn(isolate, ctx, s, "sqlExec", SqlExec);
  SetFn(isolate, ctx, s, "sqlClose", SqlClose);
  SetFn(isolate, ctx, s, "sqlDelete", SqlDelete);
  SetFn(isolate, ctx, s, "estimate", Estimate);
  (void)natives->Set(ctx, Str(isolate, "storage"), s);
}

void iwn_storage_flush_all() {
  if (KvStore* kv = Kv(true)) kv->Flush(true);
}

void iwn_storage_dispose_isolate(v8::Isolate* isolate) {
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
