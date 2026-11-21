/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Geometry Interfaces Level 1 (DOM-10): DOMRectReadOnly/DOMRect/DOMRectList, DOMMatrixReadOnly/DOMMatrix and DOMQuad.
// DOMPointReadOnly/DOMPoint come from web/xr's implementation (the same class IWER host mode uses), installed here
// first when they are missing so the page has one set of point classes whichever prelude runs first.

import { installGeometry } from '../../xr/src/geometry.ts';
import { G, str } from './env.ts';

export { installGeometry as installPoints };

const num = (v: unknown, d = 0): number => (v === undefined ? d : Number(v));

const RX = Symbol('x');
const RY = Symbol('y');
const RW = Symbol('w');
const RH = Symbol('h');

export class DOMRectReadOnly {
  declare [RX]: number;
  declare [RY]: number;
  declare [RW]: number;
  declare [RH]: number;
  constructor(x?: number, y?: number, width?: number, height?: number) {
    this[RX] = num(x);
    this[RY] = num(y);
    this[RW] = num(width);
    this[RH] = num(height);
  }
  static fromRect(
    other: { x?: number; y?: number; width?: number; height?: number } = {},
  ): DOMRectReadOnly {
    return new this(other.x, other.y, other.width, other.height);
  }
  get x(): number {
    return this[RX];
  }
  get y(): number {
    return this[RY];
  }
  get width(): number {
    return this[RW];
  }
  get height(): number {
    return this[RH];
  }
  get top(): number {
    return Math.min(this[RY], this[RY] + this[RH]);
  }
  get right(): number {
    return Math.max(this[RX], this[RX] + this[RW]);
  }
  get bottom(): number {
    return Math.max(this[RY], this[RY] + this[RH]);
  }
  get left(): number {
    return Math.min(this[RX], this[RX] + this[RW]);
  }
  toJSON(): Record<string, number> {
    return {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      top: this.top,
      right: this.right,
      bottom: this.bottom,
      left: this.left,
    };
  }
  get [Symbol.toStringTag](): string {
    return 'DOMRectReadOnly';
  }
}

export class DOMRect extends DOMRectReadOnly {
  static override fromRect(
    other: { x?: number; y?: number; width?: number; height?: number } = {},
  ): DOMRect {
    return new DOMRect(other.x, other.y, other.width, other.height);
  }
  override get x(): number {
    return this[RX];
  }
  override set x(v: number) {
    this[RX] = Number(v);
  }
  override get y(): number {
    return this[RY];
  }
  override set y(v: number) {
    this[RY] = Number(v);
  }
  override get width(): number {
    return this[RW];
  }
  override set width(v: number) {
    this[RW] = Number(v);
  }
  override get height(): number {
    return this[RH];
  }
  override set height(v: number) {
    this[RH] = Number(v);
  }
  override get [Symbol.toStringTag](): string {
    return 'DOMRect';
  }
}

export class DOMRectList extends Array<DOMRect> {
  item(i: number): DOMRect | null {
    return this[i] ?? null;
  }
  get [Symbol.toStringTag](): string {
    return 'DOMRectList';
  }
}

// --- DOMMatrix -------------------------------------------------------------------------------------------------
// Column-major m11..m44 as in the spec (m41/m42/m43 are the translation). is2D tracks whether only a..f matter.

const M = Symbol('m');
const IS2D = Symbol('is2D');
type Mat = Float64Array;

function identity(): Mat {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// m[(col-1)*4 + (row-1)] holds m<col><row>: m11=m[0], m12=m[1], ..., m41=m[12], m42=m[13], m43=m[14], m44=m[15].
function multiply(a: Mat, b: Mat): Mat {
  // result = a * b (apply b first, then a), with the spec's post-multiplication convention.
  const r = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row]! * b[col * 4 + k]!;
      r[col * 4 + row] = s;
    }
  }
  return r;
}

