// A worker: its own thread, V8 isolate and event loop (WRK-1, JS-2). Written from HTML §10.2.4 ("run a worker":
// fetch, run the script, enable the implicit port's message queue, the event loop until closing), §10.2.5 (runtime
// script errors: the worker global first, then the Worker object), §10.3 (WorkerGlobalScope), §8.1.7 (event loop),
// and the V8 embedder API (isolate per thread, TerminateExecution from another thread, foreground tasks on the
// worker's loop through the core's platform, NearHeapLimitCallback).
//
// Boot inside the thread: isolate (own heap limit, own ArrayBuffer allocator shared with the BackingStores it made,
// so transferred memory outlives it), context, globalThis.__iwn with worker versions of the core natives, the native
// modules (minus config workers.excludeModules) with this loop's IwnLoopHooks bound, the core bootstrap
// (console with a "[worker]" prefix, timers, rAF, microtasks, error hooks), the worker-scope stubs, the preludes
// (web glue in worker scope, net, image, canvas2d, workers, ...), then the worker script (classic or module).
#include <pthread.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <cstdlib>
#include <thread>

#include "iwn/core/clock.h"
#include "iwn/core/log.h"
#include "iwn/core/module_registry.h"
#include "iwn/core/platform.h"
#include "iwn/core/text.h"
#include "iwn/loop_hooks_registry.h"
#include "v8/internal.h"

#ifndef IWN_RUNTIME_VERSION
#define IWN_RUNTIME_VERSION "0.0.0"
#endif

namespace iwn {
extern const char kBootstrapJs[];
extern const size_t kBootstrapJsSize;
void install_clone_natives(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);
}  // namespace iwn

namespace iwn::workers {

namespace {

thread_local WorkerRuntime* t_current = nullptr;
constexpr size_t kStackHeadroom = 256u << 10;

// The worker equivalent of the core's PageCallScope: a verbose TryCatch, so V8 reports an uncaught exception once
// through the message listener (with its location); anything the listener did not see is reported on close.
class CallScope {
 public:
  explicit CallScope(WorkerRuntime& rt)
      : rt_(rt), tc_(rt.isolate()), saved_(std::exchange(rt.listener_reported, false)) {
    tc_.SetVerbose(true);
  }
  ~CallScope() {
    bool reported = rt_.listener_reported;
    rt_.listener_reported = saved_;
    if (tc_.HasCaught() && !tc_.HasTerminated() && !reported) rt_.report_exception(tc_.Exception(), tc_.Message());
  }
  v8::TryCatch& tc() { return tc_; }

