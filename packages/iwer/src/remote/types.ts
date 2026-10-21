/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { Vec3, Quat, EulerRotation, InputMode } from '../types/state.js';
import type {
  FingerPoseBlend,
  HandAnchor,
  XRHandFinger,
} from '../device/XRHandInput.js';
import type { Easing, NamedDirection } from './hand-motion.js';

// =============================================================================
// Device Identifiers
// =============================================================================

/**
 * Unified identifier for all tracked devices
 */
export type DeviceId =
  | 'headset'
  | 'controller-left'
  | 'controller-right'
  | 'hand-left'
  | 'hand-right'
  | 'gaze';

/**
 * Device identifiers that expose a pose.
 */
export type PoseDeviceId = DeviceId;

/** Device identifiers whose connected state can be changed. */
export type ConnectedInputDeviceId = Exclude<DeviceId, 'headset'>;

/** Device identifiers that can produce select state. Gaze is pose-only. */
export type SelectableDeviceId =
  | 'controller-left'
  | 'controller-right'
  | 'hand-left'
  | 'hand-right';

/** @deprecated Use ConnectedInputDeviceId or SelectableDeviceId as appropriate. */
export type InputDeviceId = ConnectedInputDeviceId;

/**
 * Controller device identifiers
 */
export type ControllerId = 'controller-left' | 'controller-right';

// =============================================================================
// Action Types
// =============================================================================

/**
 * Base action interface with common properties
 */
