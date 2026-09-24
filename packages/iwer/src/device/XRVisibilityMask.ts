/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Positive angular extents, in radians, from the optical axis. */
export interface XRFieldOfView {
  angleLeft: number;
  angleRight: number;
  angleUp: number;
  angleDown: number;
}

/** Per-eye visible field used to obscure content outside a target headset FOV. */
export interface XRVisibilityMask {
  left: XRFieldOfView;
  right: XRFieldOfView;
}

/** Pixel bounds of the visible opening inside one emulated eye viewport. */
export interface XRVisibilityMaskBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Convert angular target bounds into a rectangular opening in an IWER preview.
 *
 * The preview projection is symmetric and described by `previewFovY`. Target
 * bounds may be asymmetric, so the resulting opening need not be centered.
 */
export function calculateVisibilityMaskBounds(
  fieldOfView: XRFieldOfView,
  previewFovY: number,
  viewportWidth: number,
  viewportHeight: number,
): XRVisibilityMaskBounds {
  if (
    !Number.isFinite(previewFovY) ||
    previewFovY <= 0 ||
    previewFovY >= Math.PI ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const previewTanY = Math.tan(previewFovY / 2);
  const previewTanX = previewTanY * (viewportWidth / viewportHeight);
  const leftNdc = clamp(-Math.tan(fieldOfView.angleLeft) / previewTanX, -1, 1);
  const rightNdc = clamp(Math.tan(fieldOfView.angleRight) / previewTanX, -1, 1);
  const bottomNdc = clamp(
    -Math.tan(fieldOfView.angleDown) / previewTanY,
    -1,
    1,
  );
  const topNdc = clamp(Math.tan(fieldOfView.angleUp) / previewTanY, -1, 1);

  const x = ((leftNdc + 1) / 2) * viewportWidth;
  const right = ((rightNdc + 1) / 2) * viewportWidth;
  const y = ((1 - topNdc) / 2) * viewportHeight;
  const bottom = ((1 - bottomNdc) / 2) * viewportHeight;

  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}
