# runtime/canvas2d: CanvasRenderingContext2D raster core + text (FreeType, HarfBuzz) for @iwer/native.
#
# Targets:
#   iwn_canvas2d_core  static, plain C++ (no V8): rasterizer, paints, compositing, fonts, shaping. Host-testable.
#   iwn_canvas2d       static, the V8 binding: iwn_register_canvas2d(isolate, ctx, natives) -> globalThis.__iwn.canvas2d
#                      (needs IWN_V8_INCLUDE_DIR; built by default on Android).
#   iwn_canvas2d_napi  Node addon with the same JS-facing API, for the headless golden tests (host only).
#   iwn_canvas2d_tests host unit tests (ctest).
#
# Standalone host build:   cmake -S runtime/canvas2d -B build/canvas2d-host -G Ninja && ninja -C ... -j 16
# As a subdirectory:       add_subdirectory(canvas2d) from runtime/CMakeLists.txt.
cmake_minimum_required(VERSION 3.22)

if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  project(iwn_canvas2d C CXX)
  set(_iwn_c2d_top ON)
else()
  set(_iwn_c2d_top OFF)
endif()

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 20)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()

# Third-party sources: the upstream trees under IWN_THIRD_PARTY_DIR (see THIRD_PARTY.md), -DIWN_THIRD_PARTY_DIR or
# $IWN_THIRD_PARTY_DIR; each IWN_<X>_DIR below overrides one of them.
set(IWN_THIRD_PARTY_DIR "$ENV{IWN_THIRD_PARTY_DIR}" CACHE PATH "Upstream third-party source trees (default: $IWN_THIRD_PARTY_DIR)")
set(IWN_FREETYPE_DIR "${IWN_THIRD_PARTY_DIR}/freetype" CACHE PATH "FreeType source")
set(IWN_HARFBUZZ_DIR "${IWN_THIRD_PARTY_DIR}/harfbuzz" CACHE PATH "HarfBuzz source")
set(IWN_BROTLI_DIR "${IWN_THIRD_PARTY_DIR}/brotli" CACHE PATH "Brotli source")
# stb: upstream nothings/stb @ 2e2bef46 (stb_image 2.30, stb_image_write 1.16). The V8 default follows the runtime
# top level (IWN_V8_DIR) when built as its subdirectory.
set(_iwn_c2d_stb "${IWN_THIRD_PARTY_DIR}/stb")
if(IWN_V8_DIR)
  set(_iwn_c2d_v8 "${IWN_V8_DIR}/include")
else()
  set(_iwn_c2d_v8 "$ENV{IWN_V8_DIR}/include")
endif()
set(IWN_STB_DIR "${_iwn_c2d_stb}" CACHE PATH "stb headers")
set(IWN_V8_INCLUDE_DIR "${_iwn_c2d_v8}" CACHE PATH "V8 headers")
set(IWN_NODE_API_INCLUDE_DIR "" CACHE PATH "node-api-headers include dir (node_api.h) for the test addon")

option(IWN_CANVAS2D_WOFF2 "WOFF2 font support (Brotli decoder)" ON)
if(ANDROID)
  option(IWN_CANVAS2D_V8 "Build the V8 binding" ON)
  option(IWN_CANVAS2D_TESTS "Build host unit tests" OFF)
else()
  option(IWN_CANVAS2D_V8 "Build the V8 binding" OFF)
  if(DEFINED IWN_BUILD_TESTS)
    option(IWN_CANVAS2D_TESTS "Build host unit tests" ${IWN_BUILD_TESTS})
  else()
    option(IWN_CANVAS2D_TESTS "Build host unit tests" ${_iwn_c2d_top})
  endif()
endif()

if(IWN_CANVAS2D_WOFF2)
  include(${CMAKE_CURRENT_LIST_DIR}/third_party/brotli.cmake)
endif()
include(${CMAKE_CURRENT_LIST_DIR}/third_party/freetype.cmake)
include(${CMAKE_CURRENT_LIST_DIR}/third_party/harfbuzz.cmake)

add_library(iwn_canvas2d_core STATIC
  src/raster.cc
  src/geometry.cc
  src/blend.cc
  src/shader.cc
  src/canvas.cc
  src/codec.cc
  src/font.cc
  src/text.cc
  src/fonts_xml.cc
  src/bidi.cc)
target_include_directories(iwn_canvas2d_core PUBLIC ${CMAKE_CURRENT_LIST_DIR}/include
  PRIVATE ${CMAKE_CURRENT_LIST_DIR}/src)
