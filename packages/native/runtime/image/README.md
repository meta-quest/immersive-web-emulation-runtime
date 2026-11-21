# runtime/image + web/image: image decode, `Image`, `ImageBitmap`, `createImageBitmap`

The image module of `@iwer/native`. Decodes images off the JS thread and gives the bundle the browser image surface:
`HTMLImageElement` / `Image()` (`src`, `onload`/`onerror`, `decode()`, `naturalWidth/Height`, `complete`,
`crossOrigin` stored and ignored), `createImageBitmap` (Blob, ImageData, ImageBitmap, HTMLImageElement, canvases;
options `imageOrientation`, `premultiplyAlpha`, `colorSpaceConversion`, `resizeWidth/Height/Quality`, source
rectangle), `ImageBitmap` (`close()`, clone/transfer hooks) and `ImageData`. Sources: `data:` URLs, `blob:` URLs
(the glue's blob URL store) and fetch (APK assets, allowlisted network).

Spec requirements implemented (docs/spec/06-images-canvas2d.md and others): IMG-1, IMG-2, IMG-3, IMG-4, IMG-5,
IMG-6, IMG-7, PROC-2 (decode never on the JS thread), PROC-7/PROC-8 (teardown, reload releases the old page),
NET-12 (images), NET-14/15 (blob: images), GL-16/GL-17 (the source contract for WebGL: INTEROP.md), WRK-5
(structuredClone of ImageBitmap/ImageData through the glue), REG-14 (WebP), REG-16 (no main-thread decode, data:
URLs included). Status per requirement: see "Checks" below.

## Layout

```
runtime/image/
  include/iwn/image/pixels.h      PixelStore: RGBA8, stride, alpha mode; heap or AHardwareBuffer backed
  include/iwn/image/transform.h   the createImageBitmap pixel pipeline (orientation, crop, resize, flipY, alpha)
  include/iwn/image/decode.h      sniffing, EXIF orientation, decoder backends, Decode()
  include/iwn/image/pool.h        decode thread pool, cross-isolate transfer registry
  include/iwn/image/v8_binding.h  iwn_register_image + ConfigureBinding/DisposeIsolate + GetPixelStore/WrapPixelStore
  src/                            plain C++ (no V8): host-testable
  v8/binding.cc                   the thin V8 layer (globalThis.__iwn.image)
  tests/                          host unit tests (also run on a headset), fuzz smoke, bench, V8 device smoke
  tools/device-test.sh            runs all of it on a headset over adb; tools/gen_probes.cc makes src/android_probes.inc
  INTEROP.md                      contract with WebGL (texImage2D), Canvas 2D, workers, DOM, event loop
web/image/
  natives.ts      the JS view of __iwn.image (the contract)          fake-natives.ts  TS implementation for Node
  env.ts          dependencies (glue registry, fetch, DOMException)   install.ts       installImage(global)
  image-data.ts   ImageData                                           image-bitmap.ts  ImageBitmap + clone/transfer
  html-image-element.ts  HTMLImageElement, Image()                    create-image-bitmap.ts
  load.ts         data:/blob:/fetch loading                           source.ts, tex-source.ts  image-source protocol
  entry.ts, build.mjs  -> dist/image.js (IIFE, 22 KB minified, 7 KB gzip), evaluated after web/glue's bundle
```

## Design

- **Decoders.** On device: Android `AImageDecoder` (NDK, API 30+), resolved with `dlopen` so the library loads on
  the template's minSdk 29; it decodes PNG, JPEG (incl. Adobe CMYK/YCCK), GIF (first frame), WebP, BMP, ICO and
  HEIF. AVIF works only partly on Horizon OS (measured 2026-10-20): a plain 8-bit 4:2:0 file decodes, files
  with an sRGB colour box or alpha + irot fail inside `AImageDecoder_decodeImage` and are reported as
  `unsupported`. IMG-1 does not require AVIF; `BindingConfig::allow_os_formats` (default true: open question)
  decides whether HEIF/AVIF are attempted at all. stb_image 2.30 is the fallback (and libwebp 1.5.0 on the host).
  Formats are sniffed from bytes; the response MIME type is ignored. Colour values are not converted (no colour
  management, as IMG-6 documents). JPEGs cut before their end-of-image marker fail on every backend (stb would
  return the missing part as grey; it now requires the marker, as AImageDecoder does). A JPEG whose scan data is
  short but still ends with the marker is not caught by that check: if it is shorter than the size bound below it
  fails as corrupt, otherwise the backends decode it and fill the missing blocks with grey.
- **EXIF orientation.** Parsed here for JPEG (APP1), PNG (eXIf) and WebP (EXIF chunk), with Skia's acceptance
  rules (type SHORT, count 1, value 1..8, IFD0 or the Exif sub-IFD), so the parser and the OS decoder agree on
  which files carry an orientation. The OS decoder applies it for some formats and not others (Horizon OS: JPEG
  and WebP yes, PNG no), so the backend probes each format once at startup with tiny embedded files, and for the
  axis-swapping orientations (5-8) the decoded shape is checked against the stored size from the header. The
  pipeline composes "undo what the decoder did" with "what the caller asked" into one orientation step. `<img>`
  and `imageOrientation: 'from-image'`/`'flipY'` apply it; the legacy `'none'` ignores it for encoded sources.
- **One job per image.** Decode + orientation + source rectangle + resize + flipY + alpha conversion run as one
  job on the pool (2 threads by default: `min(2, cores - 1)`), with in-place fast paths (identity: no copy; flip
  only: row swap; alpha only: in place). Resizing works in premultiplied space (no colour bleed from transparent
  pixels); `pixelated` = nearest, `low` = bilinear, `medium` = area average, `high` = tent filter when shrinking.
- **Memory.** Pixels live outside the JS heap in `PixelStore`s, reported to V8 through
  `v8::ExternalMemoryAccounter` (IMG-7); `close()` frees them at once, GC frees dropped handles. Limits (IMG-3):
  more than 16384 px in a dimension or 256 MP (256 x 10^6 pixels) in total rejects from the header, before
  allocating; so does a PNG whose header promises more pixels than its file can hold. Decodes in flight share a
  512 MiB budget (a decode reserves its output size first and waits; a bigger one runs alone). A plain resize of a
  JPEG/WebP decodes downscaled first (by 2/4/8, still ≥ 2x the target). A superseded `<img>` load is cancelled
  (queued jobs never start).
- **Completions.** Page isolate: the core runtime's `post_task` (plus a shutdown hook and an `image` stats
  provider); workers: the shared loop hooks; otherwise `ConfigureBinding`'s `post` hook, the V8 platform's task
  runner, or JS polling. One registration state per context; a new context in the same isolate (reload) retires
  the old one without keeping its context alive. INTEROP.md §7.
