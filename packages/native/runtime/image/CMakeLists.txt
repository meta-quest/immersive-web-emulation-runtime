# runtime/image: image decode (AImageDecoder on Android, stb_image + libwebp as software backends), the
# createImageBitmap pixel pipeline, and the V8 binding (globalThis.__iwn.image).
#
# Targets:
#   iwn_image_core  plain C++ (no V8), host + Android
#   iwn_image_v8    the V8 binding + iwn_register_image (needs IWN_V8_INCLUDE_DIR)
#   iwn_image_tests host unit tests (ctest), built when IWN_IMAGE_BUILD_TESTS
#
# Standalone host build:   cmake -S runtime/image -B build/image-host -G Ninja && ninja -C build/image-host -j 16
# As part of runtime/:     add_subdirectory(image)  (runtime/CMakeLists.txt)
cmake_minimum_required(VERSION 3.22)
project(iwn_image LANGUAGES C CXX)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 20)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()

set(IWN_V8_DIR "$ENV{IWN_V8_DIR}" CACHE PATH "Prebuilt V8 (include/, lib/)")
# Third-party sources (upstream trees, see THIRD_PARTY.md): stb, libwebp, and the test-only lodepng, libjpeg-turbo
# and its test images, one directory each under IWN_THIRD_PARTY_DIR (-DIWN_THIRD_PARTY_DIR or $IWN_THIRD_PARTY_DIR).
set(IWN_THIRD_PARTY_DIR "$ENV{IWN_THIRD_PARTY_DIR}" CACHE PATH "Upstream third-party source trees (default: $IWN_THIRD_PARTY_DIR)")
set(IWN_STB_DIR "${IWN_THIRD_PARTY_DIR}/stb" CACHE PATH "stb (stb_image.h 2.30, stb_image_write.h)")
set(IWN_LIBWEBP_DIR "${IWN_THIRD_PARTY_DIR}/libwebp" CACHE PATH "libwebp source tree (1.4.0)")
set(IWN_LODEPNG_DIR "${IWN_THIRD_PARTY_DIR}/lodepng" CACHE PATH "lodepng (tests only)")
set(IWN_LIBJPEG_TURBO_DIR "${IWN_THIRD_PARTY_DIR}/libjpeg-turbo" CACHE PATH
    "libjpeg-turbo 2.1.x: libjpeg-turbo/ (source tree, testimages/) + include/ (no-SIMD config headers); tests only")

if(ANDROID)
  set(_iwn_image_webp_default OFF)  # AImageDecoder decodes WebP; libwebp only for API 29 fallback if wanted
  set(_iwn_image_tests_default OFF)
else()
  set(_iwn_image_webp_default ON)
  set(_iwn_image_tests_default ON)
endif()
option(IWN_IMAGE_WITH_STB "Build the stb_image software backend" ON)
option(IWN_IMAGE_WITH_WEBP "Build the libwebp software backend" ${_iwn_image_webp_default})
option(IWN_IMAGE_BUILD_TESTS "Build host unit tests" ${_iwn_image_tests_default})
option(IWN_IMAGE_V8_BINDING "Build the V8 binding" ON)
option(IWN_IMAGE_SANITIZE "Build with ASan + UBSan (host tests / fuzz smoke)" OFF)

if(IWN_IMAGE_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer -fno-sanitize-recover=undefined)
  add_link_options(-fsanitize=address,undefined)
endif()

# --- libwebp (decoder + demux; the encoder too when tests are built) ----------------------------------------------
if((IWN_IMAGE_WITH_WEBP OR IWN_IMAGE_BUILD_TESTS) AND NOT TARGET webpdemux)
  foreach(_opt ANIM_UTILS CWEBP DWEBP GIF2WEBP IMG2WEBP VWEBP WEBPINFO LIBWEBPMUX WEBPMUX EXTRAS WEBP_JS FUZZTEST)
    set(WEBP_BUILD_${_opt} OFF CACHE BOOL "" FORCE)
  endforeach()
  set(WEBP_USE_THREAD OFF CACHE BOOL "" FORCE)
  add_subdirectory(${IWN_LIBWEBP_DIR} ${CMAKE_CURRENT_BINARY_DIR}/libwebp EXCLUDE_FROM_ALL)
endif()

