/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Buffer;
export function decodePng(buf: Uint8Array): { width: number; height: number; data: Uint8Array };
export function comparePixels(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  height: number,
  threshold?: number,
): { fraction: number; bad: number; maxDiff: number };
export function diffImage(a: ArrayLike<number>, b: ArrayLike<number>, width: number, height: number, threshold?: number): Uint8Array;
