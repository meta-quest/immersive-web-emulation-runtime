# Copyright (c) Meta Platforms, Inc. and affiliates.
# SPDX-License-Identifier: MIT
#
# @iwer/native audio module (Web Audio over Oboe/AAudio, decoders).
#
#   iwn_audio_core   plain C++ graph, decoders, contexts (no V8): host + Android
#   iwn_audio        V8 binding (iwn_register_audio); Android by default (IWN_AUDIO_V8_BINDING)
#   iwn_audio_tests  host unit/golden tests (not on Android)
#   iwn_audio_fuzz   decoder fuzz driver (host)
#   iwn_audio_node   optional Node addon (IWN_AUDIO_NODE_ADDON=ON): the same V8 binding loaded
#                    into Node 24 so web/audio tests can run JS against the real engine
#
# Standalone host build:
#   cmake -S runtime/audio -B /tmp/iwn-audio-host -G Ninja && ninja -C /tmp/iwn-audio-host -j 16
cmake_minimum_required(VERSION 3.22)
project(iwn_audio C CXX)

# Third-party sources: the upstream trees under IWN_THIRD_PARTY_DIR (see THIRD_PARTY.md), -DIWN_THIRD_PARTY_DIR or
# $IWN_THIRD_PARTY_DIR; each IWN_<X>_DIR below overrides one of them.
set(IWN_THIRD_PARTY_DIR "$ENV{IWN_THIRD_PARTY_DIR}" CACHE PATH "Upstream third-party source trees (default: $IWN_THIRD_PARTY_DIR)")
# dr_mp3 0.7.3 (mackron/dr_libs).
set(IWN_DR_LIBS_DIR "${IWN_THIRD_PARTY_DIR}/dr_libs" CACHE PATH "dr_libs (dr_mp3.h)")
# Oboe 1.9.0 (google/oboe tag 1.9.0, 03242e9e), the library-only copy JUCE 8.0.8 vendors.
set(IWN_OBOE_DIR "${IWN_THIRD_PARTY_DIR}/oboe" CACHE PATH "Oboe 1.9.0 source tree")
set(IWN_V8_DIR "$ENV{IWN_V8_DIR}" CACHE PATH "Prebuilt V8 (include/)")
# Ogg Vorbis: the Xiph reference decoder (libvorbis + libvorbisfile over libogg), BSD-3-Clause.
set(IWN_LIBOGG_DIR "${IWN_THIRD_PARTY_DIR}/libogg" CACHE PATH "libogg 1.3.5 sources")
set(IWN_LIBVORBIS_DIR "${IWN_THIRD_PARTY_DIR}/libvorbis" CACHE PATH "libvorbis sources (xiph main)")
if(ANDROID)
  set(_iwn_audio_v8_default ON)
else()
  set(_iwn_audio_v8_default OFF)
endif()
option(IWN_AUDIO_V8_BINDING "Build the V8 binding target iwn_audio" ${_iwn_audio_v8_default})

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 20)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()

set(IWN_AUDIO_DIR ${CMAKE_CURRENT_SOURCE_DIR})

option(IWN_AUDIO_SANITIZE "Build with ASan + UBSan (host tests, decoder fuzzing)" OFF)
if(IWN_AUDIO_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=undefined)
  add_link_options(-fsanitize=address,undefined)
endif()

set(IWN_AUDIO_CORE_SOURCES
  src/core.cpp
  src/param.cpp
  src/nodes.cpp
  src/graph.cpp
  src/fft.cpp
  src/resampler.cpp
  src/decode.cpp
  src/third_party_impl.c
  src/notify.cpp
  src/context.cpp
  third_party/kissfft/kiss_fft.c
  third_party/kissfft/kiss_fftr.c
)
if(ANDROID)
  list(APPEND IWN_AUDIO_CORE_SOURCES src/output_oboe.cpp src/decode_android.cpp)
else()
  list(APPEND IWN_AUDIO_CORE_SOURCES src/output_null.cpp)
endif()

# libogg + libvorbis decoder (+ vorbisfile). The encoder-side files are compiled too because
# libvorbis's block.c references them; nothing calls them.
set(_iwn_vorbis_files bitrate block codebook envelope floor0 floor1 info lookup lpc lsp mapping0 mdct
    psy registry res0 sharedbook smallft synthesis vorbisfile window analysis)
set(IWN_VORBIS_SOURCES ${IWN_LIBOGG_DIR}/src/bitwise.c ${IWN_LIBOGG_DIR}/src/framing.c)
foreach(_f IN LISTS _iwn_vorbis_files)
  list(APPEND IWN_VORBIS_SOURCES ${IWN_LIBVORBIS_DIR}/lib/${_f}.c)
endforeach()
add_library(iwn_audio_vorbis STATIC ${IWN_VORBIS_SOURCES})
target_include_directories(iwn_audio_vorbis
  PUBLIC ${IWN_LIBOGG_DIR}/include ${IWN_LIBVORBIS_DIR}/include
  PRIVATE ${IWN_LIBVORBIS_DIR}/lib)
