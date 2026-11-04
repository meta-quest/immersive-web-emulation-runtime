/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host input: real tracking data (from a native runtime such as OpenXR)
// driving IWER's input sources. See HOST-INPUT.md for the contract.

import {
  Axis,
  Button,
  Gamepad,
  GamepadButton,
  GamepadConfig,
} from '../gamepad/Gamepad.js';
import { GlobalSpace, XRSpace } from '../spaces/XRSpace.js';
import {
  P_DEVICE,
  P_GAMEPAD,
  P_HOST_INPUT,
  P_JOINT_SPACE,
  P_SESSION,
  P_SPACE,
} from '../private.js';
import { XRHand, XRHandJoint } from '../input/XRHand.js';
import {
  XRHandedness,
  XRInputSource,
  XRTargetRayMode,
} from '../input/XRInputSource.js';
import { XRHandGamepadConfig, oculusHandConfig } from './XRHandInput.js';
import { XRTrackedInput, dispatchButtonEdge } from './XRTrackedInput.js';

import type { XRControllerConfig } from './XRController.js';
import type { XRDevice } from './XRDevice.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import { XRJointSpace } from '../spaces/XRJointSpace.js';
import type { XRSession } from '../session/XRSession.js';
import type { mat4 } from 'gl-matrix';
import { oculusTouchV3 } from './configs/controller/meta.js';

/** Which input source a hand shows. */
export enum XRHostInputMode {
  None = 0,
  Controller = 1,
  Hand = 2,
}

/** Button slots per hand: the larger of the controller (8) and hand (10) gamepads. */
export const HOST_INPUT_BUTTONS = 10;
/** WebXR hand joints, `XRHandJoint` order. */
export const HOST_INPUT_JOINTS = 25;
/** Floats per joint: position xyz, orientation xyzw, radius. */
export const HOST_INPUT_JOINT_STRIDE = 8;
/** Floats per pose: position xyz, orientation xyzw. */
export const HOST_INPUT_POSE_STRIDE = 7;

const AXES = 4;
const JOINT_NAMES = Object.values(XRHandJoint);
/** `jointValid` index of the wrist, whose tracking decides whether a hand is listed. */
const WRIST_JOINT = JOINT_NAMES.indexOf(XRHandJoint.Wrist);

export type XRHostHandedness = XRHandedness.Left | XRHandedness.Right;

/**
 * Receives a haptic pulse on a host controller. Intensity is 0..1, the
 * duration is in milliseconds and the frequency is 0 (the runtime's default).
 * A returned promise becomes the result of `pulse()`.
 */
export type XRHostHapticCallback = (
  handedness: 'left' | 'right',
  intensity: number,
  durationMs: number,
  frequencyHz: number,
) => void | Promise<boolean>;

export interface XRHostInputOptions {
  /** Give the left controller gamepad 'menu' at index 7 (default true). */
  leftMenuButton?: boolean;
  onHaptic?: XRHostHapticCallback | null;
  /**
   * Controller profiles and gamepad layout. Defaults to the device's own
   * controller config, or Touch v3 for a device without controllers.
   */
  controllerConfig?: XRControllerConfig;
}

/**
 * Tracking and button state for one side (left or right) as the next frame
 * should see it. IWER creates these objects once and never replaces them;
 * the host writes new values into their fields before each frame, and IWER
 * reads the fields when the frame starts.
 */
export class XRHostInputState {
  readonly handedness: XRHostHandedness;
  mode: XRHostInputMode = XRHostInputMode.None;
  /** Target ray (aim) pose: px py pz qx qy qz qw. */
  readonly targetRay = new Float32Array(HOST_INPUT_POSE_STRIDE);
  targetRayValid = false;
  /** Grip pose: px py pz qx qy qz qw. */
  readonly grip = new Float32Array(HOST_INPUT_POSE_STRIDE);
  gripValid = false;
  /** Palm pose (hands only), the grip of a hand whose grip is not valid. */
  readonly palm = new Float32Array(HOST_INPUT_POSE_STRIDE);
  palmValid = false;
  /** Button values, gamepad index order. */
  readonly buttonValues = new Float32Array(HOST_INPUT_BUTTONS);
  /** 1 pressed. The host decides; IWER applies no threshold. */
  readonly buttonPressed = new Uint8Array(HOST_INPUT_BUTTONS);
  /** 1 touched. Pressed implies touched. */
  readonly buttonTouched = new Uint8Array(HOST_INPUT_BUTTONS);
  /** Gamepad axes (controllers): touchpad x, y, thumbstick x, y. */
  readonly axes = new Float32Array(AXES);
  /** WebXR joints, `XRHandJoint` order: px py pz qx qy qz qw radius. */
  readonly joints = new Float32Array(
    HOST_INPUT_JOINTS * HOST_INPUT_JOINT_STRIDE,
  );
  /** 1 tracked, per joint. */
  readonly jointValid = new Uint8Array(HOST_INPUT_JOINTS);

