/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4 } from 'gl-matrix';

import { P_DEVICE, P_SPACE } from '../private.js';
import { HOST_VIEW_STRIDE, hostPerspective, hostPoseMatrix } from './math.js';
import { invertAffine, multiplyInto } from './affine.js';
import type { XRDeviceBase as XRDevice } from '../device/XRDeviceBase.js';
import { XREye } from '../views/XRView.js';
import type { XRHostFrame } from './types.js';
import type { XRRenderState } from '../session/XRRenderState.js';

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
   * The inputs each projection was last built from (4 FOV angles, near,
   * far per view) and the result. The FOV rarely changes during a session,
   * so most frames copy the stored matrix instead of rebuilding it; the
   * copy still runs every frame so the handed-out arrays are always fresh.
   */
  private readonly projectionInputs = new Float64Array(12).fill(NaN);
  private readonly projectionBuilt: [Float32Array, Float32Array] = [
    new Float32Array(16),
    new Float32Array(16),
  ];

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
    // eye spaces relative to the head (all affine: see affine.ts)
    invertAffine(headInverse, head);
    const eyeSpaces = state.viewSpaces;
    const leftOffset = eyeSpaces[XREye.Left][P_SPACE].offsetMatrix;
    const rightOffset = eyeSpaces[XREye.Right][P_SPACE].offsetMatrix;
    multiplyInto(leftOffset, 0, headInverse, this.world[0]);
    if (count === 2) {
      multiplyInto(rightOffset, 0, headInverse, this.world[1]);
    } else {
      // mono: every eye space sits where the single view is
      mat4.copy(rightOffset, leftOffset);
    }
    mat4.copy(eyeSpaces[XREye.None][P_SPACE].offsetMatrix, leftOffset);
  }

  /**
   * Writes each view's projection for its FOV angles and the render state's
   * clip planes, rebuilding it only when one of them changed.
   */
  writeProjections(frame: XRHostFrame, renderState: XRRenderState): void {
    const data = frame.views;
    const near = renderState.depthNear;
    const far = renderState.depthFar;
    const inputs = this.projectionInputs;
    for (let view = 0; view < this.count; view++) {
      const at = view * HOST_VIEW_STRIDE + FOV_OFFSET;
      const angleLeft = data[at];
      const angleRight = data[at + 1];
      const angleUp = data[at + 2];
      const angleDown = data[at + 3];
      const out = this.projectionBuilt[view];
      const memo = view * 6;
      if (
        inputs[memo] !== angleLeft ||
        inputs[memo + 1] !== angleRight ||
        inputs[memo + 2] !== angleUp ||
        inputs[memo + 3] !== angleDown ||
        inputs[memo + 4] !== near ||
        inputs[memo + 5] !== far
      ) {
        inputs[memo] = angleLeft;
        inputs[memo + 1] = angleRight;
        inputs[memo + 2] = angleUp;
        inputs[memo + 3] = angleDown;
        inputs[memo + 4] = near;
        inputs[memo + 5] = far;
        // only when something changed, so the boxed arguments do not matter
        hostPerspective(
          out as unknown as mat4,
          angleLeft,
          angleRight,
          angleUp,
          angleDown,
          near,
          far,
        );
      }
      this.projection[view].set(out);
    }
  }
}
