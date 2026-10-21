---
'iwer': minor
'@iwer/extension-bridge': minor
---

Hand microgestures, laid out as Quest Browser reports them (see "Microgestures" in the Scripting Hand Interactions guide):

- The hand gamepad has the `xr-standard` mapping with 10 buttons: the pinch on button 0 (select, as before), empty slots on 1 to 3, the menu gesture on 4 and Quest's thumb microgestures on 5 to 9 (swipe left, right, forward, backward, and thumb tap). Only the pinch fires session events. `XRHandInput.updateGestureButton()` writes the others.
- `microgesture { device, gesture }` (MCP `xr_microgesture`) swipes or taps the thumb on the side of the curled index finger and, as the thumb lifts, presses the gesture's button for 35 ms (always for at least one frame). A hand not in the new `microgesture` pose takes it first (0.25 s), letting go of a light pinch; a hand that is selecting must let go first. Remote control letting go mid-gesture returns the thumb and lifts the button.
- `run_sequence` takes `{ microgesture }` steps and reports them in `events` by gesture name, from the hand's own button edges; a dry run lists them as `microgesture` segments.
- `XRHandInput.thumbMotion` shows a thumb movement on top of the pose; the new `microgesture` pose is in `BUILTIN_HAND_POSE_IDS`.
- MCP: `CATALOG_VERSION` is 5; `xr_microgesture` rejects unknown parameters.

Behaviour change: the hand gamepad's `mapping` is now `'xr-standard'` (was `''`) and it has 10 buttons (was 1). Button 0 is unchanged, and hand recordings made before still replay. In native override mode hand sources still publish no gamepad, so pages don't see the gesture buttons there.