 private:
  WorkerRuntime& rt_;
  v8::TryCatch tc_;
  bool saved_;
};

WorkerRuntime& rt_of(const v8::FunctionCallbackInfo<v8::Value>& info) {
  (void)info;
  return *WorkerRuntime::current();
}

double num_arg(const v8::FunctionCallbackInfo<v8::Value>& info, int i, double def = 0) {
  if (info.Length() <= i) return def;
  return info[i]->NumberValue(info.GetIsolate()->GetCurrentContext()).FromMaybe(def);
}

// --- worker core natives (the contract of core/js/bootstrap.js and web/glue/src/natives.ts) ----------------------

void core_log(const v8::FunctionCallbackInfo<v8::Value>& info) {
  int level = static_cast<int>(num_arg(info, 0, 1));
  if (level < 0 || level > 3) level = 1;
  log_js(static_cast<LogLevel>(level), info.Length() > 1 ? utf8(info.GetIsolate(), info[1]) : "");
}
void core_timer_add(const v8::FunctionCallbackInfo<v8::Value>& info) {
  info.GetReturnValue().Set(rt_of(info).timer_add(num_arg(info, 0, 0), info.Length() > 1 && info[1]->BooleanValue(info.GetIsolate())));
}
void core_timer_clear(const v8::FunctionCallbackInfo<v8::Value>& info) {
  rt_of(info).timer_clear(static_cast<int>(num_arg(info, 0, 0)));
}
void core_request_frame(const v8::FunctionCallbackInfo<v8::Value>& info) { rt_of(info).request_frame(); }
void core_set_hooks(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1 || !info[0]->IsObject()) return throw_type_error(info.GetIsolate(), "setHooks(object)");
  rt_of(info).set_hooks(info[0].As<v8::Object>());
}
void core_set_blob_resolver(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1 || !info[0]->IsFunction()) {
    return throw_type_error(info.GetIsolate(), "setBlobResolver(function)");
  }
  rt_of(info).set_blob_resolver(info[0]);
}
void core_invoke_callback(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  if (info.Length() < 1 || !info[0]->IsFunction()) {
    return throw_type_error(isolate, "invokeCallback(fn, thisArg, ...args): fn is not a function");
  }
  WorkerRuntime& rt = rt_of(info);
  std::vector<v8::Local<v8::Value>> argv;
  for (int i = 2; i < info.Length(); ++i) argv.push_back(info[i]);
  v8::Local<v8::Value> recv = info.Length() > 1 ? info[1] : v8::Undefined(isolate).As<v8::Value>();
  v8::Local<v8::Value> result;
  {
    CallScope scope(rt);
    if (!info[0].As<v8::Function>()
             ->Call(isolate->GetCurrentContext(), recv, static_cast<int>(argv.size()), argv.empty() ? nullptr : argv.data())
             .ToLocal(&result)) {
      return;
    }
  }
  info.GetReturnValue().Set(result);
}
void run_native_microtask(v8::Local<v8::Data> data) {
  WorkerRuntime* rt = WorkerRuntime::current();
  if (!rt || data.IsEmpty() || !data->IsValue()) return;
  v8::Local<v8::Value> value = data.As<v8::Value>();
  if (!value->IsFunction()) return;
  v8::Isolate* isolate = rt->isolate();
  v8::HandleScope hs(isolate);
  v8::Local<v8::Context> ctx = rt->context();
  if (ctx.IsEmpty()) return;
  v8::Context::Scope cs(ctx);
  CallScope scope(*rt);
  (void)value.As<v8::Function>()->Call(ctx, v8::Undefined(isolate), 0, nullptr);
}
void core_enqueue_microtask(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1 || !info[0]->IsFunction()) {
    return throw_type_error(info.GetIsolate(), "The callback provided as parameter 1 is not a function.");
  }
  v8::Isolate* isolate = info.GetIsolate();
  isolate->GetCurrentContext()->GetMicrotaskQueue()->EnqueueMicrotask(isolate, &run_native_microtask,
                                                                     info[0].As<v8::Data>());
}
void core_report_error(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Value> error = info.Length() > 0 ? info[0] : v8::Undefined(isolate).As<v8::Value>();
  rt_of(info).report_exception(error, v8::Exception::CreateMessage(isolate, error));
}
void core_report_exception(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  WorkerRuntime& rt = rt_of(info);
  v8::Local<v8::Value> error = info.Length() > 0 ? info[0] : v8::Undefined(isolate).As<v8::Value>();
  rt.counter_uncaught++;
  log_js(LogLevel::kError, "[" + rt.handle().label + "] Uncaught " +
                               exception_text(isolate, isolate->GetCurrentContext(), error));
}
void core_lifecycle_state(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  v8::Local<v8::Object> o = v8::Object::New(isolate);
  set_val(isolate, ctx, o, "visibilityState", v8str(isolate, "visible"));
  set_val(isolate, ctx, o, "focused", v8::False(isolate));
  set_val(isolate, ctx, o, "readyState", v8str(isolate, "complete"));
  info.GetReturnValue().Set(o);
}
void core_reload(const v8::FunctionCallbackInfo<v8::Value>&) {
  log(LogLevel::kWarn, "location.reload() is not available in a worker");
}
void core_close(const v8::FunctionCallbackInfo<v8::Value>& info) { rt_of(info).request_close(); }
void core_inspector_sessions(const v8::FunctionCallbackInfo<v8::Value>& info) { info.GetReturnValue().Set(0); }
void clock_now(const v8::FunctionCallbackInfo<v8::Value>& info) { info.GetReturnValue().Set(now_ms()); }
void clock_time_origin(const v8::FunctionCallbackInfo<v8::Value>& info) { info.GetReturnValue().Set(time_origin_ms()); }
void crypto_random(const v8::FunctionCallbackInfo<v8::Value>& info) {
  if (info.Length() < 1 || !info[0]->IsArrayBufferView()) {
    return throw_type_error(info.GetIsolate(), "crypto.random(ArrayBufferView)");
  }
  auto view = info[0].As<v8::ArrayBufferView>();
  size_t len = view->ByteLength();
  if (len == 0) return;
  auto* base = static_cast<uint8_t*>(view->Buffer()->Data());
  if (!base) return throw_type_error(info.GetIsolate(), "crypto.random: detached buffer");
  arc4random_buf(base + view->ByteOffset(), len);  // bionic CSPRNG (NET-STORE-4)
}
void device_info(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::Context> ctx = isolate->GetCurrentContext();
  const std::string& json = rt_of(info).device_info_json();
  v8::Local<v8::Value> v;
  if (!json.empty() && v8::JSON::Parse(ctx, v8str(isolate, json)).ToLocal(&v) && v->IsObject()) {
    info.GetReturnValue().Set(v);
    return;
  }
  info.GetReturnValue().Set(v8::Object::New(isolate));
}

// A native module's completion. It runs exactly once: as a task, or, when the task is dropped (the worker closed
// or was terminated first, loop close), when the last copy is destroyed. By then teardown has disposed the
// module's per-isolate state, so the completion only frees what it owns (loop_hooks.h: a posted fn always runs).
struct HookTask {
  IwnTaskFn fn;
  void* arg;
  HookTask(IwnTaskFn f, void* a) : fn(f), arg(a) {}
  HookTask(const HookTask&) = delete;
  HookTask& operator=(const HookTask&) = delete;
  ~HookTask() {
    if (arg) fn(arg);
  }
  void run() {
    void* a = arg;
    arg = nullptr;
    if (a) fn(a);
  }
};
struct HookCall {
  std::shared_ptr<HookTask> task;
  void operator()() const { task->run(); }
};

// Loop hooks for native modules (net, storage, image) in this worker: tasks go to the worker's loop; the loop never
// exits for lack of work (a worker lives until close()/terminate()), so the refs are only counted.
int hook_post(void* user, IwnTaskFn fn, void* arg) {
  auto* rt = static_cast<WorkerRuntime*>(user);
  auto hook = std::make_shared<HookTask>(fn, arg);
  EventLoop::Task task = HookCall{hook};
  if (rt->loop().try_post(task)) return 1;
  hook->arg = nullptr;  // refused (loop closed): the caller frees arg
  return 0;
}
void hook_ref(void*) {}
void hook_unref(void*) {}

}  // namespace

// Weak references to the per-isolate teardown of other native modules (their .o files are linked whenever the
// module is, because the registry references iwn_register_<module> in the same file).
}  // namespace iwn::workers

