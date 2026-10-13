/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  NativePlane,
  XRPlane,
  XRPlaneOrientation,
} from '../../src/planes/XRPlane';
import { XRRigidTransform } from '../../src/primitives/XRRigidTransform';
import { XRSemanticLabels } from '../../src/labels/labels';
import { XRSpace } from '../../src/spaces/XRSpace';

const polygon = [
  new DOMPointReadOnly(0, 0, 0),
  new DOMPointReadOnly(1, 0, 0),
  new DOMPointReadOnly(1, 0, 1),
  new DOMPointReadOnly(0, 0, 0),
];

function plane(orientation: DOMPointInit, label?: XRSemanticLabels) {
  const transform = new XRRigidTransform(
    { x: 0, y: 0, z: 0, w: 1 },
    orientation,
  );
  return new XRPlane(
    new NativePlane(transform, polygon, label!),
    {} as XRSpace,
    polygon,
    label,
  );
}

describe('XRPlane', () => {
  const half = Math.SQRT1_2;

  test('orientation follows the plane normal, not the label', () => {
    // Identity: plane space +Y (the normal) points up.
    expect(
      plane({ x: 0, y: 0, z: 0, w: 1 }, XRSemanticLabels.Floor).orientation,
    ).toBe(XRPlaneOrientation.Horizontal);
    // Normal turned to +Z: a screen or wall facing the room.
    expect(
      plane({ x: half, y: 0, z: 0, w: half }, XRSemanticLabels.Screen)
        .orientation,
    ).toBe(XRPlaneOrientation.Vertical);
    // An upside-down plane (ceiling) is still horizontal.
    expect(
      plane({ x: 1, y: 0, z: 0, w: 0 }, XRSemanticLabels.Ceiling).orientation,
    ).toBe(XRPlaneOrientation.Horizontal);
    // A vertical table top is reported as vertical.
    expect(
      plane({ x: 0, y: 0, z: half, w: half }, XRSemanticLabels.Table)
        .orientation,
    ).toBe(XRPlaneOrientation.Vertical);
  });
});
