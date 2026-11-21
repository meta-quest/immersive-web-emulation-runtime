# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# runtime/xr: OpenXR session, the XR frame loop and IWER host mode's frame record.
# Spec: docs/spec/08 (XR-*), 09 (XRF-*), 10 (IN-*), DBG-SHOT, GL-PERF-5.
#
# Targets
#   iwn_xr_core           V8-free, OpenXR-call-free: frame record + layout, the composition-layer buffer, depth
#                         record, input mapping, pacing, perf-level and session policies, runtime-permission order,
#                         config, PNG writer, XR/JS thread handoff, the anchors' slot table. Android + host.
#   iwn_openxr_loader     Android: the Khronos OpenXR loader built from source (OpenXR SDK 1.1.63) + jsoncpp,
#                         static, symbols hidden.
#   iwn_xr                Android: the XR thread (instance, session, swapchains, layers, quad and cylinder layers,
#                         input, passthrough, scene, spatial anchors, environment depth, screenshots), runtime
#                         permissions + the V8 binding iwn_register_xr (JS: globalThis.__iwn.xr); with the image
#                         module, also the passthrough cameras for getUserMedia (XR-CAM-1) and their binding
#                         iwn_register_camera (JS: globalThis.__iwn.camera).
#   iwn_xr_core_tests     host unit tests (ctest); iwn_xr_depth_tests: the depth record (XR-DEPTH-2).
#   iwn_xr_android_tests  host tests of src/android code that makes OpenXR calls only, against a fake runtime.
#   iwn_xr_camera_tests   host tests of the passthrough cameras (xr_camera.cc) against a fake camera service.
#   iwn_xr_record_dump    host tool: a known record written by the native writer (web/xr round-trip test).

# Third-party sources: the upstream trees under IWN_THIRD_PARTY_DIR (see THIRD_PARTY.md), -DIWN_THIRD_PARTY_DIR or
# $IWN_THIRD_PARTY_DIR; IWN_OPENXR_SDK_DIR and IWN_JSONCPP_DIR override one of them each.
set(IWN_THIRD_PARTY_DIR "$ENV{IWN_THIRD_PARTY_DIR}" CACHE PATH "Upstream third-party source trees (default: $IWN_THIRD_PARTY_DIR)")
set(IWN_OPENXR_SDK_DIR "${IWN_THIRD_PARTY_DIR}/openxr" CACHE PATH
    "Khronos OpenXR SDK 1.1.63 source tree (include/ + loader sources)")
set(IWN_JSONCPP_DIR "${IWN_THIRD_PARTY_DIR}/jsoncpp" CACHE PATH
    "jsoncpp 1.9.6 source tree (OpenXR loader manifest parsing)")
if(NOT EXISTS "${IWN_OPENXR_SDK_DIR}/include/openxr/openxr.h")
  message(FATAL_ERROR "runtime/xr: OpenXR SDK headers not found under ${IWN_OPENXR_SDK_DIR}")
endif()

add_library(iwn_xr_core STATIC
  src/core/anchors.cc
  src/core/depth_record.cc
  src/core/camera_convert.cc
  src/core/frame_record.cc
  src/core/handoff.cc
  src/core/input_map.cc
  src/core/layers.cc
  src/core/loading.cc
  src/core/pacing.cc
  src/core/perf_policy.cc
  src/core/permission_queue.cc
  src/core/png.cc
  src/core/session_policy.cc
  src/core/xr_config.cc
)
target_include_directories(iwn_xr_core PUBLIC include "${IWN_OPENXR_SDK_DIR}/include")
target_compile_options(iwn_xr_core PRIVATE ${IWN_WARNINGS})
target_link_libraries(iwn_xr_core PUBLIC iwn_core_base)
if(IWN_ANDROID)
  target_link_libraries(iwn_xr_core PUBLIC z)
else()
  find_package(ZLIB REQUIRED)
  target_link_libraries(iwn_xr_core PUBLIC ZLIB::ZLIB)
endif()

