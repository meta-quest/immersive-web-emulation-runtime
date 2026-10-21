---
outline: deep
title: Scripting Hand Interactions
---

# Scripting Hand Interactions

IWER's remote control interface (`device.remote`) can drive an emulated hand the way a person moves one: put a fingertip on a button, close a pinch over a tenth of a second, fade from one pose to another, or run a whole interaction (press a button, pick something up, set it down, give a thumbs up) in one call with [`run_sequence`](#sequences). Your app's real interaction code reacts, because IWER updates the same joints, gamepad and select events the app reads. Agents reach the same commands over MCP through the IWER browser extension (`xr_set_transform`, `xr_animate_to`, `xr_set_select_value`, `xr_set_hand_pose`, `xr_get_hand_state`, `xr_run_sequence`, `xr_cancel_sequence`, `xr_list_targets`).

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
- `cancel_sequence`, which also drops the pins of the hand a sequence rested.
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

The new parameters (`anchor`, hand directions, `'auto'`, and `duration` on a pinch or a pose) and `run_sequence` need a hand the app can see: input mode `hand`, connected, and `hand-tracking` enabled on the session. The check runs when the command reaches the head of the queue, so a `set_input_mode` sent just before it counts. Otherwise the command fails with a message saying what to fix. Commands without the new parameters still apply to a hand the app can't see.

## Sequences

`run_sequence` (`device.remote.runSequence()`) runs one hand through a list of steps, with the head and body following, and resolves when it is done. Each step's properties animate together; steps run one after the other.

```js
const result = await device.remote.runSequence({
  device: 'hand-right',
  steps: [
    { label: 'press', target: 'button', press: {} },
    {
      label: 'grab',
      target: 'piece',
      approach: { distance: 0.06 },
      pinch: { value: 1, at: 'arrival' },
    },
    {
      label: 'carry',
      target: 'tray',
      depart: { distance: 0.08 },
      approach: { distance: 0.06 },
    },
    { label: 'release', pinch: 0, duration: 0.15 },
    {
      label: 'thumbs up',
      position: { relativeTo: 'head', x: 0.12, y: -0.35, z: -0.35 },
      anchor: 'wrist',
      orientation: { fingers: 'forward', thumb: 'up' },
      poseId: 'thumbs-up',
    },
    { label: 'hold', duration: 1 },
  ],
});
// result.events: [{ t, type: 'selectstart' }, { t, type: 'select' }, { t, type: 'selectend' }]
```

A move travels along one smooth arc (leaving along `depart`, arriving along `approach`), slowing into its target the way a reach does. The head turns toward where the hand is going just before it moves, the body leans toward low targets and steps closer to ones out of reach, and the other hand rests by the hip.

### Steps

