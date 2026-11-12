/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

import { P_RIGID_TRANSFORM } from '../private.js';
import { convertDOMPointInit } from '../utils/DOMPointInit.js';

export class XRRigidTransform {
  [P_RIGID_TRANSFORM]: {
    matrix: mat4;
    position: vec3;
    orientation: quat;
    positionPoint: DOMPointReadOnly;
    orientationPoint: DOMPointReadOnly;
    inverse: XRRigidTransform | null;
    // Version of `matrix`. It only moves when IWER rewrites the matrix of a
    // reused transform (overwriteTransformMatrix); each derived value below
    // records the version it was computed from and is recomputed on read
    // when that version is behind.
    version: number;
    positionVersion: number;
    orientationVersion: number;
    inverseVersion: number;
  };

  constructor(position?: DOMPointInit, orientation?: DOMPointInit) {
    const positionInit = convertDOMPointInit(position);
    const orientationInit = convertDOMPointInit(orientation);
    const resolvedPosition = vec3.fromValues(
      positionInit.x,
      positionInit.y,
      positionInit.z,
    );
    const resolvedOrientation = quat.normalize(
      quat.create(),
      quat.fromValues(
        orientationInit.x,
        orientationInit.y,
        orientationInit.z,
        orientationInit.w,
      ),
    );

    this[P_RIGID_TRANSFORM] = {
      matrix: mat4.create(),
      position: resolvedPosition,
      orientation: resolvedOrientation,
      positionPoint: new DOMPointReadOnly(
        resolvedPosition[0],
        resolvedPosition[1],
        resolvedPosition[2],
        1,
      ),
      orientationPoint: new DOMPointReadOnly(
        resolvedOrientation[0],
        resolvedOrientation[1],
        resolvedOrientation[2],
        resolvedOrientation[3],
      ),
      inverse: null,
      version: 0,
      positionVersion: 0,
      orientationVersion: 0,
      inverseVersion: 0,
    };

    this.updateMatrix();
  }

  private updateMatrix(): void {
    mat4.fromRotationTranslation(
      this[P_RIGID_TRANSFORM].matrix,
      this[P_RIGID_TRANSFORM].orientation,
      this[P_RIGID_TRANSFORM].position,
    );
  }

  get matrix(): Float32Array {
    return this[P_RIGID_TRANSFORM].matrix as Float32Array;
  }

  get position(): DOMPointReadOnly {
    const state = this[P_RIGID_TRANSFORM];
    if (state.positionVersion !== state.version) {
      const p = mat4.getTranslation(state.position, state.matrix);
      state.positionPoint = new DOMPointReadOnly(p[0], p[1], p[2], 1);
      state.positionVersion = state.version;
    }
    return state.positionPoint;
  }

  get orientation(): DOMPointReadOnly {
    const state = this[P_RIGID_TRANSFORM];
    if (state.orientationVersion !== state.version) {
      const q = mat4.getRotation(state.orientation, state.matrix);
      state.orientationPoint = new DOMPointReadOnly(q[0], q[1], q[2], q[3]);
      state.orientationVersion = state.version;
    }
    return state.orientationPoint;
  }

  get inverse(): XRRigidTransform {
    const state = this[P_RIGID_TRANSFORM];
    if (state.inverse && state.inverseVersion !== state.version) {
      // This transform was rewritten after its inverse was made: rewrite the
      // same inverse object rather than creating another one.
      const target = state.inverse;
      if (!mat4.invert(target[P_RIGID_TRANSFORM].matrix, state.matrix)) {
        throw new Error('Matrix is not invertible.');
      }
      const targetState = target[P_RIGID_TRANSFORM];
      targetState.version++;
      // the inverse's own inverse is this transform, which is current
      targetState.inverseVersion = targetState.version;
      state.inverseVersion = state.version;
    }
    if (!state.inverse) {
      const invMatrix = mat4.create();
      if (!mat4.invert(invMatrix, state.matrix)) {
        throw new Error('Matrix is not invertible.');
      }

      // Decomposing the inverse matrix into position and orientation
      let invPosition = vec3.create();
      mat4.getTranslation(invPosition, invMatrix);

      let invOrientation = quat.create();
      mat4.getRotation(invOrientation, invMatrix);

      // Creating a new XRRigidTransform for the inverse
      state.inverse = new XRRigidTransform(
        new DOMPointReadOnly(invPosition[0], invPosition[1], invPosition[2], 1),
        new DOMPointReadOnly(
          invOrientation[0],
          invOrientation[1],
          invOrientation[2],
          invOrientation[3],
        ),
      );

      // Setting the inverse of the inverse to be this transform
      state.inverse[P_RIGID_TRANSFORM].inverse = this;
      state.inverseVersion = state.version;
    }

    return state.inverse;
  }
}

/**
 * Replaces the matrix of an existing transform with 16 column-major numbers
 * (a rigid transform is assumed, nothing is validated). Used by host mode,
 * which keeps a few pose objects alive and rewrites them instead of
 * allocating new ones every frame. Reading `matrix` afterwards allocates
 * nothing; `position`, `orientation` and `inverse` are brought up to date the
 * next time they are read.
 */
export function overwriteTransformMatrix(
  transform: XRRigidTransform,
  source: ArrayLike<number>,
): void {
  const state = transform[P_RIGID_TRANSFORM];
  const target = state.matrix;
  for (let i = 0; i < 16; i++) {
    target[i] = source[i];
  }
  state.version++;
}
