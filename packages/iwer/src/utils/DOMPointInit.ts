/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

function toDouble(
  value: number | undefined,
  defaultValue: number,
  restricted: boolean,
): number {
  const converted = value === undefined ? defaultValue : +value;
  if (restricted && !Number.isFinite(converted)) {
    throw new TypeError('Restricted double value must be finite');
  }
  return converted;
}

export function convertDOMPointInit(
  point?: DOMPointInit | null,
  defaultZ = 0,
  defaultW = 1,
  restricted = false,
): Required<DOMPointInit> {
  // WebIDL reads and converts dictionary members in lexicographic order.
  return {
    w: toDouble(point?.w, defaultW, restricted),
    x: toDouble(point?.x, 0, restricted),
    y: toDouble(point?.y, 0, restricted),
    z: toDouble(point?.z, defaultZ, restricted),
  };
}
