# 07. WebGL 2 over GLES 3.2: binding semantics, errors, state, extensions

Sources: WebGL 1.0 and 2.0 specifications (Khronos, including §5 "Differences between WebGL and OpenGL
ES" and §6 of WebGL 1.0), the WebGL 2.0 IDL, the WebGL extension registry (`OVR_multiview2`,
`WEBGL_multi_draw`, `KHR_parallel_shader_compile`, `EXT_disjoint_timer_query_webgl2`,
`WEBGL_compressed_texture_*`, `EXT_clip_control`, `WEBGL_clip_cull_distance`, `WEBGL_lose_context`,
`WEBGL_debug_renderer_info`, `WEBGL_debug_shaders`, `WEBGL_render_shared_exponent`,
`WEBGL_multisampled_render_to_texture`, `EXT_texture_filter_anisotropic`, `EXT_color_buffer_float`,
`EXT_color_buffer_half_float`, `OES_texture_float_linear`, `EXT_texture_norm16`), OpenGL ES 3.2 spec and the
Khronos `gl.xml` registry, GLES extensions (`GL_OVR_multiview`, `GL_OVR_multiview2`,
`GL_OVR_multiview_multisampled_render_to_texture`, `GL_EXT_multisampled_render_to_texture`,
`GL_KHR_parallel_shader_compile`, `GL_EXT_disjoint_timer_query`, `GL_EXT_clip_control`,
`GL_EXT_clip_cull_distance`, `GL_EXT_multi_draw_indirect`, `GL_EXT_base_instance`,
`GL_EXT_buffer_storage`, `GL_EXT_robustness`), EGL 1.5 + `EGL_ANDROID_blob_cache`,
`EGL_EXT_create_context_robustness`, `EGL_KHR_no_config_context`; the showcase's per-frame GL profile
(about 720 calls and 149 draws per frame); the three r181 / super-three source (what it probes and calls, including MSAA multiview on
Quest).

Terminology: _XR context_ = the WebGL context the app hands to WebXR (C2D-2), which renders into the XR
swapchain; _other contexts_ = any further WebGL contexts. _Steady state_ = XR frames after warm-up with no new programs or resources.

## Context

**GL-1 (MUST).** `canvas.getContext('webgl2', attrs)` returns a `WebGL2RenderingContext` backed by a GLES
3.2 context; `getContext('webgl', attrs)` returns a context that presents the WebGL 1 surface (WebGL 1
extension names, `WebGLRenderingContext` prototype) over the same driver. `instanceof
WebGL2RenderingContext` / `WebGLRenderingContext` hold as in browsers, all WebGL interface objects exist
on the global (`WebGLBuffer`, `WebGLTexture`, …, `WebGLActiveInfo`, `WebGLShaderPrecisionFormat`,
`WebGLContextEvent`) and are not constructible by script.
_Check:_ an IDL coverage test generated from the WebGL 2.0 IDL: every attribute, method and constant
exists with the right arity (`fn.length`) and constant value.

**GL-2 (MUST).** `getContextAttributes()` reports what was actually provided (`alpha`, `depth`,
`stencil`, `antialias`, `premultipliedAlpha`, `preserveDrawingBuffer`, `powerPreference`,
`failIfMajorPerformanceCaveat`, `desynchronized`, `xrCompatible`). `makeXRCompatible()` resolves.
`drawingBufferWidth/Height` follow the canvas's `width`/`height` and are unaffected by XR; `drawingBufferColorSpace`
and `unpackColorSpace` exist (`'srgb'`; setting `'display-p3'` is accepted and ignored, documented).
_Check:_ tests.

**GL-3 (MUST).** Every GL resource the app can observe is zero-initialised before first use as WebGL
requires: buffers from `bufferData(target, size, usage)`, textures from `texImage*`/`texStorage*` with
null data, renderbuffers. Lazy clearing is allowed; the cost must not land inside steady-state frames.
_Check:_ allocate a texture with null data, attach it, `readPixels` before drawing: all zeros.

