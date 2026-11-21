// V8 binding of the image module: installs globalThis.__iwn.image (the contract is web/image/natives.ts) and gives
// other native modules (WebGL binding, Canvas 2D) access to the pixels behind an ImageBitmap / HTMLImageElement
// handle. See ../../../INTEROP.md for the texImage2D / drawImage contract.
#pragma once

#include <functional>
#include <memory>

#include <v8-context.h>
#include <v8-isolate.h>
#include <v8-local-handle.h>
#include <v8-object.h>
#include <v8-platform.h>

#include "iwn/image/pixels.h"

// The module entry point (NATIVE MODULE CONTRACT). Call once per context, on the context's thread.
void iwn_register_image(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);

namespace iwn::image {

// How finished jobs get back to the JS thread, chosen per registration in this order:
//  1. the core runtime (iwn::Runtime::From(isolate), the page isolate): Runtime::post_task. The module also adds a
//     shutdown hook (DisposeIsolate) and an "image" stats provider. Nothing to configure.
//  2. the per-isolate loop hooks of iwn/loop_hooks_registry.h (worker isolates), when bound before registration.
//  3. BindingConfig::post: queues `task` as a task on `isolate`'s thread (run it, then a microtask checkpoint).
//     Called from pool threads; never called for an isolate after DisposeIsolate(isolate) has returned.
//  4. BindingConfig::platform: platform->GetForegroundTaskRunner(isolate); the loop must pump it.
//  5. none: completions are queued; JS drains them with __iwn.image.poll() (`needsPolling` is true). Slower: only
//     for bring-up and tests.
// Set before the iwn_register_image calls it should affect.
struct BindingConfig {
  std::function<void(v8::Isolate* isolate, std::function<void()> task)> post;
  v8::Platform* platform = nullptr;
  int decode_threads = 0;    // 0: TaskPool::DefaultThreadCount(); only the first ConfigureBinding sets it
  bool gpu_backed = false;   // Android: decode into AHardwareBuffer-backed stores (INTEROP.md, zero-copy path)
  bool allow_os_formats = true;  // HEIF/AVIF/ICO beyond the IMG-1 set
  uint64_t decode_memory_budget = 0;  // bytes of decodes in flight (DecodeBudget); 0 keeps the default (512 MiB)
};
void ConfigureBinding(const BindingConfig& config);

// Frees everything the module holds for `isolate` (live handles' pixels, pending promises, every page context's
// state) and stops all posting for it. Call on the isolate's thread before Isolate::Dispose(); jobs still running
// finish and are dropped. The core runtime's page isolate does this through a shutdown hook; embedders of other
// isolates (workers, tests) must call it themselves: the module keys its state by isolate address, and a later
// isolate allocated at the same address would otherwise inherit handles of the dead one.
// Order for those isolates (INTEROP.md section 7): DisposeIsolate while the isolate's loop hooks are still bound,
// then UnbindLoopHooks and free the loop, then Isolate::Dispose(). Pumping tasks in between is safe: JS that runs
// after DisposeIsolate (FinalizationRegistry callbacks, other tasks) finds the image natives inert (the ones that
// return values throw a TypeError; close/cancel/poll do nothing), and old handles no longer resolve to pixels.
void DisposeIsolate(v8::Isolate* isolate);

// Registering again in the same isolate (a new page context, location.reload()) replaces the previous registration:
// the old context is released at once and the old page's completions are dropped. A retired registration is freed
// once its context was collected and its handles finalized (retired_states counts only those not yet freed).
struct BindingStats {
  bool registered = false;
  size_t pending = 0;  // current registration
  size_t handles = 0;
  size_t bytes = 0;
  int mode = 0;  // 0 runtime, 1 loop hooks, 2 post, 3 platform, 4 poll
  size_t retired_states = 0;  // earlier registrations in this isolate
  size_t retired_handles = 0;  // their handles still alive (not yet collected)
  size_t retired_bytes = 0;
  bool retired_holding_context = false;  // must stay false: a retired state never pins its context
};
BindingStats GetBindingStats(v8::Isolate* isolate);
// Test only: handles DisposeIsolate left to their pending second-pass weak callback, and how many of those ran.
void DeferredBoxStatsForTesting(size_t* deferred, size_t* freed);

// --- for other native modules (same thread as the isolate) -----------------------------------------------------

// The store behind a handle object returned by __iwn.image.* (also accepts the JS ImageBitmap/HTMLImageElement
// wrapper's handle, not the wrapper itself). nullptr if `value` is not a live (unclosed) handle.
std::shared_ptr<const PixelStore> GetPixelStore(v8::Isolate* isolate, v8::Local<v8::Value> value);

// Wraps a store in a new handle object (e.g. Canvas 2D's transferToImageBitmap). Reports its memory to V8.
v8::Local<v8::Object> WrapPixelStore(v8::Isolate* isolate, v8::Local<v8::Context> ctx,
                                     std::shared_ptr<const PixelStore> store);

}  // namespace iwn::image