target_include_directories(iwn_canvas2d_core SYSTEM PRIVATE ${IWN_STB_DIR})
target_link_libraries(iwn_canvas2d_core PUBLIC iwn_freetype iwn_harfbuzz)
set_target_properties(iwn_canvas2d_core PROPERTIES POSITION_INDEPENDENT_CODE ON CXX_VISIBILITY_PRESET hidden)
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(iwn_canvas2d_core PRIVATE -Wall -Wextra -Wno-unused-parameter -ffunction-sections -fdata-sections)
endif()
find_package(Threads)
if(Threads_FOUND)
  target_link_libraries(iwn_canvas2d_core PUBLIC Threads::Threads)
endif()

# Shared JS-facing binding logic (argument decoding is per engine; the operations are here).
add_library(iwn_canvas2d_api STATIC binding/api.cc)
target_include_directories(iwn_canvas2d_api PUBLIC ${CMAKE_CURRENT_LIST_DIR}/binding)
target_link_libraries(iwn_canvas2d_api PUBLIC iwn_canvas2d_core)
set_target_properties(iwn_canvas2d_api PROPERTIES POSITION_INDEPENDENT_CODE ON CXX_VISIBILITY_PRESET hidden)

if(IWN_CANVAS2D_V8)
  add_library(iwn_canvas2d STATIC binding/v8_binding.cc)
  if(TARGET iwn_v8)
    target_link_libraries(iwn_canvas2d PUBLIC iwn_v8)  # runtime top level: headers + V8_GN_HEADER
  else()
    if(NOT IWN_V8_INCLUDE_DIR)
      set(IWN_V8_INCLUDE_DIR "${_iwn_c2d_v8}")
    endif()
    target_include_directories(iwn_canvas2d SYSTEM PUBLIC ${IWN_V8_INCLUDE_DIR})
    target_compile_definitions(iwn_canvas2d PUBLIC V8_GN_HEADER)
  endif()
  target_link_libraries(iwn_canvas2d PUBLIC iwn_canvas2d_api)
  target_include_directories(iwn_canvas2d PUBLIC ${CMAKE_CURRENT_LIST_DIR}/binding)
  # runtime/image present: draw ImageBitmap/HTMLImageElement handles straight from its PixelStore.
  if(TARGET iwn_image_v8)
    target_link_libraries(iwn_canvas2d PRIVATE iwn_image_v8)
    target_compile_definitions(iwn_canvas2d PRIVATE IWN_C2D_WITH_IMAGE)
  endif()
  # Inside the runtime: bundled fonts from the APK assets and teardown through the core Runtime API.
  if(TARGET iwn_core)
    target_link_libraries(iwn_canvas2d PRIVATE iwn_core)
    target_compile_definitions(iwn_canvas2d PRIVATE IWN_HAVE_CORE_RUNTIME=1)
  endif()
  if(ANDROID)
    target_sources(iwn_canvas2d PRIVATE binding/android_assets.cc)
    target_link_libraries(iwn_canvas2d PUBLIC android)
  endif()
endif()

if(IWN_NODE_API_INCLUDE_DIR AND NOT ANDROID)
  add_library(iwn_canvas2d_napi MODULE binding/napi_binding.cc)
  target_include_directories(iwn_canvas2d_napi SYSTEM PRIVATE ${IWN_NODE_API_INCLUDE_DIR})
  target_compile_definitions(iwn_canvas2d_napi PRIVATE NAPI_VERSION=8 NODE_GYP_MODULE_NAME=canvas2d)
  target_link_libraries(iwn_canvas2d_napi PRIVATE iwn_canvas2d_api)
  set_target_properties(iwn_canvas2d_napi PROPERTIES PREFIX "" SUFFIX ".node" OUTPUT_NAME "canvas2d"
    CXX_VISIBILITY_PRESET hidden)
  if(NOT APPLE)
    target_link_options(iwn_canvas2d_napi PRIVATE -Wl,--unresolved-symbols=ignore-all)
  endif()
endif()

if(IWN_CANVAS2D_TESTS)
  enable_testing()
  add_executable(iwn_canvas2d_tests
    test/test_main.cc
    test/raster_test.cc
    test/canvas_test.cc
    test/text_test.cc
    test/intl_robust_test.cc
    test/bounds_test.cc
    test/stroke_raster_test.cc)
  target_include_directories(iwn_canvas2d_tests PRIVATE ${CMAKE_CURRENT_LIST_DIR}/src ${CMAKE_CURRENT_LIST_DIR}/test)
  target_link_libraries(iwn_canvas2d_tests PRIVATE iwn_canvas2d_core)
  target_compile_definitions(iwn_canvas2d_tests PRIVATE
    IWN_C2D_FONT_DIR="${CMAKE_CURRENT_LIST_DIR}/fonts")
  add_test(NAME iwn_canvas2d_tests COMMAND iwn_canvas2d_tests)
endif()