**GL-4 (MUST).** Context loss: a real device loss (EGL reports it) fires `webglcontextlost` on the canvas
(cancelable), `isContextLost()` becomes true, every call becomes a no-op returning the WebGL-specified
defaults, `getError` returns `CONTEXT_LOST_WEBGL` once; `WEBGL_lose_context.loseContext()/
restoreContext()` simulate it (`webglcontextrestored` after restore if the loss event was cancelled).
_Check:_ `WEBGL_lose_context` test; real loss is logged.

## Object model and argument handling

**GL-5 (MUST).** WebGL objects keep identity: `createX()` returns a new object each time; getters that
return objects (`getParameter(TEXTURE_BINDING_2D)`, `getFramebufferAttachmentParameter(…OBJECT_NAME)`,
`getAttachedShaders`, `getVertexAttrib(…BUFFER_BINDING)`, `getIndexedParameter(…BINDING)`) return the same
JS object the app created, or `null`. Deleted objects stay valid JS objects; `isX()` on them is false.
Objects from another context produce `INVALID_OPERATION` and no GL call.
_Check:_ tests for each getter.

**GL-6 (MUST).** Argument conversion follows WebIDL: numbers through `ToNumber`/`ToInt32`/`ToUint32`
(`GLenum`, `GLint`, `GLsizeiptr` as `long long` with `[EnforceRange]` where the IDL says), booleans through
`ToBoolean`, nullable objects accept `null`; a wrong object type (`bindTexture(TEXTURE_2D, buffer)`) or a
non-typed-array where a typed array is required throws `TypeError`.
_Check:_ IDL-driven argument tests.

**GL-7 (MUST).** Typed-array arguments: offsets (`srcOffset`, `dstOffset`) and lengths (`srcLength`,
`length`) are measured in elements (not bytes) of the view; the view's own `byteOffset` is honoured; an offset/length
outside the view is `INVALID_VALUE`; a view too small for the requested pixel rectangle (computed from the
current `PACK_*`/`UNPACK_*` state, format, type) is `INVALID_OPERATION`; the view's type must match `type`
per WebGL 2.0 §3.7.6 / §5.14.8 (e.g. `FLOAT` ↔ `Float32Array`, `HALF_FLOAT` ↔ `Uint16Array`,
`UNSIGNED_BYTE` ↔ `Uint8Array`/`Uint8ClampedArray`) else `INVALID_OPERATION`; `uniform*fv` takes a
`Float32List` (`Float32Array` or `sequence<GLfloat>`), `uniform*iv` an `Int32List`, `uniform*uiv` a
`Uint32List`: by WebIDL union conversion, the matching typed array is used directly and any other iterable
(a plain array, or a typed array of another kind such as `Float64Array`) is converted element by element
as a sequence, as browsers do; a non-iterable non-matching value is a `TypeError`; views on a `SharedArrayBuffer` are accepted;
detached buffers are treated as length 0. The binding never reads or writes outside the view.
_Check:_ argument fuzz test (random offsets/lengths/types) under ASan on the Linux build of the binding
with a software GLES (e.g. SwiftShader or ANGLE-on-Vulkan-on-CPU in CI) or a GL call recorder: no
out-of-bounds access, the expected error per case.

**GL-8 (MUST).** Uniform locations: `getUniformLocation` returns `null` for inactive/missing names and a
`WebGLUniformLocation` otherwise (array names with or without `[0]` resolve the same element 0);
`uniform*` calls given a `null` location do nothing and record no error; a location from another program, or after
the program was relinked, is `INVALID_OPERATION`.
_Check:_ tests.

## Errors

