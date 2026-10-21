/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Ids of the hand poses built into `oculusHandConfig`. Kept free of imports so
 * UIs can list poses without pulling in the pose data.
 */
export const BUILTIN_HAND_POSE_IDS = [
  'default',
  'pinch',
  'point',
  'open',
  'flat',
  'fist',
  'thumbs-up',
  'finger-gun',
  'peace',
  'three',
  'four',
  'ok',
  'rock',
  'call',
  'pinch-middle',
  'pinch-ring',
  'pinch-pinky',
  'tripod',
  'key-pinch',
  'grip',
  'claw',
  'hook',
  'cup',
] as const;

export type BuiltinHandPoseId = (typeof BUILTIN_HAND_POSE_IDS)[number];
