/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

function toDouble(value: number | undefined, defaultValue: number): number {
  return value === undefined ? defaultValue : +value;
}

export function convertDOMPointInit(
  point?: DOMPointInit | null,
  defaultZ = 0,
  defaultW = 1,
): Required<DOMPointInit> {
  // WebIDL reads and converts dictionary members in lexicographic order.
  return {
    w: toDouble(point?.w, defaultW),
    x: toDouble(point?.x, 0),
    y: toDouble(point?.y, 0),
    z: toDouble(point?.z, defaultZ),
  };
}
