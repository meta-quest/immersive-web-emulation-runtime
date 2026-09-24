/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { DoubleSide, MeshDepthMaterial, RGBADepthPacking } from 'three';

const BYTE_RADIX = 256;
const BYTE_RADIX_SQUARED = BYTE_RADIX ** 2;
const BYTE_RADIX_CUBED = BYTE_RADIX ** 3;
const BYTE_MAX = 255;

/** Decode the bytes produced by Three.js's `packDepthToRGBA`. */
export function unpackRGBADepthBytes(
  r: number,
  g: number,
  b: number,
  a: number,
): number {
  // Three.js's UnpackFactors4 applies UnpackDownscale (255 / 256) to R/G/B
  // after normalizing the RGBA8 bytes. Folding those operations together
  // gives base-256 divisors for RGB; treating the bytes as ordinary normalized
  // colors makes depth about 0.4% too large and can push it past the far plane.
  return (
    r / BYTE_RADIX +
    g / BYTE_RADIX_SQUARED +
    b / BYTE_RADIX_CUBED +
    a / (BYTE_MAX * BYTE_RADIX_CUBED)
  );
}

/** Convert WebGL's non-linear perspective depth into eye-space meters. */
export function perspectiveDepthToMeters(
  normalizedDepth: number,
  depthNear: number,
  depthFar: number,
): number {
  if (normalizedDepth >= 1 || normalizedDepth <= 0) {
    return depthFar;
  }
  return (
    (depthNear * depthFar) /
    (depthFar - normalizedDepth * (depthFar - depthNear))
  );
}

/** Build the depth-only material used for synthetic environment geometry. */
export function createEnvironmentDepthMaterial(): MeshDepthMaterial {
  return new MeshDepthMaterial({
    depthPacking: RGBADepthPacking,
    // Room surfaces must occlude from either viewing direction. A front-side
    // pass lets content show through the underside of one-sided SEM meshes.
    side: DoubleSide,
  });
}