# --- core ----------------------------------------------------------------------------------------------------------
add_library(iwn_image_core STATIC
  src/pixels.cc
  src/transform.cc
  src/format.cc
  src/base64.cc
  src/decode.cc
  src/decoder_stb.cc
  src/decoder_webp.cc
  src/decoder_android.cc
  src/pool.cc)
target_include_directories(iwn_image_core PUBLIC include PRIVATE src)
target_compile_options(iwn_image_core PRIVATE -Wall -Wextra -Wno-unused-parameter)
set_target_properties(iwn_image_core PROPERTIES POSITION_INDEPENDENT_CODE ON)
find_package(Threads REQUIRED)
target_link_libraries(iwn_image_core PUBLIC Threads::Threads)
if(IWN_IMAGE_WITH_STB)
  target_compile_definitions(iwn_image_core PRIVATE IWN_IMAGE_WITH_STB=1)
  target_include_directories(iwn_image_core PRIVATE ${IWN_STB_DIR})
endif()
if(IWN_IMAGE_WITH_WEBP)
  target_compile_definitions(iwn_image_core PRIVATE IWN_IMAGE_WITH_WEBP=1)
  target_link_libraries(iwn_image_core PRIVATE webpdemux webp)
  target_include_directories(iwn_image_core PRIVATE ${IWN_LIBWEBP_DIR}/src)
endif()
if(ANDROID)
  # AImageDecoder is dlopen'ed (API 30+); AHardwareBuffer is in libnativewindow (API 26+).
  target_link_libraries(iwn_image_core PUBLIC nativewindow log dl)
endif()

# --- V8 binding ----------------------------------------------------------------------------------------------------
if(IWN_IMAGE_V8_BINDING AND EXISTS ${IWN_V8_DIR}/include/v8.h)
  add_library(iwn_image_v8 STATIC v8/binding.cc)
  target_include_directories(iwn_image_v8 PUBLIC include ${IWN_V8_DIR}/include)
  target_compile_definitions(iwn_image_v8 PUBLIC V8_GN_HEADER)
  target_compile_options(iwn_image_v8 PRIVATE -Wall -Wextra -Wno-unused-parameter)
  set_target_properties(iwn_image_v8 PROPERTIES POSITION_INDEPENDENT_CODE ON)
  target_link_libraries(iwn_image_v8 PUBLIC iwn_image_core)
  if(TARGET iwn_v8)
    target_link_libraries(iwn_image_v8 PUBLIC iwn_v8)  # runtime/ build: the imported libv8android.so
  endif()
  if(TARGET iwn_core)
    # Page isolate: completions go through iwn::Runtime::post_task (dropped after a reload), teardown through a
    # shutdown hook, counters through a stats provider (runtime/core/include/iwn/core/runtime.h).
    target_link_libraries(iwn_image_v8 PUBLIC iwn_core)
    target_compile_definitions(iwn_image_v8 PRIVATE IWN_HAVE_CORE_RUNTIME=1)
  endif()
  # Worker isolates: the shared per-isolate loop hooks (header only, shared with net and storage).
  if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/../net/include/iwn/loop_hooks_registry.h)
    target_include_directories(iwn_image_v8 PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../net/include)
    target_compile_definitions(iwn_image_v8 PRIVATE IWN_IMAGE_HAVE_LOOP_HOOKS=1)
  endif()
  # The module registry (runtime/cmake/registry.cmake): JS name "image", entry iwn_register_image.
  set_property(GLOBAL APPEND PROPERTY IWN_NATIVE_MODULES "image:iwn_image_v8")
endif()

