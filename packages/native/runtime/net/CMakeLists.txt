# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# net module: fetch transport (HTTP/1.1), WebSocket (RFC 6455), APK/dir
# assets, origin allowlist. Targets:
#   iwn_net_core  plain C++ (no V8): host-testable cores (+ JNI connector and
#                 AAssetManager source on Android)
#   iwn_net       the V8 binding (iwn_register_net), built when V8 headers are
#                 available (target `iwn_v8`, or IWN_V8_INCLUDE_DIR)
#   iwn_net_core_test  host test executable (ctest)
#
# Standalone host build:  cmake -S runtime/net -B build/net -G Ninja && ninja -C build/net -j 16 && ctest --test-dir build/net

cmake_minimum_required(VERSION 3.22)
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  project(iwn_net LANGUAGES C CXX)
  set(IWN_NET_TOPLEVEL ON)
endif()

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 20)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()

add_library(iwn_net_core STATIC
  src/util.cc
  src/url.cc
  src/assets.cc
  src/posix_stream.cc
  src/http_parser.cc
  src/http_client.cc
  src/websocket.cc
  src/watchdog.cc
  src/zip_index.cc
)
target_include_directories(iwn_net_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(iwn_net_core PRIVATE -Wall -Wextra -Wno-unused-parameter)
set_target_properties(iwn_net_core PROPERTIES POSITION_INDEPENDENT_CODE ON)

find_package(Threads REQUIRED)
if(ANDROID)
  # zlib and the asset manager are system libraries on Android (no bundled copy).
  target_sources(iwn_net_core PRIVATE android/android_assets.cc android/jni_connector.cc)
  target_include_directories(iwn_net_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/android)
  target_link_libraries(iwn_net_core PUBLIC z android log Threads::Threads)
else()
  find_package(ZLIB REQUIRED)
  target_link_libraries(iwn_net_core PUBLIC ZLIB::ZLIB Threads::Threads)
endif()

# V8 binding.
set(IWN_V8_INCLUDE_DIR "" CACHE PATH "V8 include directory (when no iwn_v8 target exists)")
if(TARGET iwn_v8 OR IWN_V8_INCLUDE_DIR)
  add_library(iwn_net STATIC binding/net_binding.cc)
  target_link_libraries(iwn_net PUBLIC iwn_net_core)
  if(TARGET iwn_v8)
    target_link_libraries(iwn_net PUBLIC iwn_v8)
  else()
    target_include_directories(iwn_net PUBLIC ${IWN_V8_INCLUDE_DIR})
    target_compile_definitions(iwn_net PUBLIC V8_GN_HEADER)
  endif()
  if(TARGET iwn_core)
    # Page isolate integration through the core Runtime API (post_task, call_function, shutdown hooks).
    target_link_libraries(iwn_net PUBLIC iwn_core)
    target_compile_definitions(iwn_net PRIVATE IWN_HAVE_CORE_RUNTIME=1)
  endif()
  target_compile_options(iwn_net PRIVATE -Wall -Wno-unused-parameter)
  set_target_properties(iwn_net PROPERTIES POSITION_INDEPENDENT_CODE ON)
endif()

if(NOT ANDROID)
  if(IWN_NET_TOPLEVEL OR IWN_BUILD_TESTS)
    set(_iwn_net_tests_default ON)
  else()
    set(_iwn_net_tests_default OFF)
  endif()
  option(IWN_NET_BUILD_TESTS "Build the net host tests" ${_iwn_net_tests_default})
  if(IWN_NET_BUILD_TESTS)
    enable_testing()
    add_executable(iwn_net_core_test test/net_core_test.cc)
    target_link_libraries(iwn_net_core_test PRIVATE iwn_net_core)
    add_test(NAME iwn_net_core_test COMMAND iwn_net_core_test)
    # The natives contract over stdio, for web/net's Node tests against the real core.
    add_executable(iwn_net_bridge test/net_bridge.cc)
    target_link_libraries(iwn_net_bridge PRIVATE iwn_net_core)
  endif()
endif()
