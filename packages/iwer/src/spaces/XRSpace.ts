/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4, quat, vec3 } from 'gl-matrix';

import { P_SPACE } from '../private.js';

// Module-level scratch reused by XRSpaceUtils to avoid per-call allocations on
// the per-frame pose path. Each use is fully consumed before the next call.
const scratchTranslation = vec3.create();

export class XRSpace extends EventTarget {
  [P_SPACE]: {
    parentSpace: XRSpace | undefined;
    offsetMatrix: mat4;
    emulated: boolean;
  };

  constructor(parentSpace?: XRSpace, offsetMatrix?: mat4) {
    super();
    this[P_SPACE] = {
      parentSpace,
      offsetMatrix: offsetMatrix ? mat4.clone(offsetMatrix) : mat4.create(),
      emulated: true,
    };
  }
}

export class GlobalSpace extends XRSpace {
  constructor() {
    super(undefined, mat4.create()); // GlobalSpace has no parent
  }
}

export class XRSpaceUtils {
  // Update the position component of the offsetMatrix of a given XRSpace
  static updateOffsetPosition(space: XRSpace, position: vec3): void {
    const offsetMatrix = space[P_SPACE].offsetMatrix;
    mat4.fromTranslation(offsetMatrix, position);
  }

  // Update the rotation component of the offsetMatrix of a given XRSpace using a quaternion
  static updateOffsetQuaternion(space: XRSpace, quaternion: quat): void {
    const offsetMatrix = space[P_SPACE].offsetMatrix;
    mat4.getTranslation(scratchTranslation, offsetMatrix);
    mat4.fromRotationTranslation(offsetMatrix, quaternion, scratchTranslation);
  }

  // Update the offsetMatrix of a given XRSpace directly
  static updateOffsetMatrix(space: XRSpace, matrix: mat4): void {
    const offsetMatrix = space[P_SPACE].offsetMatrix;
    mat4.copy(offsetMatrix, matrix);
  }

  // Calculate the global offset matrix for a given XRSpace.
  //
  // Walks up the parent chain iteratively and folds each ancestor's offset
  // matrix into `globalOffset` (root-first). The previous recursive form
  // allocated a throwaway mat4 for every level of the hierarchy on every call,
  // which is hot: getPose -> getOffsetMatrix calls this twice per pose, many
  // times per frame. This version allocates nothing beyond the (small) chain
  // array and never shares module scratch, so callers that pass two distinct
  // output matrices (see getOffsetMatrix) stay correct.
  static calculateGlobalOffsetMatrix(
    space: XRSpace,
    globalOffset: mat4 = mat4.create(),
  ): mat4 {
    const chain: XRSpace[] = [];
    let current: XRSpace | undefined = space;
    while (current) {
      chain.push(current);
      current = current[P_SPACE].parentSpace;
    }

    // chain is [space, ..., root]; multiply offsets in root -> space order.
    mat4.identity(globalOffset);
    for (let i = chain.length - 1; i >= 0; i--) {
      mat4.multiply(globalOffset, globalOffset, chain[i][P_SPACE].offsetMatrix);
    }
    return globalOffset;
  }
}
