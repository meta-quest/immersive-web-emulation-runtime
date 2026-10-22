/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  Gamepad,
  GamepadConfig,
  GamepadMappingType,
} from '../gamepad/Gamepad.js';
import { GlobalSpace, XRSpace } from '../spaces/XRSpace.js';
import {
  P_GAMEPAD,
  P_HAND_INPUT,
  P_JOINT_SPACE,
  P_SPACE,
  P_TRACKED_INPUT,
} from '../private.js';
import { XRHand, XRHandJoint } from '../input/XRHand.js';
import {
  XRHandedness,
  XRInputSource,
  XRTargetRayMode,
} from '../input/XRInputSource.js';
import { mat4, quat, vec3 } from 'gl-matrix';

import { XRFrame } from '../frameloop/XRFrame.js';
import { XRJointSpace } from '../spaces/XRJointSpace.js';
import { XRTrackedInput } from './XRTrackedInput.js';
import {
  ButtonThresholds,
  writeImmediateValue,
  writePendingValue,
} from '../gamepad/button-edges.js';
import { libraryHandPoses } from './configs/hand/library.js';
import { pinchHandPose } from './configs/hand/pinch.js';
import { pointHandPose } from './configs/hand/point.js';
import { relaxedHandPose } from './configs/hand/relaxed.js';

export interface HandPose {
  jointTransforms: {
    [joint in XRHandJoint]: {
      offsetMatrix: mat4;
      radius: number;
    };
  };
  gripOffsetMatrix?: mat4;
}

/**
 * Pinch levels at which a hand selects and lets go: press at 0.9 (fingertips
 * about 1 cm apart), release at 0.7 (about 3 cm apart), so a pinch that closes
 * gradually selects when the fingertips meet, as hand tracking does.
 */
export const DEFAULT_PINCH_THRESHOLDS: ButtonThresholds = {
  press: 0.9,
  release: 0.7,
};

export interface XRHandInputConfig {
  profileId: string;
  fallbackProfileIds: string[];
  // use left hand pose data and mirror for right hand
  poses: {
    default: HandPose;
    pinch: HandPose;
    // Additional poses can be specified freely with string keys.
    [poseId: string]: HandPose;
  };
  /**
   * Pinch press/release levels, 0 < release < press <= 1; defaults to
   * DEFAULT_PINCH_THRESHOLDS.
   */
  pinchThresholds?: ButtonThresholds;
}

export type XRHandFinger = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

/** Joints of each finger, from the metacarpal out to the tip. */
export const handFingerJoints: Record<XRHandFinger, XRHandJoint[]> = {
  thumb: [
    XRHandJoint.ThumbMetacarpal,
    XRHandJoint.ThumbPhalanxProximal,
    XRHandJoint.ThumbPhalanxDistal,
    XRHandJoint.ThumbTip,
  ],
  index: [
    XRHandJoint.IndexFingerMetacarpal,
    XRHandJoint.IndexFingerPhalanxProximal,
    XRHandJoint.IndexFingerPhalanxIntermediate,
    XRHandJoint.IndexFingerPhalanxDistal,
    XRHandJoint.IndexFingerTip,
  ],
  middle: [
    XRHandJoint.MiddleFingerMetacarpal,
    XRHandJoint.MiddleFingerPhalanxProximal,
    XRHandJoint.MiddleFingerPhalanxIntermediate,
    XRHandJoint.MiddleFingerPhalanxDistal,
    XRHandJoint.MiddleFingerTip,
  ],
  ring: [
    XRHandJoint.RingFingerMetacarpal,
    XRHandJoint.RingFingerPhalanxProximal,
    XRHandJoint.RingFingerPhalanxIntermediate,
    XRHandJoint.RingFingerPhalanxDistal,
    XRHandJoint.RingFingerTip,
  ],
  pinky: [
    XRHandJoint.PinkyFingerMetacarpal,
    XRHandJoint.PinkyFingerPhalanxProximal,
    XRHandJoint.PinkyFingerPhalanxIntermediate,
    XRHandJoint.PinkyFingerPhalanxDistal,
    XRHandJoint.PinkyFingerTip,
  ],
};

const handFingers = Object.keys(handFingerJoints) as XRHandFinger[];
const handJoints = Object.values(XRHandJoint);
const hasOwn = (object: object, key: unknown) =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);

/** One finger taken (partly) from another pose. */
export interface FingerPoseBlend {
  readonly poseId: string;
  /** 0 keeps the base pose's finger, 1 uses the finger from `poseId`. */
  readonly weight: number;
}

