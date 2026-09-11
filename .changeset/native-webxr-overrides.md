---
'iwer': minor
---

Add an opt-in native WebXR override that preserves browser sessions and rendering while IWER drives headset poses, controller and hand poses, hand joints, gamepads, input events, action-recording playback, anchors, and hit-test sources.

Input sources are first published on a native animation frame and announced through `inputsourceschange`, matching the discovery path used by three.js and IWSDK. Input events use WebXR's ordering and frame semantics: `selectstart` on press, `select` and `selectend` on release, each stamped with an `XRFrame` the receiving session currently owns, with a terminating end event synthesized when a visible source disappears or playback loops, seeks, or restarts mid-action. `ActionPlayer.stepFrames()` provides deterministic manual stepping in native sessions and keeps its selected terminal frame active until explicitly stopped. Bulk pose APIs accept general iterables, including `XRHand.values()`, preserve later valid output after an untracked entry, and native gamepad facades expose immutable snapshots.

Hit-test sources bound to an IWER-controlled space tolerate tracking jitter, keep serving their last resolved subscription while a replacement is in flight, and retry transient failures with backoff.

Native teardown also restores host prototypes even when a browser animation-frame callback was already queued, announces the live-session transition back to browser input sources, and reports the uninstalled lifecycle state without stale capability or diagnostic state.

Also export `GlobalSpace`, `XRReferenceSpaceType`, `ActionPlayer`, and `ActionPlayerOptions` so `XRDevice.createActionPlayer()` can be used in native mode from the package entry point.

The native entry surface exposes `getNativeOverrideSupport` with an environment options bag and `getNativeOverride` for cross-bundle or HMR lifecycle recovery. `RuntimeOptions`, `XRGlobalObject`, `ActionPlayerEventContext`, `NativeOverrideEnvironment`, `NativeOverrideHandle`, and `NativeSessionInfo` are exported for consumers, and capability lifecycle terminology now ends at `active`.

`installRuntime` now throws when the same XRDevice owns a native override. In native mode, `accept_session` remains application-driven and `get_session_status` reports `sessionOffered` as false.
