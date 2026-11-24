/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Internal declarations of the workers module's V8 layer (Android). See runtime/workers/README.md for the design.
//
//   WorkerEnv        process-wide snapshot of what every worker needs from the page runtime (assets, origin,
//                    preludes, glue config, the "workers" config section). Set when the page registers.
//   WorkerHandle     one worker, shared by its creator's binding and the worker thread (terminate, done, labels).
//   BindingOwner     PortOwner of one isolate: posts closures (ids only, no V8 handles) to that isolate's JS thread.
//   IsolateBinding   the per-isolate (per-context) JS-side state: hooks, pending serialized messages, children.
//   WorkerRuntime    a worker thread: isolate, event loop (iwn::EventLoop), context, bootstrap, preludes, modules.
//   compile_*        compiling with the worker code cache (CC-5, iwn/workers/script_cache.h).
#pragma once

#include <pthread.h>
#include <v8.h>

#include <array>
#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "iwn/core/asset_source.h"
#include "iwn/core/event_loop.h"
#include "iwn/core/json.h"
#include "iwn/core/monotonic_cv.h"
#include "iwn/core/runtime.h"
#include "iwn/core/url.h"
#include "iwn/loop_hooks.h"
#include "iwn/workers/policy.h"
#include "iwn/workers/port_hub.h"
#include "iwn/workers/script_cache.h"

namespace iwn::workers {

class IsolateBinding;
class WorkerRuntime;

// --- small V8 helpers ------------------------------------------------------------------------------------------
v8::Local<v8::String> v8str(v8::Isolate* isolate, std::string_view s);
std::string utf8(v8::Isolate* isolate, v8::Local<v8::Value> value);
// Throws `new DOMException(message, name)` when the global has DOMException, else an Error with that name.
void throw_dom_exception(v8::Isolate* isolate, std::string_view message, const char* name);
void throw_type_error(v8::Isolate* isolate, std::string_view message);
void set_fn(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> target, const char* name,
            v8::FunctionCallback cb, v8::Local<v8::Value> data = {});
void set_val(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> target, const char* name,
             v8::Local<v8::Value> value);
std::string exception_text(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Value> exception);

// --- process-wide environment ----------------------------------------------------------------------------------
struct WorkerEnv {
  ScriptSource source;           // app origin + dist root + assets (the page runtime's AssetSource)
  std::string origin;            // "https://app.local"
  std::vector<std::string> preludes;
  Json glue;                     // the page's glue config section (copied into each worker's __iwn.config)
  WorkersConfig config;
  bool debuggable = false;
  std::string runtime_version;
};
std::shared_ptr<const WorkerEnv> worker_env();
void set_worker_env(std::shared_ptr<const WorkerEnv> env);
WorkerLimiter& worker_limiter();

// --- one worker --------------------------------------------------------------------------------------------------
class BindingOwner;

struct WorkerHandle {
  uint64_t id = 0;
  std::string name;
  std::string url;
  bool module = false;
  std::string label;                       // "worker 3 'ktx2'"
  std::shared_ptr<BindingOwner> parent;    // the creating global (events go there)
  PortId outside_port = 0;                 // the creator's end (Worker.postMessage / onmessage)
  PortId inside_port = 0;                  // the worker global's end

  // Any thread. Stops the worker as soon as possible (TerminateExecution, then the loop quits). Idempotent.
  void terminate();
  // Any thread. True once the worker thread finished its teardown (isolate disposed, thread about to exit).
  bool wait_done(double timeout_ms);
  bool done();

  // Set by the worker thread while its isolate/loop are alive (under mu).
  void attach(v8::Isolate* isolate, EventLoop* loop);
  void detach();
  void mark_done();
  bool terminate_requested() const { return terminate_requested_.load(); }

 private:
  std::mutex mu_;
  MonotonicCondVar cv_;
  v8::Isolate* isolate_ = nullptr;
  EventLoop* loop_ = nullptr;
  bool done_ = false;
  std::atomic<bool> terminate_requested_{false};
};

// Every live worker of the process (for stats, the debug endpoint and shutdown).
void register_worker(const std::shared_ptr<WorkerHandle>& handle);
void unregister_worker(uint64_t id);
std::vector<std::shared_ptr<WorkerHandle>> live_workers();
uint64_t next_worker_id();

// --- per-isolate owner and binding -------------------------------------------------------------------------------
// Posts closures to one isolate's JS thread. Holds no V8 handles, so the port hub (any thread) may keep it.
class BindingOwner : public PortOwner {
 public:
  using Poster = std::function<bool(std::function<void()>)>;
  BindingOwner(Poster poster, std::string label) : poster_(std::move(poster)), label_(std::move(label)) {}
  // Any thread. Runs fn with the isolate's current binding on its JS thread (inside the loop's task scopes).
  bool post(std::function<void(IsolateBinding&)> fn);
  bool schedule_delivery(PortId port) override;
  // JS thread: binds the binding the closures run against (weak: the binding lives in the per-isolate table).
  void set_binding(std::weak_ptr<IsolateBinding> binding);
  // Any thread: refuse further posts (teardown / reload).
  void kill();
  const std::string& label() const { return label_; }

