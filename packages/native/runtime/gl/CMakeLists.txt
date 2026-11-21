# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# runtime/gl: the generated WebGL 2 binding.
#
# Targets
#   iwn_gl_core   static, V8-free: GLES function table, EGL environment, blob cache, composite natives.
#   iwn_gl        static: iwn_gl_core + the V8 natives (generated fast-API + slow paths) + iwn_register_gl().
#                 Needs V8 headers: target iwn::v8 if the parent defines it, else IWN_V8_DIR/include
#                 (compiled with -DV8_GN_HEADER as the prebuilt V8 15.5 requires).
#   iwn_gl_tests  host only (Linux + Mesa EGL/GLES): native unit tests against a real ES 3.2 driver.
#   iwn_gl_node   host only, optional (-DIWN_GL_NODE_ADDON=ON): the same natives built as a Node addon
#                 against Node 24's V8, so the TypeScript binding runs headlessly on real GL in Node.
#
# Standalone host build:
#   cmake -S runtime/gl -B build/gl-host -G Ninja -DIWN_GL_NODE_ADDON=ON && ninja -C build/gl-host -j 16
# Android (arm64) build: see runtime/gl/README.md (NDK toolchain file, -DANDROID_ABI=arm64-v8a).

cmake_minimum_required(VERSION 3.22)
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  project(iwn_gl LANGUAGES C CXX)
  set(IWN_GL_TOPLEVEL ON)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(IWN_V8_DIR "$ENV{IWN_V8_DIR}" CACHE PATH "Prebuilt V8 (include/, lib/)")
option(IWN_GL_HOST_TESTS "Build the host GL tests (Linux + Mesa)" ${IWN_GL_TOPLEVEL})
option(IWN_GL_NODE_ADDON "Build the Node addon for host binding tests" OFF)

set(IWN_GL_DIR ${CMAKE_CURRENT_SOURCE_DIR})

add_library(iwn_gl_core STATIC
  generated/gl_api.gen.cc
  src/blob_cache.cc
  src/composites.cc
  src/egl_context.cc
)
target_include_directories(iwn_gl_core PUBLIC ${IWN_GL_DIR}/include ${IWN_GL_DIR}/src ${IWN_GL_DIR}/generated)
target_compile_options(iwn_gl_core PRIVATE -Wall -Wextra -Wno-unused-parameter)
if(ANDROID)
  target_link_libraries(iwn_gl_core PUBLIC EGL log dl)
else()
  find_library(IWN_EGL_LIB EGL REQUIRED)
  target_link_libraries(iwn_gl_core PUBLIC ${IWN_EGL_LIB} dl)
endif()

function(iwn_gl_v8_sources target)
  target_sources(${target} PRIVATE
    ${IWN_GL_DIR}/generated/gl_natives.gen.cc
    ${IWN_GL_DIR}/src/gl_module.cc
    ${IWN_GL_DIR}/src/gl_v8_composites.cc
    ${IWN_GL_DIR}/src/gl_image.cc)
endfunction()

if(ANDROID OR IWN_GL_WITH_V8)
  add_library(iwn_gl STATIC)
  iwn_gl_v8_sources(iwn_gl)
  target_link_libraries(iwn_gl PUBLIC iwn_gl_core)
  if(TARGET iwn::v8)
    target_link_libraries(iwn_gl PUBLIC iwn::v8)
  else()
    target_include_directories(iwn_gl PRIVATE ${IWN_V8_DIR}/include)
    target_compile_definitions(iwn_gl PRIVATE V8_GN_HEADER)
  endif()
  target_compile_options(iwn_gl PRIVATE -Wall -Wno-unused-parameter -Wno-unused-function)
  # Uploads from ImageBitmap / HTMLImageElement handles (src/gl_image.cc) when the runtime also builds the image
  # module. Generator expressions: runtime/CMakeLists.txt may add the image module after this one.
  target_compile_definitions(iwn_gl PRIVATE $<$<TARGET_EXISTS:iwn_image_v8>:IWN_GL_WITH_IMAGE=1>)
  target_link_libraries(iwn_gl PUBLIC $<TARGET_NAME_IF_EXISTS:iwn_image_v8>)
  if(ANDROID)
    target_link_libraries(iwn_gl PRIVATE nativewindow)  # AHardwareBuffer stores: GPU copy (src/gl_image.cc)
  endif()
  # runtime/ build: the GL renderer goes into the core runtime's info{} (DBG-6, iwn::Runtime::set_info_field).
  if(TARGET iwn_core)
    target_link_libraries(iwn_gl PUBLIC iwn_core)
    target_compile_definitions(iwn_gl PRIVATE IWN_GL_HAVE_CORE_RUNTIME=1)
  endif()
endif()

if(IWN_GL_HOST_TESTS AND NOT ANDROID)
  add_executable(iwn_gl_tests test/native/gl_core_test.cc)
  target_link_libraries(iwn_gl_tests PRIVATE iwn_gl_core)
  enable_testing()
  add_test(NAME iwn_gl_tests COMMAND iwn_gl_tests)
endif()

if(IWN_GL_NODE_ADDON AND NOT ANDROID)
  # Node 24 ships V8 13.6 headers without v8-fast-api-calls.h; test/node-addon/v8-13.6/ holds that one
  # header from the matching V8 tag (BSD-3-Clause, see THIRD_PARTY.md).
  execute_process(COMMAND node -p "require('path').resolve(process.execPath, '../../include/node')"
                  OUTPUT_VARIABLE IWN_NODE_INCLUDE OUTPUT_STRIP_TRAILING_WHITESPACE)
  add_library(iwn_gl_node MODULE test/node-addon/addon.cc)
  iwn_gl_v8_sources(iwn_gl_node)
  target_include_directories(iwn_gl_node PRIVATE ${IWN_GL_DIR}/test/node-addon/v8-13.6 ${IWN_NODE_INCLUDE})
  target_compile_definitions(iwn_gl_node PRIVATE IWN_GL_NODE_ADDON=1 NODE_GYP_MODULE_NAME=iwn_gl)
  target_link_libraries(iwn_gl_node PRIVATE iwn_gl_core)
  target_compile_options(iwn_gl_node PRIVATE -Wno-unused-parameter -Wno-unused-function)
  set_target_properties(iwn_gl_node PROPERTIES PREFIX "" SUFFIX ".node" OUTPUT_NAME iwn_gl)
  target_link_options(iwn_gl_node PRIVATE -Wl,--allow-shlib-undefined)
endif()
