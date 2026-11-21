# 10. Input: controllers, hands and haptics

Scope: how real tracking reaches the input states of [09](09-iwer-host-frame-record.md) and what the app
observes. IWER turns the states into `XRInputSource`s, gamepads, spaces, joints and events
(HOST-INPUT.md); this file states what the runtime must feed it.

Sources: OpenXR 1.1 §11 (actions, interaction profiles `/interaction_profiles/oculus/touch_controller`,
`/interaction_profiles/meta/touch_controller_plus`, `/interaction_profiles/facebook/touch_controller_pro`,
`/interaction_profiles/ext/hand_interaction_ext`), `XR_EXT_hand_tracking`, `XR_FB_hand_tracking_aim`,
`XR_EXT_hand_interaction`, `XR_META_hand_tracking_microgestures`, `XR_FB_touch_controller_pro`,
`XR_META_touch_controller_plus`;
WebXR Device API (input sources, select/squeeze), WebXR Gamepads Module (`xr-standard` mapping), WebXR Hand
Input (25 joints), WebXR Input Profiles registry (profile ids); Pointer Events, UI Events (KeyboardEvent
`key`/`code`); HOST-INPUT.md and its open decisions (hand gamepad layout vs Quest Browser's; the left-palm menu
gesture; the palm standing in as grip).

## Controllers

**IN-1 (MUST).** On Touch, Touch Plus and Touch Pro controllers, every control the app can observe through
WebXR reaches its input-state slot (IN-2): grip and aim poses, trigger value/touch, squeeze value,
thumbstick x/y/click/touch, A/X and B/Y click/touch, thumbrest touch, the left menu button, and haptics
(IN-7). The poses a frame's callbacks see are located for that frame's predicted display time, and button
and axis values are no older than that frame.
_Check:_ each control on a Quest 3 Touch Plus controller (and a Touch Pro where one is available) changes the
matching state slot (debug-endpoint probe of the gamepad); a controller held still in front of the headset
while the head turns does not lag or swim (human check).

**IN-2 (MUST).** Controller states use HOST-INPUT's controller layout: index 0 trigger, 1 squeeze, 2 empty,
3 thumbstick click, 4 A/X, 5 B/Y, 6 thumbrest, 7 menu (left, unless the open IWER decision changes it);
axes `[0, 0, stick x, stick y]`; target ray = aim pose; grip = grip pose; validity from the space location
flags: a pose is valid when both position and orientation are valid, otherwise IWER reports it as
untracked (`getPose` → `null`). The tracked flags are not passed on: host spaces always report
`emulatedPosition: false` (HOST-INPUT.md); whether a merely inferred (valid but not tracked) position
should count as emulated is part of README open question 6. Profiles reported to
the app match Quest Browser's list for the connected controller model.
_Check:_ compare `inputSource.profiles`, button count, axes with Quest Browser on the same controller.

**IN-3 (MUST).** `pressed` for analog buttons uses Quest Browser's thresholds with hysteresis (trigger and
squeeze; measured in Quest Browser and recorded here before M3), `touched` is true whenever pressed, and
digital buttons map their click action. A held button at the moment a source appears raises no press until
the next frame (HOST-INPUT).
_Check:_ sweep the trigger slowly: `selectstart`/`selectend` values match Quest Browser within ±0.05.

**IN-4 (MUST).** Source switching follows the interaction profile the runtime reports per hand, as in Quest
Browser: controllers listed while a controller profile (Touch, Touch Plus, Touch Pro) is active for that hand;
otherwise hands listed when hand tracking is enabled by the session and the hand is tracked (active, with a
valid wrist position); a tracked hand in a session without hand tracking is listed as a pointer (target ray
from the hand's aim, grip from the palm, select from the pinch, no joints); neither when idle. The runtime
suggests bindings for the hand interaction profile and not for `khr/simple_controller`, which Horizon OS
otherwise binds tracked hands to. A switch produces one `inputsourceschange` with removed/added (IWER does
this on mode change).
_Check:_ while wearing the headset, set the controllers down until hands are listed, then pick them up
again; the app logs exactly one `inputsourceschange` per transition, with the controllers removed and the
hands added (and the reverse). This is a human step; until someone performs it, the check is recorded as
not yet run.

## Hands

**IN-5 (MUST).** With `hand-tracking` enabled, `XR_EXT_hand_tracking` joints are located once per frame relative to the frame's base space; OpenXR joint i+1 → WebXR joint i (OpenXR's 26 joints minus the palm, which becomes the palm pose; WebXR has 25); radii
passed through; per-joint validity from the location flags.
_Check:_ `frame.fillPoses(hand.values(), ref, buf)` returns true with all 25 joints tracked while both
hands are visible; joint positions match the real hand (human check).

**IN-6 (MUST).** Hand gamepad and select: index-pinch drives button 0 (`pressed` from the runtime's pinch
state: `XR_FB_hand_tracking_aim` pinching flag when present, otherwise a documented thumb-tip–index-tip
distance with hysteresis), the system menu gesture (aim flags' menu-pressed bit) drives the menu slot
(index 4 in both the 5- and 10-button layouts), and with `XR_META_hand_tracking_microgestures` buttons 5-9
are the microgestures (swipe left, swipe right, swipe forward, swipe backward, thumb tap; pressed while the
runtime reports the gesture), the order Quest Browser reports them in. Slots 1-3 stay empty. The aim
pose from `XR_FB_hand_tracking_aim` is the target ray when present (else a documented derivation from the
joints). The grip pose of a hand is the palm (HOST-INPUT: palm stands in when grip is invalid).
_Check:_ the menu slot reports pressed at the moment the left-hand system gesture completes; index pinch fires
`select*`; a thumb swipe or tap presses its button for the frames the runtime reports it; objects attached to
the hand grip follow the palm.

## Haptics

**IN-7 (MUST).** IWER's `onHaptic(handedness, intensity, durationMs, frequencyHz)` applies an OpenXR
vibration to that hand (amplitude = intensity, duration, `XR_FREQUENCY_UNSPECIFIED` when 0); a new pulse
replaces a running one; `pulse()` resolves `true` after the duration (or at once, per HOST-INPUT, if the
runtime returns no promise; pick one and document). Hands have no actuators.
_Check:_ `gamepad.hapticActuators[0].pulse(1, 100)` buzzes the right controller for ~100 ms.

## Non-XR input

**IN-8 (withdrawn for this release).** There is no 2D panel mode (XR-IDLE), so no touch/mouse →
Pointer Events path is required. If a panel mode is added later (README open question 11), this ID is
reused for its pointer and keyboard events.
_Check:_ none while withdrawn.

**IN-9 (MUST).** `navigator.getGamepads()` returns an empty list (XR gamepads are not listed there, as in
browsers).
_Check:_ test.
