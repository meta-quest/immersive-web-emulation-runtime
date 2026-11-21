// Process-wide V8 setup (Android). The core's v8::Platform delegates worker threads and jobs to V8's default
// platform but routes each registered isolate's foreground tasks into that isolate's EventLoop, so GC steps,
// compile finalisation and Atomics.waitAsync wake the loop instead of waiting to be pumped.
#pragma once

#include <v8.h>

#include <memory>
#include <string>

#include "iwn/core/asset_source.h"
#include "iwn/core/event_loop.h"

namespace iwn {

struct V8InitOptions {
  std::shared_ptr<AssetBytes> snapshot;  // snapshot_blob.bin (external startup data); kept alive forever
  std::string diagnostic_flags;          // from the config / launch extras (JS-3); logged, unknown ones ignored
  int worker_threads = 3;
};

// Initialises V8 once per process (later calls are no-ops and log if their flags differ). Returns false on failure.
bool initialize_v8(const V8InitOptions& options);
bool v8_initialized();

// Creates an isolate whose foreground tasks go to `loop` (Isolate::Allocate + register + Initialize).
v8::Isolate* new_isolate(const v8::Isolate::CreateParams& params, EventLoop* loop);
// Disposes an isolate created with new_isolate (unregisters its task runner first).
void dispose_isolate(v8::Isolate* isolate);

// The runtime's fixed V8 flags, documented in runtime/README.md (JS-3).
const char* runtime_v8_flags();

}  // namespace iwn
