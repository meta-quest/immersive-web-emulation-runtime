// Thin V8 layer over the image core. Written from the V8 embedder headers (15.5) and docs. Everything that touches V8
// runs on the isolate's thread; pool threads only see plain C++ (bytes in, PixelStore out) and post a completion.
//
// State: one State per registration (context). The isolate keeps exactly one current State; registering again in
// the same isolate (location.reload(), PROC-8) retires the previous one: its context and pending promises are
// released at once, so the old page's heap can be collected, and its late completions are dropped. A retired State
// is freed (PruneRetired) once its context has been collected and all its handles finalized; DisposeIsolate frees
// the rest.
//
// The natives functions do not hold a State pointer: their data is the State's id, looked up in a registry on every
// call. A function called after its State was freed (after DisposeIsolate, e.g. a FinalizationRegistry callback
// run while the embedder pumps tasks before Isolate::Dispose) finds nothing and throws, or does nothing.
//
// Page JS can call these natives directly (globalThis.__iwn), so they never run page code between checking an input
// and using it: options are read as own data properties only (no getters, no prototype chain, no proxies).
//
// Completions reach the JS thread, in order of preference, through: the core runtime's post_task (page isolate),
// the shared per-isolate loop hooks (workers, iwn/loop_hooks_registry.h), BindingConfig::post, the V8 platform's
// foreground task runner, or JS polling.
#include "iwn/image/v8_binding.h"

#include <v8-array-buffer.h>
#include <v8-container.h>
#include <v8-exception.h>
#include <v8-external-memory-accounter.h>
#include <v8-external.h>
#include <v8-function-callback.h>
#include <v8-function.h>
#include <v8-microtask-queue.h>
#include <v8-microtask.h>
#include <v8-persistent-handle.h>
#include <v8-primitive.h>
#include <v8-promise.h>
#include <v8-template.h>
#include <v8-typed-array.h>
#include <v8-weak-callback-info.h>

#include <algorithm>
#include <atomic>
#include <cstring>
#include <deque>
#include <mutex>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "iwn/image/decode.h"
#include "iwn/image/pool.h"
#include "iwn/image/transform.h"

#if defined(IWN_HAVE_CORE_RUNTIME)
#include "iwn/core/json.h"
#include "iwn/core/runtime.h"
#endif
#if defined(IWN_IMAGE_HAVE_LOOP_HOOKS)
#include "iwn/loop_hooks_registry.h"
#endif

namespace iwn::image {
namespace {

// V8 allows tags 0..V8_EMBEDDER_DATA_TAG_COUNT-1 (15) for the whole embedder; the runtime's module registry hands
// them out. Handles are also checked with FunctionTemplate::HasInstance, so the default tag is safe.
#ifndef IWN_EMBEDDER_TAG_IMAGE
#define IWN_EMBEDDER_TAG_IMAGE 0
#endif
constexpr v8::EmbedderDataTypeTag kHandleTag = IWN_EMBEDDER_TAG_IMAGE;

std::mutex g_config_mu;
BindingConfig g_config;
std::atomic<bool> g_configured_pool{false};

BindingConfig Config() {
  std::lock_guard<std::mutex> lock(g_config_mu);
  return g_config;
}

#if defined(__ANDROID__)
std::unique_ptr<PixelStore> HardwareBufferAllocator(uint32_t w, uint32_t h) {
  auto store = PixelStore::AllocateHardwareBuffer(w, h);
  return store ? std::move(store) : PixelStore::AllocateHeap(w, h);
}
#endif

StoreAllocator OutputAllocator(const BindingConfig& c) {
#if defined(__ANDROID__)
  if (c.gpu_backed) return &HardwareBufferAllocator;
#else
  (void)c;
#endif
  return &HeapAllocator;
}

struct State;

// Lives as long as the JS handle object (or until close()). `state` is null once DisposeIsolate freed the box's
// State while V8 still owed it a second-pass weak callback (see Dispose).
struct HandleBox {
  State* state = nullptr;
  std::shared_ptr<const PixelStore> store;
  v8::ExternalMemoryAccounter accounter;
  size_t accounted = 0;
  v8::Global<v8::Object> self;
};

// Result of a pool job, handed back to the JS thread.
struct Completion {
  uint64_t id = 0;
  Status status = Status::kOk;
  std::string message;
  std::shared_ptr<const PixelStore> store;
};

using CancelFlag = std::shared_ptr<std::atomic<bool>>;
using Job = std::function<Completion(const std::atomic<bool>* cancel)>;

struct Pending {
  v8::Global<v8::Promise::Resolver> resolver;
  CancelFlag cancel;
};

enum class Mode : uint8_t { kRuntime, kLoopHooks, kPost, kPlatform, kPoll };

struct State : std::enable_shared_from_this<State> {
  uint64_t id = 0;  // key in Live(); the natives' function data
  v8::Isolate* isolate = nullptr;
  Mode mode = Mode::kPoll;
  void* runtime = nullptr;  // iwn::Runtime* in kRuntime mode
  std::function<void(v8::Isolate*, std::function<void()>)> post;  // kPost
  std::shared_ptr<v8::TaskRunner> runner;                           // kPlatform

  // JS thread only.
  v8::Global<v8::Context> context;
  // Weak (phantom) after retirement: empties once the old context is collected. Until then the old page's natives
  // functions, which point at this State, may still be called, so the State is kept.
  v8::Global<v8::Context> weak_context;
  v8::Global<v8::FunctionTemplate> handle_template;
  std::unordered_map<uint64_t, Pending> pending;
  uint64_t next_id = 1;
  size_t hook_refs = 0;  // kLoopHooks: loop refs taken by Submit and not yet given back (Deliver or Retire)
  std::unordered_set<HandleBox*> boxes;
  size_t live_bytes = 0;

  // Cleared (under post_mu) when the State is retired or the isolate disposed: after that no pool thread posts
  // anything for it and queued deliveries do nothing.
  std::mutex post_mu;
  std::atomic<bool> alive{true};
  std::deque<Completion> queue;  // kPoll; guarded by post_mu
};

struct IsolateEntry {
  std::shared_ptr<State> current;
  std::vector<std::shared_ptr<State>> retired;
  bool hooks_installed = false;
};

// Leaked on purpose: no static destructor may run Global destructors after the isolate is gone (exit()).
std::mutex& StatesMu() {
  static auto* mu = new std::mutex();
  return *mu;
}
std::unordered_map<v8::Isolate*, IsolateEntry>& States() {
  static auto* map = new std::unordered_map<v8::Isolate*, IsolateEntry>();
  return *map;
}

// States the natives may still use, by id. Entries are removed (JS thread, under StatesMu) before a State is
// disposed or pruned. Ids are never reused.
std::unordered_map<uint64_t, State*>& Live() {
  static auto* map = new std::unordered_map<uint64_t, State*>();
  return *map;
}
uint64_t g_next_state_id = 1;  // guarded by StatesMu

class LambdaTask final : public v8::Task {
 public:
  explicit LambdaTask(std::function<void()> fn) : fn_(std::move(fn)) {}
  void Run() override { fn_(); }

