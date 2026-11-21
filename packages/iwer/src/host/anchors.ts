/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { P_ANCHOR, P_DEVICE, P_SESSION, P_SPACE } from '../private.js';
import { XRAnchor } from '../anchors/XRAnchor.js';
import type { XRRigidTransform } from '../primitives/XRRigidTransform.js';
import type { XRSession } from '../session/XRSession.js';
import { XRSpace, XRSpaceUtils } from '../spaces/XRSpace.js';
import type { XRHostAnchor, XRHostBackend } from './types.js';

/** A host's rejection as the DOMException the page gets. */
function asDOMException(error: unknown, name: string): DOMException {
  if (error instanceof DOMException) {
    return error;
  }
  const message =
    error instanceof Error ? error.message : String(error ?? 'unknown error');
  return new DOMException(message, name);
}

/**
 * Anchors for a host session (WebXR Anchors, and persistent anchors the way
 * Quest Browser offers them: `requestPersistentHandle`, `persistentAnchors`,
 * `restorePersistentAnchor`, `deletePersistentAnchor`).
 *
 * Without the `anchors` feature every anchor call rejects with
 * `NotSupportedError`, as the Anchors module specifies. With it and the
 * backend's anchor hooks, anchors are the host's: each `XRAnchor` keeps the
 * host anchor it was created or restored as, its `anchorSpace` hangs off
 * the global (base) space and takes the host's pose every visible frame,
 * and it has no pose while the host cannot locate it. Without the hooks,
 * anchors stay IWER's own (poses fixed in the base space); their promises
 * still settle at the next frame.
 */
export class XRHostAnchors {
  private readonly session: XRSession;
  private readonly backend: XRHostBackend;
  /** the host anchor behind each live XRAnchor */
  private readonly live = new Map<XRAnchor, XRHostAnchor>();
  /** requestPersistentHandle calls in flight, per anchor */
  private readonly persisting = new Map<XRAnchor, Promise<string>>();
  /** UUIDs of restorePersistentAnchor calls in flight */
  private readonly restoring = new Set<string>();
  /** UUIDs of deletePersistentAnchor calls in flight */
  private readonly erasing = new Set<string>();
  private readonly pose = new Float32Array(16);
  private closed = false;

  constructor(session: XRSession, backend: XRHostBackend) {
    this.session = session;
    this.backend = backend;
  }

  /** The session's anchors are the host's (feature enabled, hooks present). */
  get hosted(): boolean {
    const b = this.backend;
    return (
      this.session[P_SESSION].hasAnchors &&
      typeof b.createAnchor === 'function' &&
      typeof b.getAnchorPose === 'function'
    );
  }

  /** True when `anchor` is one of this session's host anchors. */
  owns(anchor: XRAnchor): boolean {
    return this.live.has(anchor);
  }

  /**
   * A rejection for an anchor call on a session without the `anchors`
   * feature, else null.
   */
  refuse(what: string): Promise<never> | null {
    if (this.session[P_SESSION].hasAnchors) {
      return null;
    }
    return Promise.reject(
      new DOMException(
        `${what}: the session did not enable the "anchors" feature`,
        'NotSupportedError',
      ),
    );
  }

  /** `XRFrame.createAnchor(pose, space)` (the frame is active). */
  create(pose: XRRigidTransform, space: XRSpace): Promise<XRAnchor> {
    const matrix = new Float32Array(16);
    XRSpaceUtils.calculateGlobalOffsetMatrix(
      new XRSpace(space, pose.matrix),
      matrix,
    );
    let request: Promise<XRHostAnchor>;
    try {
      request = this.backend.createAnchor!(matrix);
    } catch (error) {
      return Promise.reject(asDOMException(error, 'OperationError'));
    }
    return this.adopt(request, matrix, null);
  }

