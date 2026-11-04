/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Shortens `list` to `length` without giving up its storage.
 *
 * For arrays that are emptied and refilled every frame. V8 drops an array's
 * backing store when its length is set to 0 (`list.length = 0`, `splice`), so
 * the next push allocates a new one: about 150 bytes per array per frame.
 * Popping keeps the store (measured on V8 13.6 and 14.6), and these
 * lists hold a handful of entries.
 */
export function truncateArray(list: unknown[], length: number): void {
  while (list.length > length) {
    list.pop();
  }
}