  constructor(handedness: XRHostHandedness) {
    this.handedness = handedness;
    this.targetRay[6] = 1;
    this.grip[6] = 1;
    this.palm[6] = 1;
    for (let j = 0; j < HOST_INPUT_JOINTS; j++) {
      this.joints[j * HOST_INPUT_JOINT_STRIDE + 6] = 1;
    }
  }
}

/**
 * Writes a pose (position + unit quaternion at `offset` in `src`) into a
 * column-major matrix, as gl-matrix's fromRotationTranslation does, without
 * making a view of the source.
 */
const poseToMatrix = (out: mat4, src: Float32Array, offset: number) => {
  const x = src[offset + 3];
  const y = src[offset + 4];
  const z = src[offset + 5];
  const w = src[offset + 6];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  out[0] = 1 - (yy + zz);
  out[1] = xy + wz;
  out[2] = xz - wy;
  out[3] = 0;
  out[4] = xy - wz;
  out[5] = 1 - (xx + zz);
  out[6] = yz + wx;
  out[7] = 0;
  out[8] = xz + wy;
  out[9] = yz - wx;
  out[10] = 1 - (xx + yy);
  out[11] = 0;
  out[12] = src[offset];
  out[13] = src[offset + 1];
  out[14] = src[offset + 2];
  out[15] = 1;
};

const writePose = (
  space: XRSpace,
  src: Float32Array,
  offset: number,
  valid: boolean,
) => {
  space[P_SPACE].tracked = valid;
  if (valid) {
    poseToMatrix(space[P_SPACE].offsetMatrix, src, offset);
  }
};

/** A space driven by host tracking: a direct child of the global space. */
const createHostSpace = (globalSpace: GlobalSpace) => {
  const space = new XRSpace(globalSpace);
  space[P_SPACE].emulated = false;
  space[P_SPACE].tracked = false;
  return space;
};

/** The host owns `pressed`, so every button is manual. */
const toManualButton = (button: Button | null): Button | null =>
  button && {
    id: button.id,
    type: 'manual',
    ...(button.eventTrigger ? { eventTrigger: button.eventTrigger } : {}),
  };

const TOUCHPAD_AXES: Axis[] = [
  { id: 'touchpad', type: 'x-axis' },
  { id: 'touchpad', type: 'y-axis' },
];

const hostControllerGamepadConfig = (
  config: GamepadConfig,
  menuButton: boolean,
): GamepadConfig => {
  const buttons = config.buttons.map(toManualButton);
  if (menuButton && buttons.length <= 7) {
    while (buttons.length < 7) {
      buttons.push(null);
    }
    buttons.push({ id: 'menu', type: 'manual' });
  }
  // xr-standard axes are numbers; Touch has no touchpad, so 0.
  const axes: (Axis | null)[] = [];
  for (let i = 0; i < AXES; i++) {
    axes.push(config.axes[i] ?? (i < 2 ? TOUCHPAD_AXES[i] : null));
  }
  return { mapping: config.mapping, buttons, axes };
};

const hostHandGamepadConfig: GamepadConfig = {
  mapping: XRHandGamepadConfig.mapping,
  buttons: XRHandGamepadConfig.buttons.map(toManualButton),
  axes: [],
};

/** Shared by host controllers and hands: buttons, priming and edges. */
abstract class XRHostSource extends XRTrackedInput {
  protected readonly state: XRHostInputState;
  // Gamepad buttons by index (null for empty slots), resolved once.
  protected readonly buttons: (GamepadButton | null)[];
  // A source primes on the frame it is listed: its buttons take their state
  // without reporting an edge, so a held trigger reports `selectstart` on
  // the next frame, after `inputsourceschange` announced the source.
  primed = false;

