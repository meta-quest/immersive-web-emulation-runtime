# iwer

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
