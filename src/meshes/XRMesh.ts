/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_MESH } from '../private.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSemanticLabels } from '../labels/labels.js';
import { XRSpace } from '../spaces/XRSpace.js';

export class XRMesh {
  [P_MESH]: {
    nativeMesh: NativeMesh;
    frame: XRFrame;
    meshSpace: XRSpace;
    vertices: Float32Array;
    indices: Uint32Array;
    lastChangedTime: DOMHighResTimeStamp;
    semanticLabel?: XRSemanticLabels;
  };

  constructor(
    nativeMesh: NativeMesh,
    meshSpace: XRSpace,
    vertices: Float32Array,
    indices: Uint32Array,
    semanticLabel?: XRSemanticLabels,
  ) {
    this[P_MESH] = {
      nativeMesh,
      frame: undefined!,
      meshSpace,
      vertices,
      indices,
      lastChangedTime: performance.now(),
      semanticLabel,
    };
  }

  get meshSpace() {
    return this[P_MESH].meshSpace;
  }

  get vertices(): Readonly<Float32Array> {
    return this[P_MESH].vertices;
  }

  get indices(): Readonly<Uint32Array> {
    return this[P_MESH].indices;
  }

  get lastChangedTime() {
    return this[P_MESH].lastChangedTime;
  }

  get semanticLabel() {
    return this[P_MESH].semanticLabel;
  }
}

export class XRMeshSet extends Set<XRMesh> {}

export class NativeMesh {
  constructor(
    public transform: XRRigidTransform,
    public vertices: Float32Array,
    public indices: Uint32Array,
    public semanticLabel: XRSemanticLabels,
  ) {}
}