  constructor(inputSource: XRInputSource, state: XRHostInputState) {
    super(inputSource);
    this.state = state;
    this.connected = false;
    this.buttons = inputSource.gamepad!.buttons.map((button) =>
      button instanceof GamepadButton ? button : null,
    );
  }

  protected applyButtons() {
    const { buttonValues, buttonPressed, buttonTouched } = this.state;
    const buttons = this.buttons;
    const count = Math.min(buttons.length, HOST_INPUT_BUTTONS);
    for (let i = 0; i < count; i++) {
      const button = buttons[i];
      if (button) {
        const s = button[P_GAMEPAD];
        s.value = buttonValues[i];
        s.pressed = buttonPressed[i] !== 0;
        s.touched = s.pressed || buttonTouched[i] !== 0;
      }
    }
  }

  protected applyEdges(frame: XRFrame) {
    const buttons = this.buttons;
    if (!this.primed) {
      for (let i = 0; i < buttons.length; i++) {
        const button = buttons[i];
        if (button) {
          const s = button[P_GAMEPAD];
          s.lastFramePressed = false;
          s.lastFrameValue = 0;
        }
      }
      this.primed = true;
      return;
    }
    const session = frame.session;
    const inputSource = this.inputSource;
    for (let i = 0; i < buttons.length; i++) {
      const button = buttons[i];
      if (button) {
        dispatchButtonEdge(session, frame, inputSource, button);
      }
    }
  }

  protected applyTimestamp(frame: XRFrame) {
    this.inputSource.gamepad![P_GAMEPAD].timestamp = frame.predictedDisplayTime;
  }
}

/** A controller driven by host tracking. */
export class XRHostController extends XRHostSource {
  // Axis targets by gamepad index (null for empty slots), resolved once.
  private readonly axisTargets: ({ x: number; y: number } | null)[];
  private readonly axisIsY: boolean[];

  constructor(
    state: XRHostInputState,
    globalSpace: GlobalSpace,
    profiles: string[],
    gamepadConfig: GamepadConfig,
    numHapticActuators: number,
    onPulse: (intensity: number, durationMs: number) => void | Promise<boolean>,
  ) {
    const gamepad = new Gamepad(gamepadConfig, '', -1, numHapticActuators);
    for (const actuator of gamepad.hapticActuators) {
      actuator[P_GAMEPAD].onPulse = onPulse;
    }
    super(
      new XRInputSource(
        state.handedness,
        XRTargetRayMode.TrackedPointer,
        profiles,
        createHostSpace(globalSpace),
        gamepad,
        createHostSpace(globalSpace),
      ),
      state,
    );
    this.axisTargets = gamepadConfig.axes.map((axis) =>
      axis ? gamepad[P_GAMEPAD].axesMap[axis.id] : null,
    );
    this.axisIsY = gamepadConfig.axes.map((axis) => axis?.type === 'y-axis');
  }

  onFrameStart(frame: XRFrame): void {
    const state = this.state;
    const inputSource = this.inputSource;
    writePose(
      inputSource.targetRaySpace,
      state.targetRay,
      0,
      state.targetRayValid,
    );
    writePose(inputSource.gripSpace!, state.grip, 0, state.gripValid);
    this.applyButtons();
    const targets = this.axisTargets;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      if (target) {
        if (this.axisIsY[i]) {
          target.y = state.axes[i];
        } else {
          target.x = state.axes[i];
        }
      }
    }
    this.applyTimestamp(frame);
    this.applyEdges(frame);
  }
}

/** A tracked hand driven by host tracking. */
export class XRHostHand extends XRHostSource {
  private readonly jointSpaces: XRJointSpace[];