- **data: URLs.** `<img src="data:...;base64,...">` hands the base64 text to the native module (decoded on the
  pool with forgiving-base64); the src setter does no work, the URL parser is skipped for data: URLs.
- **Zero copy toward GL.** Consumers get a pointer + stride view of the native store (no JS-heap copy); an optional
  AHardwareBuffer backing allows a GPU-side copy later (INTEROP.md §3).
- **Header size bounds (before any allocation).** A complete file cannot be smaller than its pixels allow, so tiny
  files with huge headers fail as `corrupt` before a decoder allocates: PNG (deflate's 1032:1 limit on the filtered
  rows), Huffman JPEG (at least 1 bit per 8x8 block per component: every block has a DC code, and progressive files
  must start each component with a DC scan; arithmetic-coded JPEGs get no bound), GIF (LZW emits at most 4096
  pixels per code of at least 2 bits, applied to the first frame, which must be complete to decode; the logical
  screen may legitimately be larger than the frame, so a small frame on a huge screen still allocates the screen).
  WebP and BMP have no cheap bound (lossless WebP and RLE BMP compress flat images arbitrarily well). The smallest
  files libjpeg-turbo writes (flat, optimised Huffman, baseline and progressive) are 2x above the JPEG bound; a
  greedy-LZW flat GIF is 13x above the GIF bound (tests). On a Quest 3S a 5.7 KB "15000²" JPEG and 29-byte
  "16000²" GIF now fail at 0 ms with no allocation (VmHWM 7 MB → 7 MB; they cost ~0.9-1 GB before).
- **Sizes from JS.** `fromPixels` checks width and height (1..32768, at most 2^28 pixels) before forming any size
  product, `PixelStore::AllocateHeap`/`AllocateHardwareBuffer` reject more than 2^28 pixels with overflow-checked
  arithmetic, and `createImageBitmap` checks a `pixels` descriptor (integer sides in the same range, a byte view of
  exactly width _ height _ 4 bytes) before calling native code. Transfer ids must be integers in 1..2^53-1.
- **Page JS calling the natives.** `globalThis.__iwn.image` is reachable from page code, so no native runs page JS
  between checking an input and using it: options are read as own data properties only (no getters, no prototype
  chain; proxies and accessor `crop` entries are rejected), `transform` takes its own reference to the pixels first,
  and `decode`/`fromPixels` read a view's offset and length only after the options, right before copying. Natives
  look up their registration by id on every call, so after `DisposeIsolate` they throw or do nothing instead of
  touching freed state. `ImageData` rejects views on resizable and shared buffers (WebIDL, as Chrome).