 private:
  std::function<void()> fn_;
};

v8::Local<v8::String> Str(v8::Isolate* iso, const char* s) {
  return v8::String::NewFromUtf8(iso, s, v8::NewStringType::kInternalized).ToLocalChecked();
}

// Own data properties only: never runs page setters (a throwing Object.prototype setter cannot abort the process).
void Put(v8::Local<v8::Context> ctx, v8::Local<v8::Object> obj, v8::Local<v8::Name> key, v8::Local<v8::Value> v) {
  (void)obj->CreateDataProperty(ctx, key, v).FromMaybe(false);
}

void Throw(v8::Isolate* iso, const char* message) {
  iso->ThrowException(v8::Exception::TypeError(Str(iso, message)));
}

// Null once the State was disposed (or pruned): the caller then throws or does nothing.
State* StateOf(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (!info.Data()->IsNumber()) return nullptr;
  const uint64_t id = static_cast<uint64_t>(info.Data().As<v8::Number>()->Value());
  std::lock_guard<std::mutex> lock(StatesMu());
  auto it = Live().find(id);
  return it == Live().end() ? nullptr : it->second;
}

#define IWN_STATE_OR_THROW(st, info, name)                                     \
  State* st = StateOf(info);                                                   \
  if (!st) return Throw((info).GetIsolate(), name ": the image runtime has been disposed")
#define IWN_STATE_OR_RETURN(st, info) \
  State* st = StateOf(info);          \
  if (!st) return

void ReleaseBox(HandleBox* box) {
  if (box->accounted) {
    box->accounter.Decrease(box->state->isolate, box->accounted);
    box->state->live_bytes -= std::min(box->state->live_bytes, box->accounted);
    box->accounted = 0;
  }
  box->store.reset();
}

void SetSize(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Object> obj, const PixelStore* store) {
  Put(ctx, obj, Str(iso, "width"), v8::Integer::NewFromUnsigned(iso, store ? store->width() : 0));
  Put(ctx, obj, Str(iso, "height"), v8::Integer::NewFromUnsigned(iso, store ? store->height() : 0));
  Put(ctx, obj, Str(iso, "premultiplied"), v8::Boolean::New(iso, store && store->alpha() == AlphaMode::kPremultiplied));
  Put(ctx, obj, Str(iso, "opaque"), v8::Boolean::New(iso, store && store->opaque()));
}

void PruneRetired(v8::Isolate* isolate);
std::atomic<size_t> g_deferred_created{0}, g_deferred_freed{0};  // test counters (DeferredBoxStatsForTesting)

void FinalizeSecondPass(const v8::WeakCallbackInfo<HandleBox>& data) {
  HandleBox* box = data.GetParameter();
  State* st = box->state;
  if (!st) {  // its isolate's state was disposed after the first pass ran; the pixels are already released
    g_deferred_freed.fetch_add(1);
    delete box;
    return;
  }
  ReleaseBox(box);
  st->boxes.erase(box);
  delete box;
  if (!st->alive.load() && st->boxes.empty()) PruneRetired(data.GetIsolate());  // st may be freed here
}

void FinalizeFirstPass(const v8::WeakCallbackInfo<HandleBox>& data) {
  data.GetParameter()->self.Reset();
  data.SetSecondPassCallback(FinalizeSecondPass);
}

v8::Local<v8::Object> NewHandle(State* st, v8::Local<v8::Context> ctx, std::shared_ptr<const PixelStore> store) {
  v8::Isolate* iso = st->isolate;
  v8::EscapableHandleScope scope(iso);
  v8::Local<v8::FunctionTemplate> tmpl = st->handle_template.Get(iso);
  v8::Local<v8::Object> obj;
  if (!tmpl->InstanceTemplate()->NewInstance(ctx).ToLocal(&obj)) return v8::Local<v8::Object>();
  auto* box = new HandleBox();
  box->state = st;
  box->store = std::move(store);
  if (box->store) {
    box->accounted = box->store->byte_size();
    box->accounter.Increase(iso, box->accounted);
    st->live_bytes += box->accounted;
  }
  obj->SetAlignedPointerInInternalField(0, box, kHandleTag);
  box->self.Reset(iso, obj);
  box->self.SetWeak(box, FinalizeFirstPass, v8::WeakCallbackType::kParameter);
  st->boxes.insert(box);
  SetSize(iso, ctx, obj, box->store.get());
  return scope.Escape(obj);
}

HandleBox* BoxOf(State* st, v8::Local<v8::Value> value) {
  if (!value->IsObject() || st->handle_template.IsEmpty()) return nullptr;
  v8::Local<v8::Object> obj = value.As<v8::Object>();
  if (!st->handle_template.Get(st->isolate)->HasInstance(obj)) return nullptr;
  return static_cast<HandleBox*>(obj->GetAlignedPointerFromInternalField(0, kHandleTag));
}

v8::Local<v8::Value> MakeError(v8::Isolate* iso, v8::Local<v8::Context> ctx, Status status, const std::string& msg) {
  std::string text = std::string("image: ") + StatusName(status) + (msg.empty() ? "" : ": " + msg);
  v8::Local<v8::String> message;
  if (!v8::String::NewFromUtf8(iso, text.c_str()).ToLocal(&message)) message = Str(iso, "image: error");
  v8::Local<v8::Value> err = v8::Exception::Error(message);
  if (err->IsObject()) Put(ctx, err.As<v8::Object>(), Str(iso, "code"), Str(iso, StatusName(status)));
  return err;
}

void RunMicrotasksIfExplicit(v8::Isolate* iso) {
  if (iso->GetMicrotasksPolicy() == v8::MicrotasksPolicy::kExplicit) iso->PerformMicrotaskCheckpoint();
}

#if defined(IWN_IMAGE_HAVE_LOOP_HOOKS)
void RunHookTask(void* arg) {
  std::unique_ptr<std::function<void()>> fn(static_cast<std::function<void()>*>(arg));
  (*fn)();
}
#endif

// JS thread. Settles the job's promise (if it is still pending: cancel() may have settled it already).
void Deliver(State* st, Completion c) {
#if defined(IWN_IMAGE_HAVE_LOOP_HOOKS)
  if (st->mode == Mode::kLoopHooks && st->hook_refs > 0) {  // one ref per job; Retire gave back the rest
    --st->hook_refs;
    if (const IwnLoopHooks* h = iwn::LoopHooksFor(st->isolate)) h->unref(h->user);
  }
#endif
  if (!st->alive.load()) return;
  v8::Isolate* iso = st->isolate;
  v8::HandleScope scope(iso);
  v8::Local<v8::Context> ctx = st->context.Get(iso);
  v8::Context::Scope context_scope(ctx);
  auto it = st->pending.find(c.id);
  if (it == st->pending.end()) return;
  v8::Local<v8::Promise::Resolver> resolver = it->second.resolver.Get(iso);
  st->pending.erase(it);
  if (c.status == Status::kOk) {
    v8::Local<v8::Object> handle = NewHandle(st, ctx, std::move(c.store));
    if (handle.IsEmpty()) {
      (void)resolver->Reject(ctx, MakeError(iso, ctx, Status::kOutOfMemory, "cannot create the handle")).FromMaybe(false);
    } else {
      (void)resolver->Resolve(ctx, handle).FromMaybe(false);
    }
  } else {
    (void)resolver->Reject(ctx, MakeError(iso, ctx, c.status, c.message)).FromMaybe(false);
  }
}

// Pool thread. Hands the completion to the JS thread; nothing happens once the State is retired or disposed (the
// lock makes "check alive, then post" atomic against DisposeIsolate/retirement, so no post hook is ever called for
// a disposed isolate).
void Complete(const std::shared_ptr<State>& st, Completion c) {
  std::lock_guard<std::mutex> lock(st->post_mu);
  if (!st->alive.load()) return;
  if (st->mode == Mode::kPoll) {
    st->queue.push_back(std::move(c));
    return;
  }
  std::weak_ptr<State> weak = st;
  v8::Isolate* iso = st->isolate;
  auto deliver = [weak, c = std::move(c), iso, mode = st->mode]() mutable {
    std::shared_ptr<State> s = weak.lock();
    if (!s) return;
    Deliver(s.get(), std::move(c));
    if (mode != Mode::kRuntime) RunMicrotasksIfExplicit(iso);  // the runtime's post_task runs its own checkpoint
  };
  switch (st->mode) {
    case Mode::kRuntime:
#if defined(IWN_HAVE_CORE_RUNTIME)
      static_cast<iwn::Runtime*>(st->runtime)->post_task(std::move(deliver));
#endif
      break;
    case Mode::kLoopHooks: {
#if defined(IWN_IMAGE_HAVE_LOOP_HOOKS)
      const IwnLoopHooks* h = iwn::LoopHooksFor(iso);  // unbound: the loop is gone, drop
      if (!h) break;
      auto* task = new std::function<void()>(std::move(deliver));
      if (!h->post(h->user, &RunHookTask, task)) delete task;
#endif
      break;
    }
    case Mode::kPost:
      st->post(iso, std::move(deliver));
      break;
    case Mode::kPlatform:
      st->runner->PostTask(std::make_unique<LambdaTask>(std::move(deliver)));
      break;
    case Mode::kPoll:
      break;
  }
}

// Posts `job` to the pool; its result is delivered to the promise returned to JS.
v8::Local<v8::Promise> Submit(State* st, v8::Local<v8::Context> ctx, Job job) {
  v8::Isolate* iso = st->isolate;
  v8::Local<v8::Promise::Resolver> resolver = v8::Promise::Resolver::New(ctx).ToLocalChecked();
  if (!st->alive.load()) {
    // A retired page's natives (only reachable if something leaked the old context): never pin it again.
    (void)resolver->Reject(ctx, MakeError(iso, ctx, Status::kCancelled, "page replaced")).FromMaybe(false);
    return resolver->GetPromise();
  }
  const uint64_t id = st->next_id++;
  CancelFlag cancel = std::make_shared<std::atomic<bool>>(false);
  st->pending.emplace(id, Pending{v8::Global<v8::Promise::Resolver>(iso, resolver), cancel});
#if defined(IWN_IMAGE_HAVE_LOOP_HOOKS)
  if (st->mode == Mode::kLoopHooks) {
    if (const IwnLoopHooks* h = iwn::LoopHooksFor(iso)) {  // keep a worker's loop alive until the job delivers
      h->ref(h->user);
      ++st->hook_refs;
    }
  }
#endif
  std::weak_ptr<State> weak = st->shared_from_this();
  TaskPool::Shared().Post([weak, id, job = std::move(job), cancel]() mutable {
    if (std::shared_ptr<State> s = weak.lock(); !s || !s->alive.load()) return;  // retired before it started
    Completion c = cancel->load() ? Completion{0, Status::kCancelled, "", nullptr} : job(cancel.get());
    c.id = id;
    if (std::shared_ptr<State> s = weak.lock()) Complete(s, std::move(c));
  });
  return resolver->GetPromise();
}

// Releases everything a State holds on its context. JS thread.
void Retire(State* st) {
  {
    std::lock_guard<std::mutex> lock(st->post_mu);
    st->alive.store(false);
    st->queue.clear();
  }
  for (auto& [id, p] : st->pending) {
    p.cancel->store(true);  // queued jobs for the old page are skipped
    p.resolver.Reset();
  }
  st->pending.clear();
#if defined(IWN_IMAGE_HAVE_LOOP_HOOKS)
  // A retired State's completions are dropped (never delivered), so their loop refs are given back now; otherwise a
  // worker that replaced its context with jobs in flight would never let its loop finish.
  if (st->mode == Mode::kLoopHooks && st->hook_refs > 0) {
    if (const IwnLoopHooks* h = iwn::LoopHooksFor(st->isolate)) {
      for (; st->hook_refs > 0; --st->hook_refs) h->unref(h->user);
    }
    st->hook_refs = 0;
  }
#endif
  if (!st->context.IsEmpty() && st->weak_context.IsEmpty()) {
    st->weak_context.Reset(st->isolate, st->context);
    st->weak_context.SetWeak();
  }
  st->context.Reset();
}

// Frees a retired State's handles too (isolate disposal). JS thread.
// A box whose first-pass weak callback already ran (its `self` is empty) still has a second-pass callback queued
// with V8, which runs if the embedder pumps tasks before Isolate::Dispose(). Such a box is not deleted here: it is
// detached from the State (state = nullptr) and freed by that second pass (or leaked, a few dozen bytes, if the
// isolate is disposed first).
void Dispose(State* st) {
  Retire(st);
  for (HandleBox* box : st->boxes) {
    ReleaseBox(box);
    if (box->self.IsEmpty()) {
      box->state = nullptr;
      g_deferred_created.fetch_add(1);
      continue;
    }
    box->self.Reset();
    delete box;
  }
  st->boxes.clear();
  st->handle_template.Reset();
  st->weak_context.Reset();
}

// Frees retired registrations that can no longer be reached: their context was collected (so no natives function
// pointing at the State survives) and every handle they made was finalized. Their remaining V8 handles are reset
// here, on the JS thread, so the State's destructor (possibly on a pool thread that still holds a weak_ptr lock)
// touches no V8 state. Keeps IsolateEntry::retired bounded over a long session of reloads.
void PruneRetired(v8::Isolate* isolate) {
  std::vector<std::shared_ptr<State>> dead;
  {
    std::lock_guard<std::mutex> lock(StatesMu());
    auto it = States().find(isolate);
    if (it == States().end()) return;
    auto& retired = it->second.retired;
    for (auto r = retired.begin(); r != retired.end();) {
      State* st = r->get();
      if (st->boxes.empty() && st->weak_context.IsEmpty() && st->context.IsEmpty() && st->pending.empty()) {
        Live().erase(st->id);
        dead.push_back(std::move(*r));
        r = retired.erase(r);
      } else {
        ++r;
      }
    }
  }
  for (auto& st : dead) st->handle_template.Reset();
}

// --- option parsing (the JS layer validated values already; this only converts) ---------------------------------

// Options are read as own data properties only. Natives are reachable from page JS (globalThis.__iwn), and an
// ordinary Get would run getters, Object.prototype getters (prototype pollution in any bundled library) or proxy
// traps in the middle of a native, between its input checks and their use. None of these reads runs JS: proxies are
// rejected up front, GetOwnPropertyDescriptor on an ordinary object or array runs no user code, and the descriptor
// is a fresh plain object whose own "value" is read only when it exists.
enum class Own { kAbsent, kValue, kError };

Own OwnData(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, v8::Local<v8::Name> key,
            v8::Local<v8::Value>* out) {
  v8::Local<v8::Value> desc;
  if (!o->GetOwnPropertyDescriptor(ctx, key).ToLocal(&desc)) return Own::kError;
  if (!desc->IsObject()) return Own::kAbsent;  // undefined: no own property
  v8::Local<v8::Object> d = desc.As<v8::Object>();
  v8::Local<v8::String> value_key = Str(iso, "value");
  if (!d->HasRealNamedProperty(ctx, value_key).FromMaybe(false)) return Own::kAbsent;  // accessor: ignored
  if (!d->Get(ctx, value_key).ToLocal(out)) return Own::kError;
  return Own::kValue;
}

Own OwnData(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Object> o, const char* key,
            v8::Local<v8::Value>* out) {
  return OwnData(iso, ctx, o, Str(iso, key), out);
}

// 0 for a missing, non-numeric or out-of-range value.
uint32_t ToUint(v8::Local<v8::Value> v) {
  if (!v->IsNumber()) return 0;
  double d = v.As<v8::Number>()->Value();
  return d > 0 && d < 4294967296.0 ? static_cast<uint32_t>(d) : 0;
}

// options: { applyExif: bool, flipY: bool, alpha: 0 keep | 1 premultiply | 2 unpremultiply,
//            crop?: [x, y, w, h], resizeWidth?: n, resizeHeight?: n, quality?: 0..3 }
// Booleans count only when they are booleans (no ToBoolean on objects). Returns false, with an exception pending
// when one was raised, for a proxy, a malformed crop or a failed property read.
bool ParseProcess(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Value> value, ProcessOptions* p,
                  bool* apply_exif) {
  *apply_exif = true;
  if (!value->IsObject()) return true;
  if (value->IsProxy()) return false;
  v8::TryCatch tc(iso);
  tc.SetVerbose(false);
  v8::Local<v8::Object> o = value.As<v8::Object>();
  auto fail = [&] {
    if (tc.HasCaught()) tc.ReThrow();
    return false;
  };
  v8::Local<v8::Value> v;
  auto read = [&](const char* key, v8::Local<v8::Value>* out) {
    Own r = OwnData(iso, ctx, o, key, out);
    if (r == Own::kAbsent) *out = v8::Undefined(iso);
    return r != Own::kError;
  };
  if (!read("applyExif", &v)) return fail();
  if (v->IsBoolean()) *apply_exif = v->IsTrue();
  if (!read("flipY", &v)) return fail();
  p->flip_y = v->IsTrue();
  if (!read("alpha", &v)) return fail();
  const uint32_t alpha = ToUint(v);
  p->alpha = alpha == 1 ? AlphaRequest::kPremultiplied
                        : (alpha == 2 ? AlphaRequest::kUnpremultiplied : AlphaRequest::kKeep);
  if (!read("resizeWidth", &v)) return fail();
  p->resize_width = ToUint(v);
  if (!read("resizeHeight", &v)) return fail();
  p->resize_height = ToUint(v);
  if (!read("quality", &v)) return fail();
  p->quality = static_cast<ResizeQuality>(std::min<uint32_t>(ToUint(v), 3));
  if (!read("crop", &v)) return fail();
  if (v->IsArray()) {  // a JSArray (a proxy is not one)
    v8::Local<v8::Array> a = v.As<v8::Array>();
    if (a->Length() != 4) return false;
    double r[4];
    for (uint32_t i = 0; i < 4; ++i) {
      v8::Local<v8::String> index;
      v8::Local<v8::Value> e;
      if (!v8::Integer::NewFromUnsigned(iso, i)->ToString(ctx).ToLocal(&index)) return fail();
      if (OwnData(iso, ctx, a, index, &e) != Own::kValue || !e->IsNumber()) return fail();
      r[i] = e.As<v8::Number>()->Value();
      if (!(r[i] > -1e12 && r[i] < 1e12)) return false;
    }
    if (r[2] < 1 || r[3] < 1) return false;
    p->has_crop = true;
    p->crop = Rect{static_cast<int64_t>(r[0]), static_cast<int64_t>(r[1]), static_cast<int64_t>(r[2]),
                   static_cast<int64_t>(r[3])};
  }
  if (tc.HasCaught()) return fail();
  return true;
}

// Returns the bytes of an ArrayBuffer / view without copying, kept alive by the backing store.
bool GetBytes(v8::Local<v8::Value> value, std::shared_ptr<v8::BackingStore>* bs, size_t* offset, size_t* length) {
  if (value->IsArrayBuffer()) {
    auto ab = value.As<v8::ArrayBuffer>();
    *bs = ab->GetBackingStore();
    *offset = 0;
    *length = ab->ByteLength();
    return true;
  }
  if (value->IsArrayBufferView()) {
    auto view = value.As<v8::ArrayBufferView>();
    *bs = view->Buffer()->GetBackingStore();
    *offset = view->ByteOffset();
    *length = view->ByteLength();
    return true;
  }
  return false;
}

Completion DecodeJob(const uint8_t* data, size_t size, DecodeOptions opts, const std::atomic<bool>* cancel) {
  opts.cancel = cancel;
  DecodeResult r = Decode(data, size, opts);
  return Completion{0, r.status, r.message, std::shared_ptr<const PixelStore>(std::move(r.store))};
}

bool DecodeOptionsFrom(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Value> value, DecodeOptions* opts) {
  if (!ParseProcess(iso, ctx, value, &opts->process, &opts->apply_exif_orientation)) return false;
  BindingConfig cfg = Config();
  opts->process.allocator = OutputAllocator(cfg);
  opts->allow_os_formats = cfg.allow_os_formats;
  return true;
}

// --- natives ------------------------------------------------------------------------------------------------------

// decode(bytes: ArrayBuffer | ArrayBufferView, options) -> Promise<handle>
// The caller must not modify `bytes` until the promise settles (web/image only passes buffers it owns).
void JsDecode(const v8::FunctionCallbackInfo<v8::Value>& info) {
  IWN_STATE_OR_THROW(st, info, "image.decode");
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  if (!info[0]->IsArrayBuffer() && !info[0]->IsArrayBufferView()) {
    return Throw(iso, "image.decode: expected an ArrayBuffer or view");
  }
  DecodeOptions opts;
  if (!DecodeOptionsFrom(iso, ctx, info[1], &opts)) {
    if (!iso->HasPendingException()) Throw(iso, "image.decode: bad options");
    return;
  }
  // Offset and length are taken after the options (and nothing between here and the copy runs JS).
  std::shared_ptr<v8::BackingStore> bs;
  size_t offset = 0, length = 0;
  if (!GetBytes(info[0], &bs, &offset, &length)) return Throw(iso, "image.decode: expected an ArrayBuffer or view");
  if (bs && bs->IsResizableByUserJavaScript()) {
    // Copy: a resizable buffer could shrink under the decoder.
    auto copy = std::make_shared<std::vector<uint8_t>>(static_cast<const uint8_t*>(bs->Data()) + offset,
                                                       static_cast<const uint8_t*>(bs->Data()) + offset + length);
    info.GetReturnValue().Set(Submit(st, ctx, [copy, opts](const std::atomic<bool>* cancel) {
      return DecodeJob(copy->data(), copy->size(), opts, cancel);
    }));
    return;
  }
  info.GetReturnValue().Set(Submit(st, ctx, [bs, offset, length, opts](const std::atomic<bool>* cancel) {
    const uint8_t* data = bs ? static_cast<const uint8_t*>(bs->Data()) + offset : nullptr;
    return DecodeJob(data, length, opts, cancel);
  }));
}

// decodeBase64(text: string, options) -> Promise<handle>: a data: URL's base64 payload, decoded (forgiving-base64)
// and then as an image, both on the pool. The JS thread only copies the characters. Invalid base64 rejects with
// code 'corrupt'.
void JsDecodeBase64(const v8::FunctionCallbackInfo<v8::Value>& info) {
  IWN_STATE_OR_THROW(st, info, "image.decodeBase64");
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  if (!info[0]->IsString()) return Throw(iso, "image.decodeBase64: expected a string");
  v8::Local<v8::String> text = info[0].As<v8::String>();
  DecodeOptions opts;
  if (!DecodeOptionsFrom(iso, ctx, info[1], &opts)) {
    if (!iso->HasPendingException()) Throw(iso, "image.decodeBase64: bad options");
    return;
  }
  auto chars = std::make_shared<std::vector<uint8_t>>();
  if (text->IsOneByte()) {
    chars->resize(static_cast<size_t>(text->Length()));
    if (!chars->empty()) text->WriteOneByte(iso, 0, static_cast<uint32_t>(chars->size()), chars->data());
  } else {
    // Two-byte representation: UTF-8 keeps ASCII as is and turns everything else into bytes >= 0x80, which
    // forgiving-base64 rejects, as it should.
    chars->resize(text->Utf8Length(iso));
    if (!chars->empty()) chars->resize(text->WriteUtf8(iso, reinterpret_cast<char*>(chars->data()), chars->size()));
  }
  info.GetReturnValue().Set(Submit(st, ctx, [chars, opts](const std::atomic<bool>* cancel) {
    std::vector<uint8_t> bytes;
    if (!ForgivingBase64Decode(chars->data(), chars->size(), &bytes)) {
      return Completion{0, Status::kCorrupt, "invalid base64 in data: URL", nullptr};
    }
    std::vector<uint8_t>().swap(*chars);  // the text is no longer needed
    return DecodeJob(bytes.data(), bytes.size(), opts, cancel);
  }));
}

// fromPixels(rgba: ArrayBufferView, width, height, premultiplied: bool, options) -> Promise<handle>
// Snapshots the pixels now (ImageData can change right after the call), processes them on the pool.
void JsFromPixels(const v8::FunctionCallbackInfo<v8::Value>& info) {
  IWN_STATE_OR_THROW(st, info, "image.fromPixels");
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  if (!info[0]->IsArrayBufferView() || !info[1]->IsUint32() || !info[2]->IsUint32()) {
    return Throw(iso, "image.fromPixels: expected (pixels, width, height, premultiplied, options)");
  }
  const uint32_t w = info[1].As<v8::Uint32>()->Value(), h = info[2].As<v8::Uint32>()->Value();
  // Same bounds as the transform's output cap (32768 per side, 2^28 px), checked before any size product is formed;
  // with them w * h * 4 <= 2^30 and nothing below can wrap.
  uint64_t pixels = 0;
  if (w == 0 || h == 0 || w > 32768 || h > 32768 || __builtin_mul_overflow(uint64_t{w}, uint64_t{h}, &pixels) ||
      pixels > PixelStore::kMaxPixels) {
    return Throw(iso, "image.fromPixels: width and height must be 1..32768 with width * height <= 2^28");
  }
  ProcessOptions p;
  bool apply_exif = true;
  if (!ParseProcess(iso, ctx, info[4], &p, &apply_exif)) {
    if (!iso->HasPendingException()) Throw(iso, "image.fromPixels: bad options");
    return;
  }
  const bool premultiplied = info[3]->BooleanValue(iso);  // ToBoolean runs no JS
  // The view's offset and length are read after the options and right before the copy; nothing in between runs JS.
  std::shared_ptr<v8::BackingStore> bs;
  size_t offset = 0, length = 0;
  if (!GetBytes(info[0], &bs, &offset, &length) || !bs) {
    return Throw(iso, "image.fromPixels: expected (pixels, width, height, premultiplied, options)");
  }
  if (pixels * 4 != length) {
    return Throw(iso, "image.fromPixels: pixel buffer size does not match width * height * 4");
  }
  p.allocator = OutputAllocator(Config());
  std::unique_ptr<PixelStore> snap = PixelStore::AllocateHeap(w, h);
  if (!snap) return Throw(iso, "image.fromPixels: out of memory");
  {
    MutablePixelView mv = snap->LockWrite();
    const uint8_t* src = static_cast<const uint8_t*>(bs->Data()) + offset;
    for (uint32_t y = 0; y < h; ++y) std::memcpy(mv.data + size_t{y} * mv.stride, src + size_t{y} * w * 4, size_t{w} * 4);
    snap->UnlockWrite();
  }
  snap->set_alpha(premultiplied ? AlphaMode::kPremultiplied : AlphaMode::kUnpremultiplied);
  // std::function needs a copyable callable: park the owned snapshot in a shared holder.
  auto holder = std::make_shared<std::unique_ptr<PixelStore>>(std::move(snap));
  info.GetReturnValue().Set(Submit(st, ctx, [holder, p](const std::atomic<bool>*) {
    std::unique_ptr<PixelStore> owned = std::move(*holder);
    {
      ScopedPixels sp = owned->Read();
      owned->set_opaque(IsOpaque(sp.view()));
    }
    std::unique_ptr<PixelStore> out;
    Status s = Process(std::move(owned), p, &out);  // ours alone: in-place fast paths apply
    return Completion{0, s, "", std::shared_ptr<const PixelStore>(std::move(out))};
  }));
}

// transform(handle, options) -> Promise<handle>; the source handle stays valid.
void JsTransform(const v8::FunctionCallbackInfo<v8::Value>& info) {
  IWN_STATE_OR_THROW(st, info, "image.transform");
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  HandleBox* box = BoxOf(st, info[0]);
  if (!box || !box->store) return Throw(iso, "image.transform: not a live image handle");
  // Our own reference, taken before anything else: the job never depends on the handle staying open.
  std::shared_ptr<const PixelStore> src = box->store;
  ProcessOptions p;
  bool apply_exif = true;
  if (!ParseProcess(iso, ctx, info[1], &p, &apply_exif)) {
    if (!iso->HasPendingException()) Throw(iso, "image.transform: bad options");
    return;
  }
  p.allocator = OutputAllocator(Config());
  info.GetReturnValue().Set(Submit(st, ctx, [src, p](const std::atomic<bool>*) {
    if (IsIdentity(src->width(), src->height(), src->alpha(), src->opaque(), p)) {
      return Completion{0, Status::kOk, "", src};  // immutable: share it
    }
    ScopedPixels sp = src->Read();
    std::unique_ptr<PixelStore> out;
    Status s = sp.ok() ? ProcessView(sp.view(), p, &out) : Status::kOutOfMemory;
    return Completion{0, s, "", std::shared_ptr<const PixelStore>(std::move(out))};
  }));
}

// cancel(promise) -> bool: rejects a pending decode/transform promise with code 'cancelled' now and tells its job to
// stop (a queued job never starts; a running decode stops at its next check). False when the promise is not pending.
void JsCancel(const v8::FunctionCallbackInfo<v8::Value>& info) {
  IWN_STATE_OR_RETURN(st, info);
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  info.GetReturnValue().Set(false);
  if (!info[0]->IsPromise()) return;
  for (auto it = st->pending.begin(); it != st->pending.end(); ++it) {
    v8::Local<v8::Promise::Resolver> resolver = it->second.resolver.Get(iso);
    if (!resolver->GetPromise()->StrictEquals(info[0])) continue;
    it->second.cancel->store(true);
    st->pending.erase(it);
    (void)resolver->Reject(ctx, MakeError(iso, ctx, Status::kCancelled, "")).FromMaybe(false);
    info.GetReturnValue().Set(true);
    return;
  }
}

// readPixels(handle, premultiplied?: bool) -> Uint8ClampedArray (a copy, tightly packed, top row first)
void JsReadPixels(const v8::FunctionCallbackInfo<v8::Value>& info) {
  IWN_STATE_OR_THROW(st, info, "image.readPixels");
  v8::Isolate* iso = info.GetIsolate();
  HandleBox* box = BoxOf(st, info[0]);
  if (!box || !box->store) return Throw(iso, "image.readPixels: not a live image handle");
  ScopedPixels sp = box->store->Read();
  if (!sp.ok()) return Throw(iso, "image.readPixels: cannot map pixels");
  const PixelView& v = sp.view();
  const size_t size = size_t{v.width} * v.height * 4;
  std::unique_ptr<v8::BackingStore> out = v8::ArrayBuffer::NewBackingStore(
      iso, size, v8::BackingStoreInitializationMode::kUninitialized, v8::BackingStoreOnFailureMode::kReturnNull);
  if (!out) return Throw(iso, "image.readPixels: out of memory");
  const bool premul = info[1]->BooleanValue(iso);
  CopyForUpload(v, false, premul, static_cast<uint8_t*>(out->Data()), size);
  v8::Local<v8::ArrayBuffer> ab = v8::ArrayBuffer::New(iso, std::move(out));
  info.GetReturnValue().Set(v8::Uint8ClampedArray::New(ab, 0, size));
}

// share(handle) -> handle: a second handle on the same (immutable) pixels, e.g. structuredClone of an ImageBitmap.
// Closing one does not affect the other.
void JsShare(const v8::FunctionCallbackInfo<v8::Value>& info) {
  IWN_STATE_OR_THROW(st, info, "image.share");
  v8::Isolate* iso = info.GetIsolate();
  HandleBox* box = BoxOf(st, info[0]);
  if (!box || !box->store) return Throw(iso, "image.share: not a live image handle");
  v8::Local<v8::Object> h = NewHandle(st, iso->GetCurrentContext(), box->store);
  if (h.IsEmpty()) return Throw(iso, "image.share: cannot create the handle");
  info.GetReturnValue().Set(h);
}

// close(handle): releases the pixels now; width/height become 0.
void JsClose(const v8::FunctionCallbackInfo<v8::Value>& info) {
  IWN_STATE_OR_RETURN(st, info);
  HandleBox* box = BoxOf(st, info[0]);
  if (!box) return;
  ReleaseBox(box);
  SetSize(info.GetIsolate(), info.GetIsolate()->GetCurrentContext(), info[0].As<v8::Object>(), nullptr);
}

// exportTransfer(handle) -> id: detaches the handle, parks its pixels for another isolate.
void JsExportTransfer(const v8::FunctionCallbackInfo<v8::Value>& info) {
  IWN_STATE_OR_THROW(st, info, "image.exportTransfer");
  v8::Isolate* iso = info.GetIsolate();
  HandleBox* box = BoxOf(st, info[0]);
  if (!box || !box->store) return Throw(iso, "image.exportTransfer: not a live image handle");
  const uint64_t id = TransferRegistry::Shared().Put(box->store);
  ReleaseBox(box);
  SetSize(iso, iso->GetCurrentContext(), info[0].As<v8::Object>(), nullptr);
  info.GetReturnValue().Set(v8::Number::New(iso, static_cast<double>(id)));
}

// Transfer ids are positive integers below 2^53 (they round-trip through JS numbers). Anything else (NaN, negative,
// fractional, huge) is rejected here, before the double-to-integer conversion, which would be undefined behaviour.
bool TransferId(v8::Local<v8::Value> v, uint64_t* id) {
  if (!v->IsNumber()) return false;
  const double d = v.As<v8::Number>()->Value();
  if (!(d >= 1 && d < 9007199254740992.0) || d != static_cast<double>(static_cast<uint64_t>(d))) return false;
  *id = static_cast<uint64_t>(d);
  return true;
}

// importTransfer(id) -> handle | null
void JsImportTransfer(const v8::FunctionCallbackInfo<v8::Value>& info) {
  IWN_STATE_OR_THROW(st, info, "image.importTransfer");
  v8::Isolate* iso = info.GetIsolate();
  uint64_t id = 0;
  if (!TransferId(info[0], &id)) return info.GetReturnValue().SetNull();
  auto store = TransferRegistry::Shared().Take(id);
  if (!store) return info.GetReturnValue().SetNull();
  v8::Local<v8::Object> h = NewHandle(st, iso->GetCurrentContext(), std::move(store));
  if (h.IsEmpty()) return info.GetReturnValue().SetNull();
  info.GetReturnValue().Set(h);
}

void JsDiscardTransfer(const v8::FunctionCallbackInfo<v8::Value>& info) {
  uint64_t id = 0;
  if (TransferId(info[0], &id)) TransferRegistry::Shared().Discard(id);
}

// poll() -> number of completions delivered (polling mode only; 0 otherwise)
void JsPoll(const v8::FunctionCallbackInfo<v8::Value>& info) {
  IWN_STATE_OR_RETURN(st, info);
  std::deque<Completion> ready;
  {
    std::lock_guard<std::mutex> lock(st->post_mu);
    ready.swap(st->queue);
  }
  const size_t n = ready.size();
  for (Completion& c : ready) Deliver(st, std::move(c));
  info.GetReturnValue().Set(static_cast<uint32_t>(n));
}

// stats() -> { pending, queued, threads, handles, bytes, parked, budgetBytes, budgetInFlight, mode, backends }
void JsStats(const v8::FunctionCallbackInfo<v8::Value>& info) {
  IWN_STATE_OR_THROW(st, info, "image.stats");
  v8::Isolate* iso = info.GetIsolate();
  v8::Local<v8::Context> ctx = iso->GetCurrentContext();
  v8::Local<v8::Object> o = v8::Object::New(iso);
  auto num = [&](const char* k, double v) { Put(ctx, o, Str(iso, k), v8::Number::New(iso, v)); };
  num("pending", static_cast<double>(st->pending.size()));
  num("queued", static_cast<double>(TaskPool::Shared().queued()));
  num("threads", TaskPool::Shared().threads());
  num("handles", static_cast<double>(st->boxes.size()));
  num("bytes", static_cast<double>(st->live_bytes));
  num("parked", static_cast<double>(TransferRegistry::Shared().size()));
  num("budgetBytes", static_cast<double>(DecodeBudget::Shared().limit()));
  num("budgetInFlight", static_cast<double>(DecodeBudget::Shared().in_flight()));
  static const char* const kModes[] = {"runtime", "loop-hooks", "post", "platform", "poll"};
  Put(ctx, o, Str(iso, "mode"), Str(iso, kModes[static_cast<int>(st->mode)]));
  std::vector<DecoderBackend*> backends = DefaultBackends();
  v8::Local<v8::Array> names = v8::Array::New(iso, static_cast<int>(backends.size()));
  for (size_t i = 0; i < backends.size(); ++i) {
    (void)names->CreateDataProperty(ctx, static_cast<uint32_t>(i), Str(iso, backends[i]->name())).FromMaybe(false);
  }
  Put(ctx, o, Str(iso, "backends"), names);
  info.GetReturnValue().Set(o);
}

void SetFn(v8::Isolate* iso, v8::Local<v8::Context> ctx, v8::Local<v8::Object> target, const char* name,
           v8::FunctionCallback cb, v8::Local<v8::Value> data, int length) {
  v8::Local<v8::FunctionTemplate> t = v8::FunctionTemplate::New(iso, cb, data, v8::Local<v8::Signature>(), length,
                                                                v8::ConstructorBehavior::kThrow);
  v8::Local<v8::Function> fn;
  if (!t->GetFunction(ctx).ToLocal(&fn)) return;
  fn->SetName(Str(iso, name));
  Put(ctx, target, Str(iso, name), fn);
}

}  // namespace

void ConfigureBinding(const BindingConfig& config) {
  std::lock_guard<std::mutex> lock(g_config_mu);
  g_config = config;
  if (!g_configured_pool.exchange(true)) TaskPool::ConfigureShared(config.decode_threads);
  if (config.decode_memory_budget) DecodeBudget::Shared().SetLimit(config.decode_memory_budget);
}

void DisposeIsolate(v8::Isolate* isolate) {
  IsolateEntry entry;
  {
    std::lock_guard<std::mutex> lock(StatesMu());
    auto it = States().find(isolate);
    if (it == States().end()) return;
    entry = std::move(it->second);
    States().erase(it);
    // From here on the natives of these States find nothing (StateOf returns null), so JS that still runs in this
    // isolate (tasks pumped before Isolate::Dispose) cannot reach the freed States or their deleted boxes.
    if (entry.current) Live().erase(entry.current->id);
    for (auto& st : entry.retired) Live().erase(st->id);
  }
  if (entry.current) Dispose(entry.current.get());
  for (auto& st : entry.retired) Dispose(st.get());
  // The States may outlive this call (a pool thread holding a weak_ptr lock); they no longer own V8 handles.
}

std::shared_ptr<const PixelStore> GetPixelStore(v8::Isolate* isolate, v8::Local<v8::Value> value) {
  std::vector<State*> states;
  {
    std::lock_guard<std::mutex> lock(StatesMu());
    auto it = States().find(isolate);
    if (it == States().end()) return nullptr;
    if (it->second.current) states.push_back(it->second.current.get());
    for (auto& st : it->second.retired) states.push_back(st.get());
  }
  for (State* st : states) {
    if (HandleBox* box = BoxOf(st, value)) return box->store;
  }
  return nullptr;
}

v8::Local<v8::Object> WrapPixelStore(v8::Isolate* isolate, v8::Local<v8::Context> ctx,
                                     std::shared_ptr<const PixelStore> store) {
  State* st = nullptr;
  {
    std::lock_guard<std::mutex> lock(StatesMu());
    auto it = States().find(isolate);
    if (it != States().end()) st = it->second.current.get();
  }
  if (!st) return v8::Local<v8::Object>();
  return NewHandle(st, ctx, std::move(store));
}

void DeferredBoxStatsForTesting(size_t* deferred, size_t* freed) {
  *deferred = g_deferred_created.load();
  *freed = g_deferred_freed.load();
}

BindingStats GetBindingStats(v8::Isolate* isolate) {
  BindingStats s;
  std::lock_guard<std::mutex> lock(StatesMu());
  auto it = States().find(isolate);
  if (it == States().end()) return s;
  s.registered = true;
  s.retired_states = it->second.retired.size();
  if (State* st = it->second.current.get()) {
    s.pending = st->pending.size();
    s.handles = st->boxes.size();
    s.bytes = st->live_bytes;
    s.mode = static_cast<int>(st->mode);
  }
  for (auto& st : it->second.retired) {
    s.retired_handles += st->boxes.size();
    s.retired_bytes += st->live_bytes;
    if (!st->context.IsEmpty() || !st->pending.empty()) s.retired_holding_context = true;
  }
  return s;
}

}  // namespace iwn::image