void iwn_net_dispose_isolate(v8::Isolate* isolate) __attribute__((weak));
void iwn_storage_dispose_isolate(v8::Isolate* isolate) __attribute__((weak));
namespace iwn::image {
void DisposeIsolate(v8::Isolate* isolate) __attribute__((weak));
}
namespace iwn::canvas2d {
void DisposeIsolate(v8::Isolate* isolate) __attribute__((weak));
}

namespace iwn::workers {

void dispose_module_isolates(v8::Isolate* isolate) {
  // Image first, while the loop hooks are still bound (image/INTEROP.md §7).
  if (&iwn::image::DisposeIsolate) iwn::image::DisposeIsolate(isolate);
  if (&iwn::canvas2d::DisposeIsolate) iwn::canvas2d::DisposeIsolate(isolate);
  if (&iwn_net_dispose_isolate) iwn_net_dispose_isolate(isolate);
  if (&iwn_storage_dispose_isolate) iwn_storage_dispose_isolate(isolate);
}

// ---------------------------------------------------------------------------------------------------------------

WorkerRuntime* WorkerRuntime::current() { return t_current; }

WorkerRuntime::WorkerRuntime(WorkerStart start) : start_(std::move(start)) {
  loop_hooks_.user = this;
  loop_hooks_.post = &hook_post;
  loop_hooks_.ref = &hook_ref;
  loop_hooks_.unref = &hook_unref;
}

WorkerRuntime::~WorkerRuntime() = default;

bool WorkerRuntime::start(WorkerStart start) {
  size_t stack = start.env->config.stack_bytes;
  auto* rt = new WorkerRuntime(std::move(start));
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, stack);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  pthread_t tid;
  auto trampoline = [](void* self) -> void* {
    static_cast<WorkerRuntime*>(self)->thread_main();
    return nullptr;
  };
  int rc = pthread_create(&tid, &attr, trampoline, rt);
  pthread_attr_destroy(&attr);
  if (rc != 0) {
    log(LogLevel::kError, "could not start a worker thread (pthread_create: %d)", rc);
    delete rt;
    return false;
  }
  return true;
}

std::string WorkerRuntime::origin() const {
  // A data: worker has an opaque origin (HTML); blob: and same-origin workers have the app's.
  return url_.scheme == "data" ? "null" : env().origin;
}

void WorkerRuntime::thread_main() {
  t_current = this;
  WorkerHandle& h = handle();
  pthread_setname_np(pthread_self(), worker_thread_name(h.id, h.name).c_str());
  // WRK-11: below the JS thread and the audio thread.
  setpriority(PRIO_PROCESS, static_cast<id_t>(syscall(SYS_gettid)), env().config.nice);
  double t0 = now_ms();
  if (create_isolate()) {
    // The isolate stays entered on this thread for the worker's whole life (tasks, timers, frames run inside).
    v8::Isolate::Scope isolate_scope(isolate_);
    v8::HandleScope hs(isolate_);
    boot_started_ms_ = t0;
    if (boot()) {
      while (!loop_.quit_requested()) loop_.run_once(60000);
    }
  }
  teardown();
  t_current = nullptr;
  std::shared_ptr<WorkerHandle> keep = start_.handle;
  uint64_t id = keep->id;
  // The creator drops its Worker bookkeeping; then the slot and the registry entry go.
  if (keep->parent) keep->parent->post([id](IsolateBinding& b) { b.child_exit(id); });
  unregister_worker(id);
  worker_limiter().release();
  log(LogLevel::kInfo, "%s ended", keep->label.c_str());
  delete this;
  keep->mark_done();
}

bool WorkerRuntime::create_isolate() {
  WorkerHandle& h = handle();
  auto parsed = parse_url(h.url);
  if (!parsed) return false;
  url_ = *parsed;
  allocator_ = std::shared_ptr<v8::ArrayBuffer::Allocator>(v8::ArrayBuffer::Allocator::NewDefaultAllocator());
  v8::Isolate::CreateParams params;
  // Shared allocator: a BackingStore made here keeps it alive, so memory transferred out of this worker is freed
  // correctly after the worker is gone (JS-2, REG-8).
  params.array_buffer_allocator_shared = allocator_;
  params.constraints.set_max_old_generation_size_in_bytes(env().config.heap_limit_bytes);
  isolate_ = iwn::new_isolate(params, &loop_);
  h.attach(isolate_, &loop_);
  char probe;
  isolate_->SetStackLimit(reinterpret_cast<uintptr_t>(&probe) - (env().config.stack_bytes - kStackHeadroom));
  return true;
}

