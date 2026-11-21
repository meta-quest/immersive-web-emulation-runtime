# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# JS-1 CI symbol check, run with cmake -P: -DNM=<llvm-nm> -DLIBS=<lib1;lib2;...>
# Fails if a library's dynamic symbol table names Chromium's libc++ namespace (std::__Cr) or, for a library that
# uses libc++ at all, lacks the NDK's (std::__ndk1).
foreach(lib IN LISTS LIBS)
  if(NOT EXISTS "${lib}")
    message(FATAL_ERROR "abi-check: ${lib} does not exist")
  endif()
  execute_process(COMMAND "${NM}" -D "${lib}" OUTPUT_VARIABLE syms RESULT_VARIABLE rc ERROR_VARIABLE err)
  if(NOT rc EQUAL 0)
    message(FATAL_ERROR "abi-check: ${NM} -D ${lib} failed: ${err}")
  endif()
  string(REGEX MATCHALL "__Cr" cr "${syms}")
  string(REGEX MATCHALL "__ndk1" ndk "${syms}")
  list(LENGTH cr n_cr)
  list(LENGTH ndk n_ndk)
  get_filename_component(name "${lib}" NAME)
  if(n_cr GREATER 0)
    message(FATAL_ERROR "abi-check: ${name} has ${n_cr} std::__Cr symbols (Chromium libc++ ABI); "
                        "rebuild it against the NDK libc++ (JS-1)")
  endif()
  if(n_ndk EQUAL 0)
    message(FATAL_ERROR "abi-check: ${name} has no std::__ndk1 symbols; expected the NDK libc++ ABI (JS-1)")
  endif()
  message(STATUS "abi-check: ${name}: ${n_ndk} __ndk1, 0 __Cr")
endforeach()
