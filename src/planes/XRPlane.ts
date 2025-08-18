/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_PLANE } from '../private.js';
import type { XRFrame } from '../frameloop/XRFrame.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSemanticLabels } from '../labels/labels.js';
import { XRSpace } from '../spaces/XRSpace.js';

export enum XRPlaneOrientation {
  Horizontal = 'horizontal',
  Vertical = 'vertical',
}

/**
 * XRPlane orientation mapping from semantic labels.
 * For more details, see the {@link https://github.com/immersive-web/semantic-labels | Semantic Labels Documentation}.
 */
export const XREntityOrientation: Partial<
  Record<XRSemanticLabels, XRPlaneOrientation>
> = {
  [XRSemanticLabels.Desk]: XRPlaneOrientation.Horizontal,
  [XRSemanticLabels.Couch]: XRPlaneOrientation.Horizontal,
  [XRSemanticLabels.Floor]: XRPlaneOrientation.Horizontal,
  [XRSemanticLabels.Ceiling]: XRPlaneOrientation.Horizontal,
  [XRSemanticLabels.Wall]: XRPlaneOrientation.Vertical,
  [XRSemanticLabels.Door]: XRPlaneOrientation.Vertical,
  [XRSemanticLabels.Window]: XRPlaneOrientation.Vertical,
  [XRSemanticLabels.Table]: XRPlaneOrientation.Horizontal,
  [XRSemanticLabels.Shelf]: XRPlaneOrientation.Horizontal,
  [XRSemanticLabels.Bed]: XRPlaneOrientation.Horizontal,
  [XRSemanticLabels.Screen]: XRPlaneOrientation.Horizontal,
  [XRSemanticLabels.Lamp]: XRPlaneOrientation.Horizontal,
  [XRSemanticLabels.Plant]: XRPlaneOrientation.Horizontal,
  [XRSemanticLabels.WallArt]: XRPlaneOrientation.Vertical,
};

export class XRPlane {
  [P_PLANE]: {
    nativePlane: NativePlane;
    frame: XRFrame;
    planeSpace: XRSpace;
    polygon: DOMPointReadOnly[];
    lastChangedTime: DOMHighResTimeStamp;
    semanticLabel?: XRSemanticLabels;
    orientation?: XRPlaneOrientation;
  };

  constructor(
    nativePlane: NativePlane,
    planeSpace: XRSpace,
    polygon: DOMPointReadOnly[],
    semanticLabel?: XRSemanticLabels,
  ) {
    this[P_PLANE] = {
      nativePlane,
      frame: undefined!,
      planeSpace,
      polygon,
      lastChangedTime: performance.now(),
      semanticLabel,
      orientation: semanticLabel
        ? XREntityOrientation[semanticLabel]
        : undefined,
    };
  }

  get planeSpace() {
    return this[P_PLANE].planeSpace;
  }

  get polygon(): ReadonlyArray<DOMPointReadOnly> {
    return this[P_PLANE].polygon;
  }

  get orientation() {
    return this[P_PLANE].orientation;
  }

  get lastChangedTime() {
    return this[P_PLANE].lastChangedTime;
  }

  get semanticLabel() {
    return this[P_PLANE].semanticLabel;
  }
}

export class XRPlaneSet extends Set<XRPlane> {}

export class NativePlane {
  constructor(
    public transform: XRRigidTransform,
    public polygon: DOMPointReadOnly[],
    public semanticLabel: XRSemanticLabels,
  ) {}
}