// Runs with the isolate entered (thread_main).
bool WorkerRuntime::boot() {
  WorkerHandle& h = handle();
  v8::HandleScope hs(isolate_);
  isolate_->SetMicrotasksPolicy(v8::MicrotasksPolicy::kExplicit);
  isolate_->SetPromiseRejectCallback(&WorkerRuntime::promise_reject);
  isolate_->AddMessageListenerWithErrorLevel(&WorkerRuntime::message_listener, v8::Isolate::kMessageError);
  isolate_->SetCaptureStackTraceForUncaughtExceptions(true, 32);
  isolate_->AddNearHeapLimitCallback(&WorkerRuntime::near_heap_limit, this);
  isolate_->SetHostImportModuleDynamicallyCallback(&WorkerRuntime::dynamic_import);
  isolate_->SetHostInitializeImportMetaObjectCallback(&WorkerRuntime::import_meta);
  // V8 API misuse and fatal errors in a worker are logged with the worker's label before the process aborts (the
  // stderr redirect may not flush in time).
  isolate_->SetFatalErrorHandler([](const char* location, const char* message) {
    WorkerRuntime* rt = current();
    log(LogLevel::kError, "%s: V8 fatal error in %s: %s", rt ? rt->handle().label.c_str() : "worker",
        location ? location : "?", message ? message : "?");
    abort();
  });

  EventLoop::Hooks hooks;
  hooks.run_task = [this](EventLoop::Task& t) { run_task(t); };
  hooks.fire_timer = [this](const TimerQueue::Fired& f) { fire_timer(f); };
  hooks.run_animation_frame = [this](double now) { run_animation_frame(now); };
  loop_.set_hooks(hooks);

  v8::Local<v8::Context> ctx = v8::Context::New(isolate_);
  if (ctx.IsEmpty()) return false;
  context_.Reset(isolate_, ctx);
  v8::Context::Scope cs(ctx);

  // Owner + binding first: the workers natives (registered with the other modules below) use them.
  owner_ = std::make_shared<BindingOwner>(
      [this](std::function<void()> fn) {
        EventLoop::Task task = std::move(fn);
        return loop_.try_post(task);
      },
      h.label);
  binding_ = std::make_shared<IsolateBinding>(isolate_, ctx, this, this);
  binding_->set_owner(owner_);
  owner_->set_binding(binding_);
  set_binding_for(isolate_, binding_);
  PortHub::shared().adopt(h.inside_port, owner_);

  v8::Local<v8::Object> natives = v8::Object::New(isolate_);
  ctx->Global()->DefineOwnProperty(ctx, v8str(isolate_, "__iwn"), natives, v8::DontEnum).Check();
  install_core_natives(ctx, natives);
  iwn::BindLoopHooks(isolate_, &loop_hooks_);
  for (int i = 0; i < kNativeModuleCount; ++i) {
    const NativeModuleEntry& m = kNativeModules[i];
    bool excluded = false;
    for (const auto& x : env().config.exclude_modules) excluded |= x == m.name;
    if (excluded) continue;
    v8::TryCatch tc(isolate_);
    m.fn(isolate_, ctx, natives);
    if (tc.HasCaught()) {
      log(LogLevel::kError, "%s: native module %s threw during registration: %s", h.label.c_str(), m.name,
          exception_text(isolate_, ctx, tc.Exception()).c_str());
    }
  }

  // Core bootstrap (console, timers, rAF, microtasks, error hooks), shared with the page.
  {
    v8::TryCatch tc(isolate_);
    v8::ScriptOrigin origin(v8str(isolate_, "iwn-runtime:///core/bootstrap.js"));
    v8::Local<v8::Script> script;
    v8::Local<v8::Value> fn;
    if (!v8::Script::Compile(ctx, v8str(isolate_, std::string_view(kBootstrapJs, kBootstrapJsSize)), &origin)
             .ToLocal(&script) ||
        !script->Run(ctx).ToLocal(&fn) || !fn->IsFunction()) {
      if (!h.terminate_requested()) {
        log(LogLevel::kError, "%s: core bootstrap failed: %s", h.label.c_str(),
            tc.HasCaught() && !tc.HasTerminated() ? exception_text(isolate_, ctx, tc.Exception()).c_str() : "?");
      }
      return false;
    }
    v8::Local<v8::Value> args[] = {natives, ctx->Global()};
    if (fn.As<v8::Function>()->Call(ctx, ctx->Global(), 2, args).IsEmpty()) {
      if (!h.terminate_requested()) {
        log(LogLevel::kError, "%s: core bootstrap threw: %s", h.label.c_str(),
            tc.HasCaught() && !tc.HasTerminated() ? exception_text(isolate_, ctx, tc.Exception()).c_str() : "?");
      }
      return false;
    }
  }
  // Worker-scope markers before the preludes, so they shape a worker global (the image prelude, for example, leaves
  // out HTMLImageElement when importScripts/WorkerGlobalScope exist). The workers prelude replaces them.
  {
    static const char kStubs[] =
        "(function(g){'use strict';"
        "const d=(n,v)=>Object.defineProperty(g,n,{value:v,writable:true,configurable:true,enumerable:false});"
        "const illegal=function(){throw new TypeError('Illegal constructor');};"
        "d('WorkerGlobalScope',function WorkerGlobalScope(){illegal();});"
        "d('DedicatedWorkerGlobalScope',function DedicatedWorkerGlobalScope(){illegal();});"
        "d('importScripts',function importScripts(){throw new TypeError("
        "'importScripts is unavailable: the workers prelude is not loaded');});"
        "})(globalThis);";
    v8::TryCatch tc(isolate_);
    v8::ScriptOrigin origin(v8str(isolate_, "iwn-runtime:///workers/stubs.js"));
    v8::Local<v8::Script> script;
    if (v8::Script::Compile(ctx, v8str(isolate_, kStubs), &origin).ToLocal(&script)) (void)script->Run(ctx);
  }
  const double preludes_start_ms = now_ms();
  const std::vector<std::string>& preludes = env().config.preludes ? *env().config.preludes : env().preludes;
  for (const std::string& path : preludes) {
    if (h.terminate_requested() || closing_) return false;
    auto bytes = env().source.assets ? env().source.assets->read(path) : nullptr;
    if (!bytes) {
      log(LogLevel::kError, "%s: prelude %s not found in assets", h.label.c_str(), path.c_str());
      continue;
    }
    std::string url = "iwn-runtime:///" + path;
    {
      CallScope scope(*this);
      v8::Local<v8::Script> script;
      if (compile_classic(isolate_, ctx, url, std::string(bytes->view())).ToLocal(&script)) (void)script->Run(ctx);
    }
    run_microtasks();
  }
  if (!binding_->has_hooks()) {
    log(LogLevel::kError,
        "%s: the workers prelude did not run in the worker (add iwn/prelude/workers.js to the preludes); "
        "postMessage and onmessage are unavailable",
        h.label.c_str());
  }
  booted_ = true;
  if (h.terminate_requested() || closing_) return false;
  // Isolate + context + natives + bootstrap + preludes, before the worker's own script.
  log(LogLevel::kInfo, "%s booted in %.1f ms (%s; isolate+natives+bootstrap %.1f ms, preludes %.1f ms)",
      h.label.c_str(), now_ms() - boot_started_ms_, h.module ? "module" : "classic",
      preludes_start_ms - boot_started_ms_, now_ms() - preludes_start_ms);
  run_script();
  return true;
}