export const oculusHandConfig: XRHandInputConfig = {
  profileId: 'oculus-hand',
  fallbackProfileIds: [
    'generic-hand',
    'generic-hand-select',
    'generic-trigger',
  ],
  poses: {
    default: relaxedHandPose,
    pinch: pinchHandPose,
    point: pointHandPose,
    ...libraryHandPoses,
  },
};

/**
 * Hand gamepad buttons other than the pinch, from button 4: the menu gesture
 * (a palm-up pinch), then the microgestures (thumb swipes and tap).
 */
const HAND_GESTURE_BUTTONS = [
  'menu',
  'swipe-left',
  'swipe-right',
  'swipe-forward',
  'swipe-backward',
  'tap',
] as const;
export type HandGestureButton = (typeof HAND_GESTURE_BUTTONS)[number];

/**
 * The hand gamepad as Quest Browser reports it: the pinch on button 0 (the
 * only one that fires events), buttons 1 to 3 empty, then the gesture
 * buttons on 4 to 9.
 */
const XRHandGamepadConfig: GamepadConfig = {
  mapping: GamepadMappingType.XRStandard,
  buttons: [
    { id: 'pinch', type: 'analog', eventTrigger: 'select' },
    null,
    null,
    null,
    ...HAND_GESTURE_BUTTONS.map((id) => ({ id, type: 'binary' as const })),
  ],
  axes: [],
};

/**
 * A thumb movement shown on top of the hand's pose (microgestures): the
 * thumb is `weight` of the way from its place in `from` to its place in
 * `to`, each relative to the palm.
 */
export interface ThumbMotion {
  from: HandPose;
  to: HandPose;
  weight: number;
}

const fromPosition = vec3.create();
const fromQuaternion = quat.create();
const fromScale = vec3.create();
const toPosition = vec3.create();
const toQuaternion = quat.create();
const toScale = vec3.create();
const interpolatedPosition = vec3.create();
const interpolatedQuaternion = quat.create();
const interpolatedScale = vec3.create();
const interpolateMatrix = (
  out: mat4,
  fromMatrix: mat4,
  toMatrix: mat4,
  alpha: number,
) => {
  mat4.getTranslation(fromPosition, fromMatrix);
  mat4.getRotation(fromQuaternion, fromMatrix);
  mat4.getScaling(fromScale, fromMatrix);
  mat4.getTranslation(toPosition, toMatrix);
  mat4.getRotation(toQuaternion, toMatrix);
  mat4.getScaling(toScale, toMatrix);
  vec3.lerp(interpolatedPosition, fromPosition, toPosition, alpha);
  quat.slerp(interpolatedQuaternion, fromQuaternion, toQuaternion, alpha);
  vec3.lerp(interpolatedScale, fromScale, toScale, alpha);
  mat4.fromRotationTranslationScale(
    out,
    interpolatedQuaternion,
    interpolatedPosition,
    interpolatedScale,
  );
  return out;
};

const parentMatrix = mat4.create();
const baseLocal = mat4.create();
const blendLocal = mat4.create();
const blendedLocal = mat4.create();
const fromBone = vec3.create();
const toBone = vec3.create();
const boneRotation = quat.create();
const noRotation = quat.create();
// Sets `out`'s translation (a joint's bone in its parent frame) by turning the
// `from` bone toward the `to` bone along the shortest arc and blending the
// lengths. Unlike a lerp, this never shortens the bone, even when the two
// bones point in opposite directions.
const interpolateBone = (out: mat4, from: mat4, to: mat4, alpha: number) => {
  mat4.getTranslation(fromBone, from);
  mat4.getTranslation(toBone, to);
  const fromLength = vec3.length(fromBone);
  const toLength = vec3.length(toBone);
  if (fromLength < 1e-9 || toLength < 1e-9) return;
  vec3.scale(fromBone, fromBone, 1 / fromLength);
  vec3.scale(toBone, toBone, 1 / toLength);
  quat.rotationTo(boneRotation, fromBone, toBone);
  quat.slerp(boneRotation, noRotation, boneRotation, alpha);
  vec3.transformQuat(fromBone, fromBone, boneRotation);
  vec3.scale(fromBone, fromBone, (1 - alpha) * fromLength + alpha * toLength);
  out[12] = fromBone[0];
  out[13] = fromBone[1];
  out[14] = fromBone[2];
};

