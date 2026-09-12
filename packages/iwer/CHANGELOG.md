# iwer

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
