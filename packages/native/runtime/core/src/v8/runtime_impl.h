/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Internal: the Runtime implementation and its parts (module loader, inspector/debug endpoint).
#pragma once

#include <pthread.h>
#include <v8-inspector.h>
#include <v8.h>

#include <atomic>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>
#include <unordered_map>
#include <vector>

#include "iwn/core/code_cache_store.h"
#include "iwn/core/config.h"
#include "iwn/core/event_loop.h"
#include "iwn/core/html_scan.h"
#include "iwn/core/lifecycle.h"
#include "iwn/core/loopback_server.h"
#include "iwn/core/monotonic_cv.h"
#include "iwn/core/runtime.h"
#include "iwn/core/runtime_host.h"
#include "iwn/core/serial_worker.h"

namespace iwn {

class RuntimeImpl;

// ES module graph loading with a V8 code cache (MOD-1..6, CC-1..4).
class ModuleLoader {
 public:
  // The reader runs at nice 0, below the JS thread (which the host raises), with up to 4096 queued imports.
  explicit ModuleLoader(RuntimeImpl& rt) : rt_(rt), reader_("iwn-mod-read", 0, 4096) {}
  ~ModuleLoader();

  void install_isolate_callbacks(v8::Isolate* isolate);
  // Loads, links and evaluates a module graph from an entry URL (or inline source). Returns the evaluation promise
  // (top-level await), or empty with an exception pending in the caller's TryCatch.
  v8::MaybeLocal<v8::Value> run_module(const std::string& url, const std::string* inline_source);
  // Compiles and runs a classic script (code cache applies to named scripts).
  v8::MaybeLocal<v8::Value> run_classic(const std::string& url, const std::string& source, int line_offset = 0);
  // Drops the module map (reload).
  void reset();
  // Writes code caches for scripts compiled without an accepted cache (CC-2: called after boot settles).
  void produce_code_caches();

  struct Stats {
    uint64_t modules = 0, scripts = 0, cache_consumed = 0, cache_rejected = 0, cache_miss = 0, cache_produced = 0;
    // import() reads (PROC-2): started on the reader, joined to one in flight, done synchronously instead.
    uint64_t import_reads = 0, import_reads_joined = 0, import_reads_sync = 0;
    double compile_ms = 0;
  };
  const Stats& stats() const { return stats_; }

  // Loads the bytes for a module/script URL: same-origin dist file, data:, or blob: (via the glue's resolver).
  // Returns false and sets *error (a TypeError message) on failure.
  bool fetch_source(const std::string& url, std::string* source, std::string* error);

  // PROC-2 for import(): reads the files of the import's graph that are not loaded yet (APK entries are inflated
  // there) and their code-cache entries on the loader's one background reader (SerialWorker), then posts `then` to
  // the JS thread with the bytes available to fetch_source/compile. Concurrent imports of the same URL (fragment
  // ignored) share one read, like HTML's module map "fetching" state: later callers wait on the read in flight.
  // Falls back to posting `then` directly when nothing needs reading or the reader refuses the job.
  void prefetch_then(const std::string& url, std::function<void()> then);
  // Teardown (JS thread, before the event loop closes): stops and joins the reader; queued reads are dropped.
  void stop_reader();

  // Bytes read off the JS thread, keyed by URL without fragment; only populated while a prefetched import loads.
  struct Prefetched {
    std::shared_ptr<AssetBytes> bytes;
    CodeCacheStore::SourceHash hash{};
    bool cache_looked_up = false;
    CodeCacheStore::Result cache_result = CodeCacheStore::Result::kMiss;
    std::vector<uint8_t> cache;
  };

 private:
  struct ModuleRecord {
    v8::Global<v8::Module> module;
    std::string url;
    CodeCacheStore::SourceHash hash{};
    bool cache_accepted = false;
    bool cache_written = false;
  };
  struct ScriptRecord {
    v8::Global<v8::UnboundScript> script;
    std::string url;
    CodeCacheStore::SourceHash hash{};
    bool cache_accepted = false;
    bool cache_written = false;
  };

  v8::MaybeLocal<v8::Module> load_graph(const std::string& url, const std::string* inline_source);
  v8::MaybeLocal<v8::Module> compile_module(const std::string& url, const std::string& source);
  ModuleRecord* record_for(v8::Local<v8::Module> module);
  std::unique_ptr<v8::ScriptCompiler::CachedData> lookup_cache(const std::string& url,
                                                               const CodeCacheStore::SourceHash& hash,
                                                               std::vector<uint8_t>* storage);

