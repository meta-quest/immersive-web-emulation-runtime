/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { quat, vec3 } from 'gl-matrix';

import type { HandDirections } from '../device/XRHandInput.js';
import { XRHandedness } from '../input/XRInputSource.js';

/** Time curves for timed remote commands. */
export type Easing = 'linear' | 'minimum-jerk';
export const EASINGS: readonly Easing[] = ['linear', 'minimum-jerk'];

/**
 * Easings run_sequence also uses internally: `reach` is minimum-jerk skewed
 * so the hand speeds up quickly and slows down for longer (peak speed at 40%
 * of the time), as a reach to a target does. Not a remote `easing` value.
 */
export type PathEasing = Easing | 'reach';

// t^REACH_SKEW maps 0.4 to 0.5, moving the speed peak earlier.
const REACH_SKEW = Math.log(0.5) / Math.log(0.4);

/**
 * Maps linear progress (0 to 1) through an easing. `minimum-jerk` is the
 * smooth start-and-stop profile of a human reach (10t³ − 15t⁴ + 6t⁵).
 */
export const ease = (easing: PathEasing, t: number): number => {
  let c = Math.min(1, Math.max(0, t));
  if (easing === 'reach') c = Math.pow(c, REACH_SKEW);
  const eased = easing === 'linear' ? c : c * c * c * (10 + c * (-15 + 6 * c));
  return Math.min(1, Math.max(0, eased));
};

/** Directions that can be named instead of given as a vector. */
export const NAMED_DIRECTIONS = [
  'up',
  'down',
  'forward',
  'back',
  'left',
  'right',
  'toward-head',
  'away-from-head',
] as const;
export type NamedDirection = (typeof NAMED_DIRECTIONS)[number];

/**
 * The body's frame: the head position and the horizontal directions the body
 * faces. `forward` and `right` ignore head pitch and roll.
 */
export interface BodyFrame {
  head: vec3;
  forward: vec3;
  right: vec3;
}

const UP = vec3.fromValues(0, 1, 0);

/** The body frame implied by a head pose (its yaw only). */
export const bodyFrameFromHead = (
  head: vec3,
  headRotation: quat,
): BodyFrame => {
  const forward = vec3.transformQuat(
    vec3.create(),
    vec3.fromValues(0, 0, -1),
    headRotation,
  );
  forward[1] = 0;
  if (vec3.length(forward) < 1e-6) {
    // Looking straight up or down: fall back to the head's up axis.
    vec3.transformQuat(forward, vec3.fromValues(0, 1, 0), headRotation);
    forward[1] = 0;
  }
  vec3.normalize(forward, forward);
  const right = vec3.cross(vec3.create(), forward, UP);
  return { head: vec3.clone(head), forward, right };
};

/**
 * A direction as a unit vector. Named directions are relative to the body
 * frame; `toward-head` / `away-from-head` need the point they start from.
 */
export const resolveDirection = (
  value: vec3 | NamedDirection,
  body: BodyFrame,
  from?: vec3,
): vec3 => {
  const out = vec3.create();
  if (typeof value !== 'string') {
    return vec3.normalize(out, value);
  }
  switch (value) {
    case 'up':
      return vec3.set(out, 0, 1, 0);
    case 'down':
      return vec3.set(out, 0, -1, 0);
    case 'forward':
      return vec3.copy(out, body.forward);
    case 'back':
      return vec3.negate(out, body.forward);
    case 'right':
      return vec3.copy(out, body.right);
    case 'left':
      return vec3.negate(out, body.right);
    case 'toward-head':
    case 'away-from-head': {
      vec3.subtract(out, body.head, from ?? body.head);
      if (vec3.length(out) < 1e-6) {
        vec3.negate(out, body.forward);
      }
      vec3.normalize(out, out);
      return value === 'toward-head' ? out : vec3.negate(out, out);
    }
  }
};

/**
 * Where a hand's shoulder roughly is: 18 cm to the side of, 25 cm below and
 * 5 cm behind the eyes, in the body frame.
 */
export const shoulderPosition = (
  body: BodyFrame,
  handedness: XRHandedness,
): vec3 => {
  const out = vec3.clone(body.head);
  const side = handedness === XRHandedness.Left ? -0.18 : 0.18;
  vec3.scaleAndAdd(out, out, body.right, side);
  out[1] -= 0.25;
  vec3.scaleAndAdd(out, out, body.forward, -0.05);
  return out;
};

const PRONATION = Math.tan((15 * Math.PI) / 180);

/**
 * A natural reaching orientation: fingers pointing along the forearm (from an
 * elbow estimate below and in front of the shoulder to the target), turned
 * part of the way back toward straight ahead, palm down and rolled 15° toward
 * thumb-up, the way a relaxed arm reaches.
 */
export const autoDirections = (
  shoulder: vec3,
  target: vec3,
  handedness: XRHandedness,
  body: BodyFrame,
): HandDirections => {
  const elbow = vec3.clone(shoulder);
  elbow[1] -= 0.25;
  vec3.scaleAndAdd(elbow, elbow, body.forward, 0.12);
  const fingers = vec3.subtract(vec3.create(), target, elbow);
  if (vec3.length(fingers) < 1e-6) {
    vec3.copy(fingers, body.forward);
  }
  vec3.normalize(fingers, fingers);
  // Wrists rarely turn fully toward targets off to the side.
  const pitch = fingers[1];
  const horizontal = vec3.fromValues(fingers[0], 0, fingers[2]);
  if (vec3.length(horizontal) > 1e-6) {
    vec3.normalize(horizontal, horizontal);
    vec3.lerp(horizontal, horizontal, body.forward, 0.3);
    vec3.normalize(horizontal, horizontal);
    const h = Math.sqrt(Math.max(0, 1 - pitch * pitch));
    vec3.set(fingers, horizontal[0] * h, pitch, horizontal[2] * h);
  }
  const palm = vec3.fromValues(0, -1, 0);
  vec3.scaleAndAdd(palm, palm, fingers, -vec3.dot(palm, fingers));
  if (vec3.length(palm) < 1e-6) {
    // Reaching straight down: palm faces back toward the body.
    vec3.negate(palm, body.forward);
  }
  vec3.normalize(palm, palm);
  const medial = vec3.scale(
    vec3.create(),
    body.right,
    handedness === XRHandedness.Left ? 1 : -1,
  );
  vec3.scaleAndAdd(medial, medial, fingers, -vec3.dot(medial, fingers));
  if (vec3.length(medial) > 1e-6) {
    vec3.normalize(medial, medial);
    vec3.scaleAndAdd(palm, palm, medial, PRONATION);
    vec3.normalize(palm, palm);
  }
  return { fingers, palm };
};
