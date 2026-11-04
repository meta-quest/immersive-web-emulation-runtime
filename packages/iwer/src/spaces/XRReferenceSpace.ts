/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_REF_SPACE } from '../private.js';
import { XRReferenceSpaceEventHandler } from '../events/XRReferenceSpaceEvent.js';
import { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import { XRSpace } from './XRSpace.js';
import { mat4 } from 'gl-matrix';

export enum XRReferenceSpaceType {
  Viewer = 'viewer',
  Local = 'local',
  LocalFloor = 'local-floor',
  BoundedFloor = 'bounded-floor',
  Unbounded = 'unbounded',
}

export class XRReferenceSpace extends XRSpace {
  [P_REF_SPACE]: {
    type: XRReferenceSpaceType;
    onreset: XRReferenceSpaceEventHandler | null;
    // Told about every offset space derived from this one (host mode only).
    onOffsetSpace: ((offsetSpace: XRReferenceSpace) => void) | null;
  } = {
    type: null as any,
    onreset: null,
    onOffsetSpace: null,
  };

  constructor(
    type: XRReferenceSpaceType,
    parentSpace: XRSpace,
    offsetMatrix?: mat4,
  ) {
    super(parentSpace, offsetMatrix);
    this[P_REF_SPACE].type = type;
  }

  get onreset(): XRReferenceSpaceEventHandler | null {
    return this[P_REF_SPACE].onreset;
  }

  set onreset(callback: XRReferenceSpaceEventHandler) {
    if (this[P_REF_SPACE].onreset) {
      this.removeEventListener(
        'reset',
        this[P_REF_SPACE].onreset as EventListener,
      );
    }
    this[P_REF_SPACE].onreset = callback;
    if (callback) {
      this.addEventListener('reset', callback as EventListener);
    }
  }

  // Create a new XRReferenceSpace with an offset from the current space
  getOffsetReferenceSpace(
    originOffset: XRRigidTransform | mat4,
  ): XRReferenceSpace {
    // Create a new XRReferenceSpace with the originOffset as its offsetMatrix
    // The new space's parent is set to 'this' (the current XRReferenceSpace).
    // The spec passes an XRRigidTransform; a raw mat4 is kept for callers
    // that relied on the earlier signature.
    const offsetMatrix =
      originOffset instanceof XRRigidTransform
        ? originOffset.matrix
        : originOffset;
    return linkOffsetSpace(
      this,
      new XRReferenceSpace(this[P_REF_SPACE].type, this, offsetMatrix),
    );
  }
}

/**
 * Hands a space made by getOffsetReferenceSpace to its parent's
 * `onOffsetSpace` watcher, if any, and passes the watcher on so offsets of
 * offsets are seen too. Host mode uses this to send `reset` events to offset
 * spaces; without a watcher nothing happens.
 */
export function linkOffsetSpace<T extends XRReferenceSpace>(
  parent: XRReferenceSpace,
  offsetSpace: T,
): T {
  const watcher = parent[P_REF_SPACE].onOffsetSpace;
  if (watcher) {
    offsetSpace[P_REF_SPACE].onOffsetSpace = watcher;
    watcher(offsetSpace);
  }
  return offsetSpace;
}