## Build and test

Native (host, no V8 needed for the core; the binding compiles against the V8 headers):

```bash
cmake -S runtime/image -B /tmp/image-host -G Ninja && ninja -C /tmp/image-host -j 16
/tmp/image-host/iwn_image_tests              # 53 tests: pipeline, EXIF, sniffing, PNG/JPEG(+CMYK)/WebP/GIF, limits, budget, pool
/tmp/image-host/iwn_image_fuzz_smoke 60      # mutation fuzz for N seconds (use valgrind for memory checks)
/tmp/image-host/iwn_image_bench 2048 5       # decode cost per format/options
/tmp/image-host/iwn_image_bench gen DIR && /tmp/image-host/iwn_image_bench peak DIR/big8k.jpg 1024 1024  # peak memory
```

Android arm64 (NDK r30 from dl.google.com, matching libv8android.so's libc++; `NDK=<android-ndk-r30>`), plus the
on-device run over adb:

```bash
cmake -S runtime/image -B /tmp/image-android -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-29 -DANDROID_STL=c++_shared -DIWN_IMAGE_BUILD_TESTS=ON
ninja -C /tmp/image-android -j 16
(cd web/glue && node build.mjs) && node web/image/build.mjs     # bundles for the end-to-end run
runtime/image/tools/device-test.sh <serial> /tmp/image-android  # core tests, V8 smoke, web e2e, bench
```

Third-party sources and test inputs come from the upstream trees under `IWN_THIRD_PARTY_DIR`
(`-DIWN_THIRD_PARTY_DIR=...`, default `$IWN_THIRD_PARTY_DIR`): `stb/` (stb 2.30), `libwebp/` (libwebp 1.4.0),
`lodepng/` and `libjpeg-turbo/` (layouts in THIRD_PARTY.md), or one by one with `IWN_STB_DIR`, `IWN_LIBWEBP_DIR`,
`IWN_LODEPNG_DIR` and `IWN_LIBJPEG_TURBO_DIR`. lodepng is required for the tests; without libjpeg-turbo
or the libwebp examples the tests that need them print `skip`.

As part of the whole runtime, `runtime/CMakeLists.txt` adds this directory; the module registers itself
as `image:iwn_image_v8` in `IWN_NATIVE_MODULES`.

JS (Node 24, from `packages/native`):

```bash
node --test --test-concurrency=8 web/image/test/*.test.ts     # 42 tests over fake natives (incl. the real glue bundle)
node_modules/.bin/tsc -p web/image                             # typecheck
```

These suites are not part of `packages/native`'s `npm test` (its `package.json` is shared; it runs `test/`,
`packager/test` and `compat/test` only): run the commands above, or add `web/image/test/*.test.ts` to that script.

## Checks (2026-10-20, revision 4; revision 8 additions below the table)

