# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# libiwn_devtest.so: the net + storage device test (see devtest_main.cc). Android arm64 only; built by build-apk.sh.

cmake_minimum_required(VERSION 3.22)
project(iwn_devtest LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(IWN_V8_DIR "$ENV{IWN_V8_DIR}" CACHE PATH "Prebuilt V8")
add_library(iwn_v8 SHARED IMPORTED GLOBAL)
set_target_properties(iwn_v8 PROPERTIES
  IMPORTED_LOCATION "${IWN_V8_DIR}/lib/arm64-v8a/libv8android.so"
  INTERFACE_INCLUDE_DIRECTORIES "${IWN_V8_DIR}/include"
  INTERFACE_COMPILE_DEFINITIONS "V8_GN_HEADER")

add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../.. net)
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../../../storage storage)

add_library(iwn_devtest SHARED devtest_main.cc)
target_link_libraries(iwn_devtest PRIVATE iwn_net iwn_storage iwn_v8 android log)
target_link_options(iwn_devtest PRIVATE -Wl,--no-undefined -u ANativeActivity_onCreate)
