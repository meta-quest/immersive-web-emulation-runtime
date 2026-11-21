# Image interop contract (runtime/image with WebGL, Canvas 2D, workers and the DOM)

How other parts of the runtime consume and produce decoded pixels. Owner: the image module (`runtime/image`,
`web/image`). Spec IDs: IMG-6, IMG-7, GL-16, GL-17, C2D-1, C2D-5, WRK-5.

## 1. Pixel format (all producers, all consumers)

- RGBA8, bytes in memory order R, G, B, A (`GL_RGBA` + `GL_UNSIGNED_BYTE`), **top row first**, already oriented
  (EXIF and `imageOrientation` applied). No colour management anywhere (`colorSpaceConversion` and
  `UNPACK_COLORSPACE_CONVERSION_WEBGL` are accepted and do nothing; IMG-6, GL-16).
- Every source states its alpha mode: `premultiplied` true or false. Decoded `<img>` pixels and `ImageData` are
  straight (unpremultiplied); `createImageBitmap` gives premultiplied pixels for `premultiplyAlpha: 'default'`
  and `'premultiply'` (as Chromium: its option parser treats `default` like `premultiply`) and straight ones for
  `'none'`; canvases say what they hold.
- Native side: `iwn::image::PixelStore` (`include/iwn/image/pixels.h`), immutable once published, shared through
  `std::shared_ptr<const PixelStore>`. Rows may be padded: use `stride()`, never `width * 4`. Stores allocated by
  the module have 16-byte aligned rows; stores adopted from stb_image (host, and the pre-API-30 fallback) are
  tightly packed (`width * 4`, 4-byte aligned). Every stride is a multiple of 4.

## 2. The image-source protocol (JS)

Anything usable as `TexImageSource` / `CanvasImageSource` implements a method under the registered symbol
`Symbol.for('iwn.image.source')` (`web/image/source.ts`, `IMAGE_SOURCE`). It returns a descriptor or throws:

```ts
type ImageSourceDescriptor =
  | { kind: 'handle'; handle: NativeImageHandle; origin; width; height; premultiplied }  // native pixels
  | { kind: 'pixels'; data: Uint8ClampedArray | Uint8Array; origin; width; height; premultiplied }; // JS pixels
// origin: 'bitmap' | 'image' | 'imagedata' | 'canvas' | 'webgl-canvas'
```

- Producers here: `ImageBitmap` (`origin: 'bitmap'`, handle), `HTMLImageElement` (`'image'`, handle),
  `ImageData` (`'imagedata'`, pixels, straight alpha). Producers elsewhere: the canvas stream's
  `HTMLCanvasElement` / `OffscreenCanvas` with a 2D context (`'canvas'`, premultiplied) and with a WebGL context
  (`'webgl-canvas'`; B decides how it reads back). They must return pixels that are **upright** (top row first in
  canvas space, C2D-2) and must throw a DOMException `InvalidStateError` for a zero-sized canvas.
- Consumers call `getImageSource(source, apiName)` (`web/image/tex-source.ts`, also on the image registry
  `globalThis[Symbol.for('iwn.image')].getImageSource`). It throws `TypeError` for video sources (no video yet,
  GL-17) and non-sources, and passes through the producer's `InvalidStateError` (closed bitmap, image not loaded
  or broken, detached `ImageData`).
- A `'pixels'` descriptor's `data` belongs to the producer: read it during the call, never keep or modify it.

## 3. `texImage2D` / `texSubImage2D` from a source (WebGL)

1. `const d = getImageSource(source, 'texImage2D')` (throws as above, GL-17). The upload size is `d.width x
   d.height` (WebGL 2 sub-rectangle uploads apply `UNPACK_SKIP_PIXELS/ROWS` and `UNPACK_ROW_LENGTH` inside it,
   §5.35).
