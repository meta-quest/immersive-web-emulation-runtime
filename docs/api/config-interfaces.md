---
outline: deep
---

# Configuration Interfaces

## XRDeviceConfig

- **`name`**: **string**  
  The name of the XR device.

- **`controllerConfig`**: **XRControllerConfig | undefined**  
  Configuration for the device's controllers. It is `undefined` if no controllers are used.

- **`supportedSessionModes`**: **XRSessionMode[]**  
  Session modes the device supports (e.g., `inline`, `immersive-vr`, `immersive-ar`).

- **`supportedFeatures`**: **WebXRFeatures[]**  
  Features supported by the device, such as `hand-tracking`, `hit-test`, etc.

- **`supportedFrameRates`**: **number[]**  
  Frame rates supported by the device for rendering.

- **`isSystemKeyboardSupported`**: **boolean**  
  Indicates if system keyboard input is supported.

- **`internalNominalFrameRate`**: **number**  
  The device's nominal internal frame rate.

## XRDeviceOptions

- **`ipd`**: **number**  
  Interpupillary distance in meters, affecting stereo rendering.

- **`fovy`**: **number**  
  Field of view on the Y-axis in radians.

- **`stereoEnabled`**: **boolean**  
  Enables or disables stereo rendering.

- **`headsetPosition`**: **Vector3**  
  The initial position of the headset in 3D space.

- **`headsetQuaternion`**: **Quaternion**  
  The initial orientation of the headset.

- **`canvasContainer`**: **HTMLDivElement**  
  The HTML container for the rendering canvas.

## XRControllerConfig

- **`profileId`**: **string**  
  Identifier for the controller profile.

- **`fallbackProfileIds`**: **string[]**  
  Identifiers for fallback controller profiles.

- **`layout`**: **{ [handedness in XRHandedness]?: { gamepad: GamepadConfig; gripOffsetMatrix?: mat4; numHapticActuators: number; } }**  
  Maps handedness to controller configurations, including gamepad layout and optional grip offset.

## HandPose

- **`jointTransforms`**: **{ [joint in XRHandJoint]: { offsetMatrix: mat4; radius: number; } }**  
  Pose data for each joint in the hand, including transformation matrix and joint radius.

- **`gripOffsetMatrix`**: **mat4?**  
  Optional matrix to offset the grip position.

## XRHandInputConfig

- **`profileId`**: **string**  
  Identifier for the hand input profile.

- **`fallbackProfileIds`**: **string[]**  
  Identifiers for fallback hand input profiles.

- **`poses`**: **{ default: HandPose; pinch: HandPose; [poseId: string]: HandPose; }**  
  Contains hand pose configurations for default, pinch, and additional customizable poses.
