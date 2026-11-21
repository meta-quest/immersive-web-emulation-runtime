# runtime/gl + web/webgl: the generated WebGL 2 binding (milestone M2)

Implements `docs/spec/07-webgl2.md` (GL-1 … GL-27, GL-CTS-1, GL-PERF-1 … 5). Two halves:

| part | where | what |
|---|---|---|
| generator | `runtime/gl/gen/` | `generate.mjs` reads the NDK GLES 3.2 headers (`GLES3/gl32.h`, `GLES2/gl2ext.h`), the WebGL IDL (`gen/idl/`, Chromium revision in `gen/idl/REVISION`, refresh with `gen/fetch-idl.mjs`) and `binding-table.mjs` (every documented special case) and writes everything under `runtime/gl/generated/` and `web/webgl/gen/`. `node runtime/gl/gen/generate.mjs --check` fails if a checked-in output is stale. |
| natives (C++) | `runtime/gl/` | 254 natives on `globalThis.__iwn.gl`, 243 with a V8 fast-API path (`v8::CFunction`) plus a slow callback each. Generic natives are raw GLES calls; typed arrays arrive as (view, byteOffset, byteLength) and are bounds-checked against the view (never read or written outside it); buffer offsets are doubles; `glGen*`/`glDelete*` take/return one name. Composites (`src/composites.cc`, `src/gl_v8_composites.cc`): program reflection record, shader status, zero-initialisation, multi-draw with `webgl_DrawID`, sync ids, `getBufferSubData`, EGL contexts, stats, uploads from runtime/image handles (`src/gl_image.cc`, built with `IWN_GL_WITH_IMAGE` when the `iwn_image_v8` target exists). `src/egl_context.*`: one display, a root ES 3.2 context owning the share group (OpenXR's graphics binding uses it) and one context per WebGL context. `src/blob_cache.*`: `EGL_ANDROID_blob_cache` store (bounded, LRU, invalidation key). |
| binding (TypeScript) | `web/webgl/` | the WebGL 1 / WebGL 2 interfaces over the natives: WebIDL conversion, object model and lifetime, WebGL error synthesis, the state cache, reflection answered in JS, typed-array and pixel-store rules, TexImageSource uploads, extensions, the emulated default framebuffer, draw-time validation. `dist/webgl.min.js` (IIFE prelude, `node web/webgl/build.mjs`) installs it and publishes `globalThis.__iwnWebGL`. |

## Design points (what makes it fast)

- **Every JS call is at most one native transition**, and redundant ones are none: `bindX` of the bound object,
  `useProgram` of the current program, enable of an enabled cap, `viewport`/`scissor`/`blendFunc`/… with
  unchanged values and uniform uploads equal to the value last uploaded to that program location are dropped in JS (GL-PERF-2). Cached
  values are validated first, so the cache always equals the driver. three.js steady-state frame (30 meshes,
  three materials): 70 native calls for 30 draws (2.3 per draw, GL-PERF-4 target ≤ 2).
- **No driver round trips for state or errors** (GL-10, GL-21): `getParameter` for bindings and state, all
  WebGL-specific errors, `getUniformLocation`/`getActive*`/`getProgramParameter`/`getAttribLocation`/
  `getUniformBlockIndex`… are answered in JS. A linked program costs one `programInfo` native call (status,
  log, attributes, uniforms with per-element locations, blocks, varyings) and a compiled shader one
  `shaderInfo` call, fetched lazily (KHR_parallel_shader_compile: compile/link never block; COMPLETION_STATUS
  polls are cheap natives). `glGetError` is only called when the app calls `getError` and no JS error is pending.
- **No per-call allocation** on steady-state paths (GL-PERF-3): list arguments convert into per-context scratch
  arrays, typed arrays go by pointer (`ArrayBufferView::GetContents` in the fast path).
- **Draw-time WebGL validation from cached state**: client arrays, element buffer + offset alignment, multiview
  view counts, feedback loops (recomputed only when a binding that can create one changes), attribute type
  matching, uniform block backing, front/back stencil consistency, transform-feedback conflicts.

## Integration contract (other streams)

- Runtime core: links `iwn_gl` (CMake target, registered by name). Optionally calls
  `iwn::gl::Init({shaderCacheDir, shaderCacheKey, robustAccess})` before the first JS context (header
  `runtime/gl/include/iwn/gl.h`); without it the module derives the cache dir from the process name. Loads
  `web/webgl/dist/webgl.min.js` as a prelude. Calls `__iwnWebGL.afterAnimationFrame()` after window rAF
  callbacks (drawing-buffer semantics and GL-15 epochs).
- Canvas (stream M4): `HTMLCanvasElement.getContext('webgl2'|'webgl', attrs)` → `__iwnWebGL.createContext(canvas,
  type, attrs)` (cache it per canvas; a second type returns null); width/height setters →
  `__iwnWebGL.canvasResized(ctx)`. Images / ImageBitmap / 2D canvases expose pixels to `texImage2D` through
  runtime/image's protocol `source[Symbol.for('iwn.image.source')]()` (`runtime/image/INTEROP.md` §2/§3:
  'handle' descriptors upload RGBA8 straight from the native pixel store, other formats copy once and convert in
  JS; 'bitmap' origin ignores the UNPACK flags), or the older `source[Symbol.for('iwn.texImageSource')]() →
  { width, height, data: RGBA8, premultiplied, isBitmap, closed?, complete? }` (`web/webgl/tex-source.ts`).
