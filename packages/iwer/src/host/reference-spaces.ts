/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4 } from 'gl-matrix';

import { P_REF_SPACE, P_SPACE } from '../private.js';
import { hostPoseMatrix } from './math.js';
import type { XRHostFrame } from './types.js';
import type { XRHostOutput } from './output.js';
import {
  XRReferenceSpace,
  XRReferenceSpaceType,
} from '../spaces/XRReferenceSpace.js';
import { XRBoundedReferenceSpace } from '../spaces/XRBoundedReferenceSpace.js';
import { XRReferenceSpaceEvent } from '../events/XRReferenceSpaceEvent.js';
import type { XRSpace } from '../spaces/XRSpace.js';

/**
 * Eye height assumed for local-floor when the host's base space is not at
 * floor level and no floor is known. 1.6 m is a common standing eye-height
 * estimate (also IWER's default emulated headset height); the figure is
 * still waiting for a confirmed public source.
 */
export const ASSUMED_EYE_HEIGHT = 1.6;

/** How a root reference space follows the host's tracking each frame. */
type Anchoring = 'local' | 'local-floor' | 'stage';

type Root = { space: XRReferenceSpace; anchoring: Anchoring };

/** Minimal WeakRef shape, so the ES2018 lib settings need not include it. */
type WeakHandle<T> = { deref(): T | undefined };
type WeakHandleConstructor = new <T extends object>(target: T) => WeakHandle<T>;
const WeakHandleImpl = (globalThis as { WeakRef?: WeakHandleConstructor })
  .WeakRef;

/** Smallest offset-space list length that triggers a sweep of dead entries. */
const OFFSET_SWEEP_MIN = 64;

function liveSpace(
  entry: WeakHandle<XRReferenceSpace> | XRReferenceSpace,
): XRReferenceSpace | undefined {
  return entry instanceof XRReferenceSpace ? entry : entry.deref();
}

/**
 * Reference spaces of a host session. Root spaces (local, local-floor,
 * bounded-floor) are children of IWER's global space, which is the host's
 * base space; their offsets are recomputed from the host frame every frame.
 * Offset spaces derived from them are remembered (weakly when the engine has
 * WeakRef) so a recentre can reach them too. Without WeakRef (engines older
 * than ES2021) they are held for the rest of the session: correctness over
 * memory, and every engine IWER host mode targets has WeakRef. A WeakRef
 * target stays alive until the current job ends, so a host that embeds V8
 * directly must let jobs end between frames (a microtask checkpoint, which
 * calls Isolate::ClearKeptObjects) for dead offset spaces to be collected.
 */
export class XRHostReferenceSpaces {
  private readonly globalSpace: XRSpace;
  private readonly output: XRHostOutput;
  private readonly roots: Root[] = [];
  private readonly offsets: Array<
    WeakHandle<XRReferenceSpace> | XRReferenceSpace
  > = [];
  /** List length at which dead weak entries are swept out next. */
  private sweepAt = OFFSET_SWEEP_MIN;
  private closed = false;
  private readonly watchOffsets = (space: XRReferenceSpace) => {
    if (this.closed) {
      return;
    }
    this.offsets.push(WeakHandleImpl ? new WeakHandleImpl(space) : space);
    if (this.offsets.length >= this.sweepAt) {
      // amortised: a page that makes an offset space every frame (smooth
      // locomotion) keeps the list near the number of spaces still alive
      this.sweep(this.offsets.length);
      this.sweepAt = Math.max(OFFSET_SWEEP_MIN, this.offsets.length * 2);
    }
  };

  constructor(globalSpace: XRSpace, output: XRHostOutput) {
    this.globalSpace = globalSpace;
    this.output = output;
  }

