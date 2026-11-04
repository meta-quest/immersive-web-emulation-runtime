/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// model
export { XRDevice, XRDeviceConfig } from './device/XRDevice.js';
export type { RuntimeOptions, XRGlobalObject } from './device/XRDevice.js';
export type { XRDeviceOptions } from './device/XRDevice.js';
export {
  metaQuest2,
  metaQuest3,
  metaQuestPro,
  metaVRGlasses,
  oculusQuest1,
  metaVRGlassesVisibilityMask,
} from './device/configs/headset/meta.js';
export type {
  XRFieldOfView,
  XRVisibilityMask,
  XRVisibilityMaskBounds,
} from './device/XRVisibilityMask.js';
export { calculateVisibilityMaskBounds } from './device/XRVisibilityMask.js';

// Host input (real tracking driving the input sources; see HOST-INPUT.md)
export {
  XRHostInput,
  XRHostInputState,
  XRHostInputMode,
  XRHostController,
  XRHostHand,
  HOST_INPUT_BUTTONS,
  HOST_INPUT_JOINTS,
  HOST_INPUT_JOINT_STRIDE,
  HOST_INPUT_POSE_STRIDE,
} from './device/XRHostInput.js';
export type {
  XRHostInputOptions,
  XRHostHapticCallback,
  XRHostHandedness,
} from './device/XRHostInput.js';

// Controller Configs
export {
  oculusTouchV2,
  oculusTouchV3,
  metaQuestTouchPro,
  metaQuestTouchPlus,
} from './device/configs/controller/meta.js';
export { generic } from './device/configs/controller/generic.js';

// Controller / Gamepad Config Types
export type { XRControllerConfig } from './device/XRController.js';
export { GamepadMappingType } from './gamepad/Gamepad.js';
export type {
  GamepadConfig,
  Button,
  Axis,
  GamepadEffectParameters,
  GamepadHapticEffectType,
  GamepadHapticPulseHook,
  GamepadHapticsResult,
} from './gamepad/Gamepad.js';

// Remote Control Interface
export { RemoteControlInterface, MICROGESTURES } from './remote/index.js';
export type {
  DeviceId,
  PoseDeviceId,
  ConnectedInputDeviceId,
  SelectableDeviceId,
  InputDeviceId,
  ControllerId,
  Action,
  DiscreteAction,
  TickAction,
  DurationAction,
  OrientationInput,
  DirectionInput,
  HandOrientationInput,
  PlacementOrientationInput,
  GetTransformParams,
  GetTransformResult,
  SetTransformParams,
  SetTransformResult,
  LookAtParams,
  LookAtResult,
  AnimateToParams,
  AnimateToResult,
  SetInputModeParams,
  SetInputModeResult,
  SetConnectedParams,
  SetConnectedResult,
  GetSelectValueParams,
  GetSelectValueResult,
  SetSelectValueParams,
  SetSelectValueResult,
  SetHandPoseParams,
  SetHandPoseResult,
  GetHandStateParams,
  GetHandStateResult,
  MicrogestureParams,
  MicrogestureResult,
  Microgesture,
  SequencePosition,
  SequenceTarget,
  TargetFace,
  TargetIntent,
  ResolvedTarget,
  TargetResolver,
  TimedInput,
  SequenceStep,
  RunSequenceParams,
  SequenceResult,
  SequencePlan,
  CancelSequenceResult,
  ListTargetsResult,
  SelectParams,
  SelectResult,
  GamepadButtonInfo,
  GamepadAxisInfo,
  GetGamepadStateParams,
  GetGamepadStateResult,
  GamepadButtonInput,
  GamepadAxisInput,
  SetGamepadStateParams,
  SetGamepadStateResult,
  RemoteSessionStatus,
  AcceptSessionResult,
  EndSessionResult,
  RemoteDeviceState,
  RemoteHandState,
  SetDeviceStateParams,
  SetDeviceStateResult,
  Easing,
  NamedDirection,
} from './remote/index.js';

// Control Types
export type {
  Vec3,
  Quat,
  EulerRotation,
  InputMode,
  ControlMode,
} from './types/state.js';

// Control Math Utilities
export {
  eulerToQuat,
  quatToEuler,
  directionTo,
  lookRotation,
  vec3ToObj,
  quatToObj,
  waitForCondition,
} from './utils/control-math.js';