void WorkerRuntime::install_core_natives(v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  v8::Isolate* isolate = isolate_;
  WorkerHandle& h = handle();
  v8::Local<v8::Object> core = v8::Object::New(isolate);
  set_fn(isolate, ctx, core, "log", core_log);
  set_fn(isolate, ctx, core, "timerAdd", core_timer_add);
  set_fn(isolate, ctx, core, "timerClear", core_timer_clear);
  set_fn(isolate, ctx, core, "requestFrame", core_request_frame);
  set_fn(isolate, ctx, core, "setHooks", core_set_hooks);
  set_fn(isolate, ctx, core, "setBlobResolver", core_set_blob_resolver);
  set_fn(isolate, ctx, core, "invokeCallback", core_invoke_callback);
  set_fn(isolate, ctx, core, "enqueueMicrotask", core_enqueue_microtask);
  set_fn(isolate, ctx, core, "reportException", core_report_exception);
  set_fn(isolate, ctx, core, "reportError", core_report_error);
  set_fn(isolate, ctx, core, "lifecycleState", core_lifecycle_state);
  set_fn(isolate, ctx, core, "reload", core_reload);
  set_fn(isolate, ctx, core, "close", core_close);
  set_fn(isolate, ctx, core, "inspectorSessions", core_inspector_sessions);
  set_val(isolate, ctx, core, "runtimeVersion", v8str(isolate, IWN_RUNTIME_VERSION));
  set_val(isolate, ctx, core, "v8Version", v8str(isolate, v8::V8::GetVersion()));
  set_val(isolate, ctx, core, "origin", v8str(isolate, origin()));
  set_val(isolate, ctx, core, "documentUrl", v8str(isolate, h.url));
  set_val(isolate, ctx, core, "isWorker", v8::True(isolate));
  set_val(isolate, ctx, core, "workerName", v8str(isolate, h.name.empty() ? "worker " + std::to_string(h.id) : h.name));
  set_val(isolate, ctx, natives, "core", core);

  v8::Local<v8::Object> clock = v8::Object::New(isolate);
  set_fn(isolate, ctx, clock, "now", clock_now);
  set_fn(isolate, ctx, clock, "timeOrigin", clock_time_origin);
  set_val(isolate, ctx, natives, "clock", clock);

  v8::Local<v8::Object> loop = v8::Object::New(isolate);
  set_fn(isolate, ctx, loop, "queueMicrotask", core_enqueue_microtask);
  set_val(isolate, ctx, natives, "loop", loop);

  iwn::install_clone_natives(isolate, ctx, natives);

  v8::Local<v8::Object> crypto = v8::Object::New(isolate);
  set_fn(isolate, ctx, crypto, "random", crypto_random);
  set_val(isolate, ctx, natives, "crypto", crypto);

  v8::Local<v8::Object> device = v8::Object::New(isolate);
  set_fn(isolate, ctx, device, "info", device_info);
  set_val(isolate, ctx, natives, "device", device);

  // __iwn.config for the glue: the page's glue section, in worker scope, with the worker's URL (WRK-2: location).
  Json glue = env().glue.is_object() ? env().glue : Json::object();
  glue.set("scope", "worker");
  glue.set("url", h.url);
  if (!glue.has("runtimeVersion")) glue.set("runtimeVersion", IWN_RUNTIME_VERSION);
  v8::Local<v8::Value> config;
  if (v8::JSON::Parse(ctx, v8str(isolate, glue.dump())).ToLocal(&config)) set_val(isolate, ctx, natives, "config", config);
}

void WorkerRuntime::run_script() {
  WorkerHandle& h = handle();
  std::string source, error;
  bool ok = true;
  if (start_.have_source) {
    source = std::move(start_.source);
  } else {
    ok = fetch(h.url, h.module, &source, &error);
  }
  if (!ok) {
    // HTML: a worker whose script fails to load fires a plain `error` event at the Worker (WRK-7).
    log_js(LogLevel::kError, "[" + h.label + "] failed to load worker script " + h.url + ": " + error);
    uint64_t id = h.id;
    if (h.parent) h.parent->post([id, error](IsolateBinding& b) { b.child_load_error(id, error); });
    request_close();
    return;
  }
  v8::HandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = context();
  if (h.module) {
    v8::Local<v8::Value> result;
    bool started = false;
    {
      CallScope scope(*this);
      started = run_module(h.url, &source).ToLocal(&result);
    }
    if (started && result->IsPromise()) {
      // Evaluation errors and top-level-await rejections are reported like uncaught exceptions.
      auto on_reject = [](const v8::FunctionCallbackInfo<v8::Value>& info) {
        WorkerRuntime* rt = WorkerRuntime::current();
        if (!rt) return;
        v8::Local<v8::Value> reason = info.Length() > 0 ? info[0] : v8::Undefined(info.GetIsolate()).As<v8::Value>();
        rt->report_exception(reason, v8::Exception::CreateMessage(info.GetIsolate(), reason));
      };
      v8::Local<v8::Function> fn;
      if (v8::Function::New(ctx, on_reject).ToLocal(&fn)) (void)result.As<v8::Promise>()->Catch(ctx, fn);
    }
  } else {
    CallScope scope(*this);
    (void)run_classic(h.url, source);
  }
  run_microtasks();
  // HTML "run a worker": enable the implicit port's message queue once the script ran (WRK-6: messages posted before
  // this are delivered now, in order).
  PortHub::shared().start(h.inside_port);
}

