# 09. IWER host mode: the native frame record and the host backend

Scope: the contract between the native runtime and IWER host mode. IWER is the only WebXR implementation
in the runtime. The contract's JS side is defined by IWER (`packages/iwer/src/host/types.ts`:
`XRHostFrame`, `XRHostBackend`, `XRHostSwapchainOptions`, `XRHostSwapchain`, `XRHostEvent`;
`packages/iwer/HOST-INPUT.md`: `XRHostInputState` and its per-frame semantics). This file states what the
runtime must provide to satisfy it, and how the data moves without per-frame objects or copies.

Sources: the two IWER files above and `src/host/XRHostSession.ts` (for the contract's semantics, e.g. what
`runHostFrame` passes to callbacks and to `runWindowFrame`); OpenXR 1.1 (`XrPosef`, `XrFovf`, `XrFrameState`,
spaces); V8 embedder docs (external backing stores; sandbox off); IWER's open host-input decisions.

## The record

**XRF-1 (MUST).** One frame record per session, allocated once by the native runtime and exposed to JS as
typed-array views over native memory (an `ArrayBuffer` with an external backing store; the V8 sandbox is
off, JS-1). Native writes it in place each frame before the session's callbacks run; JS (the runtime's
adapter and IWER) reads it in place. No JS object is created per frame to carry frame data, and no copy of
the record is made on either side.
*Check:* PERF-ALLOC-1 shows ~0 bytes/frame on the record path; a debug build asserts the backing store
pointer is unchanged across the session.

**XRF-2 (MUST).** The record carries every field of `XRHostFrame`:
- predicted display time in the `performance.now()` clock, as a double (milliseconds; XR-LOOP-5);
- `shouldRender`;
- `viewCount` (1 or 2);
- per view 11 numbers in this order: position x y z, orientation x y z w (unit quaternion), then the
  OpenXR fov `angleLeft angleRight angleUp angleDown` in radians (left and down negative), in the base
  space;
- `localPose`: the OpenXR LOCAL space origin in the base space (x y z qx qy qz qw);
- `baseIsStage` (true when the base space is STAGE at floor level, false when the runtime fell back to
  LOCAL);