- XR (stream M3): `RootDisplay/RootConfig/RootContext()` for `XrGraphicsBindingOpenGLESAndroidKHR`;
  `__iwnWebGL.wrapTexture(gl, name)` / `retargetTexture(gl, tex, name, framebuffers)` for the session's opaque
  colour texture (re-binds units and re-points FBO attachments), `wrapFramebuffer(gl, name, {opaque, numViews})`
  for `XRWebGLLayer`, `invalidateDepthStencil(gl, fb)` at frame end (GL-PERF-5), `frameBoundary(gl)` per XR
  frame, `resyncState(gl)` after native GL work in a WebGL context.

## Build and test

```bash
export PATH=$HOME/.local/bin:$PATH
node runtime/gl/gen/generate.mjs                      # regenerate (or --check)
# host: V8-free core + native tests + the Node addon (generated natives over Mesa's surfaceless ES 3.2)
cmake -S runtime/gl -B build/gl/host -G Ninja -DIWN_GL_NODE_ADDON=ON
ninja -C build/gl/host -j 16 && build/gl/host/iwn_gl_tests
cd web/webgl && npm install
npm run typecheck && npm test                         # IDL coverage, state cache, real GL, three.js, regressions
node bench/gl-bench.mjs                               # ns/call on the host
cts/fetch-cts.sh && node build.mjs && node cts/harness.mjs --json /tmp/cts.json   # GL-CTS-1 subset (cts/subset.txt), host
# GL-CTS-1 on a headset: the same subset and both passes through a harness app over CDP (`adb -s <serial>`, or the command in IWN_ADB)
node cts/device-build.mjs --libs <rt-android>/apk-libs.txt --out gl-cts.apk
node cts/device-run.mjs --serial <serial> --apk gl-cts.apk --port 9502 --json device.json
# device: the runtime with this module + the same test files bundled as an app
node device/build.mjs                                 # -> build/gl/gl-device-dist
node ../../runtime/app/template/build-apk.mjs --libs <rt-android>/apk-libs.txt \
  --dist build/gl/gl-device-dist --out gl-device.apk --package com.iwernative.gltest
# logcat: "GLDEV PASS|FAIL …", "GLDEV SUMMARY", "GLBENCH device …", "GLDEV compile12 … ms"
```

Build directories: `build/gl/` (gitignored). Android builds use the NDK r30
toolchain file, `-DANDROID_ABI=arm64-v8a -DANDROID_STL=c++_shared` (V8 15.5's libc++).