| Property                          | Meaning                                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `target` or `position`            | Where the anchor goes. A target is a name the page resolves ([Targets](#targets)), resolved when the sequence is sent and again when the step starts. A position is `{ x, y, z }` or `[x, y, z]` (XR origin, optionally with the surface `normal`), or relative to the body (below). |
| `offset`                          | Added to the placement; `{ normal: d }` moves `d` metres along the surface normal. Without a placement it moves from where the hand is.                                                                                                                                              |
| `anchor`                          | The point of the hand that goes there ([Anchors](#anchors)). It carries over to later steps; the first step that places the hand must name one.                                                                                                                                      |
| `press: { depth, hold, retract }` | Presses the placement with the index fingertip (defaults 8 mm past the surface, 0.03 s, back out to 6 cm). Implies `anchor: 'index-tip'` and the `point` pose. The depth is capped at 15 mm, and needs the surface normal.                                                           |
| `pinch`                           | 0–1, `{ value, start?, end?, easing? }`, or `{ value: 1, at: 'arrival' }`: the hand opens to a grip during the reach and closes as it arrives, crossing 0.9 (select) on arrival. A closing pinch on a target implies `anchor: 'grasp'`.                                              |
| `poseId`, `fingers`               | Pose to fade to. `poseId: 'pinch'` is rejected: poses never select; use `pinch: 1`.                                                                                                                                                                                                  |
| `orientation`                     | Hand directions, `'auto'`, or a quaternion / euler. By default a move with the pinch open is `'auto'`, and a hand that holds something keeps its orientation (it turns with the carry about the vertical, so the object stays upright).                                              |
| `approach`, `depart`              | `{ distance, normal? }`: come straight in along the surface normal for the last `distance` metres, or lift straight off first (straight down / up while holding). A press and a let-go lift off automatically.                                                                       |
| `body`                            | `{ position }` or `{ stepTo: target }` moves the body first (the hand goes along); `facing` (a direction) turns it.                                                                                                                                                                  |
| `duration`                        | Seconds for the reach, or `'auto'` (the default for moves): scaled to the path length, the wrist turn and any pose change.                                                                                                                                                           |
| `label`                           | Names the step in the result and in errors.                                                                                                                                                                                                                                          |

A step with only a `duration` holds. `start` and `end` are fractions of the step's reach (default 0 and 1); the default easing is `minimum-jerk`. Steps and every object in them reject unknown keys, and every error names the step (`Step 2 ('carry'): ...`).

While the hand holds something (a closing pinch on a target), targeting a surface sets the object down on it: its base goes on the surface (the resolver's `box` says how far it hangs below the grasp point), `offset.normal` above it. Let go with a pinch below 0.7; the hand opens first, then lifts away (as part of the next move, when there is one).

### Timing

Sequences run on their own clock, fed by frame time (each frame counts at most 100 ms). Each step's end state is shown for one frame before the next step starts, and the time left over from that frame carries into the next step, so slow or uneven frames give the same motion. A press, from first touch to pulling back out, stays within 0.35 s of sequence time (no frame is held inside it), so it fits an 800 ms click window even at a few frames per second. The sequence resolves one frame after its last step ends, once the app has seen its last select edge.

A sequence is checked when it is sent: everything queued ahead of it plus its own estimated time must fit 25 s. A running sequence gives up 28 s after it was sent with `{ completed: false, reason: 'deadline' }`, inside the bridge's 30 s call timeout.

### Body and gaze

The body frame (the standing head position and the way the body faces) is taken from the headset when a sequence starts, and kept for the next sequence, so a head the last sequence turned or leaned doesn't turn or lower the body. Placing the headset (`set_transform`, `animate_to` or `look_at` on it, a headset pose in `set_device_state`, or the reset) starts a new one.

- `body: 'auto'` (default): the body leans (head lower and forward, up to 10 cm) toward targets below 1.1 m in front, and walks toward a target beyond comfortable reach of the acting shoulder (by more than 6 cm) until it is at comfortable reach, while the arm reaches. Comfortable / maximum reach: `index-tip` 0.62 / 0.72 m, `grasp` 0.58 / 0.66 m, `wrist` 0.48 / 0.55 m. Steps beyond maximum reach get a warning.
- `body: 'fixed'`: the body stays; a target beyond maximum reach is an error naming the step. A step's own `body` still moves it.
- `gaze: 'follow'` (default): the head turns about 70% of the way toward each target (the eyes do the rest), starting about 0.2 s before the hand, with its pitch kept between −60° and +20°, so the work stays in view. `gaze: 'fixed'` leaves the head alone. Either way the head sways very slightly.
- `relativeTo: 'head'` positions are relative to the standing head (walks included, leans not), turned by the body's yaw: never by head pitch or roll, so a gesture lands where it is meant to wherever the head looks. `relativeTo: 'body'` measures `y` from the floor instead. `x` is right, `y` up, `z` back.

### The other hand

`idleHand: 'rest'` lowers the other hand to hang by the hip, fingers loosely curled, over the first step; it goes along with walks and sways slightly. It is the default unless that hand is pinching. `idleHand: 'keep'` leaves it where it is, and the result warns if it is within 10 cm of a place this hand goes.

### Targets

IWER doesn't know your scene, so the page registers a resolver that turns names into surface points, all XR origin:

```js
device.remote.setTargetResolver({
  resolve(target, { device, anchor, intent, from }) {
    // target: a name, or { name, face: 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' }.
    // intent: 'press' (the face to press), 'grasp' (the part to pinch),
    // 'place' (the surface to set a held object down on), 'touch'.
    // from: the acting shoulder, for "the face toward the body".
    const object = findByName(
      typeof target === 'string' ? target : target.name,
    );
    if (!object) return null;
    return {
      position: surfacePoint(object, intent), // where the anchor should touch
      normal: { x: 0, y: 1, z: 0 }, // outward unit normal of that face
      box: worldBox(object), // { min, max }
      size: worldSize(object), // optional
    };
  },
  list() {
    return objects.map((o) => ({
      name: o.name,
      position: center(o),
      size: size(o),
    }));
  },
});
```

An unknown name is an error that lists the closest known names. `list_targets` (MCP `xr_list_targets`) returns `list()`, or `{ resolver: false }` without a resolver. The listed boxes are also obstacles: a move arcs over them until no part of the hand (wrist, knuckles, fingertips, as the wrist turns) passes through, and warns if it can't. The hand can still come down onto the box it is placed on.

### Result

```js
// {
//   completed: true, cancelled: false,
//   steps: [{ label, start, end, startPerf, endPerf }],  // sequence seconds and performance.now()
//   events: [{ t, type }],      // select events the app saw, from the hand's own button edges
//   presses: [{ label, contactMs }],  // real time the fingertip was within 2 cm of each press
//   warnings: [],
//   pinchValue: 0,
//   final: { ... },             // get_hand_state
// }
```

A step that fails (a target gone when its step starts, say) stops the sequence with `{ completed: false, failedStep, reason }`; the hand stays where it is and the pinch is left as it is.

`dryRun: true` validates the sequence, resolves every target and returns the plan without moving anything: each step's segments (a `press` expands into a reach and a hold, and a pull-back unless the next step moves on), their durations, targets and walks, and warnings.

### Stopping

`cancel_sequence` (MCP `xr_cancel_sequence`) answers immediately: the running sequence stops at the current frame, its fades, ramps and pins are let go, the pinch value and select state are left as they are (no events), and the sequence resolves with `cancelled: true` and its partial result, which `cancel_sequence` returns too. `forceRelease()`, the session ending and the queue watchdog also stop a running sequence (`reason: 'released'`, `'session-ended'` or `'stalled'`); `forceRelease()` and the watchdog also cancel held buttons, so the app sees `selectend` alone. Other commands wait behind a running sequence; queries answer immediately.

## Agents (MCP)

The IWER browser extension's MCP tools take the same parameters. Their schemas reject misspelt keys instead of dropping them, so `{ "fingers": "forward", "thum": "up" }` is an error rather than an orientation that silently does nothing. `xr_run_sequence`'s description carries a compact example and the rules above, so an agent can compose a sequence from the tool list alone.

IWER also publishes the parameters of every remote method as JSON Schema (`anyOf` unions, no `$ref`), for other tool hosts:

```js
import { REMOTE_METHOD_SCHEMAS } from 'iwer/lib/remote/catalog.js';
REMOTE_METHOD_SCHEMAS.run_sequence; // { type: 'object', properties: { device, steps, ... } }
```
