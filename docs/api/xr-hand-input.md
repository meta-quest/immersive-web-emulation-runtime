---
outline: deep
---

# XRHandInput Class

The `XRHandInput` class emulates hand input within WebXR environments. It supports detailed hand pose emulation and gesture recognition, allowing for immersive interactions within the virtual space.

## Properties

### `poseId`

Specifies the current hand pose being emulated, such as `default`, `pinch`, `fist`, or other custom poses defined in the configuration.

- **Type**: `string`
- Allows dynamic update to the hand pose through a setter. Changing the `poseId` triggers an update in the hand's pose based on the configuration associated with the new pose ID, and clears any finger blends. It also ends a pose change in progress (`beginPoseTransition`): the hand snaps to the new pose.

### `poseIds`

Every pose id this hand can take: the built-in library (`BUILTIN_HAND_POSE_IDS`) for the default config, or the keys of a custom config's `poses`.

- **Type**: `string[]`
- **Readonly**

### `fingerPoses`

Fingers currently taken from other poses on top of `poseId`, keyed by finger (`thumb`, `index`, `middle`, `ring`, `pinky`). Each read returns a copy; change blends with `setFingerPose` and `clearFingerPoses`.

- **Type**: `Partial<Record<XRHandFinger, { poseId: string; weight: number }>>`
- **Readonly**

### `poseTransitionProgress`

How far a pose change begun with `beginPoseTransition` has got, from `0` to `1`, or `null` when no change is in progress. Setting it to `1` or more (or `null`) ends the change.

- **Type**: `number | null`

### `poseTransitionFrom`

The pose a change in progress fades from (the pose set before it), or `null` when no change is in progress.

- **Type**: `string | null`
- **Readonly**

### `thumbMotion`

A thumb movement shown on top of the pose, or `null`: the thumb is `weight` of the way from its place in `from` to its place in `to` (two hand poses), relative to the displayed palm. Nothing else moves, and anchors (`grasp` included) keep the displayed pose, so a pinned hand stays where it is. Remote control's microgestures set it every frame and clear it when they end.

- **Type**: `ThumbMotion | null` (`{ from: HandPose; to: HandPose; weight: number }`)

### `pin`

Where remote control holds the hand (see `setPin`), or `null`.

- **Type**: `HandPin | null` (`{ anchor, target, wristRotation?, graspPinch? }`, GlobalSpace)
- **Readonly**

### `pinchValue`

