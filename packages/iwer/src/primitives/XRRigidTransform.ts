/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

import { P_RIGID_TRANSFORM } from '../private.js';

export class XRRigidTransform {
  [P_RIGID_TRANSFORM]: {
    matrix: mat4;
    position: vec3;
    orientation: quat;
    positionPoint: DOMPointReadOnly;
    orientationPoint: DOMPointReadOnly;
    inverse: XRRigidTransform | null;
  };

  constructor(position?: DOMPointInit, orientation?: DOMPointInit) {
    // Default values
    const defaultPosition = vec3.fromValues(0, 0, 0);
    const defaultOrientation = quat.create();

    const resolvedPosition = position
      ? vec3.fromValues(position.x!, position.y!, position.z!)
      : defaultPosition;
    const resolvedOrientation = orientation
      ? quat.normalize(
          quat.create(),
          quat.fromValues(
            orientation.x!,
            orientation.y!,
            orientation.z!,
            orientation.w!,
          ),
        )
      : defaultOrientation;

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
    return this[P_RIGID_TRANSFORM].positionPoint;
  }

  get orientation(): DOMPointReadOnly {
    return this[P_RIGID_TRANSFORM].orientationPoint;
  }

  get inverse(): XRRigidTransform {
    if (!this[P_RIGID_TRANSFORM].inverse) {
      const invMatrix = mat4.create();
      if (!mat4.invert(invMatrix, this[P_RIGID_TRANSFORM].matrix)) {
        throw new Error('Matrix is not invertible.');
      }

      // Decomposing the inverse matrix into position and orientation
      let invPosition = vec3.create();
      mat4.getTranslation(invPosition, invMatrix);

      let invOrientation = quat.create();
      mat4.getRotation(invOrientation, invMatrix);

      // Creating a new XRRigidTransform for the inverse
      this[P_RIGID_TRANSFORM].inverse = new XRRigidTransform(
        new DOMPointReadOnly(invPosition[0], invPosition[1], invPosition[2], 1),
        new DOMPointReadOnly(
          invOrientation[0],
          invOrientation[1],
          invOrientation[2],
          invOrientation[3],
        ),
      );

      // Setting the inverse of the inverse to be this transform
      this[P_RIGID_TRANSFORM].inverse[P_RIGID_TRANSFORM].inverse = this;
    }

    return this[P_RIGID_TRANSFORM].inverse;
  }
}
