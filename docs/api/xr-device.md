---
outline: deep
---

# XRDevice Class

The `XRDevice` class is a central component of the Immersive Web Emulation Runtime (IWER), designed to emulate an XR device within WebXR projects. It provides a comprehensive interface for controlling and interacting with the virtual XR environment, including headset positioning, input sources (controllers and hands), and session management.

## Constructor

```typescript
constructor(
  deviceConfig: XRDeviceConfig,
  deviceOptions?: Partial<XRDeviceOptions>
)
```

- `deviceConfig:` [`XRDeviceConfig`](/api/config-interfaces#xrdeviceconfig) - Configuration object for the device, including supported features, session modes, and controller configurations.
- `deviceOptions?:` [`Partial<XRDeviceOptions>`](/api/config-interfaces#xrdeviceoptions) - Optional configuration for the device instance, such as initial IPD, FOV, and stereo rendering settings.

## Properties

### `supportedSessionModes`

An array of session modes that the emulated device supports, defining the types of XR sessions the device can initiate.

- **Type**: `XRSessionMode[]`
- **Readonly**

### `supportedFeatures`

An array of WebXR features that the emulated device supports. This can include features like hand tracking, hit testing, etc.

- **Type**: `WebXRFeatures[]`
- **Readonly**

### `supportedFrameRates`

An array of frame rates supported by the emulated device, useful for ensuring compatibility with performance requirements.

- **Type**: `number[]`
- **Readonly**

### `isSystemKeyboardSupported`

Indicates whether the system keyboard is supported by the emulated device. This is particularly relevant for experiences that require text input.

- **Type**: `boolean`
- **Readonly**

### `internalNominalFrameRate`

The nominal frame rate internal to the device emulation. It represents the frame rate at which the emulated device ideally operates.

- **Type**: `number`
- **Readonly**

### `stereoEnabled`

Indicates whether stereo rendering is enabled. When true, the device renders separate views for the left and right eyes, creating a stereoscopic effect.

- **Type**: `boolean`

### `ipd`

The Interpupillary Distance (IPD) of the emulated device, representing the distance between the centers of the pupils of the eyes. This is important for rendering scenes correctly in 3D space.

- **Type**: `number`

### `fovy`

The Field of View on the Y-axis, controlling how wide the visible area is in the vertical direction. Adjusting this can simulate different visual experiences.

- **Type**: `number`

### `position`

The current position of the emulated device in the 3D space. This vector represents where the device is located within the virtual environment.

- **Type**: `Vector3`
- **Readonly**

### `quaternion`

The current orientation of the emulated device represented as a quaternion. This determines the direction the device is facing in the 3D space.

- **Type**: `Quaternion`
- **Readonly**

### `controllers`

A collection of emulated XR controllers indexed by handedness (`left`, `right` or `none`). Each controller's state can be accessed and manipulated through this property.

- **Type**: `{ [key in XRHandedness]?: XRController }`
- **Readonly**

### `hands`

A collection of emulated XR hands indexed by handedness (`left` or `right`). This property provides access to the state and configuration of virtual hands within the XR environment.

- **Type**: `{ [key in XRHandedness]?: XRHandInput }`
- **Readonly**

### `primaryInputMode`

Determines the primary input mode, either `controller` or `hand`. This affects which set of inputs are considered active and can be dynamically changed based on the needs of the XR experience.

- **Type**: `'controller' | 'hand'`

### `activeInputs`

A list of currently active inputs (controllers or hands) based on the visibility state and primary input mode. This property dynamically reflects the inputs available at any given time.

- **Type**: `XRTrackedInput[]`
- **Readonly**

### `inputSources`

A list of current input sources available in the XR session. This includes all active controllers and hands, providing a unified way to access input data.

- **Type**: `XRInputSource[]`
- **Readonly**

### `canvasContainer`

The HTML container element for the canvas used by the XR device emulation. This container is automatically managed by the emulation runtime and is used to render the virtual environment.

- **Type**: `HTMLDivElement`
- **Readonly**

### `visibilityState`

The current visibility state of the XR session, which can be one of the states defined by the `XRVisibilityState` enum. This property is read-only and reflects changes triggered by the system or the application.

- **Type**: `XRVisibilityState`
- **Readonly**

## Methods

### `recenter`

Adjusts the user's position to the center of the reference space, effectively resetting their location within the virtual environment. This can be particularly useful for aligning the user's physical and virtual positions.

```typescript
recenter(): void
```

### `updateVisibilityState`

Modifies the current visibility state of the XR session. This method is used to simulate changes in the session's visibility, such as when the application is minimized or obscured by another application.

```typescript
updateVisibilityState(state: XRVisibilityState): void
```

- `state`: **XRVisibilityState** - The new visibility state to apply to the XR session.
