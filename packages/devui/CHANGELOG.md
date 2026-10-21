# @iwer/devui

## 2.7.0

### Minor Changes

- Add a library of base hand poses (open, flat, fist, thumbs-up, finger-gun, peace, three, four, ok, rock, call, pinch-middle, pinch-ring, pinch-pinky, tripod, key-pinch, grip, claw, hook, cup) built on the captured Quest skeleton, and per-finger pose blending through `XRHandInput.setFingerPose()`. The DevUI pose stepper and hotkey cycle through `default`, `point`, `fist`, `open` and `thumbs-up` (`pinch` is left to the pinch control), and the label shows a pose set through remote control, with `*` for finger blends. `xr_set_hand_pose` lists the poses with a short description of each, notes that poses never select, accepts per-finger overrides, and rejects unknown pose ids.
- The `iwer` peer dependency is now `^2.7.0` (it was `^2.5.0`): the pose stepper and its label read `XRHandInput.poseIds` and `fingerPoses`, which iwer 2.5 and 2.6 do not have.

### Patch Changes

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

- Versioned in lockstep with `iwer` 2.4.0; no package-specific behavior changes.

## 2.3.0

### Minor Changes

- Add the preference bridge used by browser-extension shells to seed and persist
  DevUI-controlled settings without importing private component modules.
- Export `DEFAULT_KEYMAP`, `useKeyMapStore`, and preference postMessage helpers.
- Emit storage-agnostic preference patches for keymap, input mode, FOV,
  environment, hand pose, and saved default pose interactions.

### Patch Changes

- Fix pointer-lock cleanup and reduce render churn in the live control overlay.
- Clear the offer-session interval on disposal and avoid listener leaks.
- Reduce transform-sync allocations by reusing shared quaternion scratch state.
- Keep the hidden offer-session/Enter XR control fully outside unsupported
  pages until a session is actually offered.
