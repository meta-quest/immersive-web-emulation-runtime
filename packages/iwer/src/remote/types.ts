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
import type { Microgesture } from './microgesture.js';

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
  /**
   * When set, an interruption (cancel_sequence, forceRelease, the watchdog,
   * session end) after the action started resolves it with this instead of
   * rejecting it.
   */
  abort?: (reason: string) => unknown;
  /** Roughly how long the action runs, in milliseconds (time budgets). */
  estimateMs?: number;
  /** Milliseconds the action has run so far. */
  elapsedMs?: number;
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
 * Parameters for microgesture tool
 */
export interface MicrogestureParams {
  device: 'hand-left' | 'hand-right';
  gesture: Microgesture;
}

/**
 * Result of microgesture tool
 */
export interface MicrogestureResult {
  device: 'hand-left' | 'hand-right';
  gesture: Microgesture;
  /** The hand gamepad button that pulsed: 5 to 9. */
  button: number;
  /** When the button was pressed, in milliseconds from the command's start. */
  registeredAtMs: number;
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

// =============================================================================
// run_sequence
// =============================================================================

/**
 * A step position: `{x, y, z}` (optionally with the surface `normal`) or
 * `[x, y, z]` in the XR origin, or relative to the body: `relativeTo: 'head'`
 * is the standing head, `'body'` the floor under it; both turn with the body's
 * yaw (x right, y up, z back), never with head pitch or roll.
 */
export type SequencePosition =
  | { x: number; y: number; z: number; normal?: DirectionInput }
  | [number, number, number]
  | { relativeTo: 'head' | 'body'; x: number; y: number; z: number };

/** Which face of a target to use; the default is the face toward the body. */
export type TargetFace = 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right';

/** A target name (or id), optionally with the face to use. */
export type SequenceTarget = string | { name: string; face?: TargetFace };

/**
 * Why a step wants a target, passed to the resolver: `press` wants the face
 * to press, `grasp` the part to pinch, `place` the surface to set a held
 * object down on (an up-facing normal), `touch` anything else.
 */
export type TargetIntent = 'press' | 'grasp' | 'place' | 'touch';

/** What a target resolver returns, all XR-origin, in metres. */
export interface ResolvedTarget {
  /** The surface point the anchor should touch. */
  position: Vec3;
  /** Outward unit normal of that surface. Presses need it. */
  normal?: Vec3;
  /** The target's axis-aligned size. */
  size?: Vec3;
  /** The target's axis-aligned bounds (lets a held object be set down on its base). */
  box?: { min: Vec3; max: Vec3 };
  name?: string;
}

/**
 * Turns the target names in run_sequence steps into points in the scene.
 * The page registers one with `remote.setTargetResolver()`: an app framework
 * knows its objects, IWER does not.
 */
export interface TargetResolver {
  resolve(
    target: SequenceTarget,
    context: {
      device: 'hand-left' | 'hand-right';
      anchor: HandAnchor;
      intent: TargetIntent;
      /** The acting shoulder (XR-origin): "the face toward the body". */
      from: Vec3;
    },
  ): ResolvedTarget | null;
  /** Targets by name, with their box centre and size (XR-origin). */
  list?(): { name: string; position: Vec3; size?: Vec3 }[];
}

/**
 * A step property animated over the step, or over a window of it: `start`
 * and `end` are fractions of the step's reach (default 0 and 1).
 */
export type TimedInput<T> =
  | T
  | { value: T; start?: number; end?: number; easing?: Easing };

/** One step of a run_sequence. A step with only a `duration` holds. */
export interface SequenceStep {
  label?: string;
  /** Seconds for the reach, or `'auto'` (the default for moves). */
  duration?: number | 'auto';
  position?: SequencePosition;
  target?: SequenceTarget;
  /**
   * Added to the step's placement (or the current pin target without one);
   * `{ normal }` moves along the placement's normal.
   */
  offset?: Vec3 | { normal: number };
  /** Come straight in along `normal` (default: the surface normal) for the last `distance` metres. */
  approach?: { distance: number; normal?: DirectionInput };
  /** Lift straight off along `normal` (default: the last surface normal) first. */
  depart?: { distance: number; normal?: DirectionInput };
  /** Press the placement with the index fingertip (metres, seconds, metres). */
  press?: { depth?: number; hold?: number; retract?: number };
  anchor?: HandAnchor;
  orientation?: PlacementOrientationInput;
  poseId?: TimedInput<string>;
  fingers?: SetHandPoseParams['fingers'];
  /** Pinch 0-1, timed, or `{ value, at: 'arrival' }` to close as the hand arrives. */
  pinch?: TimedInput<number> | { value: number; at: 'arrival' };
  /**
   * Move the body first: to `position` (its height is ignored), or to a
   * comfortable standing point for `stepTo`; `facing` turns it.
   */
  body?: {
    position?: SequencePosition;
    stepTo?: SequenceTarget;
    facing?: DirectionInput;
  };
  /**
   * A thumb microgesture where the hand is, as a step of its own (only
   * `label` alongside); `events` reports it.
   */
  microgesture?: Microgesture;
}

/**
 * Parameters for run_sequence: one hand's steps, run in order, with the head
 * and body following.
 */
export interface RunSequenceParams {
  device: 'hand-left' | 'hand-right';
  steps: SequenceStep[];
  /** The other hand: rest it by the hip (default unless it is pinching) or keep it. */
  idleHand?: 'keep' | 'rest';
  /** `auto` (default) leans for low targets and steps closer when out of reach. */
  body?: 'auto' | 'fixed';
  /** `follow` (default) turns the head toward each target before the hand gets there. */
  gaze?: 'follow' | 'fixed';
  /** Validate and return the plan without moving anything. */
  dryRun?: boolean;
}

/** What run_sequence resolves with (times in seconds of sequence time). */
export interface SequenceResult {
  completed: boolean;
  cancelled: boolean;
  /** Why the sequence stopped early: an error, `deadline`, `cancelled`, `released`, `session-ended` or `stalled`. */
  reason?: string;
  /** The step that failed. */
  failedStep?: number;
  steps: {
    label: string;
    start: number;
    end: number;
    /** `performance.now()` at the step's start and end. */
    startPerf: number;
    endPerf: number;
  }[];
  /**
   * Select events and microgestures (by gesture name) the app saw, from the
   * hand's own button edges.
   */
  events: { t: number; type: string }[];
  /** Each press and how long (real time, ms) the fingertip was within 2 cm of it. */
  presses: { label: string; contactMs: number | null }[];
  warnings: string[];
  pinchValue: number;
  /** The hand afterwards, as get_hand_state reports it. */
  final?: GetHandStateResult;
}

/** What a run_sequence dry run returns. */
export interface SequencePlan {
  device: 'hand-left' | 'hand-right';
  segments: {
    step: number;
    label: string;
    kind: 'move' | 'hold' | 'press' | 'press-hold' | 'retract' | 'microgesture';
    /** Seconds, including any walk. */
    duration: number;
    /** Where the anchor ends up (XR-origin). */
    target?: Vec3;
    /** How far the body walks first, in metres. */
    walk?: number;
  }[];
  /** Seconds for the whole sequence. */
  duration: number;
  warnings: string[];
}

/** Result of cancel_sequence. */
export interface CancelSequenceResult {
  cancelled: boolean;
  /** The cancelled sequence's partial result. */
  sequence?: SequenceResult;
}

/** Result of list_targets. */
export interface ListTargetsResult {
  /** False when the page has registered no target resolver. */
  resolver: boolean;
  targets: { name: string; position: Vec3; size?: Vec3 }[];
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