2. Flags (GL-16): if `d.origin === 'bitmap'`, **ignore** `UNPACK_FLIP_Y_WEBGL` and `UNPACK_PREMULTIPLY_ALPHA_WEBGL`
   (the bitmap's own options already decided its pixels). Otherwise flip rows if `UNPACK_FLIP_Y_WEBGL`, and
   convert to premultiplied if `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is true and `!d.premultiplied`, or to straight if
   it is false and `d.premultiplied`.
3. Pixels:
   - `kind: 'pixels'`: pass `d.data` to the native upload like a typed-array upload of `GL_RGBA/GL_UNSIGNED_BYTE`.
   - `kind: 'handle'`: pass `d.handle` (a JS object) to native code; there
     `iwn::image::GetPixelStore(isolate, value)` (`include/iwn/image/v8_binding.h`) returns the
     `shared_ptr<const PixelStore>` (nullptr if closed: treat as `InvalidStateError`, which step 1 already
     caught). `store->Read()` gives a `PixelView` (pointer, stride, alpha mode) valid while the `ScopedPixels`
     lives. No copy into the JS heap happens on this path.
4. With no flag work and a format of `RGBA/UNSIGNED_BYTE` (three.js's common case), upload straight from the
   view: `glPixelStorei(GL_UNPACK_ROW_LENGTH, stride / 4)`, `GL_UNPACK_ALIGNMENT 4` (strides are multiples of
   4, §1), then `glTexImage2D/glTexSubImage2D(... view.data)`, then restore the app's unpack state. With flip
   or alpha work, call `iwn::image::CopyForUpload(view, flip_y, premultiply, dst, size)`
   (`include/iwn/image/transform.h`; same rounding as Skia: `round(c*a/255)`, `round(c*255/a)`) into a scratch
   buffer and upload that. Other internal formats (`RGB`, `LUMINANCE`, `RGBA4`, half float, ...) convert from the
   RGBA8 view in B's code.
5. Keep the `shared_ptr` only for the duration of the call (or until a deferred upload has read the pixels):
   `ImageBitmap.close()` drops the JS handle's reference, the store is freed when the last reference goes.

Zero-copy path toward the GPU (optional, later): with `BindingConfig::gpu_backed = true` the decoder writes into
an `AHardwareBuffer` (`PixelStore::Backing::kHardwareBuffer`, `hardware_buffer()`: `R8G8B8A8_UNORM`, usage
`CPU_READ_OFTEN | CPU_WRITE_OFTEN | GPU_SAMPLED_IMAGE`). B may then import it once with
`eglGetNativeClientBufferANDROID` + `eglCreateImageKHR(EGL_NATIVE_BUFFER_ANDROID)` into a scratch texture
(`glEGLImageTargetTexture2DOES`) and copy GPU-side into the app's texture (`glCopyImageSubData`, GLES 3.2) instead
of a CPU upload: no driver-side memcpy on the GL thread. The app texture must not *become* the EGLImage (WebGL
semantics: the app owns its texture's storage, may `generateMipmap`, may respecify). `Read()` on such a store
locks the buffer for CPU access, so the CPU path in step 4 keeps working. Status: the AHardwareBuffer allocation
and decode path compiles and is wired in but has **never run on a device**; default off until B measures it
(C2D-3's ≤ 0.2 ms budget for a 1024² upload is the target).

## 4. Canvas 2D (stream C2D)

- `drawImage` / `createPattern` from any source: `getImageSource(source, 'drawImage')`; draw from the
  descriptor, converting to the canvas's premultiplied format when `!d.premultiplied`. `ImageData` is **not** a
  drawImage source (C2D-5): reject it before calling `getImageSource` (its descriptor exists for
  `createImageBitmap`).
- Canvas as a source: implement `[Symbol.for('iwn.image.source')]()` on `HTMLCanvasElement` and
  `OffscreenCanvas`, returning `{ kind: 'pixels', origin: 'canvas', premultiplied: true, data }` (or a handle).
- `transferToImageBitmap()` / `createImageBitmap(canvas)`: wrap native pixels with
  `iwn::image::WrapPixelStore(isolate, ctx, store)` (C++, returns a handle object) and then
  `globalThis[Symbol.for('iwn.image')].wrapBitmap(handle)` (JS) to get an `ImageBitmap`. A JS-only canvas can
  instead go through `createImageBitmap(canvas)`, which calls `fromPixels` with its descriptor.

## 5. Workers and `structuredClone` (WRK-5)

The image registry's `clone` hooks:

- `cloneImageData(data)`: copy. `cloneBitmap(bitmap)`: a new bitmap on the same immutable pixels (native
  `share`). Same-realm `transferBitmap(bitmap)`: moves the handle, the original reads `width/height` 0.
- Cross-isolate transfer: sender `exportBitmap(bitmap) -> { iwnImageBitmap: id }` (detaches; pixels parked in the
  process-wide `TransferRegistry`), receiver `importBitmap(token)` in the other isolate. An id is single-use. If
  the message is never delivered, call `__iwn.image.discardTransfer(id)` to free the pixels.
- `installImage` registers ImageData (cloneable), ImageBitmap (cloneable and transferable) with the glue's
  `cloneRegistry` on `globalThis[Symbol.for('iwn.glue')]`, so the global `structuredClone` handles them in the
  same realm. Tested end to end over the real glue bundle (`web/image/test/glue-e2e.test.ts`, and on a headset in
  `tests/web_e2e.js`). Worker `postMessage` (cross-isolate) is for the workers stream to wire through
  `exportBitmap` / `importBitmap`.

## 6. DOM stand-ins (`document.createElement('img')`)

`globalThis[Symbol.for('iwn.image')].createImageElement()` returns a new `HTMLImageElement` (also for
`createElementNS(xhtml | svg, 'img')`). `installImage(global, { Base })` builds `HTMLImageElement` on top of the
DOM stream's `HTMLElement` when it is passed (or found as `globalThis.HTMLElement` at install time); `Base` is
constructed with no arguments. The element routes `setAttribute/getAttribute/removeAttribute/hasAttribute` for
its reflected attributes (`src`, `width`, `height`, `crossorigin`, `alt`, `decoding`, `loading`, ...) and passes
others to `Base`'s.

## 7. Event loop (runtime core) and page reloads

How finished jobs reach the JS thread is chosen per registration (`include/iwn/image/v8_binding.h`):

1. Page isolate of the core runtime (`iwn::Runtime::From(isolate)` non-null): `Runtime::post_task`, which runs
   the completion with scopes, error reporting and a microtask checkpoint, and drops it once the page context was
   replaced. The module also adds a shutdown hook (`DisposeIsolate`) and an `image` stats provider. Nothing to
   configure.
2. Worker isolates: the per-isolate `IwnLoopHooks` of `iwn/loop_hooks_registry.h` (shared with net and storage),
   when bound before `iwn_register_image`; each job holds a `ref` on the loop until its completion runs.
3. `ConfigureBinding({ .post = ... })`: the hook queues the task (run it, then a microtask checkpoint). It is
   called from pool threads, never for an isolate after `DisposeIsolate(isolate)` returned (the module checks
   and posts under one lock), so the hook may assume the isolate is alive.
4. `ConfigureBinding({ .platform = ... })`: tasks on `platform->GetForegroundTaskRunner(isolate)`.
5. None: JS polls (`__iwn.image.needsPolling`): fine for bring-up, adds up to 2 ms latency per image.

Reloads (PROC-8): registering again in the same isolate retires the previous registration at once: its
`v8::Global<Context>` and pending promise resolvers are released (the old page's heap and its unreachable
bitmaps become collectable), queued jobs of the old page are skipped and its late completions dropped. Measured
on a Quest 3S: page A with eight 4 MB bitmaps, 16 MB of JS objects and a decode in flight, then a new context:
page A's context is collected, RSS returns to the baseline (52.9 → 117.2 → 53.2 MB).

`DisposeIsolate(isolate)`: **required** on the isolate's thread before `Isolate::Dispose()` for isolates the core
runtime does not own (workers, tests); it frees live handles' pixels and stops all posting for that isolate. State
is keyed by isolate address, so skipping it lets a later isolate at the same address inherit a dead one's state. The module's
global tables are never destroyed (no static destructor runs V8 code at `exit()`).

Teardown order for non-core isolates (workers, tests):

1. `iwn::image::DisposeIsolate(isolate)` first, while the isolate's loop hooks are still bound. Pool threads read
   the raw `IwnLoopHooks*` from the registry and call `post` through it; after `DisposeIsolate` returns they never
   do so again for that isolate. Unbinding (`UnbindLoopHooks`) and freeing the loop before `DisposeIsolate` can
   leave a pool thread calling through a dangling pointer.
2. Then unbind the loop hooks and free the loop.
3. Then `Isolate::Dispose()`. Pumping the isolate's task runner between steps 1 and 3 is allowed: a handle whose
   first-pass weak callback already ran is left for its queued second pass, which frees it without touching the
   disposed state (if the isolate is disposed first, that box, a few dozen bytes, leaks). Page JS that runs in
   between (V8 posts FinalizationRegistry cleanup to that runner) finds `__iwn.image` inert: the natives look up
   their registration by id on every call, so after `DisposeIsolate` the ones that return values throw a
   `TypeError` and `close`/`cancel`/`poll` do nothing; `GetPixelStore` returns null for old handles.

Retired registrations are freed once their context has been collected and all their handles finalized (checked
at the next registration and when a retired page's last handle is finalized), so many reloads in one session
do not accumulate state. In loop-hooks mode a retired registration gives back its in-flight jobs' loop refs at
once (its completions are dropped, so they would otherwise never be released).

Embedder data tags: handles use `IWN_EMBEDDER_TAG_IMAGE` (default 0; V8 15.5 allows 0..14 for the whole
embedder, so the registry should hand out one per module; handles are also checked with
`FunctionTemplate::HasInstance`).

## 8. Natives contract additions (version 2)

- `decodeBase64(text, options)`: a `data:` URL's base64 payload; forgiving-base64 and the decode run on the pool,
  the JS thread only copies the characters (REG-16). `HTMLImageElement` uses it for `data:` URLs (the src setter
  itself does no work; a 16 MiB data: URL costs ~1.2 ms of JS-thread time on a Linux build host instead of ~390 ms).
- `cancel(promise)`: rejects a pending job's promise with code `cancelled` and stops the job (a queued job never
  starts; a decode waiting for the memory budget gives up). `HTMLImageElement` cancels a superseded load.
- Memory: decodes reserve their output size in a process-wide budget (`DecodeBudget`, 512 MiB by default,
  `BindingConfig::decode_memory_budget`) before allocating; a decode larger than the budget runs alone. A plain
  resize of a JPEG or WebP decodes downscaled by 2/4/8 first (libjpeg-turbo DCT scaling, libwebp's rescaler: both
  filter), still ≥ 2x the target: on a Quest 3S an 8192² JPEG resized to 1024² peaks at 77 MB instead of 314 MB.
  A PNG whose header promises more pixels than its file size can hold (deflate's 1032:1 limit) fails before any
  allocation.