 private:
  std::mutex mu_;
  bool alive_ = true;
  Poster poster_;
  std::weak_ptr<IsolateBinding> binding_;
  std::string label_;
};

// Calls page callbacks the way the isolate's runtime does (verbose TryCatch / error reporting, checkpoint rules).
class JsHost {
 public:
  virtual ~JsHost() = default;
  virtual v8::MaybeLocal<v8::Value> call(v8::Local<v8::Function> fn, v8::Local<v8::Value> recv, int argc,
                                         v8::Local<v8::Value> argv[]) = 0;
};

struct SerializedMessage;

class IsolateBinding : public std::enable_shared_from_this<IsolateBinding> {
 public:
  IsolateBinding(v8::Isolate* isolate, v8::Local<v8::Context> ctx, JsHost* host, WorkerRuntime* worker);
  ~IsolateBinding();

  v8::Isolate* isolate() const { return isolate_; }
  v8::Local<v8::Context> context() const { return context_.Get(isolate_); }
  WorkerRuntime* worker() const { return worker_; }  // null for the page
  const std::shared_ptr<BindingOwner>& owner() const { return owner_; }
  void set_owner(std::shared_ptr<BindingOwner> owner) { owner_ = std::move(owner); }
  // The page binding owns its JsHost (a worker's is the WorkerRuntime itself).
  void own_host(std::unique_ptr<JsHost> host) {
    owned_host_ = std::move(host);
    host_ = owned_host_.get();
  }

  // JS hooks (setHooks).
  void set_hooks(v8::Local<v8::Object> hooks);
  bool has_hooks() const { return !dispatch_.IsEmpty(); }
  v8::Local<v8::Function> host_write() const { return host_write_.Get(isolate_); }
  v8::Local<v8::Function> host_read() const { return host_read_.Get(isolate_); }
  bool is_host_object(v8::Local<v8::Object> object);

  // Calls hooks.dispatch(kind, args...) as a runtime callback.
  void dispatch(const char* kind, std::vector<v8::Local<v8::Value>> args);

  // serialize() results waiting for post().
  uint32_t keep_pending(std::unique_ptr<SerializedMessage> m);
  std::unique_ptr<SerializedMessage> take_pending(uint32_t id);

  // Delivery task for one of this isolate's ports.
  void deliver(PortId port);

  // Workers this global created.
  void add_child(std::shared_ptr<WorkerHandle> handle);
  std::shared_ptr<WorkerHandle> child(uint64_t id);
  void remove_child(uint64_t id);
  std::vector<std::shared_ptr<WorkerHandle>> children();
  // Child events (posted by the worker thread through the owner).
  void child_error(uint64_t id, const std::string& message, const std::string& filename, int line, int col);
  void child_load_error(uint64_t id, const std::string& message);
  void child_exit(uint64_t id);

  // Ends this binding (reload, teardown): no more posts, terminates children (without waiting), closes its ports,
  // drops pending messages and JS handles. JS thread.
  void shutdown();
  // Waits (bounded) for the children terminated by shutdown().
  void join_children(double timeout_ms);