Indicates the current level of the pinch gesture being emulated, with a range from `0` (no pinch) to `1` (full pinch). The pinch closes the thumb and index onto each other, relative to the palm; the wrist, the grip and the other fingers keep the pose. The hand selects when the pinch reaches `0.9` (gamepad button 0 `pressed`, `selectstart`) and lets go when it falls to `0.7` or below (`select`, then `selectend`); see `pinchThresholds` in [XRHandInputConfig](./config-interfaces.md#xrhandinputconfig).

- **Type**: `number`
- **Readonly**

The hand's gamepad has Quest Browser's layout: mapping `xr-standard`, 10 buttons, no axes. Button 0 is the pinch (the only button that fires events), buttons 1 to 3 are empty, 4 is the menu gesture and 5 to 9 are the microgestures: swipe left, swipe right, swipe forward, swipe backward and thumb tap (see `updateGestureButton`).

### `connected`

Reflects the connection status of the hand input, showing whether it's actively recognized and tracked within the XR session.

- **Type**: `boolean`

### `position`

The current 3D position of the hand input, allowing for movement tracking within the virtual environment.

- **Type**: `Vector3`
- **Readonly**

### `quaternion`

The current orientation of the hand input, represented as a quaternion for accurate gesture and direction tracking.

- **Type**: `Quaternion`
- **Readonly**

### `inputSource`

Provides access to the `XRInputSource` associated with this hand input, integrating it with the XR input system.

- **Type**: `XRInputSource`
- **Readonly**

## Methods

### `updateHandPose`

Executes the pose update logic, adjusting the virtual hand's current pose based on the active `poseId`, finger blends, any pose change in progress and `pinchValue`, then re-applies the pin (`setPin`). Runs every frame.

```typescript
updateHandPose(): void
```

### `beginPoseTransition`

Starts a timed change to `poseId` (with optional finger blends): the hand fades from what it shows now, before pinch and mid-change included, as `poseTransitionProgress` goes from `0` to `1`. `poseId` and `fingerPoses` report the new pose right away. Joints blend relative to their parents along the shortest arc, as finger blends do. Returns `false` for an unknown pose. Remote control's `set_hand_pose` with a `duration` drives this.

```typescript
beginPoseTransition(poseId: string, fingers?: Partial<Record<XRHandFinger, FingerPoseBlend>>): boolean
```

### `setPin`

Holds a point of the hand at a position from now on: after every shape update (pose, finger blends, pose change, pinch), the target ray moves so that `anchor` sits on `target`. With `wristRotation`, the target ray also turns so the wrist keeps that rotation. Applies right away; pass `null` to let go. Remote control's `anchor` parameter sets pins, and drops them when it lets go of the device.

```typescript
setPin(pin: HandPin | null): void
```

- `anchor`: **HandAnchor** - `target-ray`, `wrist`, `grip`, `grasp` (where the thumb and index tips meet in a full pinch), `index-tip`, `thumb-tip`, or any WebXR joint name.
- `target`: **vec3** - GlobalSpace position.
- `wristRotation`: **quat** - Optional GlobalSpace wrist rotation.
- `graspPinch`: **number** - For `grasp`: the pinch value the point is taken at (default `1`).

### `anchorOffset`

An anchor's position in the target-ray frame for the hand as shown now. `grasp` is fixed for the displayed pose (it does not move with the pinch).

```typescript
anchorOffset(anchor: HandAnchor, out?: vec3, graspPinch?: number): vec3
```

### `wristRotation`

The wrist's rotation in GlobalSpace for the hand as shown now.

```typescript
wristRotation(out?: quat): quat
```

### `handAxes`

The hand's directions in the target-ray frame, from the displayed wrist: `fingers` (wrist −Z), `palm` (wrist −Y, the way the palm faces) and `thumb` (toward the thumb side, on either hand).

```typescript
handAxes(): { fingers: vec3; palm: vec3; thumb: vec3 }
```

### `setFingerPose`

Takes one finger from another pose while the rest of the hand keeps `poseId`. Each joint blends relative to its parent joint and the finger stays attached to the base pose's palm. At a partial `weight`, each bone's length lies between its lengths in the two poses. The 21 generated poses are built on the captured `default` skeleton, so between them each finger's bones keep exactly the same lengths; the captured `pinch` and `point` come from other captures and differ slightly.

The blended finger is computed when `poseId`, `setFingerPose` or `clearFingerPoses` changes, not every frame.

```typescript
setFingerPose(finger: XRHandFinger, poseId: string, weight?: number): void
```

- `finger`: **XRHandFinger** - `thumb`, `index`, `middle`, `ring` or `pinky`.
- `poseId`: **string** - The pose to take the finger from.
- `weight`: **number** - `0` keeps the base pose's finger, `1` (default) uses the finger from `poseId`.

### `clearFingerPoses`

Clears the blend for one finger, or for every finger if called without arguments.

```typescript
clearFingerPoses(finger?: XRHandFinger): void
```

### `updateGestureButton`

Writes one of the gamepad's gesture buttons for the next frame: `1` pressed, `0` released. These buttons fire no session events; apps read them from the gamepad. Quest holds a recognized microgesture down for about 35 ms; remote control's `microgesture` does the same and moves the thumb too.

```typescript
updateGestureButton(id: HandGestureButton, value: 0 | 1): void
```

- `id`: **HandGestureButton** - `menu` (button 4), `swipe-left`, `swipe-right`, `swipe-forward`, `swipe-backward` or `tap` (buttons 5 to 9).

### `updatePinchValue`

Modifies the emulation level of the pinch gesture. This method allows for the simulation of pinch gestures to various degrees, enhancing interaction realism within the virtual environment.

```typescript
updatePinchValue(value: number): void
```

- `value`: **number** - The new pinch intensity, where `0` indicates no pinch and `1` indicates a fully engaged pinch gesture.