  /**
   * Turns a host anchor (once the host has it) into an `XRAnchor` that the
   * next frame adds to the tracked anchors and hands to the page. `initial`:
   * the pose to show until the host's first one (null: none, a restored
   * anchor has no known pose yet).
   */
  private adopt(
    request: Promise<XRHostAnchor>,
    initial: Float32Array | null,
    uuid: string | null,
  ): Promise<XRAnchor> {
    return new Promise<XRAnchor>((resolve, reject) => {
      request.then(
        (handle) => {
          const s = this.session[P_SESSION];
          if (this.closed || s.ended) {
            this.release(handle);
            reject(
              new DOMException(
                'XRSession has ended before the anchor was resolved.',
                'InvalidStateError',
              ),
            );
            return;
          }
          const space = new XRSpace(
            s.device[P_DEVICE].globalSpace,
            initial ?? undefined,
          );
          space[P_SPACE].tracked = initial !== null;
          const anchor = new XRAnchor(space, this.session);
          this.live.set(anchor, handle);
          if (uuid !== null) {
            s.persistentAnchors.set(uuid, anchor);
          }
          s.newAnchors.set(anchor, { resolve, reject });
        },
        (error) => reject(asDOMException(error, 'OperationError')),
      );
    });
  }

  /**
   * Once per visible frame, before the callbacks: every host anchor takes
   * the host's pose (or loses it), then the frame's tracked anchors are
   * listed and the anchors created since the last frame are handed over.
   */
  update(): void {
    if (this.live.size > 0 && this.backend.getAnchorPose) {
      this.live.forEach(this.locate);
    }
    // XRSession's updateTrackedAnchors, without its per-frame array
    const s = this.session[P_SESSION];
    if (s.trackedAnchors.size > 0 || s.frameTrackedAnchors.size > 0) {
      s.frameTrackedAnchors.clear();
      s.trackedAnchors.forEach(this.visitAnchor);
    }
  }

  // Made once, like the callbacks below: a closure written inside update()
  // would be allocated every frame.
  private readonly locate = (handle: XRHostAnchor, anchor: XRAnchor) => {
    const space = anchor[P_ANCHOR].anchorSpace;
    if (!space) {
      return;
    }
    if (this.backend.getAnchorPose!(handle, this.pose)) {
      XRSpaceUtils.updateOffsetMatrix(space, this.pose);
      space[P_SPACE].tracked = true;
    } else {
      space[P_SPACE].tracked = false;
    }
  };

  private readonly visitAnchor = (anchor: XRAnchor) => {
    const s = this.session[P_SESSION];
    const pending = s.newAnchors.get(anchor);
    if (anchor[P_ANCHOR].deleted) {
      s.trackedAnchors.delete(anchor);
      if (pending) {
        s.newAnchors.delete(anchor);
        pending.reject(
          new DOMException('Anchor is no longer tracked', 'InvalidStateError'),
        );
      }
      return;
    }
    s.frameTrackedAnchors.add(anchor);
    if (pending) {
      s.newAnchors.delete(anchor);
      pending.resolve(anchor);
    }
  };

  /** `XRAnchor.delete()` of a host anchor. */
  onDelete(anchor: XRAnchor): void {
    // deleted before the frame that would hand it over (its persisted copy
    // was erased meanwhile): the waiting promise rejects instead of hanging
    const s = this.session[P_SESSION];
    const pending = s.newAnchors.get(anchor);
    if (pending) {
      s.newAnchors.delete(anchor);
      pending.reject(
        new DOMException(
          'The anchor was deleted before it was resolved.',
          'InvalidStateError',
        ),
      );
    }
    const handle = this.live.get(anchor);
    if (handle === undefined) {
      return;
    }
    this.live.delete(anchor);
    this.release(handle);
  }

  /** `XRAnchor.requestPersistentHandle()` of a host anchor. */
  persist(anchor: XRAnchor): Promise<string> {
    const s = this.session[P_SESSION];
    for (const [uuid, known] of s.persistentAnchors) {
      if (known === anchor) {
        return Promise.resolve(uuid);
      }
    }
    const pending = this.persisting.get(anchor);
    if (pending) {
      return pending;
    }
    const handle = this.live.get(anchor);
    if (handle === undefined || !this.backend.persistAnchor) {
      return Promise.reject(
        new DOMException(
          'Persistent anchors are not supported by this host.',
          'NotSupportedError',
        ),
      );
    }
    let request: Promise<string>;
    try {
      request = this.backend.persistAnchor(handle);
    } catch (error) {
      return Promise.reject(asDOMException(error, 'OperationError'));
    }
    const done = request.then(
      (uuid) => {
        this.persisting.delete(anchor);
        s.persistentAnchors.set(uuid, anchor);
        return uuid;
      },
      (error) => {
        this.persisting.delete(anchor);
        throw asDOMException(error, 'OperationError');
      },
    );
    this.persisting.set(anchor, done);
    return done;
  }