target_compile_options(iwn_audio_vorbis PRIVATE -w)
if(IWN_AUDIO_SANITIZE)
  # libogg/libvorbis do int bit shifts UBSan reports (benign on our compilers); keep ASan on them.
  target_compile_options(iwn_audio_vorbis PRIVATE -fno-sanitize=undefined)
endif()
set_target_properties(iwn_audio_vorbis PROPERTIES POSITION_INDEPENDENT_CODE ON)
if(NOT ANDROID)
  target_link_libraries(iwn_audio_vorbis PUBLIC m)
endif()

add_library(iwn_audio_core STATIC ${IWN_AUDIO_CORE_SOURCES})
target_include_directories(iwn_audio_core
  PUBLIC ${IWN_AUDIO_DIR}/include
  PRIVATE ${IWN_AUDIO_DIR}/src ${IWN_AUDIO_DIR}/third_party/kissfft
          ${IWN_DR_LIBS_DIR})
set_target_properties(iwn_audio_core PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_options(iwn_audio_core PRIVATE
  $<$<COMPILE_LANGUAGE:CXX>:-Wall -Wextra -Wno-unused-parameter>
  $<$<COMPILE_LANGUAGE:C>:-w>)
find_package(Threads REQUIRED)
target_link_libraries(iwn_audio_core PUBLIC Threads::Threads PRIVATE iwn_audio_vorbis)

if(ANDROID)
  if(NOT TARGET oboe)
    add_subdirectory(${IWN_OBOE_DIR} ${CMAKE_BINARY_DIR}/third_party/oboe)
  endif()
  target_include_directories(iwn_audio_core PRIVATE ${IWN_OBOE_DIR}/include)
  target_link_libraries(iwn_audio_core PUBLIC oboe mediandk log)
endif()

# ---- V8 binding -------------------------------------------------------------------------------
# iwn_audio is the module target the runtime registry picks up (iwn_<dir> convention). With the core
# present (Android runtime build) it also wires host hooks, the shutdown hook and the stats section
# through iwn::Runtime.
if(IWN_AUDIO_V8_BINDING AND EXISTS ${IWN_V8_DIR}/include/v8.h)
  add_library(iwn_audio STATIC src/binding_v8.cpp)
  target_include_directories(iwn_audio PRIVATE ${IWN_AUDIO_DIR}/src)
  target_compile_definitions(iwn_audio PUBLIC IWN_WITH_V8)
  if(TARGET iwn::v8)
    target_link_libraries(iwn_audio PUBLIC iwn::v8)
  else()
    target_include_directories(iwn_audio PRIVATE ${IWN_V8_DIR}/include)
    target_compile_definitions(iwn_audio PRIVATE V8_GN_HEADER)
  endif()
  if(TARGET iwn::core)
    target_link_libraries(iwn_audio PRIVATE iwn::core)
    target_compile_definitions(iwn_audio PRIVATE IWN_AUDIO_WITH_CORE)
  endif()
  target_link_libraries(iwn_audio PUBLIC iwn_audio_core)
  set_target_properties(iwn_audio PROPERTIES POSITION_INDEPENDENT_CODE ON)
endif()

# ---- host-only targets --------------------------------------------------------------------------
if(NOT ANDROID)
  add_executable(iwn_audio_tests test/test_main.cpp test/test_graph.cpp test/test_decode.cpp
                                 test/test_context.cpp test/test_regressions.cpp)
  target_include_directories(iwn_audio_tests PRIVATE ${IWN_AUDIO_DIR}/src ${IWN_AUDIO_DIR}/test)
  target_link_libraries(iwn_audio_tests PRIVATE iwn_audio_core)
  target_compile_definitions(iwn_audio_tests PRIVATE
    IWN_AUDIO_FIXTURES="${IWN_AUDIO_DIR}/test/fixtures")
  add_test(NAME iwn_audio_tests COMMAND iwn_audio_tests)

  add_executable(iwn_audio_fuzz test/fuzz_decode.cpp)
  target_include_directories(iwn_audio_fuzz PRIVATE ${IWN_AUDIO_DIR}/src)
  target_link_libraries(iwn_audio_fuzz PRIVATE iwn_audio_core)

  option(IWN_AUDIO_NODE_ADDON "Build the Node addon for JS-against-native tests" OFF)
  if(IWN_AUDIO_NODE_ADDON)
    if(NOT NODE_INCLUDE_DIR)
      message(FATAL_ERROR "set NODE_INCLUDE_DIR to <node prefix>/include/node")
    endif()
    add_library(iwn_audio_node MODULE src/binding_v8.cpp host-node/addon.cpp)
    target_include_directories(iwn_audio_node PRIVATE ${IWN_AUDIO_DIR}/src ${NODE_INCLUDE_DIR})
    target_compile_definitions(iwn_audio_node PRIVATE IWN_WITH_V8 IWN_NODE_ADDON)
    target_link_libraries(iwn_audio_node PRIVATE iwn_audio_core)
    set_target_properties(iwn_audio_node PROPERTIES PREFIX "" SUFFIX ".node")
    target_link_options(iwn_audio_node PRIVATE -Wl,--unresolved-symbols=ignore-all)
  endif()
endif()
