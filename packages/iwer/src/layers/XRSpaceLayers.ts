/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_COMPOSITION_LAYER, P_REF_SPACE, P_SPACE_LAYER } from '../private.js';
import {
  XRCompositionLayer,
  type XRCompositionLayerInit,
} from './XRProjectionLayer.js';
import type { XRLayerEventHandler } from '../events/XRLayerEvent.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../spaces/XRReferenceSpace.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSpace } from '../spaces/XRSpace.js';
import { getSpaceSession } from '../spaces/spaceSessions.js';
import type { XRSession } from '../session/XRSession.js';

// "Setting the space on a layer". Equirect and cube layers additionally need a
// reference space other than "viewer", as at creation.
const checkSpace = (
  session: XRSession,
  space: XRSpace,
  environment: boolean,
): XRSpace => {
  if (!(space instanceof XRSpace)) {
    throw new TypeError('A layer space must be an XRSpace.');
  }
  const owner = getSpaceSession(space);
  if (owner && owner !== session) {
    throw new TypeError('The layer space belongs to a different XRSession.');
  }
  if (
    environment &&
    (!(space instanceof XRReferenceSpace) ||
      space[P_REF_SPACE].type === XRReferenceSpaceType.Viewer)
  ) {
    throw new TypeError(
      'Equirect and cube layers need a reference space other than "viewer".',
    );
  }
  return space;
};

const checkTransform = (transform: XRRigidTransform): XRRigidTransform => {
  if (!(transform instanceof XRRigidTransform)) {
    throw new TypeError('A layer transform must be an XRRigidTransform.');
  }
  return transform;
};

// WebIDL float: non-finite values throw.
const toFloat = (value: number): number => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError('Layer dimensions must be finite numbers.');
  }
  return number;
};

type SpaceLayerState = {
  space: XRSpace;
  onredraw: XRLayerEventHandler | null;
};

/**
 * Shared by quad, cylinder, equirect and cube layers: a space and a redraw
 * event handler.
 */
abstract class XRSpaceLayer<
  State extends SpaceLayerState,
> extends XRCompositionLayer {
  [P_SPACE_LAYER]: State;
  protected abstract readonly environment: boolean;

  constructor(session: XRSession, init: XRCompositionLayerInit, state: State) {
    super(session, init);
    this[P_SPACE_LAYER] = state;
  }

  get space(): XRSpace {
    return this[P_SPACE_LAYER].space;
  }

  set space(space: XRSpace) {
    this[P_SPACE_LAYER].space = checkSpace(
      this[P_COMPOSITION_LAYER].session,
      space,
      this.environment,
    );
  }

  get onredraw(): XRLayerEventHandler | null {
    return this[P_SPACE_LAYER].onredraw;
  }

  set onredraw(callback: XRLayerEventHandler | null) {
    const previous = this[P_SPACE_LAYER].onredraw;
    if (previous) {
      this.removeEventListener('redraw', previous as EventListener);
    }
    this[P_SPACE_LAYER].onredraw = callback;
    if (callback) {
      this.addEventListener('redraw', callback as EventListener);
    }
  }
}

export { checkSpace as checkLayerSpace };

type QuadState = SpaceLayerState & {
  transform: XRRigidTransform;
  width: number;
  height: number;
};

export class XRQuadLayer extends XRSpaceLayer<QuadState> {
  protected readonly environment = false;

  get transform(): XRRigidTransform {
    return this[P_SPACE_LAYER].transform;
  }

  set transform(transform: XRRigidTransform) {
    this[P_SPACE_LAYER].transform = checkTransform(transform);
  }

  get width(): number {
    return this[P_SPACE_LAYER].width;
  }

  set width(width: number) {
    this[P_SPACE_LAYER].width = toFloat(width);
  }

  get height(): number {
    return this[P_SPACE_LAYER].height;
  }

  set height(height: number) {
    this[P_SPACE_LAYER].height = toFloat(height);
  }
}

type CylinderState = SpaceLayerState & {
  transform: XRRigidTransform;
  radius: number;
  centralAngle: number;
  aspectRatio: number;
};

export class XRCylinderLayer extends XRSpaceLayer<CylinderState> {
  protected readonly environment = false;

  get transform(): XRRigidTransform {
    return this[P_SPACE_LAYER].transform;
  }

  set transform(transform: XRRigidTransform) {
    this[P_SPACE_LAYER].transform = checkTransform(transform);
  }

  get radius(): number {
    return this[P_SPACE_LAYER].radius;
  }

  set radius(radius: number) {
    this[P_SPACE_LAYER].radius = toFloat(radius);
  }

  get centralAngle(): number {
    return this[P_SPACE_LAYER].centralAngle;
  }

  set centralAngle(centralAngle: number) {
    this[P_SPACE_LAYER].centralAngle = toFloat(centralAngle);
  }

  get aspectRatio(): number {
    return this[P_SPACE_LAYER].aspectRatio;
  }

  set aspectRatio(aspectRatio: number) {
    this[P_SPACE_LAYER].aspectRatio = toFloat(aspectRatio);
  }
}

type EquirectState = SpaceLayerState & {
  transform: XRRigidTransform;
  radius: number;
  centralHorizontalAngle: number;
  upperVerticalAngle: number;
  lowerVerticalAngle: number;
};

export class XREquirectLayer extends XRSpaceLayer<EquirectState> {
  protected readonly environment = true;

  get transform(): XRRigidTransform {
    return this[P_SPACE_LAYER].transform;
  }

  set transform(transform: XRRigidTransform) {
    this[P_SPACE_LAYER].transform = checkTransform(transform);
  }

  get radius(): number {
    return this[P_SPACE_LAYER].radius;
  }

  set radius(radius: number) {
    this[P_SPACE_LAYER].radius = toFloat(radius);
  }

  get centralHorizontalAngle(): number {
    return this[P_SPACE_LAYER].centralHorizontalAngle;
  }

  set centralHorizontalAngle(angle: number) {
    this[P_SPACE_LAYER].centralHorizontalAngle = toFloat(angle);
  }

  get upperVerticalAngle(): number {
    return this[P_SPACE_LAYER].upperVerticalAngle;
  }

  set upperVerticalAngle(angle: number) {
    this[P_SPACE_LAYER].upperVerticalAngle = toFloat(angle);
  }

  get lowerVerticalAngle(): number {
    return this[P_SPACE_LAYER].lowerVerticalAngle;
  }

  set lowerVerticalAngle(angle: number) {
    this[P_SPACE_LAYER].lowerVerticalAngle = toFloat(angle);
  }
}

type CubeState = SpaceLayerState & {
  orientation: DOMPointReadOnly;
};

export class XRCubeLayer extends XRSpaceLayer<CubeState> {
  protected readonly environment = true;

  get orientation(): DOMPointReadOnly {
    return this[P_SPACE_LAYER].orientation;
  }

  set orientation(orientation: DOMPointReadOnly) {
    if (!(orientation instanceof DOMPointReadOnly)) {
      throw new TypeError(
        'A cube layer orientation must be a DOMPointReadOnly.',
      );
    }
    this[P_SPACE_LAYER].orientation = orientation;
  }
}
