// The runtime API other native modules use (Android; needs V8). One Runtime per main isolate, living on the main JS
// thread. Get it from any V8 callback with iwn::Runtime::From(isolate).
//
// Threading: everything here is JS-thread only unless marked "any thread".
#pragma once

#include <v8.h>

#include <functional>
#include <memory>
#include <string>

#include "iwn/core/asset_source.h"
#include "iwn/core/config.h"
#include "iwn/core/event_loop.h"
#include "iwn/core/json.h"
#include "iwn/core/lifecycle.h"
#include "iwn/core/url.h"

namespace iwn {

class Runtime {
 public:
  virtual ~Runtime() = default;

  // The Runtime that owns this isolate (nullptr for isolates the core did not create, e.g. workers).
  static Runtime* From(v8::Isolate* isolate);

  virtual v8::Isolate* isolate() const = 0;
  // The current page context (replaced on location.reload(), PROC-8).
  virtual v8::Local<v8::Context> context() const = 0;
  // Increments whenever the page context is replaced.
  virtual uint64_t context_generation() const = 0;
  virtual EventLoop& loop() = 0;
  virtual AssetSource& assets() = 0;
  virtual const RuntimeConfig& config() const = 0;
  // https://app.local (or the configured origin) and the document URL (<origin>/).
  virtual const Url& app_origin() const = 0;
  virtual const Url& document_url() const = 0;
  // Reads a file of the app's dist by its path inside the dist ("assets/x.js"); nullptr if missing.
  virtual std::shared_ptr<AssetBytes> read_app_file(std::string_view dist_path) = 0;

  // Any thread. Runs fn on the JS thread as a task: isolate + HandleScope + Context::Scope + TryCatch (uncaught
  // exceptions are reported as page errors) + a microtask checkpoint afterwards (LOOP-1). Dropped if the page
  // context was replaced before it runs. After teardown (the loop closes once the shutdown hooks ran) the task is
  // refused and deliberately leaked, not destroyed, because it may hold v8::Global handles of the disposed isolate:
  // stop module threads in a shutdown hook so they post nothing afterwards.
  virtual void post_task(std::function<void()> fn) = 0;
  // Calls a JS function as a runtime callback: a verbose (page) TryCatch, so an exception is reported once with its
  // location and DevTools "pause on uncaught exceptions" stops at the throw (CDP-5), then a microtask checkpoint if
  // no JS is on the stack (HTML "clean up after running a callback"; when called from a native function the page
  // called, the enclosing task's checkpoint runs the microtasks instead).
  // Use this for every page callback rather than a private TryCatch + report_exception (V8 would predict those
  // exceptions as caught, so the debugger would not pause).
  virtual v8::MaybeLocal<v8::Value> call_function(v8::Local<v8::Function> fn, v8::Local<v8::Value> recv, int argc,
                                                  v8::Local<v8::Value> argv[]) = 0;
  // Reports a caught exception like an uncaught one (window error event, logcat JS tag, DevTools console). Does not
  // make the debugger pause; prefer call_function for page callbacks.
  virtual void report_exception(const v8::TryCatch& try_catch) = 0;

  // XR frame loop hook (M3): while the pump is active it drives frames instead of the 60 Hz window-rAF timer.
  virtual void set_frame_pump(FramePump* pump) = 0;
  // Marks code running inside frame callbacks, so GC pauses are attributed (LOG-3, DBG-STATS).
  virtual void set_in_frame_callbacks(bool inside) = 0;

  // Debug endpoint extension (DBG-1): a method handler gets params and a reply callback (callable from any thread,
  // exactly once) that takes the method's result object ({"error": "..."} for failures). "eval", "stats" and "info"
  // are built in; "shot" is for the XR module.
  using DebugReply = std::function<void(Json result)>;
  using DebugMethod = std::function<void(const Json& params, DebugReply reply)>;
  virtual void add_debug_method(std::string name, DebugMethod method) = 0;
  // Extra sections for `stats` (called on the JS thread when stats are requested).
  virtual void add_stats_provider(std::string name, std::function<Json()> provider) = 0;
  // Extra `info` fields (e.g. "glRenderer", "openxrRuntime"), any thread.
  virtual void set_info_field(std::string key, std::string value) = 0;
  // Boot timeline mark (ms since process start), any thread: "sessionGranted", "firstXrFrame", ...
  virtual void mark_boot(std::string name) = 0;

  // Teardown hooks (PROC-7): run on the JS thread in reverse registration order, after pagehide and before the
  // context and isolate are disposed. Workers join, storage flushes, audio stops here.
  virtual void add_shutdown_hook(std::function<void()> hook) = 0;
  // Any thread. Feeds lifecycle (the XR module uses kExternalHidden/kExternalVisible for OpenXR session state).
  virtual void post_lifecycle(LifecycleInput input) = 0;
  // Any thread. Ends the app: pagehide, shutdown hooks, teardown, then the host finishes the activity.
  virtual void request_exit() = 0;
};

}  // namespace iwn