if(IWN_ANDROID)
  # --- Khronos OpenXR loader (static) --------------------------------------------------------------------------
  set(_oxr "${IWN_OPENXR_SDK_DIR}/src")
  file(GLOB _oxr_loader_sources CONFIGURE_DEPENDS "${_oxr}/loader/*.cpp" "${_oxr}/common/*.cpp" "${_oxr}/*.c"
       "${_oxr}/external/android-jni-wrappers/wrap/*.cpp")
  add_library(iwn_openxr_loader STATIC
    ${_oxr_loader_sources}
    "${_oxr}/external/jnipp/jnipp.cpp"
    "${IWN_JSONCPP_DIR}/src/lib_json/json_reader.cpp"
    "${IWN_JSONCPP_DIR}/src/lib_json/json_value.cpp"
    "${IWN_JSONCPP_DIR}/src/lib_json/json_writer.cpp"
  )
  target_include_directories(iwn_openxr_loader
    PUBLIC "${IWN_OPENXR_SDK_DIR}/include"
    PRIVATE "${_oxr}" "${_oxr}/common" "${_oxr}/loader" "${_oxr}/external/jnipp"
            "${_oxr}/external/android-jni-wrappers" "${IWN_JSONCPP_DIR}/include")
  target_compile_definitions(iwn_openxr_loader PRIVATE
    XR_OS_ANDROID XR_USE_PLATFORM_ANDROID XR_KHR_LOADER_INIT_SUPPORT DISABLE_STD_FILESYSTEM)
  # Hidden symbols: the app library exports only ANativeActivity_onCreate anyway (runtime/app exports.map).
  target_compile_options(iwn_openxr_loader PRIVATE -fvisibility=hidden -fvisibility-inlines-hidden -fexceptions
    -Wno-unused-parameter -Wno-deprecated-declarations -Wno-unused-variable -Wno-unused-function)
  target_link_libraries(iwn_openxr_loader PUBLIC android log dl)

  # --- the XR module -------------------------------------------------------------------------------------------
  add_library(iwn_xr STATIC
    src/android/egl_xr.cc
    src/android/xr_anchors.cc
    src/android/jni_android.cc
    src/android/xr_depth.cc
    src/android/xr_system.cc
    src/android/xr_input.cc
    src/android/xr_layers.cc
    src/android/xr_loading.cc
    src/android/xr_permissions.cc
    src/android/xr_scene.cc
    src/android/xr_shot.cc
    src/v8/xr_anchors_binding.cc
    src/v8/xr_binding.cc
  )
  target_include_directories(iwn_xr PRIVATE src)
  target_compile_definitions(iwn_xr PRIVATE XR_USE_PLATFORM_ANDROID XR_USE_GRAPHICS_API_OPENGL_ES
    IWN_RUNTIME_VERSION="${IWN_RUNTIME_VERSION}")
  target_compile_options(iwn_xr PRIVATE ${IWN_WARNINGS} -fno-rtti)
  target_link_libraries(iwn_xr PUBLIC iwn_xr_core iwn_core iwn::v8 iwn_openxr_loader iwn_gl EGL GLESv3 android log)
  # The loading screen decodes the app's splash PNG with the image module's decoder (AImageDecoder / stb).
  if(TARGET iwn_image_core)
    target_link_libraries(iwn_xr PRIVATE iwn_image_core)
    target_compile_definitions(iwn_xr PRIVATE IWN_XR_HAVE_IMAGE=1)
  endif()
  # The passthrough cameras (XR-CAM-1): frames are image-module pixel stores, so they need its V8 binding.
  if(TARGET iwn_image_v8)
    target_sources(iwn_xr PRIVATE src/android/xr_camera.cc src/v8/camera_binding.cc)
    target_link_libraries(iwn_xr PRIVATE iwn_image_v8 camera2ndk mediandk)
    set_property(GLOBAL APPEND PROPERTY IWN_NATIVE_MODULES "camera:iwn_xr")
  endif()
endif()

iwn_add_host_test(iwn_xr_core_tests
  SOURCES test/host/xr_core_test.cc
  LIBS iwn_xr_core)

# XR-thread code of src/android that makes OpenXR calls only (the scene model, spatial anchors), against a fake runtime that behaves
# as Meta's does where that code depends on it (test/host/fake_openxr.h).
iwn_add_host_test(iwn_xr_android_tests
  SOURCES test/host/xr_android_test.cc test/host/fake_openxr.cc src/android/xr_scene.cc src/android/xr_anchors.cc
  LIBS iwn_xr_core)
if(TARGET iwn_xr_android_tests)
  target_include_directories(iwn_xr_android_tests PRIVATE src)
endif()

iwn_add_host_test(iwn_xr_depth_tests
  SOURCES test/host/xr_depth_test.cc
  LIBS iwn_xr_core)

# The passthrough cameras (xr_camera.cc) against a fake camera service that behaves as Horizon OS's where that code
# depends on it (test/host/fake_camera.h); test/host/fake_ndk stands in for the NDK camera headers and the JNI broker.
if(TARGET iwn_image_core)
  iwn_add_host_test(iwn_xr_camera_tests
    SOURCES test/host/xr_camera_test.cc test/host/fake_camera.cc src/android/xr_camera.cc
    LIBS iwn_xr_core iwn_image_core)
  if(TARGET iwn_xr_camera_tests)
    target_include_directories(iwn_xr_camera_tests BEFORE PRIVATE test/host/fake_ndk)
    target_include_directories(iwn_xr_camera_tests PRIVATE src)
  endif()
endif()

if(IWN_BUILD_TESTS AND NOT IWN_ANDROID)
  add_executable(iwn_xr_record_dump test/host/record_dump_main.cc)
  target_link_libraries(iwn_xr_record_dump PRIVATE iwn_xr_core)
endif()