- the GL name of the colour image acquired for this frame (0 when none);
- the current display refresh rate in Hz (0 when unknown).
Positions are metres, right-handed, +Y up, −Z forward (OpenXR and WebXR agree; no conversion).
*Check:* a record round-trip test (native writer in the Linux build ↔ IWER's `runHostFrame` in Node with
the record handed as the `XRHostFrame`): known poses/fovs give the expected `XRView.transform.matrix` and
`projectionMatrix` (OpenXR asymmetric-fov projection with the session's `depthNear`/`depthFar`).

**XRF-3 (MUST).** Base space: the runtime locates views and input in one base space for the whole session:
STAGE when the runtime provides one, LOCAL otherwise, and sets `baseIsStage` accordingly. LOCAL's pose in
the base space is updated every frame, so a recenter moves `local`/`local-floor` (XR-SPACE-*).
*Check:* recenter during XR moves `local` and `local-floor` but not `bounded-floor`.

**XRF-4 (MUST).** Layout is defined once in a machine-readable form from which both the C++ writer
offsets and the JS reader offsets are generated; the record starts with a layout version number, and the
runtime refuses to start a session (logging both versions) if the JS adapter and native writer disagree.
*Check:* change the version on one side in a test build; session start fails with the message.

**XRF-5 (MUST).** Precision: time is float64. Poses and fovs may be float32 or float64 (documented);
whichever is chosen, a pose at 50 m from the origin keeps sub-millimetre precision.
*Check:* unit test.

**XRF-6 (MUST).** Lifetime: the record (and the input states, XRF-IN-*) is valid from swapchain creation to
session end. After `end`, JS references to its views must not crash if read (the memory stays mapped until
the next session or exit, or the views are detached and read as length 0).
*Check:* read a saved view after `end`: no crash.

**XRF-7 (SHOULD).** The record reserves space (and a flags word) for later per-frame data so that adding
it does not change existing offsets: depth/motion swapchain image names (XR-DEPTH-1), a way to tell JS
that the detected planes/meshes changed, eye-gaze pose, per-view recommended viewport scale.
*Check:* layout review.

## Input states

**XRF-IN-1 (MUST).** Each frame before IWER's frame start, the runtime fills the two `XRHostInputState`s
(left, right) exactly as HOST-INPUT.md defines: `mode`, target-ray and grip poses with validity, palm pose
with validity, 10 button value/pressed/touched slots in the gamepad index order of the current mode, 4 axes
(WebXR sign: +x right, +y toward the user), 25 joints × (pose 7 + radius) with per-joint validity, all in
the base space. Writes during a frame apply to the next frame.
*Check:* the HOST-INPUT semantic tests in IWER pass with states filled by the runtime's adapter from a
recorded OpenXR input trace.

**XRF-IN-2 (MUST, decision pending).** No per-frame copy of input data on the JS side. Preferred: IWER's
`XRHostInputState` arrays are views onto the native record (an IWER change: allow the host to supply the
backing typed arrays when enabling host input). Fallback if IWER keeps owning them: one `TypedArray.set`
per field per frame from the native record, costing ≤ 5 µs per frame on Quest 3 and allocating nothing.
*Check:* the choice is recorded; per-frame input cost measured by the micro-benchmark.

**XRF-IN-3 (MUST).** `pressed` decisions (thresholds, hysteresis) are made by the runtime, not by IWER
(HOST-INPUT: IWER takes buttons verbatim); see IN-3.
*Check:* covered by IN-3.

## The host backend (what the runtime implements for IWER)

**XRF-B-1 (MUST).** `beginSwapchain(options)` creates the swapchain per XR-SC-1 from `arraySize`, `scale`,
`format`, `foveation` (and later `passthrough`, `unpremultiplied`, `scene`) and returns `width`, `height`,
`arraySize`, the supported `rates`, current `rate`, `hasStage` with `stageWidth`/`stageDepth`, and the
`foveation` actually applied; returns `null` (IWER throws `OperationError`) if creation fails, with the
OpenXR error logged.
*Check:* device test of both array sizes; induced failure (absurd scale) yields `OperationError`.

**XRF-B-2 (MUST).** `endSession()` (the page ended its WebXR session) drops the swapchain and returns to
the idle presentation (XR-IDLE-1); the OpenXR session keeps running (XR-LIFE-5, XR-IDLE-3). The OpenXR
session ends only on the system's request (`STOPPING`/`EXITING`/`LOSS_PENDING`) or when XR-LIFE-5's or
XR-LIFE-7's timeout requests exit. `requestFrameRate(rate)` asks the display (false when refused);
`setFixedFoveation(level)` applies XR-FOV-1; `getOpaqueColorTexture()` returns the session's single
colour `WebGLTexture` (XR-SC-2); `wrapTexture(name)` wraps a raw GL texture name for the `XRWebGLLayer`
path; `runWindowFrame(time)` runs window rAF callbacks (TMR-5) and **ignores its `time` argument**: IWER
passes the predicted display time, which lies in the future, while window callbacks get the frame's start
time on the `performance.now()` clock (TMR-4, TMR-5; if open question 12 changes what IWER passes, this
note is revisited); `postTask(cb)` queues a task (LOOP-1);
`autoGrantOfferedSession` follows XR-LIFE-2; `invalidateDepth` follows GL-PERF-5 for `XRWebGLLayer`.
*Check:* IWER host-mode tests run against the runtime's backend in Node with fake natives (the headless
runner) and on device.

**XRF-B-3 (MUST).** The runtime forwards OpenXR events with `dispatchHostEvent`: `visibilitychange`
(`visible`, `focused` from XR-LIFE-4), `frameratechange` (`rate`), `referencespacereset`, `end`
(system-initiated end).
*Check:* each event observed in a device test.

**XRF-B-4 (MUST).** The runtime calls IWER's `runHostFrame(record)` once per rendered frame inside the
window of XR-LOOP-1, and never re-enters it. `session.end()` inside a callback lands after the frame
(IWER flags it; the runtime completes the frame then ends).
*Check:* covered by XR-LIFE-5.

## IWER as shipped in the runtime

**XRF-P-1 (MUST).** The runtime bundles IWER through its host entry point, which excludes the emulator-only
parts (remote control, action recording/playback, native-override and the layers polyfill, dev UI). The
whole runtime JS prelude, minified, is no larger than 1.3 MB.
*Check:* size report in CI.

**XRF-P-2 (MUST).** If the packaged app also contains an injected IWER emulator (IWSDK's
`dev.emulator.injectOnBuild`), the packer refuses the build with a message saying how to turn it off
(PKG-6), so two WebXR implementations never compete for `navigator.xr`.
*Check:* pack the showcase with injection on: the packer fails with that message.

**XRF-P-3 (SHOULD).** Per-frame JS cost of the IWER host path (record → callbacks entered, plus the pose
queries three makes per frame) ≤ 0.15 ms median on Quest 3 with V8 15.5. Proposed budget, to be confirmed (index, question 9).
*Check:* a V8 sampling profile (CDP `Profiler`) attributing time to IWER's code over a 7-view sweep.

**XRF-P-4 (MUST).** The open IWER host-input decisions are settled before M3 and recorded here: hand
gamepad layout (IWER 2.7's 10 buttons vs Quest Browser's 5), left `menu` at index 7 by default,
`XRFrame.getPose` typed `XRPose | null`, no gaze input source while host input is on.
*Check:* this section updated with the decisions.
