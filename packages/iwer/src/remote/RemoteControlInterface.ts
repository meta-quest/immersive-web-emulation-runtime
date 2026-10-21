/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

import type {
  XRDevice,
  SyntheticEnvironmentModule,
} from '../device/XRDevice.js';
import type { Vec3, Quat } from '../types/state.js';
import { P_DEVICE, P_GAMEPAD, P_JOINT_SPACE } from '../private.js';
import {
  FingerPoseBlend,
  HandAnchor,
  HandDirections,
  XRHandFinger,
  XRHandInput,
  handFingerJoints,
  isHandAnchor,
  wristRotationFromDirections,
} from '../device/XRHandInput.js';
import {
  BodyFrame,
  EASINGS,
  Easing,
  NAMED_DIRECTIONS,
  NamedDirection,
  autoDirections,
  bodyFrameFromHead,
  resolveDirection,
  shoulderPosition,
} from './hand-motion.js';
import { XRHandJoint } from '../input/XRHand.js';
import { Channel, ChannelEngine, ChannelRun } from './channels.js';
import {
  SEQUENCE_BUDGET_S,
  SequenceHost,
  SequenceRunner,
  planSequence,
} from './sequence.js';
import { GamepadButton } from '../gamepad/Gamepad.js';
import { cancelButton } from '../gamepad/button-edges.js';
import type {
  DeviceId,
  ConnectedInputDeviceId,
  SelectableDeviceId,
  Action,
  DiscreteAction,
  TickAction,
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
  SelectParams,
  SelectResult,
  GetGamepadStateParams,
  GetGamepadStateResult,
  SetGamepadStateParams,
  SetGamepadStateResult,
  RemoteSessionStatus,
  AcceptSessionResult,
  EndSessionResult,
  RemoteDeviceState,
  SetDeviceStateParams,
  SetDeviceStateResult,
  SetHandPoseParams,
  SetHandPoseResult,
  GetHandStateParams,
  GetHandStateResult,
  OrientationInput,
  RunSequenceParams,
  SequencePlan,
  SequenceResult,
  TargetResolver,
  CancelSequenceResult,
  ListTargetsResult,
} from './types.js';
import {
  vec3ToObj,
  quatToObj,
  quatToEuler,
  eulerToQuat,
  directionTo,
  lookRotation,
  lookRotationGimbal,
  waitForCondition,
} from '../utils/control-math.js';

/**
 * Check if an orientation input is euler angles (has any of pitch, yaw, or roll)
 */
function isEulerRotation(
  orientation: OrientationInput,
): orientation is { pitch?: number; yaw?: number; roll?: number } {
  return (
    'pitch' in orientation || 'yaw' in orientation || 'roll' in orientation
  );
}

/**
 * Normalize an orientation input to a quaternion
 */
function normalizeOrientation(orientation: OrientationInput): Quat {
  if (isEulerRotation(orientation)) {
    return eulerToQuat(orientation);
  }
  return orientation;
}

const quatFromGl = (q: quat): Quat => ({ x: q[0], y: q[1], z: q[2], w: q[3] });
const vec3FromGl = (v: vec3): Vec3 => ({ x: v[0], y: v[1], z: v[2] });

/**
 * Linear interpolation for numbers
 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Linear interpolation for Vec3
 */
function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
  };
}

/**
 * Spherical linear interpolation for quaternions
 */
function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  // Compute dot product
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;

  // If dot is negative, negate one quaternion to take shorter path
  let bx = b.x,
    by = b.y,
    bz = b.z,
    bw = b.w;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  // If quaternions are very close, use linear interpolation
  if (dot > 0.9995) {
    const result = {
      x: lerp(a.x, bx, t),
      y: lerp(a.y, by, t),
      z: lerp(a.z, bz, t),
      w: lerp(a.w, bw, t),
    };
    // Normalize
    const len = Math.sqrt(
      result.x * result.x +
        result.y * result.y +
        result.z * result.z +
        result.w * result.w,
    );
    return {
      x: result.x / len,
      y: result.y / len,
      z: result.z / len,
      w: result.w / len,
    };
  }

  // Standard slerp
  const theta0 = Math.acos(dot);
  const theta = theta0 * t;
  const sinTheta = Math.sin(theta);
  const sinTheta0 = Math.sin(theta0);

  const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
  const s1 = sinTheta / sinTheta0;

  return {
    x: s0 * a.x + s1 * bx,
    y: s0 * a.y + s1 * by,
    z: s0 * a.z + s1 * bz,
    w: s0 * a.w + s1 * bw,
  };
}

/**
 * Map of common device name aliases to canonical DeviceId values.
 * Enables callers to use natural variants like "right", "left-controller",
 * "controllers.right", etc. in addition to the canonical names.
 */
const DEVICE_ID_ALIASES: Record<string, string> = {
  right: 'controller-right',
  left: 'controller-left',
  'right-controller': 'controller-right',
  'left-controller': 'controller-left',
  'controllers.right': 'controller-right',
  'controllers.left': 'controller-left',
  rightController: 'controller-right',
  leftController: 'controller-left',
  'right-hand': 'hand-right',
  'left-hand': 'hand-left',
  'hands.right': 'hand-right',
  'hands.left': 'hand-left',
  rightHand: 'hand-right',
  leftHand: 'hand-left',
};

/**
 * Resolve a device identifier, accepting both canonical names and common aliases.
 */
function resolveDeviceId(id: string): string {
  return DEVICE_ID_ALIASES[id] ?? id;
}

/** Default duration (seconds) for the high-level `select` action. */
const DEFAULT_SELECT_DURATION_S = 0.15;

/** Seconds a hand takes to close (and to open) its pinch in `select`. */
const HAND_PINCH_RAMP_S = 0.1;

function requireSelectableDeviceId(value: unknown): SelectableDeviceId {
  switch (value) {
    case 'controller-left':
    case 'controller-right':
    case 'hand-left':
    case 'hand-right':
      return value;
    default:
      throw new Error(`Unsupported select device: ${String(value)}`);
  }
}

const gazeWorldOrientation = quat.create();
const gazeViewerInverse = quat.create();
const gazeLocalOrientation = quat.create();

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Validate a position, throwing on any non-finite component so a bad input
 * cannot permanently corrupt the device pose.
 */
function validatePosition(p: Vec3): void {
  if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) {
    throw new Error(
      `Invalid position: x, y, z must be finite numbers (got ${JSON.stringify(
        p,
      )}).`,
    );
  }
}

/**
 * Validate a quaternion and return a normalized copy. Throws on non-finite
 * components or a near-zero-length quaternion.
 */
