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

## runtime/image + web/image

Shipped in the runtime library (Android arm64):

| component | version | license | source | used for |
|---|---|---|---|---|
| Android `AImageDecoder` (libjnigraphics, system library) | API 30+ (resolved with `dlopen`) | part of the OS | Android NDK `<android/imagedecoder.h>` | primary decoder on device: PNG, JPEG (incl. CMYK/YCCK), GIF, WebP, BMP, ICO, HEIF; AVIF only partly on Horizon OS (measured 2026-10-20: a plain 8-bit 4:2:0 file decodes, files with an sRGB colour box or alpha + irot fail and are reported as unsupported) |
| stb_image | 2.30 | MIT or public domain (Unlicense), choice | github.com/nothings/stb @ 2e2bef463a5b53ddf8bb788e25da6b8506314c08, `stb_image.h` (`$IWN_THIRD_PARTY_DIR/stb` or CMake `IWN_STB_DIR`) | fallback decoder (PNG, JPEG, GIF, BMP) for formats/devices without AImageDecoder, and the host test decoder. Built with `STBI_NO_STDIO`, no HDR/PSD/TGA/PIC/PNM, zeroed allocations |
| Skia `SkParseEncodedOrigin.cpp` (adapted from) | skia @ 3f8fc145ba678f3bd47af50f8fb51bcde474ef9c (milestone 103) | BSD-3-Clause (Copyright 2018 / 2011 Google Inc.; notice kept in `runtime/image/src/format.cc`, must also appear in the APK's notices) | skia.googlesource.com/skia `src/codec/SkParseEncodedOrigin.cpp` (the notice is read from `$IWN_THIRD_PARTY_DIR/skia/LICENSE`) | `TiffIfdOrientation`/`ReadTiffOrientation` in `runtime/image/src/format.cc` are adapted from its `parse_encoded_origin`/`SkParseEncodedOrigin` (same structure and acceptance rules: SHORT, count 1, value 1..8, IFD0 or the Exif sub-IFD), so the EXIF orientations accepted here match the OS decoder (Skia) |

Host builds only (tests, headless), not shipped by default on Android (`IWN_IMAGE_WITH_WEBP=OFF` there):

| component | version | license | source | used for |
|---|---|---|---|---|
| libwebp (+ demux, sharpyuv) | 1.4.0 | BSD-3-Clause (+ patent grant in PATENTS) | libwebp-1.4.0.tar.gz from storage.googleapis.com/downloads.webmproject.org/releases/webp (github.com/webmproject/libwebp v1.4.0; `$IWN_THIRD_PARTY_DIR/libwebp` or CMake `IWN_LIBWEBP_DIR`) | WebP decode on the host (lossy, lossless, alpha, first animation frame); its encoder generates WebP test inputs |

Test only (not shipped):

| component | version | license | source | used for |
|---|---|---|---|---|
| lodepng | master @ 18964554bc769255401942e0e6dfd09f2fab2093 | zlib | github.com/lvandeve/lodepng (`$IWN_THIRD_PARTY_DIR/lodepng` or `IWN_LODEPNG_DIR`) | PNG encoder for every colour type / depth / interlace, and the reference PNG decoder the decode results are compared with |
| stb_image_write | 1.16 | MIT or public domain, choice | `stb_image_write.h` of the same stb tree as stb_image | JPEG test inputs, the EXIF probe images (`runtime/image/src/android_probes.inc`, generated by `tools/gen_probes.cc`) |
| libjpeg-turbo (libjpeg API, C sources, no SIMD) | 2.1.6 (2.1.x branch @ fbc8460eb71afa7eac79f5c2a66fbae545981545) | IJG License + BSD-3-Clause (`LICENSE.md`, `README.ijg`) | github.com/libjpeg-turbo/libjpeg-turbo, built from source by `runtime/image/CMakeLists.txt` into the test binaries only. `IWN_LIBJPEG_TURBO_DIR` (default `$IWN_THIRD_PARTY_DIR/libjpeg-turbo`) holds the source tree in `libjpeg-turbo/` and headers configured for a build without SIMD in `include/nosimd/` and `include/shared/` | IMG-1's JPEG check: reference decodes (JDCT_ISLOW + fancy upsampling, as Skia/Chromium) the decoder output must match within ±1, and generated Adobe CMYK / YCCK test files. Runs on the host and the headset |
| libjpeg-turbo test images (`testorig.jpg`, `testimgint.jpg`) | same tree | IJG / BSD-3-Clause | `$IWN_LIBJPEG_TURBO_DIR/libjpeg-turbo/testimages` | baseline and progressive JPEG inputs (read at test time, not copied) |
| libwebp `examples/test.webp`, `test_ref.ppm` | 1.4.0 | BSD-3-Clause | `examples/` of the libwebp source tree above | WebP decode compared with dwebp's reference output (read at test time) |
| libavif / libheif test samples | libavif main @ b994fe4601c62d6f98dbff295bd5c251940789b0 / libheif 1.23.4 | BSD-2-Clause / LGPL-3.0 (sample files only, pushed to the headset for an informational probe, never linked or shipped) | github.com/AOMediaCodec/libavif `tests/data/{abc_color_irot_alpha_NOirot,colors_sdr_srgb,io/kodim03_yuv420_8bpc}.avif`, github.com/strukturag/libheif `tests/data/rainbow-451x461.heic` (`$IWN_THIRD_PARTY_DIR/libavif/tests/data`, `$IWN_THIRD_PARTY_DIR/libheif/tests/data`) | "does the OS decode AVIF/HEIF" probe in `tools/device-test.sh` |
| esbuild | 0.28.2 (from web/glue's devDependencies) | MIT | npm | bundles `web/image/dist/image.js` |

Toolchain for the module's Android builds and `tools/device-test.sh`: Android NDK r30 (30.0.16248370) from
dl.google.com (`android-ndk-r30-linux.zip`, sha1 5107f898313790e449e87eee2183d9a20602dee9, the revision V8 was built
with).

Nothing from npm ships in `web/image`: ImageData, ImageBitmap, createImageBitmap, HTMLImageElement and the data:
URL/base64 parsing are written from the HTML, Fetch, Infra and WebIDL specs. The test-side PNG encoder and the
fake natives' PNG decoder (`web/image/test/helpers.ts`, `web/image/fake-natives.ts`) use Node's `node:zlib`.

## runtime/canvas2d + web/canvas2d: shipped in every APK

| component | version | license | source | used for |
|---|---|---|---|---|
| FreeType | 2.14.2 | FreeType License (FTL; dual-licensed with GPLv2, we use the FTL: credit in the app's notices) | freetype.org 2.14.2 (github.com/freetype/freetype @ f4205da14867c5387cd6a329b90ee10a6df6eeff; `$IWN_THIRD_PARTY_DIR/freetype` or CMake `IWN_FREETYPE_DIR`) | font loading (TrueType, CFF/CFF2, WOFF via its bundled zlib, WOFF2 via Brotli), unhinted glyph outlines, names/OS/2 metrics, variable-font instances, COLR v0 layers. Minimal build: TrueType + CFF drivers, sfnt, psaux/psnames/pshinter, gzip; no hinting interpreter, autofit, renderers, PNG/SVG glyphs, Type 1, BDF (`runtime/canvas2d/third_party/config/`) |
| HarfBuzz | 14.0.0 | Old MIT | github.com/harfbuzz/harfbuzz 14.0.0 (@ da69b6585cad71ff72d06d7563952cbf52b7735a; `$IWN_THIRD_PARTY_DIR/harfbuzz` or CMake `IWN_HARFBUZZ_DIR`) | text shaping (OpenType GSUB/GPOS: kerning, ligatures, marks, complex scripts) and the Unicode script/category data used for itemisation; amalgamated `harfbuzz.cc` without AAT/CFF/colour/bitmap/draw/paint (`third_party/harfbuzz.cmake`) |
| zlib (inside FreeType) | 1.3.1 | zlib License | FreeType 2.14.2 `src/gzip/` (FreeType's bundled copy; upstream zlib.net) | WOFF 1.0 font decompression (FreeType's gzip module) |
| Unicode Character Database data | Unicode 17.0.0 | Unicode License (Unicode, Inc. data files and software permission notice) | HarfBuzz's generated `src/hb-ucd-table.hh`; the bidi class ranges in `runtime/canvas2d/src/bidi.cc` are written from the UCD (DerivedBidiClass/BidiBrackets) | script and general category lookup (itemisation, bidi classes), paired brackets for the bidi algorithm |
| Brotli (decoder only) | 1.2.0 | MIT | github.com/google/brotli v1.2.0 (@ 028fb5a23661f123017c060daa546b55cf4bde29; `$IWN_THIRD_PARTY_DIR/brotli` or CMake `IWN_BROTLI_DIR`) | WOFF2 font decompression inside FreeType (CMake option `IWN_CANVAS2D_WOFF2`, default ON; ~130 KB of the module, mostly the static dictionary) |
| stb_image_write | 1.16 | MIT or public domain, choice | github.com/nothings/stb @ 2e2bef463a5b53ddf8bb788e25da6b8506314c08, `stb_image_write.h` (`$IWN_THIRD_PARTY_DIR/stb` or CMake `IWN_STB_DIR`) | PNG and JPEG encoding for `toDataURL`/`toBlob`/`convertToBlob` (file-static symbols) |
| stb_image | 2.30 | MIT or public domain, choice | `stb_image.h` of the same stb tree | decoding the PNG images inside CBDT colour-emoji strikes (`STBI_ONLY_PNG`, file-static symbols) |
| Roboto (Regular, Bold) | Google Fonts v51 (2026-02-19) | SIL Open Font License 1.1 (`runtime/canvas2d/fonts/OFL-Roboto.txt`) | npm `@expo-google-fonts/roboto@0.4.3` (the package redistributes the Google Fonts TTFs) | bundled `sans-serif` / `system-ui` face (C2D-9: Latin, Latin-1, Latin Extended, Greek, Cyrillic, Vietnamese, symbols). |
| Roboto Mono (Regular) | Google Fonts (2026) | SIL Open Font License 1.1 (`runtime/canvas2d/fonts/OFL-RobotoMono.txt`) | npm `@expo-google-fonts/roboto-mono@0.4.2` | bundled `monospace` face |

Shipping the notices (C2D-9): `runtime/canvas2d/licenses/` holds the texts (FTL with the FreeType credit line in
`NOTICE.txt`, HarfBuzz `COPYING`, Brotli MIT, zlib, stb MIT, the Unicode notice) and `runtime/canvas2d/apk-assets.json`
lists them with the bundled fonts and their OFL texts for the APK (`assets/iwn/licenses/canvas2d/`,
`assets/iwn/fonts/`); the release build copies that list into the template (`release/stage-template-assets.mjs`). The Unicode notice text is the
2016-2020 wording as distributed with the system ICU package (`/usr/share/licenses/libicu/LICENSE`); the current
wording (Unicode License v3, https://www.unicode.org/license.txt) could not be fetched from here.

Test/tooling only (not shipped): `node-api-headers` 1.9.0 (MIT, npm; headers for the Node addon the golden
tests use), `playwright-core` 1.58.2 (Apache-2.0, npm, installed outside the repo) driving Playwright's
`chrome-headless-shell` 145 (revision 1208, Playwright's browser cache) to render the Chrome goldens, and the test
fixtures `web/canvas2d/test/fixtures/roboto-latin-400-normal.woff`/`.woff2` (npm `@fontsource/roboto@5.3.0`, SIL OFL
1.1, licence file next to them) for the WOFF/WOFF2 loading test. The path
rasterizer, stroker, compositing, gradients, CSS colour/font parsing, font matching, SVG path parsing, CBLC/CBDT
parsing, the fonts.xml parser, the bidi algorithm and the PNG test codec are our own code, written from the HTML, CSS
Color 4, CSS Fonts 4, CSS Font Loading 3, Compositing and Blending 1, Filter Effects 1, SVG 2, UAX #9 (bidi), UAX #24
(scripts), OpenType and PNG specifications and the
publicly described cell-coverage rasterization technique (see `runtime/canvas2d/README.md`). Skia and CanvasKit were
considered and not used (size; see the same README).

## runtime/net + runtime/storage + web/net + web/storage

Shipped in the runtime library (Android arm64):

| component | version | license | source | used for |
|---|---|---|---|---|
| SQLite (amalgamation) | 3.53.2 | public domain | sqlite.org amalgamation 3530200, `sqlite3.{c,h}` (`$IWN_THIRD_PARTY_DIR/sqlite` or CMake `IWN_SQLITE_DIR`) | IndexedDB and Cache API backend (`runtime/storage`), built with our own flags in `runtime/storage/CMakeLists.txt` (THREADSAFE=2, no extension loading) |
| zlib (system `libz.so`) | OS | zlib | Android NDK sysroot (host: system zlib) | gzip/deflate response bodies (`runtime/net`), CRC-32 of the localStorage log (`runtime/storage`); not bundled |
| Android platform TLS/sockets (`java.net.Socket`, `javax.net.ssl` / Conscrypt, `ProxySelector`, `HttpsURLConnection` hostname verifier) | OS (API 29+) | part of the OS | called through JNI from `runtime/net/android/jni_connector.cc`; no app dex code | TLS, system trust store + network security config, SNI, hostname verification, system proxy |

Shipped in the web preludes:

| component | version | license | source | ships in | used for |
|---|---|---|---|---|---|
| web-streams-polyfill | 4.3.0 | MIT | npm, github.com/MattiasBuelens/web-streams-polyfill | `web/net/dist/net.min.js` (installed only when `ReadableStream` is missing) | WHATWG Streams for `Response.body`, `Blob.stream()` |
| indexeddbshim | 19.0.7 | MIT OR Apache-2.0 (we use MIT) | npm, github.com/indexeddbshim/IndexedDBShim | `web/storage/dist/idb.min.js` (opt-in) | IndexedDB over a WebSQL-style driver |
| typeson-registry (+ bundled typeson) | 15.0.0 (typeson 10.3.0) | MIT | npm, dependency of indexeddbshim | idb.min.js | structured clone of IndexedDB values |
| base64-arraybuffer-es6 | 3.1.0 | MIT | npm, inlined in typeson-registry's dist bundle | idb.min.js | base64 of ArrayBuffers inside typeson-registry |
| eventtargeter | 0.12.1 | MIT | npm, dependency of indexeddbshim | idb.min.js | IndexedDB event dispatch |
| sync-promise-expanded | 2.0.0 | ISC | npm, dependency of indexeddbshim | idb.min.js | indexeddbshim internals |
| websql-configurable | 4.1.0 | Apache-2.0 | npm, github.com/brettz9/node-websql (only `custom/` + `lib/websql/`, not its better-sqlite3 driver) | idb.min.js | WebSQL transaction semantics over our native driver (`web/storage/src/websql.ts`) |
| immediate | 3.3.0 | MIT | npm, dependency of websql-configurable | idb.min.js | default scheduler (we pass our own delays) |
| tiny-queue | 0.2.1 | Apache-2.0 | npm, dependency of websql-configurable | idb.min.js | transaction queue |
| noop-fn | 1.0.0 | MIT | npm, dependency of websql-configurable | idb.min.js | no-op callbacks |

indexeddbshim's npm package also declares `canvas`, `@node-static/node-static`, `better-sqlite3` (via websql-configurable)
and `argsarray` (WTFPL); none of them is bundled (installed with `--ignore-scripts`, never imported by the browser entry
points we use). One local workaround patches `IDBTransaction.prototype.__executeRequests` at install time (an upstream
race; see `web/storage/src/indexeddb.ts`).

Build/test only (not shipped): ws 8.x (MIT; WebSocket server in the web/net tests and the device test's host
servers), esbuild 0.28.2 (MIT), TypeScript 6.0.3 (Apache-2.0), Node's built-in `node:sqlite` (fake storage natives),
OpenSSL (self-signed certificate for the device TLS rejection check), Android SDK build-tools 34.0.0 + JDK `keytool`
(device test APK). Written from specifications, no library code: the HTTP/1.1 client and parser (RFC 9110/9112),
redirect handling (Fetch §4.4), RFC 6455 framing/handshake, SHA-1 (FIPS 180-4), base64 (RFC 4648), UTF-8
validation (Unicode table 3-7), the origin allowlist, the KV log format, Headers/Request/Response/fetch/
XMLHttpRequest/WebSocket (WHATWG Fetch, XHR, WebSockets), Web Storage (HTML §12) and the Cache API (Service
Workers §5).
