/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `iwer/host`: the entry point for native hosts that run IWER in host mode
 * (see host/types.ts). It exposes the WebXR implementation and the host
 * contract and leaves out what only an emulator in a browser needs:
 * RemoteControlInterface, ActionRecorder / ActionPlayer, the native WebXR
 * override and the WebXR Layers polyfill.
 *
 * `XRDevice` here is the shared device model without those parts:
 * `device.remote` is null, `createActionPlayer` throws NotSupportedError and
 * `installRuntime({ polyfillLayers: true })` only warns. Everything else
 * matches the main `iwer` entry.
 */

// device model
export { XRDeviceBase as XRDevice } from './device/XRDeviceBase.js';
export type {
  RuntimeOptions,
  WebXRFeature,
  XRDeviceConfig,
  XRDeviceOptions,
  XRGlobalObject,
} from './device/XRDeviceBase.js';
export {
  metaQuest2,
  metaQuest3,
  metaQuestPro,
  metaVRGlasses,
  oculusQuest1,
} from './device/configs/headset/meta.js';
export {
  oculusTouchV2,
  oculusTouchV3,
  metaQuestTouchPro,
  metaQuestTouchPlus,
} from './device/configs/controller/meta.js';
export { generic } from './device/configs/controller/generic.js';
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

// host contract
export type {
  XRHostBackend,
  XRHostErrorSource,
  XRHostEvent,
  XRHostFrame,
  XRHostSwapchain,
  XRHostSwapchainOptions,
} from './host/types.js';
export { HOST_VIEW_STRIDE } from './host/math.js';
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

// WebXR implementation
export { XRSystem } from './initialization/XRSystem.js';
export { XRSession } from './session/XRSession.js';
export { XRRenderState } from './session/XRRenderState.js';
export { XRFrame } from './frameloop/XRFrame.js';
export { XRSpace, GlobalSpace } from './spaces/XRSpace.js';
export {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from './spaces/XRReferenceSpace.js';
export { XRBoundedReferenceSpace } from './spaces/XRBoundedReferenceSpace.js';
export { XRJointSpace } from './spaces/XRJointSpace.js';
export { XRView } from './views/XRView.js';
export { XRViewport } from './views/XRViewport.js';
export { XRRigidTransform } from './primitives/XRRigidTransform.js';
export { XRPose } from './pose/XRPose.js';
export { XRViewerPose } from './pose/XRViewerPose.js';
export { XRJointPose } from './pose/XRJointPose.js';
export { XRInputSource, XRInputSourceArray } from './input/XRInputSource.js';
export { XRHand } from './input/XRHand.js';
export { XRWebGLLayer, XRLayer } from './layers/XRWebGLLayer.js';
export {
  XRCompositionLayer,
  XRProjectionLayer,
  XRWebGLSubImage,
} from './layers/XRProjectionLayer.js';
export { XRHostWebGLBinding } from './host/XRHostWebGLBinding.js';
export { XRPlane, XRPlaneSet, NativePlane } from './planes/XRPlane.js';
export { XRMesh, XRMeshSet, NativeMesh } from './meshes/XRMesh.js';
export { XRSemanticLabels } from './labels/labels.js';
export { XRAnchor, XRAnchorSet } from './anchors/XRAnchor.js';
export { XRSessionEvent } from './events/XRSessionEvent.js';
export { XRInputSourceEvent } from './events/XRInputSourceEvent.js';
export { XRInputSourcesChangeEvent } from './events/XRInputSourcesChangeEvent.js';
export { XRReferenceSpaceEvent } from './events/XRReferenceSpaceEvent.js';

// private keys, for adapters that reach into IWER objects
export * from './private.js';