function validateAndNormalizeQuat(q: Quat): Quat {
  if (
    !isFiniteNumber(q.x) ||
    !isFiniteNumber(q.y) ||
    !isFiniteNumber(q.z) ||
    !isFiniteNumber(q.w)
  ) {
    throw new Error(
      `Invalid orientation: x, y, z, w must be finite numbers (got ${JSON.stringify(
        q,
      )}).`,
    );
  }
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (len < 1e-6) {
    throw new Error('Invalid orientation: quaternion has near-zero length.');
  }
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

/**
 * RemoteControlInterface provides frame-synchronized programmatic control of an XRDevice.
 *
 * This class implements a command queue that processes actions during each frame update,
 * enabling smooth animations and coordinated control with DevUI.
 *
 * Key features:
 * - Frame-synchronized execution: Commands are queued and processed during frame update
 * - Duration-based actions: Smooth animations via lerp over multiple frames
 * - Automatic capture/release: Captures device on first command, releases 30s after queue empties
 * - Unified device identifiers: 'headset', 'controller-left', 'hand-right', etc.
 *
 * Usage:
 * ```typescript
 * import { XRDevice, metaQuest3 } from 'iwer';
 *
 * const device = new XRDevice(metaQuest3);
 * device.installRuntime();
 *
 * // Get transform
 * const result = await device.remote.dispatch('get_transform', { device: 'headset' });
 *
 * // Animate headset to new position over 1 second
 * await device.remote.dispatch('animate_to', {
 *   device: 'headset',
 *   position: { x: 0, y: 1.6, z: -1 },
 *   duration: 1.0
 * });
 * ```
 */
export class RemoteControlInterface {
  private device: XRDevice;
  private commandQueue: Action[] = [];
  private _isCaptured: boolean = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private actionIdCounter: number = 0;

  /** Release timeout in milliseconds (default: 30000 = 30 seconds) */
  readonly RELEASE_TIMEOUT_MS = 30000;

  /**
   * Queue watchdog in milliseconds. Queued actions are rejected when no frame
   * arrives for this long, so callers don't hang forever when the XR render
   * loop is paused. Frames that keep arriving keep the queue alive, however
   * long the actions ahead of it run.
   */
  readonly ACTION_TIMEOUT_MS = 10000;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** Per-device channels (transform, pose, pinch) that timed commands run. */
  private channels = new ChannelEngine();
  private targetResolver: TargetResolver | null = null;
  // The body's facing and standing head position between sequences (null
  // until a sequence completes; cleared when the headset is placed).
  private sequenceBody: { forward: vec3; standing: vec3 } | null = null;
  /** A run_sequence gives up this long after dispatch, under the 30 s bridge timeout. */
  readonly SEQUENCE_DEADLINE_MS = 28000;

  constructor(device: XRDevice) {
    this.device = device;
    // Pins, pose fades and ramps only run under programmatic control: however
    // the device goes back to manual, the hands are let go.
    device.onControlModeChange((mode) => {
      if (mode === 'manual') {
        this.releaseHands();
      }
    });
  }

  private generateActionId(): string {
    return `action_${++this.actionIdCounter}`;
  }

  // =============================================================================
  // Public Properties
  // =============================================================================

  /**
   * Whether the device is currently captured for programmatic control.
   * When true, DevUI should go into passive mode (sync FROM device only).
   */
  get isCaptured(): boolean {
    return this._isCaptured;
  }

  /**
   * Number of pending actions in the queue
   */
  get queueLength(): number {
    return this.commandQueue.length;
  }

  // =============================================================================
  // Queue Management
  // =============================================================================

  /**
   * Enqueue a discrete action for processing
   */
  private enqueueDiscrete(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const action: DiscreteAction = {
        type: 'discrete',
        id: this.generateActionId(),
        method,
        params,
        resolve,
        reject,
      };
      this.commandQueue.push(action);
      this.armWatchdog();
    });
  }

  /**
   * Enqueue a timed action: `start` runs on its first frame, `tick` advances
   * it until it reports the time left over, then it resolves with `result`.
   */
  private enqueueTick(
    method: string,
    params: Record<string, unknown>,
    spec: Pick<
      TickAction,
      'start' | 'tick' | 'result' | 'abort' | 'estimateMs'
    >,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const action: TickAction = {
        type: 'tick',
        id: this.generateActionId(),
        method,
        params,
        started: false,
        ...spec,
        resolve,
        reject,
      };
      this.commandQueue.push(action);
      this.armWatchdog();
    });
  }

  /**
   * Enqueue channels that run together as one timed action. `build` runs when
   * the action reaches the head of the queue (so channels capture their start
   * state, and hands are checked, then); the action holds the head until
   * every channel finishes and resolves with `result(elapsedMs)`. Timed
   * commands run one channel each; run_sequence and tests drive several.
   */
  private enqueueChannels(
    method: string,
    params: Record<string, unknown>,
    build: () => Channel[],
    result: (elapsedMs: number) => unknown,
    estimateMs: number,
  ): Promise<unknown> {
    let run!: ChannelRun;
    return this.enqueueTick(method, params, {
      estimateMs,
      start: () => {
        run = this.channels.run(build());
      },
      tick: (deltaMs) => {
        try {
          return run.advance(deltaMs);
        } catch (error) {
          run.stop();
          throw error;
        }
      },
      result: () => result(run.elapsedMs),
    });
  }

  /**
   * Settles every queued action after an interruption: a started action that
   * can report partial progress (a sequence) resolves with it, the rest
   * reject with `message(method)`.
   */
  private interruptQueue(
    reason: string,
    message: (method: string) => string,
  ): void {
    const pending = this.commandQueue;
    this.commandQueue = [];
    this.armWatchdog();
    for (const action of pending) {
      if (action.type === 'tick' && action.started && action.abort) {
        action.resolve(action.abort(reason));
      } else {
        action.reject(new Error(message(action.method)));
      }
    }
  }

  /** Roughly how long the queued commands still run, in milliseconds. */
  private queuedMs(): number {
    let total = 0;
    for (const action of this.commandQueue) {
      if (action.type === 'tick') {
        total += Math.max(
          0,
          (action.estimateMs ?? 0) - (action.elapsedMs ?? 0),
        );
      }
    }
    return total;
  }

  /**
   * (Re)arm the queue watchdog. Called on every enqueue and every frame, so it
   * only fires when frames stop arriving while actions are waiting.
   */
  private armWatchdog(): void {
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    if (this.commandQueue.length === 0) {
      return;
    }
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      // Nothing can finish what was held; end it without completing it.
      this.cancelHeldInputs();
      this.releaseHands();
      this.interruptQueue(
        'stalled',
        (method) =>
          `RemoteControlInterface: action '${method}' timed out after ` +
          `${this.ACTION_TIMEOUT_MS}ms with no frame processing the queue ` +
          `(is the XR render loop running?).`,
      );
      this.startReleaseTimer();
    }, this.ACTION_TIMEOUT_MS);
  }

  /**
   * Update method called each frame by XRDevice.
   * Processes the command queue and handles duration-based animations.
   *
   * @param deltaTimeMs - Time since last frame in milliseconds
   */
  update(deltaTimeMs: number): void {
    if (this.commandQueue.length === 0) {
      return;
    }

    // Always cancel pending release while queue is active
    this.cancelReleaseTimer();

    // Activate capture mode
    if (!this._isCaptured) {
      this._isCaptured = true;
      this.device.controlMode = 'programmatic';
    }

    let remainingMs = deltaTimeMs;
    // Devices whose buttons were written this frame.
    const written = new Set<unknown>();
    while (this.commandQueue.length > 0) {
      const action = this.commandQueue[0];
      // A second write to a device's buttons waits for the next frame, so a
      // press and the release queued behind it never land in the same frame
      // (the app would see neither edge). Different devices share a frame.
      const writes = RemoteControlInterface.INPUT_WRITE_METHODS.has(
        action.method,
      );
      if (writes && written.has(action.params.device)) {
        break;
      }

      if (action.type === 'discrete') {
        // Execute discrete action immediately
        try {
          const result = this.executeDiscreteAction(action);
          action.resolve(result);
        } catch (error) {
          action.reject(error as Error);
        }
        this.commandQueue.shift();
        if (writes) {
          written.add(action.params.device);
        }
        if (RemoteControlInterface.FRAME_ENDING_METHODS.has(action.method)) {
          break;
        }
        // Continue to next action
      } else {
        // Timed action: advance it by the time this frame has left. A
        // finished action passes its leftover time on to the next one.
        try {
          if (!action.started) {
            action.started = true;
            action.start();
          }
          const leftover = action.tick(remainingMs);
          action.elapsedMs =
            (action.elapsedMs ?? 0) +
            (leftover < 0 ? remainingMs : remainingMs - leftover);
          if (leftover < 0) {
            break;
          }
          remainingMs = leftover;
          action.resolve(action.result());
        } catch (error) {
          action.reject(error as Error);
        }
        this.commandQueue.shift();
        if (writes) {
          written.add(action.params.device);
        }
      }
    }

    // Notify state change
    this.device.notifyStateChange();
    this.armWatchdog();

    // Start the release timer once nothing is queued or animating.
    if (this.commandQueue.length === 0 && !this.channels.isActive()) {
      this.startReleaseTimer();
    }
  }

  private startReleaseTimer(): void {
    this.cancelReleaseTimer();
    this.releaseTimer = setTimeout(() => {
      this._isCaptured = false;
      this.releaseTimer = null;
      // Going manual lets go of the hands (see the constructor).
      this.device.controlMode = 'manual';
    }, this.RELEASE_TIMEOUT_MS);
  }

  private cancelReleaseTimer(): void {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  // =============================================================================
  // Device Resolution
  // =============================================================================

  /**
   * Get the transform (position, quaternion) for a device
   */
  private getDeviceTransform(deviceId: DeviceId): {
    position: Vec3;
    orientation: Quat;
  } {
    switch (deviceId) {
      case 'headset':
        return {
          position: vec3ToObj(this.device.position),
          orientation: quatToObj(this.device.quaternion),
        };
      case 'controller-left': {
        const controller = this.device.controllers.left;
        if (!controller) throw new Error('Left controller not available');
        return {
          position: vec3ToObj(controller.position),
          orientation: quatToObj(controller.quaternion),
        };
      }
      case 'controller-right': {
        const controller = this.device.controllers.right;
        if (!controller) throw new Error('Right controller not available');
        return {
          position: vec3ToObj(controller.position),
          orientation: quatToObj(controller.quaternion),
        };
      }
      case 'hand-left': {
        const hand = this.device.hands.left;
        if (!hand) throw new Error('Left hand not available');
        return {
          position: vec3ToObj(hand.position),
          orientation: quatToObj(hand.quaternion),
        };
      }
      case 'hand-right': {
        const hand = this.device.hands.right;
        if (!hand) throw new Error('Right hand not available');
        return {
          position: vec3ToObj(hand.position),
          orientation: quatToObj(hand.quaternion),
        };
      }
      case 'gaze': {
        const gaze = this.device.gaze;
        if (!gaze) throw new Error('Gaze input not available');
        quat.multiply(
          gazeWorldOrientation,
          this.device.quaternion.quat,
          gaze.quaternion.quat,
        );
        return {
          position: vec3ToObj(this.device.position),
          orientation: {
            x: gazeWorldOrientation[0],
            y: gazeWorldOrientation[1],
            z: gazeWorldOrientation[2],
            w: gazeWorldOrientation[3],
          },
        };
      }
      default:
        throw new Error(`Unknown device: ${deviceId}`);
    }
  }

  /**
   * Set the transform for a device
   */
  private setDeviceTransform(
    deviceId: DeviceId,
    position?: Vec3,
    orientation?: Quat,
  ): void {
    // Validate both inputs before applying either, so an invalid orientation
    // can't leave a half-applied (position-only) and permanently corrupt pose.
    if (deviceId === 'gaze' && position) {
      throw new Error(
        'Gaze position is derived from the headset. Move the headset transform instead.',
      );
    }
    if (position) {
      validatePosition(position);
    }
    const orient = orientation
      ? validateAndNormalizeQuat(orientation)
      : undefined;
    switch (deviceId) {
      case 'headset':
        // A placed headset stands the body there for the next sequence.
        this.sequenceBody = null;
        if (position) {
          this.device.position.set(position.x, position.y, position.z);
        }
        if (orient) {
          this.device.quaternion.set(orient.x, orient.y, orient.z, orient.w);
        }
        break;
      case 'controller-left': {
        const controller = this.device.controllers.left;
        if (!controller) throw new Error('Left controller not available');
        if (position) {
          controller.position.set(position.x, position.y, position.z);
        }
        if (orient) {
          controller.quaternion.set(orient.x, orient.y, orient.z, orient.w);
        }
        break;
      }
      case 'controller-right': {
        const controller = this.device.controllers.right;
        if (!controller) throw new Error('Right controller not available');
        if (position) {
          controller.position.set(position.x, position.y, position.z);
        }
        if (orient) {
          controller.quaternion.set(orient.x, orient.y, orient.z, orient.w);
        }
        break;
      }
      case 'hand-left': {
        const hand = this.device.hands.left;
        if (!hand) throw new Error('Left hand not available');
        if (position) {
          hand.position.set(position.x, position.y, position.z);
        }
        if (orient) {
          hand.quaternion.set(orient.x, orient.y, orient.z, orient.w);
        }
        break;
      }
      case 'hand-right': {
        const hand = this.device.hands.right;
        if (!hand) throw new Error('Right hand not available');
        if (position) {
          hand.position.set(position.x, position.y, position.z);
        }
        if (orient) {
          hand.quaternion.set(orient.x, orient.y, orient.z, orient.w);
        }
        break;
      }
      case 'gaze': {
        const gaze = this.device.gaze;
        if (!gaze) throw new Error('Gaze input not available');
        if (orient) {
          quat.invert(gazeViewerInverse, this.device.quaternion.quat);
          quat.set(
            gazeWorldOrientation,
            orient.x,
            orient.y,
            orient.z,
            orient.w,
          );
          quat.multiply(
            gazeLocalOrientation,
            gazeViewerInverse,
            gazeWorldOrientation,
          );
          gaze.quaternion.set(
            gazeLocalOrientation[0],
            gazeLocalOrientation[1],
            gazeLocalOrientation[2],
            gazeLocalOrientation[3],
          );
        }
        break;
      }
      default:
        throw new Error(`Unknown device: ${deviceId}`);
    }
  }

  // =============================================================================
  // XR origin
  // =============================================================================

  /**
   * The XR origin in GlobalSpace: the app's first non-viewer reference space,
   * or null (identity) without one. Remote positions, orientations and
   * directions are all relative to it.
   */
  private originMatrix(): mat4 | null {
    const session = this.device[P_DEVICE].runtime.getSession();
    return session?.originOffsetMatrix ?? null;
  }

  /** Transform a position from XR-origin coordinates to GlobalSpace. */
  private transformXROriginToGlobal(position: Vec3): Vec3 {
    const offsetMatrix = this.originMatrix();
    if (!offsetMatrix) {
      return position;
    }
    const posVec = vec3.fromValues(position.x, position.y, position.z);
    vec3.transformMat4(posVec, posVec, offsetMatrix);
    return { x: posVec[0], y: posVec[1], z: posVec[2] };
  }

  /** Transform a position from GlobalSpace to XR-origin coordinates. */
  private transformGlobalToXROrigin(position: Vec3): Vec3 {
    const offsetMatrix = this.originMatrix();
    if (!offsetMatrix) {
      return position;
    }
    const inverse = mat4.invert(mat4.create(), offsetMatrix) ?? mat4.create();
    const posVec = vec3.fromValues(position.x, position.y, position.z);
    vec3.transformMat4(posVec, posVec, inverse);
    return { x: posVec[0], y: posVec[1], z: posVec[2] };
  }

  private originRotation(): quat {
    const offsetMatrix = this.originMatrix();
    const rotation = quat.create();
    if (offsetMatrix) {
      mat4.getRotation(rotation, offsetMatrix);
      quat.normalize(rotation, rotation);
    }
    return rotation;
  }

  /** Transform an orientation from XR-origin coordinates to GlobalSpace. */
  private orientationToGlobal(orientation: Quat): Quat {
    const q = quat.fromValues(
      orientation.x,
      orientation.y,
      orientation.z,
      orientation.w,
    );
    quat.multiply(q, this.originRotation(), q);
    return quatFromGl(quat.normalize(q, q));
  }

  /** Transform an orientation from GlobalSpace to XR-origin coordinates. */
  private orientationToXROrigin(orientation: Quat): Quat {
    const q = quat.fromValues(
      orientation.x,
      orientation.y,
      orientation.z,
      orientation.w,
    );
    const inverse = quat.invert(quat.create(), this.originRotation());
    quat.multiply(q, inverse, q);
    return quatFromGl(quat.normalize(q, q));
  }

  /** A device transform in XR-origin coordinates. */
  private getDeviceTransformInOrigin(deviceId: DeviceId): {
    position: Vec3;
    orientation: Quat;
  } {
    const transform = this.getDeviceTransform(deviceId);
    return {
      position: this.transformGlobalToXROrigin(transform.position),
      orientation: this.orientationToXROrigin(transform.orientation),
    };
  }

  /** Set a device transform given in XR-origin coordinates. */
  private setDeviceTransformInOrigin(
    deviceId: DeviceId,
    position?: Vec3,
    orientation?: Quat,
  ): void {
    if (position) {
      validatePosition(position);
    }
    this.setDeviceTransform(
      deviceId,
      position ? this.transformXROriginToGlobal(position) : undefined,
      orientation
        ? this.orientationToGlobal(validateAndNormalizeQuat(orientation))
        : undefined,
    );
  }

  // =============================================================================
  // Hands
  // =============================================================================

  private handFor(deviceId: string): XRHandInput {
    const side =
      deviceId === 'hand-left'
        ? 'left'
        : deviceId === 'hand-right'
          ? 'right'
          : null;
    if (!side) {
      throw new Error(
        `Expected device 'hand-left' or 'hand-right', got '${deviceId}'.`,
      );
    }
    const hand = this.device.hands[side];
    if (!hand) {
      throw new Error(`Hand ${side} not available`);
    }
    return hand;
  }

  /**
   * Throws unless the hand is what the app currently sees: hand input mode,
   * connected, and hand tracking enabled on the session.
   */
  private requireLiveHand(deviceId: string): XRHandInput {
    const hand = this.handFor(deviceId);
    const session = this.device[P_DEVICE].runtime.getSession();
    if (this.device.primaryInputMode !== 'hand') {
      throw new Error(
        `${deviceId} is not live: the input mode is controllers. Call set_input_mode with mode 'hand' first.`,
      );
    }
    if (!hand.connected) {
      throw new Error(`${deviceId} is disconnected. Call set_connected first.`);
    }
    if (
      session?.enabledFeatures &&
      session.enabledFeatures.length > 0 &&
      !session.enabledFeatures.includes('hand-tracking')
    ) {
      throw new Error(
        `${deviceId} is not live: the app's session did not enable 'hand-tracking'.`,
      );
    }
    return hand;
  }

  /**
   * Lets go of both hands: every channel (moves, pose fades, pinch ramps)
   * stops where it is, a pose fade snaps to its pose, and pins are dropped.
   * Hands stay where they are.
   */
  private releaseHands(): void {
    this.channels.stop();
    for (const side of ['left', 'right'] as const) {
      const hand = this.device.hands[side];
      if (hand) {
        hand.poseTransitionProgress = null;
        hand.setPin(null);
      }
    }
  }

  /** The body frame from the headset (its position and yaw), in GlobalSpace. */
  private bodyFrame(): BodyFrame {
    return bodyFrameFromHead(
      this.device.position.vec3,
      this.device.quaternion.quat,
    );
  }

  private toVec3(value: unknown, what: string): vec3 {
    if (Array.isArray(value)) {
      if (value.length === 3 && value.every(isFiniteNumber)) {
        return vec3.fromValues(value[0], value[1], value[2]);
      }
    } else if (value && typeof value === 'object') {
      const v = value as Vec3;
      if (isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.z)) {
        return vec3.fromValues(v.x, v.y, v.z);
      }
    }
    throw new Error(
      `${what} must be {x, y, z} or [x, y, z] with finite numbers (got ${JSON.stringify(value)}).`,
    );
  }

  /**
   * A direction input (XR-origin vector, or a name relative to the headset's
   * yaw, or to `body` when given) as a GlobalSpace unit vector. `from`
   * (GlobalSpace) is the point toward-head / away-from-head start at.
   */
  private directionToGlobal(
    value: unknown,
    what: string,
    from?: vec3,
    body: BodyFrame = this.bodyFrame(),
  ): vec3 {
    if (typeof value === 'string') {
      if (!(NAMED_DIRECTIONS as readonly string[]).includes(value)) {
        throw new Error(
          `Unknown direction '${value}' for ${what}. Use a vector or one of: ${NAMED_DIRECTIONS.join(', ')}.`,
        );
      }
      return resolveDirection(value as NamedDirection, body, from);
    }
    const v = this.toVec3(value, what);
    if (vec3.length(v) < 1e-6) {
      throw new Error(`${what} must not be a zero vector.`);
    }
    vec3.transformQuat(v, v, this.originRotation());
    return vec3.normalize(v, v);
  }

  /**
   * Resolves a placement orientation for a hand. Returns the wanted wrist
   * rotation (hand directions or 'auto'), or the target-ray rotation
   * (quaternion / euler), in GlobalSpace.
   */
  private resolveHandOrientation(
    hand: XRHandInput,
    orientation: unknown,
    targetGlobal: vec3 | null,
    body: BodyFrame = this.bodyFrame(),
  ): { wristRotation?: quat; rayRotation?: Quat } {
    if (orientation === undefined) {
      return {};
    }
    if (orientation === 'auto') {
      if (!targetGlobal) {
        throw new Error(`orientation 'auto' needs a position to reach toward.`);
      }
      const directions = autoDirections(
        shoulderPosition(body, hand.inputSource.handedness),
        targetGlobal,
        hand.inputSource.handedness,
        body,
      );
      return { wristRotation: this.wristFromDirections(hand, directions) };
    }
    if (
      orientation &&
      typeof orientation === 'object' &&
      'fingers' in (orientation as object)
    ) {
      const input = orientation as {
        fingers: unknown;
        palm?: unknown;
        thumb?: unknown;
      };
      const extra = Object.keys(input).filter(
        (key) => !['fingers', 'palm', 'thumb'].includes(key),
      );
      if (extra.length > 0) {
        throw new Error(`Unknown hand orientation keys: ${extra.join(', ')}.`);
      }
      if ((input.palm === undefined) === (input.thumb === undefined)) {
        throw new Error(
          'A hand orientation takes fingers plus exactly one of palm or thumb.',
        );
      }
      const from = targetGlobal ?? undefined;
      const directions: HandDirections = {
        fingers: this.directionToGlobal(input.fingers, 'fingers', from, body),
        palm:
          input.palm !== undefined
            ? this.directionToGlobal(input.palm, 'palm', from, body)
            : undefined,
        thumb:
          input.thumb !== undefined
            ? this.directionToGlobal(input.thumb, 'thumb', from, body)
            : undefined,
      };
      return { wristRotation: this.wristFromDirections(hand, directions) };
    }
    return {
      rayRotation: this.orientationToGlobal(
        validateAndNormalizeQuat(
          normalizeOrientation(orientation as OrientationInput),
        ),
      ),
    };
  }

  private wristFromDirections(
    hand: XRHandInput,
    directions: HandDirections,
  ): quat {
    const rotation = wristRotationFromDirections(
      directions,
      hand.inputSource.handedness,
    );
    if (!rotation) {
      throw new Error(
        'The two hand directions are parallel; give directions at an angle.',
      );
    }
    return rotation;
  }

  /**
   * Where an anchor of the hand is now, in GlobalSpace (a grasp point at
   * `graspPinch`, else at the pin's).
   */
  private anchorPosition(
    hand: XRHandInput,
    anchor: HandAnchor,
    graspPinch = hand.pin?.graspPinch,
  ): vec3 {
    const offset = hand.anchorOffset(anchor, vec3.create(), graspPinch);
    vec3.transformQuat(offset, offset, hand.quaternion.quat);
    return vec3.add(offset, offset, hand.position.vec3);
  }

  private requireAnchor(anchor: unknown): HandAnchor {
    if (!isHandAnchor(anchor)) {
      throw new Error(
        `Unknown anchor '${String(anchor)}'. Use target-ray, wrist, grip, grasp, index-tip, thumb-tip, or a WebXR joint name.`,
      );
    }
    return anchor;
  }

  private requireEasing(easing: unknown, fallback: Easing): Easing {
    if (easing === undefined) {
      return fallback;
    }
    if (!(EASINGS as readonly unknown[]).includes(easing)) {
      throw new Error(
        `Unknown easing '${String(easing)}'. Use ${EASINGS.join(' or ')}.`,
      );
    }
    return easing as Easing;
  }

  private requireDuration(duration: unknown, what: string): number {
    if (duration === undefined) {
      return 0;
    }
    if (!isFiniteNumber(duration) || duration < 0) {
      throw new Error(`${what} duration must be a number of seconds ≥ 0.`);
    }
    return duration;
  }

  /** True when a placement for a hand needs the anchor/pin path. */
  private isHandPlacement(
    deviceId: string,
    anchor: unknown,
    orientation: unknown,
  ): boolean {
    if (deviceId !== 'hand-left' && deviceId !== 'hand-right') {
      return false;
    }
    return (
      (anchor !== undefined && anchor !== 'target-ray') ||
      orientation === 'auto' ||
      (!!orientation &&
        typeof orientation === 'object' &&
        'fingers' in (orientation as object))
    );
  }

  /**
   * Get the select value for an input device (trigger for controller, pinch for hand)
   */
  private getDeviceSelectValue(deviceId: SelectableDeviceId): number {
    switch (deviceId) {
      case 'controller-left':
        return this.device.controllers.left?.getButtonValue('trigger') ?? 0;
      case 'controller-right':
        return this.device.controllers.right?.getButtonValue('trigger') ?? 0;
      case 'hand-left':
        return this.device.hands.left?.pinchValue ?? 0;
      case 'hand-right':
        return this.device.hands.right?.pinchValue ?? 0;
      default:
        throw new Error(`Unknown input device: ${deviceId}`);
    }
  }

  /**
   * Set the select value for an input device
   */
  private setDeviceSelectValue(
    deviceId: SelectableDeviceId,
    value: number,
  ): void {
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
      throw new Error(`Select value must be within [0, 1], got ${value}.`);
    }
    switch (deviceId) {
      case 'controller-left':
        this.device.controllers.left?.updateButtonValue('trigger', value);
        break;
      case 'controller-right':
        this.device.controllers.right?.updateButtonValue('trigger', value);
        break;
      case 'hand-left':
        this.device.hands.left?.updatePinchValue(value);
        break;
      case 'hand-right':
        this.device.hands.right?.updatePinchValue(value);
        break;
      default:
        throw new Error(`Unknown input device: ${deviceId}`);
    }
  }

  /**
   * Set connected state for an input device
   */
  private setDeviceConnected(
    deviceId: ConnectedInputDeviceId,
    connected: boolean,
  ): void {
    switch (deviceId) {
      case 'controller-left':
        if (this.device.controllers.left) {
          this.device.controllers.left.connected = connected;
        }
        break;
      case 'controller-right':
        if (this.device.controllers.right) {
          this.device.controllers.right.connected = connected;
        }
        break;
      case 'hand-left':
        if (this.device.hands.left) {
          this.device.hands.left.connected = connected;
        }
        break;
      case 'hand-right':
        if (this.device.hands.right) {
          this.device.hands.right.connected = connected;
        }
        break;
      case 'gaze':
        if (!this.device.gaze) {
          throw new Error('Gaze input not available');
        }
        this.device.gaze.connected = connected;
        break;
      default:
        throw new Error(`Unknown input device: ${deviceId}`);
    }
  }

  // =============================================================================
  // Discrete Action Execution
  // =============================================================================

  private executeDiscreteAction(action: DiscreteAction): unknown {
    const { method, params } = action;

    switch (method) {
      // Session tools
      case 'get_session_status':
        return this.executeGetSessionStatus();
      case 'accept_session':
        return this.executeAcceptSession();
      case 'end_session':
        return this.executeEndSession();

      // Transform tools
      case 'get_transform':
        return this.executeGetTransform(
          params as unknown as GetTransformParams,
        );
      case 'set_transform':
        return this.executeSetTransform(
          params as unknown as SetTransformParams,
        );
      case 'look_at':
        return this.executeLookAt(params as unknown as LookAtParams);

      // Input tools
      case 'set_input_mode':
        return this.executeSetInputMode(
          params as unknown as SetInputModeParams,
        );
      case 'set_connected':
        return this.executeSetConnected(
          params as unknown as SetConnectedParams,
        );
      case 'get_select_value':
        return this.executeGetSelectValue(
          params as unknown as GetSelectValueParams,
        );
      case 'set_select_value':
        return this.executeSetSelectValue(
          params as unknown as SetSelectValueParams,
        );
      case 'set_hand_pose':
        return this.executeSetHandPose(params as unknown as SetHandPoseParams);

      // Gamepad tools
      case 'get_gamepad_state':
        return this.executeGetGamepadState(
          params as unknown as GetGamepadStateParams,
        );
      case 'set_gamepad_state':
        return this.executeSetGamepadState(
          params as unknown as SetGamepadStateParams,
        );

      // State tools
      case 'get_device_state':
        return this.executeGetDeviceState();
      case 'set_device_state':
        return this.executeSetDeviceState(
          params as unknown as SetDeviceStateParams,
        );

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // =============================================================================
  // Session Tool Implementations
  // =============================================================================

  private executeGetSessionStatus(): RemoteSessionStatus {
    const runtime = this.device[P_DEVICE].runtime;
    const session = runtime.getSession();
    return {
      deviceName: this.device.name,
      isRuntimeInstalled: true,
      sessionActive: !!session,
      sessionOffered: runtime.kind === 'emulated' && this.device.sessionOffered,
      sessionMode: session?.mode ?? null,
      enabledFeatures: session ? Array.from(session.enabledFeatures) : [],
      visibilityState: session?.visibilityState ?? this.device.visibilityState,
      runtimeKind: runtime.kind,
    };
  }

  private executeAcceptSession(): AcceptSessionResult {
    if (this.device[P_DEVICE].runtime.kind === 'native') {
      throw new Error(
        'Session start is app-driven in native override mode; immersive sessions require a user gesture.',
      );
    }
    if (!this.device.sessionOffered) {
      throw new Error('No session has been offered');
    }
    this.device.grantOfferedSession();
    // Session activation is async - caller should use get_session_status to poll
    return { success: true };
  }

  private executeEndSession(): EndSessionResult {
    const session = this.device[P_DEVICE].runtime.getSession();
    if (!session) {
      throw new Error('No active session');
    }
    session.end();
    return { success: true };
  }

  // =============================================================================
  // Transform Tool Implementations
  // =============================================================================

  private executeGetTransform(params: GetTransformParams): GetTransformResult {
    const { device: deviceId } = params;
    const transform = this.getDeviceTransformInOrigin(deviceId);
    return {
      device: deviceId,
      position: transform.position,
      orientation: transform.orientation,
      euler: quatToEuler(transform.orientation),
    };
  }

  private executeSetTransform(params: SetTransformParams): SetTransformResult {
    const { device: deviceId, position, orientation, anchor } = params;
    if (this.isHandPlacement(deviceId, anchor, orientation)) {
      this.placeHand(deviceId, position, orientation, anchor);
    } else {
      if (anchor !== undefined) {
        this.requireAnchor(anchor);
      }
      this.setDeviceTransformInOrigin(
        deviceId,
        position,
        orientation
          ? normalizeOrientation(orientation as OrientationInput)
          : undefined,
      );
      if (deviceId === 'hand-left' || deviceId === 'hand-right') {
        // A placement by the target ray (no anchor) lets go of any pin.
        this.handFor(deviceId).setPin(null);
      }
    }
    const newTransform = this.getDeviceTransformInOrigin(deviceId);
    return {
      device: deviceId,
      position: newTransform.position,
      orientation: newTransform.orientation,
    };
  }

  /**
   * Places a hand by an anchor and/or a hand orientation, and pins it there:
   * the anchor stays put (and the wrist keeps its rotation) while the hand's
   * shape changes.
   */
  private placeHand(
    deviceId: string,
    position: Vec3 | undefined,
    orientation: unknown,
    anchorInput: unknown,
  ): void {
    const hand = this.requireLiveHand(deviceId);
    const anchor = this.requireAnchor(anchorInput ?? 'target-ray');
    const target = position
      ? this.toVec3(this.transformXROriginToGlobal(position), 'position')
      : this.anchorPosition(hand, anchor);
    const { wristRotation, rayRotation } = this.resolveHandOrientation(
      hand,
      orientation,
      target,
    );
    if (rayRotation) {
      hand.quaternion.set(
        rayRotation.x,
        rayRotation.y,
        rayRotation.z,
        rayRotation.w,
      );
    }
    hand.setPin({
      anchor,
      target,
      wristRotation:
        wristRotation ?? (rayRotation ? undefined : hand.pin?.wristRotation),
    });
  }

  private executeLookAt(params: LookAtParams): LookAtResult {
    const { device: deviceId, target, moveToDistance } = params;
    if (deviceId === 'gaze' && moveToDistance !== undefined) {
      throw new Error(
        'Gaze origin is derived from the headset; moveToDistance is not supported for gaze.',
      );
    }
    const currentTransform = this.getDeviceTransform(deviceId);

    // Transform target from XR-origin-relative to GlobalSpace
    const targetInGlobal = this.transformXROriginToGlobal(target);

    // Calculate direction to target
    const direction = directionTo(currentTransform.position, targetInGlobal);

    // Calculate look rotation
    // Use gimbal rotation for headset (keeps it level, no roll)
    // Use standard lookRotation for controllers/hands (can tilt freely)
    const lookQuat =
      deviceId === 'headset'
        ? lookRotationGimbal(direction)
        : lookRotation(direction);

    // Optionally move to a specific distance from target
    let newPosition: Vec3 | undefined;
    if (moveToDistance !== undefined) {
      newPosition = {
        x: targetInGlobal.x - direction.x * moveToDistance,
        y: targetInGlobal.y - direction.y * moveToDistance,
        z: targetInGlobal.z - direction.z * moveToDistance,
      };
    }

    if (deviceId === 'hand-left' || deviceId === 'hand-right') {
      // look_at aims the target ray; it lets go of any pin.
      this.handFor(deviceId).setPin(null);
    }
    this.setDeviceTransform(deviceId, newPosition, lookQuat);

    const newTransform = this.getDeviceTransformInOrigin(deviceId);
    return {
      device: deviceId,
      position: newTransform.position,
      orientation: newTransform.orientation,
    };
  }

  // =============================================================================
  // Input Tool Implementations
  // =============================================================================

  private executeSetInputMode(params: SetInputModeParams): SetInputModeResult {
    const { mode } = params;
    if (mode !== this.device.primaryInputMode) {
      this.releaseHands();
    }
    this.device.primaryInputMode = mode;

    const activeDevices: DeviceId[] = [];
    if (mode === 'controller') {
      if (this.device.controllers.left?.connected) {
        activeDevices.push('controller-left');
      }
      if (this.device.controllers.right?.connected) {
        activeDevices.push('controller-right');
      }
    } else {
      if (this.device.hands.left?.connected) {
        activeDevices.push('hand-left');
      }
      if (this.device.hands.right?.connected) {
        activeDevices.push('hand-right');
      }
    }

    if (this.device.gaze?.connected) {
      activeDevices.push('gaze');
    }

    return { mode, activeDevices };
  }

  private executeSetConnected(params: SetConnectedParams): SetConnectedResult {
    const { device: deviceId, connected } = params;
    if (!connected && (deviceId === 'hand-left' || deviceId === 'hand-right')) {
      this.handFor(deviceId).setPin(null);
    }
    this.setDeviceConnected(deviceId, connected);
    return { device: deviceId, connected };
  }

  private executeGetSelectValue(
    params: GetSelectValueParams,
  ): GetSelectValueResult {
    const { device: deviceId } = params;
    const value = this.getDeviceSelectValue(deviceId);
    return { device: deviceId, value };
  }

  private executeSetSelectValue(
    params: SetSelectValueParams,
  ): SetSelectValueResult {
    const { device: deviceId, value } = params;
    this.setDeviceSelectValue(deviceId, value);
    return { device: deviceId, value };
  }

  private executeSetHandPose(params: SetHandPoseParams): SetHandPoseResult {
    const handInput = this.handFor(params.device);
    const { poseId, fingers } = this.parseHandPose(handInput, params);
    // Setting poseId clears earlier finger blends; then apply the new ones.
    handInput.poseId = poseId;
    for (const finger of Object.keys(fingers) as XRHandFinger[]) {
      handInput.setFingerPose(
        finger,
        fingers[finger]!.poseId,
        fingers[finger]!.weight,
      );
    }
    return { device: params.device, poseId, fingers: handInput.fingerPoses };
  }

  /** Validates set_hand_pose's pose and finger blends against the hand's poses. */
  private parseHandPose(
    handInput: XRHandInput,
    params: SetHandPoseParams,
  ): {
    poseId: string;
    fingers: Partial<Record<XRHandFinger, FingerPoseBlend>>;
  } {
    const { poseId, fingers } = params;
    const available = handInput.poseIds;
    const requireKnown = (id: unknown): string => {
      if (typeof id !== 'string' || !available.includes(id)) {
        throw new Error(
          `Unknown hand pose '${id}'. Available poses: ${available.join(', ')}.`,
        );
      }
      return id;
    };
    requireKnown(poseId);
    if (
      fingers !== undefined &&
      (fingers === null ||
        typeof fingers !== 'object' ||
        Array.isArray(fingers))
    ) {
      throw new Error('fingers must map finger names to poses.');
    }
    const fingerNames = Object.keys(handFingerJoints);
    const blends: Partial<Record<XRHandFinger, FingerPoseBlend>> = {};
    for (const [finger, blend] of Object.entries(fingers ?? {})) {
      if (!fingerNames.includes(finger)) {
        throw new Error(
          `Unknown finger '${finger}'. Fingers: ${fingerNames.join(', ')}.`,
        );
      }
      if (typeof blend !== 'string' && (!blend || typeof blend !== 'object')) {
        throw new Error(
          `Finger '${finger}' takes a pose id or { poseId, weight }.`,
        );
      }
      const { poseId: fingerPoseId, weight = 1 } =
        typeof blend === 'string' ? { poseId: blend } : blend;
      if (typeof weight !== 'number' || !(weight >= 0 && weight <= 1)) {
        throw new Error(`Finger weight must be within [0, 1], got ${weight}.`);
      }
      blends[finger as XRHandFinger] = {
        poseId: requireKnown(fingerPoseId),
        weight,
      };
    }
    return { poseId, fingers: blends };
  }

  private executeGetHandState(params: GetHandStateParams): GetHandStateResult {
    const hand = this.handFor(params.device);
    const toOrigin = (v: vec3) => this.transformGlobalToXROrigin(vec3FromGl(v));
    const rotateToOrigin = (v: vec3) => {
      const r = quat.invert(quat.create(), this.originRotation());
      const out = vec3.transformQuat(
        vec3.create(),
        v,
        quat.multiply(r, r, hand.quaternion.quat),
      );
      return vec3FromGl(out);
    };
    const anchors = {} as GetHandStateResult['anchors'];
    for (const name of [
      'wrist',
      'grip',
      'grasp',
      'index-tip',
      'thumb-tip',
    ] as const) {
      anchors[name] = toOrigin(this.anchorPosition(hand, name));
    }
    const axes = hand.handAxes();
    const transform = this.getDeviceTransformInOrigin(params.device);
    const pin = hand.pin;
    const state: GetHandStateResult = {
      device: params.device,
      connected: hand.connected,
      poseId: hand.poseId,
      fingers: hand.fingerPoses,
      transition:
        hand.poseTransitionProgress === null
          ? null
          : {
              from: hand.poseTransitionFrom!,
              progress: hand.poseTransitionProgress,
            },
      pinchValue: hand.pinchValue,
      pressed: hand.inputSource.gamepad!.buttons[0]!.pressed,
      position: transform.position,
      orientation: transform.orientation,
      pin: pin ? { anchor: pin.anchor, target: toOrigin(pin.target) } : null,
      anchors,
      axes: {
        fingers: rotateToOrigin(axes.fingers),
        palm: rotateToOrigin(axes.palm),
        thumb: rotateToOrigin(axes.thumb),
      },
    };
    if (params.joints === 'all') {
      state.joints = {};
      for (const jointName of Object.values(XRHandJoint)) {
        state.joints[jointName] = {
          position: toOrigin(this.anchorPosition(hand, jointName)),
          radius: hand.inputSource.hand!.get(jointName)![P_JOINT_SPACE].radius,
        };
      }
    }
    return state;
  }

  // =============================================================================
  // World / scene queries (require the synthetic environment module, SEM)
  // =============================================================================

  private requireSem(): SyntheticEnvironmentModule {
    const sem = this.device.sem;
    if (!sem) {
      throw new Error(
        'Scene understanding (SEM) is not installed on this device. ' +
          'Install @iwer/sem to query the emulated world.',
      );
    }
    return sem;
  }

  private executeGetObjects(): {
    objects: { type: 'plane' | 'mesh'; semanticLabel: string | null }[];
  } {
    const sem = this.requireSem();
    const objects: {
      type: 'plane' | 'mesh';
      semanticLabel: string | null;
    }[] = [];
    sem.trackedPlanes.forEach((plane) => {
      objects.push({
        type: 'plane',
        semanticLabel: plane.semanticLabel ?? null,
      });
    });
    sem.trackedMeshes.forEach((mesh) => {
      objects.push({ type: 'mesh', semanticLabel: mesh.semanticLabel ?? null });
    });
    // NOTE: object poses are intentionally omitted for now — SEM tracks them in
    // GlobalSpace and they need transforming into the app's XR-origin space.
    // Follow-up: add poses + a raycast query once that transform is wired.
    return { objects };
  }

  private executeGetWorldState(): {
    planeCount: number;
    meshCount: number;
    objects: { type: 'plane' | 'mesh'; semanticLabel: string | null }[];
  } {
    const sem = this.requireSem();
    return {
      planeCount: sem.trackedPlanes.size,
      meshCount: sem.trackedMeshes.size,
      objects: this.executeGetObjects().objects,
    };
  }

  // =============================================================================
  // Capability discovery & transport
  // =============================================================================

  /**
   * Describe the methods this interface exposes so an agent (or an MCP bridge)
   * can discover capabilities at runtime rather than relying on hard-coded
   * strings. `immediate` methods run synchronously; `requiresSession` methods
   * are queued and need an active, rendering XR session.
   */
  listMethods(): {
    method: string;
    immediate: boolean;
    requiresSession: boolean;
  }[] {
    const methods: {
      method: string;
      immediate: boolean;
      requiresSession: boolean;
    }[] = [];
    RemoteControlInterface.IMMEDIATE_METHODS.forEach((method) => {
      methods.push({ method, immediate: true, requiresSession: false });
    });
    RemoteControlInterface.SESSION_REQUIRED_METHODS.forEach((method) => {
      methods.push({ method, immediate: false, requiresSession: true });
    });
    return methods;
  }

  /** Alias for {@link listMethods}; returns the capability manifest. */
  describe(): ReturnType<RemoteControlInterface['listMethods']> {
    return this.listMethods();
  }

  /**
   * Opt-in transport bridge. Connect a message port (a MessagePort, Worker, or
   * WebSocket-like object) so a remote agent can drive the device by posting
   * `{ id, method, params }` envelopes and receiving `{ id, result }` or
   * `{ id, error }` replies. Kept out of the constructor to preserve the
   * dependency-light, in-process default.
   */
  connectTransport(port: {
    postMessage(message: unknown): void;
    addEventListener(
      type: 'message',
      listener: (event: { data: unknown }) => void,
    ): void;
  }): void {
    port.addEventListener('message', (event) => {
      const envelope = event.data as {
        id?: unknown;
        method?: unknown;
        params?: Record<string, unknown>;
      };
      if (!envelope || typeof envelope.method !== 'string') {
        return;
      }
      const { id, method, params } = envelope;
      this.dispatch(method, params ?? {})
        .then((result) => port.postMessage({ id, result }))
        .catch((error: unknown) =>
          port.postMessage({
            id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    });
  }

  // =============================================================================
  // Gamepad Tool Implementations
  // =============================================================================

  private executeGetGamepadState(
    params: GetGamepadStateParams,
  ): GetGamepadStateResult {
    const { device: deviceId } = params;
    const hand = deviceId === 'controller-left' ? 'left' : 'right';
    const controller = this.device.controllers[hand];

    if (!controller) {
      throw new Error(`Controller ${hand} not available`);
    }

    // Button layout for Meta Quest Touch Plus controllers
    // Use hand-conditional internal names for lookup
    const buttonInternalNames = [
      'trigger',
      'squeeze',
      'thumbstick',
      hand === 'left' ? 'x-button' : 'a-button',
      hand === 'left' ? 'y-button' : 'b-button',
      'thumbrest',
    ];

    const buttons = buttonInternalNames.map((name, index) => ({
      index,
      name: name
        .replace('x-button', 'x')
        .replace('y-button', 'y')
        .replace('a-button', 'a')
        .replace('b-button', 'b'),
      value: controller.getButtonValue(name),
      touched: controller.getButtonTouched(name),
      pressed: controller.getButtonPressed(name),
    }));

    const axesData = controller.getAxes();
    const axes = [
      { index: 0, name: 'thumbstick-x', value: axesData.x },
      { index: 1, name: 'thumbstick-y', value: axesData.y },
    ];

    return {
      device: deviceId,
      connected: controller.connected,
      buttons,
      axes,
    };
  }

  private executeSetGamepadState(
    params: SetGamepadStateParams,
  ): SetGamepadStateResult {
    const { device: deviceId, buttons, axes } = params;
    const hand = deviceId === 'controller-left' ? 'left' : 'right';
    const controller = this.device.controllers[hand];

    if (!controller) {
      throw new Error(`Controller ${hand} not available`);
    }

    let buttonsSet = 0;
    let axesSet = 0;

    // Button index to name mapping
    const buttonIndexToName = [
      'trigger',
      'squeeze',
      'thumbstick',
      hand === 'left' ? 'x-button' : 'a-button',
      hand === 'left' ? 'y-button' : 'b-button',
      'thumbrest',
    ];

    if (buttons) {
      for (const btn of buttons) {
        const buttonName = buttonIndexToName[btn.index];
        // Only apply (and count) finite values; clamp into the valid [0,1]
        // range so an out-of-range value can't silently no-op yet still count.
        if (buttonName && isFiniteNumber(btn.value)) {
          // Use updateButtonValue for proper event triggering
          controller.updateButtonValue(buttonName, clamp(btn.value, 0, 1));
          if (btn.touched !== undefined) {
            controller.updateButtonTouch(buttonName, btn.touched);
          }
          buttonsSet++;
        }
      }
    }

    if (axes) {
      let xValue: number | undefined;
      let yValue: number | undefined;
      for (const axis of axes) {
        if (!isFiniteNumber(axis.value)) {
          continue;
        }
        if (axis.index === 0) {
          xValue = clamp(axis.value, -1, 1);
          axesSet++;
        } else if (axis.index === 1) {
          yValue = clamp(axis.value, -1, 1);
          axesSet++;
        }
      }
      if (xValue !== undefined || yValue !== undefined) {
        const currentAxes = controller.getAxes();
        controller.updateAxes(
          'thumbstick',
          xValue ?? currentAxes.x,
          yValue ?? currentAxes.y,
        );
      }
    }

    return { device: deviceId, buttonsSet, axesSet };
  }

  // =============================================================================
  // State Tool Implementations
  // =============================================================================

  private executeGetDeviceState(): RemoteDeviceState {
    const identity = {
      position: { x: 0, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    };
    const inOrigin = (deviceId: DeviceId, present: boolean) =>
      present ? this.getDeviceTransformInOrigin(deviceId) : identity;
    const controller = (side: 'left' | 'right') => {
      const input = this.device.controllers[side];
      return {
        connected: input?.connected ?? false,
        ...inOrigin(`controller-${side}`, !!input),
      };
    };
    const hand = (side: 'left' | 'right') => {
      const input = this.device.hands[side];
      return {
        connected: input?.connected ?? false,
        ...inOrigin(`hand-${side}`, !!input),
        ...(input
          ? { poseId: input.poseId, pinchValue: input.pinchValue }
          : {}),
      };
    };
    return {
      headset: this.getDeviceTransformInOrigin('headset'),
      inputMode: this.device.primaryInputMode,
      controllers: { left: controller('left'), right: controller('right') },
      hands: { left: hand('left'), right: hand('right') },
      ...(this.device.gaze
        ? {
            gaze: {
              connected: this.device.gaze.connected,
              orientation: this.getDeviceTransformInOrigin('gaze').orientation,
            },
          }
        : {}),
      stereoEnabled: this.device.stereoEnabled,
      fov: this.device.fovy * (180 / Math.PI), // Convert to degrees
    };
  }

  private executeSetDeviceState(
    params: SetDeviceStateParams,
  ): SetDeviceStateResult {
    const { state } = params;

    this.releaseHands();
    if (!state) {
      // Reset to initial state; held buttons are cancelled, not completed.
      this.cancelHeldInputs();
      this.sequenceBody = null;
      this.device.position.set(0, 1.6, 0);
      this.device.quaternion.set(0, 0, 0, 1);
      this.device.primaryInputMode = 'controller';
      this.device.stereoEnabled = false;
      // Reset controllers and hands to default positions
      if (this.device.controllers.left) {
        this.device.controllers.left.position.set(-0.2, 1.4, -0.3);
        this.device.controllers.left.quaternion.set(0, 0, 0, 1);
        this.device.controllers.left.connected = true;
      }
      if (this.device.controllers.right) {
        this.device.controllers.right.position.set(0.2, 1.4, -0.3);
        this.device.controllers.right.quaternion.set(0, 0, 0, 1);
        this.device.controllers.right.connected = true;
      }
      if (this.device.hands.left) {
        this.device.hands.left.position.set(-0.15, 1.3, -0.4);
        this.device.hands.left.quaternion.set(0, 0, 0, 1);
        this.device.hands.left.connected = true;
      }
      if (this.device.hands.right) {
        this.device.hands.right.position.set(0.15, 1.3, -0.4);
        this.device.hands.right.quaternion.set(0, 0, 0, 1);
        this.device.hands.right.connected = true;
      }
      if (this.device.gaze) {
        this.device.gaze.quaternion.set(0, 0, 0, 1);
        this.device.gaze.connected = true;
      }
    } else {
      // Apply partial state
      if (state.headset) {
        // Validate before applying either component (atomic, no corruption).
        this.setDeviceTransformInOrigin(
          'headset',
          state.headset.position,
          state.headset.orientation,
        );
      }
      if (state.inputMode !== undefined) {
        this.device.primaryInputMode = state.inputMode;
      }
      if (state.stereoEnabled !== undefined) {
        this.device.stereoEnabled = state.stereoEnabled;
      }
      if (state.fov !== undefined) {
        this.device.fovy = state.fov * (Math.PI / 180); // Convert to radians
      }
      if (state.controllers) {
        this.applyInputState('controller-left', state.controllers.left);
        this.applyInputState('controller-right', state.controllers.right);
      }
      if (state.hands) {
        for (const side of ['left', 'right'] as const) {
          const handState = state.hands[side];
          this.applyInputState(`hand-${side}`, handState);
          const hand = this.device.hands[side];
          if (hand && handState?.poseId !== undefined) {
            this.parseHandPose(hand, {
              device: `hand-${side}`,
              poseId: handState.poseId,
            });
            hand.poseId = handState.poseId;
          }
          if (hand && handState?.pinchValue !== undefined) {
            this.setDeviceSelectValue(`hand-${side}`, handState.pinchValue);
          }
        }
      }
      if (state.gaze) {
        this.applyInputState('gaze', state.gaze);
      }
    }

    return { state: this.executeGetDeviceState() };
  }

  private applyInputState(
    deviceId: ConnectedInputDeviceId,
    state?: { connected?: boolean; position?: Vec3; orientation?: Quat },
  ): void {
    if (!state) return;

    if (state.connected !== undefined) {
      this.setDeviceConnected(deviceId, state.connected);
    }
    if (state.position || state.orientation) {
      this.setDeviceTransformInOrigin(
        deviceId,
        state.position,
        state.orientation,
      );
    }
  }

  // =============================================================================
  // Public API - Dispatch
  // =============================================================================

  /**
   * Set of methods that execute immediately (synchronously) without going through the queue.
   * These are queries and session management commands that need to work outside of XR frames.
   */
  private static readonly IMMEDIATE_METHODS = new Set([
    // Session management - must work before/after XR session
    'get_session_status',
    'accept_session',
    'end_session',
    // Pure queries - just read current state
    'get_transform',
    'get_select_value',
    'get_gamepad_state',
    'get_device_state',
    'get_hand_state',
    'list_targets',
    // Stops a running sequence; must not wait behind it
    'cancel_sequence',
    // World/scene introspection - reads the synthetic environment (SEM)
    'get_world_state',
    'get_objects',
  ]);

  /**
   * Set of immediate methods that are "active" - they modify state and should trigger capture mode.
   * Passive methods (queries) should NOT trigger capture mode.
   */
  private static readonly ACTIVE_IMMEDIATE_METHODS = new Set([
    'accept_session',
    'end_session',
  ]);

  /**
   * Queued methods that write a device's buttons. A second write to the same
   * device waits for the next frame, so a press and its release never land
   * in one frame (see update()).
   */
  private static readonly INPUT_WRITE_METHODS = new Set([
    'set_select_value',
    'set_gamepad_state',
    'select',
    '_hand_motion',
    'run_sequence',
  ]);

  /**
   * Queued methods that end the queue's work for the frame: they change which
   * input sources exist, which the app hears about before any edge.
   */
  private static readonly FRAME_ENDING_METHODS = new Set([
    'set_input_mode',
    'set_connected',
    'set_device_state',
  ]);

  /**
   * Set of methods that require an active XR session.
   * These are state-modifying methods that are processed during frame updates.
   */
  private static readonly SESSION_REQUIRED_METHODS = new Set([
    'set_transform',
    'look_at',
    'animate_to',
    'set_input_mode',
    'set_connected',
    'set_select_value',
    'select',
    'set_gamepad_state',
    'set_device_state',
    'set_hand_pose',
    'run_sequence',
  ]);

  /**
   * Activate capture mode for programmatic control.
   * Called when active methods are executed.
   */
  private activateCaptureMode(): void {
    if (!this._isCaptured) {
      this._isCaptured = true;
      this.cancelReleaseTimer();
      this.device.controlMode = 'programmatic';
    }
    // Reset the release timer
    this.startReleaseTimer();
  }

  /**
   * Dispatch a method call.
   *
   * Immediate methods (queries, session management) execute synchronously.
   * State-modifying methods require an active session and are queued for frame-synchronized execution.
   *
   * @param method - The method name (e.g., 'get_transform', 'animate_to')
   * @param params - The method parameters
   * @returns Promise that resolves with the method result
   */
  async dispatch(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    // Normalize device identifier aliases (e.g. "right" -> "controller-right")
    // into a copy — never mutate the caller's params object (it may be reused,
    // frozen, or aliased onto a queued action).
    const normalizedParams =
      typeof params.device === 'string'
        ? { ...params, device: resolveDeviceId(params.device) }
        : params;

    // Immediate methods execute synchronously without queue
    if (RemoteControlInterface.IMMEDIATE_METHODS.has(method)) {
      // Active immediate methods trigger capture mode
      if (RemoteControlInterface.ACTIVE_IMMEDIATE_METHODS.has(method)) {
        this.activateCaptureMode();
      }
      return this.executeImmediateMethod(method, normalizedParams);
    }

    // Methods that modify state require an active session
    if (RemoteControlInterface.SESSION_REQUIRED_METHODS.has(method)) {
      if (!this.device[P_DEVICE].runtime.getSession()) {
        const guidance =
          this.device[P_DEVICE].runtime.kind === 'native'
            ? 'The application must start its native immersive session first.'
            : `Use 'get_session_status' to check session state, and 'accept_session' to start a session.`;
        throw new Error(
          `Cannot execute '${method}': No active XR session. ` + guidance,
        );
      }
    }

    // Timed commands hold the head of the queue until they finish.
    if (method === 'animate_to') {
      return this.enqueueAnimateTo(
        normalizedParams as unknown as AnimateToParams,
        normalizedParams,
      );
    }
    if (
      method === 'set_select_value' &&
      (normalizedParams as { duration?: unknown }).duration !== undefined
    ) {
      return this.enqueueSelectRamp(
        normalizedParams as unknown as SetSelectValueParams,
        normalizedParams,
      );
    }
    if (
      method === 'set_hand_pose' &&
      (normalizedParams as { duration?: unknown }).duration !== undefined
    ) {
      return this.enqueuePoseFade(
        normalizedParams as unknown as SetHandPoseParams,
        normalizedParams,
      );
    }

    if (method === 'run_sequence') {
      return this.enqueueSequence(
        normalizedParams as unknown as RunSequenceParams,
        normalizedParams,
      );
    }

    // Handle select specially - it's a discrete action that enqueues multiple sub-actions
    if (method === 'select') {
      const selectParams = normalizedParams as unknown as SelectParams;
      return this.executeSelectSequence(selectParams);
    }

    // All other methods are discrete actions that go through the queue
    return this.enqueueDiscrete(method, normalizedParams);
  }

  /**
   * Execute an immediate method synchronously (not queued).
   * Used for queries and session management that must work outside XR frames.
   */
  private executeImmediateMethod(
    method: string,
    params: Record<string, unknown>,
  ): unknown {
    switch (method) {
      case 'get_session_status':
        return this.executeGetSessionStatus();
      case 'accept_session':
        return this.executeAcceptSession();
      case 'end_session':
        return this.executeEndSession();
      case 'get_transform':
        return this.executeGetTransform(
          params as unknown as GetTransformParams,
        );
      case 'get_select_value':
        return this.executeGetSelectValue(
          params as unknown as GetSelectValueParams,
        );
      case 'get_gamepad_state':
        return this.executeGetGamepadState(
          params as unknown as GetGamepadStateParams,
        );
      case 'get_device_state':
        return this.executeGetDeviceState();
      case 'get_hand_state':
        return this.executeGetHandState(
          params as unknown as GetHandStateParams,
        );
      case 'list_targets':
        return this.executeListTargets();
      case 'cancel_sequence':
        return this.executeCancelSequence();
      case 'get_world_state':
        return this.executeGetWorldState();
      case 'get_objects':
        return this.executeGetObjects();
      default:
        throw new Error(`Unknown immediate method: ${method}`);
    }
  }

  // =============================================================================
  // Timed commands
  // =============================================================================

  /**
   * The select value last written for a device: the one waiting for the next
   * frame, else the current one.
   */
  private latestSelectValue(deviceId: SelectableDeviceId): number {
    const side = deviceId.endsWith('left') ? 'left' : 'right';
    const isHand = deviceId.startsWith('hand');
    const input = isHand
      ? this.device.hands[side]
      : this.device.controllers[side];
    const button =
      input?.inputSource.gamepad?.[P_GAMEPAD].buttonsMap[
        isHand ? 'pinch' : 'trigger'
      ];
    return (
      button?.[P_GAMEPAD].pendingValue ?? this.getDeviceSelectValue(deviceId)
    );
  }

  /** A pinch (or trigger) ramp from the value it starts at to `value`. */
  private pinchChannel(
    deviceId: SelectableDeviceId,
    value: number,
    durationMs: number,
    easing: Easing,
  ): Channel {
    let from = 0;
    return {
      device: deviceId,
      kind: 'pinch',
      durationMs,
      easing,
      begin: () => {
        from = this.latestSelectValue(deviceId);
      },
      apply: (progress) => {
        this.setDeviceSelectValue(deviceId, from + (value - from) * progress);
      },
    };
  }

  /** A pose fade from the hand as shown when it starts. */
  private poseChannel(
    hand: XRHandInput,
    deviceId: string,
    pose: Pick<SetHandPoseParams, 'poseId' | 'fingers'>,
    durationMs: number,
    easing: Easing,
  ): Channel {
    return {
      device: deviceId,
      kind: 'pose',
      durationMs,
      easing,
      begin: () => {
        const { poseId, fingers } = this.parseHandPose(hand, {
          device: deviceId as SetHandPoseParams['device'],
          ...pose,
        });
        hand.beginPoseTransition(poseId, fingers);
      },
      apply: (progress) => {
        // A pose set in the meantime (DevUI, a release) ended the fade.
        if (hand.poseTransitionProgress !== null) {
          hand.poseTransitionProgress = progress;
        }
      },
    };
  }

  /**
   * The transform channel of animate_to. A hand placed by an anchor or by hand
   * directions moves its pin (the anchor's path, and the wrist's rotation);
   * anything else moves the device pose as before. Start and target are
   * taken when the channel starts.
   */
  private moveChannel(
    params: Pick<
      AnimateToParams,
      'device' | 'position' | 'orientation' | 'anchor'
    >,
    durationMs: number,
    easing: Easing,
  ): Channel {
    const { device: deviceId, position, orientation, anchor } = params;
    if (this.isHandPlacement(deviceId, anchor, orientation)) {
      let hand!: XRHandInput;
      let handAnchor!: HandAnchor;
      const fromTarget = vec3.create();
      const toTarget = vec3.create();
      const fromWrist = quat.create();
      let toWrist: quat | undefined;
      let fromRay: quat | undefined;
      let toRay: quat | undefined;
      const target = vec3.create();
      const rotation = quat.create();
      return {
        device: deviceId,
        kind: 'transform',
        durationMs,
        easing,
        begin: () => {
          hand = this.requireLiveHand(deviceId);
          handAnchor = this.requireAnchor(anchor ?? 'target-ray');
          vec3.copy(fromTarget, this.anchorPosition(hand, handAnchor));
          vec3.copy(
            toTarget,
            position
              ? this.toVec3(
                  this.transformXROriginToGlobal(position),
                  'position',
                )
              : fromTarget,
          );
          hand.wristRotation(fromWrist);
          // 'auto' is resolved once, toward where the anchor is going.
          const resolved = this.resolveHandOrientation(
            hand,
            orientation,
            toTarget,
          );
          toWrist = resolved.wristRotation;
          if (resolved.rayRotation) {
            fromRay = quat.clone(hand.quaternion.quat);
            const r = resolved.rayRotation;
            toRay = quat.fromValues(r.x, r.y, r.z, r.w);
          } else if (!toWrist && hand.pin?.wristRotation) {
            toWrist = quat.clone(hand.pin.wristRotation);
          }
        },
        apply: (progress) => {
          vec3.lerp(target, fromTarget, toTarget, progress);
          if (fromRay && toRay) {
            quat.slerp(rotation, fromRay, toRay, progress);
            hand.quaternion.set(
              rotation[0],
              rotation[1],
              rotation[2],
              rotation[3],
            );
          }
          if (toWrist) {
            quat.slerp(rotation, fromWrist, toWrist, progress);
          }
          hand.setPin({
            anchor: handAnchor,
            target,
            wristRotation: toWrist ? rotation : undefined,
          });
        },
      };
    }

    if (anchor !== undefined && anchor !== 'target-ray') {
      this.requireAnchor(anchor);
    }
    let from!: { position: Vec3; orientation: Quat };
    let toPosition: Vec3 | undefined;
    let toOrientation: Quat | undefined;
    return {
      device: deviceId,
      kind: 'transform',
      durationMs,
      easing,
      begin: () => {
        from = this.getDeviceTransform(deviceId);
        toPosition = position
          ? this.transformXROriginToGlobal(position)
          : undefined;
        toOrientation = orientation
          ? this.orientationToGlobal(
              validateAndNormalizeQuat(
                normalizeOrientation(orientation as OrientationInput),
              ),
            )
          : undefined;
        if (deviceId === 'hand-left' || deviceId === 'hand-right') {
          // A move by the target ray lets go of any pin.
          this.handFor(deviceId).setPin(null);
        }
      },
      apply: (progress) => {
        this.setDeviceTransform(
          deviceId,
          toPosition
            ? lerpVec3(from.position, toPosition, progress)
            : undefined,
          toOrientation
            ? slerpQuat(from.orientation, toOrientation, progress)
            : undefined,
        );
      },
    };
  }

  /** animate_to: one transform channel; the start pose is taken when it starts. */
  private enqueueAnimateTo(
    params: AnimateToParams,
    rawParams: Record<string, unknown>,
  ): Promise<unknown> {
    const { device: deviceId, position } = params;
    if (deviceId === 'gaze' && position) {
      throw new Error(
        'Gaze position is derived from the headset. Move the headset transform instead.',
      );
    }
    const durationMs = (params.duration ?? 0.5) * 1000;
    const easing = this.requireEasing(params.easing, 'linear');
    const channel = this.moveChannel(params, durationMs, easing);
    return this.enqueueChannels(
      'animate_to',
      rawParams,
      () => [channel],
      (elapsedMs): AnimateToResult => {
        const transform = this.getDeviceTransformInOrigin(deviceId);
        return {
          device: deviceId,
          position: transform.position,
          orientation: transform.orientation,
          actualDuration: elapsedMs / 1000,
        };
      },
      durationMs,
    );
  }

  /** set_select_value with a duration: ramps from the current value. */
  private enqueueSelectRamp(
    params: SetSelectValueParams,
    rawParams: Record<string, unknown>,
  ): Promise<unknown> {
    const deviceId = requireSelectableDeviceId(params.device);
    const { value } = params;
    const durationMs = this.requireDuration(params.duration, 'Select') * 1000;
    const easing = this.requireEasing(params.easing, 'minimum-jerk');
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
      throw new Error(`Select value must be within [0, 1], got ${value}.`);
    }
    return this.enqueueChannels(
      'set_select_value',
      rawParams,
      () => {
        if (deviceId === 'hand-left' || deviceId === 'hand-right') {
          this.requireLiveHand(deviceId);
        }
        return [this.pinchChannel(deviceId, value, durationMs, easing)];
      },
      (): SetSelectValueResult => ({ device: deviceId, value }),
      durationMs,
    );
  }

  /** set_hand_pose with a duration: fades from the hand as shown. */
  private enqueuePoseFade(
    params: SetHandPoseParams,
    rawParams: Record<string, unknown>,
  ): Promise<unknown> {
    const hand = this.handFor(params.device);
    const durationMs = this.requireDuration(params.duration, 'Pose') * 1000;
    const easing = this.requireEasing(params.easing, 'minimum-jerk');
    return this.enqueueChannels(
      'set_hand_pose',
      rawParams,
      () => {
        this.requireLiveHand(params.device);
        return [
          this.poseChannel(hand, params.device, params, durationMs, easing),
        ];
      },
      (): SetHandPoseResult => ({
        device: params.device,
        poseId: hand.poseId,
        fingers: hand.fingerPoses,
      }),
      durationMs,
    );
  }

  /**
   * @internal Runs a move, a pose fade and a pinch ramp of one hand together,
   * as one queued action (each takes the params of animate_to, set_hand_pose
   * or set_select_value, without the device). Resolves with get_hand_state
   * once all of them finish. Not a remote method: the channel engine's entry
   * point for hand sequences and tests.
   */
  runHandMotion(
    deviceId: 'hand-left' | 'hand-right',
    motion: {
      move?: Omit<AnimateToParams, 'device'>;
      pose?: Omit<SetHandPoseParams, 'device'>;
      pinch?: Omit<SetSelectValueParams, 'device'>;
    },
  ): Promise<unknown> {
    const hand = this.handFor(deviceId);
    const channels: Channel[] = [];
    if (motion.move) {
      channels.push(
        this.moveChannel(
          { ...motion.move, device: deviceId },
          (motion.move.duration ?? 0.5) * 1000,
          this.requireEasing(motion.move.easing, 'linear'),
        ),
      );
    }
    if (motion.pose) {
      channels.push(
        this.poseChannel(
          hand,
          deviceId,
          motion.pose,
          this.requireDuration(motion.pose.duration, 'Pose') * 1000,
          this.requireEasing(motion.pose.easing, 'minimum-jerk'),
        ),
      );
    }
    if (motion.pinch) {
      channels.push(
        this.pinchChannel(
          deviceId,
          motion.pinch.value,
          this.requireDuration(motion.pinch.duration, 'Select') * 1000,
          this.requireEasing(motion.pinch.easing, 'minimum-jerk'),
        ),
      );
    }
    return this.enqueueChannels(
      '_hand_motion',
      { device: deviceId },
      () => {
        this.requireLiveHand(deviceId);
        return channels;
      },
      () => this.executeGetHandState({ device: deviceId }),
      Math.max(0, ...channels.map((c) => (c.delayMs ?? 0) + c.durationMs)),
    );
  }

  /**
   * Execute select action: press, hold `duration`, release, on the device's
   * pinch channel. A hand closes its pinch over 0.1 s and opens it over 0.1 s
   * around the hold; a controller steps its trigger. Each edge lands on its
   * own frame.
   */
  private executeSelectSequence(params: SelectParams): Promise<SelectResult> {
    const { device: deviceId, duration = DEFAULT_SELECT_DURATION_S } = params;

    // Validate device upfront to prevent sub-actions from failing in the frame loop
    this.getDeviceSelectValue(deviceId);
    const holdMs = Math.max(0, duration) * 1000;
    const isHand = deviceId === 'hand-left' || deviceId === 'hand-right';
    const rampMs = isHand ? HAND_PINCH_RAMP_S * 1000 : 0;
    // Close, hold, open.
    const phases = [
      () => this.pinchChannel(deviceId, 1, rampMs, 'minimum-jerk'),
      () => this.pinchChannel(deviceId, 1, holdMs, 'linear'),
      () => this.pinchChannel(deviceId, 0, rampMs, 'minimum-jerk'),
    ];
    let phase = 0;
    let run!: ChannelRun;
    return this.enqueueTick(
      'select',
      params as unknown as Record<string, unknown>,
      {
        estimateMs: holdMs + 2 * rampMs,
        start: () => {
          run = this.channels.run([phases[0]()]);
        },
        tick: (deltaMs) => {
          let leftover = run.advance(deltaMs);
          while (leftover >= 0) {
            phase++;
            if (phase === phases.length) {
              return leftover;
            }
            run = this.channels.run([phases[phase]()]);
            if (phase === 1) {
              // The press lands this frame; what is left of it counts toward
              // the hold, and the release comes on a later frame.
              run.advance(Math.min(leftover, holdMs));
              return -1;
            }
            leftover = run.advance(leftover);
          }
          return -1;
        },
        result: () => ({ device: deviceId, duration }),
      },
    ) as Promise<SelectResult>;
  }

  // =============================================================================
  // Hand sequences
  // =============================================================================

  /**
   * Registers how run_sequence steps turn `target` names into points in the
   * scene: an app framework knows its objects, IWER doesn't. Pass null to
   * remove it.
   */
  setTargetResolver(resolver: TargetResolver | null): void {
    this.targetResolver = resolver;
  }

  /** Runs a hand sequence; same as `dispatch('run_sequence', params)`. */
  runSequence(
    params: RunSequenceParams,
  ): Promise<SequenceResult | SequencePlan> {
    return this.dispatch(
      'run_sequence',
      params as unknown as Record<string, unknown>,
    ) as Promise<SequenceResult | SequencePlan>;
  }

  /** What the sequence runner needs from remote control. */
  private sequenceHost(): SequenceHost {
    return {
      hand: (deviceId) => this.handFor(deviceId),
      liveHand: (deviceId) => this.requireLiveHand(deviceId),
      otherHand: (deviceId) => {
        const other =
          this.device.hands[deviceId === 'hand-left' ? 'right' : 'left'];
        return other?.connected ? other : undefined;
      },
      headPose: () => ({
        position: vec3.clone(this.device.position.vec3),
        rotation: quat.clone(this.device.quaternion.quat),
      }),
      setHeadPose: (position, rotation) => {
        this.device.position.set(position[0], position[1], position[2]);
        this.device.quaternion.set(
          rotation[0],
          rotation[1],
          rotation[2],
          rotation[3],
        );
      },
      originToGlobal: (position) =>
        this.toVec3(
          this.transformXROriginToGlobal(vec3FromGl(position)),
          'position',
        ),
      globalToOrigin: (position) =>
        this.toVec3(
          this.transformGlobalToXROrigin(vec3FromGl(position)),
          'position',
        ),
      originDirectionToGlobal: (direction) =>
        vec3.transformQuat(vec3.create(), direction, this.originRotation()),
      globalDirectionToOrigin: (direction) =>
        vec3.transformQuat(
          vec3.create(),
          direction,
          quat.invert(quat.create(), this.originRotation()),
        ),
      directionToGlobal: (value, what, from, body) =>
        this.directionToGlobal(value, what, from, body),
      anchorPosition: (hand, anchor, graspPinch) =>
        this.anchorPosition(hand, anchor, graspPinch),
      requireAnchor: (anchor) => this.requireAnchor(anchor),
      resolveOrientation: (hand, orientation, target, body) =>
        this.resolveHandOrientation(hand, orientation, target, body),
      parsePose: (hand, poseId, fingers) =>
        this.parseHandPose(hand, {
          device:
            hand.inputSource.handedness === 'left' ? 'hand-left' : 'hand-right',
          poseId,
          fingers,
        }),
      setPinch: (deviceId, value) => this.setDeviceSelectValue(deviceId, value),
      latestPinch: (deviceId) => this.latestSelectValue(deviceId),
      pinchButton: (deviceId) =>
        this.handFor(deviceId).inputSource.gamepad![P_GAMEPAD].buttonsMap
          .pinch!,
      channels: this.channels,
      resolver: () => this.targetResolver,
      handState: (deviceId) => this.executeGetHandState({ device: deviceId }),
      bodyState: () => this.sequenceBody,
      setBodyState: (state) => {
        this.sequenceBody = {
          forward: vec3.clone(state.forward),
          standing: vec3.clone(state.standing),
        };
      },
    };
  }

  /**
   * run_sequence: validated and planned at dispatch (a dry run answers right
   * away), then run as one timed action holding the head of the queue.
   */
  private enqueueSequence(
    params: RunSequenceParams,
    rawParams: Record<string, unknown>,
  ): Promise<SequenceResult | SequencePlan> {
    const host = this.sequenceHost();
    const warnings: string[] = [];
    const plan = SequenceRunner.describe(
      host,
      params,
      planSequence(host, params),
      warnings,
    );
    if (params.dryRun) {
      try {
        this.requireLiveHand(params.device);
      } catch (error) {
        warnings.push((error as Error).message);
      }
      return Promise.resolve(plan);
    }
    // The agent waits for everything queued ahead as well.
    const queuedS = this.queuedMs() / 1000;
    if (plan.duration + queuedS > SEQUENCE_BUDGET_S) {
      throw new Error(
        `The sequence would take about ${plan.duration.toFixed(1)} s` +
          (queuedS > 0.05
            ? `, after ${queuedS.toFixed(1)} s of commands queued ahead`
            : '') +
          `; keep it under ${SEQUENCE_BUDGET_S} s (split it into several run_sequence calls).`,
      );
    }
    // Plan again for the run: segments keep their own state.
    const segments = planSequence(host, params);
    const deadline = performance.now() + this.SEQUENCE_DEADLINE_MS;
    let runner!: SequenceRunner;
    return this.enqueueTick('run_sequence', rawParams, {
      estimateMs: plan.duration * 1000,
      start: () => {
        runner = new SequenceRunner(host, params, segments, deadline);
        runner.start();
      },
      tick: (deltaMs) => (runner.done ? deltaMs : runner.tick(deltaMs)),
      result: () => runner.result(),
      abort: (reason) => {
        this.releaseHands();
        return runner.abort(reason);
      },
    }) as Promise<SequenceResult>;
  }

  /**
   * cancel_sequence: stops a running sequence at the current frame. Fades,
   * ramps and pins are let go; the pinch stays as it is.
   */
  private executeCancelSequence(): CancelSequenceResult {
    const head = this.commandQueue[0];
    if (
      head?.type !== 'tick' ||
      head.method !== 'run_sequence' ||
      !head.started ||
      !head.abort
    ) {
      return { cancelled: false };
    }
    this.commandQueue.shift();
    this.armWatchdog();
    const sequence = head.abort('cancelled') as SequenceResult;
    head.resolve(sequence);
    if (this.commandQueue.length === 0) {
      this.startReleaseTimer();
    }
    return { cancelled: true, sequence };
  }

  /** list_targets: what the page's target resolver knows. */
  private executeListTargets(): ListTargetsResult {
    if (!this.targetResolver) {
      return { resolver: false, targets: [] };
    }
    return { resolver: true, targets: this.targetResolver.list?.() ?? [] };
  }

  /**
   * Accept an offered XR session (async wrapper for proper session activation)
   */
  async acceptSession(): Promise<AcceptSessionResult> {
    if (this.device[P_DEVICE].runtime.kind === 'native') {
      throw new Error(
        'Session start is app-driven in native override mode; immersive sessions require a user gesture.',
      );
    }
    if (!this.device.sessionOffered) {
      throw new Error('No session has been offered');
    }

    this.device.grantOfferedSession();

    // Wait for session to become active
    await waitForCondition(() => !!this.device.activeSession, 5000);

    // Just return success - caller can use get_session_status for details
    return { success: true };
  }

  /**
   * Called when the XR session ends: queued commands can't run against a
   * session that is gone, so they are rejected instead of resuming in the
   * next session.
   */
  onSessionEnd(): void {
    this.releaseHands();
    // A running sequence resolves with what it did; the rest reject.
    this.interruptQueue('session-ended', () => 'The XR session ended.');
    if (this._isCaptured) {
      this.startReleaseTimer();
    }
  }

  /**
   * Force release capture mode (for testing/cleanup)
   */
  forceRelease(): void {
    this.cancelReleaseTimer();
    this._isCaptured = false;
    this.device.controlMode = 'manual';

    // Cancel any held input on BOTH controllers and hands so an interrupted
    // select/squeeze/thumbstick (or hand pinch) doesn't stay engaged. Held
    // select/squeeze actions end without completing. Poses are intentionally
    // left where they are; pins and pose fades are let go.
    this.cancelHeldInputs();
    this.releaseHands();
    for (const hand of ['left', 'right'] as const) {
      this.device.controllers[hand]?.updateAxes('thumbstick', 0, 0);
    }
    // Clear pending actions; a running sequence resolves with what it did.
    this.interruptQueue('released', () => 'Capture released');
  }

  /**
   * Cancel every held button on both controllers and hands: values drop to 0
   * and a press the app saw ends with `selectend`/`squeezeend` alone.
   */
  private cancelHeldInputs(): void {
    for (const hand of ['left', 'right'] as const) {
      for (const input of [
        this.device.controllers[hand],
        this.device.hands[hand],
      ]) {
        for (const button of input?.inputSource.gamepad?.buttons ?? []) {
          if (button instanceof GamepadButton) {
            cancelButton(button);
          }
        }
      }
    }
  }
}