interface BaseAction {
  id: string;
  method: string;
  params: Record<string, unknown>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Discrete action - executes immediately when processed
 */
export interface DiscreteAction extends BaseAction {
  type: 'discrete';
}

/**
 * Timed action - runs over several frames and holds the head of the queue
 * until it finishes.
 */
export interface TickAction extends BaseAction {
  type: 'tick';
  started: boolean;
  /** Called on the first frame the action runs (captures start state). */
  start: () => void;
  /**
   * Advances by `deltaMs`; returns the time left over once finished (carried
   * into the next action), or -1 while still running.
   */
  tick: (deltaMs: number) => number;
  result: () => unknown;
}

/** @deprecated Timed actions are {@link TickAction}s. */
export type DurationAction = TickAction;

/**
 * Union of all action types
 */
export type Action = DiscreteAction | TickAction;

// =============================================================================
// Tool Parameter Types
// =============================================================================

/**
 * Orientation can be specified as quaternion or euler angles (partial euler angles allowed, missing default to 0)
 */
export type OrientationInput = Quat | Partial<EulerRotation>;

/** A direction as `{x, y, z}`, `[x, y, z]`, or a name relative to the body. */
export type DirectionInput = Vec3 | [number, number, number] | NamedDirection;

/**
 * A hand orientation by direction (XR-origin): where the fingers point and the
 * way the palm faces, or the thumb side of the hand. `fingers` is kept exact.
 */
export interface HandOrientationInput {
  fingers: DirectionInput;
  palm?: DirectionInput;
  thumb?: DirectionInput;
}

/**
 * Orientation for a placement: a quaternion or euler angles for the device
 * (for hands, the target ray), hand directions, or `'auto'` (hands only: a
 * natural reach toward the position from the shoulder).
 */
export type PlacementOrientationInput =
  | OrientationInput
  | HandOrientationInput
  | 'auto';

/**
 * Parameters for get_transform tool
 */
export interface GetTransformParams {
  device: PoseDeviceId;
}

/**
 * Result of get_transform tool
 */
export interface GetTransformResult {
  device: PoseDeviceId;
  position: Vec3;
  orientation: Quat;
  euler: EulerRotation;
}

/**
 * Parameters for set_transform tool
 */
export interface SetTransformParams {
  device: PoseDeviceId;
  position?: Vec3;
  orientation?: PlacementOrientationInput;
  /** Hands: the point of the hand `position` places (default `target-ray`). */
  anchor?: HandAnchor;
}

/**
 * Result of set_transform tool
 */
export interface SetTransformResult {
  device: PoseDeviceId;
  position: Vec3;
  orientation: Quat;
}

/**
 * Parameters for look_at tool
 */
export interface LookAtParams {
  device: PoseDeviceId;
  target: Vec3;
  moveToDistance?: number;
}

/**
 * Result of look_at tool
 */
export interface LookAtResult {
  device: PoseDeviceId;
  position: Vec3;
  orientation: Quat;
}

/**
 * Parameters for animate_to tool
 */
export interface AnimateToParams {
  device: PoseDeviceId;
  position?: Vec3;
  orientation?: PlacementOrientationInput;
  duration?: number; // seconds, default: 0.5
  easing?: Easing; // default: 'linear'
  /** Hands: the point of the hand `position` places (default `target-ray`). */
  anchor?: HandAnchor;
}

/**
 * Result of animate_to tool
 */
export interface AnimateToResult {
  device: PoseDeviceId;
  position: Vec3;
  orientation: Quat;
  actualDuration: number; // actual time taken in seconds
}

/**
 * Parameters for set_input_mode tool
 */
export interface SetInputModeParams {
  mode: InputMode;
}

/**
 * Result of set_input_mode tool
 */
export interface SetInputModeResult {
  mode: InputMode;
  activeDevices: DeviceId[];
}

/**
 * Parameters for set_connected tool
 */
export interface SetConnectedParams {
  device: ConnectedInputDeviceId;
  connected: boolean;
}

/**
 * Result of set_connected tool
 */
export interface SetConnectedResult {
  device: ConnectedInputDeviceId;
  connected: boolean;
}

/**
 * Parameters for get_select_value tool
 */
export interface GetSelectValueParams {
  device: SelectableDeviceId;
}

/**
 * Result of get_select_value tool
 */
export interface GetSelectValueResult {
  device: SelectableDeviceId;
  value: number;
}

/**
 * Parameters for set_select_value tool
 */
export interface SetSelectValueParams {
  device: SelectableDeviceId;
  value: number;
  /** Seconds to ramp from the current value (default: instant). */
  duration?: number;
  easing?: Easing;
}

/**
 * Result of set_select_value tool
 */
export interface SetSelectValueResult {
  device: SelectableDeviceId;
  value: number;
}

/**
 * Parameters for set_hand_pose tool
 */
export interface SetHandPoseParams {
  device: 'hand-left' | 'hand-right';
  poseId: string;
  /** Per-finger overrides: a pose id, or a pose id with a 0-1 blend weight. */
  fingers?: Partial<
    Record<XRHandFinger, string | { poseId: string; weight?: number }>
  >;
  /** Seconds to fade from the hand as shown (default: instant). */
  duration?: number;
  easing?: Easing;
}

/**
 * Result of set_hand_pose tool
 */
export interface SetHandPoseResult {
  device: 'hand-left' | 'hand-right';
  poseId: string;
  fingers: Partial<Record<XRHandFinger, FingerPoseBlend>>;
}

/**
 * Parameters for get_hand_state tool
 */
export interface GetHandStateParams {
  device: 'hand-left' | 'hand-right';
  /** `'all'` adds every joint's position and radius. */
  joints?: 'key' | 'all';
}

/**
 * Result of get_hand_state tool (positions and orientations XR-origin)
 */
export interface GetHandStateResult {
  device: 'hand-left' | 'hand-right';
  connected: boolean;
  poseId: string;
  fingers: Partial<Record<XRHandFinger, FingerPoseBlend>>;
  /** A timed pose change in progress: the pose it fades from, and how far. */
  transition: { from: string; progress: number } | null;
  pinchValue: number;
  pressed: boolean;
  position: Vec3;
  orientation: Quat;
  pin: { anchor: HandAnchor; target: Vec3 } | null;
  anchors: Record<'wrist' | 'grip' | 'grasp' | 'index-tip' | 'thumb-tip', Vec3>;
  axes: { fingers: Vec3; palm: Vec3; thumb: Vec3 };
  joints?: Record<string, { position: Vec3; radius: number }>;
}

/**
 * Parameters for select tool
 */
export interface SelectParams {
  device: SelectableDeviceId;
  duration?: number; // seconds, default: 0.3
}

/**
 * Result of select tool
 */
export interface SelectResult {
  device: SelectableDeviceId;
  duration: number;
}

/**
 * Button info for gamepad state
 */
export interface GamepadButtonInfo {
  index: number;
  name: string;
  value: number;
  touched: boolean;
  pressed: boolean;
}

/**
 * Axis info for gamepad state
 */
export interface GamepadAxisInfo {
  index: number;
  name: string;
  value: number;
}

/**
 * Parameters for get_gamepad_state tool
 */
export interface GetGamepadStateParams {
  device: ControllerId;
}

/**
 * Result of get_gamepad_state tool
 */
export interface GetGamepadStateResult {
  device: ControllerId;
  connected: boolean;
  buttons: GamepadButtonInfo[];
  axes: GamepadAxisInfo[];
}

/**
 * Button input for set_gamepad_state
 */
export interface GamepadButtonInput {
  index: number;
  value: number;
  touched?: boolean;
}

/**
 * Axis input for set_gamepad_state
 */
export interface GamepadAxisInput {
  index: number;
  value: number;
}

/**
 * Parameters for set_gamepad_state tool
 */
export interface SetGamepadStateParams {
  device: ControllerId;
  buttons?: GamepadButtonInput[];
  axes?: GamepadAxisInput[];
}

/**
 * Result of set_gamepad_state tool
 */
export interface SetGamepadStateResult {
  device: ControllerId;
  buttonsSet: number;
  axesSet: number;
}

// =============================================================================
// Session Types
// =============================================================================

/**
 * Session status for get_session_status
 */
export interface RemoteSessionStatus {
  deviceName: string;
  isRuntimeInstalled: boolean;
  sessionActive: boolean;
  sessionOffered: boolean;
  sessionMode: 'immersive-vr' | 'immersive-ar' | 'inline' | null;
  enabledFeatures: string[];
  visibilityState: 'visible' | 'visible-blurred' | 'hidden';
  runtimeKind: 'emulated' | 'native';
}

/**
 * Result of accept_session
 */
export interface AcceptSessionResult {
  success: boolean;
}

/**
 * Result of end_session
 */
export interface EndSessionResult {
  success: boolean;
}

// =============================================================================
// Device State Types
// =============================================================================

/** A hand in get_device_state / set_device_state. */
export interface RemoteHandState {
  connected: boolean;
  position: Vec3;
  orientation: Quat;
  poseId?: string;
  pinchValue?: number;
}

/**
 * Full device state for get_device_state
 */
export interface RemoteDeviceState {
  headset: {
    position: Vec3;
    orientation: Quat;
  };
  inputMode: InputMode;
  controllers: {
    left: { connected: boolean; position: Vec3; orientation: Quat };
    right: { connected: boolean; position: Vec3; orientation: Quat };
  };
  hands: {
    left: RemoteHandState;
    right: RemoteHandState;
  };
  gaze?: {
    connected: boolean;
    orientation: Quat;
  };
  stereoEnabled: boolean;
  fov: number;
}

/**
 * Parameters for set_device_state
 */
export interface SetDeviceStateParams {
  state?: Partial<RemoteDeviceState>;
}

/**
 * Result of set_device_state
 */
export interface SetDeviceStateResult {
  state: RemoteDeviceState;
}