  /**
   * Makes a root space of the given type, or returns null for types a host
   * session does not offer (unbounded, or bounded-floor when the host said
   * it has no stage). `viewer` is handled by the caller. `frame` is the host
   * frame being run, if any, so a space made inside a frame is placed at
   * once.
   */
  create(
    type: XRReferenceSpaceType,
    frame: XRHostFrame | null,
  ): XRReferenceSpace | null {
    let root: Root;
    if (type === XRReferenceSpaceType.Local) {
      root = {
        space: new XRReferenceSpace(type, this.globalSpace),
        anchoring: 'local',
      };
    } else if (type === XRReferenceSpaceType.LocalFloor) {
      root = {
        space: new XRReferenceSpace(type, this.globalSpace),
        anchoring: 'local-floor',
      };
    } else if (type === XRReferenceSpaceType.BoundedFloor) {
      if (this.output.lacksStage) {
        return null;
      }
      root = {
        space: new XRBoundedReferenceSpace(this.globalSpace, undefined, () =>
          this.output.stageBounds(),
        ),
        anchoring: 'stage',
      };
    } else {
      return null;
    }
    root.space[P_REF_SPACE].onOffsetSpace = this.watchOffsets;
    this.roots.push(root);
    if (frame) {
      this.place(root, frame);
    }
    return root.space;
  }

  /** Re-anchors every root space to this frame's tracking. */
  update(frame: XRHostFrame): void {
    for (let i = 0; i < this.roots.length; i++) {
      this.place(this.roots[i], frame);
    }
  }

  private place(root: Root, frame: XRHostFrame): void {
    const offset = root.space[P_SPACE].offsetMatrix;
    switch (root.anchoring) {
      case 'stage':
        // bounded-floor is the base (stage) space itself
        mat4.identity(offset);
        return;
      case 'local':
        hostPoseMatrix(offset, frame.localPose, 0);
        return;
      case 'local-floor':
        // LOCAL's position on the floor plane and its heading, dropped to
        // the floor: y = 0 on a stage base, else an assumed eye height below
        hostPoseMatrix(offset, frame.localPose, 0);
        offset[13] = frame.baseIsStage ? 0 : offset[13] - ASSUMED_EYE_HEIGHT;
        return;
    }
  }

  /** How many offset spaces are on record; take it before a recentre. */
  get offsetCount(): number {
    return this.offsets.length;
  }

  /**
   * After a recentre: fires `reset` at the offset spaces derived from a root
   * space that were on record when the recentre happened (pass `offsetCount`
   * read before any `reset` was dispatched). WebXR queues one reset per space
   * that exists at that moment, so spaces made by `reset` handlers are left
   * alone; otherwise a handler that derives a new offset space on reset would
   * never let this return. (The caller fires `reset` at the spaces the page
   * requested.)
   */
  resetOffsets(count: number): void {
    // collected first: handlers may add (and so sweep) entries while the
    // events are dispatched, and a recentre is rare enough to allocate
    const targets: XRReferenceSpace[] = [];
    const end = Math.min(count, this.offsets.length);
    for (let i = 0; i < end; i++) {
      const space = liveSpace(this.offsets[i]);
      if (space) {
        targets.push(space);
      }
    }
    this.sweep(this.offsets.length);
    for (let i = 0; i < targets.length; i++) {
      targets[i].dispatchEvent(
        new XRReferenceSpaceEvent('reset', { referenceSpace: targets[i] }),
      );
    }
  }

  /** Drops dead weak entries among the first `count`, keeping order. */
  private sweep(count: number): void {
    const list = this.offsets;
    let kept = 0;
    for (let i = 0; i < list.length; i++) {
      if (i >= count || liveSpace(list[i])) {
        list[kept++] = list[i];
      }
    }
    list.length = kept;
  }

  /** Forgets everything when the session ends. */
  clear(): void {
    this.closed = true;
    for (const root of this.roots) {
      root.space[P_REF_SPACE].onOffsetSpace = null;
    }
    this.roots.length = 0;
    this.offsets.length = 0;
  }
}
