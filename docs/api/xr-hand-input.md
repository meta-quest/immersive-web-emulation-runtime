---
outline: deep
---

# XRHandInput Class

The `XRHandInput` class emulates hand input within WebXR environments. It supports detailed hand pose emulation and gesture recognition, allowing for immersive interactions within the virtual space.

## Properties

### `poseId`

Specifies the current hand pose being emulated, such as `default`, `pinch`, `fist`, or other custom poses defined in the configuration.

- **Type**: `string`
- Allows dynamic update to the hand pose through a setter. Changing the `poseId` triggers an update in the hand's pose based on the configuration associated with the new pose ID, and clears any finger blends.

### `poseIds`

Every pose id this hand can take: the built-in library (`BUILTIN_HAND_POSE_IDS`) for the default config, or the keys of a custom config's `poses`.

- **Type**: `string[]`
- **Readonly**

### `fingerPoses`

Fingers currently taken from other poses on top of `poseId`, keyed by finger (`thumb`, `index`, `middle`, `ring`, `pinky`). Each read returns a copy; change blends with `setFingerPose` and `clearFingerPoses`.

- **Type**: `Partial<Record<XRHandFinger, { poseId: string; weight: number }>>`
- **Readonly**

### `pinchValue`

Indicates the current level of the pinch gesture being emulated, with a range from `0` (no pinch) to `1` (full pinch).

- **Type**: `number`
- **Readonly**

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

Executes the pose update logic, adjusting the virtual hand's current pose based on the active `poseId` and `pinchValue`. This method facilitates the interpolation between different hand poses and pinch gestures for dynamic hand gesture emulation.

```typescript
updateHandPose(): void
```

### `setFingerPose`

Takes one finger from another pose while the rest of the hand keeps `poseId`. Each joint blends relative to its parent joint and the finger stays attached to the base pose's palm. At a partial `weight`, each bone's length lies between its lengths in the two poses. The 20 generated poses are built on the captured `default` skeleton, so between them each finger's bones keep exactly the same lengths; the captured `pinch` and `point` come from other captures and differ slightly.

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

### `updatePinchValue`

Modifies the emulation level of the pinch gesture. This method allows for the simulation of pinch gestures to various degrees, enhancing interaction realism within the virtual environment.

```typescript
updatePinchValue(value: number): void
```

- `value`: **number** - The new pinch intensity, where `0` indicates no pinch and `1` indicates a fully engaged pinch gesture.
