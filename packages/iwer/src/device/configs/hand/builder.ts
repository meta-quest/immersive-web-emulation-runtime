/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

import type { HandPose } from '../../XRHandInput.js';
import { XRHandJoint } from '../../../input/XRHand.js';

/**
 * Joint angles for one finger, in degrees. Flexion is positive toward the
 * palm; `yaw` is the side-to-side angle at the knuckle (negative toward the
 * thumb); `roll` twists the finger about its own axis. Omitted values keep the
 * skeleton's rest value.
 */
export interface FingerAngles {
  mcp?: number;
  pip?: number;
  dip?: number;
  yaw?: number;
  roll?: number;
  pipYaw?: number;
  pipRoll?: number;
}

/**
 * Thumb angles, in degrees. `cmc` is the thumb metacarpal's [yaw, pitch, roll]
 * relative to the wrist: negative yaw swings the thumb away from the index,
 * negative pitch moves it toward the palm side, and negative roll turns the
 * thumb pad toward the fingers. `shift` (0 to 1) moves the thumb base toward
 * its position in the opposed (pinch) skeleton.
 */
export interface ThumbAngles {
  cmc?: [number, number, number];
  shift?: number;
  mcp?: number;
  ip?: number;
  mcpYaw?: number;
  mcpRoll?: number;
  ipYaw?: number;
  ipRoll?: number;
}

export interface HandPoseAngles {
  thumb?: ThumbAngles;
  index?: FingerAngles;
  middle?: FingerAngles;
  ring?: FingerAngles;
  pinky?: FingerAngles;
}

type LongFinger = 'index' | 'middle' | 'ring' | 'pinky';