const mirrorMultiplierMatrix = [
  1, -1, -1, 0, -1, 1, 1, 0, -1, 1, 1, 0, -1, 1, 1, 1,
];
const mirrorMatrixToRight = (matrixLeft: mat4) => {
  for (let i = 0; i < 16; i++) {
    matrixLeft[i] *= mirrorMultiplierMatrix[i];
  }
};

const createPose = (): HandPose => {
  const pose = {
    jointTransforms: {},
    gripOffsetMatrix: mat4.create(),
  } as HandPose;
  for (const jointName of Object.values(XRHandJoint)) {
    pose.jointTransforms[jointName] = {
      offsetMatrix: mat4.create(),
      radius: 0,
    };
  }
  return pose;
};

const copyPose = (out: HandPose, source: HandPose) => {
  for (const jointName of Object.values(XRHandJoint)) {
    mat4.copy(
      out.jointTransforms[jointName].offsetMatrix,
      source.jointTransforms[jointName].offsetMatrix,
    );
    out.jointTransforms[jointName].radius =
      source.jointTransforms[jointName].radius;
  }
  if (source.gripOffsetMatrix) {
    mat4.copy(out.gripOffsetMatrix!, source.gripOffsetMatrix);
  }
};

const lerp = (a: number, b: number, t: number) => (1 - t) * a + t * b;

/**
 * Blends one finger chain of `out` toward `other`, joint by joint relative to
 * each joint's parent, chaining from the wrist already in `out`, so the finger
 * stays attached to `out`'s palm. Each bone turns along the shortest arc and
 * keeps a length between its two poses' lengths. `out` must not be `base`.
 */
const blendChain = (
  out: HandPose,
  base: HandPose,
  other: HandPose,
  chain: XRHandJoint[],
  weight: number,
) => {
  let parent = XRHandJoint.Wrist;
  for (const jointName of chain) {
    mat4.invert(parentMatrix, base.jointTransforms[parent].offsetMatrix);
    mat4.multiply(
      baseLocal,
      parentMatrix,
      base.jointTransforms[jointName].offsetMatrix,
    );
    mat4.invert(parentMatrix, other.jointTransforms[parent].offsetMatrix);
    mat4.multiply(
      blendLocal,
      parentMatrix,
      other.jointTransforms[jointName].offsetMatrix,
    );
    interpolateMatrix(blendedLocal, baseLocal, blendLocal, weight);
    // The two poses can express the bone in differently oriented parent
    // frames (e.g. two captured skeletons), where a lerp shortens it.
    interpolateBone(blendedLocal, baseLocal, blendLocal, weight);
    mat4.multiply(
      out.jointTransforms[jointName].offsetMatrix,
      out.jointTransforms[parent].offsetMatrix,
      blendedLocal,
    );
    out.jointTransforms[jointName].radius = lerp(
      base.jointTransforms[jointName].radius,
      other.jointTransforms[jointName].radius,
      weight,
    );
    parent = jointName;
  }
};

/** Blends a whole hand from `a` toward `b`: the wrist, then every finger. */
const blendHand = (out: HandPose, a: HandPose, b: HandPose, weight: number) => {
  interpolateMatrix(
    out.jointTransforms[XRHandJoint.Wrist].offsetMatrix,
    a.jointTransforms[XRHandJoint.Wrist].offsetMatrix,
    b.jointTransforms[XRHandJoint.Wrist].offsetMatrix,
    weight,
  );
  out.jointTransforms[XRHandJoint.Wrist].radius = lerp(
    a.jointTransforms[XRHandJoint.Wrist].radius,
    b.jointTransforms[XRHandJoint.Wrist].radius,
    weight,
  );
  for (const finger of handFingers) {
    blendChain(out, a, b, handFingerJoints[finger], weight);
  }
  if (a.gripOffsetMatrix && b.gripOffsetMatrix) {
    interpolateMatrix(
      out.gripOffsetMatrix!,
      a.gripOffsetMatrix,
      b.gripOffsetMatrix,
      weight,
    );
  }
};

/** Fingers the pinch moves; the rest of the hand keeps its pose. */
const PINCH_FINGERS: XRHandFinger[] = ['thumb', 'index'];

/**
 * Points a hand can be placed by. `grasp` is where the thumb and index tips
 * meet when the hand fully pinches; any WebXR joint name also works.
 */
export type HandAnchor =
  | 'target-ray'
  | 'wrist'
  | 'grip'
  | 'grasp'
  | 'index-tip'
  | 'thumb-tip'
  | XRHandJoint;

const ANCHOR_JOINTS: Record<string, XRHandJoint> = {
  wrist: XRHandJoint.Wrist,
  'index-tip': XRHandJoint.IndexFingerTip,
  'thumb-tip': XRHandJoint.ThumbTip,
};

