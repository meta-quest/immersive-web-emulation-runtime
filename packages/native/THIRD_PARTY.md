# Third-party components in @iwer/native

The established libraries each part of the package uses: name, version, license, source, what ships. Sections
follow the package areas. Sources are named by upstream project, version and URL. The native libraries built from
source are read from one directory per project under `IWN_THIRD_PARTY_DIR` (named in the row as
`$IWN_THIRD_PARTY_DIR/<dir>`), or from the CMake variable given next to it.

## runtime/core + runtime/app: shipped in every APK

| component | version | license | source | used for |
|---|---|---|---|---|
| V8 (`libv8android.so`, `snapshot_blob.bin`, headers) | 15.5.35.25 (+ local BUILD.gn patch that links `v8android` as one shared library) | BSD-3-Clause (V8), with bundled ICU (Unicode License V3) and other V8 third-party code under their own licenses (see V8's `LICENSE`/`LICENSE.*`) | prebuilt for Android arm64 from the 15.5.35.25 tag (pointer compression on, sandbox off, NDK libc++); upstream chromium.googlesource.com/v8/v8 | the JS engine, inspector (CDP), code cache, ICU (`Intl`) |
| LLVM libc++ (`libc++_shared.so`) | Android NDK r30 (30.0.16248370) | Apache-2.0 WITH LLVM-exception | Android NDK sysroot | C++ standard library for the runtime and V8 (same ABI V8 was built against) |

Statically linked into `libv8android.so`, so every APK ships these. Revisions are the pins in V8 15.5.35.25's
`DEPS` (chromium.googlesource.com/v8/v8/+/refs/tags/15.5.35.25/DEPS). Presence was confirmed with `llvm-nm -C` on
`lib.unstripped/arm64-v8a/libv8android.so`; symbol counts are in brackets.

| component | version | license | source | used for |
|---|---|---|---|---|
| ICU | 78 (`icu_78` symbols; chromium/deps/icu @ 6ebb40c594776cc2c21ea14df85a2a89a328b364), data built in (`icu_use_data_file = false`) | Unicode-3.0 (plus ICU's bundled third-party data licenses in its `LICENSE`) | chromium.googlesource.com/chromium/deps/icu | `Intl`, `Intl.Segmenter` (JS-6), case mapping [7170] |
| Abseil (abseil-cpp) | chromium/src/third_party/abseil-cpp @ 435e7d977fb36fb47854a4c552c0706dad0bd7cf | Apache-2.0 | chromium.googlesource.com/chromium/src/third_party/abseil-cpp | V8 internals (containers, hashing) [2059 `absl::`] |
| simdutf | chromium/src/third_party/simdutf @ f7356eed293f8208c40b3c1b344a50bd70971983 | Apache-2.0 OR MIT | chromium.googlesource.com/chromium/src/third_party/simdutf | UTF-8/16 validation and transcoding in V8 [188] |
| fast_float | github.com/fastfloat/fast_float @ 34164f547b7df3f5d794ff67e9f885c36819ebfc (Chromium mirror) | Apache-2.0 OR MIT OR BSL-1.0 | chromium.googlesource.com/external/github.com/fastfloat/fast_float | string to number parsing [20] |
| dragonbox | github.com/jk-jeon/dragonbox @ beeeef91cf6fef89a4d4ba5e95d47ca64ccb3a44 (Chromium mirror) | Apache-2.0 WITH LLVM-exception OR BSL-1.0 | chromium.googlesource.com/external/github.com/jk-jeon/dragonbox | number to shortest string [2] |
| FP16 | github.com/Maratyszcza/FP16 @ 782eea126dc5c755827be751a099eb01826175cf (Chromium mirror) | MIT | chromium.googlesource.com/external/github.com/Maratyszcza/FP16 | `Float16Array`, `Math.f16round` conversions [11] |
| zlib (Chromium's fork) | chromium/src/third_party/zlib @ 285e94b8fa95ad3b7d16b80798ec8dce6febb8c8 | Zlib (Chromium's optimisations BSD-3-Clause) | chromium.googlesource.com/chromium/src/third_party/zlib | V8 compression (snapshot/compressed data) [41 `Cr_z_*`] |
| fdlibm (V8's port in `src/base/ieee754.cc`) | as in V8 15.5.35.25 | Sun Microsystems permissive notice (V8's `LICENSE.fdlibm`) | V8 tree | `Math.*` transcendental functions [48 `ieee754`] |
| LLVM libc (correctly rounded math, namespace `__llvm_libc_cr`) | github.com/llvm/llvm-project/libc @ 43a9a99ce4b5a04954090f8a0e74bf2786f59379 (Chromium mirror, V8 `DEPS` `third_party/llvm-libc/src`) | Apache-2.0 WITH LLVM-exception | chromium.googlesource.com/external/github.com/llvm/llvm-project/libc | `Math.*` functions V8 routes to LLVM libc's correctly rounded implementations (e.g. `asin`) [78 `__llvm_libc`] |
| inspector_protocol (crdtp) | chromium/deps/inspector_protocol @ c0045057ce801744c5e88596a2f1bab1802e39f0 (V8's `third_party/inspector_protocol/README.v8`) | BSD-3-Clause (its own `LICENSE`, Copyright 2016 The Chromium Authors) | chromium.googlesource.com/deps/inspector_protocol (vendored in the V8 tree) | CDP message encoding/dispatch inside V8's inspector [571 `crdtp`] |
| DFA UTF-8 Decoder (Bjoern Hoehrmann; V8's `third_party/utf8-decoder`) | 2010-06-25, vendored in V8 15.5.35.25 | MIT (its own `LICENSE`, Copyright (c) 2008-2009 Bjoern Hoehrmann) | V8 tree; bjoern.hoehrmann.de/utf-8/decoder/dfa/ | UTF-8 decoding in V8 [`Utf8DfaDecoder`, `GeneralizedUtf8DfaDecoder`] |
| SHA-256 (V8's `src/utils/sha-256.{h,cc}`, from the Google Omaha installer for Windows) | as in V8 15.5.35.25 | Apache-2.0 (file header: Copyright 2013 Google Inc.) | V8 tree (chromium.googlesource.com/v8/v8/+/refs/tags/15.5.35.25/src/utils/sha-256.h) | SHA-256 used inside V8 [`v8::internal::SHA256_hash`, `SHA256_init/update/final`, `SHA256_VTAB`] |
| rapidhash (V8's `third_party/rapidhash-v8`, Nicolas De Carli, based on wyhash) | Nicoshev/rapidhash @ 588978411df8683777429f729be5213eb1bfd5f3 (V8's `README.chromium`) | BSD-2-Clause (binary redistributions must reproduce the notice) | github.com/Nicoshev/rapidhash, vendored in the V8 tree | string hashing and the hash seed (`src/strings/string-hasher.cc`, `src/numbers/hash-seed.cc`); header-only, inlined |
| Highway (Google SIMD library, `//third_party/highway:libhwy` in `v8_base`) | google/highway @ 2607d3b5b0113992fe84d3848859eae13b3b52c1 (V8 `DEPS`) | Apache-2.0 OR BSD-3-Clause | chromium.googlesource.com/external/github.com/google/highway | SIMD in V8's string hasher, JSON parser/stringifier, unicode and regexp code (inlined) |
| cpu_features (Google, via Chromium's zlib `//third_party/cpu_features:ndk_compat` on Android) | v0.11.0 (google/cpu_features @ 81d13c49649f0714dd41fb56bb246398b6584085) | Apache-2.0 (the `ndk_compat` layer: BSD-2-Clause, Copyright 2010 The Android Open Source Project) | chromium.googlesource.com/external/github.com/google/cpu_features | CPU feature detection for zlib's SIMD paths [`GetAarch64Info`, `CpuFeatures_*`] |
| HalfSipHash (V8's `third_party/siphash`) | as in V8 15.5.35.25 | CC0-1.0 | github.com/veorq/SipHash, vendored in the V8 tree | `third_party/siphash/halfsiphash.cc` in `v8_base` (hashing) |
| LLVM libunwind (from the NDK toolchain V8 was linked with) | NDK r30 runtime | Apache-2.0 WITH LLVM-exception | Android NDK | `_Unwind_Backtrace`/`_Unwind_GetIP` for V8's stack traces [static `t` symbols] |

Build/test only (not shipped): Android SDK build-tools 35.0.0 (`aapt2`, `zipalign`, `apksigner.jar`, Apache-2.0),
platform `android-34` `android.jar`, OpenJDK 17 (GPL-2.0 with Classpath Exception) to run apksigner, OpenSSL
(debug signing key), Info-ZIP `zip`, CMake/Ninja. No other library code: SHA-1/SHA-256/base64, the 128-bit
code-cache hash (own design: multiply-rotate lanes with the round and primes from the public xxHash64 format
specification (BSD-2-Clause document), a different finalisation; no code copied), JSON, the URL subset, the HTML tag scanner and the WebSocket/HTTP server in `runtime/core/src/base/` are written from FIPS 180-4,
RFC 4648, RFC 8259, the WHATWG URL/HTML/Fetch standards and RFC 6455/9110.
