---
'iwer': minor
'@iwer/extension-bridge': minor
'@iwer/devui': patch
---

Hand motion primitives for remote control (see the new "Scripting Hand Interactions" guide):

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
- MCP: `CATALOG_VERSION` is 3. `xr_set_transform`, `xr_animate_to`, `xr_set_select_value`, `xr_set_hand_pose`, `xr_set_device_state` and `xr_get_hand_state` reject unknown parameters (top level and nested) instead of silently dropping them, and quaternion / euler objects no longer accept extra keys.
