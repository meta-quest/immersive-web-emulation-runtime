/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The poses the hand pose stepper and hotkey cycle through. `pinch` is left
 * out: pinching is the pinch control's job. Every other pose stays reachable
 * through `set_hand_pose` and `XRHandInput.poseId`.
 */
export const FEATURED_HAND_POSE_IDS = [
  'default',
  'point',
  'fist',
  'open',
  'thumbs-up',
] as const;

/**
 * The poses to cycle through for a hand that can take `available`: the
 * featured ones it has, or all of them for a custom config without any.
 */
export function cyclePoseIds(available: readonly string[]): string[] {
  const featured = FEATURED_HAND_POSE_IDS.filter((id) =>
    available.includes(id),
  );
  return featured.length > 0 ? featured : [...available];
}

/**
 * The pose one step (`delta` 1 or -1) from `current`. From a pose outside the
 * cycle (set by an agent or a script), next goes to the first featured pose
 * and previous to the last.
 */
export function stepPoseId(
  current: string,
  available: readonly string[],
  delta: 1 | -1,
): string {
  const poses = cyclePoseIds(available);
  const index = poses.indexOf(current);
  if (index === -1) {
    return delta > 0 ? poses[0] : poses[poses.length - 1];
  }
  return poses[(index + poses.length + delta) % poses.length];
}

/** The stepper label: the pose id, with `*` when fingers come from other poses. */
export function poseLabel(poseId: string, fingerPoses: object): string {
  return Object.keys(fingerPoses).length > 0 ? `${poseId}*` : poseId;
}
