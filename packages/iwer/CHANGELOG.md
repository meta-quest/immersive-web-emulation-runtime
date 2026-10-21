# iwer

## 2.7.0

### Minor Changes

- Hand motion primitives for remote control (see the new "Scripting Hand Interactions" guide):
  - `anchor` on `set_transform` / `animate_to` places a point of the hand (`index-tip`, `grasp`, `wrist`, `grip`, `thumb-tip` or any WebXR joint) at `position` and pins it there: the point stays put while the hand changes pose or pinches. `grasp` is where the thumb and index tips meet in a full pinch, so placing it on an object and pinching closes both tips onto it.
  - Hand orientation by direction: `{ fingers, palm }` or `{ fingers, thumb }` (vectors or names such as `forward`, `up` and `toward-head`), or `'auto'` for a relaxed reach from the shoulder.
  - `set_select_value` and `set_hand_pose` take `duration` and `easing` to ramp the pinch or fade between poses; `animate_to` takes `easing` (`linear`, the default, or `minimum-jerk`).
  - `get_hand_state` (MCP `xr_get_hand_state`) reads a hand's pose, finger blends, pose fade, pinch, pressed state, pin, key joint positions and directions; `get_device_state` reports each hand's `poseId` and `pinchValue`, and `set_device_state` accepts them.
  - `XRHandInput` gains `beginPoseTransition()`, `poseTransitionProgress`, `poseTransitionFrom`, `setPin()`, `pin`, `anchorOffset()`, `wristRotation()` and `handAxes()`.
  - New parameters need a hand the app can see (hand input mode, connected, `hand-tracking` enabled), checked when the command reaches the head of the queue; commands without them behave as before.

  Behaviour changes:
  - Every remote position, orientation and direction, given or reported, is relative to the XR origin: the app's first reference space that is not `viewer`. This is unchanged for `local-floor` and `bounded-floor` apps. With a `local` space, `set_transform`, `get_transform`, `get_device_state`, `set_device_state` and the results of `look_at` and `animate_to` used GlobalSpace before. The `set_device_state` reset without a state still uses the floor frame.
  - A pinch now closes only the thumb and index, relative to the palm, keeping bone lengths; the wrist, the grip space and the other fingers keep the pose (before, every joint and the grip moved toward the captured `pinch` skeleton, and the wrist shifted 2.5 cm).
  - The right hand's grip space is mirrored from the left-hand data like its joints; it was about 6 cm off toward the thumb.
  - `select` on a hand closes the pinch over 0.1 s before the hold and opens it over 0.1 s after.
  - `animate_to` starts from where the device is when the animation starts, not when it was sent, and a frame's time left over after a timed command finishes goes to the next one.
  - Remote control letting go of the device (the release timeout, `forceRelease()`, any switch to manual control), the session ending and the queue watchdog drop pins and stop pose fades and ramps where they are. The DevUI picks up the device's final pose when remote control ends.
  - The `DurationAction` type is replaced by `TickAction` (`DurationAction` remains as a deprecated alias).
  - MCP: `CATALOG_VERSION` is 5. `xr_set_transform`, `xr_animate_to`, `xr_set_select_value`, `xr_set_hand_pose`, `xr_set_device_state` and `xr_get_hand_state` reject unknown parameters (top level and nested) instead of silently dropping them, and quaternion / euler objects no longer accept extra keys.

