# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# runtime/core: the V8 embedding (M1). Two libraries:
#   iwn_core_base  V8-free logic (event loop, timers, URL/module resolution, HTML scan, WebSocket/HTTP server,
#                  code-cache store, lifecycle, JSON, config). Builds for Android and the host; host-tested (HL-3).
#   iwn_core       the V8 binding layer (platform, isolate/context, modules + code cache, inspector, debug endpoint,
#                  console/timers/lifecycle natives, module registry). Android only.
# Other modules link iwn::core (Android) for the Runtime API (iwn/core/runtime.h), or iwn::core_base for logging and
# the event loop in host tests.

add_library(iwn_core_base STATIC
  src/base/asset_source.cc
  src/base/clock.cc
  src/base/code_cache_store.cc
  src/base/config.cc
  src/base/event_loop.cc
  src/base/html_scan.cc
  src/base/json.cc
  src/base/lifecycle.cc
  src/base/log.cc
  src/base/loopback_server.cc
  src/base/monotonic_cv.cc
  src/base/serial_worker.cc
  src/base/text.cc
  src/base/timer_queue.cc
  src/base/url.cc
  src/base/websocket.cc
)
target_include_directories(iwn_core_base PUBLIC include)
target_compile_options(iwn_core_base PRIVATE ${IWN_WARNINGS})
find_package(Threads REQUIRED)
target_link_libraries(iwn_core_base PUBLIC Threads::Threads)
if(IWN_ANDROID)
  target_link_libraries(iwn_core_base PUBLIC log)
endif()
add_library(iwn::core_base ALIAS iwn_core_base)

# The core JS bootstrap is embedded in the library as a string (no asset needed to boot).
set(IWN_BOOTSTRAP_JS "${CMAKE_CURRENT_SOURCE_DIR}/js/bootstrap.js")
set(IWN_BOOTSTRAP_CC "${CMAKE_BINARY_DIR}/generated/iwn_bootstrap_js.cc")
add_custom_command(
  OUTPUT "${IWN_BOOTSTRAP_CC}"
  COMMAND ${CMAKE_COMMAND} -DIN=${IWN_BOOTSTRAP_JS} -DOUT=${IWN_BOOTSTRAP_CC} -DSYMBOL=kBootstrapJs
          -P "${CMAKE_CURRENT_SOURCE_DIR}/embed.cmake"
  DEPENDS "${IWN_BOOTSTRAP_JS}" "${CMAKE_CURRENT_SOURCE_DIR}/embed.cmake"
  COMMENT "Embedding core bootstrap.js")

if(IWN_ANDROID)
  add_library(iwn_core STATIC
    src/v8/clone.cc
    src/v8/debug_endpoint.cc
    src/v8/inspector.cc
    src/v8/modules.cc
    src/v8/natives_core.cc
    src/v8/platform.cc
    src/v8/runtime.cc
    src/v8/v8_util.cc
    "${IWN_BOOTSTRAP_CC}"
  )
  target_include_directories(iwn_core PUBLIC include PRIVATE src)
  # libv8android.so is built without RTTI: classes deriving from V8 interfaces (ValueSerializer::Delegate,
  # V8InspectorClient, Platform, ...) must be compiled with -fno-rtti too, or the link needs V8 typeinfo.
  target_compile_options(iwn_core PRIVATE ${IWN_WARNINGS} -fno-rtti)
  target_compile_definitions(iwn_core PRIVATE
    IWN_RUNTIME_VERSION="${IWN_RUNTIME_VERSION}" IWN_BUILD_ID="${IWN_BUILD_ID}")
  target_link_libraries(iwn_core PUBLIC iwn_core_base iwn::v8 log android)
  add_library(iwn::core ALIAS iwn_core)
endif()

# --- host tests --------------------------------------------------------------------------------------------------
if(IWN_BUILD_TESTS AND NOT IWN_ANDROID)
  add_library(iwn_test_main STATIC test/host/iwn_test_main.cc)
  target_include_directories(iwn_test_main PUBLIC test/host)
  iwn_add_host_test(iwn_core_base_tests
    SOURCES
      test/host/code_cache_store_test.cc
      test/host/config_test.cc
      test/host/event_loop_test.cc
      test/host/html_scan_test.cc
      test/host/json_test.cc
      test/host/lifecycle_test.cc
      test/host/log_test.cc
      test/host/loopback_server_test.cc
      test/host/monotonic_cv_test.cc
      test/host/serial_worker_test.cc
      test/host/text_test.cc
      test/host/timer_queue_test.cc
      test/host/url_test.cc
      test/host/websocket_test.cc
    LIBS iwn_core_base)
  # A tiny host binary that serves the inspector HTTP/WebSocket protocol with an echo backend, so Node clients
  # (Node 24's global WebSocket, raw sockets) can be tested against the real server code (CDP-3, DBG-1).
  add_executable(iwn_loopback_echo test/host/loopback_echo_main.cc)
  target_link_libraries(iwn_loopback_echo PRIVATE iwn_core_base)
endif()
