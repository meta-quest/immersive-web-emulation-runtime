/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The main isolate: engine setup, the page context, the event loop hooks, error and rejection reporting,
// lifecycle, reload and teardown. Written from the V8 embedder guide/headers and HTML §8.1 (event loop,
// "report the exception", unhandled rejections), against docs/spec/01..03 and 14.
#include <pthread.h>
#include <sys/resource.h>
#include <unistd.h>

#include <chrono>
#include <cmath>
#include <cstring>
#include <utility>

#include "iwn/core/clock.h"
#include "iwn/core/log.h"
#include "iwn/core/module_registry.h"
#include "iwn/core/platform.h"
#include "iwn/core/text.h"
#include "v8/runtime_impl.h"
#include "v8/v8_util.h"

#ifndef IWN_RUNTIME_VERSION
#define IWN_RUNTIME_VERSION "0.0.0"
#endif
#ifndef IWN_BUILD_ID
#define IWN_BUILD_ID "unknown"
#endif

namespace iwn {

extern const char kBootstrapJs[];
extern const size_t kBootstrapJsSize;
void install_core_natives(RuntimeImpl& rt, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);

namespace {
constexpr int kIsolateSlot = 0;
constexpr size_t kJsThreadStack = 8u << 20;
constexpr size_t kStackHeadroom = 512u << 10;   // keep V8's limit this far from the real end of the stack
constexpr size_t kOldSpaceBytes = 1536ull << 20;  // JS-4: >= 1 GB on Quest 3/3S
}  // namespace

Runtime* Runtime::From(v8::Isolate* isolate) {
  return isolate ? static_cast<RuntimeImpl*>(isolate->GetData(kIsolateSlot)) : nullptr;
}

std::unique_ptr<RuntimeHost> create_runtime_host(RuntimeOptions options) {
  return std::make_unique<RuntimeImpl>(std::move(options));
}

RuntimeImpl::RuntimeImpl(RuntimeOptions options) : options_(std::move(options)) {
  init_clock();
  boot_marks_.emplace_back("processStart", 0.0);
}

RuntimeImpl::~RuntimeImpl() {
  if (thread_.joinable()) {
    if (finished_) {
      thread_.join();
    } else {
      thread_.detach();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// RuntimeHost

void RuntimeImpl::start() {
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, kJsThreadStack);
  pthread_t tid;
  // std::thread cannot set a stack size; run thread_main on a pthread and keep std::thread unused.
  auto trampoline = [](void* self) -> void* {
    static_cast<RuntimeImpl*>(self)->thread_main();
    return nullptr;
  };
  if (pthread_create(&tid, &attr, trampoline, this) != 0) {
    log(LogLevel::kError, "could not start the JS thread");
  } else {
    pthread_detach(tid);
  }
  pthread_attr_destroy(&attr);
}

void RuntimeImpl::post_lifecycle(LifecycleInput input) {
  loop_.post([this, input] {
    if (!isolate_) return;
    dispatch_page_events(lifecycle_.apply(input));
  });
}

void RuntimeImpl::post_low_memory() {
  loop_.post([this] {
    if (isolate_) isolate_->LowMemoryNotification();
  });
}

void RuntimeImpl::request_quit() {
  if (exit_requested_.exchange(true)) return;
  loop_.post([this] {
    if (isolate_) dispatch_page_events(lifecycle_.apply(LifecycleInput::kDestroy));
    loop_.request_quit();
  });
  // Watchdog: a page stuck in a long task must not keep the process from tearing down.
  // isolate_, finished_ and tearing_down_ are read under join_mu_, and teardown sets tearing_down_ (and clears
  // isolate_) under it, so TerminateExecution can neither hit a disposed isolate nor land after teardown's
  // CancelTerminateExecution and abort the shutdown hooks (PROC-7).
  std::thread([this] {
    pthread_setname_np(pthread_self(), "iwn-quit-watch");
    std::unique_lock<std::mutex> lock(join_mu_);
    if (!join_cv_.wait_for(lock, std::chrono::seconds(3), [this] { return finished_ || tearing_down_; })) {
      if (isolate_) {
        log(LogLevel::kWarn, "JS thread did not reach teardown within 3 s; terminating script execution");
        isolate_->TerminateExecution();
        loop_.request_quit();
      }
    }
  }).detach();
}

bool RuntimeImpl::join(int timeout_ms) {
  std::unique_lock<std::mutex> lock(join_mu_);
  return join_cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms), [this] { return finished_; });
}

// ---------------------------------------------------------------------------------------------------------------
// Engine and context

bool RuntimeImpl::boot_engine() {
  // Config.
  std::vector<std::string> warnings;
  // CDP-1/CDP-10 fail closed: without explicit config keys the inspector and debug endpoint follow FLAG_DEBUGGABLE.
  RuntimeConfig base;
  base.inspector_enabled = options_.debuggable;
  base.debug_enabled = options_.debuggable;
  config_ = base;
  if (auto bytes = options_.assets->read(options_.config_asset)) {
    std::string err;
    auto json = Json::parse(bytes->view(), &err);
    if (!json) {
      log(LogLevel::kError, "%s: invalid JSON (%s); using defaults", options_.config_asset.c_str(), err.c_str());
    } else {
      config_ = parse_runtime_config(*json, &warnings, base);
    }
  } else {
    log(LogLevel::kWarn, "%s missing; using defaults (dist under assets/%s/)", options_.config_asset.c_str(),
        config_.app_root.c_str());
  }
  for (const auto& w : warnings) log(LogLevel::kWarn, "config: %s", w.c_str());
  if (config_.package_id.empty()) config_.package_id = options_.package_name;
  if (options_.version_code) config_.version_code = options_.version_code;
  if (!options_.version_name.empty()) config_.version_name = options_.version_name;
  // Launch overrides (CDP-8, JS-3) apply in debuggable builds, or when the config already enables the inspector.
  // The activity is exported, so any app can start it with extras: the ones that change how the engine runs
  // (iwn.v8flags, iwn.inspectBrk) apply in debuggable builds only.
  bool overrides_allowed = options_.debuggable || config_.inspector_enabled;
  if (overrides_allowed) {
    if (options_.debuggable && options_.inspect_brk >= 0) config_.wait_for_debugger = options_.inspect_brk == 1;
    if (options_.inspector >= 0) config_.inspector_enabled = options_.inspector == 1;
  }
  if (config_.wait_for_debugger) config_.inspector_enabled = true;
  origin_url_ = *parse_url(config_.origin + "/");
  document_url_ = origin_url_;
  // The query string the page sees (DOM-5): a launch override (`am start --es iwn.query a=1`, PKG-CFG-3) in the
  // builds that honour overrides. location.search, document.URL and the glue's navigation state follow it.
  if (overrides_allowed && !options_.extra_query.empty()) {
    std::string q = options_.extra_query;
    if (q[0] != '?') q = "?" + q;
    if (auto u = parse_url(config_.origin + "/" + q)) {
      document_url_ = *u;
      log(LogLevel::kInfo, "launch override: document URL %s", document_url_.href().c_str());
    } else {
      log(LogLevel::kWarn, "launch override iwn.query ignored: \"%s\" is not a valid query string", options_.extra_query.c_str());
    }
  }

  // JS-3: config.v8Flags is a diagnostic aid, honoured only in debuggable builds; the runtime's own flags are
  // applied after it either way (platform.cc kRuntimeFlags), so neither source can switch off a JIT tier or Wasm.
  std::string flags;
  if (!config_.v8_flags.empty()) {
    if (options_.debuggable) {
      flags = config_.v8_flags;
    } else {
      log(LogLevel::kWarn, "config.v8Flags ignored in a non-debuggable build: \"%s\"", config_.v8_flags.c_str());
    }
  }
  if (options_.debuggable && !options_.extra_v8_flags.empty()) {
    flags += (flags.empty() ? "" : " ") + options_.extra_v8_flags;
  }
  V8InitOptions init;
  init.snapshot = options_.assets->read(options_.snapshot_asset);
  init.diagnostic_flags = flags;
  if (!initialize_v8(init)) return false;
  mark_boot("engineInitialized");

  allocator_ = v8::ArrayBuffer::Allocator::NewDefaultAllocator();
  v8::Isolate::CreateParams params;
  params.array_buffer_allocator = allocator_;
  params.constraints.set_max_old_generation_size_in_bytes(kOldSpaceBytes);
  isolate_ = new_isolate(params, &loop_);
  isolate_->SetData(kIsolateSlot, static_cast<Runtime*>(this));

  // Stack limit: this thread has kJsThreadStack; let V8 use all but the headroom.
  char probe;
  uintptr_t here = reinterpret_cast<uintptr_t>(&probe);
  isolate_->SetStackLimit(here - (kJsThreadStack - kStackHeadroom));

  // Isolate settings that allocate handles need the isolate entered.
  v8::Isolate::Scope isolate_scope(isolate_);
  v8::HandleScope handle_scope(isolate_);
  isolate_->SetMicrotasksPolicy(v8::MicrotasksPolicy::kExplicit);  // JS-5, LOOP-1
  isolate_->SetPromiseRejectCallback(&RuntimeImpl::promise_reject_callback);
  isolate_->AddMessageListenerWithErrorLevel(&RuntimeImpl::message_listener, v8::Isolate::kMessageError);
  isolate_->SetCaptureStackTraceForUncaughtExceptions(true, 32);
  isolate_->AddNearHeapLimitCallback(&RuntimeImpl::near_heap_limit, this);
  isolate_->AddGCPrologueCallback(&RuntimeImpl::gc_prologue, this);
  isolate_->AddGCEpilogueCallback(&RuntimeImpl::gc_epilogue, this);
  isolate_->SetAllowAtomicsWait(false);  // as on a browser main thread

  modules_ = std::make_unique<ModuleLoader>(*this);
  devtools_ = std::make_unique<DevTools>(*this);
  if (config_.code_cache_enabled && !options_.cache_dir.empty()) {
    std::string stamp = "versionCode=" + std::to_string(config_.version_code) + ";build=" + IWN_BUILD_ID +
                        ";v8=" + v8::V8::GetVersion();
    code_cache_ = std::make_shared<CodeCacheStore>(options_.cache_dir + "/iwn-code-cache", stamp,
                                                   config_.code_cache_max_bytes);
  }
  return true;
}

// CON-3: console calls go through bootstrap.js wrappers (logcat formatting), so the first stack frames of every
// Runtime.consoleAPICalled are runtime frames. An inline source map that ignore-lists the bootstrap (identity
// mappings, `ignoreList` and the older `x_google_ignoreList`) makes DevTools skip those frames, so console messages
// and uncaught timer errors link to the app's own code. Built once per process.
static std::string bootstrap_source_with_ignore_map() {
  std::string src(kBootstrapJs, kBootstrapJsSize);
  size_t lines = 1;
  for (char c : src) lines += c == '\n';
  std::string mappings = "AAAA";  // generated line 1, col 0 -> source 0, line 0, col 0
  mappings.reserve(lines * 5);
  for (size_t i = 1; i < lines; ++i) mappings += ";AACA";  // each next line maps to the next source line
  Json sources = Json::array();
  sources.push("iwn-runtime:///core/bootstrap.source.js");
  Json content = Json::array();
  content.push(src);
  Json ignore = Json::array();
  ignore.push(0);
  Json map = Json::object();
  map.set("version", 3);
  map.set("file", "bootstrap.js");
  map.set("sources", sources);
  map.set("sourcesContent", content);
  map.set("names", Json::array());
  map.set("mappings", mappings);
  map.set("ignoreList", ignore);
  map.set("x_google_ignoreList", ignore);
  std::string json = map.dump();
  if (!src.empty() && src.back() != '\n') src.push_back('\n');
  src += "//# sourceMappingURL=data:application/json;charset=utf-8;base64," + base64_encode(json.data(), json.size());
  src.push_back('\n');
  return src;
}

bool RuntimeImpl::create_context() {
  v8::HandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = v8::Context::New(isolate_);
  if (ctx.IsEmpty()) return false;
  context_.Reset(isolate_, ctx);
  v8::Context::Scope cs(ctx);
  modules_->install_isolate_callbacks(isolate_);

  // globalThis.__iwn: non-enumerable, so page code iterating globals does not see it.
  v8::Local<v8::Object> natives = v8::Object::New(isolate_);
  ctx->Global()
      ->DefineOwnProperty(ctx, v8u::sym(isolate_, "__iwn"), natives, v8::DontEnum)
      .Check();
  install_natives(ctx, natives);

  devtools_->context_created(ctx);

  // Core bootstrap: console, timers, rAF, microtasks, error/rejection/lifecycle hooks.
  v8::TryCatch tc(isolate_);
  v8::ScriptOrigin origin(v8u::str(isolate_, "iwn-runtime:///core/bootstrap.js"));
  v8::Local<v8::Script> script;
  v8::Local<v8::Value> fn;
  static const std::string kBootstrapWithMap = bootstrap_source_with_ignore_map();
  if (!v8::Script::Compile(ctx, v8u::str(isolate_, kBootstrapWithMap), &origin)
           .ToLocal(&script) ||
      !script->Run(ctx).ToLocal(&fn) || !fn->IsFunction()) {
    log(LogLevel::kError, "core bootstrap failed to compile: %s",
        v8u::exception_text(isolate_, ctx, tc.Exception()).c_str());
    return false;
  }
  v8::Local<v8::Value> args[] = {natives, ctx->Global()};
  if (fn.As<v8::Function>()->Call(ctx, ctx->Global(), 2, args).IsEmpty()) {
    log(LogLevel::kError, "core bootstrap threw: %s", v8u::exception_text(isolate_, ctx, tc.Exception()).c_str());
    return false;
  }
  return true;
}

void RuntimeImpl::install_natives(v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives) {
  install_core_natives(*this, ctx, natives);
  for (int i = 0; i < kNativeModuleCount; ++i) {
    const NativeModuleEntry& m = kNativeModules[i];
    v8::TryCatch tc(isolate_);
    m.fn(isolate_, ctx, natives);
    if (tc.HasCaught()) {
      log(LogLevel::kError, "native module %s threw during registration: %s", m.name,
          v8u::exception_text(isolate_, ctx, tc.Exception()).c_str());
    }
  }
}

void RuntimeImpl::dispose_context() {
  if (context_.IsEmpty()) return;
  v8::HandleScope hs(isolate_);
  devtools_->context_destroyed(context());
  hooks_.Reset();
  blob_resolver_.Reset();
  pending_rejections_.clear();
  reported_rejections_.clear();
  handled_later_.clear();
  modules_->reset();
  context_.Reset();
}

// ---------------------------------------------------------------------------------------------------------------
// Boot: preludes, index.html classic scripts, module entry (PROC-5, MOD-1)

void RuntimeImpl::boot_page() {
  v8::HandleScope hs(isolate_);
  v8::Local<v8::Context> ctx = context();
  v8::Context::Scope cs(ctx);
  ready_state_ = "loading";

  for (const std::string& path : config_.preludes) {
    auto bytes = options_.assets->read(path);
    if (!bytes) {
      log(LogLevel::kError, "prelude %s not found in assets", path.c_str());
      continue;
    }
    {
      PageCallScope scope(*this);
      (void)modules_->run_classic("iwn-runtime:///" + path, std::string(bytes->view()));
    }
    run_microtasks();
  }
  mark_boot("preludesEvaluated");

  std::string index_path = config_.index;
  auto index = read_app_file(index_path);
  if (!index) {
    log(LogLevel::kError, "no %s in assets/%s/: nothing to run (the debug endpoint stays available)",
        index_path.c_str(), config_.app_root.c_str());
    return;
  }
  HtmlDocumentInfo doc = scan_html(index->view());
  title_ = doc.title;
  devtools_->set_title(title_);
  Url base = document_url_;
  if (!doc.base_href.empty()) {
    if (auto b = parse_url(doc.base_href, &document_url_)) base = *b;
  }
  const std::string index_url = origin_url_.href() + index_path;  // the entry document's URL (no query string)

  // Classic scripts first, in document order (MOD-1).
  int inline_n = 0;
  for (const HtmlScript& s : doc.scripts) {
    if (!s.classic) continue;
    std::string source, error, script_url = index_url;
    if (!s.src.empty()) {
      auto url = parse_url(s.src, &base);
      if (!url || !modules_->fetch_source(url->href(), &source, &error)) {
        log_js(LogLevel::kError, "classic script " + s.src + " failed to load: " + (url ? error : "bad URL"));
        continue;
      }
      script_url = url->href();
    }
    {
      PageCallScope scope(*this);
      if (s.src.empty()) {
        (void)modules_->run_classic(index_url, s.inline_text, static_cast<int>(s.line) - 1);
      } else {
        (void)modules_->run_classic(script_url, source);
      }
    }
    run_microtasks();
  }

  // Then module scripts in document order; the first is the entry.
  bool have_module = false;
  for (const HtmlScript& s : doc.scripts) {
    if (!s.module) continue;
    have_module = true;
    std::string url;
    if (s.src.empty()) {
      url = index_url + "#inline-module-" + std::to_string(++inline_n);
    } else {
      auto u = parse_url(s.src, &base);
      if (!u) {
        log_js(LogLevel::kError, "module script has an invalid URL: " + s.src);
        continue;
      }
      url = u->href();
    }
    v8::TryCatch tc(isolate_);
    v8::Local<v8::Value> result;
    if (!modules_->run_module(url, s.src.empty() ? &s.inline_text : nullptr).ToLocal(&result)) {
      // Fetch/parse/link errors (PROC-9: one clearly tagged line with the URL; REG-20).
      if (tc.HasCaught() && !tc.HasTerminated()) {
        report_exception_value(tc.Exception(), tc.Message(), "entry module " + url + " failed: ");
      }
      run_microtasks();
      continue;
    }
    if (result->IsPromise()) {
      // Evaluation errors and top-level-await rejections: reported once, with the module URL.
      auto promise = result.As<v8::Promise>();
      auto on_reject = [](const v8::FunctionCallbackInfo<v8::Value>& info) {
        auto* rt = static_cast<RuntimeImpl*>(Runtime::From(info.GetIsolate()));
        std::string url = v8u::to_utf8(info.GetIsolate(), info.Data());
        v8::Local<v8::Value> reason = info.Length() > 0 ? info[0] : v8::Undefined(info.GetIsolate()).As<v8::Value>();
        rt->report_exception_value(reason, v8::Exception::CreateMessage(info.GetIsolate(), reason),
                                   "entry module " + url + " failed: ");
      };
      v8::Local<v8::Function> reject_fn =
          v8::Function::New(ctx, on_reject, v8u::str(isolate_, url)).ToLocalChecked();
      (void)promise->Catch(ctx, reject_fn);
    }
    run_microtasks();
  }
  if (!have_module) {
    log(LogLevel::kError, "%s has no <script type=\"module\"> entry", index_path.c_str());
  }
  mark_boot("entryEvaluated");

  // DOMContentLoaded then load (module scripts have run; top-level await does not delay these).
  ready_state_ = "interactive";
  {
    v8::Local<v8::Value> argv[] = {v8u::str(isolate_, "interactive")};
    call_hook("documentReady", 1, argv);
    run_microtasks();
  }
  ready_state_ = "complete";
  {
    v8::Local<v8::Value> argv[] = {v8u::str(isolate_, "complete")};
    call_hook("documentReady", 1, argv);
    run_microtasks();
  }

  schedule_code_cache_pass();
}

void RuntimeImpl::schedule_code_cache_pass() {
  if (!code_cache_ || code_cache_scheduled_) return;
  code_cache_scheduled_ = true;
  uint64_t gen = generation_;
  loop_.post_delayed(
      [this, gen] {
        if (gen != generation_) return;  // a pass for a page that has since reloaded
        code_cache_scheduled_ = false;
        code_cache_first_pass_done_ = true;
        modules_->produce_code_caches();
        mark_boot("codeCacheWritten");
      },
      config_.code_cache_delay_ms);
}

void RuntimeImpl::note_uncached_script() {
  // CC-1/CC-2: chunks imported after the first pass get their own (debounced) pass.
  if (code_cache_first_pass_done_) schedule_code_cache_pass();
}

// ---------------------------------------------------------------------------------------------------------------
// The JS thread

void RuntimeImpl::log_boot_line() {
  std::string gl, xr;
  {
    std::lock_guard<std::mutex> lock(info_mu_);
    gl = info_fields_.count("glRenderer") ? info_fields_["glRenderer"] : "n/a";
    xr = info_fields_.count("openxrRuntime") ? info_fields_["openxrRuntime"] : "n/a";
  }
  log(LogLevel::kInfo,
      "iwer-native %s (build %s) V8 %s | device %s %s | OS %s | app %s %s (%lld) | GL %s | OpenXR %s | modules %d",
      IWN_RUNTIME_VERSION, IWN_BUILD_ID, v8::V8::GetVersion(), options_.device.manufacturer.c_str(),
      options_.device.model.c_str(), options_.device.fingerprint.c_str(), config_.package_id.c_str(),
      config_.version_name.c_str(), static_cast<long long>(config_.version_code), gl.c_str(), xr.c_str(),
      kNativeModuleCount);
}

void RuntimeImpl::thread_main() {
  pthread_setname_np(pthread_self(), "iwn-js");
  js_thread_ = pthread_self();
  if (!boot_engine()) {
    log(LogLevel::kError, "engine failed to start");
    std::lock_guard<std::mutex> lock(join_mu_);
    finished_ = true;
    join_cv_.notify_all();
    return;
  }
  {
    v8::Isolate::Scope isolate_scope(isolate_);
    v8::HandleScope outer(isolate_);
    devtools_->create_inspector(isolate_);

    EventLoop::Hooks hooks;
    hooks.run_task = [this](EventLoop::Task& t) { run_task(t); };
    hooks.fire_timer = [this](const TimerQueue::Fired& f) { fire_timer(f); };
    hooks.run_animation_frame = [this](double now) { run_animation_frame(now); };
    hooks.after_iteration = [this] { after_iteration(); };
    loop_.set_hooks(hooks);

    if (!create_context()) {
      log(LogLevel::kError, "could not create the page context");
    } else {
      mark_boot("contextReady");
      log_boot_line();
      devtools_->start_server();
      if (config_.wait_for_debugger) devtools_->wait_for_debugger();
      if (!exit_requested_) boot_page();
    }

    while (!loop_.quit_requested()) {
      loop_.run_once(60000);
      if (reload_requested_.exchange(false) && !loop_.quit_requested()) {
        log(LogLevel::kInfo, "location.reload(): restarting the page in a fresh context");
        {
          v8::HandleScope hs(isolate_);
          v8::Context::Scope cs(context());
          std::vector<PageEvent> ev = {{PageEvent::Target::kWindow, "pagehide"}};
          dispatch_page_events(ev);
        }
        dispose_context();
        if (reload_url_) {
          document_url_ = *reload_url_;
          reload_url_.reset();
        }
        loop_.reset_for_reload();
        generation_++;
        code_cache_scheduled_ = false;
        code_cache_first_pass_done_ = false;
        if (create_context()) boot_page();
      }
    }
    teardown();
  }
  v8::Isolate* isolate = isolate_;
  {
    std::lock_guard<std::mutex> lock(join_mu_);
    isolate_ = nullptr;
  }
  dispose_isolate(isolate);
  delete allocator_;
  allocator_ = nullptr;
  log(LogLevel::kInfo, "runtime stopped");
  std::function<void()> on_exit = options_.on_exit_requested;
  {
    std::lock_guard<std::mutex> lock(join_mu_);
    finished_ = true;
    join_cv_.notify_all();
  }
  if (on_exit && exit_requested_) on_exit();
}

void RuntimeImpl::teardown() {
  // PROC-7: pagehide already dispatched by request_quit's task. Shutdown hooks in reverse order, then the server,
  // then the context.
  {
    std::lock_guard<std::mutex> lock(join_mu_);
    tearing_down_ = true;  // the quit watchdog stands down from here (it holds join_mu_ while terminating)
  }
  isolate_->CancelTerminateExecution();
  // The import() reader is joined first: whatever it already posted is still queued and is destroyed below.
  modules_->stop_reader();
  {
    v8::HandleScope hs(isolate_);
    if (!context_.IsEmpty()) {
      v8::Context::Scope cs(context());
      for (auto it = shutdown_hooks_.rbegin(); it != shutdown_hooks_.rend(); ++it) {
        v8::TryCatch tc(isolate_);
        (*it)();
      }
    }
  }
  shutdown_hooks_.clear();
  devtools_->stop_server();
  dispose_context();
  // Refuse later posts and destroy every queued task here, on the JS thread while the isolate is alive (tasks may
  // hold v8::Global handles and file bytes), so nothing posted to this page outlives it (PROC-7).
  loop_.close();
  devtools_.reset();
  modules_.reset();
}

void RuntimeImpl::assert_js_thread(const char* where) const {
  if (js_thread_ && !pthread_equal(js_thread_, pthread_self())) {
    log(LogLevel::kError, "PROC-2 violation: %s entered the main isolate off the JS thread", where);
#ifndef NDEBUG
    abort();
#endif
  }
}

void RuntimeImpl::run_task(EventLoop::Task& task) {
  if (!task) return;
  assert_js_thread("a task");
  v8::HandleScope hs(isolate_);
  if (context_.IsEmpty()) {
    task();
    return;
  }
  v8::Local<v8::Context> ctx = context();
  v8::Context::Scope cs(ctx);
  {
    PageCallScope scope(*this);
    task();
  }
  run_microtasks();
}

void RuntimeImpl::fire_timer(const TimerQueue::Fired& fired) {
  assert_js_thread("a timer");
  if (context_.IsEmpty()) return;
  v8::HandleScope hs(isolate_);
  v8::Context::Scope cs(context());
  loop_.timers().begin_callback(fired);
  v8::Local<v8::Value> argv[] = {v8::Integer::New(isolate_, fired.id)};
  call_hook("timer", 1, argv);
  run_microtasks();
  loop_.timers().end_callback(now_ms());
}

void RuntimeImpl::run_animation_frame(double now) {
  assert_js_thread("an animation frame");
  if (context_.IsEmpty()) return;
  v8::HandleScope hs(isolate_);
  v8::Context::Scope cs(context());
  bool was_inside = in_frame_callbacks_;
  in_frame_callbacks_ = true;
  // HTML "run the animation frame callbacks": the JS side snapshots the handles, then each callback is called
  // from here under its own PageCallScope (no JS try/catch around page code, CDP-5) with a microtask checkpoint
  // after it (LOOP-1).
  v8::Local<v8::Context> ctx = context();
  v8::Local<v8::Value> now_v = v8::Number::New(isolate_, now);
  v8::Local<v8::Value> snapshot;
  v8::Local<v8::Value> begin_argv[] = {now_v};
  v8::Local<v8::Function> run_one = hook_function("frameCallback");
  if (!run_one.IsEmpty() && call_hook("frameBegin", 1, begin_argv).ToLocal(&snapshot) && snapshot->IsArray()) {
    v8::Local<v8::Array> handles = snapshot.As<v8::Array>();
    uint32_t n = handles->Length();
    for (uint32_t i = 0; i < n && !loop_.quit_requested() && !isolate_->IsExecutionTerminating(); ++i) {
      v8::HandleScope per_callback(isolate_);
      v8::Local<v8::Value> handle;
      if (!handles->Get(ctx, i).ToLocal(&handle)) continue;
      v8::Local<v8::Value> argv[] = {handle, now_v};
      call_hook_function(run_one, 2, argv);
      run_microtasks();
    }
  }
  run_microtasks();
  in_frame_callbacks_ = was_inside;
  ++fps_frames_;
  if (now - fps_window_start_ >= 1000) {
    fps_ = fps_frames_ * 1000.0 / (now - fps_window_start_);
    fps_frames_ = 0;
    fps_window_start_ = now;
  }
}

void RuntimeImpl::after_iteration() {
  if (config_.stats_log_interval_ms > 0) {
    double now = now_ms();
    if (now - last_stats_log_ms_ >= config_.stats_log_interval_ms) {
      last_stats_log_ms_ = now;
      v8::HeapStatistics hs;
      isolate_->GetHeapStatistics(&hs);
      const auto& ls = loop_.stats();
      log(LogLevel::kInfo,
          "stats fps=%.1f vis=%s tasks=%llu timers=%zu rafs=%llu heapMB=%.1f gcIn=%llu/%.1fms gcOut=%llu/%.1fms "
          "gcMax=%.1fms",
          fps_, lifecycle_.visibility_state(), static_cast<unsigned long long>(ls.tasks_run), loop_.pending_timers(),
          static_cast<unsigned long long>(ls.animation_frames), hs.used_heap_size() / 1048576.0,
          static_cast<unsigned long long>(gc_.count_in), gc_.ms_in, static_cast<unsigned long long>(gc_.count_out),
          gc_.ms_out, gc_.max_ms);
    }
  }
}

void RuntimeImpl::run_microtasks() {
  if (!isolate_) return;
  for (int round = 0; round < 8; ++round) {
    isolate_->PerformMicrotaskCheckpoint();
    if (pending_rejections_.empty() && handled_later_.empty()) break;
    process_rejections();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Errors and rejections (LOOP-4, PROC-9)

PageCallScope::PageCallScope(RuntimeImpl& rt)
    : rt_(rt), tc_(rt.isolate()), saved_reported_(std::exchange(rt.listener_reported_, false)) {
  tc_.SetVerbose(true);
}

PageCallScope::~PageCallScope() {
  bool reported = rt_.listener_reported_;
  rt_.listener_reported_ = saved_reported_;
  if (tc_.HasCaught() && !tc_.HasTerminated() && !reported) rt_.report_exception(tc_);
}

v8::Local<v8::Function> RuntimeImpl::hook_function(const char* name) {
  if (hooks_.IsEmpty() || context_.IsEmpty()) return {};
  v8::Local<v8::Value> fn;
  if (!hooks()->Get(context(), v8u::sym(isolate_, name)).ToLocal(&fn) || !fn->IsFunction()) return {};
  return fn.As<v8::Function>();
}

v8::MaybeLocal<v8::Value> RuntimeImpl::call_hook_function(v8::Local<v8::Function> fn, int argc,
                                                          v8::Local<v8::Value> argv[]) {
  v8::EscapableHandleScope hs(isolate_);
  v8::Local<v8::Value> r;
  {
    PageCallScope scope(*this);
    if (!fn->Call(context(), hooks(), argc, argv).ToLocal(&r)) return {};
  }
  return hs.Escape(r);
}

v8::MaybeLocal<v8::Value> RuntimeImpl::call_hook(const char* name, int argc, v8::Local<v8::Value> argv[]) {
  v8::Local<v8::Function> fn = hook_function(name);
  if (fn.IsEmpty()) return {};
  return call_hook_function(fn, argc, argv);
}

v8::MaybeLocal<v8::Value> RuntimeImpl::call_function(v8::Local<v8::Function> fn, v8::Local<v8::Value> recv, int argc,
                                                     v8::Local<v8::Value> argv[]) {
  assert_js_thread("Runtime::call_function");
  v8::EscapableHandleScope hs(isolate_);
  v8::Local<v8::Value> result;
  {
    PageCallScope scope(*this);
    (void)fn->Call(context(), recv, argc, argv).ToLocal(&result);
  }
  // HTML "clean up after running a callback": a microtask checkpoint only when no JS is on the stack. A module that
  // calls back into the page from a native function the page called (JS -> native -> callback) must not run
  // microtasks in the middle of that script (JS-5, LOOP-1); the enclosing task's checkpoint runs them.
  if (v8::StackTrace::CurrentStackTrace(isolate_, 1)->GetFrameCount() == 0) run_microtasks();
  if (result.IsEmpty()) return {};
  return hs.Escape(result);
}

void RuntimeImpl::report_exception(const v8::TryCatch& tc) {
  if (tc.HasTerminated() || !tc.HasCaught()) return;
  report_exception_value(tc.Exception(), tc.Message());
}

void RuntimeImpl::report_exception_value(v8::Local<v8::Value> exception, v8::Local<v8::Message> message,
                                         const std::string& log_prefix) {
  counter_uncaught++;
  // HTML "report an exception": while the error event is being dispatched (error reporting mode), a further
  // exception (an error handler that throws, reportError() from a handler) only goes to the console.
  bool dispatch = !in_error_reporting_;
  v8::Local<v8::Context> ctx = context();
  std::string text = v8u::exception_text(isolate_, ctx, exception);
  std::string url, msg_text;
  int line = 0, col = 0;
  if (!message.IsEmpty()) {
    url = v8u::to_utf8(isolate_, message->GetScriptResourceName());
    line = message->GetLineNumber(ctx).FromMaybe(0);
    col = message->GetStartColumn(ctx).FromMaybe(-1) + 1;
    msg_text = v8u::to_utf8(isolate_, message->Get());
  } else {
    msg_text = text;
  }
  bool should_log = true;
  v8::Local<v8::Value> argv[] = {exception, v8u::str(isolate_, msg_text), v8u::str(isolate_, url),
                                 v8::Integer::New(isolate_, line), v8::Integer::New(isolate_, col)};
  v8::Local<v8::Value> r;
  if (dispatch) {
    in_error_reporting_ = true;
    if (call_hook("error", 5, argv).ToLocal(&r) && r->IsFalse()) should_log = false;
    in_error_reporting_ = false;
  }
  if (should_log) {
    std::string where = url.empty() ? "" : url + ":" + std::to_string(line) + ":" + std::to_string(col);
    std::string line_text = log_prefix + "Uncaught " + text;
    if (!where.empty() && text.find(url + ":" + std::to_string(line)) == std::string::npos) {
      line_text += "\n    at " + where;
    }
    log_js(LogLevel::kError, line_text);
    devtools_->exception_thrown(ctx, exception, message, "Uncaught");
  }
}

void RuntimeImpl::promise_reject_callback(v8::PromiseRejectMessage message) {
  v8::Local<v8::Promise> promise = message.GetPromise();
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  auto* rt = static_cast<RuntimeImpl*>(Runtime::From(isolate));
  if (!rt) return;
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

void RuntimeImpl::process_rejections() {
  std::vector<PendingRejection> pending;
  pending.swap(pending_rejections_);
  std::vector<v8::Global<v8::Promise>> handled;
  handled.swap(handled_later_);
  v8::Local<v8::Context> ctx = context();
  for (auto& p : pending) {
    v8::Local<v8::Promise> promise = p.promise.Get(isolate_);
    v8::Local<v8::Value> reason = p.reason.Get(isolate_);
    counter_rejections++;
    bool should_log = true;
    v8::Local<v8::Value> argv[] = {promise, reason};
    v8::Local<v8::Value> r;
    if (call_hook("rejection", 2, argv).ToLocal(&r) && r->IsFalse()) should_log = false;
    // A handler attached by the event listener makes it handled after all.
    if (promise->HasHandler()) should_log = false;
    if (should_log) {
      // Only for a rejection that is logged: exception_text reads `stack` and may call the reason's toString(),
      // which runs page code.
      log_js(LogLevel::kError, "Uncaught (in promise) " + v8u::exception_text(isolate_, ctx, reason));
      devtools_->exception_thrown(ctx, reason, v8::Exception::CreateMessage(isolate_, reason),
                                  "Uncaught (in promise)");
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

void RuntimeImpl::enqueue_rejection_handled(v8::Local<v8::Promise> promise) {
  handled_later_.emplace_back(isolate_, promise);
}

void RuntimeImpl::message_listener(v8::Local<v8::Message> message, v8::Local<v8::Value> data) {
  // Exceptions that reached a verbose TryCatch (PageCallScope) or escaped every TryCatch (e.g. a promise job
  // run by V8). `data` is the exception (the listener was added without data).
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  auto* rt = static_cast<RuntimeImpl*>(Runtime::From(isolate));
  if (!rt || rt->context_.IsEmpty()) return;
  rt->listener_reported_ = true;
  rt->report_exception_value(data, message);
}

size_t RuntimeImpl::near_heap_limit(void* data, size_t current, size_t initial) {
  auto* rt = static_cast<RuntimeImpl*>(data);
  v8::HeapStatistics hs;
  rt->isolate_->GetHeapStatistics(&hs);
  if (!rt->heap_limit_raised_) {
    rt->heap_limit_raised_ = true;
    size_t raised = current + current / 4;
    log(LogLevel::kError,
        "JS heap near its limit: used %.1f MB, total %.1f MB, limit %.1f MB, external %.1f MB, "
        "malloced %.1f MB; raising the limit once to %.1f MB (JS-4)",
        hs.used_heap_size() / 1048576.0, hs.total_heap_size() / 1048576.0, hs.heap_size_limit() / 1048576.0,
        hs.external_memory() / 1048576.0, hs.malloced_memory() / 1048576.0, raised / 1048576.0);
    return raised;
  }
  log(LogLevel::kError, "JS heap at its raised limit (%.1f MB): out of memory follows", current / 1048576.0);
  return current;
}

void RuntimeImpl::gc_prologue(v8::Isolate*, v8::GCType, v8::GCCallbackFlags, void* data) {
  static_cast<RuntimeImpl*>(data)->gc_start_ms_ = now_ms();
}

void RuntimeImpl::gc_epilogue(v8::Isolate*, v8::GCType, v8::GCCallbackFlags, void* data) {
  auto* rt = static_cast<RuntimeImpl*>(data);
  double ms = now_ms() - rt->gc_start_ms_;
  if (rt->in_frame_callbacks_) {
    rt->gc_.count_in++;
    rt->gc_.ms_in += ms;
  } else {
    rt->gc_.count_out++;
    rt->gc_.ms_out += ms;
  }
  if (ms > rt->gc_.max_ms) rt->gc_.max_ms = ms;
}

// ---------------------------------------------------------------------------------------------------------------
// Lifecycle

void RuntimeImpl::dispatch_page_events(const std::vector<PageEvent>& events) {
  // PROC-6 policy (documented in core/README.md): timers keep their normal rate while hidden; window rAF stops.
  loop_.set_window_frames_suspended(!lifecycle_.visible());
  if (context_.IsEmpty()) return;
  v8::HandleScope hs(isolate_);
  v8::Context::Scope cs(context());
  for (const auto& e : events) {
    log(LogLevel::kInfo, "lifecycle: %s on %s (visibility %s)", e.type.c_str(),
        e.target == PageEvent::Target::kWindow ? "window" : "document", lifecycle_.visibility_state());
    v8::Local<v8::Value> argv[] = {v8u::str(isolate_, e.type),
                                   v8u::str(isolate_, e.target == PageEvent::Target::kWindow ? "window" : "document")};
    call_hook("lifecycle", 2, argv);
    run_microtasks();
  }
}

void RuntimeImpl::request_reload(const std::string& url) {
  if (!url.empty()) {
    auto u = parse_url(url, &document_url_);
    if (u && u->origin() == origin_url_.origin()) {
      reload_url_ = *u;
    } else {
      log(LogLevel::kWarn, "location.reload(): %s is not in the app's origin; keeping %s", url.c_str(),
          document_url_.href().c_str());
    }
  }
  reload_requested_ = true;
  loop_.wake();
}

void RuntimeImpl::request_exit() { request_quit(); }

// ---------------------------------------------------------------------------------------------------------------
// Runtime API

std::shared_ptr<AssetBytes> RuntimeImpl::read_app_file(std::string_view dist_path) {
  std::string p = config_.app_root.empty() ? std::string(dist_path) : config_.app_root + "/" + std::string(dist_path);
  return options_.assets->read(p);
}

void RuntimeImpl::post_task(std::function<void()> fn) {
  uint64_t gen = generation_;
  EventLoop::Task task = [this, gen, fn = std::move(fn)] {
    if (gen != generation_ || context_.IsEmpty()) return;
    fn();
  };
  if (!loop_.try_post(task)) {
    // After teardown. The closure may hold v8::Global handles of the disposed isolate, which must not be destroyed
    // (that would write into freed isolate memory), so it is deliberately leaked. Module threads should be stopped
    // by their shutdown hook (they run before the loop closes); this only catches stragglers, and says so.
    static std::atomic<uint64_t> leaked{0};
    uint64_t n = ++leaked;
    if (n <= 3 || (n & (n - 1)) == 0) {
      log(LogLevel::kWarn, "post_task after the page was torn down: task dropped without destroying it (%llu so far)",
          static_cast<unsigned long long>(n));
    }
    new EventLoop::Task(std::move(task));  // NOLINT: intentional leak, see above
  }
}

void RuntimeImpl::add_debug_method(std::string name, DebugMethod method) {
  devtools_->add_method(std::move(name), std::move(method));
}

void RuntimeImpl::add_stats_provider(std::string name, std::function<Json()> provider) {
  stats_providers_[std::move(name)] = std::move(provider);
}

void RuntimeImpl::set_info_field(std::string key, std::string value) {
  std::lock_guard<std::mutex> lock(info_mu_);
  info_fields_[std::move(key)] = std::move(value);
}

void RuntimeImpl::mark_boot(std::string name) {
  double t = now_ms();
  std::lock_guard<std::mutex> lock(info_mu_);
  for (auto& m : boot_marks_) {
    if (m.first == name) return;  // first occurrence wins
  }
  boot_marks_.emplace_back(std::move(name), t);
}

void RuntimeImpl::add_shutdown_hook(std::function<void()> hook) { shutdown_hooks_.push_back(std::move(hook)); }

Json RuntimeImpl::info_json() {
  Json j = Json::object();
  j.set("deviceModel", options_.device.model);
  j.set("manufacturer", options_.device.manufacturer);
  j.set("osBuild", options_.device.fingerprint);
  j.set("androidRelease", options_.device.android_release);
  j.set("sdkInt", options_.device.sdk_int);
  j.set("runtimeVersion", IWN_RUNTIME_VERSION);
  j.set("buildId", IWN_BUILD_ID);
  j.set("v8Version", v8::V8::GetVersion());
  {
    std::lock_guard<std::mutex> lock(info_mu_);
    j.set("glRenderer", info_fields_.count("glRenderer") ? info_fields_["glRenderer"] : "unavailable (no GL module)");
    j.set("openxrRuntime",
          info_fields_.count("openxrRuntime") ? info_fields_["openxrRuntime"] : "unavailable (no XR module)");
    for (auto& kv : info_fields_) {
      if (kv.first != "glRenderer" && kv.first != "openxrRuntime") j.set(kv.first, kv.second);
    }
  }
  j.set("packageId", config_.package_id);
  j.set("versionName", config_.version_name);
  j.set("versionCode", config_.version_code);
  Json features = Json::array();
  for (int i = 0; i < kNativeModuleCount; ++i) features.push(std::string("module:") + kNativeModules[i].name);
  if (config_.inspector_enabled) features.push("inspector");
  if (code_cache_) features.push("codeCache");
  j.set("features", features);
  j.set("origin", config_.origin);
  j.set("title", title_);
  return j;
}

Json RuntimeImpl::stats_json() {
  Json j = Json::object();
  j.set("runtimeVersion", IWN_RUNTIME_VERSION);
  j.set("buildId", IWN_BUILD_ID);
  j.set("v8Version", v8::V8::GetVersion());
  j.set("uptimeMs", now_ms());
  Json boot = Json::object();
  {
    std::lock_guard<std::mutex> lock(info_mu_);
    for (auto& m : boot_marks_) boot.set(m.first, m.second);
  }
  j.set("boot", boot);
  j.set("fps", fps_);
  j.set("refreshRate", nullptr);
  j.set("visibilityState", lifecycle_.visibility_state());
  j.set("focused", lifecycle_.focused());
  j.set("readyState", ready_state_);
  j.set("contextGeneration", static_cast<uint64_t>(generation_));
  const auto& ls = loop_.stats();
  Json loop = Json::object();
  loop.set("iterations", ls.iterations);
  loop.set("tasksRun", ls.tasks_run);
  loop.set("platformTasksRun", ls.high_tasks_run);
  loop.set("timersFired", ls.timers_fired);
  loop.set("animationFrames", ls.animation_frames);
  loop.set("budgetCarryovers", ls.budget_carryovers);
  loop.set("pendingTasks", static_cast<uint64_t>(loop_.pending_tasks()));
  loop.set("pendingTimers", static_cast<uint64_t>(loop_.pending_timers()));
  j.set("loop", loop);
  v8::HeapStatistics hs;
  isolate_->GetHeapStatistics(&hs);
  Json heap = Json::object();
  heap.set("used", static_cast<uint64_t>(hs.used_heap_size()));
  heap.set("total", static_cast<uint64_t>(hs.total_heap_size()));
  heap.set("limit", static_cast<uint64_t>(hs.heap_size_limit()));
  heap.set("external", static_cast<uint64_t>(hs.external_memory()));
  heap.set("malloced", static_cast<uint64_t>(hs.malloced_memory()));
  j.set("heap", heap);
  Json gc = Json::object();
  gc.set("countInFrame", gc_.count_in);
  gc.set("msInFrame", gc_.ms_in);
  gc.set("countOutsideFrame", gc_.count_out);
  gc.set("msOutsideFrame", gc_.ms_out);
  gc.set("maxPauseMs", gc_.max_ms);
  j.set("gc", gc);
  const auto& ms = modules_->stats();
  Json mod = Json::object();
  mod.set("modules", ms.modules);
  mod.set("scripts", ms.scripts);
  mod.set("compileMs", ms.compile_ms);
  mod.set("codeCacheConsumed", ms.cache_consumed);
  mod.set("codeCacheRejected", ms.cache_rejected);
  mod.set("codeCacheMiss", ms.cache_miss);
  mod.set("codeCacheProduced", ms.cache_produced);
  mod.set("importReads", ms.import_reads);
  mod.set("importReadsJoined", ms.import_reads_joined);
  mod.set("importReadsSync", ms.import_reads_sync);
  j.set("scripts", mod);
  Json err = Json::object();
  err.set("uncaught", counter_uncaught);
  err.set("unhandledRejections", counter_rejections);
  j.set("errors", err);
  j.set("inspectorSessions", static_cast<uint64_t>(devtools_->session_count()));
  j.set("workers", 0);
  for (auto& kv : stats_providers_) {
    v8::TryCatch tc(isolate_);
    j.set(kv.first, kv.second());
  }
  return j;
}

}  // namespace iwn