**GL-9 (MUST).** GL errors never throw: `getError()` returns the first recorded error and clears it, as
WebGL specifies, with errors from the driver and errors the binding synthesises merged in the right order.
The binding synthesises WebGL-mandated errors that GLES does not raise (at least: §5 of WebGL 2.0 —
buffer target restrictions per WebGL 2.0 §5.1: a buffer's type is set by its first binding: element-array
data if first bound to `ELEMENT_ARRAY_BUFFER`, other data if first bound to any other target **including**
`COPY_READ_BUFFER` or `COPY_WRITE_BUFFER`; an element-array buffer may later be bound only to
`ELEMENT_ARRAY_BUFFER`, `COPY_READ_BUFFER` or `COPY_WRITE_BUFFER`, and an other-data buffer can never be
bound to `ELEMENT_ARRAY_BUFFER` (`INVALID_OPERATION`),
`vertexAttribPointer` with no `ARRAY_BUFFER` bound and a non-zero offset, client-side arrays, feedback loops
between a sampled texture and the draw framebuffer's attachments, transform feedback buffer conflicts,
multiview `numViews` mismatch with the program (OVR*multiview2), the typed-array rules of GL-7, deleted or
foreign objects, `drawBuffers` length rules).
\_Check:* the WebGL 2.0 conformance suite subset (GL-CTS-1) for those areas passes.

**GL-10 (MUST).** In steady state the binding does not call `glGetError` after every call; errors are
collected with no synchronous driver round trip per call (e.g. checked when the app calls `getError`, or
at frame end in debug builds). Driver errors that occurred are still reported by the next `getError`.
_Check:_ steady-state profile on device shows 0 `glGetError` calls per frame from the binding unless the
app calls `getError`.

**GL-11 (MUST, decision recorded).** Out-of-range vertex/index fetch: WebGL 2.0 requires that a draw never
reads outside a buffer (an error or robust-access values). The runtime satisfies this without CPU index
validation by creating the context with robust buffer access (`EGL_EXT_create_context_robustness` /
`GL_EXT_robustness`) when the driver offers it, after measuring that it costs < 2 % App GPU on the
showcase; if it costs more, the choice between robust access and documented non-validation (apps are
trusted and packaged) is an open question (index, question 4).
_Check:_ the A/B number and the decision in the spec log; with robust access on, a draw with indices past
the end does not crash or hang the GPU.

**GL-12 (SHOULD).** A debug switch logs every call that raised an error (call name, arguments, error) and
the JS stack, rate-limited.
_Check:_ enable it; a deliberate `bindBuffer(0x1234, b)` logs once with the stack.

## State and queries

**GL-13 (MUST).** `getParameter` returns WebGL types: `Int32Array` (`VIEWPORT`, `SCISSOR_BOX`,
`MAX_VIEWPORT_DIMS`), `Float32Array` (`COLOR_CLEAR_VALUE`, `BLEND_COLOR`, `DEPTH_RANGE`,
`ALIASED_*_RANGE`), boolean arrays (`COLOR_WRITEMASK`), objects (bindings), strings, numbers, `null`.
WebGL-only values are answered by the runtime: `VERSION` begins with `"WebGL 2.0"` (WebGL 1 surface:
`"WebGL 1.0"`), `SHADING_LANGUAGE_VERSION` begins with `"WebGL GLSL ES 3.00"` (`"…1.0"`),
`UNPACK_FLIP_Y_WEBGL`, `UNPACK_PREMULTIPLY_ALPHA_WEBGL`, `UNPACK_COLORSPACE_CONVERSION_WEBGL`,
`MAX_CLIENT_WAIT_TIMEOUT_WEBGL` (0 as in Chrome). `VENDOR`/`RENDERER` follow the choice recorded in the
open questions (browser-masked strings vs driver strings); `WEBGL_debug_renderer_info`'s `UNMASKED_*`
return the driver's.
_Check:_ tests; three's capability detection on device logs the same `renderer.capabilities` as in Quest
Browser (precision, maxTextures, maxTextureSize, maxSamples, isWebGL2) — diff the two JSON dumps.

**GL-14 (MUST).** Limits reported through `getParameter` are the driver's, except where WebGL caps them
(e.g. `MAX_CLIENT_WAIT_TIMEOUT_WEBGL`) or Quest Browser exposes a smaller value that apps rely on (record
any such case with evidence).
_Check:_ dump all `getParameter` limits on Quest 3 in Quest Browser and in the runtime; differences are
listed and justified.

