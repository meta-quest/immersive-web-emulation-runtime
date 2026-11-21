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

## web/glue: shipped in `web/glue/dist/glue.min.js` and `web/glue/dist/glue-subtle.min.js`

| component | version | license | source | used for |
|---|---|---|---|---|
| whatwg-url | 17.3.0 | MIT | npm, github.com/jsdom/whatwg-url | `URL`, `URLSearchParams` (the URL Standard's reference implementation) |
| webidl-conversions | 8.0.1 | BSD-2-Clause | npm, dependency of whatwg-url | WebIDL argument conversion inside whatwg-url |
| punycode | 2.3.1 | MIT | npm, github.com/mathiasbynens/punycode.js | IDNA label encode/decode in the tr46 shim |
| @noble/hashes | 2.4.0 | MIT | npm, github.com/paulmillr/noble-hashes | `crypto.subtle.digest` (SHA-1, SHA-256, SHA-384, SHA-512). Only in the opt-in prelude `glue-subtle.min.js` (active with config `subtle: 'digest'`), not in `glue.min.js` |

License notices: `npm run build` writes `web/glue/dist/glue.NOTICES.txt` with the copyright and license text of
each bundled package (taken from its `node_modules/<pkg>/LICENSE*`). MIT and BSD-2-Clause require these notices
in redistributed copies, so the APK packer must ship that file next to `glue.min.js` and `glue-subtle.min.js` (for example under
`assets/licenses/`). The build also fails if the bundle contains a package or version not listed above
(`BUNDLED` in `web/glue/build.mjs`); `web/glue/package.json` pins the transitive `webidl-conversions` with an
npm `overrides` entry, so the bundled version does not depend on the lockfile.

Swapped out at build time (not shipped; replaced by small shims in `web/glue/src/shims/`, see `web/glue/build.mjs`):

| dependency of whatwg-url | version | license | why replaced |
|---|---|---|---|
| tr46 | 7.0.0 | MIT | its UTS #46 mapping table is ~240 KB minified; the shim approximates the mapping with NFKC + case folding and keeps the validity checks (WPT `toascii.json` 87/87, `urltestdata.json` 896/896 as of 2026-10-20). Measured gap: WPT `IdnaTestV2.json` 2619/2668 (98.2 %, inputs filtered as WPT's `IdnaTestV2.window.js` does; 97.7 % before the sigma/separator fixes of 2026-10-20). Of the 49 remaining failures, 39 reject a valid host (the CheckBidi approximation treats Arabic-Indic digits as RTL; code points newer than the engine's ICU data; ignored characters such as the Hangul fillers), 5 give a different encoding and 5 accept a host UTS #46 rejects; ASCII hosts are unaffected |
| @exodus/bytes | 1.16.0 | MIT | legacy multi-byte encodings (~150 KB) only matter for non-UTF-8 documents; the runtime is UTF-8 only |

Build/test only (not shipped): esbuild 0.28.2 (MIT, npm) bundles the glue; TypeScript 6.0.3 (Apache-2.0) type-checks it.

Test fixtures: `web/glue/test/fixtures/wpt-*.json` are copies of web-platform-tests `url/resources/` files
(`urltestdata.json`, `setters_tests.json`, `toascii.json`), 3-Clause BSD License
(web-platform-tests contributors), fetched 2026-10-19 from Chromium's mirror
`chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/web_tests/external/wpt/url/resources/`.

Considered and not used (size or fit): core-js-pure 3.50.0 (MIT): its URL polyfill passes only 95.2 % of
`urltestdata.json` (file: and blob: edge cases), and DOMException + structuredClone + atob/btoa cost ~44 KB
minified because core-js bundles its own ES runtime; event-target-shim 6.0.2 (MIT): no capture/bubble path
for DOM stand-ins; fast-text-encoding 1.0.6 (Apache-2.0): no `fatal`, streaming or UTF-16; text-encoding
(deprecated, large tables). These are implemented from the specs in `web/glue/src/` instead.

## runtime/gl + web/webgl: the WebGL binding (`web/webgl/dist/webgl.min.js`)

Nothing third-party ships in the binding's code: the generator, the natives, the composites, the EGL/blob-cache
code and the TypeScript binding are our own, written from the WebGL 1.0/2.0 specifications and extension
registry texts, the WebGL 2.0 IDL, OpenGL ES 3.0/3.2 and EGL 1.5 (+ the EGL/GLES extensions named in
`docs/spec/07-webgl2.md`), and the V8 embedder headers (`v8-fast-api-calls.h`, `v8-array-buffer.h`).

Inputs the generator reads (checked in where noted):

| component | version | license | source | used for |
|---|---|---|---|---|
| WebGL IDL files (`runtime/gl/gen/idl/*.idl`, checked in) | Chromium commit 754af040be824ba6308e15b8d6fa016c82f0fb8a (`gen/idl/REVISION`) | BSD-3-Clause (The Chromium Authors; webgl_rendering_context_base.idl also carries Apple's BSD-2 notice) | `chromium.googlesource.com/chromium/src/+/<rev>/third_party/blink/renderer/modules/webgl/` via `gen/fetch-idl.mjs` | the WebGL 1/2 + extension interfaces: operations, overloads, WebIDL lengths, constants |
| Khronos GLES 3.2 / gl2ext / EGL headers | NDK r30 (30.0.16248370) sysroot | Apache-2.0 / MIT (Khronos) | Android NDK (dl.google.com) | C signatures of every GLES entry point and enum values (read by the generator; compiled against) |

Build/test only (not shipped):

| component | version | license | source | used for |
|---|---|---|---|---|
| `v8-fast-api-calls.h` (`runtime/gl/test/node-addon/v8-13.6/`, checked in) | V8 13.6.233.10 | BSD-3-Clause (the V8 project authors) | `chromium.googlesource.com/v8/v8/+/refs/tags/13.6.233.10/include/` | building the host test addon against the V8 inside Node 24 (which does not ship this header) |
| Mesa (EGL + GLES 3.2, llvmpipe, surfaceless) | 26.1.1 (host system packages) | MIT | `mesa-libEGL`, `mesa-dri-drivers` RPMs | the real driver behind the host tests, three.js tests and the conformance runs |
| three | 0.181.0 | MIT | npm | integration tests (`web/webgl/test/three.test.ts`); bundled into the on-device test APK only |
| @types/three | 0.181.0 | MIT | npm | type-checking the three.js tests |
| esbuild | 0.28.2 | MIT | npm | bundles `dist/webgl.js` and the device test app |
| Khronos WebGL conformance tests (`sdk/tests`) | KhronosGroup/WebGL commit 193020cd37c3ad6aa068805ef7fb7eca187734b5 | Khronos MIT-style license (per-file headers) | `chromium.googlesource.com/external/khronosgroup/webgl/+archive/<rev>/sdk/tests.tar.gz` via `web/webgl/cts/fetch-cts.sh`, unpacked outside the repo | the GL-CTS-1 subset run by `web/webgl/cts/harness.mjs`; not checked in |
