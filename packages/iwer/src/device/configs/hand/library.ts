/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { HandPoseAngles, ThumbAngles, buildHandPose } from './builder.js';

import type { HandPose } from '../../XRHandInput.js';
import { pinchHandPose } from './pinch.js';
import { relaxedHandPose } from './relaxed.js';

/**
 * Base hand poses built on the captured relaxed skeleton, so they share its
 * finger bone lengths (metacarpal to tip), joint radii, wrist and grip
 * placement and can be blended finger by finger. Only `thumb.shift` moves the
 * thumb base away from its rest position.
 * Angles are in degrees (see HandPoseAngles); each pose was tuned by rendering
 * it on the WebXR generic-hand mesh and grading it against a written brief.
 */
export const handPoseAngles: Record<string, HandPoseAngles> = {
  // All five digits fully extended and spread wide (high five).
  open: {
    thumb: { cmc: [-72, 3, -48], mcp: 5, ip: 2 },
    index: { mcp: -4, pip: 2, dip: 4, yaw: -17 },
    middle: { mcp: -3, pip: 3, dip: 5, yaw: 3 },
    ring: { mcp: -2, pip: 6, dip: 8, yaw: 21.5 },
    pinky: { mcp: 1, pip: 8, dip: 8, yaw: 18.5 },
  },
  // Fingers straight and pressed together, thumb alongside the index (blade / karate chop).
  flat: {
    thumb: {
      cmc: [-16.5, -4.8, -67.7],
      mcp: 10,
      ip: 6,
      mcpYaw: 14,
      mcpRoll: 2,
      ipYaw: 0,
      ipRoll: -2,
    },
    index: {
      mcp: 2.7,
      pip: 3,
      dip: 2,
      yaw: 8.2,
      roll: -7,
      pipYaw: -1.8,
      pipRoll: 1,
    },
    middle: {
      mcp: 4,
      pip: 3,
      dip: 2,
      yaw: -0.1,
      roll: -2.2,
      pipYaw: -0.1,
      pipRoll: 3.5,
    },
    ring: {
      mcp: 2.1,
      pip: 4,
      dip: 2.5,
      yaw: -4.9,
      roll: 1,
      pipYaw: -0.8,
      pipRoll: 2.5,
    },
    pinky: {
      mcp: 15,
      pip: 5,
      dip: 3,
      yaw: -25.6,
      roll: -8,
      pipYaw: 0.8,
      pipRoll: 7.5,
    },
  },
  // All fingers tightly curled into the palm, thumb wrapped across the index and middle fingers.
  fist: {
    thumb: {
      cmc: [-25.4, -63, -118.6],
      shift: 1,
      mcp: 55,
      ip: 73.4,
      mcpYaw: 21.2,
      mcpRoll: 20.8,
      ipYaw: -7.2,
      ipRoll: -4.4,
    },
    index: { mcp: 88, pip: 100, dip: 62, yaw: -4.2, roll: -8.8 },
    middle: { mcp: 86, pip: 102, dip: 64, yaw: 5, roll: 0 },
    ring: { mcp: 82, pip: 106, dip: 74, yaw: 12.9, roll: 7.3 },
    pinky: { mcp: 74, pip: 108, dip: 70, yaw: 19.7, roll: -17.7 },
  },
  // Fist with the thumb extended straight up.
  'thumbs-up': {
    thumb: { cmc: [-77, -12, -58], mcp: 0, ip: -6 },
    index: { mcp: 88, pip: 100, dip: 62, yaw: -2.5, roll: -6.9 },
    middle: { mcp: 86, pip: 102, dip: 64, yaw: 5, roll: 0 },
    ring: { mcp: 88, pip: 102, dip: 66, yaw: 9.8, roll: 10.5 },
    pinky: { mcp: 90, pip: 100, dip: 66, yaw: 27, roll: -24 },
  },
  // Index straight, thumb up, other fingers curled (finger gun / L).
  'finger-gun': {
    thumb: { cmc: [-84, -2, -66], mcp: 13, ip: 13, mcpYaw: -2, shift: 0.6 },
    index: { mcp: 3, pip: 13, dip: 9, yaw: -7 },
    middle: { mcp: 83, pip: 103, dip: 63, yaw: 5.5, roll: 0 },
    ring: { mcp: 86, pip: 104, dip: 68, yaw: 8.5, roll: 10.5 },
    pinky: { mcp: 87, pip: 101, dip: 67, yaw: 23.5, roll: -22 },
  },
  // Index and middle extended in a V, thumb holding down the curled ring and pinky.
  peace: {
    thumb: {
      cmc: [-16.2, -53.8, -93.4],
      shift: 0.9,
      mcp: 60.8,
      ip: 52,
      mcpRoll: -10,
      ipRoll: -25,
    },
    index: { mcp: 0, pip: 12, dip: 9, yaw: -20 },
    middle: { mcp: -3, pip: 13, dip: 9, yaw: 14 },
    ring: { mcp: 83, pip: 104, dip: 76, yaw: 5, roll: 12 },
    pinky: { mcp: 87, pip: 102, dip: 68, yaw: 27, roll: -27 },
  },
  // Index, middle and ring extended, thumb holding down the curled pinky.
  three: {
    thumb: { cmc: [3.5, -49.3, -109.2], shift: 1, mcp: 49.5, ip: 63.3 },
    index: { mcp: 3, pip: 8, dip: 8, yaw: -5 },
    middle: { mcp: 2, pip: 7, dip: 7, yaw: 5 },
    ring: { mcp: 4, pip: 10, dip: 9, yaw: 14 },
    pinky: { mcp: 90, pip: 95, dip: 68, yaw: -2 },
  },
  // Four fingers extended, thumb folded across the palm.
  four: {
    thumb: { cmc: [10.8, -20.1, -125.2], shift: 1, mcp: 46, ip: 48 },
    index: { mcp: 2, pip: 8, dip: 8, yaw: -7 },
    middle: { mcp: 1, pip: 10, dip: 9, yaw: 5 },
    ring: { mcp: 8, pip: 12, dip: 11, yaw: 15 },
    pinky: { mcp: 11, pip: 14, dip: 12, yaw: 8 },
  },
  // Thumb and index tips touching in a round circle, other three fingers extended.
  ok: {
    thumb: { cmc: [-51.3, -48.4, -94], shift: 0.6, mcp: 29, ip: 42.6 },
    index: { mcp: 54, pip: 58.2, dip: 36.5, yaw: -26, roll: 21 },
    middle: { mcp: 4, pip: 15, dip: 12, yaw: 4 },
    ring: { mcp: 11, pip: 21, dip: 16, yaw: 12 },
    pinky: { mcp: 19, pip: 26, dip: 20, yaw: 9 },
  },
  // Index and pinky extended (horns), thumb holding the curled middle and ring.
  rock: {
    thumb: { cmc: [-13.7, -54.4, -104.1], shift: 0.9, mcp: 56.1, ip: 53 },
    index: { mcp: 3, pip: 12, dip: 11, yaw: -8 },
    middle: { mcp: 86, pip: 102, dip: 58, yaw: 5, roll: 0 },
    ring: { mcp: 86, pip: 102, dip: 66, yaw: 9.8, roll: 10.5 },
    pinky: { mcp: 11, pip: 7, dip: 8, yaw: 3 },
  },
  // Thumb and pinky extended, other fingers curled (call me / shaka).
  call: {
    thumb: { cmc: [-64, -14, -67], mcp: 5, ip: -10 },
    index: { mcp: 86, pip: 102, dip: 56, yaw: -5.7, roll: 3 },
    middle: { mcp: 82, pip: 108, dip: 54, yaw: 4.9, roll: 8 },
    ring: { mcp: 78, pip: 104, dip: 58, yaw: 12.4, roll: 14.3 },
    pinky: { mcp: -2, pip: 12, dip: 9, yaw: 10 },
  },
  // Thumb tip pinching the middle fingertip; other fingers relaxed.
  'pinch-middle': {
    thumb: { cmc: [-6.9, -58.7, -127.3], shift: 1, mcp: 20.3, ip: 43.6 },
    index: { mcp: 28, pip: 44, dip: 24, yaw: -9, pipYaw: 12 },
    middle: { mcp: 49.9, pip: 61.6, dip: 35, yaw: 4 },
    ring: { mcp: 50, pip: 64, dip: 38, yaw: 9 },
    pinky: { mcp: 60, pip: 66, dip: 40, yaw: 7 },
  },
  // Thumb tip pinching the ring fingertip; other fingers relaxed.
  'pinch-ring': {
    thumb: { cmc: [3.1, -63.5, -131.4], shift: 1, mcp: 29.7, ip: 34 },
    index: { mcp: 26, pip: 36, dip: 22, yaw: 5.5 },
    middle: { mcp: 33, pip: 45, dip: 27, yaw: -2.4 },
    ring: { mcp: 52.1, pip: 54.8, dip: 33.5, yaw: 4 },
    pinky: { mcp: 54, pip: 50, dip: 30, yaw: 4 },
  },
  // Thumb tip pinching the pinky fingertip; other fingers relaxed.
  'pinch-pinky': {
    thumb: { cmc: [24, -57.9, -142], shift: 1, mcp: 31.6, ip: 30.1 },
    index: { mcp: 26, pip: 36, dip: 25, yaw: 4 },
    middle: { mcp: 32, pip: 44, dip: 30, yaw: -3.2 },
    ring: { mcp: 50, pip: 47.5, dip: 31.6, yaw: 1 },
    pinky: { mcp: 45.8, pip: 58.9, dip: 30.4, yaw: -0.4 },
  },
  // Thumb, index and middle fingertips meeting (three-finger precision grip).
  tripod: {
    thumb: { cmc: [-7.3, -50.9, -118.2], shift: 1, mcp: 14.8, ip: 27.2 },
    index: { mcp: 50, pip: 45.9, dip: 27.5, yaw: 0.5, roll: -9, pipYaw: 3.7 },
    middle: { mcp: 44, pip: 54.4, dip: 32.6, yaw: 0.9, roll: 5, pipYaw: 0.1 },
    ring: { mcp: 63, pip: 76, dip: 44, yaw: 5 },
    pinky: { mcp: 75, pip: 82, dip: 48, yaw: 1 },
  },
  // Thumb pad pressed against the side of the curled index finger (lateral / key pinch).
  'key-pinch': {
    thumb: {
      cmc: [-30.4, -8.9, -59],
      shift: 1,
      mcp: 25.5,
      ip: 20.9,
      mcpYaw: 2.6,
      mcpRoll: 3.2,
      ipYaw: -11.5,
      ipRoll: -12.3,
    },
    index: { mcp: 56, pip: 66, dip: 42, yaw: -10, roll: -3.2 },
    middle: { mcp: 74, pip: 96, dip: 60, yaw: 3.6, roll: 0 },
    ring: { mcp: 80, pip: 99, dip: 63, yaw: 8.1, roll: 12 },
    pinky: { mcp: 85, pip: 101, dip: 65, yaw: 21.9, roll: -19.5 },
  },
  // Fingers loosely curled (the index's middle bone square to the hand), the
  // thumb hovering just off its side: ready for microgestures.
  microgesture: {
    thumb: {
      cmc: [-49.1, 6.9, -62],
      shift: 1,
      mcp: 37.9,
      ip: 40.1,
      mcpYaw: 2.6,
      mcpRoll: 3.2,
      ipYaw: -15.3,
      ipRoll: -12.3,
    },
    index: { mcp: 40, pip: 50, dip: 30, yaw: -10, roll: -3.2 },
    middle: { mcp: 58, pip: 72, dip: 44, yaw: 3.6, roll: 0 },
    ring: { mcp: 62, pip: 74, dip: 46, yaw: 8.1, roll: 12 },
    pinky: { mcp: 66, pip: 76, dip: 46, yaw: 21.9, roll: -19.5 },
  },
  // Power grip wrapped around a 4 cm handle.
  grip: {
    thumb: {
      cmc: [-27.6, -65.9, -128.5],
      shift: 1,
      mcp: 41.3,
      ip: 48.5,
      mcpYaw: -1.6,
      mcpRoll: -4.5,
    },
    index: { mcp: 49.4, pip: 72.5, dip: 45.6, yaw: 34.9, roll: -12.6 },
    middle: { mcp: 71.4, pip: 61.5, dip: 37.7, yaw: 20.2, roll: -0.8 },
    ring: { mcp: 70, pip: 59.2, dip: 37.5, yaw: -2.1, roll: 16 },
    pinky: { mcp: 67.8, pip: 55.4, dip: 35.8, yaw: -3.4, roll: -19.5 },
  },
  // Spread, curved fingers and opposed thumb as if holding a ball (spherical grasp).
  claw: {
    thumb: { cmc: [-41.2, -68.8, -71.2], shift: 0, mcp: 30.8, ip: 31.5 },
    index: { mcp: 22.8, pip: 44.5, dip: 33, yaw: -12 },
    middle: { mcp: 22.9, pip: 42.2, dip: 33, yaw: 3 },
    ring: { mcp: 25, pip: 42.4, dip: 33, yaw: 14 },
    pinky: { mcp: 47.1, pip: 52.1, dip: 33, yaw: 22 },
  },
  // Fingers hooked at the middle knuckles with straight base knuckles (carrying a bag handle).
  hook: {
    thumb: { cmc: [-25.8, 1.3, -92.6], mcp: 24, ip: 32 },
    index: { mcp: 0, pip: 90, dip: 56, yaw: 9.3, roll: -6.4 },
    middle: { mcp: 0, pip: 94, dip: 60, yaw: 2.5, roll: -2 },
    ring: { mcp: 4, pip: 98, dip: 66, yaw: -3.5, roll: 5 },
    pinky: { mcp: 19, pip: 100, dip: 68, yaw: -22, roll: -12 },
  },
  // Fingers together and gently curved, palm hollowed (scooping water).
  cup: {
    thumb: { cmc: [-11.8, -11.5, -98.7], shift: 0.2, mcp: 13.5, ip: 14.2 },
    index: {
      mcp: 36.2,
      pip: 31.1,
      dip: 21.7,
      yaw: 16.1,
      roll: -4.4,
      pipYaw: 3.3,
      pipRoll: 3.7,
    },
    middle: {
      mcp: 38.8,
      pip: 35.5,
      dip: 22.7,
      yaw: 3,
      roll: -7.3,
      pipYaw: 5,
      pipRoll: -0.2,
    },
    ring: {
      mcp: 39.5,
      pip: 30.1,
      dip: 21.1,
      yaw: 2.7,
      roll: 10.5,
      pipYaw: -6.2,
      pipRoll: 4.3,
    },
    pinky: {
      mcp: 42.7,
      pip: 28.5,
      dip: 18.4,
      yaw: -11.7,
      roll: -7.5,
      pipYaw: 1,
      pipRoll: 6.3,
    },
  },
};

