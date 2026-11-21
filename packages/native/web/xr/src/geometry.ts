/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// DOMPointReadOnly / DOMPoint (W3C Geometry Interfaces Module Level 1, §2), installed only when no other runtime
// layer provides them: WebXR returns them (XRRigidTransform.position/orientation, XRBoundedReferenceSpace
// .boundsGeometry), so IWER needs them on the global. matrixTransform accepts any DOMMatrix-like object (m11..m44).

interface MatrixLike {
  m11: number; m12: number; m13: number; m14: number;
  m21: number; m22: number; m23: number; m24: number;
  m31: number; m32: number; m33: number; m34: number;
  m41: number; m42: number; m43: number; m44: number;
}

interface PointInit {
  x?: number;
  y?: number;
  z?: number;
  w?: number;
}

const X = Symbol('x');
const Y = Symbol('y');
const Z = Symbol('z');
const W = Symbol('w');

class DOMPointReadOnly {
  [X]: number;
  [Y]: number;
  [Z]: number;
  [W]: number;

  constructor(x: number = 0, y: number = 0, z: number = 0, w: number = 1) {
    this[X] = Number(x);
    this[Y] = Number(y);
    this[Z] = Number(z);
    this[W] = Number(w);
  }

  static fromPoint(other: PointInit = {}): DOMPointReadOnly {
    return new this(other.x ?? 0, other.y ?? 0, other.z ?? 0, other.w ?? 1);
  }

  get x(): number {
    return this[X];
  }
  get y(): number {
    return this[Y];
  }
  get z(): number {
    return this[Z];
  }
  get w(): number {
    return this[W];
  }

  matrixTransform(matrix: MatrixLike): DOMPoint {
    const { x, y, z, w } = this;
    const m = matrix;
    return new DOMPoint(
      m.m11 * x + m.m21 * y + m.m31 * z + m.m41 * w,
      m.m12 * x + m.m22 * y + m.m32 * z + m.m42 * w,
      m.m13 * x + m.m23 * y + m.m33 * z + m.m43 * w,
      m.m14 * x + m.m24 * y + m.m34 * z + m.m44 * w,
    );
  }

  toJSON(): { x: number; y: number; z: number; w: number } {
    return { x: this.x, y: this.y, z: this.z, w: this.w };
  }
}

class DOMPoint extends DOMPointReadOnly {
  static override fromPoint(other: PointInit = {}): DOMPoint {
    return new DOMPoint(other.x ?? 0, other.y ?? 0, other.z ?? 0, other.w ?? 1);
  }
  override get x(): number {
    return this[X];
  }
  set x(v: number) {
    this[X] = Number(v);
  }
  override get y(): number {
    return this[Y];
  }
  set y(v: number) {
    this[Y] = Number(v);
  }
  override get z(): number {
    return this[Z];
  }
  set z(v: number) {
    this[Z] = Number(v);
  }
  override get w(): number {
    return this[W];
  }
  set w(v: number) {
    this[W] = Number(v);
  }
}

/** Installs DOMPointReadOnly and DOMPoint on `g` when they are missing; returns the names it installed. */
export function installGeometry(g: Record<string, unknown>): string[] {
  const installed: string[] = [];
  for (const [name, value] of [
    ['DOMPointReadOnly', DOMPointReadOnly],
    ['DOMPoint', DOMPoint],
  ] as const) {
    if (typeof g[name] === 'function') continue;
    Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
    installed.push(name);
  }
  return installed;
}