export const isHandAnchor = (value: unknown): value is HandAnchor =>
  typeof value === 'string' &&
  (value === 'target-ray' ||
    value === 'grip' ||
    value === 'grasp' ||
    hasOwn(ANCHOR_JOINTS, value) ||
    (handJoints as string[]).includes(value));

/**
 * A hand orientation by direction: where the fingers point (wrist -Z), and
 * either the way the palm faces (wrist -Y) or the thumb side of the hand.
 * `fingers` is kept exact; the second direction is made perpendicular to it.
 */
export interface HandDirections {
  fingers: vec3;
  palm?: vec3;
  thumb?: vec3;
}

/**
 * Where a hand is held by remote control: `anchor` stays at `target` (in
 * GlobalSpace) and, when given, the wrist keeps `wristRotation` (GlobalSpace),
 * however the hand's shape changes.
 */
export interface HandPin {
  anchor: HandAnchor;
  target: vec3;
  wristRotation?: quat;
  /** For a `grasp` anchor: the pinch the grasp point is taken at (default 1). */
  graspPinch?: number;
}

/**
 * The wrist rotation (GlobalSpace) that points a hand's fingers along
 * `fingers` with its palm facing `palm`, or its thumb side toward `thumb`.
 * The wrist frame follows WebXR: -Z along the fingers, +Y out of the back of
 * the hand. Returns null when the two directions are parallel.
 */
export const wristRotationFromDirections = (
  directions: HandDirections,
  handedness: XRHandedness,
  out: quat = quat.create(),
): quat | null => {
  const z = vec3.normalize(
    vec3.create(),
    vec3.negate(vec3.create(), directions.fingers),
  );
  const y = vec3.create();
  if (directions.palm) {
    vec3.negate(y, directions.palm);
  } else if (directions.thumb) {
    // The thumb side is palm x fingers on a left hand and fingers x palm on a
    // right hand (mirror images); y (back of the hand) = -palm.
    vec3.cross(y, directions.thumb, directions.fingers);
    if (handedness === XRHandedness.Right) {
      vec3.negate(y, y);
    }
  } else {
    return null;
  }
  vec3.scaleAndAdd(y, y, z, -vec3.dot(y, z));
  if (vec3.length(y) < 1e-6) {
    return null;
  }
  vec3.normalize(y, y);
  const x = vec3.cross(vec3.create(), y, z);
  const m = mat4.fromValues(
    x[0],
    x[1],
    x[2],
    0,
    y[0],
    y[1],
    y[2],
    0,
    z[0],
    z[1],
    z[2],
    0,
    0,
    0,
    0,
    1,
  );
  return quat.normalize(out, mat4.getRotation(out, m));
};

const anchorScratch = vec3.create();
// The second point of a two-point anchor (never `anchorOffset`'s output).
const anchorPartScratch = vec3.create();
const pinchedScratch = createPose();
const thumbScratch = createPose();
const wristLocalScratch = quat.create();
const desiredRotation = quat.create();
const radialScratch = vec3.create();

export class XRHandInput extends XRTrackedInput {
  [P_HAND_INPUT]: {
    poseId: string;
    poses: {
      default: HandPose;
      pinch: HandPose;
      // Additional poses can be specified freely with string keys.
      [poseId: string]: HandPose;
    };
    fingerPoses: Partial<Record<XRHandFinger, FingerPoseBlend>>;
    // The base pose with finger blends applied, rebuilt only when `poseId` or
    // the blends change (`blendedPoseStale`) instead of every frame.
    blendedPose: HandPose;
    blendedPoseStale: boolean;
    fingersBlended: boolean;
    // A timed change of pose: the hand fades from `transitionFrom` (what was
    // displayed when the change began, last set to `transitionFromId`) to the
    // new pose as `transitionProgress` goes from 0 to 1; null when no change
    // is in flight.
    transitionFrom: HandPose;
    transitionFromId: string;
    transitionProgress: number | null;
    // The hand before pinch: pose, finger blends and any transition.
    displayedPose: HandPose;
    // A thumb movement shown on top of the displayed pose, or null.
    thumbMotion: ThumbMotion | null;
    pin: HandPin | null;
  };