# --- tests (host; the same binary also runs on a headset: tools/device-test.sh) ------------------------------------
if(IWN_IMAGE_BUILD_TESTS)
  enable_testing()
  if(NOT EXISTS ${IWN_LODEPNG_DIR}/lodepng.cpp)
    message(FATAL_ERROR "image tests need lodepng: set IWN_LODEPNG_DIR (or IWN_THIRD_PARTY_DIR)")
  endif()
  # libjpeg-turbo, built from source for the tests only (no SIMD): IMG-1's reference decodes and CMYK/YCCK files.
  set(_ljt ${IWN_LIBJPEG_TURBO_DIR}/libjpeg-turbo)
  if(EXISTS ${_ljt}/jdapimin.c AND EXISTS ${IWN_LIBJPEG_TURBO_DIR}/include/nosimd/jconfig.h)
    set(_ljt_sources jaricom jcapimin jcapistd jcarith jccoefct jccolor jcdctmgr jchuff jcinit jcmainct jcmarker
        jcmaster jcomapi jcparam jcphuff jcprepct jcsample jctrans jdapimin jdapistd jdarith jdatadst jdatasrc
        jdcoefct jdcolor jddctmgr jdhuff jdinput jdmainct jdmarker jdmaster jdmerge jdphuff jdpostct jdsample jdtrans
        jerror jfdctflt jfdctfst jfdctint jidctflt jidctfst jidctint jidctred jmemmgr jmemnobs jpeg_nbits jquant1
        jquant2 jutils jsimd_none)
    list(TRANSFORM _ljt_sources PREPEND ${_ljt}/)
    list(TRANSFORM _ljt_sources APPEND .c)
    add_library(iwn_image_libjpeg_ref STATIC ${_ljt_sources})
    target_include_directories(iwn_image_libjpeg_ref PUBLIC ${_ljt} ${IWN_LIBJPEG_TURBO_DIR}/include/nosimd
                               ${IWN_LIBJPEG_TURBO_DIR}/include/shared)
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
      target_compile_definitions(iwn_image_libjpeg_ref PRIVATE JT_ARM64)
    else()
      target_compile_definitions(iwn_image_libjpeg_ref PRIVATE JT_x86_64)
    endif()
    target_compile_definitions(iwn_image_libjpeg_ref PRIVATE "INLINE=__attribute__((always_inline))")
    target_compile_options(iwn_image_libjpeg_ref PRIVATE -w)
    set(_iwn_have_ljt 1)
  else()
    message(STATUS "iwn_image: libjpeg-turbo not found under ${IWN_LIBJPEG_TURBO_DIR}; JPEG reference tests skip")
    set(_iwn_have_ljt 0)
  endif()

  # Test images: libjpeg-turbo testimages and libwebp examples; missing data makes those tests skip.
  add_library(iwn_image_testlib STATIC tests/test_images.cc tests/test_main.cc tests/jpeg_ref.cc
              ${IWN_LODEPNG_DIR}/lodepng.cpp)
  target_include_directories(iwn_image_testlib PUBLIC tests ${IWN_LODEPNG_DIR}
                             PRIVATE ${IWN_STB_DIR} ${IWN_LIBWEBP_DIR}/src)
  target_compile_definitions(iwn_image_testlib PRIVATE
    IWN_IMAGE_TEST_DATA_LIBJPEG="${_ljt}/testimages"
    IWN_IMAGE_TEST_DATA_LIBWEBP="${IWN_LIBWEBP_DIR}/examples"
    IWN_IMAGE_HAVE_LIBJPEG_REF=${_iwn_have_ljt})
  target_link_libraries(iwn_image_testlib PUBLIC iwn_image_core webp)
  if(_iwn_have_ljt)
    target_link_libraries(iwn_image_testlib PUBLIC iwn_image_libjpeg_ref)
  endif()

  add_executable(iwn_image_tests tests/test_transform.cc tests/test_format.cc tests/test_decode.cc tests/test_pool.cc)
  target_link_libraries(iwn_image_tests PRIVATE iwn_image_testlib)
  add_test(NAME iwn_image_tests COMMAND iwn_image_tests)

  add_executable(iwn_image_fuzz_smoke tests/fuzz_smoke.cc)
  target_link_libraries(iwn_image_fuzz_smoke PRIVATE iwn_image_testlib)

  add_executable(iwn_image_bench tests/bench.cc)
  target_link_libraries(iwn_image_bench PRIVATE iwn_image_testlib)

  add_executable(iwn_image_gen_probes tools/gen_probes.cc)
  target_link_libraries(iwn_image_gen_probes PRIVATE iwn_image_testlib)

  # Device smoke test of the V8 binding: embeds V8, registers the module, runs tests/v8_smoke.js.
  if(ANDROID AND TARGET iwn_image_v8)
    add_executable(iwn_image_v8_smoke tests/v8_smoke.cc)
    target_link_libraries(iwn_image_v8_smoke PRIVATE iwn_image_v8 iwn_image_testlib
                          ${IWN_V8_DIR}/lib/arm64-v8a/libv8android.so)
  endif()
endif()