function invert(m: Mat): Mat | null {
  const inv = new Float64Array(16);
  inv[0] =
    m[5]! * m[10]! * m[15]! -
    m[5]! * m[11]! * m[14]! -
    m[9]! * m[6]! * m[15]! +
    m[9]! * m[7]! * m[14]! +
    m[13]! * m[6]! * m[11]! -
    m[13]! * m[7]! * m[10]!;
  inv[4] =
    -m[4]! * m[10]! * m[15]! +
    m[4]! * m[11]! * m[14]! +
    m[8]! * m[6]! * m[15]! -
    m[8]! * m[7]! * m[14]! -
    m[12]! * m[6]! * m[11]! +
    m[12]! * m[7]! * m[10]!;
  inv[8] =
    m[4]! * m[9]! * m[15]! -
    m[4]! * m[11]! * m[13]! -
    m[8]! * m[5]! * m[15]! +
    m[8]! * m[7]! * m[13]! +
    m[12]! * m[5]! * m[11]! -
    m[12]! * m[7]! * m[9]!;
  inv[12] =
    -m[4]! * m[9]! * m[14]! +
    m[4]! * m[10]! * m[13]! +
    m[8]! * m[5]! * m[14]! -
    m[8]! * m[6]! * m[13]! -
    m[12]! * m[5]! * m[10]! +
    m[12]! * m[6]! * m[9]!;
  inv[1] =
    -m[1]! * m[10]! * m[15]! +
    m[1]! * m[11]! * m[14]! +
    m[9]! * m[2]! * m[15]! -
    m[9]! * m[3]! * m[14]! -
    m[13]! * m[2]! * m[11]! +
    m[13]! * m[3]! * m[10]!;
  inv[5] =
    m[0]! * m[10]! * m[15]! -
    m[0]! * m[11]! * m[14]! -
    m[8]! * m[2]! * m[15]! +
    m[8]! * m[3]! * m[14]! +
    m[12]! * m[2]! * m[11]! -
    m[12]! * m[3]! * m[10]!;
  inv[9] =
    -m[0]! * m[9]! * m[15]! +
    m[0]! * m[11]! * m[13]! +
    m[8]! * m[1]! * m[15]! -
    m[8]! * m[3]! * m[13]! -
    m[12]! * m[1]! * m[11]! +
    m[12]! * m[3]! * m[9]!;
  inv[13] =
    m[0]! * m[9]! * m[14]! -
    m[0]! * m[10]! * m[13]! -
    m[8]! * m[1]! * m[14]! +
    m[8]! * m[2]! * m[13]! +
    m[12]! * m[1]! * m[10]! -
    m[12]! * m[2]! * m[9]!;
  inv[2] =
    m[1]! * m[6]! * m[15]! -
    m[1]! * m[7]! * m[14]! -
    m[5]! * m[2]! * m[15]! +
    m[5]! * m[3]! * m[14]! +
    m[13]! * m[2]! * m[7]! -
    m[13]! * m[3]! * m[6]!;
  inv[6] =
    -m[0]! * m[6]! * m[15]! +
    m[0]! * m[7]! * m[14]! +
    m[4]! * m[2]! * m[15]! -
    m[4]! * m[3]! * m[14]! -
    m[12]! * m[2]! * m[7]! +
    m[12]! * m[3]! * m[6]!;
  inv[10] =
    m[0]! * m[5]! * m[15]! -
    m[0]! * m[7]! * m[13]! -
    m[4]! * m[1]! * m[15]! +
    m[4]! * m[3]! * m[13]! +
    m[12]! * m[1]! * m[7]! -
    m[12]! * m[3]! * m[5]!;
  inv[14] =
    -m[0]! * m[5]! * m[14]! +
    m[0]! * m[6]! * m[13]! +
    m[4]! * m[1]! * m[14]! -
    m[4]! * m[2]! * m[13]! -
    m[12]! * m[1]! * m[6]! +
    m[12]! * m[2]! * m[5]!;
  inv[3] =
    -m[1]! * m[6]! * m[11]! +
    m[1]! * m[7]! * m[10]! +
    m[5]! * m[2]! * m[11]! -
    m[5]! * m[3]! * m[10]! -
    m[9]! * m[2]! * m[7]! +
    m[9]! * m[3]! * m[6]!;
  inv[7] =
    m[0]! * m[6]! * m[11]! -
    m[0]! * m[7]! * m[10]! -
    m[4]! * m[2]! * m[11]! +
    m[4]! * m[3]! * m[10]! +
    m[8]! * m[2]! * m[7]! -
    m[8]! * m[3]! * m[6]!;
  inv[11] =
    -m[0]! * m[5]! * m[11]! +
    m[0]! * m[7]! * m[9]! +
    m[4]! * m[1]! * m[11]! -
    m[4]! * m[3]! * m[9]! -
    m[8]! * m[1]! * m[7]! +
    m[8]! * m[3]! * m[5]!;
  inv[15] =
    m[0]! * m[5]! * m[10]! -
    m[0]! * m[6]! * m[9]! -
    m[4]! * m[1]! * m[10]! +
    m[4]! * m[2]! * m[9]! +
    m[8]! * m[1]! * m[6]! -
    m[8]! * m[2]! * m[5]!;
  const det =
    m[0]! * inv[0]! + m[1]! * inv[4]! + m[2]! * inv[8]! + m[3]! * inv[12]!;
  if (det === 0 || !Number.isFinite(det)) return null;
  for (let i = 0; i < 16; i++) inv[i] = inv[i]! / det;
  return inv;
}

