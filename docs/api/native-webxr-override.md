---
outline: deep
---

# Native WebXR Override

The native WebXR override lets IWER drive tracking and controller input inside
an immersive session created by the browser. It keeps the browser's native
session, frame timing, rendering layers, projection matrices, and compositor.

This mode is separate from desktop emulation. Calling
`XRDevice.installRuntime()` still installs IWER's complete emulated WebXR
runtime. The native override is enabled only when an application explicitly
calls `installNativeOverride()`.

The standalone installer is deliberate: it keeps the native integration module
out of the `XRDevice` runtime path so emulation-only applications can tree-shake
it. Both modes still use the same `XRDevice` state and control APIs.

## Install the override

Install the override before the application requests an immersive session:

```typescript
import {
  getNativeOverride,
  getNativeOverrideSupport,
  installNativeOverride,
  metaQuest3,
  XRDevice,
} from 'iwer';

const support = getNativeOverrideSupport();
if (!support.supported) {
  throw new Error(support.notes.join(' '));
}

const device = new XRDevice(metaQuest3);
const nativeOverride = installNativeOverride(device, {
  onUnsupported: 'throw',
});
```

`getNativeOverride()` finds the installed lifecycle handle structurally, without
an `instanceof` check, so independently bundled IWER copies and hot-module
replacement can recover and uninstall an override whose original handle was
lost.

During HMR, explicitly remove the override created by the previous module:

```typescript
if (import.meta.hot) {
  const previousOverride = getNativeOverride();
  if (previousOverride) {
    previousOverride.uninstall();
  }
}
```

An override installed with a custom environment must be recovered by passing
the same environment to `getNativeOverride(environment)`.

The application's existing `navigator.xr.requestSession('immersive-vr')`
call still returns the browser's native `XRSession`. Inline sessions pass
through unchanged.

Use the `XRDevice` properties or its remote-control interface to update the
headset and controllers. Call `nativeOverride.uninstall()` to restore all
patched browser properties and detach active sessions. A live session receives
an `inputsourceschange` event that removes the synthetic sources and adds the
browser's currently exposed native sources, so event-driven framework state
returns to native input cleanly. Synthetic input-source and hit-test facades
obtained from the override are invalid after uninstall and must not be passed
back to native WebXR methods.

After teardown, `nativeOverride.capabilities.phase` is `uninstalled` and every
runtime capability flag is reset. The `supported` field continues to describe
the most recent environment support check; calling `install()` checks the
environment again before applying any patches.

`installNativeOverride()` is the supported entry point. `XRNativeOverride` is
the returned lifecycle handle; construct it directly only to defer or retry
installation.

Only one native override can be installed on an `XRSystem` at a time. A
native override and the full emulated runtime cannot be installed on the same
`XRDevice` simultaneously.

With the default `onUnsupported: 'warn'` behavior, check
`nativeOverride.installed` after installation. It is `false` when the initial
browser hooks could not be installed.

## Controlled and native behavior

| IWER controls                          | Browser remains responsible for    |
| -------------------------------------- | ---------------------------------- |
| Viewer position and orientation        | `XRSession` creation and lifecycle |
| Target-ray, grip, and hand-joint poses | `requestAnimationFrame` cadence    |
| Controller `Gamepad` values            | Render state and WebXR layers      |
| Synthetic controller and hand sources  | View projection matrices           |
| `select*` and `squeeze*` events        | Compositing and display submission |
| Action-recording playback              | Real-world hit tests and anchors   |

Synthetic input sources replace the native session's input sources while the
override is attached. Like browser-provided sources, the initial synthetic set
is published on the first native animation frame and announced with an
`inputsourceschange` event, so frameworks that discover controllers through that
event receive them normally. Headset pose control is absolute rather than an
offset from physical tracking.

## Hand input

Synthetic hands are published when both conditions hold:

- the browser session enabled the `hand-tracking` feature, and
- `XRDevice.primaryInputMode` is `'hand'`.

Each hand input source exposes a stable `XRHand`-shaped `hand` collection with
all 25 `XRJointSpace`-shaped joints. The same facade objects are reused for the
lifetime of the session, so applications can cache them. `XRFrame.getPose()`,
`fillPoses()`, `getJointPose()`, and `fillJointRadii()` all resolve those
joints, and iterables that mix synthetic joints with browser-tracked ones keep
native results for the browser's entries. This includes the common
`frame.fillPoses(inputSource.hand.values(), referenceSpace, transforms)`
shape.

Following WebXR Hand Input, hand sources report `gamepad: null`. Pinch is still
driven through `XRHandInput.updatePinchValue()`, which produces the standard
`selectstart` / `select` / `selectend` sequence. Controller input sources report
`hand: null`.

Joint radii follow WebXR Hand Input's tracking semantics: a joint whose radius
is unknown is reported as untracked by both APIs, so `fillJointRadii()` writes
`NaN` and returns `false` while `getJointPose()` returns `null` for the same
joint on the same frame.

## Action playback