  constructor(
    handInputConfig: XRHandInputConfig,
    handedness: XRHandedness,
    globalSpace: GlobalSpace,
  ) {
    if (handedness !== XRHandedness.Left && handedness !== XRHandedness.Right) {
      throw new DOMException(
        'handedness for XRHandInput must be either "left" or "right"',
        'InvalidStateError',
      );
    }
    if (!handInputConfig.poses.default || !handInputConfig.poses.pinch) {
      throw new DOMException(
        '"default" and "pinch" hand pose configs are required',
        'InvalidStateError',
      );
    }
    const pinchThresholds =
      handInputConfig.pinchThresholds ?? DEFAULT_PINCH_THRESHOLDS;
    if (
      !(
        pinchThresholds.release > 0 &&
        pinchThresholds.release < pinchThresholds.press &&
        pinchThresholds.press <= 1
      )
    ) {
      throw new DOMException(
        'pinchThresholds need 0 < release < press <= 1',
        'InvalidStateError',
      );
    }

    const targetRaySpace = new XRSpace(globalSpace);
    const gripSpace = new XRSpace(targetRaySpace);
    const profiles = [
      handInputConfig.profileId,
      ...handInputConfig.fallbackProfileIds,
    ];
    const hand = new XRHand();
    Object.values(XRHandJoint).forEach((jointName) => {
      hand.set(jointName, new XRJointSpace(jointName, targetRaySpace));
    });
    const inputSource = new XRInputSource(
      handedness,
      XRTargetRayMode.TrackedPointer,
      profiles,
      targetRaySpace,
      new Gamepad(XRHandGamepadConfig),
      gripSpace,
      hand,
    );

    super(inputSource);
    const pinchButton = inputSource.gamepad![P_GAMEPAD].buttonsMap.pinch!;
    pinchButton[P_GAMEPAD].thresholds = { ...pinchThresholds };
    const blendedPose = createPose();
    this[P_HAND_INPUT] = {
      poseId: 'default',
      poses: handInputConfig.poses,
      fingerPoses: {},
      blendedPose,
      blendedPoseStale: false,
      fingersBlended: false,
      transitionFrom: createPose(),
      transitionFromId: 'default',
      transitionProgress: null,
      displayedPose: createPose(),
      thumbMotion: null,
      pin: null,
    };

    this.updateHandPose();
  }

  get poseId() {
    return this[P_HAND_INPUT].poseId;
  }

  /**
   * Sets the whole hand to a pose and clears any finger blends. A pose change
   * in progress (beginPoseTransition) stops and the hand snaps to the pose.
   */
  set poseId(poseId: string) {
    if (!hasOwn(this[P_HAND_INPUT].poses, poseId)) {
      console.warn(`Pose config ${poseId} not found`);
      return;
    }
    this[P_HAND_INPUT].poseId = poseId;
    this[P_HAND_INPUT].fingerPoses = {};
    this[P_HAND_INPUT].blendedPoseStale = true;
    this[P_HAND_INPUT].transitionProgress = null;
  }

  /** Ids of every pose this hand can take. */
  get poseIds(): string[] {
    return Object.keys(this[P_HAND_INPUT].poses);
  }

  /** Fingers currently taken from other poses, on top of `poseId` (a copy). */
  get fingerPoses(): Partial<Record<XRHandFinger, FingerPoseBlend>> {
    const fingerPoses: Partial<Record<XRHandFinger, FingerPoseBlend>> = {};
    for (const finger of handFingers) {
      const blend = this[P_HAND_INPUT].fingerPoses[finger];
      if (blend) fingerPoses[finger] = { ...blend };
    }
    return fingerPoses;
  }

  /**
   * Takes one finger from another pose while the rest of the hand keeps
   * `poseId`, e.g. curl the middle, ring and pinky of `open` from `fist`.
   * `weight` blends between the base pose's finger (0) and `poseId`'s (1).
   * Each joint blends relative to its parent joint and keeps a bone length
   * between the two poses' lengths. The 21 generated poses are built on the
   * captured relaxed skeleton, so between them each finger's bones keep
   * exactly the same lengths.
   */
  setFingerPose(finger: XRHandFinger, poseId: string, weight = 1) {
    if (!hasOwn(handFingerJoints, finger)) {
      console.warn(`Unknown finger ${finger}`);
      return;
    }
    if (!hasOwn(this[P_HAND_INPUT].poses, poseId)) {
      console.warn(`Pose config ${poseId} not found`);
      return;
    }
    if (typeof weight !== 'number' || !(weight >= 0 && weight <= 1)) {
      console.warn(`Out-of-range weight ${weight} provided for ${finger}`);
      return;
    }
    this[P_HAND_INPUT].fingerPoses[finger] = { poseId, weight };
    this[P_HAND_INPUT].blendedPoseStale = true;
  }