const NAMES = [
  'm11',
  'm12',
  'm13',
  'm14',
  'm21',
  'm22',
  'm23',
  'm24',
  'm31',
  'm32',
  'm33',
  'm34',
  'm41',
  'm42',
  'm43',
  'm44',
] as const;
const ALIAS: Record<string, number> = { a: 0, b: 1, c: 4, d: 5, e: 12, f: 13 };

function parseTransformList(text: string): { m: Mat; is2D: boolean } {
  const s = text.trim();
  if (s === '' || s === 'none') return { m: identity(), is2D: true };
  let m = identity();
  let is2D = true;
  const re = /([a-zA-Z0-9]+)\(([^)]*)\)/g;
  let consumed = '';
  for (let x = re.exec(s); x; x = re.exec(s)) {
    consumed += x[0];
    const fn = x[1]!.toLowerCase();
    const args = x[2]!
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((a) => {
        const v = parseFloat(a);
        if (/deg$/.test(a)) return (v * Math.PI) / 180;
        if (/turn$/.test(a)) return v * 2 * Math.PI;
        if (/grad$/.test(a)) return (v * Math.PI) / 200;
        return v;
      });
    let t = identity();
    if (fn === 'matrix' && args.length === 6) {
      t[0] = args[0]!;
      t[1] = args[1]!;
      t[4] = args[2]!;
      t[5] = args[3]!;
      t[12] = args[4]!;
      t[13] = args[5]!;
    } else if (fn === 'matrix3d' && args.length === 16) {
      t = Float64Array.from(args);
      is2D = false;
    } else if (
      fn === 'translate' ||
      fn === 'translatex' ||
      fn === 'translatey'
    ) {
      t[12] = fn === 'translatey' ? 0 : (args[0] ?? 0);
      t[13] =
        fn === 'translatex'
          ? 0
          : fn === 'translatey'
            ? (args[0] ?? 0)
            : (args[1] ?? 0);
    } else if (fn === 'translate3d' || fn === 'translatez') {
      if (fn === 'translatez') t[14] = args[0] ?? 0;
      else {
        t[12] = args[0] ?? 0;
        t[13] = args[1] ?? 0;
        t[14] = args[2] ?? 0;
      }
      is2D = false;
    } else if (fn === 'scale' || fn === 'scalex' || fn === 'scaley') {
      t[0] = fn === 'scaley' ? 1 : (args[0] ?? 1);
      t[5] =
        fn === 'scalex'
          ? 1
          : fn === 'scaley'
            ? (args[0] ?? 1)
            : (args[1] ?? args[0] ?? 1);
    } else if (fn === 'rotate' || fn === 'rotatez') {
      const a = args[0] ?? 0;
      t[0] = Math.cos(a);
      t[1] = Math.sin(a);
      t[4] = -Math.sin(a);
      t[5] = Math.cos(a);
    } else if (fn === 'skewx') {
      t[4] = Math.tan(args[0] ?? 0);
    } else if (fn === 'skewy') {
      t[1] = Math.tan(args[0] ?? 0);
    } else throw new SyntaxError(`Failed to parse '${text}'.`);
    m = multiply(m, t);
  }
  if (consumed.replace(/\s/g, '') !== s.replace(/\s/g, ''))
    throw new SyntaxError(`Failed to parse '${text}'.`);
  return { m, is2D };
}

