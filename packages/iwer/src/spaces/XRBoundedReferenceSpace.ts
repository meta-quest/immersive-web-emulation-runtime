/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_BOUNDED_REF_SPACE } from '../private.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
  linkOffsetSpace,
} from './XRReferenceSpace.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import type { XRSpace } from './XRSpace.js';
import { mat4 } from 'gl-matrix';

const NO_BOUNDS: readonly DOMPointReadOnly[] = Object.freeze([]);

/**
 * bounded-floor in host mode: the stage, with the stage rectangle the host
 * reported as its bounds (empty until the host knows it).
 */
export class XRBoundedReferenceSpace extends XRReferenceSpace {
  [P_BOUNDED_REF_SPACE]: {
    bounds: () => readonly DOMPointReadOnly[];
  };

  constructor(
    parentSpace: XRSpace,
    offsetMatrix?: mat4,
    bounds?: () => readonly DOMPointReadOnly[],
  ) {
    super(XRReferenceSpaceType.BoundedFloor, parentSpace, offsetMatrix);
    this[P_BOUNDED_REF_SPACE] = { bounds: bounds ?? (() => NO_BOUNDS) };
  }

  /** The boundary polygon on the floor (y = 0), wound as the WebXR spec defines. */
  get boundsGeometry(): readonly DOMPointReadOnly[] {
    return this[P_BOUNDED_REF_SPACE].bounds();
  }

  getOffsetReferenceSpace(
    originOffset: XRRigidTransform | mat4,
  ): XRBoundedReferenceSpace {
    const offsetMatrix =
      originOffset instanceof XRRigidTransform
        ? originOffset.matrix
        : originOffset;
    return linkOffsetSpace(
      this,
      new XRBoundedReferenceSpace(
        this,
        offsetMatrix,
        this[P_BOUNDED_REF_SPACE].bounds,
      ),
    );
  }
}
