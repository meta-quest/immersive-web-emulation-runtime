/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Android runtime permissions (XR-PERM-1): the ones Horizon OS grants only after its system dialog (protection level
// "dangerous": USE_SCENE for planes, meshes, hit test and depth; CAMERA and HEADSET_CAMERA for the passthrough
// cameras). The packer declares them in the manifest; here they are asked for when something first needs them. The
// native broker (runtime/xr xr_permissions.h) keeps one Android request in flight, puts each permission to the user
// once per process (a new page or a reload only re-checks) and never asks for one the manifest lacks.

import type { XrNatives } from './natives.ts';

/** Planes, meshes, scene-based hit test and environment depth (the Scene API). */
export const USE_SCENE = 'com.oculus.permission.USE_SCENE';

export class RuntimePermissions {
  private readonly natives: XrNatives;
  private readonly report: (error: unknown) => void;
  /** This page's answer per permission (the native broker keeps the dialog to once per process). */
  private readonly asked = new Map<string, Promise<boolean>>();
  /** The manifest's permissions; null: unknown (all count as declared). Read on first use. */
  private manifest: Set<string> | null | undefined;

  constructor(natives: XrNatives, report: (error: unknown) => void) {
    this.natives = natives;
    this.report = report;
  }

  /**
   * Resolves each name to whether the app holds it. The names not asked for yet go to the system in one request
   * (one dialog); a name asked for before is not asked again, but a denial is re-checked (no dialog), so a grant
   * made in Settings since counts. Never rejects: a failed request counts as denied.
   */
  async request(names: readonly string[]): Promise<Record<string, boolean>> {
    // one the manifest does not declare cannot be granted: denied without asking (the system would still start its
    // dialog activity, which pauses the session)
    for (const n of names) if (!this.asked.has(n) && !this.declared(n)) this.asked.set(n, Promise.resolve(false));
    const fresh = [...new Set(names)].filter((n) => !this.asked.has(n));
    if (fresh.length > 0) {
      const answer = this.ask(fresh);
      for (const n of fresh) this.asked.set(n, answer.then((r) => r[n] === true));
    }
    const out: Record<string, boolean> = {};
    for (const n of names) out[n] = (await this.asked.get(n)!) || this.check(n);
    return out;
  }

  /** Whether the app's manifest declares `name` (true when the runtime cannot tell). */
  declared(name: string): boolean {
    if (this.manifest === undefined) {
      let list: readonly string[] | null = null;
      try {
        list = this.natives.declaredPermissions?.() ?? null;
      } catch (error) {
        this.report(error);
      }
      this.manifest = list ? new Set(list) : null;
    }
    return this.manifest === null || this.manifest.has(name);
  }

  private ask(names: string[]): Promise<Record<string, boolean>> {
    const request = this.natives.requestPermissions;
    // A runtime without the helper (host tests, an older template): the manifest's install-time grant is all
    // there is, so the feature's own native call decides.
    if (typeof request !== 'function') return Promise.resolve(Object.fromEntries(names.map((n) => [n, true])));
    return Promise.resolve()
      .then(() => request.call(this.natives, names))
      .then(
        (r) => r ?? {},
        (error: unknown) => {
          this.report(error);
          return {};
        },
      );
  }

  private check(name: string): boolean {
    const check = this.natives.checkPermissions;
    if (typeof check !== 'function') return false;
    try {
      return check.call(this.natives, [name])?.[name] === true;
    } catch {
      return false;
    }
  }
}
