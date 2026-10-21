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

const XRHandGamepadConfig: GamepadConfig = {
  mapping: GamepadMappingType.None,
  buttons: [{ id: 'pinch', type: 'analog', eventTrigger: 'select' }],
  axes: [],
};

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
    const blendedPose = { jointTransforms: {} } as HandPose;
    handJoints.forEach((jointName) => {
      blendedPose.jointTransforms[jointName] = {
        offsetMatrix: mat4.create(),
        radius: 0,
      };
    });
    this[P_HAND_INPUT] = {
      poseId: 'default',
      poses: handInputConfig.poses,
      fingerPoses: {},
      blendedPose,
      blendedPoseStale: false,
      fingersBlended: false,
    };

    this.updateHandPose();
  }

  get poseId() {
    return this[P_HAND_INPUT].poseId;
  }

  /** Sets the whole hand to a pose and clears any finger blends. */
  set poseId(poseId: string) {
    if (!hasOwn(this[P_HAND_INPUT].poses, poseId)) {
      console.warn(`Pose config ${poseId} not found`);
      return;
    }
    this[P_HAND_INPUT].poseId = poseId;
    this[P_HAND_INPUT].fingerPoses = {};
    this[P_HAND_INPUT].blendedPoseStale = true;
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
   * between the two poses' lengths. The 20 generated poses are built on the
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
    for (const jointName of handJoints) {
      const target = blendedPose.jointTransforms[jointName];
      mat4.copy(
        target.offsetMatrix,
        basePose.jointTransforms[jointName].offsetMatrix,
      );
      target.radius = basePose.jointTransforms[jointName].radius;
    }
    for (const finger of handFingers) {
      const blend = fingerPoses[finger];
      if (!blend) continue;
      const blendPose = poses[blend.poseId];
      const { weight } = blend;
      let parent = XRHandJoint.Wrist;
      for (const jointName of handFingerJoints[finger]) {
        // Blend each joint relative to its parent, then chain from the base
        // pose's wrist so the finger stays attached to the base palm.
        mat4.invert(
          parentMatrix,
          basePose.jointTransforms[parent].offsetMatrix,
        );
        mat4.multiply(
          baseLocal,
          parentMatrix,
          basePose.jointTransforms[jointName].offsetMatrix,
        );
        mat4.invert(
          parentMatrix,
          blendPose.jointTransforms[parent].offsetMatrix,
        );
        mat4.multiply(
          blendLocal,
          parentMatrix,
          blendPose.jointTransforms[jointName].offsetMatrix,
        );
        interpolateMatrix(blendedLocal, baseLocal, blendLocal, weight);
        // The two poses can express the bone in differently oriented parent
        // frames (e.g. two captured skeletons), where a lerp shortens it.
        interpolateBone(blendedLocal, baseLocal, blendLocal, weight);
        const target = blendedPose.jointTransforms[jointName];
        mat4.multiply(
          target.offsetMatrix,
          blendedPose.jointTransforms[parent].offsetMatrix,
          blendedLocal,
        );
        target.radius =
          (1 - weight) * basePose.jointTransforms[jointName].radius +
          weight * blendPose.jointTransforms[jointName].radius;
        parent = jointName;
      }
    }
    blendedPose.gripOffsetMatrix = basePose.gripOffsetMatrix;
    return true;
  }

  updateHandPose() {
    const state = this[P_HAND_INPUT];
    const basePose = state.poses[state.poseId];
    if (state.blendedPoseStale) {
      state.fingersBlended = this.blendFingers(basePose);
      state.blendedPoseStale = false;
    }
    const targetPose = state.fingersBlended ? state.blendedPose : basePose;
    const pinchPose = state.poses.pinch;
    for (const jointName of handJoints) {
      const targetJointMatrix =
        targetPose.jointTransforms[jointName].offsetMatrix;
      const pinchJointMatrix =
        pinchPose.jointTransforms[jointName].offsetMatrix;
      const jointSpace = this.inputSource.hand!.get(jointName)!;
      interpolateMatrix(
        jointSpace[P_SPACE].offsetMatrix,
        targetJointMatrix,
        pinchJointMatrix,
        this.pinchValue,
      );
      if (this.inputSource.handedness === XRHandedness.Right) {
        mirrorMatrixToRight(jointSpace[P_SPACE].offsetMatrix);
      }
      jointSpace[P_JOINT_SPACE].radius =
        (1 - this.pinchValue) * targetPose.jointTransforms[jointName].radius +
        this.pinchValue * pinchPose.jointTransforms[jointName].radius;
    }
    if (targetPose.gripOffsetMatrix && pinchPose.gripOffsetMatrix) {
      interpolateMatrix(
        this.inputSource.gripSpace![P_SPACE].offsetMatrix,
        targetPose.gripOffsetMatrix!,
        pinchPose.gripOffsetMatrix!,
        this.pinchValue,
      );
    }
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

  onFrameStart(frame: XRFrame): void {
    super.onFrameStart(frame);
    this.updateHandPose();
  }
}