  /** Clears the blend for one finger, or for every finger if omitted. */
  clearFingerPoses(finger?: XRHandFinger) {
    if (finger === undefined) {
      this[P_HAND_INPUT].fingerPoses = {};
    } else if (hasOwn(handFingerJoints, finger)) {
      delete this[P_HAND_INPUT].fingerPoses[finger];
    } else {
      console.warn(`Unknown finger ${finger}`);
      return;
    }
    this[P_HAND_INPUT].blendedPoseStale = true;
  }

  /** Rebuilds `blendedPose`; returns false when no finger is blended. */
  private blendFingers(basePose: HandPose): boolean {
    const { poses, fingerPoses, blendedPose } = this[P_HAND_INPUT];
    if (!handFingers.some((finger) => fingerPoses[finger])) {
      return false;
    }
    copyPose(blendedPose, basePose);
    for (const finger of handFingers) {
      const blend = fingerPoses[finger];
      if (blend) {
        blendChain(
          blendedPose,
          basePose,
          poses[blend.poseId],
          handFingerJoints[finger],
          blend.weight,
        );
      }
    }
    return true;
  }

  /**
   * Starts a timed change to `poseId` (and finger blends): the hand fades
   * from what it shows now (before pinch, mid-fade included) as
   * `poseTransitionProgress` goes from 0 to 1. `poseId` and `fingerPoses`
   * report the new pose right away.
   */
  beginPoseTransition(
    poseId: string,
    fingers: Partial<Record<XRHandFinger, FingerPoseBlend>> = {},
  ): boolean {
    const state = this[P_HAND_INPUT];
    if (!hasOwn(state.poses, poseId)) {
      console.warn(`Pose config ${poseId} not found`);
      return false;
    }
    // Start from the hand as it shows now, including changes made since the
    // last frame.
    this.updateDisplayedPose();
    copyPose(state.transitionFrom, state.displayedPose);
    state.transitionFromId = state.poseId;
    state.poseId = poseId;
    state.fingerPoses = {};
    for (const finger of handFingers) {
      const blend = fingers[finger];
      if (blend) state.fingerPoses[finger] = { ...blend };
    }
    state.blendedPoseStale = true;
    state.transitionProgress = 0;
    return true;
  }

  /** Progress (0 to 1) of the pose change begun by beginPoseTransition, or null. */
  get poseTransitionProgress(): number | null {
    return this[P_HAND_INPUT].transitionProgress;
  }

  set poseTransitionProgress(progress: number | null) {
    this[P_HAND_INPUT].transitionProgress =
      progress === null || progress >= 1 ? null : Math.max(0, progress);
  }

  /**
   * The pose a change in progress fades from (the pose set before it), or
   * null when no change is in progress.
   */
  get poseTransitionFrom(): string | null {
    const state = this[P_HAND_INPUT];
    return state.transitionProgress === null ? null : state.transitionFromId;
  }

  /** Where remote control holds this hand, or null. */
  get pin(): HandPin | null {
    return this[P_HAND_INPUT].pin;
  }

  /**
   * Holds `anchor` at `target` (GlobalSpace) from now on, re-solved every frame
   * after the hand's shape updates, optionally with a fixed wrist rotation.
   * Applies right away, to the hand's current shape. Pass null to let go.
   */
  setPin(pin: HandPin | null) {
    this[P_HAND_INPUT].pin = pin
      ? {
          anchor: pin.anchor,
          target: vec3.clone(pin.target),
          wristRotation: pin.wristRotation && quat.clone(pin.wristRotation),
          graspPinch: pin.graspPinch,
        }
      : null;
    // Refreshes the joints (a pose set earlier in this frame included) and
    // solves the pin against them.
    this.updateHandPose();
  }

  /** The wrist's rotation in GlobalSpace for the hand as shown now. */
  wristRotation(out: quat = quat.create()): quat {
    mat4.getRotation(
      out,
      this.inputSource.hand!.get(XRHandJoint.Wrist)![P_SPACE].offsetMatrix,
    );
    quat.multiply(out, this.quaternion.quat, out);
    return quat.normalize(out, out);
  }