  constructor(state: XRHostInputState, globalSpace: GlobalSpace) {
    const hand = new XRHand();
    const jointSpaces: XRJointSpace[] = [];
    for (const jointName of JOINT_NAMES) {
      const jointSpace = new XRJointSpace(jointName, globalSpace);
      jointSpace[P_SPACE].emulated = false;
      jointSpace[P_SPACE].tracked = false;
      hand.set(jointName, jointSpace);
      jointSpaces.push(jointSpace);
    }
    super(
      new XRInputSource(
        state.handedness,
        XRTargetRayMode.TrackedPointer,
        [oculusHandConfig.profileId, ...oculusHandConfig.fallbackProfileIds],
        createHostSpace(globalSpace),
        new Gamepad(hostHandGamepadConfig),
        createHostSpace(globalSpace),
        hand,
      ),
      state,
    );
    this.jointSpaces = jointSpaces;
  }

  onFrameStart(frame: XRFrame): void {
    const state = this.state;
    const inputSource = this.inputSource;
    writePose(
      inputSource.targetRaySpace,
      state.targetRay,
      0,
      state.targetRayValid,
    );
    if (state.gripValid) {
      writePose(inputSource.gripSpace!, state.grip, 0, true);
    } else {
      writePose(inputSource.gripSpace!, state.palm, 0, state.palmValid);
    }
    const { joints, jointValid } = state;
    const jointSpaces = this.jointSpaces;
    for (let j = 0; j < HOST_INPUT_JOINTS; j++) {
      const jointSpace = jointSpaces[j];
      const valid = jointValid[j] !== 0;
      const offset = j * HOST_INPUT_JOINT_STRIDE;
      writePose(jointSpace, joints, offset, valid);
      jointSpace[P_JOINT_SPACE].radius = valid ? joints[offset + 7] : 0;
    }
    this.applyButtons();
    this.applyTimestamp(frame);
    this.applyEdges(frame);
  }
}

const HANDEDNESSES: XRHostHandedness[] = [
  XRHandedness.Left,
  XRHandedness.Right,
];

/**
 * The host's input for a device: one state per hand, and the controller and
 * hand sources it drives. Created by `XRDevice.enableHostInput()`.
 */
export class XRHostInput {
  [P_HOST_INPUT]: {
    device: XRDevice;
    states: Record<XRHostHandedness, XRHostInputState>;
    controllers: Record<XRHostHandedness, XRHostController>;
    hands: Record<XRHostHandedness, XRHostHand>;
    // What each hand lists now (left, right).
    listed: (XRHostSource | null)[];
    // Stable arrays, rewritten in place when the listed sources change.
    activeInputs: XRTrackedInput[];
    inputSources: XRInputSource[];
    // Bumped whenever the listed sources change.
    version: number;
    // The version each session last diffed its input sources against.
    seenVersions: WeakMap<XRSession, number>;
    session: XRSession | null;
    handTracking: boolean;
    sync: (frame: XRFrame) => void;
    unchangedFor: (session: XRSession) => boolean;
    // the session ended: nothing stays listed or connected
    endSession: () => void;
  };

  onHaptic: XRHostHapticCallback | null;