 private:
  v8::Isolate* isolate_;
  v8::Global<v8::Context> context_;
  JsHost* host_;
  std::unique_ptr<JsHost> owned_host_;
  WorkerRuntime* worker_;
  std::shared_ptr<BindingOwner> owner_;
  v8::Global<v8::Object> hooks_;
  v8::Global<v8::Function> dispatch_, host_write_, host_read_;
  std::vector<v8::Global<v8::Object>> host_protos_;
  std::unordered_map<uint32_t, std::unique_ptr<SerializedMessage>> pending_;
  uint32_t next_pending_ = 1;
  std::map<uint64_t, std::shared_ptr<WorkerHandle>> children_;
  std::vector<std::shared_ptr<WorkerHandle>> terminated_children_;
  bool shut_down_ = false;
};

// Per-isolate binding table (the current binding of each isolate; replaced on reload).
std::shared_ptr<IsolateBinding> binding_for(v8::Isolate* isolate);
void set_binding_for(v8::Isolate* isolate, std::shared_ptr<IsolateBinding> binding);
std::shared_ptr<IsolateBinding> take_binding_for(v8::Isolate* isolate);

// Installs __iwn.workers on `natives` for the binding's context.
void install_workers_natives(IsolateBinding& binding, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);

// --- structured serialize/deserialize across isolates (HTML §2.7, V8 ValueSerializer) ---------------------------
struct SerializedMessage final : Payload {
  ~SerializedMessage() override;
  size_t byte_size() const override;
  uint8_t* data = nullptr;  // ValueSerializer::Release() buffer (free())
  size_t size = 0;
  // Host-object descriptors, serialized separately (V8 does not allow JS while deserializing, so the receiver
  // revives them with its JS hook before the main value is read; the main data refers to them by index).
  uint8_t* host_data = nullptr;
  size_t host_size = 0;
  uint32_t host_count = 0;
  std::vector<std::shared_ptr<v8::BackingStore>> array_buffers;   // transferred
  std::vector<std::shared_ptr<v8::BackingStore>> shared_buffers;  // SharedArrayBuffer / shared wasm memory
  std::vector<v8::CompiledWasmModule> wasm_modules;
  std::vector<PortId> ports;       // transferred ports: closed by the destructor unless delivered
  std::vector<uint64_t> bitmaps;   // ImageBitmap transfer tokens: discarded by the destructor unless delivered
  bool delivered = false;
};

// Serializes `value` with `transfer` (ArrayBuffers only; platform transferables are handled through the binding's
// host hooks). On success transferred buffers are detached and their memory moves into the message. On failure a
// DataCloneError (or the hook's exception) is pending and nothing was detached.
std::unique_ptr<SerializedMessage> serialize_message(IsolateBinding& binding, v8::Local<v8::Context> ctx,
                                                     v8::Local<v8::Value> value,
                                                     const std::vector<v8::Local<v8::ArrayBuffer>>& transfer,
                                                     bool allow_shared);
// Deserializes into the binding's isolate. `ports` / `bitmaps` are handed to the host read hook. Empty on failure
// (exception pending).
v8::MaybeLocal<v8::Value> deserialize_message(IsolateBinding& binding, v8::Local<v8::Context> ctx,
                                              SerializedMessage& message, v8::Local<v8::Array> ports,
                                              v8::Local<v8::Array> bitmaps);

// --- worker code cache (CC-5): iwn/workers/script_cache.h ---------------------------------------------------
// Compiles a classic script with the shared code cache (consumes a hit, produces after a miss).
v8::MaybeLocal<v8::Script> compile_classic(v8::Isolate* isolate, v8::Local<v8::Context> ctx, const std::string& url,
                                           const std::string& source);
v8::MaybeLocal<v8::Module> compile_module(v8::Isolate* isolate, const std::string& url, const std::string& source);

// --- the worker thread ---------------------------------------------------------------------------------------
struct WorkerStart {
  std::shared_ptr<const WorkerEnv> env;
  std::shared_ptr<WorkerHandle> handle;
  bool have_source = false;   // blob: bytes resolved by the creator
  std::string source;
  std::string device_info_json;  // the creator's navigator facts (WRK-12 cap applied)
};

class WorkerRuntime : public JsHost {
 public:
  // Starts the thread; false if it could not be created (the caller releases the limiter slot).
  static bool start(WorkerStart start);
  // The worker running on this thread (null on other threads).
  static WorkerRuntime* current();

  v8::Isolate* isolate() const { return isolate_; }
  v8::Local<v8::Context> context() const { return context_.Get(isolate_); }
  EventLoop& loop() { return loop_; }
  const WorkerEnv& env() const { return *start_.env; }
  WorkerHandle& handle() { return *start_.handle; }
  const std::string& device_info_json() const { return start_.device_info_json; }
  const Url& url() const { return url_; }
  std::string origin() const;
  bool closing() const { return closing_; }

  // JsHost
  v8::MaybeLocal<v8::Value> call(v8::Local<v8::Function> fn, v8::Local<v8::Value> recv, int argc,
                                 v8::Local<v8::Value> argv[]) override;

