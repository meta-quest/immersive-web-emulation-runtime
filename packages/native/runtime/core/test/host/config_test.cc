/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "iwn/core/config.h"
#include "iwn_test.h"

using namespace iwn;

IWN_TEST(Config, DefaultsWhenMissing) {
  std::vector<std::string> w;
  auto c = parse_runtime_config(Json(), &w);
  IWN_CHECK(w.empty());
  IWN_CHECK_EQ(c.origin, std::string("https://app.local"));
  IWN_CHECK_EQ(c.app_root, std::string("app"));
  IWN_CHECK_EQ(c.inspector_port, 9229);
  IWN_CHECK(c.code_cache_enabled);
}

IWN_TEST(Config, ParsesAndWarns) {
  auto j = Json::parse(R"({"origin":"https://game.local:8443/x","appRoot":"app/","preludes":["iwn/prelude/glue.js"],
    "inspector":{"enabled":false,"port":9501,"waitForDebugger":true},"debug":{"port":9601},
    "codeCache":{"delayMs":"soon"},"app":{"packageId":"com.x.y","versionCode":12}})");
  std::vector<std::string> w;
  auto c = parse_runtime_config(*j, &w);
  IWN_CHECK_EQ(c.origin, std::string("https://game.local:8443"));
  IWN_CHECK_EQ(c.app_root, std::string("app"));
  IWN_CHECK_EQ(c.preludes.size(), size_t(1));
  IWN_CHECK(!c.inspector_enabled);
  IWN_CHECK_EQ(c.inspector_port, 9501);
  IWN_CHECK(c.wait_for_debugger);
  IWN_CHECK_EQ(c.debug_port, 9601);
  IWN_CHECK_EQ(c.code_cache_delay_ms, 5000.0);
  IWN_CHECK_EQ(w.size(), size_t(1));
  IWN_CHECK_EQ(c.package_id, std::string("com.x.y"));
  IWN_CHECK_EQ(c.version_code, int64_t(12));
}

IWN_TEST(Config, BadOriginFallsBack) {
  std::vector<std::string> w;
  auto c = parse_runtime_config(*Json::parse(R"({"origin":"not a url"})"), &w);
  IWN_CHECK_EQ(c.origin, std::string("https://app.local"));
  IWN_CHECK_EQ(w.size(), size_t(1));
}

IWN_TEST(Config, DebugSurfacesFailClosed) {
  // No keys: off by default; the runtime seeds them from FLAG_DEBUGGABLE through `base`.
  auto c = parse_runtime_config(*Json::parse(R"({"app":{"packageId":"a.b"}})"), nullptr);
  IWN_CHECK(!c.inspector_enabled);
  IWN_CHECK(!c.debug_enabled);
  RuntimeConfig debuggable;
  debuggable.inspector_enabled = debuggable.debug_enabled = true;
  auto d = parse_runtime_config(*Json::parse(R"({"debug":{"enabled":false}})"), nullptr, debuggable);
  IWN_CHECK(d.inspector_enabled);
  IWN_CHECK(!d.debug_enabled);
}