- Add a library of base hand poses (open, flat, fist, thumbs-up, finger-gun, peace, three, four, ok, rock, call, pinch-middle, pinch-ring, pinch-pinky, tripod, key-pinch, grip, claw, hook, cup) built on the captured Quest skeleton, and per-finger pose blending through `XRHandInput.setFingerPose()`. The DevUI pose stepper and hotkey cycle through `default`, `point`, `fist`, `open` and `thumbs-up` (`pinch` is left to the pinch control), and the label shows a pose set through remote control, with `*` for finger blends. `xr_set_hand_pose` lists the poses with a short description of each, notes that poses never select, accepts per-finger overrides, and rejects unknown pose ids.
- Hand microgestures, laid out as Quest Browser reports them (see "Microgestures" in the Scripting Hand Interactions guide):
  - The hand gamepad has the `xr-standard` mapping with 10 buttons: the pinch on button 0 (select, as before), empty slots on 1 to 3, the menu gesture on 4 and Quest's thumb microgestures on 5 to 9 (swipe left, right, forward, backward, and thumb tap). Only the pinch fires session events. `XRHandInput.updateGestureButton()` writes the others.
  - `microgesture { device, gesture }` (MCP `xr_microgesture`) swipes or taps the thumb on the side of the curled index finger and, as the thumb lifts, presses the gesture's button for 35 ms (always for at least one frame). A hand not in the new `microgesture` pose takes it first (0.25 s), letting go of a light pinch; a hand that is selecting must let go first. Remote control letting go mid-gesture returns the thumb and lifts the button.
  - `run_sequence` takes `{ microgesture }` steps and reports them in `events` by gesture name, from the hand's own button edges; a dry run lists them as `microgesture` segments.
  - `XRHandInput.thumbMotion` shows a thumb movement on top of the pose; the new `microgesture` pose is in `BUILTIN_HAND_POSE_IDS`.
  - MCP: `CATALOG_VERSION` is 5; `xr_microgesture` rejects unknown parameters.

  Behaviour change: the hand gamepad's `mapping` is now `'xr-standard'` (was `''`) and it has 10 buttons (was 1). Button 0 is unchanged, and hand recordings made before still replay. In native override mode hand sources still publish no gamepad, so pages don't see the gesture buttons there.

- `run_sequence` runs a whole hand interaction in one call (see "Sequences" in the Scripting Hand Interactions guide): `device.remote.runSequence()`, MCP `xr_run_sequence`.
  - Steps place the hand by an anchor at a named target or a position (XR origin, or relative to the head or the floor under the body), press targets with the index fingertip (`press`), pinch on arrival, set a held object down on a surface, fade poses and turn the hand. Each move is one smooth arc (`approach` / `depart` come straight in and lift straight off), the head turns to each target first (`gaze`), the body leans toward low targets and steps closer to ones out of reach (`body`, or a step's own `body` move), and the other hand rests by the hip (`idleHand`).
  - Every step property can be timed within its step (`{ value, start, end, easing }`); `duration: 'auto'` (the default for moves) scales with the path, the wrist turn and pose changes. Each step's end is shown for a frame and the frame's leftover time carries over, so uneven frame rates give the same motion; a press keeps the fingertip in touch for at most 0.35 s of sequence time.
  - The page resolves target names with `device.remote.setTargetResolver({ resolve, list? })`; `list_targets` (MCP `xr_list_targets`) lists them. Targets are resolved when the sequence is sent and again when their step starts; listed boxes are also obstacles the hand arcs over.
  - Sequences are validated before anything moves (strict keys, every error naming its step, targets, reach with `body: 'fixed'`, and the time budget: the sequence plus everything queued ahead must fit 25 s), need a live hand when they reach the head of the queue, and give up 28 s after they were sent. `dryRun: true` returns the expanded plan without moving.
  - The result reports the steps' times, the select events the app saw (from the hand's own button edges, in native mode too), each press's real contact time, warnings and the final hand state; a failed step reports `failedStep` and `reason`.
  - `cancel_sequence` (MCP `xr_cancel_sequence`) stops a running sequence at once, leaving the pinch as it is; `forceRelease()`, the session ending and the queue watchdog also stop one, and it resolves with its partial result instead of rejecting.
  - `iwer/lib/remote/catalog.js` publishes JSON Schema for the parameters of every remote method (`REMOTE_METHOD_SCHEMAS`), for tool hosts; the extension bridge's schemas are tested against it.
  - MCP: `CATALOG_VERSION` is 5; the new tools reject unknown parameters, top level and nested.
  - Types: `RunSequenceParams`, `SequenceStep`, `SequenceResult`, `SequencePlan`, `TargetResolver`, `ResolvedTarget` and friends are exported; `TickAction` gains optional `abort`, `estimateMs` and `elapsedMs`.

