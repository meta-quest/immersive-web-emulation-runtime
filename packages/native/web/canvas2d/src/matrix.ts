/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** 2D affine transforms in canvas order [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f). */

export type Mat = Float64Array | number[];

export function mapX(m: Mat, x: number, y: number): number {
  return m[0]! * x + m[2]! * y + m[4]!;
}
export function mapY(m: Mat, x: number, y: number): number {
  return m[1]! * x + m[3]! * y + m[5]!;
}

/** out = m * n (n applied first). out may alias m. */
export function multiply(out: Mat, m: Mat, n: Mat): void {
  const a = m[0]! * n[0]! + m[2]! * n[1]!;
  const b = m[1]! * n[0]! + m[3]! * n[1]!;
  const c = m[0]! * n[2]! + m[2]! * n[3]!;
  const d = m[1]! * n[2]! + m[3]! * n[3]!;
  const e = m[0]! * n[4]! + m[2]! * n[5]! + m[4]!;
  const f = m[1]! * n[4]! + m[3]! * n[5]! + m[5]!;
  out[0] = a;
  out[1] = b;
  out[2] = c;
  out[3] = d;
  out[4] = e;
  out[5] = f;
}

/** Inverse into out; false when singular. */
export function invert(out: Mat, m: Mat): boolean {
  const det = m[0]! * m[3]! - m[1]! * m[2]!;
  if (!det || !Number.isFinite(det)) return false;
  const id = 1 / det;
  const a = m[3]! * id;
  const b = -m[1]! * id;
  const c = -m[2]! * id;
  const d = m[0]! * id;
  const e = (m[2]! * m[5]! - m[3]! * m[4]!) * id;
  const f = (m[1]! * m[4]! - m[0]! * m[5]!) * id;
  out[0] = a;
  out[1] = b;
  out[2] = c;
  out[3] = d;
  out[4] = e;
  out[5] = f;
  return Number.isFinite(e) && Number.isFinite(f);
}

/**
 * Minimal DOMMatrix stand-in for getTransform() when the runtime has no DOMMatrix global: the 2D attributes,
 * is2D/isIdentity, and the read-only 4x4 aliases.
 */
export class Canvas2DMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  constructor(init?: ArrayLike<number>) {
    const v = init && init.length >= 6 ? init : [1, 0, 0, 1, 0, 0];
    this.a = v[0]!;
    this.b = v[1]!;
    this.c = v[2]!;
    this.d = v[3]!;
    this.e = v[4]!;
    this.f = v[5]!;
  }
  get m11(): number { return this.a; }
  get m12(): number { return this.b; }
  get m21(): number { return this.c; }
  get m22(): number { return this.d; }
  get m41(): number { return this.e; }
  get m42(): number { return this.f; }
  get m13(): number { return 0; }
  get m14(): number { return 0; }
  get m23(): number { return 0; }
  get m24(): number { return 0; }
  get m31(): number { return 0; }
  get m32(): number { return 0; }
  get m33(): number { return 1; }
  get m34(): number { return 0; }
  get m43(): number { return 0; }
  get m44(): number { return 1; }
  get is2D(): boolean { return true; }
  get isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }
  multiply(o: { a: number; b: number; c: number; d: number; e: number; f: number }): Canvas2DMatrix {
    const out = [0, 0, 0, 0, 0, 0];
    multiply(out, [this.a, this.b, this.c, this.d, this.e, this.f], [o.a, o.b, o.c, o.d, o.e, o.f]);
    return new Canvas2DMatrix(out);
  }
  inverse(): Canvas2DMatrix {
    const out = [0, 0, 0, 0, 0, 0];
    if (!invert(out, [this.a, this.b, this.c, this.d, this.e, this.f])) return new Canvas2DMatrix([NaN, NaN, NaN, NaN, NaN, NaN]);
    return new Canvas2DMatrix(out);
  }
  transformPoint(p: { x?: number; y?: number } = {}): { x: number; y: number; z: number; w: number } {
    const x = p.x ?? 0;
    const y = p.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
  }
  toFloat64Array(): Float64Array {
    return new Float64Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]);
  }
  toString(): string {
    return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`;
  }
}

export function makeDOMMatrix(m: Mat): object {
  const G = globalThis as { DOMMatrix?: new (init: number[]) => object };
  const v = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!];
  if (typeof G.DOMMatrix === 'function') {
    try {
      return new G.DOMMatrix(v);
    } catch {
      // fall through
    }
  }
  return new Canvas2DMatrix(v);
}

/**
 * DOMMatrix2DInit validation and fixup (Geometry Interfaces §6.1): a/m11 ... f/m42 must agree when both are
 * given; missing values default to the identity. Throws TypeError on a mismatch. Returns null when any value
 * is non-finite (the canvas methods then do nothing).
 */
export function from2DInit(init: unknown): number[] | null {
  if (init === undefined || init === null) return [1, 0, 0, 1, 0, 0];
  if (typeof init !== 'object') throw new TypeError('Failed to convert value to DOMMatrix2DInit.');
  const o = init as Record<string, unknown>;
  const pick = (k1: string, k2: string, def: number): number => {
    const v1 = o[k1];
    const v2 = o[k2];
    const n1 = v1 === undefined ? undefined : Number(v1);
    const n2 = v2 === undefined ? undefined : Number(v2);
    if (n1 !== undefined && n2 !== undefined && !(n1 === n2 || (Number.isNaN(n1) && Number.isNaN(n2)))) {
      throw new TypeError(`DOMMatrix2DInit: '${k1}' and '${k2}' disagree.`);
    }
    return n1 ?? n2 ?? def;
  };
  const v = [pick('a', 'm11', 1), pick('b', 'm12', 0), pick('c', 'm21', 0), pick('d', 'm22', 1), pick('e', 'm41', 0), pick('f', 'm42', 0)];
  if (o.is2D === false) throw new TypeError('DOMMatrix2DInit: is2D is false.');
  return v.every(Number.isFinite) ? v : null;
}
