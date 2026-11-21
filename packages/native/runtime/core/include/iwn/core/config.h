/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The generated runtime config (assets/iwn/config.json), V8-free. Written by the packer (M5) or the template build
// script; every field has a default so an APK without the file still boots the dist under assets/app/.
//
// {
//   "origin": "https://app.local",            // MOD-2 (default; open question 1)
//   "appRoot": "app",                         // asset directory holding the Vite dist
//   "index": "index.html",
//   "preludes": ["iwn/prelude/glue.js"],      // classic runtime scripts run after the core bootstrap, before the page
//   "inspector": { "enabled": true, "port": 9229, "waitForDebugger": false },   // CDP-1, CDP-8
//                                             (enabled defaults to FLAG_DEBUGGABLE, as does debug.enabled)
//   "debug": { "enabled": true, "port": 0 },  // DBG-1: /host on the inspector port; port > 0 adds its own listener
//   "v8Flags": "",                            // diagnostic only (JS-3): debuggable builds; runtime flags win
//   "codeCache": { "enabled": true, "maxBytes": 67108864, "delayMs": 5000 },      // CC-1..4
//   "stats": { "logIntervalMs": 0 },          // LOG-3 periodic stats line; 0 = off
//   "app": { "packageId": "...", "versionName": "1.0.0", "versionCode": 1 },
//   "glue": { ... }                           // handed to the web glue as __iwn.config
// }
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "iwn/core/json.h"

namespace iwn {

struct RuntimeConfig {
  std::string origin = "https://app.local";
  std::string app_root = "app";
  std::string index = "index.html";
  std::vector<std::string> preludes;
  // Fail closed (CDP-1, CDP-10): the runtime seeds both from ApplicationInfo.FLAG_DEBUGGABLE before parsing, so a
  // config without these keys enables them only in debuggable builds.
  bool inspector_enabled = false;
  int inspector_port = 9229;
  bool wait_for_debugger = false;
  bool debug_enabled = false;
  int debug_port = 0;
  std::string v8_flags;
  bool code_cache_enabled = true;
  uint64_t code_cache_max_bytes = 64ull << 20;
  double code_cache_delay_ms = 5000;
  double stats_log_interval_ms = 0;
  std::string package_id;
  std::string version_name = "0.0.0";
  int64_t version_code = 0;
  Json glue;
};

// Missing fields keep the value they have in `base`; wrong types are reported in warnings and ignored.
RuntimeConfig parse_runtime_config(const Json& json, std::vector<std::string>* warnings, RuntimeConfig base = {});

}  // namespace iwn