  constructor(device: XRDevice, options: XRHostInputOptions = {}) {
    const globalSpace = device[P_DEVICE].globalSpace;
    const leftMenuButton = options.leftMenuButton ?? true;
    this.onHaptic = options.onHaptic ?? null;
    const states = {
      [XRHandedness.Left]: new XRHostInputState(XRHandedness.Left),
      [XRHandedness.Right]: new XRHostInputState(XRHandedness.Right),
    };
    const makeController = (handedness: XRHostHandedness) => {
      let profiles: string[];
      let gamepadConfig: GamepadConfig;
      let numHapticActuators = 1;
      const config = options.controllerConfig;
      const emulated = device.controllers[handedness];
      if (config?.layout[handedness]) {
        profiles = [config.profileId, ...config.fallbackProfileIds];
        gamepadConfig = config.layout[handedness]!.gamepad;
        numHapticActuators = config.layout[handedness]!.numHapticActuators;
      } else if (emulated) {
        profiles = emulated.inputSource.profiles;
        gamepadConfig = emulated.gamepadConfig;
        numHapticActuators =
          emulated.inputSource.gamepad!.hapticActuators.length;
      } else {
        profiles = [
          oculusTouchV3.profileId,
          ...oculusTouchV3.fallbackProfileIds,
        ];
        gamepadConfig = oculusTouchV3.layout[handedness]!.gamepad;
      }
      return new XRHostController(
        states[handedness],
        globalSpace,
        profiles,
        hostControllerGamepadConfig(
          gamepadConfig,
          leftMenuButton && handedness === XRHandedness.Left,
        ),
        numHapticActuators,
        (intensity, durationMs) =>
          this.onHaptic?.(handedness, intensity, durationMs, 0),
      );
    };
    const internal: XRHostInput[typeof P_HOST_INPUT] = {
      device,
      states,
      controllers: {
        [XRHandedness.Left]: makeController(XRHandedness.Left),
        [XRHandedness.Right]: makeController(XRHandedness.Right),
      },
      hands: {
        [XRHandedness.Left]: new XRHostHand(states.left, globalSpace),
        [XRHandedness.Right]: new XRHostHand(states.right, globalSpace),
      },
      listed: [null, null],
      activeInputs: [],
      inputSources: [],
      version: 0,
      seenVersions: new WeakMap(),
      session: null,
      handTracking: false,
      sync: (frame: XRFrame) => {
        const session = frame.session;
        let reprime = false;
        if (session !== internal.session) {
          internal.session = session;
          internal.handTracking =
            session[P_SESSION].enabledFeatures.includes('hand-tracking');
          reprime = true;
        }
        const visible = device[P_DEVICE].visibilityState === 'visible';
        let changed = false;
        for (let i = 0; i < HANDEDNESSES.length; i++) {
          const handedness = HANDEDNESSES[i];
          const state = internal.states[handedness];
          const mode = state.mode;
          let next: XRHostSource | null = null;
          if (visible) {
            if (mode === XRHostInputMode.Controller) {
              next = internal.controllers[handedness];
            } else if (
              mode === XRHostInputMode.Hand &&
              internal.handTracking &&
              state.jointValid[WRIST_JOINT] !== 0
            ) {
              // A hand without a tracked wrist is not tracked (WebXR Hand
              // Input), so it is not listed, as browsers do. Horizon OS can
              // report a hand it does not see with an aim pose and no joints.
              next = internal.hands[handedness];
            }
          }
          const prev = internal.listed[i];
          if (next !== prev) {
            changed = true;
            if (prev) {
              prev.connected = false;
            }
            if (next) {
              next.connected = true;
              next.primed = false;
            }
            internal.listed[i] = next;
          } else if (reprime && next) {
            next.primed = false;
          }
        }
        if (changed) {
          internal.activeInputs.length = 0;
          internal.inputSources.length = 0;
          for (const source of internal.listed) {
            if (source) {
              internal.activeInputs.push(source);
              internal.inputSources.push(source.inputSource);
            }
          }
          internal.version++;
        }
      },
      unchangedFor: (session: XRSession) => {
        if (internal.seenVersions.get(session) === internal.version) {
          return true;
        }
        internal.seenVersions.set(session, internal.version);
        return false;
      },
      endSession: () => {
        for (let i = 0; i < internal.listed.length; i++) {
          const source = internal.listed[i];
          if (source) {
            source.connected = false;
          }
          internal.listed[i] = null;
        }
        internal.activeInputs.length = 0;
        internal.inputSources.length = 0;
        internal.session = null;
        internal.version++;
      },
    };
    this[P_HOST_INPUT] = internal;
  }

  get left(): XRHostInputState {
    return this[P_HOST_INPUT].states.left;
  }

  get right(): XRHostInputState {
    return this[P_HOST_INPUT].states.right;
  }

  get(handedness: 'left' | 'right'): XRHostInputState {
    return this[P_HOST_INPUT].states[handedness as XRHostHandedness];
  }

  /** The controller source for a hand (listed while its mode is Controller). */
  getController(handedness: 'left' | 'right'): XRHostController {
    return this[P_HOST_INPUT].controllers[handedness as XRHostHandedness];
  }

  /** The hand source for a hand (listed while its mode is Hand). */
  getHand(handedness: 'left' | 'right'): XRHostHand {
    return this[P_HOST_INPUT].hands[handedness as XRHostHandedness];
  }

  /** The sources listed now, in a stable array rewritten when they change. */
  get activeInputs(): readonly XRTrackedInput[] {
    return this[P_HOST_INPUT].activeInputs;
  }
}
