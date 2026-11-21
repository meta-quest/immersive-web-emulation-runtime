# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# runtime/app: libiwernative.so, the library the template APK's NativeActivity loads (android.app.lib_name).
# Links the core and every registered native module; writes apk-libs.txt listing the shared libraries the APK
# must carry (this library, libv8android.so, libc++_shared.so, plus anything modules add with
#   set_property(GLOBAL APPEND PROPERTY IWN_APK_LIBS /abs/path/libfoo.so)).

add_library(iwernative SHARED
  src/android_main.cc
  src/apk_assets.cc
  "${IWN_MODULE_REGISTRY_SOURCE}"
)
target_include_directories(iwernative PRIVATE src)
target_compile_options(iwernative PRIVATE ${IWN_WARNINGS})
target_link_libraries(iwernative PRIVATE iwn_core ${IWN_NATIVE_MODULE_TARGETS} android log)
target_link_options(iwernative PRIVATE
  "-Wl,-z,max-page-size=16384"            # PKG-3: 16 KB page alignment of LOAD segments
  "-Wl,--gc-sections"
  "-Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/src/exports.map")
set_target_properties(iwernative PROPERTIES LINK_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/exports.map")

# libc++_shared.so from the NDK the build uses (V8 was built against the NDK libc++ ABI).
set(_sysroot_lib "${CMAKE_ANDROID_NDK}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android")
if(NOT CMAKE_ANDROID_NDK AND ANDROID_NDK)
  set(_sysroot_lib "${ANDROID_NDK}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android")
endif()
get_property(_extra_libs GLOBAL PROPERTY IWN_APK_LIBS)
string(REPLACE ";" "\n" _extra_lines "${_extra_libs}")
file(GENERATE OUTPUT "${CMAKE_BINARY_DIR}/apk-libs.txt" CONTENT
"$<TARGET_FILE:iwernative>
${IWN_V8_DIR}/lib/arm64-v8a/libv8android.so
${_sysroot_lib}/libc++_shared.so
${_extra_lines}
")

# JS-1: the libc++ ABI of everything in the APK must be the NDK's (std::__ndk1), not Chromium's (std::__Cr). A
# mismatched V8 or module build fails here, before it reaches a device.
if(CMAKE_NM)
  add_custom_command(TARGET iwernative POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -DNM=${CMAKE_NM}
            "-DLIBS=$<TARGET_FILE:iwernative>;${IWN_V8_DIR}/lib/arm64-v8a/libv8android.so"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/../cmake/abi-check.cmake"
    COMMENT "JS-1 libc++ ABI check (llvm-nm: __ndk1 present, __Cr absent)"
    VERBATIM)
else()
  message(WARNING "CMAKE_NM not set: the JS-1 libc++ ABI check is skipped")
endif()
