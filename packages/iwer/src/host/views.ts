/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4 } from 'gl-matrix';

import { P_DEVICE, P_SPACE } from '../private.js';
import { HOST_VIEW_STRIDE, hostPerspective, hostPoseMatrix } from './math.js';
import type { XRDeviceBase as XRDevice } from '../device/XRDeviceBase.js';
import { XREye } from '../views/XRView.js';
import type { XRHostFrame } from './types.js';

// FOV angles sit after position (3) and orientation (4) in each view record
const FOV_OFFSET = 7;

const headInverse = mat4.create();

/**
 * Per-frame view state of a host session: where each eye is, the head pose
 * the page sees as the viewer, and each eye's projection matrix. Everything
 * is allocated once per session and rewritten in place.
 */
export class XRHostViews {
  /** Views in the current frame, 1 or 2. */
  count = 2;
  /** Each eye's pose in the base (global) space. */
  readonly world: [mat4, mat4] = [mat4.create(), mat4.create()];
  /**
   * Each eye's projection matrix. `XRView.projectionMatrix` hands these
   * arrays out directly, so they are only ever rewritten in place.
   */
  readonly projection: [Float32Array, Float32Array] = [
    new Float32Array(16),
    new Float32Array(16),
  ];
  /** The head (viewer) pose in the base space. */
  readonly head = mat4.create();

  /**
   * Reads the eye poses from the host frame and writes them into IWER's
   * space graph: the device's viewer space becomes the head pose, and its
   * view spaces become each eye relative to the head.
   */
  readPoses(frame: XRHostFrame, device: XRDevice): void {
    const requested = frame.viewCount | 0;
    const count = requested >= 2 ? 2 : 1;
    this.count = count;
    const data = frame.views;
    hostPoseMatrix(this.world[0], data, 0);
    if (count === 2) {
      hostPoseMatrix(this.world[1], data, HOST_VIEW_STRIDE);
    }

    // The frame carries no separate head pose, so the head is placed midway
    // between the eyes and takes the first eye's orientation. (Whether the
    // host should send OpenXR's VIEW pose instead is an open question.)
    const head = this.head;
    mat4.copy(head, this.world[0]);
    if (count === 2) {
      const right = this.world[1];
      head[12] = 0.5 * (head[12] + right[12]);
      head[13] = 0.5 * (head[13] + right[13]);
      head[14] = 0.5 * (head[14] + right[14]);
    }

    const state = device[P_DEVICE];
    mat4.copy(state.viewerSpace[P_SPACE].offsetMatrix, head);
    mat4.invert(headInverse, head);
    const eyeSpaces = state.viewSpaces;
    const leftOffset = eyeSpaces[XREye.Left][P_SPACE].offsetMatrix;
    const rightOffset = eyeSpaces[XREye.Right][P_SPACE].offsetMatrix;
    mat4.multiply(leftOffset, headInverse, this.world[0]);
    if (count === 2) {
      mat4.multiply(rightOffset, headInverse, this.world[1]);
    } else {
      // mono: every eye space sits where the single view is
      mat4.copy(rightOffset, leftOffset);
    }
    mat4.copy(eyeSpaces[XREye.None][P_SPACE].offsetMatrix, leftOffset);
  }

  /** Rebuilds each view's projection from its FOV angles and the clip planes. */
  writeProjections(frame: XRHostFrame, near: number, far: number): void {
    const data = frame.views;
    for (let view = 0; view < this.count; view++) {
      const at = view * HOST_VIEW_STRIDE + FOV_OFFSET;
      hostPerspective(
        this.projection[view] as unknown as mat4,
        data[at],
        data[at + 1],
        data[at + 2],
        data[at + 3],
        near,
        far,
      );
    }
  }
}