const LONG_FINGER_CHAINS: Record<LongFinger, XRHandJoint[]> = {
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

const THUMB_CHAIN = [
  XRHandJoint.ThumbMetacarpal,
  XRHandJoint.ThumbPhalanxProximal,
  XRHandJoint.ThumbPhalanxDistal,
  XRHandJoint.ThumbTip,
];

interface LocalTransform {
  translation: vec3;
  rotation: quat;
  yaw: number;
  pitch: number;
  roll: number;
}

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

const parentOf = (joint: XRHandJoint): XRHandJoint => {
  for (const chain of [THUMB_CHAIN, ...Object.values(LONG_FINGER_CHAINS)]) {
    const i = chain.indexOf(joint);
    if (i >= 0) return i === 0 ? XRHandJoint.Wrist : chain[i - 1];
  }
  throw new Error(`No parent for ${joint}`);
};

const localTransform = (pose: HandPose, joint: XRHandJoint): LocalTransform => {
  const local = mat4.create();
  mat4.invert(local, pose.jointTransforms[parentOf(joint)].offsetMatrix);
  mat4.multiply(local, local, pose.jointTransforms[joint].offsetMatrix);
  // Intrinsic Y-X-Z (yaw, pitch, roll) decomposition of the rotation.
  const m21 = local[1];
  const m22 = local[5];
  const m13 = local[8];
  const m23 = local[9];
  const m33 = local[10];
  const pitch = Math.asin(-Math.min(Math.max(m23, -1), 1));
  const gimbal = Math.abs(m23) >= 0.9999999;
  return {
    translation: mat4.getTranslation(vec3.create(), local),
    rotation: mat4.getRotation(quat.create(), local),
    yaw:
      (gimbal ? Math.atan2(-local[2], local[0]) : Math.atan2(m13, m33)) * R2D,
    pitch: pitch * R2D,
    roll: gimbal ? 0 : Math.atan2(m21, m22) * R2D,
  };
};

const qx = quat.create();
const qy = quat.create();
const qz = quat.create();
const fromYawPitchRoll = (yaw: number, pitch: number, roll: number) => {
  quat.setAxisAngle(qy, [0, 1, 0], yaw * D2R);
  quat.setAxisAngle(qx, [1, 0, 0], pitch * D2R);
  quat.setAxisAngle(qz, [0, 0, 1], roll * D2R);
  const out = quat.multiply(quat.create(), qy, qx);
  return quat.multiply(out, out, qz);
};

/**
 * Builds a hand pose from joint angles on the skeleton of `rest`: finger bone
 * lengths (metacarpal to tip), the finger bases, joint radii, wrist and grip
 * placement all come from `rest`, so every pose built from the same skeleton
 * can be blended finger by finger. The one exception is the thumb base:
 * `thumb.shift` moves it toward its position in `opposed`.
 * Left-hand convention, like every pose config.
 */
export const buildHandPose = (
  angles: HandPoseAngles,
  rest: HandPose,
  opposed: HandPose,
): HandPose => {
  const restLocal = {} as Record<XRHandJoint, LocalTransform>;
  for (const joint of Object.values(XRHandJoint)) {
    if (joint !== XRHandJoint.Wrist) {
      restLocal[joint] = localTransform(rest, joint);
    }
  }
  const locals = {} as Record<XRHandJoint, mat4>;
  const set = (joint: XRHandJoint, rotation: quat, translation?: vec3) => {
    locals[joint] = mat4.fromRotationTranslation(
      mat4.create(),
      rotation,
      translation ?? restLocal[joint].translation,
    );
  };

  const [cmc, proximal, distal, tip] = THUMB_CHAIN;
  const thumb = angles.thumb ?? {};
  const cmcRest = restLocal[cmc];
  set(
    cmc,
    fromYawPitchRoll(
      ...(thumb.cmc ?? [cmcRest.yaw, cmcRest.pitch, cmcRest.roll]),
    ),
    vec3.lerp(
      vec3.create(),
      cmcRest.translation,
      localTransform(opposed, cmc).translation,
      thumb.shift ?? 0,
    ),
  );
  set(
    proximal,
    fromYawPitchRoll(
      thumb.mcpYaw ?? restLocal[proximal].yaw,
      thumb.mcp !== undefined ? -thumb.mcp : restLocal[proximal].pitch,
      thumb.mcpRoll ?? restLocal[proximal].roll,
    ),
  );
  set(
    distal,
    fromYawPitchRoll(
      thumb.ipYaw ?? restLocal[distal].yaw,
      thumb.ip !== undefined ? -thumb.ip : restLocal[distal].pitch,
      thumb.ipRoll ?? restLocal[distal].roll,
    ),
  );
  set(tip, restLocal[tip].rotation);

  for (const [finger, chain] of Object.entries(LONG_FINGER_CHAINS)) {
    const [metacarpal, prox, intermediate, dist, fingerTip] = chain;
    const a = angles[finger as LongFinger] ?? {};
    // A straight knuckle is pitch 0, except the pinky whose metacarpal frame is
    // tilted; its rest pitch already reads as a straight finger.
    const straight = finger === 'pinky' ? restLocal[prox].pitch : 0;
    set(metacarpal, restLocal[metacarpal].rotation);
    set(
      prox,
      fromYawPitchRoll(
        a.yaw ?? restLocal[prox].yaw,
        a.mcp !== undefined ? straight - a.mcp : restLocal[prox].pitch,
        a.roll ?? restLocal[prox].roll,
      ),
    );
    set(
      intermediate,
      fromYawPitchRoll(
        a.pipYaw ?? restLocal[intermediate].yaw,
        a.pip !== undefined ? -a.pip : restLocal[intermediate].pitch,
        a.pipRoll ?? restLocal[intermediate].roll,
      ),
    );
    set(
      dist,
      fromYawPitchRoll(
        restLocal[dist].yaw,
        a.dip !== undefined ? -a.dip : restLocal[dist].pitch,
        restLocal[dist].roll,
      ),
    );
    set(fingerTip, restLocal[fingerTip].rotation);
  }

  const jointTransforms = {} as HandPose['jointTransforms'];
  for (const joint of Object.values(XRHandJoint)) {
    const offsetMatrix =
      joint === XRHandJoint.Wrist
        ? mat4.clone(rest.jointTransforms[joint].offsetMatrix)
        : mat4.multiply(
            mat4.create(),
            jointTransforms[parentOf(joint)].offsetMatrix,
            locals[joint],
          );
    jointTransforms[joint] = {
      offsetMatrix,
      radius: rest.jointTransforms[joint].radius,
    };
  }
  return {
    jointTransforms,
    gripOffsetMatrix: rest.gripOffsetMatrix
      ? mat4.clone(rest.gripOffsetMatrix)
      : undefined,
  };
};
