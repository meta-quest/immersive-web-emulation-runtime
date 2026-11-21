// How the platform shell (runtime/app: NativeActivity) starts and stops the runtime. The host owns the main JS
// thread; the shell only posts lifecycle inputs and never waits on JS (PROC-3).
#pragma once

#include <functional>
#include <memory>
#include <string>

#include "iwn/core/asset_source.h"
#include "iwn/core/lifecycle.h"

namespace iwn {

struct DeviceFacts {
  std::string model;             // Build.MODEL (ro.product.model)
  std::string manufacturer;      // ro.product.manufacturer
  std::string fingerprint;       // ro.build.fingerprint
  std::string android_release;   // ro.build.version.release
  int sdk_int = 0;
  std::string locale = "en-US";  // BCP 47
  int cpu_count = 0;
  double memory_gib = 0;
};

struct RuntimeOptions {
  std::shared_ptr<AssetSource> assets;
  std::string files_dir;  // app-private persistent storage
  std::string cache_dir;  // app-private cache (code cache lives here, CC-4)
  DeviceFacts device;
  std::string package_name;
  std::string version_name;
  int64_t version_code = 0;
  bool debuggable = false;          // ApplicationInfo.FLAG_DEBUGGABLE
  // Launch overrides (am start --es/--ez extras, honoured only in debuggable builds or when the config allows):
  std::string extra_v8_flags;       // "iwn.v8flags"
  int inspect_brk = -1;             // "iwn.inspectBrk": -1 unset, 0/1
  int inspector = -1;               // "iwn.inspector": -1 unset, 0/1 (force the inspector on/off)
  std::string extra_query;          // "iwn.query": the URL query string the page sees (DOM-5, PKG-CFG-3)
  std::string snapshot_asset = "iwn/v8/snapshot_blob.bin";
  std::string config_asset = "iwn/config.json";
  // Called on the JS thread after teardown when the runtime wants the activity to finish (request_exit()).
  std::function<void()> on_exit_requested;
};

class RuntimeHost {
 public:
  virtual ~RuntimeHost() = default;
  // Starts the main JS thread (named "iwn-js", 8 MB stack) and boots the page.
  virtual void start() = 0;
  // Any thread; never blocks.
  virtual void post_lifecycle(LifecycleInput input) = 0;
  virtual void post_low_memory() = 0;
  // Any thread; asks the JS thread to run pagehide + shutdown hooks + teardown and exit. Never blocks.
  virtual void request_quit() = 0;
  // Waits up to timeout_ms for the JS thread to finish; returns true if it did.
  virtual bool join(int timeout_ms) = 0;
};

std::unique_ptr<RuntimeHost> create_runtime_host(RuntimeOptions options);

}  // namespace iwn
