---
outline: deep
---

# XRController Class

The `XRController` class represents an emulated XR input device, such as a handheld controller, used within WebXR projects.

## Properties

Properties of the `XRController` class provide access to the controller's current state, including its connection status, position, orientation, and the associated input source.

### `connected`

Indicates whether the controller is currently connected and active.

- **Type**: `boolean`

### `position`

Provides the current position of the controller in the 3D space, enabling position tracking within the virtual environment.

- **Type**: `Vector3`
- **Readonly**

### `quaternion`

Describes the current orientation of the controller as a quaternion, essential for accurate directional tracking.

- **Type**: `Quaternion`
- **Readonly**

### `inputSource`

Accesses the underlying `XRInputSource` object for this controller, linking it to the broader XR input system.

- **Type**: `XRInputSource`
- **Readonly**

## Methods

Methods of the `XRController` class allow for dynamic updates to the controller's state, simulating user interactions such as button presses, touch, and movement along axes.

### `updateButtonValue`

Simulates the press or release of a button on the controller by updating its value.

```typescript
updateButtonValue(id: string, value: number): void
```

- `id`: **string** - The identifier for the button to update.
- `value`: **number** - The new value for the button, with `0` indicating unpressed and `1` indicating fully pressed.

### `updateButtonTouch`

Simulates touching or releasing a touch-sensitive button on the controller.

```typescript
updateButtonTouch(id: string, touched: boolean): void
```

- `id`: **string** - The identifier for the button to update.
- `touched`: **boolean** - Indicates whether the button is being touched.

### `updateAxis`

Updates the value of a specific axis, such as a thumbstick or touchpad direction.

```typescript
updateAxis(id: string, type: 'x-axis' | 'y-axis', value: number): void
```

- `id`: **string** - The identifier for the axis group to update.
- `type`: **'x-axis' | 'y-axis'** - Specifies which axis to update.
- `value`: **number** - The new value for the axis, between `-1` (full negative) and `1` (full positive).

### `updateAxes`

Simultaneously updates the values of both axes for a specific control element on the controller.

```typescript
updateAxes(id: string, x: number, y: number): void
```

- `id`: **string** - The identifier for the axis group to update.
- `x`: **number** - The new value for the x-axis.
- `y`: **number** - The new value for the y-axis.
