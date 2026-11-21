# 08. OpenXR session lifecycle, the frame loop, swapchains and the WebXR session it backs

Scope: the native side of WebXR. The JS-visible WebXR object model is IWER host mode (one WebXR
implementation); this file states what the native runtime must do so that IWER's sessions
behave like Quest Browser's. The exact record IWER reads is in [09](09-iwer-host-frame-record.md); input in
[10](10-input.md).

Sources: OpenXR 1.1 specification (§10 session lifecycle, §10.4 frame synchronisation, §10.5 frame
submission, §9 swapchains, §7 spaces, §12 composition layers) and extensions `XR_KHR_android_create_instance`,
`XR_KHR_loader_init(_android)`, `XR_KHR_opengl_es_enable`, `XR_FB_display_refresh_rate`, `XR_FB_foveation`,
`XR_FB_foveation_configuration`, `XR_META_foveation_eye_tracked` (later), `XR_FB_swapchain_update_state`,
`XR_FB_color_space`, `XR_EXT_performance_settings`, `XR_FB_composition_layer_settings`,
`XR_KHR_composition_layer_depth`, `XR_FB_space_warp`, `XR_FB_passthrough`, `XR_META_performance_metrics`;
WebXR Device API, WebXR Layers API Level 1, WebXR Hand Input, WebXR Gamepads Module; IWER host-mode types
(`packages/iwer/src/host/types.ts`) and `HOST-INPUT.md`; device measurements of the showcase app on Quest 3
(72 Hz hold, A/B against Quest Browser); Chromium's WebXR sources (`xr_session.cc`, `xr_system.cc`,
`xr_frame_provider.cc`) for the browser behaviour noted in XR-INIT-3, XR-RATE-1 and XR-LOOP-5; IWSDK `packages/core` (`XRLayerSystem`,
the world initializer's `xr.offer` option) and its `layers` example; IWER `src/host/XRHostWebGLBinding.ts`.

## Instance, system, extensions

**XR-INIT-1 (MUST).** The runtime creates one OpenXR instance through the Khronos loader with the
Android loader-init and instance-create structures (VM and activity), enabling `XR_KHR_opengl_es_enable`
and every optional extension it uses only when enumerated. Missing optional extensions degrade
features (logged once), never fail startup.
_Check:_ the LOG-2 line lists the enabled extensions; a run with an extension artificially withheld
(debug switch) still enters XR.

**XR-INIT-2 (MUST).** The GLES 3.2 context is created against the requirements from
`xrGetOpenGLESGraphicsRequirementsKHR` and bound to the session; no window surface is needed while in XR
(a tiny pbuffer or surfaceless context is fine).
_Check:_ boot log; no EGL errors.

**XR-INIT-3 (MUST).** `navigator.xr.isSessionSupported('immersive-vr')` resolves true when an HMD system
exists; `'inline'` always resolves true (WebXR: inline sessions are always supported; Chromium does the
same), and inline sessions are IWER's with no native support beyond window rAF (TMR-5); `'immersive-ar'`
resolves true only when passthrough is available and the AR feature set is implemented (later milestone,
XR-AR-*).
*Check:\* runtime test of the three answers; `immersive-vr` true on device.

## Session lifecycle (OpenXR state ↔ WebXR)

**XR-LIFE-1 (MUST).** `requestSession('immersive-vr', init)`: required features not supported reject with
`NotSupportedError`; optional unsupported ones are dropped; `enabledFeatures` lists what was granted.
Supported at M3: `viewer`, `local`, `local-floor`, `bounded-floor`, `layers`, `hand-tracking`, and the
Quest Browser foveation-level feature strings; `plane-detection`, `mesh-detection`, `anchors`, `hit-test` and
`depth-sensing` only when the native side reports support for each (XR-PERM-1). A second request while one session is active rejects with
`InvalidStateError`. User activation is not required (there is no page gesture in a packaged app).
_Check:_ IWER host-mode tests plus a device test of each case.

**XR-LIFE-2 (MUST).** `offerSession(mode, init)` (IWSDK calls it at boot unless `xr.offer` is `'none'`):
by default the offer is granted as soon as the OpenXR session is ready (IWER host mode's
`autoGrantOfferedSession`); the app is already immersive and there is no "Enter VR" button. A config
switch (and its launch-extra override, PKG-CFG-3) selects _explicit-grant mode_: the offer is held and the
runtime stays in the idle presentation (XR-IDLE-1) until JS calls one grant function the runtime
documents, which grants the offer through IWER's `grantOfferedSession()`. The use is attaching DevTools or
a test driver and setting things up (breakpoints in session-start code, probes) before the session starts,
without changing the bundle. Our perf tool does not use this mode; it holds the offer with its own
injected script (DBG-STAGE).
_Check:_ the showcase enters XR with no user action; the same APK launched with explicit-grant mode on
stays in the idle presentation for 10 s (no session, window rAF running), then an `eval` that calls the
documented grant function enters the session within 5 s; calling it with no offer pending is a no-op.

**XR-LIFE-3 (MUST).** The native session follows OpenXR's state machine: `xrBeginSession` on `READY`,
frame loop while `SYNCHRONIZED`/`VISIBLE`/`FOCUSED`, `xrEndSession` on `STOPPING`, instance teardown or
re-creation on `LOSS_PENDING`, process exit on `EXITING`. Every state change is logged.
_Check:_ logs across doff/don, system menu, quit.

**XR-LIFE-4 (MUST).** WebXR `visibilityState` maps from OpenXR: `FOCUSED` → `visible`, `VISIBLE` →
`visible-blurred` (system UI over the app), `SYNCHRONIZED`/`STOPPING`/idle → `hidden`; each change fires
`visibilitychange` once. While `hidden` the session's rAF callbacks do not run (as in browsers); while
`visible-blurred` they run and input sources are removed silently (HOST-INPUT semantics).
_Check:_ open the system menu during XR: `visible-blurred`, frames continue, sources gone; close it:
`visible`, sources return without spurious select events.

**XR-LIFE-5 (MUST).** `session.end()` called by the app: if called inside a frame callback the current
frame is finished and submitted first; `end` fires once; the swapchain is freed; the runtime then shows
the idle presentation (XR-IDLE-1) and keeps the OpenXR session running, so a later `requestSession` or
`offerSession` starts a new WebXR session at once. If no new WebXR session is requested within a
configurable grace period (default 2 s; decision pending, README open question 11), the runtime requests
exit (`xrRequestExitSession`) and the app closes to the system home, so the user is never left in an
empty scene. A system-initiated end (quit, `EXITING`, `LOSS_PENDING`) fires the same `end` and never
calls back into a dead session.
_Check:_ call `end()` inside a rAF callback and from a timer; both end cleanly; a `requestSession` within
the grace period re-enters; with no re-request the app exits to home after the grace period.

## Before the first WebXR frame and between sessions (no flat panel)

The runtime has no 2D panel mode in this release: every app is an immersive-start VR app (PKG-8).
Earlier drafts said "flat panel" or "flat frames" for this state; it is now called the _idle
presentation_.

**XR-IDLE-1 (MUST, with a SHOULD part).** From the moment the OpenXR session is running until the first
WebXR frame (boot, module compile, a held offer), and between WebXR sessions (XR-LIFE-5), the runtime keeps
submitting OpenXR frames: the loading screen (the app's splash image and a spinner as quad layers, PKG-CFG-2)
over a background of the runtime's own, an opaque layer (black or a configured colour) or, for a contextual
background, a passthrough layer while the user comes from passthrough. With the splash off the background alone.
No such frame is left without an opaque or passthrough layer: what the system shows behind one is not the app's
choice. The app's first projection layer hands over (a short cross-fade). No app JS runs in this loop other than
window rAF callbacks and tasks.

- MUST: the system never reports the app as unresponsive and never closes it, even while one long
  synchronous JS task occupies the main JS thread (evaluating the showcase's 6.8 MB entry chunk, which
  took ~6 s to compile in the headless runner, or IWSDK's `World.create`); and whenever the main JS thread
  is free between tasks, frames run at the display rate.
- SHOULD: frames keep coming at the display rate during such long JS tasks too (the loading screen stays
  steady). This means idle-presentation frames must not wait for the JS thread; which thread issues them is
  the implementer's choice within OpenXR's threading rules (PROC-1).
  _Check:_ launch the showcase cold: no system "not responding" prompt or close during boot; `stats` boot
  marks show frames submitted before the first WebXR frame, and the stats report the longest gap between
  submitted frames during boot (recorded; SHOULD target ≤ 2 frame periods); a recording of a launch shows the
  splash and spinner on the configured background until the app's first frame, with no empty frame.

**XR-IDLE-2 (MUST).** In the idle presentation, window `requestAnimationFrame` is driven by the OpenXR
frame loop (one callback round per `xrWaitFrame`, at the display rate; TMR-5). `window.innerWidth/
innerHeight` and canvas drawing buffers keep fixed, documented values (DOM-3); drawing to a WebGL
context's default framebuffer here is allowed and is not displayed.
_Check:_ window rAF count per second equals the display rate before entering XR.

**XR-IDLE-3 (MUST).** Moving between the idle presentation and a WebXR session needs no new OpenXR
session, no new GL context and no app reload; the first WebXR frame follows the grant within two display
frames.
_Check:_ boot marks "session granted" → "first XR frame" ≤ 2 frame periods.

**XR-LIFE-7 (MUST, decision pending).** An app that never offers or requests an immersive session (IWSDK
with `xr.offer: 'none'` or `xr: false`, or an app that waits for a click on a DOM "Enter VR" button that
cannot be pressed here) must not leave the user in black indefinitely. If no session has been offered or
requested 10 s (configurable) after the entry module finished evaluating, the runtime logs one error line
that names the likely causes (no `offerSession`/`requestSession`; for IWSDK, `xr.offer`) and counts it in
`stats`; if there is still none 30 s after the entry finished (configurable; README open question 11), it
exits to home as XR-LIFE-5 does. A held offer (XR-LIFE-2) counts as offered. The exit step is skipped
when the build serves the inspector or the debug endpoint (debug builds, and builds packed with the
inspector flag such as our perf tool's staged build, whose injected script holds the offer where the
runtime cannot see it; DBG-STAGE); the error line is still logged. The developer page (PKG-14) states that apps
must offer or request a session on their own.
_Check:_ pack a test app built with IWSDK `xr.offer: 'none'` as a plain release build: the error line
appears at ~10 s and the app exits to home at the timeout; as a debug build it logs the line and stays; the
showcase never logs the line.

**XR-LIFE-6 (SHOULD).** Session start applies, before the first frame: the colour space (Rec. 709 /
the browser's choice, via `XR_FB_color_space`), the configured or app-requested refresh rate, foveation
(XR-FOV-1), and performance levels (XR-PERF-1).
_Check:_ the first VrApi line after entering XR shows the chosen rate, foveation level and CPU/GPU levels.

## The frame loop

**XR-LOOP-1 (MUST).** Per XR frame, in this order (the JS steps on the main JS thread; which native thread
issues the OpenXR and GL calls is the implementer's choice, PROC-1): `xrWaitFrame` → `xrBeginFrame` →
locate views (and input, [10](10-input.md)) for the predicted display time → acquire and wait the
swapchain image → write the frame record ([09](09-iwer-host-frame-record.md)) → invoke, through IWER, the callbacks the session has queued, then window rAF callbacks → frame-end GL work (invalidation GL-PERF-5, re-pointing
for the next frame if needed) → release the image → `xrEndFrame` with the layers and the same predicted
display time. No JS runs between release and `xrEndFrame`.
_Check:_ a GL/XR call trace for one frame in the debug build matches the order.

**XR-LOOP-2 (MUST).** When `xrWaitFrame` reports `shouldRender = false`, the runtime calls `xrBeginFrame`
and `xrEndFrame` with no layers and does not run session rAF callbacks (window rAF and tasks still run).
_Check:_ induce it (proximity off / system overlay transitions); no callbacks for those frames, no
OpenXR validation errors.

**XR-LOOP-3 (MUST).** Exceptions thrown by an XR rAF callback are reported (LOOP-4 path) and do not skip
the rest of the frame: later callbacks run and the frame is submitted.
_Check:_ a callback that throws every frame; frames continue at full rate.

**XR-LOOP-4 (MUST).** Frame pacing: tasks, timers, GC work and code-cache writes run after `xrEndFrame`
and before the next `xrWaitFrame` returns, so they do not delay a frame's JS (see PERF-JS-*). Observable
outcome: garbage-collection pause time falls mostly outside the frame callbacks (PERF-GC-1), and no frame
is late because of GC or code-cache work. How this is achieved is the implementer's choice within V8
15.5's public embedder API, documented with the runtime.
*Check:\* the DBG-STATS GC pause split shows ≥ 95 % of pause time outside frame callbacks; no stale frames
attributable to GC over a 5-minute run (VrApi stale 0).

**XR-LOOP-5 (MUST).** The frame record's predicted display time (09) is OpenXR's predicted display time
converted to the `performance.now()` clock (TMR-4), strictly increasing, and is what
`XRFrame.predictedDisplayTime` returns. The `time` argument of session rAF callbacks is whatever IWER host
mode passes; today that is the same predicted display time. Quest Browser instead passes the frame's start
time and exposes the prediction only as `predictedDisplayTime`. Whether IWER should match Quest Browser is
README open question 12; until it is decided, the check below is written for the predicted time.
_Check:_ recorded deltas equal the refresh period ± jitter, never ≤ 0; at callback entry `time −
performance.now()` lies between −1 and +3 frame periods.

## Swapchain and projection layer

**XR-SC-1 (MUST).** The first projection layer created by the session (`XRWebGLBinding.
createProjectionLayer` or `new XRWebGLLayer`) creates the swapchain: `textureType: 'texture-array'` → one
swapchain with `arraySize = 2` (multiview); `'texture'` → one swapchain with both eyes side by side;
size = recommended per-eye size × `scaleFactor` (clamped to the maximum); 1 mip level, sample count 1
(MSAA comes from the multisampled multiview attachment, GL-24). The colour format renders colours that
match Quest Browser (verify with XR-COL-1). Later layers in the same session reuse it.
_Check:_ LOG-2 swapchain line; three's render target sizes equal Quest Browser's for the same
`scaleFactor` (compare `layer.textureWidth/Height`).

**XR-SC-2 (MUST).** `XRWebGLBinding.getViewSubImage(layer, view)` returns, for each eye, a sub-image
whose `colorTexture` is **one stable `WebGLTexture` object per session** that always refers to the image
acquired for the current frame (browsers hand out one opaque texture), `imageIndex` 0/1 for
texture-array, `viewport` the full layer (texture-array) or that eye's half ('texture'). Framebuffers the
app attached that texture to keep rendering into the current image every frame without the app
re-attaching. `depthStencilTexture` is `null` when the layer has no depth swapchain.
_Check:_ an app that attaches once at session start renders every frame to the right image (no
flicker, the symptom of rendering into a stale image); XR screenshots on 10
consecutive frames all show the scene.

**XR-SC-3 (MUST).** `XRWebGLLayer` fallback (no layers feature): `framebuffer` is an opaque framebuffer
whose colour is the current swapchain image, `framebufferWidth/Height`, `getViewport(view)` side by side,
`ignoreDepthValues` true unless depth is submitted, `fixedFoveation` settable; drawing to it outside a
frame callback is ignored, as WebXR specifies for opaque framebuffers.
_Check:_ a three app with `layers` not requested renders in both eyes.

**XR-SC-4 (MUST).** Exactly one projection layer per frame for a VR session, with both views' pose and fov
taken from the same `xrLocateViews` result that was handed to JS for that frame, plus the session's quad
and cylinder layers (XR-LAYER-1) in `renderState.layers` order.
_Check:_ a fixed cube does not swim when the head moves (human check on device, once per milestone);
`xrEndFrame` validation layer clean.

**XR-LAYER-1 (MUST).** Quad and cylinder composition layers (WebXR Layers), as IWSDK core's `XRLayerSystem`
uses them for entities with `XRQuadLayer`/`XRCylinderLayer` components. `XRWebGLBinding.createQuadLayer` /
`createCylinderLayer` (IWER host mode, `layers` feature enabled) create one OpenXR swapchain per layer, sized
`viewPixelWidth` × `viewPixelHeight` per view: layout `mono`, `stereo-left-right` (side by side), `stereo-top-bottom`
(left eye on top) with `textureType: 'texture'` (`stereo` resolves to side by side), `mono` (a 1-layer array) or
`stereo` (a 2-layer array) with `'texture-array'`; `isStatic` makes a static swapchain drawn in one frame (every view,
any number of `getSubImage` calls in that frame; `needsRedraw` goes false when the frame ends); 1 mip level.
`blendTextureSourceAlpha` defaults to true, as in Chromium and the WebXR Layers polyfill. The layer keeps its own copy
of the `transform` it is given (init or attribute); `space` and `transform` take only an `XRSpace` and an
`XRRigidTransform` (TypeError otherwise), and a layer whose pose cannot be worked out is left out of the frame, not the
whole list. `getSubImage(layer, frame,
eye)` returns the view's sub-image, whose `colorTexture` is one `WebGLTexture` per layer that refers to the image
acquired for that layer this frame (as XR-SC-2 for projection layers), and clears it to transparent black on the first
access of a frame unless `clearOnAccess` is false. The runtime keeps one image acquired per layer; the image of a layer
the page drew in a frame (`getSubImage`) is released once the frame's GL work is fenced and becomes its content, and a
layer the page does not draw keeps showing its last content. Each frame submits `renderState.layers` in order around
the projection layer: `XrCompositionLayerQuad` (size = twice WebXR's `width`/`height`, which are half-extents as in
Quest Browser and the WebXR Layers polyfill) and `XrCompositionLayerCylinderKHR` (`radius`, `centralAngle`,
`aspectRatio`), one per eye (`eyeVisibility`) for stereo layouts, posed from the layer's `space` and `transform` at the
frame's predicted display time in the base space (in the VIEW space for a layer in the viewer reference space),
`blendTextureSourceAlpha` as `XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT` (premultiplied). When layers are
listed before the projection layer, the projection layer blends by its alpha too (Chromium blends projection layers by
default), so they show through its transparent pixels; otherwise it stays opaque in `immersive-vr`. A session that shows
only quad or cylinder layers (no projection layer) ends the loading screen like a projection frame. A layer without
content yet, an unlocated space or a shape OpenXR rejects is left out of that frame; the compositor's layer limit
(`maxLayerCount`) cuts the end of the list. `destroy()` releases the swapchain; the session's end releases all.
Equirect and cube layers are absent (IWSDK does not use them).
_Check:_ proto-layers (IWSDK 1.0.0 and 1.1.0) runs on device at full rate with no exception, its quad and cylinder
layers submitted every frame (`xr.layers` in DBG-STATS, LOG-2's layer swapchain lines); a system capture (Meta's
capture service, which unlike DBG-SHOT includes composition layers) shows them, and shows each eye its region of
every stereo layout.

**XR-COL-1 (MUST).** Colour parity: a test scene with known sRGB patches (three, `outputColorSpace =
SRGBColorSpace`) shows the same encoded values in an XR screenshot of the runtime and of Quest Browser
on the same headset, ±2 per channel.
_Check:_ DBG-SHOT readback vs a Quest Browser capture through the same readback path where possible, or
the compositor mirror for both.

## Refresh rate, foveation, performance levels

**XR-RATE-1 (MUST).** `session.supportedFrameRates` (`Float32Array`) from the display's list,
`session.frameRate`, `updateTargetFrameRate(rate)` resolves after the runtime confirms the change (and
fires `frameratechange`), and rejects with `InvalidStateError` after end and for a rate not in the list
(as Quest Browser does).
_Check:_ request 90 then 72; both resolve; VrApi line shows the rate.

**XR-FOV-1 (MUST).** `fixedFoveation` (0..1) on projection layers and `XRWebGLLayer` maps to the
runtime's fixed foveation levels (none/low/medium/high) through `XR_FB_foveation` profiles applied to the
swapchain; the Quest Browser feature strings `low-`/`medium-`/`high-fixed-foveation-level` set the initial
value; a config default applies when the app sets nothing. Foveation is applied before the first frame is
submitted. Reading `fixedFoveation` returns the value set (or the effective one if the runtime overrode
it).
_Check:_ VrApi `Fov` field changes with the setting; the first VrApi line shows the configured level.

**XR-PERF-1 (MUST).** CPU/GPU performance levels start at the level Quest Browser uses for the same
content (CPU level 2 in the baseline measurements; GPU per the runtime default), and adapt upward on missed
frames over a window (and back down after sustained headroom) through `XR_EXT_performance_settings`; they
are never pinned at the maximum by default. (Regression guard: pinning CPU level 4 costs power and heat for nothing; GAP-6.)
_Check:_ the showcase holds 72 Hz with VrApi showing CPU level ≤ 2 throughout a 7-view sweep
(PERF-LVL-1); forcing a heavy view raises the level within 2 s and stale frames stop.

**XR-PERF-2 (SHOULD).** A thermal/performance notification from the runtime (`XR_EXT_performance_settings`
events) is logged and reflected in the stats line.
_Check:_ log line when the runtime reports a level change.

## Reference spaces

**XR-SPACE-1 (MUST).** `viewer`, `local`, `local-floor`, `bounded-floor` behave as in Quest Browser:
`local` origin at the head position and yaw at session start (follows recenter); `local-floor` has the same horizontal origin and heading as `local`, with its origin height at the floor (from the stage; if no stage is defined, an estimated floor —
the documented default — below `local`); `bounded-floor` is the stage with `boundsGeometry` (at least 4 floor points in clockwise order viewed from above, as WebXR requires) and is unsupported (request rejects) if no boundary is set;
`unbounded` rejects with `NotSupportedError`. `getOffsetReferenceSpace` composes transforms.
_Check:_ stand at a marked spot facing a marked wall, launch: an object at (0, 0, −1) in `local-floor` sits
on the real floor 1 m ahead (human check, once per milestone); compare `getViewerPose(local-floor)` height
with Quest Browser on the same spot (±2 cm).

**XR-SPACE-2 (MUST).** Recenter (`XR_TYPE_EVENT_DATA_REFERENCE_SPACE_CHANGE_PENDING`) fires `reset` on
each affected reference space (with `transform` when known) and `local`/`local-floor` follow the new
origin from the next frame.
_Check:_ long-press the Meta button to recenter during XR; `reset` fires once per live space.

## Depth, Space Warp, AR (later milestones, recorded now)

**XR-DEPTH-1 (SHOULD, after M6).** A depth swapchain and `XR_KHR_composition_layer_depth` submission when
the layer requests depth and the app writes it, keeping the path to `XR_FB_space_warp` (motion vector +
depth swapchains) open: nothing in the frame record or swapchain management may assume one colour image
only.
_Check:_ design review of the record (XRF-\*) shows room for depth/motion texture names.

**XR-AR-1 (MUST for `immersive-ar`; MAY, later, for the rest).** `immersive-ar` over `XR_FB_passthrough`
(passthrough composited beneath the app's projection layer, blended by alpha; `environmentBlendMode
'alpha-blend'`) for apps that declare passthrough: the packer writes `xr.immersiveAr: true` into the runtime config
when the resolved features include passthrough (`world.xr.mode: "ar"` implies it), and only then is
`isSessionSupported('immersive-ar')` true. `plane-detection`/`mesh-detection` and `hit-test` from the scene model
(XR-AR-2); `anchors` (XR-ANCHOR-1).
_Check:_ packer tests (`xr.immersiveAr` with and without passthrough); a device run of an AR sample gets past
`isSessionSupported`.

**XR-PERM-1 (MUST).** Android runtime permissions (protection level "dangerous": `com.oculus.permission.USE_SCENE`
for planes, meshes, hit test and depth; `android.permission.CAMERA` and `horizonos.permission.HEADSET_CAMERA` for the
passthrough cameras) are asked for when first needed, not at launch. A feature that needs one is grantable only when
the native side reports support for it (`capabilities()`); before a session gets such a feature the runtime asks for
the permission through the system dialog (`Activity.requestPermissions`), once per process (a later page or a reload
only re-checks it, so a grant made in Settings counts): granted, the feature is granted; denied, a required feature
rejects the request with `NotSupportedError` and an optional one is dropped. A permission the manifest does not
declare is never asked for and reads as denied (the error names the manifest). Android drops a request made while
another is in flight, so the runtime keeps one in flight and asks for what came meanwhile in the next one. No dialog
for a request that fails anyway (unsupported mode or required feature, an active session), and none for a non-immersive
session: as in Quest Browser, `plane-detection`, `mesh-detection`, `hit-test`, `anchors`, `depth-sensing`,
`hand-tracking`, `layers`, `bounded-floor` and `unbounded` are for immersive sessions only (required: rejected;
optional: dropped). Session requests reach IWER in call order, so one waiting for the dialog is not overtaken by a later
one. NativeActivity does not forward `onRequestPermissionsResult`, so the runtime polls `checkSelfPermission` and takes
the dialog as answered when the app gets its input focus back; there is no time limit while the dialog is up. Other
runtime code asks through the same function (`__iwnXR.requestPermissions`). Install-time permissions
(`USE_ANCHOR_API`, hand tracking) need no dialog; eye tracking (`com.oculus.permission.EYE_TRACKING`, on newer OS
versions also `horizonos.permission.EYE_TRACKING`) is a runtime permission and must be asked for like the others once
gaze tracking is granted.
_Check:_ web/xr tests (granted, denied, required, optional, asked once, undeclared, inline, request order, overlapping
requests); host tests of the wait and of the request order; a device run with the permission not granted at install.

**XR-AR-2 (MUST when offered).** `plane-detection`, `mesh-detection` and `hit-test` come from the headset's room
(Space Setup), read with `XR_FB_spatial_entity`, `XR_FB_spatial_entity_query`, `XR_FB_spatial_entity_container`,
`XR_FB_scene` and `XR_META_spatial_entity_mesh`; they are granted only when the runtime has those extensions
(`capabilities()` `planeDetection`, `meshDetection`, `hitTest`), and `com.oculus.permission.USE_SCENE` is asked for
before a session gets them (XR-PERM-1). The room is queried when a session wants any of the three, again when the app resumes
and after a scene capture completes; Space Setup is never started by the runtime. Quest completes a query that finds
no room with success (an empty scene); one that completes with an error, or whose results or rooms' contents cannot
be read, failed (status `failed` with the error: `USE_SCENE` not granted, or the spatial-data service refusing the
package), and the last room stays published until a query succeeds. The runtime hands out the same space handle again
for an entity already loaded, so a re-query keeps those handles alive. Every entity is located in the base space for
each frame handed to JS, through a pose table of its own (the frame record is unchanged, XRF-4). As in Quest
Browser: an entity with a 2D boundary is a plane (`semanticLabel` from its scene label: `floor`, `wall`,
`ceiling`, `table`, `couch`, `door`, `window`, `shelf` for storage, `bed`, `screen`, `lamp`, `plant`,
`wall art`, `other`; orientation from its normal), one with a 3D bounding box is a mesh of that box, and the
room mesh is a mesh labelled `global mesh`. Hit test (`requestHitTestSource`,
`requestHitTestSourceForTransientInput`) casts each source's ray into those planes (inside the polygon) and
meshes, also without plane or mesh detection; results are nearest first, posed with +Y along the surface normal.
As in Quest Browser, mesh triangles are hit on their front face only (counter-clockwise seen from the ray, so a ray
from inside a furniture volume does not hit the inside of its box), and a source without `entityTypes` hits the
global mesh alone when the room has one, else the planes (WebXR's default entity type). A room mesh's
bounding-volume tree is built a slice per frame after the room arrives; until it is ready the mesh is left out.
Without a room, or with `com.oculus.permission.USE_SCENE` missing from the manifest, the lists are empty and hit
tests find nothing (not granted: XR-PERM-1); Quest Browser instead hits a 10 x 10 m stage floor plane (or uses
`XR_META_environment_raycast`), which the runtime does not do: no surface is made up (environment raycast is the
later path). Without
`com.oculus.permission.USE_ANCHOR_API` in the manifest the runtime offers none of the scene extensions, so the
three features are not offered at all (required: `NotSupportedError`); the packer declares both permissions for
each of them.
_Check:_ IWER host-mode tests (hit test), web/xr tests (planes, meshes, labels, hit test, empty room), host tests of
the scene model against a fake runtime (`iwn_xr_android_tests`: re-query, failed query, teardown), a device run
reading `__iwnXR.scene()` and the `xr.scene` stats section.

**XR-ANCHOR-1 (MUST, when the headset has spatial anchors).** `anchors` is granted, in `immersive-vr` and
`immersive-ar` sessions, when the runtime offers `XR_FB_spatial_entity` and the system reports spatial-entity support;
persistence also needs `XR_FB_spatial_entity_storage` and `XR_FB_spatial_entity_query`. Without the feature every
anchor call rejects with `NotSupportedError`. `XRFrame.createAnchor(pose, space)` (and
`XRHitTestResult.createAnchor()`) creates a spatial anchor at that pose in the base space, at the frame's display
time; the promise settles in a frame after the system's completion event, and rejects with `OperationError` when the
system refuses (Horizon OS places anchors only with 6DoF tracking). Every frame handed to JS carries each live
anchor's pose, located at the frame's predicted display time and delivered in a buffer of its own (not the frame
record, XRF-*); an anchor the system cannot locate has no pose that frame. `anchor.delete()` destroys the anchor,
and a session's anchors are destroyed when it ends. Persistent anchors follow Quest Browser:
`anchor.requestPersistentHandle()` saves the anchor to the system's local anchor storage and resolves with its UUID
(the same UUID on every call; after the anchor's session ended or the anchor was deleted it rejects with
`InvalidStateError`), `session.persistentAnchors` lists the UUIDs this app persisted (kept in localStorage's runtime
entries, which the page cannot see or clear, as Quest Browser keeps them per origin),
`session.restorePersistentAnchor(uuid)` loads one by UUID (an unknown or malformed UUID rejects with
`InvalidStateError`), and `session.deletePersistentAnchor(uuid)` erases it, also an anchor restored in this session or
never loaded (its storable component is enabled first), and forgets it when the system has no such anchor; a delete
while the same UUID is being restored rejects with `InvalidStateError`, as in Quest Browser. UUIDs compare in lower
case. A refused creation's space is destroyed with it. At most 64 anchors live at a time. The
manifest needs `com.oculus.permission.USE_ANCHOR_API` (a normal permission, no prompt), which the packer adds for the
`anchors` feature.
*Check:\* web/xr and IWER host-mode tests of each call; host tests of the XR-thread side against a fake runtime
(`iwn_xr_android_tests`: erase of a restored anchor, erase then delete, refused creation, restore and erase at once);
device: grant, refusal and persistence paths without tracking; create, locate, persist, relaunch and restore by UUID
on a headset that tracks in 6DoF.

**XR-DEPTH-2 (SHOULD).** `depth-sensing` is granted when the system has `XR_META_environment_depth` (`capabilities()`
`depthSensing`), for `immersive-ar` and `immersive-vr` sessions, as Quest Browser offers it:
usage `gpu-optimized` only, data format `unsigned-short` (what Quest Browser 156 reports for this texture) or
`float32` (IWSDK's choice; it samples the same texture either way), not `luminance-alpha` (a packed two-byte encoding
this texture does not have); the page's `depthSensing` preferences are matched in order, and with no match a required
`depth-sensing` rejects with `NotSupportedError` and an optional one is dropped, before any permission dialog. A
request without a `depthSensing` dictionary (or with empty preference lists) gets the first usage and format offered
(`gpu-optimized`, `unsigned-short`) instead of a rejection. While such a session runs, the runtime runs one depth
provider (hand removal off, as in Quest Browser, so real hands occlude virtual content; it keeps running while the
session is hidden or stopping, until the session ends) and acquires the newest depth image for each WebXR frame's
predicted display time in the base space; the image's swapchain name, size, clip planes and per-eye depth-view pose
and FOV reach JS in a depth record of its own (the frame record is unchanged; a host test tool writes one and web/xr
reads it back field by field). `XRWebGLBinding.getDepthInformation(view)` returns, per eye, `textureType
'texture-array'`, `imageIndex` 0/1, `rawValueToMeters` 1 (metres = `depthNear / (1 - d)`, the formula IWSDK's
occlusion shaders use), `depthNear`/`depthFar` as OpenXR reports them (`depthFar` may be `Infinity`), an identity
`normDepthBufferFromNormView`, and `null` for frames without an image. With `matchDepthView` (the default, as in
Chromium) the depth is laid out in the eye's render view of this frame, as Quest Browser 156 does it: each frame a pass
on the page's WebGL 2 context carries every pixel's ray, at the far plane, into the depth view and copies the raw depth
found there (the far plane where the depth view does not reach) into a 2-layer DEPTH*COMPONENT16 texture of the
context's own, restoring all GL state it touches; the depth information then has the view's own `projectionMatrix`
and `transform`. Pages that sample depth by screen position (IWSDK) need this, because the image comes from the depth
cameras' pose at their own rate (about 30 Hz). With `matchDepthView: false` (or WebGL 1) the texture is one
session-long `WebGLTexture` re-pointed at each frame's image (NEAREST filtering), with the depth view's
`projectionMatrix` and `transform`. From the first frame that hands out depth (that frame included) until the session
ends, the framebuffers that render into the frame's image, a projection layer's or an XRWebGLLayer's, are cleared
(colour, depth, stencil) before the frame's callbacks, as a browser clears a layer's textures: three.js renders no
background, so does not clear, once it has a depth texture. The provider stops when the session ends, once a JS frame
still in flight is collected (as the colour swapchain waits); a JS frame that outlives its OpenXR frame (a long
first-sight compile) may sample an image the runtime has already released, which can show wrong occlusion in that
frame. It needs `com.oculus.permission.USE_SCENE`, asked for before the session gets the feature (XR-PERM-1); without it
the provider is refused and every frame has no depth. `XRWebGLDepthInformation` is a global in host mode.
\_Check:* web/xr and IWER host tests (negotiation, matched and raw geometry with turned heads, the reprojection pass's
state restore, the record round trip, a second session); device: proto-occlusion shows virtual objects cut by real
ones, the `xr-depth` log line reports the per-frame acquire cost. The display rate with occlusion in view follows the
page's GPU cost from frame to frame, which the live depth changes 30 times a second; Quest Browser shows the same (the
measurements are in the depth commit's test plan).

**XR-SEC-1 (MUST NOT).** No secondary views, no `dom-overlay`, and no camera access for an app that does not
declare the camera (XR-CAM-1); requesting the views or `dom-overlay` as required rejects, as optional, dropped.
Without the declaration `navigator.mediaDevices` is absent (DOM-4).
_Check:_ tests.

**XR-CAM-1 (SHOULD).** An app that declares the camera (`native.features.camera`, or IWSDK's
`world.features.camera`, PKG-8) gets `navigator.mediaDevices` over the headset's passthrough cameras (Horizon OS
Passthrough Camera API: Camera2 on the cameras the vendor tag `com.meta.extra_metadata.camera_source` marks 0,
left then right): `enumerateDevices()` lists them as `videoinput` with labels naming the side and the facing
("Left passthrough camera (id 50), facing back"), `getUserMedia({ video })` opens one at a native size and rate
chosen by the constraints (Media Capture and Streams SelectSettings, resizeMode `none`, Chromium's default ideal
640x480 at 30 Hz) and resolves a `MediaStream` whose `MediaStreamTrack` reports its settings, stops, clones and
ends (`ended` event) when the system takes the camera away; audio is not offered (`NotFoundError`); an unsatisfiable
required constraint rejects with `OverconstrainedError`, a camera the app may not use (permissions not granted)
with `NotAllowedError`. A camera opens once per app (Android disconnects an earlier open of the same camera): a
`getUserMedia` for a camera that is open shares its source in the mode it runs in, a new track on the same frames.
While the page is hidden (`document.visibilityState`) the cameras are closed and their tracks stay live with
`muted` true (`mute` event); visible again, each opens in the same mode and its tracks unmute (`unmute`); a camera
that cannot open again ends its tracks. A disabled track (`enabled = false`) renders black frames. A `<video>`
plays such a stream (`srcObject`; readyState steps, `play()`, `videoWidth`/`videoHeight`,
`requestVideoFrameCallback`), and `texImage2D`/`texSubImage2D`, `drawImage` and `createImageBitmap` take its
newest frame (GL-17), or while paused the frame it stopped at (its first if it never played); an `ImageBitmap`,
clone or transfer of a frame is a copy, so held frames never stall the camera. Frames are YUV*420_888 converted to
RGBA8 off the JS thread into AHardwareBuffers that WebGL copies on the GPU (into RGBA8 or unsized
RGBA/UNSIGNED_BYTE levels; a `texSubImage2D` that does not fit its level is `INVALID_VALUE`). The camera needs
`android.permission.CAMERA` and `horizonos.permission.HEADSET_CAMERA` (runtime permissions the user grants). Until
both are held, `enumerateDevices()` gives one `videoinput` with an empty `deviceId`, `label` and `groupId`
(Media Capture and Streams' device information exposure) and the runtime reads no camera list (Horizon OS keeps a
list read before the grant empty until the app restarts); once both are held,
`navigator.permissions.query({ name: 'camera' })` answers `granted` (DOM-4).
\_Check:* unit tests (constraints, permissions before and after the grant, shared cameras, the page's visibility,
stream/track lifecycle, disabled tracks, `<video>` playback and pause, uploads and their bounds, recycled frames
copied for keeping); proto-camera from D122713586 unchanged on a Quest 3 shows the camera feed in its mirror at
30 Hz and holds the display rate; a probe page grants at `getUserMedia` after an early `enumerateDevices`, holds
`ImageBitmap`s, opens one camera twice and sleeps the headset past a minute with a stream open.