- Select and squeeze events follow the WebXR order: `selectstart` on press, then `select` and `selectend` on release (previously `select` fired with `selectstart` on press). The emulated runtime, the native override and ActionPlayer replays share one button-edge path, so the gamepad `pressed` flag and the events always change on the same frame.

  Behaviour changes:
  - A hand selects when its pinch reaches 0.9 and lets go at 0.7 (`XRHandInputConfig.pinchThresholds`, which must satisfy `0 < release < press <= 1`), so a partial pinch such as `set_select_value 0.5` no longer selects, and the gamepad `pressed` flag follows the same levels.
  - Cancelling an interaction (`forceRelease`, the `set_device_state` reset, `setPinchValueImmediate(0)` / `setButtonValueImmediate(…, 0)` on a held button, an ActionPlayer loop, seek, restart or stop mid-press, or a recording that ends mid-press) fires `selectend`/`squeezeend` without `select`/`squeeze`. An input source that disconnects or leaves the primary input mode mid-press does the same, before `inputsourceschange`. A cancelling immediate write keeps the value it asked for (a partial pinch stays partial), and a press written while a cancel is still to be reported waits for the next frame.
  - Buttons held when a session ends start the next session released, with no events.
  - Recorded hand pinches now fire select events on replay, and a replay only ends actions whose start it sent.
  - `set_select_value` rejects out-of-range and NaN values instead of warning and reporting success.
  - Remote control rejects queued commands only when no frame arrives for `ACTION_TIMEOUT_MS`, and then also cancels held buttons; a long animation no longer times out the commands behind it. A press and the release queued behind it always land on different frames (a second write to the same device waits for the next frame; writes to different devices share one), `set_input_mode`, `set_connected` and `set_device_state` end the queue's work for their frame, and one stalled frame advances remote control by at most 100 ms.
  - DevUI: a gaze click whose release is still waiting for the next frame stays a click (`select` + `selectend`) when the window blurs, remote control takes over, or the gaze mode or commit hand changes; a gaze press still held at that moment is cancelled.
  - The `xr_select` and `xr_set_select_value` tool descriptions give the WebXR event order and the hand pinch levels.

## 2.6.0

### Minor Changes

- f4e1156: Add eight built-in GLTS rooms to `@iwer/sem` (`sunlit_living_room`, `home_office`, `conference_room`, `open_office`, `kitchen`, `bedroom`, `music_studio`, `open_studio`), each within Quest's 10 x 10 m room-scan limit and reported like a scanned room. `sem.environments` lists them first and `sem.environmentInfo(id)` tells rooms, added environments and legacy scans apart; the DevUI environment menu lists the room captures under "Legacy scans". The iwer `SyntheticEnvironmentModule` interface gains an optional `environmentInfo`. The rooms add about 0.3 MB to the package (2.8 MB packed); apps load only the room they pick.
- 65a4c51: Add GLTS environments: `sem.addEnvironment(id, url)` registers a `.glts` file (a procedural, possibly dynamic three.js scene) that `loadDefaultEnvironment(id)` loads like the built-in captures, and `sem.environments` lists both; the DevUI environment menu now shows that list. Meshes tagged with `userData.xrPlane` / `userData.xrMesh` become XRPlanes / XRMeshes, and the DevUI plane / bounding-box / mesh toggles work for these environments. Like a scanned room on Quest, a GLTS environment also reports its static geometry as one 'global mesh' XRMesh (tag moving objects with `userData.xrGlobalMesh = false`), and hit tests ignore invisible detection proxies. Plane and mesh spaces now follow moving objects, and `lastChangedTime` no longer changes every frame. The iwer `SyntheticEnvironmentModule` interface gains optional `addEnvironment` and `environments` members, so modules without GLTS support still fit. `@drawcall/glts` needs Node 22.18+ to install.

### Patch Changes

- 0b2eba7: Fix room understanding for the built-in captures: `XRPlane.orientation` now follows the plane's normal (screens were reported as horizontal) and updates, with `lastChangedTime`, when a plane turns between horizontal and vertical, captured planes report normals facing into the room (they pointed out of it, so floors faced down), and office_large's room mesh is reported as 'global mesh'. `@iwer/sem` also ships each capture once instead of four times (no JSON copies in `lib/`, and the prebuilt bundles fetch captures instead of embedding them), shrinking the package from 7.4 MB to 2.5 MB.

## 2.5.0

### Minor Changes

