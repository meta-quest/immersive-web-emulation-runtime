/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Tracks property overrides and restores them in reverse order.
 *
 * A failed patch is never recorded, so callers can safely try an instance
 * first and then fall back to its prototype.
 */
export class PatchRegistry {
  private entries: Array<{
    target: object;
    key: PropertyKey;
    descriptor: PropertyDescriptor | undefined;
  }> = [];

  get size(): number {
    return this.entries.length;
  }

  define(
    target: object,
    key: PropertyKey,
    descriptor: PropertyDescriptor,
  ): boolean {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    try {
      Object.defineProperty(target, key, descriptor);
      this.entries.push({ target, key, descriptor: previous });
      return true;
    } catch {
      return false;
    }
  }

  revert(): void {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const { target, key, descriptor } = this.entries[index];
      try {
        if (descriptor) {
          Object.defineProperty(target, key, descriptor);
        } else {
          Reflect.deleteProperty(target, key);
        }
      } catch {
        // Restoration is best-effort for host objects. Callers should expose a
        // capability failure rather than mask the original application error.
      }
    }
    this.entries = [];
  }
}
