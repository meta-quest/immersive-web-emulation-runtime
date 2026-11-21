// Worker policy without V8: the "workers" config section, the live-worker limit (WRK-9), worker URL checks
// (WRK-1), script loading for worker scripts, importScripts and worker modules (WRK-1, WRK-3, WRK-4), and thread
// naming (PROC-4).
//
// Config (assets/iwn/config.json, top-level "workers" object; every field optional):
//   "workers": {
//     "maxWorkers": 32,              // WRK-9: live workers per process (nested workers count too)
//     "heapLimitMB": 256,            // WRK-9: old-space limit of each worker isolate
//     "stackKB": 4096,               // worker thread stack (V8's limit leaves 256 KB headroom)
//     "nice": 10,                    // WRK-11: worker threads run below the JS thread (nice 0 or lower) and audio
//     "crossOriginIsolated": true,   // SharedArrayBuffer / shared wasm memory may cross threads (see README)
//     "hardwareConcurrency": 4,      // WRK-12: navigator.hardwareConcurrency in every global (min with the cores)
//     "preludes": [...],             // classic runtime scripts for worker globals (default: the page's preludes)
//     "excludeModules": ["gl", "audio", "storage", "xr"],  // native modules a worker global does not get (WRK-2)
//     "messageLog": 0,               // WRK-10: keep the last N messages (debug endpoint "workers"); -1 = 256 in
//                                    // debuggable builds, 0 elsewhere (default -1)
//     "joinTimeoutMs": 2000,         // PROC-7: how long app exit waits for worker threads
//     "codeCacheMB": 32              // CC-5: in-process code cache shared by worker isolates (0 = off)
//   }
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "iwn/core/asset_source.h"
#include "iwn/core/json.h"
#include "iwn/core/url.h"

namespace iwn::workers {

struct WorkersConfig {
  int max_workers = 32;
  uint64_t heap_limit_bytes = 256ull << 20;
  size_t stack_bytes = 4u << 20;
  int nice = 10;
  bool cross_origin_isolated = true;
  int hardware_concurrency = 4;
  std::optional<std::vector<std::string>> preludes;
  std::vector<std::string> exclude_modules = {"gl", "audio", "storage", "xr"};
  int message_log = -1;
  double join_timeout_ms = 2000;
  size_t code_cache_bytes = 32u << 20;
};

// Parses the "workers" section (a missing or non-object section gives the defaults). Bad values are reported in
// `warnings` and ignored.
WorkersConfig parse_workers_config(const Json& section, std::vector<std::string>* warnings);

// WRK-12: the value navigator.hardwareConcurrency reports: min(cores, cap), at least 1.
int capped_concurrency(int cores, int cap);

// WRK-9: live-worker accounting (process-wide in the binding; instances in tests).
class WorkerLimiter {
 public:
  explicit WorkerLimiter(int max = 32) : max_(max) {}
  void set_max(int max) { max_.store(max); }
  int max() const { return max_.load(); }
  // Takes a slot; false when `max` workers are alive.
  bool try_acquire();
  void release();
  int live() const { return live_.load(); }
  uint64_t created() const { return created_.load(); }

 private:
  std::atomic<int> max_;
  std::atomic<int> live_{0};
  std::atomic<uint64_t> created_{0};
};

// WRK-1: may a global with origin `creator_origin` start a worker from `url`? Same-origin URLs, data: (opaque origin)
// and blob: URLs are allowed (a blob: URL's origin is its creator's; the bytes come from the creator's store).
enum class WorkerUrlCheck { kOk, kCrossOrigin, kUnsupportedScheme };
WorkerUrlCheck check_worker_url(const Url& url, const std::string& creator_origin);

// Where scripts come from: the app's dist inside the packaged assets, under the app origin.
struct ScriptSource {
  Url app_origin;            // https://app.local/
  std::string app_root;      // asset directory of the dist ("app")
  AssetSource* assets = nullptr;
};

struct FetchedScript {
  bool ok = false;
  std::string source;
  std::string mime;   // from the extension (assets) or the data: URL; empty when unknown
  std::string error;  // why it failed (log / exception text)
};

// Reads a script for a worker, importScripts or a worker module: same-origin asset or data: URL. (blob: URLs are
// resolved by the caller against the right global's store; other origins are refused: NET-5 has no network
// module/worker loads.) `require_js_mime`: module scripts need a JavaScript MIME type (HTML).
FetchedScript fetch_script(const std::string& url, const ScriptSource& from, bool require_js_mime);

// PROC-4: "iwn-w<id>-<name>", at most 15 characters (pthread limit), name sanitised to [A-Za-z0-9._-].
std::string worker_thread_name(uint64_t id, const std::string& name);

// The label of a worker in logs and the message log: "worker <id> '<name>'" or "worker <id> <url>".
std::string worker_label(uint64_t id, const std::string& name, const std::string& url);

}  // namespace iwn::workers