  static v8::MaybeLocal<v8::Module> resolve_callback(v8::Local<v8::Context> context, v8::Local<v8::String> specifier,
                                                     v8::Local<v8::FixedArray> attributes,
                                                     v8::Local<v8::Module> referrer);
  static v8::MaybeLocal<v8::Promise> dynamic_import_callback(v8::Local<v8::Context> context,
                                                             v8::Local<v8::Data> host_defined_options,
                                                             v8::Local<v8::Value> resource_name,
                                                             v8::Local<v8::String> specifier,
                                                             v8::Local<v8::FixedArray> attributes);
  static void import_meta_callback(v8::Local<v8::Context> context, v8::Local<v8::Module> module,
                                   v8::Local<v8::Object> meta);

  RuntimeImpl& rt_;
  std::unordered_map<std::string, std::unique_ptr<ModuleRecord>> by_url_;
  std::unordered_multimap<int, ModuleRecord*> by_hash_;
  std::unordered_map<std::string, v8::Global<v8::Value>> failed_;  // MOD-4: same error for every importer
  std::vector<std::unique_ptr<ScriptRecord>> scripts_;
  // Bytes read off the JS thread (keyed by URL without fragment), only while the batch that brought them runs its
  // waiting imports; erased when that batch's task ends.
  std::unordered_map<std::string, Prefetched> prefetched_;
  // Imports waiting for a read in flight, keyed by target URL without fragment (JS thread only).
  struct InFlight {
    uint64_t generation = 0;
    std::vector<std::function<void()>> waiters;
  };
  std::unordered_map<std::string, InFlight> inflight_;
  // Reader-thread only: dependency files already sent to the JS thread in this generation, so a later import that
  // shares them does not read them again (it finds them loaded, or falls back to a synchronous read).
  std::unordered_map<std::string, bool> reader_sent_;
  uint64_t reader_generation_ = 0;
  SerialWorker reader_;
  Stats stats_;
};

// V8 inspector over the loopback server (CDP-1..10) plus the debug endpoint (DBG-*).
class DevTools : public v8_inspector::V8InspectorClient {
 public:
  explicit DevTools(RuntimeImpl& rt);
  ~DevTools() override;

  void create_inspector(v8::Isolate* isolate);
  bool start_server();  // per config; logs and returns false on failure (the app keeps running)
  void stop_server();
  void set_title(std::string title);
  void context_created(v8::Local<v8::Context> ctx);
  void context_destroyed(v8::Local<v8::Context> ctx);
  // Report an uncaught exception to attached DevTools consoles.
  void exception_thrown(v8::Local<v8::Context> ctx, v8::Local<v8::Value> exception, v8::Local<v8::Message> message,
                        const std::string& text);
  // CDP-8: blocks the JS thread (servicing only inspector messages) until Runtime.runIfWaitingForDebugger.
  void wait_for_debugger();
  size_t session_count() const { return sessions_.size(); }
  bool paused() const { return paused_; }

  // Debug endpoint registry (DBG-1).
  void add_method(std::string name, Runtime::DebugMethod method);

  // V8InspectorClient
  void runMessageLoopOnPause(int context_group_id) override;
  void quitMessageLoopOnPause() override;
  void runIfWaitingForDebugger(int context_group_id) override;
  v8::Local<v8::Context> ensureDefaultContextInGroup(int context_group_id) override;
  double currentTimeMS() override;

 private:
  struct Session;
  struct Inbound {
    enum class Kind { kOpen, kMessage, kClose } kind = Kind::kMessage;
    uint64_t conn = 0;
    int channel = 0;  // 0 = CDP, 1 = debug endpoint
    std::string text;
    bool safe_in_interrupt = false;
  };
  struct EvalRequest {
    Runtime::DebugReply reply;
    bool done = false;
  };
  void on_server_inbound(Inbound in);
  // Drains queued inbound items. cdp_only: leave debug-endpoint requests queued (paused / waiting).
  // safe_only: stop at the first CDP message that may run page JS (used from interrupts).
  void drain(bool cdp_only, bool safe_only);
  void drain_items(bool cdp_only, bool safe_only);
  // Frees parked closed sessions once it is safe (not paused, not in an interrupt, V8 holds no reference).
  void reap_closed_sessions();
  void handle_cdp(uint64_t conn, const std::string& text);
  void handle_debug(uint64_t conn, const std::string& text);
  std::string http_response(const ws::HttpRequest& req, int local_port);
  std::string target_json(const std::string& host) const;
  // Network.loadNetworkResource source (CDP-5): app dist, iwn-runtime:/// assets, data:. False if not found.
  bool load_resource(const std::string& url, std::string* body, std::string* mime);
  void run_eval(const Json& params, Runtime::DebugReply reply);
  void finish_eval(int request_id, bool ok, v8::Local<v8::Value> value);
  static void interrupt_callback(v8::Isolate* isolate, void* data);