  /** `XRSession.persistentAnchors`. */
  persistentAnchors(): string[] {
    const list = this.backend.getPersistentAnchors?.();
    return list
      ? Array.from(list)
      : Array.from(this.session[P_SESSION].persistentAnchors.keys());
  }

  /** `XRSession.restorePersistentAnchor(uuid)` (hosted sessions). */
  restore(given: string): Promise<XRAnchor> {
    // UUIDs compare in lower case, the form persistent handles have
    const uuid = String(given).toLowerCase();
    const s = this.session[P_SESSION];
    if (s.ended) {
      return Promise.reject(
        new DOMException('XRSession has already ended.', 'InvalidStateError'),
      );
    }
    const known = s.persistentAnchors.get(uuid);
    if (known && this.live.has(known)) {
      return Promise.resolve(known);
    }
    if (this.restoring.has(uuid) || this.erasing.has(uuid)) {
      return Promise.reject(
        new DOMException(
          this.erasing.has(uuid)
            ? `The anchor with UUID ${uuid} is being deleted.`
            : `Multiple concurrent attempts detected to restore the anchor with UUID: ${uuid}.`,
          'InvalidStateError',
        ),
      );
    }
    if (!this.backend.restoreAnchor) {
      return Promise.reject(
        new DOMException(
          'Persistent anchors are not supported by this host.',
          'NotSupportedError',
        ),
      );
    }
    let request: Promise<XRHostAnchor>;
    try {
      request = this.backend.restoreAnchor(uuid);
    } catch (error) {
      return Promise.reject(asDOMException(error, 'InvalidStateError'));
    }
    this.restoring.add(uuid);
    const settled = () => {
      this.restoring.delete(uuid);
    };
    request.then(settled, settled);
    return this.adopt(
      request.catch((error) => {
        throw asDOMException(error, 'InvalidStateError');
      }),
      null,
      uuid,
    );
  }

  /** `XRSession.deletePersistentAnchor(uuid)` (hosted sessions). */
  erase(given: string): Promise<undefined> {
    const uuid = String(given).toLowerCase();
    // as Quest Browser (kAnchorAlreadyProcessing): not while it is restored
    if (this.restoring.has(uuid) || this.erasing.has(uuid)) {
      return Promise.reject(
        new DOMException(
          `The anchor with UUID ${uuid} is already being restored or deleted.`,
          'InvalidStateError',
        ),
      );
    }
    if (!this.backend.erasePersistentAnchor) {
      return Promise.reject(
        new DOMException(
          'Persistent anchors are not supported by this host.',
          'NotSupportedError',
        ),
      );
    }
    let request: Promise<void>;
    try {
      request = this.backend.erasePersistentAnchor(uuid);
    } catch (error) {
      return Promise.reject(asDOMException(error, 'InvalidStateError'));
    }
    this.erasing.add(uuid);
    const settled = () => {
      this.erasing.delete(uuid);
    };
    request.then(settled, settled);
    return request.then(
      () => {
        // as in IWER's own persistent anchors: a live anchor restored from
        // the erased copy is deleted with it
        const s = this.session[P_SESSION];
        const anchor = s.persistentAnchors.get(uuid);
        s.persistentAnchors.delete(uuid);
        anchor?.delete();
        return undefined;
      },
      (error) => {
        throw asDOMException(error, 'InvalidStateError');
      },
    );
  }

  /** The session ends: every host anchor is released (persisted copies stay). */
  close(): void {
    this.closed = true;
    const handles = Array.from(this.live.values());
    this.live.clear();
    this.persisting.clear();
    for (const handle of handles) {
      this.release(handle);
    }
  }

  private release(handle: XRHostAnchor): void {
    try {
      this.backend.deleteAnchor?.(handle);
    } catch (error) {
      console.error('XRHostBackend.deleteAnchor threw', error);
    }
  }
}