v8::MaybeLocal<v8::Value> WorkerRuntime::run_classic(const std::string& url, const std::string& source) {
  v8::EscapableHandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = context();
  v8::Local<v8::Script> script;
  if (!compile_classic(isolate_, ctx, url, source).ToLocal(&script)) return {};
  v8::Local<v8::Value> result;
  if (!script->Run(ctx).ToLocal(&result)) return {};
  return hs.Escape(result);
}

bool WorkerRuntime::fetch(const std::string& url, bool module, std::string* source, std::string* error) {
  auto u = parse_url(url);
  if (!u) {
    *error = "invalid URL " + url;
    return false;
  }
  if (u->scheme == "blob") {
    // The worker's own blob store (the glue's resolver: url => {bytes, type} | null), NET-14/15.
    if (blob_resolver_.IsEmpty()) {
      *error = "no blob: URL resolver in this worker";
      return false;
    }
    v8::HandleScope hs(isolate_);
    v8::Local<v8::Context> ctx = context();
    v8::TryCatch tc(isolate_);
    v8::Local<v8::Value> argv[] = {v8str(isolate_, url)};
    v8::Local<v8::Value> r;
    v8::Local<v8::Value> fn = blob_resolver_.Get(isolate_);
    if (!fn.As<v8::Function>()->Call(ctx, v8::Undefined(isolate_), 1, argv).ToLocal(&r) || !r->IsObject()) {
      *error = "unknown or revoked blob URL " + url;
      return false;
    }
    v8::Local<v8::Value> bytes;
    if (!r.As<v8::Object>()->Get(ctx, v8str(isolate_, "bytes")).ToLocal(&bytes) || !bytes->IsArrayBufferView()) {
      *error = "blob resolver returned no bytes for " + url;
      return false;
    }
    auto view = bytes.As<v8::ArrayBufferView>();
    source->resize(view->ByteLength());
    view->CopyContents(source->data(), source->size());
    return true;
  }
  FetchedScript f = fetch_script(url, env().source, module);
  if (!f.ok) {
    *error = f.error;
    return false;
  }
  *source = std::move(f.source);
  return true;
}

int WorkerRuntime::timer_add(double timeout, bool repeat) { return loop_.timers().add(timeout, repeat, now_ms()); }
void WorkerRuntime::timer_clear(int id) { loop_.timers().clear(id); }

void WorkerRuntime::request_close() {
  closing_ = true;
  loop_.request_quit();
}

v8::MaybeLocal<v8::Value> WorkerRuntime::call(v8::Local<v8::Function> fn, v8::Local<v8::Value> recv, int argc,
                                              v8::Local<v8::Value> argv[]) {
  v8::EscapableHandleScope hs(isolate_);
  v8::Local<v8::Value> result;
  {
    CallScope scope(*this);
    (void)fn->Call(context(), recv, argc, argv).ToLocal(&result);
  }
  if (v8::StackTrace::CurrentStackTrace(isolate_, 1)->GetFrameCount() == 0) run_microtasks();
  if (result.IsEmpty()) return {};
  return hs.Escape(result);
}

v8::MaybeLocal<v8::Value> WorkerRuntime::call_hook(const char* name, int argc, v8::Local<v8::Value> argv[]) {
  if (hooks_.IsEmpty()) return {};
  v8::EscapableHandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = context();
  v8::Local<v8::Value> fn;
  if (!hooks()->Get(ctx, v8str(isolate_, name)).ToLocal(&fn) || !fn->IsFunction()) return {};
  v8::Local<v8::Value> r;
  {
    CallScope scope(*this);
    if (!fn.As<v8::Function>()->Call(ctx, hooks(), argc, argv).ToLocal(&r)) return {};
  }
  return hs.Escape(r);
}

void WorkerRuntime::run_task(EventLoop::Task& task) {
  if (!task) return;
  // After close() (or terminate) later tasks are discarded (HTML "closing" flag): never run, and destroyed in
  // teardown after the modules' per-isolate states (dropped_tasks_), so native completions free what they own.
  if (closing_ || handle().terminate_requested()) {
    dropped_tasks_.push_back(std::move(task));
    return;
  }
  v8::HandleScope hs(isolate_);
  if (context_.IsEmpty()) {
    task();
    return;
  }
  v8::Context::Scope cs(context());
  {
    CallScope scope(*this);
    task();
  }
  run_microtasks();
}