  RuntimeImpl& rt_;
  std::unique_ptr<v8_inspector::V8Inspector> inspector_;
  std::shared_ptr<LoopbackServer> server_;
  int cdp_port_ = 0;
  std::string socket_base_;  // Android: the abstract socket names are "<socket_base_>_<port>" (CDP-1)
  std::string target_id_;
  std::map<uint64_t, std::unique_ptr<Session>> sessions_;
  std::vector<std::unique_ptr<Session>> closing_;
  std::map<std::string, Runtime::DebugMethod> methods_;
  std::map<int, std::shared_ptr<EvalRequest>> evals_;
  int next_eval_id_ = 1;
  std::map<std::string, std::string> io_streams_;  // IO.read handles from Network.loadNetworkResource
  std::map<std::string, size_t> io_offsets_;
  uint64_t next_stream_ = 0;

  mutable std::mutex mu_;  // guards inbound_, channels_, title_
  MonotonicCondVar cv_;
  std::deque<Inbound> inbound_;
  std::map<uint64_t, int> channels_;
  std::string title_;
  std::atomic<bool> drain_posted_{false};
  bool paused_ = false;
  bool in_interrupt_ = false;
  bool waiting_for_debugger_ = false;
  bool context_alive_ = false;
};

// Page callbacks (timers, frames, hooks, tasks, microtasks, native completions) run inside one of these.
// Chrome's model (CDP-5, LOOP-4): a *verbose* v8::TryCatch, so V8's exception prediction classes an exception
// that reaches it as uncaught (DevTools "pause on uncaught exceptions" stops at the throw) and V8 reports it
// through the message listener once, with its location. If V8 did not report it (e.g. some compile errors), the
// scope reports it when it closes. Callers must not report tc() themselves.
class PageCallScope {
 public:
  explicit PageCallScope(RuntimeImpl& rt);
  ~PageCallScope();
  PageCallScope(const PageCallScope&) = delete;
  PageCallScope& operator=(const PageCallScope&) = delete;
  v8::TryCatch& tc() { return tc_; }

 private:
  RuntimeImpl& rt_;
  v8::TryCatch tc_;
  bool saved_reported_;
};

class RuntimeImpl : public Runtime, public RuntimeHost {
 public:
  explicit RuntimeImpl(RuntimeOptions options);
  ~RuntimeImpl() override;

  // RuntimeHost
  void start() override;
  void post_lifecycle(LifecycleInput input) override;
  void post_low_memory() override;
  void request_quit() override;
  bool join(int timeout_ms) override;

  // Runtime
  v8::Isolate* isolate() const override { return isolate_; }
  v8::Local<v8::Context> context() const override { return context_.Get(isolate_); }
  uint64_t context_generation() const override { return generation_; }
  EventLoop& loop() override { return loop_; }
  AssetSource& assets() override { return *options_.assets; }
  const RuntimeConfig& config() const override { return config_; }
  const Url& app_origin() const override { return origin_url_; }
  const Url& document_url() const override { return document_url_; }
  std::shared_ptr<AssetBytes> read_app_file(std::string_view dist_path) override;
  void post_task(std::function<void()> fn) override;
  v8::MaybeLocal<v8::Value> call_function(v8::Local<v8::Function> fn, v8::Local<v8::Value> recv, int argc,
                                          v8::Local<v8::Value> argv[]) override;
  void report_exception(const v8::TryCatch& try_catch) override;
  void set_frame_pump(FramePump* pump) override { loop_.set_frame_pump(pump); }
  void set_in_frame_callbacks(bool inside) override { in_frame_callbacks_ = inside; }
  void add_debug_method(std::string name, DebugMethod method) override;
  void add_stats_provider(std::string name, std::function<Json()> provider) override;
  void set_info_field(std::string key, std::string value) override;
  void mark_boot(std::string name) override;
  void add_shutdown_hook(std::function<void()> hook) override;
  void request_exit() override;