  // self.close(): the current task finishes, later tasks are discarded, the worker ends (HTML §10.2.4).
  void request_close();
  // Uncaught exception in this worker: error event on the worker global, then (not cancelled) the creator.
  void report_exception(v8::Local<v8::Value> exception, v8::Local<v8::Message> message);
  void run_microtasks();
  // Called by the binding's natives.
  v8::Local<v8::Object> hooks() const { return hooks_.Get(isolate_); }
  void set_hooks(v8::Local<v8::Object> hooks) { hooks_.Reset(isolate_, hooks); }
  void set_blob_resolver(v8::Local<v8::Value> fn) { blob_resolver_.Reset(isolate_, fn); }
  // Script loading for modules/importScripts: same-origin asset, data:, or blob: through the glue's resolver.
  bool fetch(const std::string& url, bool module, std::string* source, std::string* error);
  v8::MaybeLocal<v8::Value> run_classic(const std::string& url, const std::string& source);
  v8::MaybeLocal<v8::Value> run_module(const std::string& url, const std::string* inline_source);
  int timer_add(double timeout, bool repeat);
  void timer_clear(int id);
  void request_frame() { loop_.request_animation_frame(); }
  uint64_t counter_uncaught = 0;
  bool listener_reported = false;
  bool in_error_reporting = false;

 private:
  explicit WorkerRuntime(WorkerStart start);
  ~WorkerRuntime();
  void thread_main();
  bool create_isolate();
  bool boot();
  void run_script();
  void teardown();
  void install_core_natives(v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);
  void run_task(EventLoop::Task& task);
  void fire_timer(const TimerQueue::Fired& fired);
  void run_animation_frame(double now);
  v8::MaybeLocal<v8::Value> call_hook(const char* name, int argc, v8::Local<v8::Value> argv[]);
  void process_rejections();
  void forward_error_to_parent(const std::string& message, const std::string& filename, int line, int col);

  // Modules (worker_modules.cc).
  struct ModuleRecord {
    v8::Global<v8::Module> module;
    std::string url;
  };
  v8::MaybeLocal<v8::Module> load_graph(const std::string& url, const std::string* inline_source);
  ModuleRecord* record_for(v8::Local<v8::Module> module);
  static v8::MaybeLocal<v8::Module> resolve_callback(v8::Local<v8::Context> context, v8::Local<v8::String> specifier,
                                                     v8::Local<v8::FixedArray> attributes,
                                                     v8::Local<v8::Module> referrer);
  static v8::MaybeLocal<v8::Promise> dynamic_import(v8::Local<v8::Context> context, v8::Local<v8::Data> options,
                                                    v8::Local<v8::Value> resource_name, v8::Local<v8::String> specifier,
                                                    v8::Local<v8::FixedArray> attributes);
  static void import_meta(v8::Local<v8::Context> context, v8::Local<v8::Module> module, v8::Local<v8::Object> meta);
  static void promise_reject(v8::PromiseRejectMessage message);
  static void message_listener(v8::Local<v8::Message> message, v8::Local<v8::Value> data);
  static size_t near_heap_limit(void* data, size_t current, size_t initial);

  WorkerStart start_;
  Url url_;
  EventLoop loop_;
  IwnLoopHooks loop_hooks_{};
  // Tasks discarded while closing, destroyed in teardown after the native modules' per-isolate states, so a module
  // completion among them (HookTask) frees its own state instead of running JS (loop_hooks.h: fn always runs).
  std::vector<EventLoop::Task> dropped_tasks_;
  std::atomic<int> loop_refs_{0};
  std::shared_ptr<v8::ArrayBuffer::Allocator> allocator_;
  v8::Isolate* isolate_ = nullptr;
  v8::Global<v8::Context> context_;
  v8::Global<v8::Object> hooks_;
  v8::Global<v8::Value> blob_resolver_;
  std::shared_ptr<IsolateBinding> binding_;
  std::shared_ptr<BindingOwner> owner_;
  std::unordered_map<std::string, std::unique_ptr<ModuleRecord>> modules_;
  std::unordered_multimap<int, ModuleRecord*> modules_by_hash_;
  std::unordered_map<std::string, v8::Global<v8::Value>> failed_modules_;
  struct PendingRejection {
    v8::Global<v8::Promise> promise;
    v8::Global<v8::Value> reason;
  };
  std::vector<PendingRejection> pending_rejections_;
  std::vector<v8::Global<v8::Promise>> reported_rejections_;
  std::vector<v8::Global<v8::Promise>> handled_later_;
  std::atomic<bool> closing_{false};
  bool oom_ = false;
  bool heap_raised_ = false;
  bool booted_ = false;
  double boot_started_ms_ = 0;
};

// The module's teardown for an isolate the core does not own: frees every native module's per-isolate state
// (image, canvas2d, net, storage) through weak references (modules not linked into the app are skipped).
void dispose_module_isolates(v8::Isolate* isolate);

}  // namespace iwn::workers
