---
outline: deep
title: Scripting Hand Interactions
---

# Scripting Hand Interactions

IWER's remote control interface (`device.remote`) can drive an emulated hand the way a person moves one: put a fingertip on a button, close a pinch over a tenth of a second, fade from one pose to another. Your app's real interaction code reacts, because IWER updates the same joints, gamepad and select events the app reads. Agents reach the same commands over MCP through the IWER browser extension (`xr_set_transform`, `xr_animate_to`, `xr_set_select_value`, `xr_set_hand_pose`, `xr_get_hand_state`).

```js
const remote = device.remote;
await remote.dispatch('set_input_mode', { mode: 'hand' });

// Index fingertip on a button, pointing, then pinch-grab something else.
await remote.dispatch('set_hand_pose', {
  device: 'hand-right',
  poseId: 'point',
  duration: 0.3,
});
await remote.dispatch('animate_to', {
  device: 'hand-right',
  anchor: 'index-tip',
  position: { x: 0.1, y: 1.05, z: -0.45 },
  orientation: 'auto',
  duration: 0.6,
  easing: 'minimum-jerk',
});
await remote.dispatch('animate_to', {
  device: 'hand-right',
  anchor: 'grasp',
  position: { x: 0.25, y: 0.95, z: -0.5 },
  duration: 0.6,
  easing: 'minimum-jerk',
});
await remote.dispatch('set_select_value', {
  device: 'hand-right',
  value: 1,
  duration: 0.15,
});
```

Commands run in the order they were sent, one frame-synchronized step at a time; a timed command holds the queue until it finishes.

## Coordinates

Every position, orientation and direction that remote control takes or reports is relative to the **XR origin**: the app's first reference space that is not `viewer`. For `local-floor` and `bounded-floor` (IWSDK's default) that is IWER's floor frame, so values are the same as before. A `local` space keeps the headset's pose when the space was created, pitch included. In native override mode the origin is the browser's anchor space. `-Z` is forward and `+Y` is up.

This applies to `set_transform`, `get_transform`, `animate_to`, `look_at`, `get_device_state`, `set_device_state` and `get_hand_state`. The `set_device_state` reset with no `state` still puts the headset 1.6 m and the hands 1.3 m above the floor.

## Anchors

A hand's position is its target ray's origin, which is not a point on the hand. `anchor` on `set_transform` and `animate_to` names the point of the hand that `position` places instead:

| Anchor                 | Point                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| `target-ray` (default) | The target ray's origin, as before.                                |
| `index-tip`            | The index fingertip: for pressing buttons.                         |
| `grasp`                | Where the thumb and index tips meet in a full pinch: for grabbing. |
| `wrist`                | The wrist: for placing a gesture.                                  |
| `thumb-tip`, `grip`    | The thumb tip, or the grip space's origin.                         |
| any WebXR joint name   | That joint, for example `middle-finger-tip`.                       |

The hand keeps the anchor where you put it while its shape changes (a **pin**): a pose change, a pinch or a pose fade moves the fingers around the anchor, not the anchor itself. Placing `grasp` on an object and then pinching closes both fingertips onto it with the wrist still.

The pin is re-solved every frame after the hand's shape updates, in both the emulated runtime and native override mode. Results report the solved pose. These commands drop it:

- `set_transform` or `animate_to` without an `anchor` (or with `target-ray`): the hand moves by its target ray, as before.
- `look_at`, `set_connected` with `false`, a change of input mode, and `set_device_state`.
- Remote control letting go of the device (30 s after the last command, or `forceRelease()`), the session ending, and the queue watchdog. Any timed command still running stops where it is.

A placement with a new `position` replaces the pin. One with only an `orientation` that names the pinned anchor turns the hand about that point.

## Hand orientation

`orientation` takes a quaternion or euler angles, which set the target ray as before. For hands it also takes directions:

- `{ fingers, palm }`: where the fingers point and which way the palm faces.
- `{ fingers, thumb }`: where the fingers point and which way the thumb side of the hand faces. A thumbs up is `{ fingers: 'forward', thumb: 'up' }` with the `thumbs-up` pose, on either hand.

`fingers` is kept exactly; the second direction is made perpendicular to it. Each direction is a vector (`{ x, y, z }` or `[x, y, z]`, XR-origin) or a name: `up`, `down`, `forward`, `back`, `left`, `right` (the last four follow the way the headset faces, ignoring its pitch), `toward-head` or `away-from-head` (from the placed position). The wrist keeps this rotation while the hand changes shape.

`orientation: 'auto'` picks the orientation of a relaxed reach toward `position`: the fingers follow the forearm from an estimated shoulder (18 cm to the side of, 25 cm below and 5 cm behind the eyes), the palm faces down, rolled 15° toward thumb-up. It is worked out once, when the command starts.

## Timed pinch and pose

- `set_select_value { value, duration?, easing? }` ramps the pinch (or a controller's trigger) from its current value. A hand selects when its pinch reaches **0.9** and lets go at **0.7** or below, so the press lands on the frame the ramp passes 0.9.
- `select` on a hand closes the pinch over 0.1 s, holds it for `duration`, and opens it over 0.1 s. Press and release always land on different frames.
- `set_hand_pose { poseId, fingers?, duration?, easing? }` fades from the hand as shown (a fade in progress included) to the new pose. `poseId` and `fingers` report the new pose right away, and `get_hand_state` reports `transition: { from, progress }` until it ends. Setting `XRHandInput.poseId` directly, as the DevUI does, ends a fade and snaps.
- `animate_to` takes `easing`: `linear` (the default) or `minimum-jerk`, the smooth start and stop of a human reach. It starts from wherever the device is when the animation starts, not when it was sent.

`easing` defaults to `minimum-jerk` for pinch ramps and pose fades. A pinch only closes the thumb and index, relative to the palm; the other fingers, the wrist and the grip keep the pose.

## Reading a hand back

`get_hand_state { device, joints? }` answers immediately:

```js
const state = await remote.dispatch('get_hand_state', { device: 'hand-right' });
// {
//   poseId: 'point', fingers: {}, transition: null,
//   pinchValue: 0, pressed: false,
//   position, orientation,            // the target ray
//   pin: { anchor: 'index-tip', target: { x, y, z } },
//   anchors: { wrist, grip, grasp, 'index-tip', 'thumb-tip' },
//   axes: { fingers, palm, thumb },   // unit directions
//   connected: true,
// }
```

`joints: 'all'` adds every joint's position and radius. `get_device_state` reports each hand's `poseId` and `pinchValue`, and `set_device_state` accepts them.

## Live hands

The new parameters (`anchor`, hand directions, `'auto'`, and `duration` on a pinch or a pose) need a hand the app can see: input mode `hand`, connected, and `hand-tracking` enabled on the session. The check runs when the command reaches the head of the queue, so a `set_input_mode` sent just before it counts. Otherwise the command fails with a message saying what to fix. Commands without the new parameters still apply to a hand the app can't see.

## Agents (MCP)

The IWER browser extension's MCP tools take the same parameters. Their schemas reject misspelt keys instead of dropping them, so `{ "fingers": "forward", "thum": "up" }` is an error rather than an orientation that silently does nothing.