function fromInit(init: Record<string, unknown> | undefined | null): {
  m: Mat;
  is2D: boolean;
} {
  const m = identity();
  if (!init) return { m, is2D: true };
  let is2D = true;
  for (const [k, i] of Object.entries(ALIAS)) {
    const named = NAMES[i]!;
    const v = init[named] ?? init[k];
    if (v !== undefined) m[i] = Number(v);
  }
  for (const k of [
    'm13',
    'm14',
    'm23',
    'm24',
    'm31',
    'm32',
    'm34',
    'm43',
  ] as const) {
    if (init[k] !== undefined && Number(init[k]) !== 0) is2D = false;
    if (init[k] !== undefined) m[NAMES.indexOf(k)] = Number(init[k]);
  }
  for (const k of ['m33', 'm44'] as const) {
    if (init[k] !== undefined && Number(init[k]) !== 1) is2D = false;
    if (init[k] !== undefined) m[NAMES.indexOf(k)] = Number(init[k]);
  }
  if (init.is2D === false) is2D = false;
  return { m, is2D };
}

function point(x: number, y: number, z: number, w: number): unknown {
  const P = G.DOMPoint;
  return typeof P === 'function' ? new P(x, y, z, w) : { x, y, z, w };
}

export class DOMMatrixReadOnly {
  declare [M]: Mat;
  declare [IS2D]: boolean;
  constructor(init?: string | ArrayLike<number>) {
    let m = identity();
    let is2D = true;
    if (typeof init === 'string') ({ m, is2D } = parseTransformList(init));
    else if (init !== undefined && init !== null) {
      const a = Array.from(init as ArrayLike<number>, Number);
      if (a.length === 6) {
        m[0] = a[0]!;
        m[1] = a[1]!;
        m[4] = a[2]!;
        m[5] = a[3]!;
        m[12] = a[4]!;
        m[13] = a[5]!;
      } else if (a.length === 16) {
        m = Float64Array.from(a);
        is2D = false;
      } else
        throw new TypeError(
          `Failed to construct 'DOMMatrix': The sequence must contain 6 elements for a 2D matrix or 16 elements for a 3D matrix.`,
        );
    }
    this[M] = m;
    this[IS2D] = is2D;
  }
  static fromMatrix(other?: any): DOMMatrixReadOnly {
    const r = new this();
    const { m, is2D } =
      other instanceof DOMMatrixReadOnly
        ? { m: Float64Array.from(other[M]), is2D: other[IS2D] }
        : fromInit(other);
    r[M] = m;
    r[IS2D] = is2D;
    return r;
  }
  static fromFloat32Array(a: Float32Array): DOMMatrixReadOnly {
    return new this(Array.from(a));
  }
  static fromFloat64Array(a: Float64Array): DOMMatrixReadOnly {
    return new this(Array.from(a));
  }
  get is2D(): boolean {
    return this[IS2D];
  }
  get isIdentity(): boolean {
    const m = this[M];
    for (let i = 0; i < 16; i++)
      if (m[i] !== (i % 5 === 0 ? 1 : 0)) return false;
    return true;
  }
  translate(tx = 0, ty = 0, tz = 0): DOMMatrix {
    return DOMMatrix.fromMatrix(this).translateSelf(tx, ty, tz);
  }
  scale(sx = 1, sy?: number, sz = 1, ox = 0, oy = 0, oz = 0): DOMMatrix {
    return DOMMatrix.fromMatrix(this).scaleSelf(sx, sy, sz, ox, oy, oz);
  }
  scale3d(s = 1, ox = 0, oy = 0, oz = 0): DOMMatrix {
    return DOMMatrix.fromMatrix(this).scale3dSelf(s, ox, oy, oz);
  }
  rotate(rx = 0, ry?: number, rz?: number): DOMMatrix {
    return DOMMatrix.fromMatrix(this).rotateSelf(rx, ry, rz);
  }
  rotateAxisAngle(x = 0, y = 0, z = 0, angle = 0): DOMMatrix {
    return DOMMatrix.fromMatrix(this).rotateAxisAngleSelf(x, y, z, angle);
  }
  skewX(sx = 0): DOMMatrix {
    return DOMMatrix.fromMatrix(this).skewXSelf(sx);
  }
  skewY(sy = 0): DOMMatrix {
    return DOMMatrix.fromMatrix(this).skewYSelf(sy);
  }
  multiply(other?: any): DOMMatrix {
    return DOMMatrix.fromMatrix(this).multiplySelf(other);
  }
  flipX(): DOMMatrix {
    return this.multiply({ a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  }
  flipY(): DOMMatrix {
    return this.multiply({ a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 });
  }
  inverse(): DOMMatrix {
    return DOMMatrix.fromMatrix(this).invertSelf();
  }
  transformPoint(
    p: { x?: number; y?: number; z?: number; w?: number } = {},
  ): unknown {
    const m = this[M];
    const x = num(p.x),
      y = num(p.y),
      z = num(p.z),
      w = num(p.w, 1);
    return point(
      m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w,
      m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w,
      m[2]! * x + m[6]! * y + m[10]! * z + m[14]! * w,
      m[3]! * x + m[7]! * y + m[11]! * z + m[15]! * w,
    );
  }
  toFloat32Array(): Float32Array {
    return Float32Array.from(this[M]);
  }
  toFloat64Array(): Float64Array {
    return Float64Array.from(this[M]);
  }
  toJSON(): Record<string, unknown> {
    const o: Record<string, unknown> = {
      a: this.a,
      b: this.b,
      c: this.c,
      d: this.d,
      e: this.e,
      f: this.f,
    };
    NAMES.forEach((n, i) => (o[n] = this[M][i]));
    o.is2D = this.is2D;
    o.isIdentity = this.isIdentity;
    return o;
  }
  toString(): string {
    const m = this[M];
    if (!m.every(Number.isFinite))
      throw new Error('InvalidStateError: the matrix has non-finite values');
    return this[IS2D]
      ? `matrix(${[m[0], m[1], m[4], m[5], m[12], m[13]].join(', ')})`
      : `matrix3d(${Array.from(m).join(', ')})`;
  }
  get [Symbol.toStringTag](): string {
    return 'DOMMatrixReadOnly';
  }
}
for (const [i, n] of NAMES.entries()) {
  Object.defineProperty(DOMMatrixReadOnly.prototype, n, {
    get(this: DOMMatrixReadOnly) {
      return this[M][i];
    },
    configurable: true,
    enumerable: true,
  });
}
for (const [k, i] of Object.entries(ALIAS)) {
  Object.defineProperty(DOMMatrixReadOnly.prototype, k, {
    get(this: DOMMatrixReadOnly) {
      return this[M][i];
    },
    configurable: true,
    enumerable: true,
  });
}
export interface DOMMatrixReadOnly {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
  readonly m11: number;
  readonly m12: number;
  readonly m13: number;
  readonly m14: number;
  readonly m21: number;
  readonly m22: number;
  readonly m23: number;
  readonly m24: number;
  readonly m31: number;
  readonly m32: number;
  readonly m33: number;
  readonly m34: number;
  readonly m41: number;
  readonly m42: number;
  readonly m43: number;
  readonly m44: number;
}

export class DOMMatrix extends DOMMatrixReadOnly {
  static override fromMatrix(other?: any): DOMMatrix {
    const r = new DOMMatrix();
    const { m, is2D } =
      other instanceof DOMMatrixReadOnly
        ? { m: Float64Array.from(other[M]), is2D: other[IS2D] }
        : fromInit(other);
    r[M] = m;
    r[IS2D] = is2D;
    return r;
  }
  static override fromFloat32Array(a: Float32Array): DOMMatrix {
    return new DOMMatrix(Array.from(a));
  }
  static override fromFloat64Array(a: Float64Array): DOMMatrix {
    return new DOMMatrix(Array.from(a));
  }
  multiplySelf(other?: any): this {
    const o =
      other instanceof DOMMatrixReadOnly
        ? { m: other[M], is2D: other[IS2D] }
        : fromInit(other);
    this[M] = multiply(this[M], o.m);
    this[IS2D] = this[IS2D] && o.is2D;
    return this;
  }
  preMultiplySelf(other?: any): this {
    const o =
      other instanceof DOMMatrixReadOnly
        ? { m: other[M], is2D: other[IS2D] }
        : fromInit(other);
    this[M] = multiply(o.m, this[M]);
    this[IS2D] = this[IS2D] && o.is2D;
    return this;
  }
  translateSelf(tx = 0, ty = 0, tz = 0): this {
    const t = identity();
    t[12] = Number(tx);
    t[13] = Number(ty);
    t[14] = Number(tz);
    this[M] = multiply(this[M], t);
    if (Number(tz) !== 0) this[IS2D] = false;
    return this;
  }
  scaleSelf(sx = 1, sy?: number, sz = 1, ox = 0, oy = 0, oz = 0): this {
    this.translateSelf(ox, oy, oz);
    const t = identity();
    t[0] = Number(sx);
    t[5] = Number(sy ?? sx);
    t[10] = Number(sz);
    this[M] = multiply(this[M], t);
    this.translateSelf(-ox, -oy, -oz);
    if (Number(sz) !== 1 || Number(oz) !== 0) this[IS2D] = false;
    return this;
  }
  scale3dSelf(s = 1, ox = 0, oy = 0, oz = 0): this {
    return this.scaleSelf(s, s, s, ox, oy, oz);
  }
  rotateSelf(rx = 0, ry?: number, rz?: number): this {
    if (ry === undefined && rz === undefined) {
      rz = rx;
      rx = 0;
      ry = 0;
    }
    ry ??= 0;
    rz ??= 0;
    if (rz) this.rotateAxisAngleSelf(0, 0, 1, rz);
    if (ry) this.rotateAxisAngleSelf(0, 1, 0, ry);
    if (rx) this.rotateAxisAngleSelf(1, 0, 0, rx);
    return this;
  }
  rotateAxisAngleSelf(x = 0, y = 0, z = 0, angle = 0): this {
    const len = Math.hypot(x, y, z);
    if (len === 0) return this;
    x /= len;
    y /= len;
    z /= len;
    const a = (Number(angle) * Math.PI) / 180;
    const s = Math.sin(a / 2),
      c = Math.cos(a / 2);
    const sc = s * c,
      sq = s * s;
    const t = identity();
    t[0] = 1 - 2 * (y * y + z * z) * sq;
    t[1] = 2 * (x * y * sq + z * sc);
    t[2] = 2 * (x * z * sq - y * sc);
    t[4] = 2 * (x * y * sq - z * sc);
    t[5] = 1 - 2 * (x * x + z * z) * sq;
    t[6] = 2 * (y * z * sq + x * sc);
    t[8] = 2 * (x * z * sq + y * sc);
    t[9] = 2 * (y * z * sq - x * sc);
    t[10] = 1 - 2 * (x * x + y * y) * sq;
    this[M] = multiply(this[M], t);
    if (x !== 0 || y !== 0) this[IS2D] = false;
    return this;
  }
  skewXSelf(sx = 0): this {
    const t = identity();
    t[4] = Math.tan((Number(sx) * Math.PI) / 180);
    this[M] = multiply(this[M], t);
    return this;
  }
  skewYSelf(sy = 0): this {
    const t = identity();
    t[1] = Math.tan((Number(sy) * Math.PI) / 180);
    this[M] = multiply(this[M], t);
    return this;
  }
  invertSelf(): this {
    const inv = invert(this[M]);
    if (!inv) {
      this[M] = new Float64Array(16).fill(NaN);
      this[IS2D] = false;
    } else this[M] = inv;
    return this;
  }
  setMatrixValue(text: string): this {
    const { m, is2D } = parseTransformList(str(text));
    this[M] = m;
    this[IS2D] = is2D;
    return this;
  }
  override get [Symbol.toStringTag](): string {
    return 'DOMMatrix';
  }
}
for (const [i, n] of NAMES.entries()) {
  Object.defineProperty(DOMMatrix.prototype, n, {
    get(this: DOMMatrix) {
      return this[M][i];
    },
    set(this: DOMMatrix, v: number) {
      this[M][i] = Number(v);
      if (
        (i === 2 ||
          i === 3 ||
          i === 6 ||
          i === 7 ||
          i === 8 ||
          i === 9 ||
          i === 11 ||
          i === 14) &&
        Number(v) !== 0
      )
        this[IS2D] = false;
      if ((i === 10 || i === 15) && Number(v) !== 1) this[IS2D] = false;
    },
    configurable: true,
    enumerable: true,
  });
}
for (const [k, i] of Object.entries(ALIAS)) {
  Object.defineProperty(DOMMatrix.prototype, k, {
    get(this: DOMMatrix) {
      return this[M][i];
    },
    set(this: DOMMatrix, v: number) {
      this[M][i] = Number(v);
    },
    configurable: true,
    enumerable: true,
  });
}

export class DOMQuad {
  readonly p1: unknown;
  readonly p2: unknown;
  readonly p3: unknown;
  readonly p4: unknown;
  constructor(
    p1: Record<string, number> = {},
    p2: Record<string, number> = {},
    p3: Record<string, number> = {},
    p4: Record<string, number> = {},
  ) {
    const mk = (p: Record<string, number>) =>
      point(num(p.x), num(p.y), num(p.z), num(p.w, 1));
    this.p1 = mk(p1);
    this.p2 = mk(p2);
    this.p3 = mk(p3);
    this.p4 = mk(p4);
  }
  static fromRect(
    r: { x?: number; y?: number; width?: number; height?: number } = {},
  ): DOMQuad {
    const x = num(r.x),
      y = num(r.y),
      w = num(r.width),
      h = num(r.height);
    return new DOMQuad(
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    );
  }
  static fromQuad(q: Record<string, Record<string, number>> = {}): DOMQuad {
    return new DOMQuad(q.p1, q.p2, q.p3, q.p4);
  }
  getBounds(): DOMRect {
    const ps = [this.p1, this.p2, this.p3, this.p4] as Array<{
      x: number;
      y: number;
    }>;
    const xs = ps.map((p) => p.x);
    const ys = ps.map((p) => p.y);
    const minX = Math.min(...xs),
      minY = Math.min(...ys);
    return new DOMRect(
      minX,
      minY,
      Math.max(...xs) - minX,
      Math.max(...ys) - minY,
    );
  }
  toJSON(): Record<string, unknown> {
    return { p1: this.p1, p2: this.p2, p3: this.p3, p4: this.p4 };
  }
  get [Symbol.toStringTag](): string {
    return 'DOMQuad';
  }
}