export const libraryHandPoses: Record<string, HandPose> = {};
for (const [id, angles] of Object.entries(handPoseAngles)) {
  libraryHandPoses[id] = buildHandPose(angles, relaxedHandPose, pinchHandPose);
}

/**
 * Where the thumb goes during microgestures, on the `microgesture` pose. Tap
 * and the side swipes touch the side of the index finger's middle bone and
 * slide toward its tip or knuckle; the forward and backward swipes touch a
 * little behind (or in front) and slide around the bone, over its back or
 * toward the palm. Only the thumb of these poses is used; each was solved to
 * keep the thumb tip on the finger's surface.
 */
export type MicrogestureThumb =
  | 'touch'
  | 'tip-mid'
  | 'tip'
  | 'knuckle-mid'
  | 'knuckle'
  | 'forward-start'
  | 'forward-mid'
  | 'forward'
  | 'backward-start'
  | 'backward-mid'
  | 'backward';

const microgestureThumbAngles: Record<MicrogestureThumb, ThumbAngles> = {
  touch: {
    cmc: [-42.1, 4.7, -62.6],
    mcp: 35.1,
    ip: 35.5,
    mcpYaw: 4,
    ipYaw: -13.7,
  },
  'tip-mid': {
    cmc: [-39.3, -0.9, -61],
    mcp: 32.4,
    ip: 31.5,
    mcpYaw: 2.6,
    ipYaw: -13.4,
  },
  tip: {
    cmc: [-35.4, -7.3, -59.8],
    mcp: 27.9,
    ip: 25.9,
    mcpYaw: 1.4,
    ipYaw: -12.4,
  },
  'knuckle-mid': {
    cmc: [-45.6, 8.2, -67.7],
    mcp: 35.5,
    ip: 39.9,
    mcpYaw: 5.1,
    ipYaw: -13.6,
  },
  knuckle: {
    cmc: [-47.1, 11.5, -71],
    mcp: 34.1,
    ip: 41.7,
    mcpYaw: 7.5,
    ipYaw: -12.1,
  },
  'forward-start': {
    cmc: [-46.1, 7.7, -64],
    mcp: 43.2,
    ip: 45.7,
    mcpYaw: 3.8,
    ipYaw: -15,
  },
  'forward-mid': {
    cmc: [-42, 3.2, -63.4],
    mcp: 33.7,
    ip: 35.1,
    mcpYaw: 5.1,
    ipYaw: -13.1,
  },
  forward: {
    cmc: [-30.6, -2.4, -60.3],
    mcp: 20.2,
    ip: 16.6,
    mcpYaw: 4.3,
    ipYaw: -9.5,
  },
  'backward-start': {
    cmc: [-38.1, 1.9, -62.3],
    mcp: 29.2,
    ip: 28.5,
    mcpYaw: 4,
    ipYaw: -12.1,
  },
  'backward-mid': {
    cmc: [-45.1, 8.2, -62.2],
    mcp: 41.9,
    ip: 43.2,
    mcpYaw: 3.5,
    ipYaw: -14.6,
  },
  backward: {
    cmc: [-44.8, 10.2, -63.7],
    mcp: 48.5,
    ip: 49.5,
    mcpYaw: 3.6,
    ipYaw: -14.8,
  },
};

// Each keyframe keeps the rest thumb's base shift and twists.
export const microgestureThumbPoses = {} as Record<MicrogestureThumb, HandPose>;
for (const [id, thumb] of Object.entries(microgestureThumbAngles)) {
  const rest = handPoseAngles.microgesture;
  microgestureThumbPoses[id as MicrogestureThumb] = buildHandPose(
    { ...rest, thumb: { ...rest.thumb, ...thumb } },
    relaxedHandPose,
    pinchHandPose,
  );
}
