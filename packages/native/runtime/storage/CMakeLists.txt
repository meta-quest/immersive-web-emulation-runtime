# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# storage module: durable KV file for localStorage, SQLite backend for
# IndexedDB / Cache API. Targets:
#   iwn_sqlite3          SQLite 3.53.2 amalgamation (public domain), our flags
#   iwn_storage_core     plain C++ (no V8), host-testable
#   iwn_storage          the V8 binding (iwn_register_storage) when V8 headers exist
#   iwn_storage_core_test  host tests (ctest)
#
# Standalone host build:  cmake -S runtime/storage -B build/storage -G Ninja && ninja -C build/storage -j 16

cmake_minimum_required(VERSION 3.22)
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  project(iwn_storage LANGUAGES C CXX)
  set(IWN_STORAGE_TOPLEVEL ON)
endif()

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 20)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()

# SQLite amalgamation 3.53.2 (sqlite.org, see THIRD_PARTY.md):
# -DIWN_SQLITE_DIR, $IWN_SQLITE_DIR or <IWN_THIRD_PARTY_DIR>/sqlite.
if(IWN_THIRD_PARTY_DIR)
  set(_iwn_sqlite_default "${IWN_THIRD_PARTY_DIR}/sqlite")
else()
  set(_iwn_sqlite_default "$ENV{IWN_SQLITE_DIR}")
endif()
set(IWN_SQLITE_DIR "${_iwn_sqlite_default}" CACHE PATH "Directory with sqlite3.c/sqlite3.h")
if(NOT TARGET iwn_sqlite3)
  add_library(iwn_sqlite3 STATIC ${IWN_SQLITE_DIR}/sqlite3.c)
  target_include_directories(iwn_sqlite3 PUBLIC ${IWN_SQLITE_DIR})
  target_compile_definitions(iwn_sqlite3 PRIVATE
    SQLITE_THREADSAFE=2            # each connection is used by one worker thread
    SQLITE_DQS=0
    SQLITE_DEFAULT_MEMSTATUS=0
    SQLITE_DEFAULT_WAL_SYNCHRONOUS=2
    SQLITE_TEMP_STORE=2
    SQLITE_OMIT_DEPRECATED
    SQLITE_OMIT_LOAD_EXTENSION
    SQLITE_OMIT_SHARED_CACHE
    SQLITE_OMIT_PROGRESS_CALLBACK
    SQLITE_OMIT_TCL_VARIABLE
    SQLITE_USE_ALLOCA
    SQLITE_LIKE_DOESNT_MATCH_BLOBS
    SQLITE_MAX_EXPR_DEPTH=0
    HAVE_USLEEP=1
  )
  target_compile_options(iwn_sqlite3 PRIVATE -w -O2)
  set_target_properties(iwn_sqlite3 PROPERTIES POSITION_INDEPENDENT_CODE ON)
endif()

find_package(Threads REQUIRED)
add_library(iwn_storage_core STATIC src/fs_util.cc src/kv_store.cc src/sql_database.cc)
target_include_directories(iwn_storage_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(iwn_storage_core PUBLIC iwn_sqlite3 Threads::Threads)
target_compile_options(iwn_storage_core PRIVATE -Wall -Wextra -Wno-unused-parameter)
set_target_properties(iwn_storage_core PROPERTIES POSITION_INDEPENDENT_CODE ON)
if(ANDROID)
  target_link_libraries(iwn_storage_core PUBLIC z log)
else()
  find_package(ZLIB REQUIRED)
  target_link_libraries(iwn_storage_core PUBLIC ZLIB::ZLIB dl)
endif()

set(IWN_V8_INCLUDE_DIR "" CACHE PATH "V8 include directory (when no iwn_v8 target exists)")
if(TARGET iwn_v8 OR IWN_V8_INCLUDE_DIR)
  add_library(iwn_storage STATIC binding/storage_binding.cc)
  # loop_hooks.h is shared with the net module (header only, no link dependency).
  target_include_directories(iwn_storage PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../net/include)
  target_link_libraries(iwn_storage PUBLIC iwn_storage_core)
  if(TARGET iwn_v8)
    target_link_libraries(iwn_storage PUBLIC iwn_v8)
  else()
    target_include_directories(iwn_storage PUBLIC ${IWN_V8_INCLUDE_DIR})
    target_compile_definitions(iwn_storage PUBLIC V8_GN_HEADER)
  endif()
  if(TARGET iwn_core)
    # Page isolate integration through the core Runtime API (post_task, call_function, shutdown hooks).
    target_link_libraries(iwn_storage PUBLIC iwn_core)
    target_compile_definitions(iwn_storage PRIVATE IWN_HAVE_CORE_RUNTIME=1)
  endif()
  target_compile_options(iwn_storage PRIVATE -Wall -Wno-unused-parameter)
  set_target_properties(iwn_storage PROPERTIES POSITION_INDEPENDENT_CODE ON)
endif()

if(NOT ANDROID)
  if(IWN_STORAGE_TOPLEVEL OR IWN_BUILD_TESTS)
    set(_iwn_storage_tests_default ON)
  else()
    set(_iwn_storage_tests_default OFF)
  endif()
  option(IWN_STORAGE_BUILD_TESTS "Build the storage host tests" ${_iwn_storage_tests_default})
  if(IWN_STORAGE_BUILD_TESTS)
    enable_testing()
    add_executable(iwn_storage_core_test test/storage_core_test.cc)
    target_link_libraries(iwn_storage_core_test PRIVATE iwn_storage_core)
    add_test(NAME iwn_storage_core_test COMMAND iwn_storage_core_test)
    # Crash-durability helper: writes, then _exit()s without a clean shutdown.
    add_executable(iwn_kv_crash_helper test/kv_crash_helper.cc)
    target_link_libraries(iwn_kv_crash_helper PRIVATE iwn_storage_core)
    target_compile_definitions(iwn_storage_core_test PRIVATE IWN_KV_CRASH_HELPER="$<TARGET_FILE:iwn_kv_crash_helper>")
  endif()
endif()