  /**
   * An anchor's position in the target-ray frame for the hand as shown now
   * (pinch included); `grasp` is fixed for the current pose.
   */
  anchorOffset(
    anchor: HandAnchor,
    out: vec3 = vec3.create(),
    graspPinch = 1,
  ): vec3 {
    if (anchor === 'target-ray') {
      return vec3.set(out, 0, 0, 0);
    }
    if (anchor === 'grip') {
      return mat4.getTranslation(
        out,
        this.inputSource.gripSpace![P_SPACE].offsetMatrix,
      );
    }
    if (anchor === 'grasp') {
      // Midway between the thumb and index tips of the displayed pose
      // pinched to `graspPinch` (where they meet at a full pinch).
      const state = this[P_HAND_INPUT];
      copyPose(pinchedScratch, state.displayedPose);
      for (const finger of PINCH_FINGERS) {
        blendChain(
          pinchedScratch,
          state.displayedPose,
          state.poses.pinch,
          handFingerJoints[finger],
          graspPinch,
        );
      }
      mat4.getTranslation(
        out,
        pinchedScratch.jointTransforms[XRHandJoint.ThumbTip].offsetMatrix,
      );
      mat4.getTranslation(
        anchorPartScratch,
        pinchedScratch.jointTransforms[XRHandJoint.IndexFingerTip].offsetMatrix,
      );
      vec3.lerp(out, out, anchorPartScratch, 0.5);
      if (this.inputSource.handedness === XRHandedness.Right) {
        out[0] = -out[0];
      }
      return out;
    }
    const jointName = ANCHOR_JOINTS[anchor] ?? (anchor as XRHandJoint);
    return mat4.getTranslation(
      out,
      this.inputSource.hand!.get(jointName)![P_SPACE].offsetMatrix,
    );
  }

  /**
   * The hand's axes in the target-ray frame, from the displayed wrist:
   * fingers (wrist -Z), palm (wrist -Y) and the thumb side. Mirror-safe.
   */
  handAxes(): { fingers: vec3; palm: vec3; thumb: vec3 } {
    const wrist = this.inputSource.hand!.get(XRHandJoint.Wrist)![P_SPACE]
      .offsetMatrix;
    const fingers = vec3.fromValues(-wrist[8], -wrist[9], -wrist[10]);
    const palm = vec3.fromValues(-wrist[4], -wrist[5], -wrist[6]);
    const thumb = vec3.cross(vec3.create(), palm, fingers);
    // Point `thumb` to the thumb side: from the little finger toward the index.
    const index = this.inputSource.hand!.get(
      XRHandJoint.IndexFingerMetacarpal,
    )![P_SPACE].offsetMatrix;
    const pinky = this.inputSource.hand!.get(
      XRHandJoint.PinkyFingerMetacarpal,
    )![P_SPACE].offsetMatrix;
    vec3.set(
      radialScratch,
      index[12] - pinky[12],
      index[13] - pinky[13],
      index[14] - pinky[14],
    );
    if (vec3.dot(thumb, radialScratch) < 0) {
      vec3.negate(thumb, thumb);
    }
    return { fingers, palm, thumb: vec3.normalize(thumb, thumb) };
  }

  /** Re-applies the pin, if any, to the target-ray pose. */
  private solvePin() {
    const pin = this[P_HAND_INPUT].pin;
    if (!pin) {
      return;
    }
    if (pin.wristRotation) {
      // ray rotation = wanted wrist rotation * (wrist in the ray frame)^-1
      mat4.getRotation(
        wristLocalScratch,
        this.inputSource.hand!.get(XRHandJoint.Wrist)![P_SPACE].offsetMatrix,
      );
      quat.invert(wristLocalScratch, wristLocalScratch);
      quat.multiply(desiredRotation, pin.wristRotation, wristLocalScratch);
      quat.normalize(desiredRotation, desiredRotation);
      this.quaternion.set(
        desiredRotation[0],
        desiredRotation[1],
        desiredRotation[2],
        desiredRotation[3],
      );
    }
    this.anchorOffset(pin.anchor, anchorScratch, pin.graspPinch);
    vec3.transformQuat(anchorScratch, anchorScratch, this.quaternion.quat);
    this.position.set(
      pin.target[0] - anchorScratch[0],
      pin.target[1] - anchorScratch[1],
      pin.target[2] - anchorScratch[2],
    );
    this.updateTargetRaySpace();
  }

  /** Rebuilds `displayedPose`: the pose, finger blends and any pose change. */
  private updateDisplayedPose() {
    const state = this[P_HAND_INPUT];
    const basePose = state.poses[state.poseId];
    if (state.blendedPoseStale) {
      state.fingersBlended = this.blendFingers(basePose);
      state.blendedPoseStale = false;
    }
    const targetPose = state.fingersBlended ? state.blendedPose : basePose;
    if (state.transitionProgress !== null) {
      blendHand(
        state.displayedPose,
        state.transitionFrom,
        targetPose,
        state.transitionProgress,
      );
    } else {
      copyPose(state.displayedPose, targetPose);
    }
  }