  // Internals used by the natives, the loader and DevTools.
  // log_prefix starts the single logcat line (PROC-9), e.g. "entry module <url> failed: ".
  void report_exception_value(v8::Local<v8::Value> exception, v8::Local<v8::Message> message,
                              const std::string& log_prefix = {});
  // PROC-2: logs (and aborts in debug builds) when the main isolate is entered from another thread.
  void assert_js_thread(const char* where) const;
  // Called by the loader when it compiles a script or module without an accepted cache.
  void note_uncached_script();
  void run_microtasks();
  // `url`: the document URL the page restarts with (location.reload() keeps query and fragment, DOM-5); empty or
  // not in the app's origin keeps the current one.
  void request_reload(const std::string& url = {});
  Json stats_json();
  Json info_json();
  const Lifecycle& lifecycle() const { return lifecycle_; }
  const char* ready_state() const { return ready_state_; }
  std::shared_ptr<CodeCacheStore> code_cache() { return code_cache_; }
  ModuleLoader& modules() { return *modules_; }
  DevTools& devtools() { return *devtools_; }
  const RuntimeOptions& options() const { return options_; }
  v8::Local<v8::Object> hooks() const { return hooks_.Get(isolate_); }
  void set_hooks(v8::Local<v8::Object> hooks) { hooks_.Reset(isolate_, hooks); }
  v8::Local<v8::Value> blob_resolver() const { return blob_resolver_.Get(isolate_); }
  void set_blob_resolver(v8::Local<v8::Value> fn) { blob_resolver_.Reset(isolate_, fn); }
  const std::string& document_title() const { return title_; }
  // Runs a JS-side hook function by name on the hooks object; returns empty if absent or it threw (reported).
  // Page code runs under a PageCallScope, so DevTools' "pause on uncaught exceptions" stops in it (CDP-5).
  v8::MaybeLocal<v8::Value> call_hook(const char* name, int argc, v8::Local<v8::Value> argv[]);
  v8::Local<v8::Function> hook_function(const char* name);
  v8::MaybeLocal<v8::Value> call_hook_function(v8::Local<v8::Function> fn, int argc, v8::Local<v8::Value> argv[]);
  void enqueue_rejection_handled(v8::Local<v8::Promise> promise);
  uint64_t counter_uncaught = 0, counter_rejections = 0;

 private:
  friend class DevTools;
  friend class PageCallScope;
  void thread_main();
  bool boot_engine();
  bool create_context();
  void dispose_context();
  void boot_page();
  void install_natives(v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);
  void run_task(EventLoop::Task& task);
  void fire_timer(const TimerQueue::Fired& fired);
  void run_animation_frame(double now);
  void after_iteration();
  void process_rejections();
  void dispatch_page_events(const std::vector<PageEvent>& events);
  void teardown();
  void log_boot_line();
  void schedule_code_cache_pass();

  static void promise_reject_callback(v8::PromiseRejectMessage message);
  static void message_listener(v8::Local<v8::Message> message, v8::Local<v8::Value> data);
  static size_t near_heap_limit(void* data, size_t current, size_t initial);
  static void gc_prologue(v8::Isolate* isolate, v8::GCType type, v8::GCCallbackFlags flags, void* data);
  static void gc_epilogue(v8::Isolate* isolate, v8::GCType type, v8::GCCallbackFlags flags, void* data);

  RuntimeOptions options_;
  RuntimeConfig config_;
  Url origin_url_;
  Url document_url_;
  std::string title_;
  EventLoop loop_;
  Lifecycle lifecycle_;
  const char* ready_state_ = "loading";
  std::thread thread_;
  std::mutex join_mu_;
  MonotonicCondVar join_cv_;
  bool finished_ = false;
  bool tearing_down_ = false;  // guarded by join_mu_
  pthread_t js_thread_{};
  std::atomic<bool> exit_requested_{false};
  std::atomic<bool> reload_requested_{false};
  std::optional<Url> reload_url_;  // JS thread

  v8::Isolate* isolate_ = nullptr;
  v8::ArrayBuffer::Allocator* allocator_ = nullptr;
  v8::Global<v8::Context> context_;
  v8::Global<v8::Object> hooks_;
  v8::Global<v8::Value> blob_resolver_;
  std::atomic<uint64_t> generation_{0};
  std::unique_ptr<ModuleLoader> modules_;
  std::unique_ptr<DevTools> devtools_;
  std::shared_ptr<CodeCacheStore> code_cache_;

  struct PendingRejection {
    v8::Global<v8::Promise> promise;
    v8::Global<v8::Value> reason;
  };
  std::vector<PendingRejection> pending_rejections_;
  std::vector<v8::Global<v8::Promise>> reported_rejections_;
  std::vector<v8::Global<v8::Promise>> handled_later_;

  std::map<std::string, std::function<Json()>> stats_providers_;
  std::mutex info_mu_;
  std::map<std::string, std::string> info_fields_;
  std::vector<std::pair<std::string, double>> boot_marks_;
  std::vector<std::function<void()>> shutdown_hooks_;

  bool in_frame_callbacks_ = false;
  bool listener_reported_ = false;  // set by message_listener; see PageCallScope
  bool in_error_reporting_ = false;  // HTML "error reporting mode": nested errors only go to the console
  bool heap_limit_raised_ = false;
  double gc_start_ms_ = 0;
  struct GcStats {
    uint64_t count_in = 0, count_out = 0;
    double ms_in = 0, ms_out = 0, max_ms = 0;
  } gc_;
  // fps over the last second of the loop's frames (EventLoop::Stats::frames)
  double fps_window_start_ = 0;
  uint64_t fps_frames_ = 0;
  double fps_ = 0;
  double last_stats_log_ms_ = 0;
  bool code_cache_scheduled_ = false;
  bool code_cache_first_pass_done_ = false;
};

}  // namespace iwn
