/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mat4 } from 'gl-matrix';

/*
 * 4x4 helpers for host mode's per-frame pose math. Poses and the offsets of
 * reference spaces are affine (bottom row exactly 0 0 0 1), which these
 * exploit. The shortcuts are only taken when they give the general result
 * (up to the sign of a zero): matrices that are not affine, and inputs with
 * a NaN or infinite entry (whose full products and determinants turn NaN),
 * take the general path.
 */

/** Whether `x` is finite (x - x is NaN for NaN and for either infinity). */
function finite(x: number): boolean {
  return x - x === 0;
}

/** Whether `m`'s bottom row is exactly 0 0 0 1 (column-major). */
export function isAffine(m: mat4): boolean {
  return m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1;
}

/**
 * `out[at .. at + 15] = a * b`, column-major 4x4, as gl-matrix's multiply.
 *
 * Every matrix here is normally affine (bottom row 0 0 0 1: poses, and offsets
 * made from XRRigidTransforms), and then the product needs 36 multiplies
 * instead of 64. The terms skipped are products with those exact zeros and
 * ones, so the result is the same (up to the sign of a zero) as long as the
 * other factor of each is finite. Every computed entry is finite exactly
 * when every input entry it used is (an infinite or NaN term never sums to
 * a finite value), and each input entry of the 3x3 parts and translations
 * feeds some computed entry, so the result is checked rather than the
 * inputs: when any entry is not finite, the general product is redone.
 * Anything not affine, or written over one of its inputs, takes the general
 * product too (`out` may alias `a` or `b`).
 */
export function multiplyInto(out: mat4, at: number, a: mat4, b: mat4): void {
  const a00 = a[0];
  const a01 = a[1];
  const a02 = a[2];
  const a03 = a[3];
  const a10 = a[4];
  const a11 = a[5];
  const a12 = a[6];
  const a13 = a[7];
  const a20 = a[8];
  const a21 = a[9];
  const a22 = a[10];
  const a23 = a[11];
  const a30 = a[12];
  const a31 = a[13];
  const a32 = a[14];
  const a33 = a[15];
  if (
    a03 === 0 &&
    a13 === 0 &&
    a23 === 0 &&
    a33 === 1 &&
    b[3] === 0 &&
    b[7] === 0 &&
    b[11] === 0 &&
    b[15] === 1 &&
    // written in place below, so `out` must not be an input (the general
    // product reads each column of `b` before writing it)
    out !== a &&
    out !== b
  ) {
    // the sum of every computed entry: finite exactly when each one is
    // (or, rarely, a finite sum overflows, which only costs the redo)
    let sum = 0;
    for (let c = 0; c < 12; c += 4) {
      const b0 = b[c];
      const b1 = b[c + 1];
      const b2 = b[c + 2];
      const x = b0 * a00 + b1 * a10 + b2 * a20;
      const y = b0 * a01 + b1 * a11 + b2 * a21;
      const z = b0 * a02 + b1 * a12 + b2 * a22;
      out[at + c] = x;
      out[at + c + 1] = y;
      out[at + c + 2] = z;
      out[at + c + 3] = 0;
      sum += x + y + z;
    }
    const b0 = b[12];
    const b1 = b[13];
    const b2 = b[14];
    const x = b0 * a00 + b1 * a10 + b2 * a20 + a30;
    const y = b0 * a01 + b1 * a11 + b2 * a21 + a31;
    const z = b0 * a02 + b1 * a12 + b2 * a22 + a32;
    out[at + 12] = x;
    out[at + 13] = y;
    out[at + 14] = z;
    out[at + 15] = 1;
    if (finite(sum + x + y + z)) {
      return;
    }
    // a NaN or infinite entry: redo it as the general product, whose
    // 0 * x terms then turn NaN as gl-matrix's do (inputs are untouched)
  }
  generalMultiply(out, at, a, b);
}

/** The full 4x4 product, as gl-matrix's multiply (`out` may alias). */
function generalMultiply(out: mat4, at: number, a: mat4, b: mat4): void {
  const a00 = a[0];
  const a01 = a[1];
  const a02 = a[2];
  const a03 = a[3];
  const a10 = a[4];
  const a11 = a[5];
  const a12 = a[6];
  const a13 = a[7];
  const a20 = a[8];
  const a21 = a[9];
  const a22 = a[10];
  const a23 = a[11];
  const a30 = a[12];
  const a31 = a[13];
  const a32 = a[14];
  const a33 = a[15];
  for (let c = 0; c < 16; c += 4) {
    const b0 = b[c];
    const b1 = b[c + 1];
    const b2 = b[c + 2];
    const b3 = b[c + 3];
    out[at + c] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[at + c + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[at + c + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[at + c + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
}

/**
 * `out = inverse(m)`; false (out unchanged) when `m` is singular. For an
 * affine `m` only its 3x3 part is inverted (cofactors) and the translation
 * is carried through, about a third of the work of a general 4x4 inverse.
 * A matrix with a NaN or infinite entry goes to gl-matrix, whose 4x4
 * determinant is then NaN (so the answer is false, as it always was); such
 * entries are found from the inverse translation, which every input entry
 * enters.
 * `out` may be `m`.
 */
export function invertAffine(out: mat4, m: mat4): boolean {
  if (!isAffine(m)) {
    return mat4.invert(out, m) !== null;
  }
  const a00 = m[0];
  const a01 = m[1];
  const a02 = m[2];
  const a10 = m[4];
  const a11 = m[5];
  const a12 = m[6];
  const a20 = m[8];
  const a21 = m[9];
  const a22 = m[10];
  const tx = m[12];
  const ty = m[13];
  const tz = m[14];
  const c00 = a22 * a11 - a12 * a21;
  const c10 = -a22 * a10 + a12 * a20;
  const c20 = a21 * a10 - a11 * a20;
  let det = a00 * c00 + a01 * c10 + a02 * c20;
  if (!det) {
    return false;
  }
  det = 1 / det;
  const r00 = c00 * det;
  const r01 = (-a22 * a01 + a02 * a21) * det;
  const r02 = (a12 * a01 - a02 * a11) * det;
  const r10 = c10 * det;
  const r11 = (a22 * a00 - a02 * a20) * det;
  const r12 = (-a12 * a00 + a02 * a10) * det;
  const r20 = c20 * det;
  const r21 = (-a21 * a00 + a01 * a20) * det;
  const r22 = (a11 * a00 - a01 * a10) * det;
  const t0 = -(r00 * tx + r10 * ty + r20 * tz);
  const t1 = -(r01 * tx + r11 * ty + r21 * tz);
  const t2 = -(r02 * tx + r12 * ty + r22 * tz);
  // every inverse entry and every translation enters t0..t2, so they are
  // all finite unless an input entry is NaN or infinite (or the inverse is
  // too large to hold): then gl-matrix decides, exactly
  if (!finite(t0 + t1 + t2)) {
    return mat4.invert(out, m) !== null;
  }
  out[0] = r00;
  out[1] = r01;
  out[2] = r02;
  out[3] = 0;
  out[4] = r10;
  out[5] = r11;
  out[6] = r12;
  out[7] = 0;
  out[8] = r20;
  out[9] = r21;
  out[10] = r22;
  out[11] = 0;
  out[12] = t0;
  out[13] = t1;
  out[14] = t2;
  out[15] = 1;
  return true;
}