`XRDevice.createActionPlayer()` works in native mode. It takes the reference
space the recording's poses are expressed in, which the application builds
directly — the emulated runtime is not installed in native mode, so there is no
session reference space to pass:

```typescript
import { GlobalSpace, XRReferenceSpace, XRReferenceSpaceType } from 'iwer';

const recordingSpace = new XRReferenceSpace(
  XRReferenceSpaceType.Local,
  new GlobalSpace(),
);
const player = device.createActionPlayer(recordingSpace, recording, {
  loop: true,
  playbackRate: 1,
});
player.play();
```

Recorded poses are then interpreted in the session's native anchor reference
space, the same way live device poses are.

While a player is wired to native mode, the override temporarily replaces any
`ActionPlayerOptions.eventContext` supplied by the application. It restores the
previous context when the player is unwired or the override is uninstalled.

The recording is sampled exactly once per native frame timestamp on one visible
session, and the recorded viewer pose, input sources, target-ray and grip
spaces, hand joints, gamepad values, `inputsourceschange`, and `select` /
`squeeze` events are all published through the same stable native facades used
for live device input. The final sampled frame remains observable to the frame
callback that produced it, and live device state resumes on the following frame.

Recorded hand joints are only published when the browser session enabled
`hand-tracking`.

### Event delivery

Playback events follow WebXR's ordering, not the emulated runtime's:
`selectstart` fires when a recorded button goes down, and `select` followed by
`selectend` fire when it comes back up. IWER's emulated runtime keeps its
long-standing order and is unaffected.

Every event is stamped with an `XRFrame` that the receiving session currently
owns. An edge the recording produces while a session is not inside an animation
frame callback — a secondary session, or an application-driven
`ActionPlayer.stepFrames()` — is queued and delivered on that session's next
frame instead of being dropped or stamped with an expired frame. An input
source stays in `XRSession.inputSources` until its queued events have been
delivered.

If a recorded source disappears while one of its actions is still held — the
recording ends, the source stops being recorded, or `ActionPlayer.stop()` is
called mid-press — the override synthesizes the terminating `selectend` /
`squeezeend` while the session remains visible. It does not synthesize
`select` / `squeeze`, because the action was interrupted rather than
completed. If the browser hides the session, its queued events and held-action
state are cleared as part of suspending input; no terminal event is delayed
until a later visibility cycle.

`ActionPlayer.stepFrames()` switches the player to deterministic manual
stepping. Native animation frames render the selected recording frame without
advancing it again, including the final frame of a non-looping recording.
Another `stepFrames()` call advances it, `stop()` releases it back to live
device state, and `play()` returns to wall-clock playback. A `seek()` that
changes the sampled frame, restarting with `play()`, or wrapping a loop
terminates any held action before establishing a new event baseline, so
playback never leaves an unmatched `selectstart` or `squeezestart`.

`XRSession.inputSources` follows the WebXR `FrozenArray` contract. It starts
empty and is populated on the first native animation frame. Each snapshot is
frozen; when membership changes, the getter exposes a new snapshot while the
input-source, space, hand, and gamepad facade objects remain stable.

Bulk pose methods also follow the browser's partial-result behavior: when one
space cannot be resolved, `fillPoses()` returns `false` but continues writing
later resolvable matrices into the caller's buffer.

## Remote control in native mode

Remote transform, gamepad, and input commands work after the application has
started an immersive session. Session and rendering behavior differ from full
desktop emulation:

- `accept_session` is unavailable because the application must start the
  native session through the browser's normal user-gesture flow.
- `get_session_status` reports `sessionOffered: false`.
- `XRDevice.activeSession` and `XRDevice.sessionOffered` reflect only the
  emulated runtime; inspect `nativeOverride.sessions` in native mode.
- DevUI session controls are not wired to browser-owned native sessions.
- Positions supplied to `look_at` and `animate_to` are interpreted directly in
  the native anchor reference space; there is no emulated XR-origin offset.
- `stereoEnabled` and field-of-view updates do not replace the browser's native
  projection matrices.
- `XRDevice.updateVisibilityState()` cannot force native session visibility;
  the browser's visibility state remains authoritative.

## Anchors and hit testing

`XRFrame.createAnchor()` accepts IWER-controlled spaces. The requested pose is
composed into the session's native anchor reference space
(`base_from_controlled * controlled_from_anchor`) and forwarded to the browser,
so the anchor is created at the synthetic pose and then tracked by the browser
like any other anchor. Errors raised by the browser — an unsupported `anchors`
feature or an inactive frame — are preserved. Validation failures for an
IWER-controlled space reject the returned promise, including
`InvalidStateError` when the space belongs to a different native session,
matching the browser's promise-returning WebIDL behavior.

`XRSession.requestHitTestSource()` also accepts IWER-controlled spaces, but the
WebXR hit-test subscription API has no way to move an existing subscription.
The override therefore returns a stable `XRHitTestSource`-shaped facade backed
by a native subscription created from the controlled pose, and it resubscribes
when that pose moves meaningfully. The contract is:

- `XRFrame.getHitTestResults(facade)` returns the browser's results for the
  subscription the browser has most recently resolved. The facade never goes
  blank once its first subscription resolves.
- Resubscription is triggered by motion beyond 5 mm of translation or 1 degree
  of rotation. Tracking jitter below that does not resubscribe, so a hand-held
  or head-locked space settles instead of churning.
- At most one replacement is ever in flight. A space that moves continuously
  therefore costs one native subscription per browser round trip rather than
  one per frame, and its results trail the controlled pose by the resubscribe
  tolerance plus that round trip.
- The previous native subscription keeps serving results until its replacement
  resolves, and is cancelled at that point. Cancelling the facade, ending the
  session, or calling `uninstall()` cancels the backing subscription. Calling
  `cancel()` on the facade more than once raises `InvalidStateError`.
- A failed replacement is treated as transient: the working subscription is
  kept, a note is recorded, and the override retries with exponential backoff
  up to 32 frames. Sources recover on their own once the browser succeeds again.

`XRSession.requestHitTestSourceForTransientInput()` is not translated;
synthetic input sources are not transient. `XRHitTestResult.getPose()` expects a
browser-owned base space.

## Frame validity

WebXR marks an `XRFrame` inactive as soon as its animation frame callback
returns. The override enforces that for IWER-controlled spaces too:
`getPose()`, `fillPoses()`, `getJointPose()`, `fillJointRadii()`, and
`getHitTestResults()` raise `InvalidStateError` when called on a frame whose
callback has already returned. The promise-returning `createAnchor()` rejects
with `InvalidStateError` instead. Queries that only involve browser-owned
spaces keep whatever the browser itself does.

## Capability inspection

`getNativeOverrideSupport()` performs a preliminary check before
installation. Host-object patching can still fail after a native session
starts, so inspect `nativeOverride.capabilities` for the authoritative
runtime result.

```typescript
const { phase, poseOverride, inputSources, notes } =
  nativeOverride.capabilities;
```

The phase is `uninstalled` before installation and after teardown. While active,
it progresses from `installed`, to `attached` after an immersive session is
captured, to `active` after viewer and view transforms have been overridden
successfully. The `notes` array reports unsupported browser hooks or
degraded behavior.

The phase and capability flags are high-water marks for the current install
cycle. `nativeOverride.installed` and `nativeOverride.sessions` report live
state.

Alongside the pose and input flags, `capabilities` reports `handInput` and
`jointPoses`, which turn on once synthetic hands are bound and the joint hooks
are installed, and `actionPlayback`, `anchors`, and `hitTest`, which turn on the
first time each path actually runs.

If the browser refuses to let `XRFrame.createAnchor` or
`XRFrame.getHitTestResults` be overridden, `notes` says so explicitly.
`requestHitTestSource()` then rejects IWER-controlled spaces with
`NotSupportedError` rather than handing back a facade the browser cannot use.
If no applicable frame hook can be installed, an unpatchable `createAnchor`
call cannot be intercepted and the note is the only signal. If a prototype
wrapper remains active from an earlier frame, controlled calls instead reject
with `NotSupportedError`. Availability is tracked per native session and
recovers if a later browser frame can be instrumented; one unusual sealed frame
does not disable anchors or hit testing for every session.

`nativeOverride.sessions` lists attached immersive sessions and identifies
the primary session. Shared remote and playback state advances from that session
while it is visible, or from the first visible secondary session otherwise.
Each read returns a new `NativeSessionInfo` snapshot. Its `anchorSpace` is the
browser-owned reference space used as the synthetic origin for that session.

## Options

`installNativeOverride(device, options)` accepts:

- `onUnsupported: 'warn' | 'throw'` — warn and preserve native behavior, or
  throw when a required hook cannot be installed. The default is `'warn'`.
- `xrSystem` — overrides the `XRSystem` used by the installer. This is
  primarily a testing seam; the default is `navigator.xr`.
- `globalObject` — overrides the source of native WebXR constructors. This
  is primarily a testing seam; the default is `globalThis`.

`getNativeOverrideSupport(environment)` and `getNativeOverride(environment)`
accept the same `xrSystem` and `globalObject` subset.

## Current limitations

- Starting the immersive session remains application-driven and requires the
  browser's normal user gesture.
- Hit-test results for a moving IWER-controlled space lag that space by the
  resubscribe tolerance plus one browser round trip. See
  [Anchors and hit testing](#anchors-and-hit-testing).
- `XRSession.requestHitTestSourceForTransientInput()` does not accept
  IWER-controlled spaces.
- Synthetic hands require the browser session to have enabled the
  `hand-tracking` feature; the override cannot add features to a session the
  application already negotiated.
- Action playback advances on one visible session only. Other visible sessions
  observe the same recorded state and receive the same events on their own
  frames, but do not independently advance playback.
- When the browser hides a session, synthetic input sources are removed and
  queued or held actions are cleared without a delayed terminal event.
