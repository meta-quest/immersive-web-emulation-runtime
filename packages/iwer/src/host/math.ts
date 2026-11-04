/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { mat4 } from 'gl-matrix';

/** Numbers per view in {@link XRHostFrame.views}. */
export const HOST_VIEW_STRIDE = 11;

/**
 * Writes the WebGL projection matrix for an off-axis view frustum described
 * the OpenXR way, by four angles from the view direction (radians; the left
 * and down edges usually have negative angles).
 *
 * At distance `near` the frustum edges are `near * tan(angle)`, which turns
 * the classic glFrustum matrix into one that depends only on the tangents.
 * Clip-space depth runs from -1 (near) to +1 (far), the OpenGL/WebGL
 * convention, and `far` may be `Infinity`. Column-major, writes into `out`.
 */
export function hostPerspective(
  out: mat4,
  angleLeft: number,
  angleRight: number,
  angleUp: number,
  angleDown: number,
  near: number,
  far: number,
): mat4 {
  const xMin = Math.tan(angleLeft);
  const xMax = Math.tan(angleRight);
  const yMin = Math.tan(angleDown);
  const yMax = Math.tan(angleUp);
  const invSpanX = 1 / (xMax - xMin);
  const invSpanY = 1 / (yMax - yMin);

  for (let i = 0; i < 16; i++) {
    out[i] = 0;
  }
  // x and y scale: 2 / (frustum width and height at unit distance)
  out[0] = 2 * invSpanX;
  out[5] = 2 * invSpanY;
  // off-axis shift of the frustum centre
  out[8] = (xMax + xMin) * invSpanX;
  out[9] = (yMax + yMin) * invSpanY;
  // w = -z_eye
  out[11] = -1;
  // depth: maps -near to -1 and -far to +1
  if (far === Infinity) {
    out[10] = -1;
    out[14] = -2 * near;
  } else {
    const invDepth = 1 / (near - far);
    out[10] = (far + near) * invDepth;
    out[14] = 2 * far * near * invDepth;
  }
  return out;
}

/**
 * Builds a rigid-body matrix from seven numbers starting at `offset`:
 * translation x, y, z followed by a rotation quaternion x, y, z, w.
 */
export function hostPoseMatrix(
  out: mat4,
  src: ArrayLike<number>,
  offset: number,
): mat4 {
  // Self-contained rather than forwarding seven numbers to
  // hostPoseMatrixAt: doubles passed to a call that is not inlined are boxed,
  // which allocates a heap number per argument.
  let qx = src[offset + 3];
  let qy = src[offset + 4];
  let qz = src[offset + 5];
  let qw = src[offset + 6];
  let len = qx * qx + qy * qy + qz * qz + qw * qw;
  if (len > 0 && Math.abs(len - 1) > 1e-6) {
    len = 1 / Math.sqrt(len);
    qx *= len;
    qy *= len;
    qz *= len;
    qw *= len;
  } else if (len === 0) {
    qw = 1;
  }
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  out[0] = 1 - (yy + zz);
  out[1] = xy + wz;
  out[2] = xz - wy;
  out[3] = 0;
  out[4] = xy - wz;
  out[5] = 1 - (xx + zz);
  out[6] = yz + wx;
  out[7] = 0;
  out[8] = xz + wy;
  out[9] = yz - wx;
  out[10] = 1 - (xx + yy);
  out[11] = 0;
  out[12] = src[offset];
  out[13] = src[offset + 1];
  out[14] = src[offset + 2];
  out[15] = 1;
  return out;
}

/**
 * Rigid-body matrix from a translation and a quaternion (normalised here; a
 * zero quaternion is read as identity). Same formula as gl-matrix's
 * `mat4.fromRotationTranslation`.
 */
export function hostPoseMatrixAt(
  out: mat4,
  x: number,
  y: number,
  z: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): mat4 {
  let len = qx * qx + qy * qy + qz * qz + qw * qw;
  if (len > 0 && Math.abs(len - 1) > 1e-6) {
    len = 1 / Math.sqrt(len);
    qx *= len;
    qy *= len;
    qz *= len;
    qw *= len;
  } else if (len === 0) {
    qw = 1;
  }
  writeRotation(out, qx, qy, qz, qw);
  out[12] = x;
  out[13] = y;
  out[14] = z;
  out[15] = 1;
  return out;
}

/**
 * The rotation part (and the zero last row entries) of a rigid-body matrix
 * from a unit quaternion, as gl-matrix's `fromRotationTranslation` writes it.
 */
function writeRotation(
  out: mat4,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): void {
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  out[0] = 1 - (yy + zz);
  out[1] = xy + wz;
  out[2] = xz - wy;
  out[3] = 0;
  out[4] = xy - wz;
  out[5] = 1 - (xx + zz);
  out[6] = yz + wx;
  out[7] = 0;
  out[8] = xz + wy;
  out[9] = yz - wx;
  out[10] = 1 - (xx + yy);
  out[11] = 0;
}
