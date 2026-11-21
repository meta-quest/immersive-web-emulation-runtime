// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Public entry points of the net module for the runtime core.
//
//   1. once per process, before the first isolate:  iwn_net_configure(opts)
//      (optional with the core runtime: the binding then configures itself
//      from iwn::Runtime — assets, origin, the "network" config section)
//   2. per isolate/context (main + workers):  iwn::BindLoopHooks(isolate, &hooks)
//      then iwn_register_net(isolate, context, natives)  → globalThis.__iwn.net
//      Registering again for a new context of the same isolate (reload)
//      ends the previous context's requests and sockets.
//   3. before disposing a worker isolate:  iwn_net_dispose_isolate(isolate)
//      (the page isolate does this itself through a core shutdown hook)
//   4. only when the process is about to exit:  iwn_net_abort_all()
//      Do NOT call it on pause/visibility changes: PROC-6 expects in-flight
//      requests and sockets to carry on after resume (a socket the OS drops
//      fails on its own). Thread-safe.

#ifndef IWN_NET_MODULE_H_
#define IWN_NET_MODULE_H_

#include <memory>
#include <string>
#include <vector>

#include "iwn/net/assets.h"

namespace v8 {
class Isolate;
class Context;
class Object;
template <class T>
class Local;
}  // namespace v8

struct IwnNetOptions {
  // The app's files (AndroidAssetSource on device, DirAssetSource headless).
  std::shared_ptr<iwn::net::AssetSource> assets;
  // native.network.allow from the packed config (NET-5).
  std::vector<std::string> allow;
  // Debug build: cleartext http/ws to loopback hosts may be allowlisted.
  bool debug_build = false;
  std::string app_origin = "https://app.local";
  std::string user_agent = "iwer-native";
  int timeout_ms = 60000;
  // WebSocket is outside the alpha's supported surface: wsConnect/wsSend/
  // wsClose (and so the JS WebSocket global) exist only when this is set
  // ("network": {"experimentalWebSocket": true} in assets/iwn/config.json).
  bool experimental_websocket = false;
  // Android: the process JavaVM* (TLS/sockets through the platform). Null on
  // the host build (plain TCP only).
  void* java_vm = nullptr;
};

void iwn_net_configure(const IwnNetOptions& options);
void iwn_register_net(v8::Isolate* isolate, v8::Local<v8::Context> ctx, v8::Local<v8::Object> natives);
void iwn_net_abort_all();
void iwn_net_dispose_isolate(v8::Isolate* isolate);

#endif  // IWN_NET_MODULE_H_