**GL-15 (MUST).** Query and sync results follow WebGL's "not available in the same task" rule: a query's
`QUERY_RESULT_AVAILABLE` and a sync's status may become true only after the current task / XR frame
callback returns (three polls across frames). `COMPLETION_STATUS_KHR` (KHR*parallel_shader_compile) is not
bound by that rule and may report true as soon as compilation or linking has finished. `clientWaitSync` with a non-zero
timeout above `MAX_CLIENT_WAIT_TIMEOUT_WEBGL` is `INVALID_OPERATION`.
\_Check:* tests with the GL call recorder.

**GL-16 (MUST).** Pixel store, as WebGL 1.0 §5.14.8 and WebGL 2.0 §5.14/§5.35 define it:

- `UNPACK_FLIP_Y_WEBGL` and `UNPACK_PREMULTIPLY_ALPHA_WEBGL` apply to `texImage2D`/`texSubImage2D` from
  `HTMLImageElement`, `ImageData` and canvases (2D, WebGL, `OffscreenCanvas`) and from a client-side
  `ArrayBufferView`; premultiply applies to formats with alpha.
- They are **ignored for `ImageBitmap` sources** (the bitmap's own options decide its pixels; IMG-6).
- With either flag true, `texImage3D`/`texSubImage3D` from a non-null `ArrayBufferView` or from a
  `PIXEL_UNPACK_BUFFER`, and `texImage2D`/`texSubImage2D` from a `PIXEL_UNPACK_BUFFER`, generate
  `INVALID_OPERATION` and upload nothing (WebGL 2.0). `texImage3D`/`texSubImage3D` from DOM sources and
  `ImageData` apply the flags as for 2D.
- The source data is never modified. `UNPACK_COLORSPACE_CONVERSION_WEBGL` is accepted (no colour management,
  documented). `UNPACK_ALIGNMENT/ROW_LENGTH/SKIP_*/IMAGE_HEIGHT` apply to typed-array uploads; for
  `TexImageSource` uploads they apply as WebGL 2.0 §5.35 says (sub-rectangle uploads from images).
  _Check:_ a pixel-exact test matrix (flipY × premultiply × source kind × format) against Chrome's
  results on the same inputs, including `ImageBitmap` sources (flags have no effect) and the
  `INVALID_OPERATION` cases above; the GL-CTS-1 `tex-image-and-sub-image` directories pass.

**GL-17 (MUST).** `texImage2D(…, source)` with a 2D canvas, another context's WebGL canvas, an `ImageBitmap`,
an `HTMLImageElement` or `ImageData` uses the source's size; a closed bitmap or an unloaded image throws
`InvalidStateError`; a `HTMLVideoElement` playing a camera stream (XR-CAM-1) uploads its newest frame (0x0 before
the first); other `HTMLVideoElement`s and `VideoFrame` throw `TypeError` (no video decoding, documented).
_Check:_ tests.

## Shaders and programs

**GL-18 (MUST).** GLSL ES 3.00 and 1.00 WebGL shaders compile on the Adreno driver. The runtime rewrites
only what WebGL defines differently from GLES, and the rewrite is invisible to `getShaderSource` (returns
the app's source): WebGL-only extension directives map to the GLES ones or are removed
(`GL_ANGLE_multi_draw` → `gl_DrawID` support per GL-25; `GL_ANGLE_clip_cull_distance` →
`GL_EXT_clip_cull_distance`; `GL_OVR_multiview2` passes through), and identifiers the runtime injects use
the reserved `webgl_` prefix so they cannot clash with app code. `WEBGL_debug_shaders.
getTranslatedShaderSource` returns what was actually compiled.
_Check:_ a corpus of every shader three r181 / super-three generates for the 23 proto samples (captured
headlessly) compiles and links on Quest 3 and 3S with no errors.

**GL-19 (SHOULD).** Driver shader workarounds: where the Adreno compiler is known to miscompile WebGL-valid
GLSL that browsers accept (Chromium/ANGLE workaround lists for Qualcomm are a public source), apply the
same source-level workaround; each one is listed with the test that shows the bug.
_Check:_ the list exists; each entry has a repro.

**GL-20 (MUST).** `KHR_parallel_shader_compile` is exposed when the driver has
`GL_KHR_parallel_shader_compile`: `COMPLETION_STATUS_KHR` on shaders and programs never blocks, and
`maxShaderCompilerThreadsKHR` is accepted. Getting a shader's info log or a program's link status before
completion blocks only on that object.
_Check:_ compile 40 programs and poll; the poll calls take < 50 µs each; the main thread does not block
for the compiles.

**GL-21 (MUST).** Program reflection is cheap: after a link completes, the active attributes, uniforms,
uniform blocks and their locations are fetched from the driver once per program (no further driver
round trips for `getActiveUniform`/`getActiveAttrib`/`getUniformLocation`/`getAttribLocation`/
`getProgramParameter`/`getUniformBlockIndex` calls by the app, which are answered from that record).
_Check:_ first-XR-frame profile of the showcase, counted as `docs/headless-showcase.md` counts its
~2,960 sync queries: JS→native calls that return driver state synchronously (`getProgramParameter`,
`getShaderParameter`, `getActive*`, `get*Location`, `getUniformBlockIndex`, `getError`, …). Target: ≤ 2 such
calls reach native code per program linked plus ≤ 1 per shader compiled, whatever the app asks (three
asks for both info logs, the link status and every active attribute and uniform); everything else is
answered in JS from the record. The number of
GLES calls native code makes internally to build the reflection record (GLES needs one query per active
uniform) is not counted, only reported.

**GL-22 (MUST).** Persistent program binary cache: compiled programs are cached across launches through
`EGL_ANDROID_blob_cache` (the driver's own cache; Quest Browser keeps one) in the app's cache directory,
bounded (default 32 MB), invalidated on driver/OS build change and APK version code change.
_Check:_ warm launch of the showcase compiles its programs ≥ 3× faster in total than cold (boot timeline);
the cache directory exists and is bounded.

## Extensions

**GL-23 (MUST).** `getSupportedExtensions()` lists, and `getExtension(name)` returns an object (the same
object on every call) for, each extension below exactly when the driver capability in brackets exists;
otherwise `getExtension` returns `null`:
`EXT_color_buffer_float` [ES 3.2 core], `EXT_color_buffer_half_float` [ES 3.2 core or
`GL_EXT_color_buffer_half_float`], `EXT_float_blend` [`GL_EXT_float_blend`], `OES_texture_float_linear`
[`GL_OES_texture_float_linear`], `EXT_texture_filter_anisotropic` [`GL_EXT_texture_filter_anisotropic`],
`EXT_texture_norm16` [`GL_EXT_texture_norm16`], `EXT_clip_control` [`GL_EXT_clip_control`],
`WEBGL_clip_cull_distance` [`GL_EXT_clip_cull_distance`], `KHR_parallel_shader_compile`
[`GL_KHR_parallel_shader_compile`], `EXT_disjoint_timer_query_webgl2` [`GL_EXT_disjoint_timer_query`],
`WEBGL_compressed_texture_astc` [`GL_KHR_texture_compression_astc_ldr`; `getSupportedProfiles()` lists
`ldr` and `hdr` when `GL_KHR_texture_compression_astc_hdr`], `WEBGL_compressed_texture_etc` [ES 3.0 core],
`WEBGL_compressed_texture_etc1` [`GL_OES_compressed_ETC1_RGB8_texture`],
`WEBGL_compressed_texture_s3tc`/`_s3tc_srgb`/`EXT_texture_compression_bptc`/`_rgtc`/
`WEBGL_compressed_texture_pvrtc` [their GL extensions; absent on Adreno], `WEBGL_lose_context` [always],
`WEBGL_debug_renderer_info` [always], `WEBGL_debug_shaders` [always], `WEBGL_multi_draw` [always: GL-25],
`WEBGL_render_shared_exponent` [`GL_QCOM_render_shared_exponent`], `WEBGL_multisampled_render_to_texture`
[`GL_EXT_multisampled_render_to_texture`], `OVR_multiview2` [`GL_OVR_multiview2`], `OCULUS_multiview`
[`GL_OVR_multiview2` + `GL_OVR_multiview_multisampled_render_to_texture`], `OES_draw_buffers_indexed`
[ES 3.2 core or `GL_OES_draw_buffers_indexed`] (there is no `WEBGL_`-prefixed name),
`EXT_texture_mirror_clamp_to_edge` [`GL_EXT_texture_mirror_clamp_to_edge`], `WEBGL_provoking_vertex`
[`GL_ANGLE_provoking_vertex` or `GL_EXT_provoking_vertex`; not core in GLES 3.2, so absent without one of
them], `EXT_polygon_offset_clamp` [`GL_EXT_polygon_offset_clamp`],
`WEBGL_polygon_mode` [`GL_NV_polygon_mode` / `GL_ANGLE_polygon_mode`]. The WebGL 1 surface lists the WebGL
1 names (`OES_texture_float`, `OES_standard_derivatives`, `ANGLE_instanced_arrays`,
`OES_vertex_array_object`, `WEBGL_depth_texture`, `OES_element_index_uint`, `EXT_sRGB`,
`EXT_shader_texture_lod`, `EXT_frag_depth`, `WEBGL_draw_buffers`, `OES_texture_half_float(_linear)`,
`EXT_blend_minmax`) mapped onto ES 3 core.
_Check:_ on Quest 3 and 3S, compare `getSupportedExtensions()` with Quest Browser's list; every
difference is explained (driver vs browser policy).

**GL-24 (MUST).** Multiview. `OVR_multiview2.framebufferTextureMultiviewOVR(target, attachment, texture,
level, baseViewIndex, numViews)` and `OCULUS_multiview.framebufferTextureMultisampleMultiviewOVR(target,
attachment, texture, level, samples, baseViewIndex, numViews)` attach `TEXTURE_2D_ARRAY` layers as views;
the constants `FRAMEBUFFER_ATTACHMENT_TEXTURE_NUM_VIEWS_OVR`,
`FRAMEBUFFER_ATTACHMENT_TEXTURE_BASE_VIEW_INDEX_OVR`, `MAX_VIEWS_OVR`,
`FRAMEBUFFER_INCOMPLETE_VIEW_TARGETS_OVR` exist; `getFramebufferAttachmentParameter` reports them;
shaders with `#extension GL_OVR_multiview2 : require` and `layout(num_views = 2) in;` compile; drawing with
a program whose `num_views` differs from the bound framebuffer's is `INVALID_OPERATION`; the multisampled
variant renders 4× MSAA with the resolve happening implicitly on tile store (no app-visible resolve
attachment, no blit). Both extensions are reported to the app (super-three takes the multiview path when
`OCULUS_multiview` is present).
_Check:_ a two-colour-per-eye multiview test (each view's `gl_ViewID_OVR` picks a colour) renders the
right colour per eye in an XR screenshot (DBG-SHOT) with and without MSAA; the showcase's eye pass is ONE
pass per frame with `samples = 4` in the GL profile.

**GL-25 (MUST).** `WEBGL_multi_draw` (`multiDrawArraysWEBGL`, `multiDrawElementsWEBGL`,
`multiDrawArraysInstancedWEBGL`, `multiDrawElementsInstancedWEBGL` with their list/offset/count
signatures) is always exposed. Shaders may use `gl_DrawID` (under `#extension GL_ANGLE_multi_draw :
require`) and see the index of the sub-draw in every one of the forms. Entries with count 0 or instance
count 0 draw nothing. Offsets into the lists are in elements. Errors follow the extension spec, the
Khronos conformance test `conformance/extensions/webgl-multi-draw.html` and Chromium: a negative
`drawcount` is `INVALID_VALUE`; an offset at or past the end of its list, or `offset + drawcount` past the
end, is `INVALID_OPERATION`; a `drawcount` of 0 is not an error.
Results are identical to issuing the sub-draws one by one with `gl_DrawID` set. Multi-draw and multiview
compile together in one program (super-three's BatchedMesh in XR).
_Check:_ BatchedMesh with 20 instances rendered in multiview: pixel-identical to the same scene with one
mesh per instance; gl-bench multi-draw case reports ns/draw.

**GL-26 (MUST).** `EXT_disjoint_timer_query_webgl2`: `queryCounterEXT`, `TIME_ELAPSED_EXT`,
`TIMESTAMP_EXT`, `GPU_DISJOINT_EXT` (from the driver) with GL-15's availability rule.
_Check:_ three's `renderer.info` GPU timing path returns plausible values (within 20 % of VrApi App GPU).

**GL-27 (MUST).** `EXT_texture_filter_anisotropic` max reported from the driver; `WEBGL_compressed_texture_astc`
uploads of KTX2 transcoded to ASTC work through `compressedTexImage2D/3D` and `compressedTexSubImage*`
with typed arrays and with `PIXEL_UNPACK_BUFFER` offsets.
_Check:_ the KTX2 sample shows textures; `getError` is 0.

## Conformance

**GL-CTS-1 (MUST).** A subset of the Khronos WebGL 2.0 conformance suite (`conformance2/` and
`conformance/` tests for: buffers, textures (formats, tex-image-and-sub-image from typed arrays, image
bitmaps, canvases), uniforms, programs/GLSL (excluding validator-only negative tests, which the runtime
does not claim), state, misc error tests, rendering, extensions listed in GL-23, `OVR_multiview2`)
runs on the device through a small harness app and is green, with every excluded test listed with a
reason. The subset grows when a sample hits a gap.
_Check:_ harness output: pass/fail counts per directory, archived per run (M2 exit check).

## Performance-shaped requirements (binding)

**GL-PERF-1 (MUST).** Call overhead: every entry point is generated from the Khronos registry and the
WebGL IDL (no hand-written per-entry boilerplate beyond the documented special cases), and every entry
point with scalar or typed-array arguments has a V8 fast-API path. Median JS→driver overhead per call
measured by a gl-bench equivalent is ≤ Quest Browser's for the same calls on the same headset and day, and
the binding's cost per frame meets PERF-GL-1 (numbers to be captured on a headset: see the index's open
items).
_Check:_ gl-bench equivalent (`uniform1f`, `uniform4fv`, `uniformMatrix4fv`, `bindTexture`,
`bindVertexArray`, `useProgram`, `drawElements`, `bufferSubData` 64 B and 4 KB, multi-draw 16/64/256)
reports ns/call; compare in one session.

**GL-PERF-2 (MUST).** State cache: calls that would not change GL state (bind of the bound object,
`useProgram` of the current program, enable of an enabled cap, a uniform upload equal to the program's
current value for that location, `activeTexture` of the active unit, `viewport`/`scissor`/`clearColor`/
`blendFunc`/`depthMask`/… with unchanged values) do not reach the driver, observable only through
performance and the GL call recorder. The cache is invalidated correctly by everything that can change
state behind it (context switch, XR frame boundary re-attachments, `deleteX` of a bound object, program
relink).
_Check:_ the showcase's 21 redundant state sets and 18 redundant uniforms per frame (headless profile)
drop to 0 at the driver; a cache-coherency fuzz test (random call sequences vs an uncached replay) gives
identical `readPixels` results.

**GL-PERF-3 (MUST).** No per-call JS allocation in the binding on steady-state paths (no temporary arrays,
closures or objects for scalar calls, uniform uploads, binds, draws); typed arrays are passed by pointer
without copying.
_Check:_ PERF-ALLOC-1 null-app measurement with a three scene using these paths.

**GL-PERF-4 (SHOULD).** JS→native transitions per draw: the median showcase frame needs ≤ 2 transitions
per draw on average including state, against 4.8 (716 calls / 149 draws) today, if gl-bench shows that the
transition rather than the driver call dominates. The mechanism is the implementer's.
_Check:_ the transitions/draw number in the stats and the JS ms/frame it buys.

**GL-PERF-5 (MUST).** Attachment invalidation: at the end of each XR frame the runtime invalidates (GLES
`glInvalidateFramebuffer`) depth/stencil attachments of every framebuffer that targets the swapchain image
when the projection layer does not submit depth, after the app's last draw, restoring the app's binding.
The colour attachment is never invalidated.
_Check:_ a frame-end GL trace shows the invalidate; App GPU A/B on device (target: ≤ 0 ms change or
better).
