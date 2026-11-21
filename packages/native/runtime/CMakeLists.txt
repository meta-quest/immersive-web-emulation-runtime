# @iwer/native runtime: top-level build.
#
# Two configurations:
#   * Android arm64 (NDK toolchain file): the runtime library libiwernative.so for the APK, with V8 15.5.
#   * Host (x86_64 Linux): only the V8-free parts of every module and their unit tests (HL-3).
#
# Native module contract (see README.md): each module lives in runtime/<module>/ as a CMake static library and
# exposes  void iwn_register_<module>(v8::Isolate*, v8::Local<v8::Context>, v8::Local<v8::Object> natives).
# The registry below links every module it finds and calls the register functions at context creation.
cmake_minimum_required(VERSION 3.22)
project(iwer_native_runtime LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(ANDROID)
  set(IWN_ANDROID ON)
else()
  set(IWN_ANDROID OFF)
endif()

option(IWN_BUILD_TESTS "Build host unit tests (V8-free parts)" ${CMAKE_HOST_UNIX})
set(IWN_TOOLCHAIN_DIR "$ENV{IWN_TOOLCHAIN_DIR}" CACHE PATH "Optional toolchain root holding v8-15.5/ (default: $IWN_TOOLCHAIN_DIR)")
set(IWN_V8_DIR "${IWN_TOOLCHAIN_DIR}/v8-15.5" CACHE PATH "Prebuilt V8 15.5 (include/, lib/arm64-v8a/libv8android.so, snapshot_blob.bin)")
# Upstream third-party source trees, one directory per project (THIRD_PARTY.md names each one); every module
# also takes a per-project IWN_<X>_DIR that overrides its directory.
set(IWN_THIRD_PARTY_DIR "$ENV{IWN_THIRD_PARTY_DIR}" CACHE PATH "Upstream third-party source trees (default: $IWN_THIRD_PARTY_DIR)")
set(IWN_RUNTIME_VERSION "0.1.0" CACHE STRING "Runtime version reported by info/stats")
set(IWN_MODULES_EXCLUDE "" CACHE STRING "Semicolon list of native module directories to skip")

set(IWN_RUNTIME_DIR "${CMAKE_CURRENT_SOURCE_DIR}")

# Build id: git short hash of the checkout when available (reported in info/stats and the boot line, LOG-2).
# A caller-provided -DIWN_BUILD_ID (release/build-release.sh) wins so the .so and template.json agree.
if(NOT IWN_BUILD_ID)
  execute_process(COMMAND git rev-parse --short=12 HEAD WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
                  OUTPUT_VARIABLE IWN_BUILD_ID OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
  # As packager/template/build-template.mjs: "-dirty" when the package has uncommitted or untracked files (checked
  # at configure time), so a dev build never names a clean commit its code is not in.
  if(IWN_BUILD_ID)
    execute_process(COMMAND git status --porcelain -- .. WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
                    OUTPUT_VARIABLE _iwn_changes RESULT_VARIABLE _iwn_status_rc OUTPUT_STRIP_TRAILING_WHITESPACE
                    ERROR_QUIET)
    if(NOT _iwn_status_rc EQUAL 0 OR _iwn_changes)
      string(APPEND IWN_BUILD_ID "-dirty")
    endif()
  endif()
endif()
if(NOT IWN_BUILD_ID)
  set(IWN_BUILD_ID "unknown")
endif()

# Common warning set for our own code.
set(IWN_WARNINGS -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers)

# --- V8 (Android only; there is no host V8 build) --------------------------------------------------------------
if(IWN_ANDROID)
  if(NOT EXISTS "${IWN_V8_DIR}/lib/arm64-v8a/libv8android.so")
    message(FATAL_ERROR "libv8android.so not found under ${IWN_V8_DIR}")
  endif()
  add_library(iwn_v8 SHARED IMPORTED GLOBAL)
  set_target_properties(iwn_v8 PROPERTIES
    IMPORTED_LOCATION "${IWN_V8_DIR}/lib/arm64-v8a/libv8android.so"
    INTERFACE_INCLUDE_DIRECTORIES "${IWN_V8_DIR}/include"
    # v8-gn.h carries the build's defines (pointer compression on, sandbox off): must match libv8android.so.
    INTERFACE_COMPILE_DEFINITIONS "V8_GN_HEADER")
  add_library(iwn::v8 ALIAS iwn_v8)
endif()

# --- Host test helper -------------------------------------------------------------------------------------------
# iwn_add_host_test(<name> SOURCES a.cc b.cc LIBS lib1 lib2): a host executable registered with ctest.
if(IWN_BUILD_TESTS AND NOT IWN_ANDROID)
  enable_testing()
endif()
function(iwn_add_host_test name)
  if(NOT IWN_BUILD_TESTS OR IWN_ANDROID)
    return()
  endif()
  cmake_parse_arguments(T "" "" "SOURCES;LIBS" ${ARGN})
  add_executable(${name} ${T_SOURCES})
  target_link_libraries(${name} PRIVATE ${T_LIBS} iwn_test_main)
  target_compile_options(${name} PRIVATE ${IWN_WARNINGS})
  add_test(NAME ${name} COMMAND ${name})
endfunction()

# --- Core (always first: modules may link iwn::core / iwn::core_base) --------------------------------------------
add_subdirectory(core)

# --- Native modules: one add_subdirectory line per module -------------------------------------------------------
# A module registers itself either by naming its library target iwn_<dir> or with
#   set_property(GLOBAL APPEND PROPERTY IWN_NATIVE_MODULES "<module>:<target>")
# in its own CMakeLists.txt. <module> is the JS name (globalThis.__iwn.<module>) and the suffix of
# iwn_register_<module>. Order matters where a module builds optional parts against another one: image before
# canvas2d and workers (decoded-image handles), gl before xr.
add_subdirectory(gl)
add_subdirectory(image)

# --- Module registry ---------------------------------------------------------------------------------------------
include(cmake/registry.cmake)
iwn_finalize_native_modules()

# --- The Android app library (last: links every registered module) -----------------------------------------------
if(IWN_ANDROID)
  add_subdirectory(app)
endif()