- 57c1b41: Add continuous gaze input emulation to the full and native WebXR runtimes,
  including an additive native gaze-only mode, gaze-plus-pinch DevUI controls,
  gaze-aware remote-control contracts, and native session-offer interception so
  gaze remains attached across automatic re-entry and page reloads.
- 9ae262f: Add a measured Meta VR Glasses field-of-view mask for desktop XR testing, an in-page
  DevUI comparison toggle, and persistent per-site and all-sites browser-extension
  controls.

## 2.4.0

### Minor Changes

- 0afb95f: Add an opt-in native WebXR override that preserves browser sessions and rendering while IWER drives headset poses, controller and hand poses, hand joints, gamepads, input events, action-recording playback, anchors, and hit-test sources.

  Input sources are first published on a native animation frame and announced through `inputsourceschange`, matching the discovery path used by three.js and IWSDK. Input events use WebXR's ordering and frame semantics: `selectstart` on press, `select` and `selectend` on release, each stamped with an `XRFrame` the receiving session currently owns, with a terminating end event synthesized when a visible source disappears or playback loops, seeks, or restarts mid-action. `ActionPlayer.stepFrames()` provides deterministic manual stepping in native sessions and keeps its selected terminal frame active until explicitly stopped. Bulk pose APIs accept general iterables, including `XRHand.values()`, preserve later valid output after an untracked entry, and native gamepad facades expose immutable snapshots.

  Hit-test sources bound to an IWER-controlled space tolerate tracking jitter, keep serving their last resolved subscription while a replacement is in flight, and retry transient failures with backoff.

  Native teardown also restores host prototypes even when a browser animation-frame callback was already queued, announces the live-session transition back to browser input sources, and reports the uninstalled lifecycle state without stale capability or diagnostic state.

  Also export `GlobalSpace`, `XRReferenceSpaceType`, `ActionPlayer`, and `ActionPlayerOptions` so `XRDevice.createActionPlayer()` can be used in native mode from the package entry point.

  The native entry surface exposes `getNativeOverrideSupport` with an environment options bag and `getNativeOverride` for cross-bundle or HMR lifecycle recovery. `RuntimeOptions`, `XRGlobalObject`, `ActionPlayerEventContext`, `NativeOverrideEnvironment`, `NativeOverrideHandle`, and `NativeSessionInfo` are exported for consumers, and capability lifecycle terminology now ends at `active`.

  `installRuntime` now throws when the same XRDevice owns a native override. In native mode, `accept_session` remains application-driven and `get_session_status` reports `sessionOffered` as false.

## 2.3.0

### Minor Changes

- Add agent-ready programmatic control APIs for extension-hosted and local-tool
  automation: runtime method metadata, `connectTransport`, world/object queries,
  hand pose updates, and more reliable session status reporting.
- Expand action recording and playback with programmatic accessors, JSON export,
  seeking, frame stepping, duration/current-time reporting, looping, playback
  rate control, and optional select/squeeze event dispatch.
- Export Meta controller configs and config types, add a generic
  trigger/squeeze/thumbstick controller config, and wire haptics through the
  emulated gamepad surface.
- Add runtime lifecycle and compatibility controls including
  `XRDevice.uninstallRuntime()`, native WebXR detection/forced install,
  WebGL1 `makeXRCompatible`, and configurable user-agent override support.

### Patch Changes

- Fix session lifecycle behavior so `XRSession.end()` is idempotent and post-end
  frame/render-state behavior is closer to the WebXR spec.
- Preserve legitimate zero-valued render-state fields, including
  `inlineVerticalFieldOfView`.
- Tighten WebXR spec fidelity for transforms, depth information, hit testing,
  and event-handler getter round trips.
- Improve remote-control robustness with request timeouts, atomic transform
  validation, non-mutating dispatch params, accurate gamepad update counts, and
  complete force-release cleanup for buttons, thumbsticks, and hand pinch.
- Fix action-player edge cases for single-frame recordings, end-of-recording
  reads, and invalid gamepad data.
- Reduce per-frame allocations across spaces, frames, sessions, views, gamepads,
  action replay, and depth buffers.
- Improve package hygiene with pnpm monorepo support, clean builds, and
  `sideEffects: false` metadata.