void WorkerRuntime::fire_timer(const TimerQueue::Fired& fired) {
  if (closing_ || context_.IsEmpty()) return;
  v8::HandleScope hs(isolate_);
  v8::Context::Scope cs(context());
  loop_.timers().begin_callback(fired);
  v8::Local<v8::Value> argv[] = {v8::Integer::New(isolate_, fired.id)};
  call_hook("timer", 1, argv);
  run_microtasks();
  loop_.timers().end_callback(now_ms());
}

void WorkerRuntime::run_animation_frame(double now) {
  if (closing_ || context_.IsEmpty() || hooks_.IsEmpty()) return;
  v8::HandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = context();
  v8::Context::Scope cs(ctx);
  v8::Local<v8::Value> now_v = v8::Number::New(isolate_, now);
  v8::Local<v8::Value> begin_argv[] = {now_v};
  v8::Local<v8::Value> snapshot, run_one;
  if (!hooks()->Get(ctx, v8str(isolate_, "frameCallback")).ToLocal(&run_one) || !run_one->IsFunction()) return;
  if (!call_hook("frameBegin", 1, begin_argv).ToLocal(&snapshot) || !snapshot->IsArray()) return;
  v8::Local<v8::Array> handles = snapshot.As<v8::Array>();
  for (uint32_t i = 0; i < handles->Length() && !closing_ && !isolate_->IsExecutionTerminating(); ++i) {
    v8::HandleScope per(isolate_);
    v8::Local<v8::Value> handle;
    if (!handles->Get(ctx, i).ToLocal(&handle)) continue;
    v8::Local<v8::Value> argv[] = {handle, now_v};
    {
      CallScope scope(*this);
      (void)run_one.As<v8::Function>()->Call(ctx, hooks(), 2, argv);
    }
    run_microtasks();
  }
}

void WorkerRuntime::run_microtasks() {
  if (!isolate_) return;
  for (int round = 0; round < 8; ++round) {
    isolate_->PerformMicrotaskCheckpoint();
    if (pending_rejections_.empty() && handled_later_.empty()) break;
    process_rejections();
  }
}

void WorkerRuntime::process_rejections() {
  std::vector<PendingRejection> pending;
  pending.swap(pending_rejections_);
  std::vector<v8::Global<v8::Promise>> handled;
  handled.swap(handled_later_);
  v8::HandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = context();
  for (auto& p : pending) {
    v8::Local<v8::Promise> promise = p.promise.Get(isolate_);
    v8::Local<v8::Value> reason = p.reason.Get(isolate_);
    v8::Local<v8::Value> argv[] = {promise, reason};
    v8::Local<v8::Value> r;
    bool should_log = true;
    if (call_hook("rejection", 2, argv).ToLocal(&r) && r->IsFalse()) should_log = false;
    if (promise->HasHandler()) should_log = false;
    if (should_log) {
      log_js(LogLevel::kError, "[" + handle().label + "] Uncaught (in promise) " + exception_text(isolate_, ctx, reason));
    }
    if (reported_rejections_.size() >= 256) reported_rejections_.erase(reported_rejections_.begin());
    reported_rejections_.emplace_back(isolate_, promise);
  }
  for (auto& h : handled) {
    v8::Local<v8::Promise> promise = h.Get(isolate_);
    v8::Local<v8::Value> argv[] = {promise, promise->Result()};
    call_hook("rejectionHandled", 2, argv);
  }
}

void WorkerRuntime::promise_reject(v8::PromiseRejectMessage message) {
  WorkerRuntime* rt = current();
  if (!rt) return;
  v8::Isolate* isolate = rt->isolate_;
  v8::Local<v8::Promise> promise = message.GetPromise();
  switch (message.GetEvent()) {
    case v8::kPromiseRejectWithNoHandler:
      rt->pending_rejections_.push_back(
          {v8::Global<v8::Promise>(isolate, promise), v8::Global<v8::Value>(isolate, message.GetValue())});
      break;
    case v8::kPromiseHandlerAddedAfterReject: {
      auto& pend = rt->pending_rejections_;
      for (auto it = pend.begin(); it != pend.end(); ++it) {
        if (it->promise.Get(isolate) == promise) {
          pend.erase(it);
          return;
        }
      }
      auto& rep = rt->reported_rejections_;
      for (auto it = rep.begin(); it != rep.end(); ++it) {
        if (it->Get(isolate) == promise) {
          rt->handled_later_.emplace_back(isolate, promise);
          rep.erase(it);
          return;
        }
      }
      break;
    }
    default:
      break;
  }
}

void WorkerRuntime::message_listener(v8::Local<v8::Message> message, v8::Local<v8::Value> data) {
  WorkerRuntime* rt = current();
  if (!rt || rt->context_.IsEmpty()) return;
  rt->listener_reported = true;
  rt->report_exception(data, message);
}