| requirement               | status                                                                                                                                                                                                                                    | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMG-1 decode set          | partly met: decoding done for PNG (all colour types/depths, interlaced), JPEG (baseline, progressive, Adobe CMYK and YCCK), WebP (lossy, lossless, alpha), GIF first frame                                                                | reference decodes from libjpeg-turbo 2.1.6 (built for the tests, JDCT_ISLOW + fancy upsampling as Skia/Chromium). Quest 3S (AImageDecoder): `testorig.jpg`, `testimgint.jpg`, CMYK and YCCK all **max 0** against libjpeg-turbo, so ±1 holds. Host / pre-API-30 fallback (stb_image): max 3, 1.3% of channels off by more than 1 (asserted ≤ 4 and < 3%); CMYK/YCCK max 0. PNG matches lodepng exactly; WebP vs dwebp `test_ref.ppm` max 1. PNGSuite is not available offline (github blocked): generated equivalents stand in for the PNGSuite subset the acceptance check names, so that part of the check is not met as written |
| IMG-2 bad input           | partly met: no CI fuzz job yet (the check asks for one); manual runs only                                                                                                                                                                 | truncation tests (every cut of a JPEG before its end-of-image marker fails on every backend; short scan data that still ends with the marker is only rejected when it is below the size bound); mutation fuzz on the revision 4 code: 3 x 8 min (106 M inputs, incl. the base64 decoder, header reader with the new JPEG/GIF bounds, downscale path; assertions on): no crash; valgrind 8 min (1.79 M inputs): 0 errors. Revision 3: 3 x 20 min (240 M inputs) and valgrind 10 min                                                                                                                                                 |
| IMG-3 limits              | done                                                                                                                                                                                                                                      | header-time rejection: > 16384 px per side, > 256 x 10^6 pixels; absurd PNG, Huffman JPEG and GIF headers fail before any backend runs (tests; Quest 3S peak check above). Heap/AHardwareBuffer stores capped at 2^28 pixels with overflow-checked sizes; `fromPixels` 1..32768 per side (tests on host and device)                                                                                                                                                                                                                                                                                                                |
| IMG-4 `Image`             | partly met: `new Image()` / `HTMLImageElement` done (no srcset/sizes selection, no layout); `document.createElement('img')` / `createElementNS` need DOM stand-ins that no stream provides yet, only the `createImageElement` hook exists | web tests (pending request keeps the previous image, superseded loads cancelled, data: via native base64); device e2e over glue + real module                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| IMG-5 `ImageData`         | done                                                                                                                                                                                                                                      | web tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| IMG-6 `createImageBitmap` | partly met: the API and pixel pipeline are done; `premultiplyAlpha: 'default'` premultiplies like Chrome                                                                                                                                  | pixel matrix natively and in JS. The acceptance check itself (texture read-back through a framebuffer for every imageOrientation x premultiplyAlpha pair compared with Chrome, GLTFLoader texels vs Chrome) has not run: it needs WebGL's texImage2D (INTEROP.md §3) and Chrome goldens                                                                                                                                                                                                                                                                                                                                            |
| IMG-7 external memory     | done                                                                                                                                                                                                                                      | Quest 3S: 500 dropped 1024² handles, RSS 52.1 MB → peak 244.6 MB → 52.9 MB after GC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PROC-8 reload             | done in the module                                                                                                                                                                                                                        | Quest 3S (`tests/v8_smoke.cc`): page A (8 bitmaps, 16 MB JS heap, decode in flight) then a new context in the same isolate: page A collected, bitmaps finalized, its registration freed (retired states do not accumulate), RSS 50.2 → 114.4 → 50.3 MB (revision 4 run); teardown with tasks pumped between `DisposeIsolate` and `Isolate::Dispose`: 250 handles awaiting their second pass were freed by it, no crash; the runtime-core path (`post_task`, shutdown hook) compiles in the full runtime build but the APK could not be built today (net module compile error in another stream)                                    |
| WRK-5 clone/transfer      | done same-realm                                                                                                                                                                                                                           | `web/image/test/glue-e2e.test.ts` over the real glue bundle and `tests/web_e2e.js` on the headset: structuredClone(ImageData), structuredClone(ImageBitmap), transfer detaches; worker postMessage wiring belongs to the workers stream                                                                                                                                                                                                                                                                                                                                                                                            |
| PROC-2 / REG-16           | done by construction                                                                                                                                                                                                                      | decode only on pool threads; data: URLs: the JS thread does ~1.2 ms for a 16 MiB URL (was ~390 ms of JS base64). Quest 3S decode cost on the pool (2048², noisy): JPEG 41 ms, PNG 122 ms, WebP 139 ms. Peak memory, 8192² JPEG resized to 1024²: 77 MB (314 MB full size)                                                                                                                                                                                                                                                                                                                                                          |

Revision 8 (built from stb 2.30 / libwebp 1.4.0 and the dl.google.com NDK r30): host 53/53, the same
under valgrind (0 errors), web 42/42 + tsc; Quest 3S: core 53/53, V8 smoke and web
e2e ALL PASS, including the new page-JS checks (option getters/prototype getters/proxies never run inside a native,
natives inert after `DisposeIsolate`) and the crash probes (`j7_transform_close`, `j7_frompixels_shrink`,
`j7_decode_shrink`, `j7_web_pollution`), which no longer crash. 'pixelated' resize with flipY now flips after
scaling on every path; the decode budget reserves the full size unless the backend downscales that format. No
ASan run this revision: the build machine's gcc lost its libasan runtime (`/usr/lib64/libasan.so.6.0.0` missing).

## Open items

- `UNPACK_*` handling and the GPU read-back of IMG-6 belong to the WebGL binding (contract in INTEROP.md §3).
- The AHardwareBuffer decode mode (`gpu_backed`) has never run on a device.
- The runtime-integrated completion path (`Runtime::post_task`) is compiled but not yet exercised in an APK.
- Embedder data tag allocation across modules (V8 15.5 allows 15 for the whole embedder): handles use the
  default tag, safe because they are also type-checked with `FunctionTemplate::HasInstance`.