// Initialization
export { XRSystem } from './initialization/XRSystem.js';

// Native WebXR selective override
export {
  getNativeOverride,
  getNativeOverrideSupport,
  installNativeOverride,
  XRNativeOverride,
} from './native/index.js';
export type {
  NativeOverrideCapabilities,
  NativeOverrideEnvironment,
  NativeOverrideHandle,
  NativeOverrideMode,
  NativeOverrideOptions,
  NativeOverridePhase,
  NativeOverrideSupport,
  NativeSessionInfo,
} from './native/index.js';

// Host mode: a native host drives frames and backs layers (host/types.ts)
export type {
  XRHostBackend,
  XRHostErrorSource,
  XRHostEvent,
  XRHostFrame,
  XRHostSwapchain,
  XRHostSwapchainOptions,
} from './host/types.js';
export { XRHostWebGLBinding } from './host/XRHostWebGLBinding.js';
export {
  XRCompositionLayer,
  XRProjectionLayer,
  XRWebGLSubImage,
} from './layers/XRProjectionLayer.js';

// Session
export { XRRenderState } from './session/XRRenderState.js';
export { XRSession } from './session/XRSession.js';

// Frame Loop
export { XRFrame } from './frameloop/XRFrame.js';

// Spaces
export { XRSpace, GlobalSpace } from './spaces/XRSpace.js';
export {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from './spaces/XRReferenceSpace.js';
export { XRJointSpace } from './spaces/XRJointSpace.js';
export { XRBoundedReferenceSpace } from './spaces/XRBoundedReferenceSpace.js';

// Views
export { XRView } from './views/XRView.js';
export { XRViewport } from './views/XRViewport.js';

// Primitives
export { XRRigidTransform } from './primitives/XRRigidTransform.js';

// Pose
export { XRPose } from './pose/XRPose.js';
export { XRViewerPose } from './pose/XRViewerPose.js';
export { XRJointPose } from './pose/XRJointPose.js';

// Input
export { XRInputSource, XRInputSourceArray } from './input/XRInputSource.js';
export { XRHand } from './input/XRHand.js';
export { BUILTIN_HAND_POSE_IDS } from './device/configs/hand/ids.js';
export type { BuiltinHandPoseId } from './device/configs/hand/ids.js';
export type {
  FingerPoseBlend,
  HandAnchor,
  HandDirections,
  HandGestureButton,
  HandPin,
  ThumbMotion,
  XRHandFinger,
} from './device/XRHandInput.js';
export {
  XRGazeInput,
  GAZE_TRACKING_FEATURES,
  isGazeTrackingFeature,
  supportsGazeTracking,
} from './device/XRGazeInput.js';
export type { GazeTrackingFeature } from './device/XRGazeInput.js';

// Layers
export { XRWebGLLayer, XRLayer } from './layers/XRWebGLLayer.js';

// Planes
export { XRPlane, XRPlaneSet, NativePlane } from './planes/XRPlane.js';

// Meshes
export { XRMesh, XRMeshSet, NativeMesh } from './meshes/XRMesh.js';
export { XRSemanticLabels } from './labels/labels.js';

// Depth Sensing
export { XRCPUDepthInformation } from './depth/XRDepthInformation.js';
export {
  XRWebGLBinding,
  XRWebGLDepthInformation,
  type XRTextureType,
} from './depth/XRWebGLBinding.js';

// Anchors
export { XRAnchor, XRAnchorSet } from './anchors/XRAnchor.js';

// Hit Test
export { XRRay } from './hittest/XRRay.js';

// Events
export { XRSessionEvent } from './events/XRSessionEvent.js';
export { XRInputSourceEvent } from './events/XRInputSourceEvent.js';
export { XRInputSourcesChangeEvent } from './events/XRInputSourcesChangeEvent.js';
export { XRReferenceSpaceEvent } from './events/XRReferenceSpaceEvent.js';

// Action Recording/Playback
export { ActionRecorder } from './action/ActionRecorder.js';
export { ActionPlayer } from './action/ActionPlayer.js';
export type {
  ActionPlayerEventContext,
  ActionPlayerOptions,
  CompressedRecording,
} from './action/ActionPlayer.js';

// Private Keys
export * from './private.js';