void iwn_register_image(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  using namespace iwn::image;
  v8::HandleScope scope(isolate);
  auto st = std::make_shared<State>();
  {
    std::lock_guard<std::mutex> lock(StatesMu());
    st->id = g_next_state_id++;
  }
  st->isolate = isolate;
  st->context.Reset(isolate, ctx);
  BindingConfig cfg = Config();
#if defined(IWN_HAVE_CORE_RUNTIME)
  iwn::Runtime* rt = iwn::Runtime::From(isolate);
#else
  void* rt = nullptr;
#endif
  // Order documented in v8_binding.h: runtime, loop hooks, BindingConfig::post, platform, poll.
  if (rt) {
    st->mode = Mode::kRuntime;
    st->runtime = rt;
  }
#if defined(IWN_IMAGE_HAVE_LOOP_HOOKS)
  else if (iwn::LoopHooksFor(isolate)) {
    st->mode = Mode::kLoopHooks;
  }
#endif
  else if (cfg.post) {
    st->mode = Mode::kPost;
    st->post = cfg.post;
  }
  else if (cfg.platform) {
    st->mode = Mode::kPlatform;
    st->runner = cfg.platform->GetForegroundTaskRunner(isolate);
    if (!st->runner) st->mode = Mode::kPoll;
  } else {
    st->mode = Mode::kPoll;
  }

  v8::Local<v8::FunctionTemplate> handle_tmpl = v8::FunctionTemplate::New(isolate);
  handle_tmpl->SetClassName(Str(isolate, "IwnImageHandle"));
  handle_tmpl->InstanceTemplate()->SetInternalFieldCount(1);
  st->handle_template.Reset(isolate, handle_tmpl);

  // The State's id, not its address: see StateOf. Ids stay below 2^53, so the double is exact.
  v8::Local<v8::Value> data = v8::Number::New(isolate, static_cast<double>(st->id));
  v8::Local<v8::Object> image = v8::Object::New(isolate);
  SetFn(isolate, ctx, image, "decode", JsDecode, data, 2);
  SetFn(isolate, ctx, image, "decodeBase64", JsDecodeBase64, data, 2);
  SetFn(isolate, ctx, image, "fromPixels", JsFromPixels, data, 5);
  SetFn(isolate, ctx, image, "transform", JsTransform, data, 2);
  SetFn(isolate, ctx, image, "cancel", JsCancel, data, 1);
  SetFn(isolate, ctx, image, "readPixels", JsReadPixels, data, 2);
  SetFn(isolate, ctx, image, "share", JsShare, data, 1);
  SetFn(isolate, ctx, image, "close", JsClose, data, 1);
  SetFn(isolate, ctx, image, "exportTransfer", JsExportTransfer, data, 1);
  SetFn(isolate, ctx, image, "importTransfer", JsImportTransfer, data, 1);
  SetFn(isolate, ctx, image, "discardTransfer", JsDiscardTransfer, data, 1);
  SetFn(isolate, ctx, image, "poll", JsPoll, data, 0);
  SetFn(isolate, ctx, image, "stats", JsStats, data, 0);
  Put(ctx, image, Str(isolate, "needsPolling"), v8::Boolean::New(isolate, st->mode == Mode::kPoll));
  Put(ctx, image, Str(isolate, "version"), v8::Integer::New(isolate, 2));
  Put(ctx, natives, Str(isolate, "image"), image);

  std::shared_ptr<State> previous;
  bool install_hooks = false;
  {
    std::lock_guard<std::mutex> lock(StatesMu());
    IsolateEntry& entry = States()[isolate];
    Live()[st->id] = st.get();
    previous = std::move(entry.current);
    if (previous) entry.retired.push_back(previous);
    entry.current = st;
    if (!entry.hooks_installed && rt) entry.hooks_installed = install_hooks = true;
  }
  if (previous) Retire(previous.get());  // the old page's context can now be collected
  PruneRetired(isolate);                 // earlier pages that are fully gone

#if defined(IWN_HAVE_CORE_RUNTIME)
  if (install_hooks) {
    // Teardown (PROC-7): free everything before the context and isolate go, and stop posting.
    rt->add_shutdown_hook([isolate] { DisposeIsolate(isolate); });
    rt->add_stats_provider("image", [isolate] {
      BindingStats s = GetBindingStats(isolate);
      iwn::Json j = iwn::Json::object();
      j.set("pending", static_cast<uint64_t>(s.pending));
      j.set("handles", static_cast<uint64_t>(s.handles));
      j.set("bytes", static_cast<uint64_t>(s.bytes));
      j.set("retiredHandles", static_cast<uint64_t>(s.retired_handles));
      j.set("queued", static_cast<uint64_t>(TaskPool::Shared().queued()));
      j.set("threads", TaskPool::Shared().threads());
      j.set("budgetInFlight", DecodeBudget::Shared().in_flight());
      return j;
    });
  }
#else
  (void)install_hooks;
#endif
}
