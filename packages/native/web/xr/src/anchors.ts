/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Spatial anchors over the native XR module (runtime/xr xr_anchors.h, docs/spec/08 XR-ANCHOR-1): what IWER host mode's
// anchor hooks (createAnchor, getAnchorPose, deleteAnchor, persistAnchor, restoreAnchor, erasePersistentAnchor,
// getPersistentAnchors) need. Requests are numbered by the native side and finish at a later frame (poll()); poses
// come from the native pose buffer, written before each frame.
//
// session.persistentAnchors: Quest Browser lists the anchors the origin persisted, in the origin's localStorage under a
// key the page cannot see or clear. Here the app is the origin, and the UUIDs it persisted are kept the same way, in
// localStorage's runtime entries (web/storage __iwnRuntimeStorage: hidden from the page, kept by clear()), added when a
// persist succeeds and removed when an erase does; the system's anchor store has no per-app listing without loading
// every anchor. UUIDs compare in lower case (the form persistent handles have).

import { mat4, quat, vec3 } from 'gl-matrix';

import type { NativeAnchorResult, XrNatives } from './natives.ts';

/** Floats per anchor in the pose buffer: flags (1 = located), position xyz, orientation xyzw (iwn/xr/anchors.h). */
export const ANCHOR_STRIDE = 8;
export const PERSISTED_KEY = 'persistent-anchors';

/** The host anchor IWER keeps: the native anchor id (slot | generation << 8). */
export interface NativeAnchor {
  readonly id: number;
}

/** web/storage's runtime entries (absent without that prelude: the list then lives in memory for the page). */
export type RuntimeStore = { getItem(k: string): string | null; setItem(k: string, v: string | null): void };

const position = vec3.create();
const rotation = quat.create();

export class NativeAnchors {
  private readonly natives: XrNatives;
  private readonly storage: () => RuntimeStore | null;
  private poses: Float32Array | null = null;
  private readonly waiting = new Map<number, { resolve(r: NativeAnchorResult): void; reject(e: Error): void }>();
  /** The UUID list when localStorage is unavailable. */
  private memory: string[] = [];

  constructor(natives: XrNatives, storage: () => RuntimeStore | null) {
    this.natives = natives;
    this.storage = storage;
  }

  /** Settles the requests the native side finished (call at every frame, tick and event batch). */
  poll(): void {
    const list = this.natives.anchorResults?.();
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const w = this.waiting.get(r.request);
      if (!w) continue;  // a request of a session that is gone
      this.waiting.delete(r.request);
      if (r.ok) w.resolve(r);
      else w.reject(new Error(r.error ?? 'the anchor request failed'));
    }
  }

  private request(request: number | undefined, what: string): Promise<NativeAnchorResult> {
    if (!request) {
      return Promise.reject(new DOMException(`${what}: this headset has no spatial anchors`, 'NotSupportedError'));
    }
    return new Promise((resolve, reject) => this.waiting.set(request, { resolve, reject }));
  }

  create(transform: Float32Array): Promise<NativeAnchor> {
    mat4.getTranslation(position, transform);
    mat4.getRotation(rotation, transform);
    const request = this.natives.anchorCreate?.(
      position[0], position[1], position[2], rotation[0], rotation[1], rotation[2], rotation[3],
    );
    return this.request(request, 'XRFrame.createAnchor').then((r) => ({ id: r.anchor ?? 0 }));
  }

  pose(anchor: NativeAnchor, out: Float32Array): boolean {
    let p = this.poses;
    if (!p) {
      const buffer = this.natives.anchorPoses?.();
      if (!buffer) return false;
      p = this.poses = new Float32Array(buffer);
    }
    const o = (anchor.id & 0xff) * ANCHOR_STRIDE;
    if (p[o] !== 1) return false;
    quat.set(rotation, p[o + 4], p[o + 5], p[o + 6], p[o + 7]);
    vec3.set(position, p[o + 1], p[o + 2], p[o + 3]);
    mat4.fromRotationTranslation(out, rotation, position);
    return true;
  }

  destroy(anchor: NativeAnchor): void {
    this.natives.anchorDestroy?.(anchor.id);
  }

  persist(anchor: NativeAnchor): Promise<string> {
    return this.request(this.natives.anchorPersist?.(anchor.id), 'XRAnchor.requestPersistentHandle').then((r) => {
      const uuid = r.uuid ?? '';
      const list = this.persisted();
      if (!list.includes(uuid)) this.store([...list, uuid]);
      return uuid;
    });
  }

  restore(uuid: string): Promise<NativeAnchor> {
    const id = String(uuid).toLowerCase();
    return this.request(this.natives.anchorRestore?.(id), 'XRSession.restorePersistentAnchor').then(
      (r) => ({ id: r.anchor ?? 0 }),
    );
  }

  erase(uuid: string): Promise<void> {
    const id = String(uuid).toLowerCase();
    const forget = () => this.store(this.persisted().filter((u) => u !== id));
    return this.request(this.natives.anchorErase?.(id), 'XRSession.deletePersistentAnchor').then(
      () => forget(),
      (error: Error) => {
        // the system has no such anchor (erased elsewhere, or the app's data was cleared): not listed any more
        if (/no persisted anchor/.test(error.message)) forget();
        throw error;
      },
    );
  }

  /** The UUIDs this app has persisted (session.persistentAnchors). */
  persisted(): string[] {
    const storage = this.storage();
    if (!storage) return this.memory.slice();
    try {
      const list = JSON.parse(storage.getItem(PERSISTED_KEY) ?? '[]') as unknown;
      return Array.isArray(list) ? list.filter((u): u is string => typeof u === 'string').map((u) => u.toLowerCase()) : [];
    } catch {
      return [];
    }
  }

  private store(list: string[]): void {
    const storage = this.storage();
    if (!storage) {
      this.memory = list;
      return;
    }
    try {
      storage.setItem(PERSISTED_KEY, JSON.stringify(list));
    } catch {
      this.memory = list;
    }
  }
}