  /**
   * Updates the joints and grip from the pose, finger blends, any pose change,
   * any thumb movement and the pinch, then re-solves the pin. Runs every
   * frame.
   */
  updateHandPose() {
    const state = this[P_HAND_INPUT];
    const basePose = state.poses[state.poseId];
    this.updateDisplayedPose();
    const displayed = state.displayedPose;
    let shown = displayed;
    // A thumb movement moves only the thumb, relative to the displayed palm;
    // anchors (grasp included) keep the displayed pose, so a pinned hand stays
    // where it is.
    const motion = state.thumbMotion;
    if (motion) {
      copyPose(thumbScratch, displayed);
      blendChain(
        thumbScratch,
        motion.from,
        motion.to,
        handFingerJoints.thumb,
        motion.weight,
      );
      shown = thumbScratch;
    }
    // Pinch closes the thumb and index onto each other, relative to the
    // displayed palm; the rest of the hand and the grip keep their pose.
    const pinchValue = this.pinchValue;
    if (pinchValue > 0) {
      copyPose(pinchedScratch, shown);
      for (const finger of PINCH_FINGERS) {
        blendChain(
          pinchedScratch,
          shown,
          state.poses.pinch,
          handFingerJoints[finger],
          pinchValue,
        );
      }
      shown = pinchedScratch;
    }
    const right = this.inputSource.handedness === XRHandedness.Right;
    for (const jointName of handJoints) {
      const jointSpace = this.inputSource.hand!.get(jointName)!;
      mat4.copy(
        jointSpace[P_SPACE].offsetMatrix,
        shown.jointTransforms[jointName].offsetMatrix,
      );
      if (right) {
        mirrorMatrixToRight(jointSpace[P_SPACE].offsetMatrix);
      }
      jointSpace[P_JOINT_SPACE].radius =
        shown.jointTransforms[jointName].radius;
    }
    if (basePose.gripOffsetMatrix) {
      mat4.copy(
        this.inputSource.gripSpace![P_SPACE].offsetMatrix,
        displayed.gripOffsetMatrix!,
      );
      if (right) {
        mirrorMatrixToRight(this.inputSource.gripSpace![P_SPACE].offsetMatrix);
      }
    }
    this.solvePin();
  }

  get pinchValue() {
    return this[P_TRACKED_INPUT].inputSource.gamepad![P_GAMEPAD].buttonsMap[
      'pinch'
    ]!.value;
  }

  updatePinchValue(value: number) {
    if (!(value >= 0 && value <= 1)) {
      console.warn(`Out-of-range value ${value} provided for pinch`);
      return;
    }
    writePendingValue(
      this[P_TRACKED_INPUT].inputSource.gamepad![P_GAMEPAD].buttonsMap.pinch!,
      value,
    );
  }

  /**
   * Set pinch synchronously. Releasing a held pinch this way cancels the
   * select (`selectend` without `select`), for interaction cancellation.
   */
  setPinchValueImmediate(value: number) {
    if (!(value >= 0 && value <= 1)) {
      console.warn(`Out-of-range value ${value} provided for pinch`);
      return;
    }
    writeImmediateValue(
      this[P_TRACKED_INPUT].inputSource.gamepad![P_GAMEPAD].buttonsMap.pinch!,
      value,
    );
  }

  /**
   * The thumb movement shown on top of the pose (microgestures), or null.
   * Applies from the next pose update (every frame).
   */
  get thumbMotion(): ThumbMotion | null {
    return this[P_HAND_INPUT].thumbMotion;
  }

  set thumbMotion(motion: ThumbMotion | null) {
    this[P_HAND_INPUT].thumbMotion = motion;
  }

  /**
   * Writes a gesture button (menu, or a microgesture) for the next frame:
   * 1 pressed, 0 released. These buttons fire no session events; apps read
   * them from the hand's gamepad.
   */
  updateGestureButton(id: HandGestureButton, value: 0 | 1) {
    if (!HAND_GESTURE_BUTTONS.includes(id) || (value !== 0 && value !== 1)) {
      console.warn(`Invalid value ${value} provided for gesture button ${id}`);
      return;
    }
    writePendingValue(
      this[P_TRACKED_INPUT].inputSource.gamepad![P_GAMEPAD].buttonsMap[id]!,
      value,
    );
  }

  onFrameStart(frame: XRFrame): void {
    super.onFrameStart(frame);
    this.updateHandPose();
  }
}
