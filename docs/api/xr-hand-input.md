---
outline: deep
---

# XRHandInput Class

The `XRHandInput` class emulates hand input within WebXR environments. It supports detailed hand pose emulation and gesture recognition, allowing for immersive interactions within the virtual space.

## Properties

### `poseId`

Specifies the current hand pose being emulated, such as `default`, `pinch`, or other custom poses defined in the configuration.

- **Type**: `string`
- Allows dynamic update to the hand pose through a setter. Changing the `poseId` triggers an update in the hand's pose based on the configuration associated with the new pose ID.

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

### `updatePinchValue`

Modifies the emulation level of the pinch gesture. This method allows for the simulation of pinch gestures to various degrees, enhancing interaction realism within the virtual environment.

```typescript
updatePinchValue(value: number): void
```

- `value`: **number** - The new pinch intensity, where `0` indicates no pinch and `1` indicates a fully engaged pinch gesture.