void WorkerRuntime::report_exception(v8::Local<v8::Value> exception, v8::Local<v8::Message> message) {
  counter_uncaught++;
  v8::HandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = context();
  std::string text = exception_text(isolate_, ctx, exception);
  std::string url, msg_text;
  int line = 0, col = 0;
  if (!message.IsEmpty()) {
    url = utf8(isolate_, message->GetScriptResourceName());
    line = message->GetLineNumber(ctx).FromMaybe(0);
    col = message->GetStartColumn(ctx).FromMaybe(-1) + 1;
    msg_text = utf8(isolate_, message->Get());
  } else {
    msg_text = text;
  }
  // HTML §10.2.5: the error event at the worker global first; if not cancelled, at the Worker object in the creator.
  bool cancelled = false;
  if (!in_error_reporting) {
    in_error_reporting = true;
    v8::Local<v8::Value> argv[] = {exception, v8str(isolate_, msg_text), v8str(isolate_, url),
                                   v8::Integer::New(isolate_, line), v8::Integer::New(isolate_, col)};
    v8::Local<v8::Value> r;
    if (call_hook("error", 5, argv).ToLocal(&r) && r->IsFalse()) cancelled = true;
    in_error_reporting = false;
  } else {
    // An error handler that throws: console only (error reporting mode).
    log_js(LogLevel::kError, "[" + handle().label + "] Uncaught " + text);
    return;
  }
  if (cancelled) return;
  std::string where = url.empty() ? "" : url + ":" + std::to_string(line) + ":" + std::to_string(col);
  std::string full = "Uncaught " + text;
  if (!where.empty() && text.find(url + ":" + std::to_string(line)) == std::string::npos) full += "\n    at " + where;
  forward_error_to_parent(msg_text, url, line, col);
  // The full text (with the stack) is logged here; the creator logs one line if nobody handles it there (WRK-7).
  log_js(LogLevel::kDebug, "[" + handle().label + "] " + full);
}

void WorkerRuntime::forward_error_to_parent(const std::string& message, const std::string& filename, int line,
                                            int col) {
  WorkerHandle& h = handle();
  uint64_t id = h.id;
  bool posted = h.parent && h.parent->post([id, message, filename, line, col](IsolateBinding& b) {
    b.child_error(id, message, filename, line, col);
  });
  if (!posted) log_js(LogLevel::kError, "[" + h.label + "] Uncaught " + message);
}

size_t WorkerRuntime::near_heap_limit(void* data, size_t current, size_t) {
  auto* rt = static_cast<WorkerRuntime*>(data);
  if (!rt->heap_raised_) {
    rt->heap_raised_ = true;
    rt->oom_ = true;
    log(LogLevel::kError, "%s: JS heap at its limit (%.0f MB, config workers.heapLimitMB): terminating the worker (WRK-9)",
        rt->handle().label.c_str(), current / 1048576.0);
    rt->isolate_->TerminateExecution();
    rt->closing_ = true;
    rt->loop_.request_quit();
    WorkerHandle& h = rt->handle();
    uint64_t id = h.id;
    std::string msg = "Worker terminated: out of memory (heap limit " +
                      std::to_string(rt->env().config.heap_limit_bytes >> 20) + " MB)";
    if (h.parent) {
      h.parent->post([id, msg](IsolateBinding& b) { b.child_error(id, msg, "", 0, 0); });
    }
    // Room to unwind the terminated script without a fatal OOM.
    return current + (64u << 20);
  }
  return current + (16u << 20);
}

void WorkerRuntime::teardown() {
  WorkerHandle& h = handle();
  // From here terminate() only sets the flag: it never touches the isolate again.
  h.detach();
  if (!isolate_) return;
  {
    v8::Isolate::Scope isolate_scope(isolate_);
    isolate_->CancelTerminateExecution();
    v8::HandleScope hs(isolate_);
    if (owner_) owner_->kill();
    if (binding_) {
      binding_->shutdown();  // children terminated, ports closed, pending messages dropped
      binding_->join_children(env().config.join_timeout_ms);
    }
    PortHub::shared().close(h.inside_port);
    if (!context_.IsEmpty()) {
      v8::Context::Scope cs(context());
      dispose_module_isolates(isolate_);
    }
    // The modules' states are disposed: completions dropped while closing now only free what they own.
    dropped_tasks_.clear();
    iwn::UnbindLoopHooks(isolate_);
    take_binding_for(isolate_);
    binding_.reset();
    modules_by_hash_.clear();
    modules_.clear();
    failed_modules_.clear();
    pending_rejections_.clear();
    reported_rejections_.clear();
    handled_later_.clear();
    hooks_.Reset();
    blob_resolver_.Reset();
    context_.Reset();
    // Destroy every queued task while the isolate is alive (tasks may hold V8 platform work).
    loop_.close();
  }
  iwn::dispose_isolate(isolate_);
  isolate_ = nullptr;
  allocator_.reset();  // BackingStores still alive elsewhere keep their own reference
}

// --- WorkerHandle ----------------------------------------------------------------------------------------------

void WorkerHandle::terminate() {
  terminate_requested_ = true;
  std::lock_guard<std::mutex> lock(mu_);
  if (isolate_) isolate_->TerminateExecution();  // thread-safe; interrupts JS and wasm loops (WRK-8)
  if (loop_) loop_->request_quit();
}

void WorkerHandle::attach(v8::Isolate* isolate, EventLoop* loop) {
  std::lock_guard<std::mutex> lock(mu_);
  isolate_ = isolate;
  loop_ = loop;
  if (terminate_requested_) {
    isolate_->TerminateExecution();
    loop_->request_quit();
  }
}

void WorkerHandle::detach() {
  std::lock_guard<std::mutex> lock(mu_);
  isolate_ = nullptr;
  loop_ = nullptr;
}

void WorkerHandle::mark_done() {
  {
    std::lock_guard<std::mutex> lock(mu_);
    done_ = true;
  }
  cv_.notify_all();
}

bool WorkerHandle::done() {
  std::lock_guard<std::mutex> lock(mu_);
  return done_;
}

bool WorkerHandle::wait_done(double timeout_ms) {
  std::unique_lock<std::mutex> lock(mu_);
  return cv_.wait_for(lock, std::chrono::microseconds(static_cast<int64_t>(timeout_ms * 1000)), [this] { return done_; });
}

}  // namespace iwn::workers
