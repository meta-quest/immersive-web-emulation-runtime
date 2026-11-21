/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Uniform uploads: location validity (GL-8: null = silent no-op, other program / stale link =
// INVALID_OPERATION), type compatibility answered from the reflection record (so invalid uploads never
// reach the driver and never poison the cache), the per-program value cache (GL-PERF-2: an upload equal to
// the program's current value is dropped; cells keyed by uniform element and shared by all location objects), list arguments without allocation (GL-PERF-3).

import type { Ctx } from './core.ts';
import * as E from './gen/enums.gen.ts';
import {
  WebGLProgram,
  WebGLUniformLocation,
  type UniformCell,
} from './objects.ts';
import { programExtras } from './programs.ts';
import { f32List, i32List, u32List, viewRange, range } from './views.ts';

// Families: 1 = float, 2 = int, 3 = uint, 4 = bool, 5 = sampler, 6 = matrix
const T_FLOAT = 1;
const T_INT = 2;
const T_UINT = 3;
const T_BOOL = 4;
const T_SAMPLER = 5;
const T_MAT = 6;

/** uniform type -> [family, components] */
const TYPE_INFO = new Map<number, readonly [number, number]>([
  [E.FLOAT, [T_FLOAT, 1]],
  [E.FLOAT_VEC2, [T_FLOAT, 2]],
  [E.FLOAT_VEC3, [T_FLOAT, 3]],
  [E.FLOAT_VEC4, [T_FLOAT, 4]],
  [E.INT, [T_INT, 1]],
  [E.INT_VEC2, [T_INT, 2]],
  [E.INT_VEC3, [T_INT, 3]],
  [E.INT_VEC4, [T_INT, 4]],
  [E.UNSIGNED_INT, [T_UINT, 1]],
  [E.UNSIGNED_INT_VEC2, [T_UINT, 2]],
  [E.UNSIGNED_INT_VEC3, [T_UINT, 3]],
  [E.UNSIGNED_INT_VEC4, [T_UINT, 4]],
  [E.BOOL, [T_BOOL, 1]],
  [E.BOOL_VEC2, [T_BOOL, 2]],
  [E.BOOL_VEC3, [T_BOOL, 3]],
  [E.BOOL_VEC4, [T_BOOL, 4]],
  [E.FLOAT_MAT2, [T_MAT, 4]],
  [E.FLOAT_MAT3, [T_MAT, 9]],
  [E.FLOAT_MAT4, [T_MAT, 16]],
  [E.FLOAT_MAT2x3, [T_MAT, 6]],
  [E.FLOAT_MAT2x4, [T_MAT, 8]],
  [E.FLOAT_MAT3x2, [T_MAT, 6]],
  [E.FLOAT_MAT3x4, [T_MAT, 12]],
  [E.FLOAT_MAT4x2, [T_MAT, 8]],
  [E.FLOAT_MAT4x3, [T_MAT, 12]],
]);
function typeInfo(type: number): readonly [number, number] {
  return TYPE_INFO.get(type) ?? [T_SAMPLER, 1];
}

/** Cache tags: family * 32 + components (matrices: 6*32 + comps, distinct from vectors) */
const MAX_CACHED = 256;

/**
 * Validate a location for an upload of `family` (1 f, 2 i, 3 ui, 6 matrix) with `comps` components.
 * Returns the record entry index or -1 (null location: silently -1 without error).
 */
function check(
  ctx: Ctx,
  loc: unknown,
  family: number,
  comps: number,
  what: string,
): WebGLUniformLocation | null {
  if (loc === null || loc === undefined) return null;
  if (!(loc instanceof WebGLUniformLocation))
    throw new TypeError(`${what}: location is not a WebGLUniformLocation`);
  const p = loc._program;
  if (ctx._program !== p || loc._linkGen !== p._linkGen || p._ctx !== ctx) {
    ctx._e(E.INVALID_OPERATION, what);
    return null;
  }
  if (loc._family === 0) describe(loc);
  const f = loc._family;
  const c = loc._comps;
  const ok =
    f === family
      ? c === comps
      : f === T_BOOL
        ? family !== T_MAT && c === comps
        : f === T_SAMPLER && family === T_INT && comps === 1;
  if (!ok) {
    ctx._e(E.INVALID_OPERATION, what);
    return null;
  }
  return loc;
}

/** Cache the uniform's shape on the location (once per location object). */
function describe(loc: WebGLUniformLocation): void {
  const u = loc._program._record!.uniforms[loc._uniform];
  const [f, c] = typeInfo(u.type);
  loc._family = f;
  loc._comps = c;
  loc._type = u.type;
  loc._isArray = u.isArray;
  loc._remaining = u.size - loc._element;
}

function samplerValue(
  ctx: Ctx,
  loc: WebGLUniformLocation,
  values: ArrayLike<number>,
  off: number,
  count: number,
  what: string,
): boolean {
  if (loc._family !== T_SAMPLER) return true;
  const p = loc._program;
  const u = p._record!.uniforms[loc._uniform];
  for (let i = 0; i < count; i++) {
    const v = values[off + i];
    if (v < 0 || v >= ctx._maxUnits) {
      ctx._e(E.INVALID_VALUE, what);
      return false;
    }
  }
  const units = programExtras(p).samplerUnits;
  const n = Math.min(count, u.size - loc._element);
  for (let i = 0; i < n; i++)
    units.set(loc._uniform * 4096 + loc._element + i, values[off + i]);
  if (ctx._drawFbo && ctx._drawFbo._texAttachments) ctx._feedbackDirty = true;
  ctx._texDirty = true;
  return true;
}

/**
 * The program-owned cache cell of a location (shared by every location object for the same uniform element,
 * so two location objects or an element location and its array's base location never disagree).
 */
function cellOf(loc: WebGLUniformLocation): UniformCell {
  let cell = loc._cell;
  if (cell !== null) return cell;
  const x = programExtras(loc._program);
  const key = loc._uniform * 4096 + loc._element;
  cell = x.cells.get(key) ?? null;
  if (cell === null) {
    let siblings: UniformCell[] | null = null;
    if (loc._isArray) {
      siblings = x.cellGroups.get(loc._uniform) ?? null;
      if (siblings === null) x.cellGroups.set(loc._uniform, (siblings = []));
    }
    cell = { tag: 0, len: 0, f: null, i: null, siblings };
    if (siblings !== null) siblings.push(cell);
    x.cells.set(key, cell);
  }
  loc._cell = cell;
  return cell;
}

/** A store through `cell` changed elements other cells of the same array may have cached. */
function invalidateSiblings(cell: UniformCell): void {
  const s = cell.siblings;
  if (s === null || s.length < 2) return;
  for (let k = 0; k < s.length; k++) if (s[k] !== cell) s[k].tag = 0;
}

/** Scalar-argument uploads (uniform4f & co.): cache compare on the scratch values. */
function cachedF(
  loc: WebGLUniformLocation,
  tag: number,
  n: number,
  a: number,
  b: number,
  c: number,
  d: number,
): boolean {
  const cell = cellOf(loc);
  let cache = cell.f;
  if (cell.tag === tag && cell.len === n && cache !== null) {
    if (
      cache[0] === Math.fround(a) &&
      (n < 2 || cache[1] === Math.fround(b)) &&
      (n < 3 || cache[2] === Math.fround(c)) &&
      (n < 4 || cache[3] === Math.fround(d))
    )
      return true;
  }
  if (cache === null || cache.length < 4) cache = cell.f = new Float32Array(4);
  cache[0] = a;
  cache[1] = b;
  cache[2] = c;
  cache[3] = d;
  cell.tag = tag;
  cell.len = n;
  invalidateSiblings(cell);
  return false;
}
function cachedI(
  loc: WebGLUniformLocation,
  tag: number,
  n: number,
  a: number,
  b: number,
  c: number,
  d: number,
): boolean {
  const cell = cellOf(loc);
  let cache = cell.i;
  if (cell.tag === tag && cell.len === n && cache !== null) {
    if (
      cache[0] === (a | 0) &&
      (n < 2 || cache[1] === (b | 0)) &&
      (n < 3 || cache[2] === (c | 0)) &&
      (n < 4 || cache[3] === (d | 0))
    )
      return true;
  }
  if (cache === null || cache.length < 4) cache = cell.i = new Int32Array(4);
  cache[0] = a;
  cache[1] = b;
  cache[2] = c;
  cache[3] = d;
  cell.tag = tag;
  cell.len = n;
  invalidateSiblings(cell);
  return false;
}

/** Array uploads: compare `len` elements at `src[off..]` with the cache; store when different. */
function cachedArrayF(
  loc: WebGLUniformLocation,
  tag: number,
  src: Float32Array,
  off: number,
  len: number,
): boolean {
  const cell = cellOf(loc);
  if (len > MAX_CACHED) {
    cell.tag = 0;
    invalidateSiblings(cell);
    return false;
  }
  let cache = cell.f;
  if (cell.tag === tag && cell.len === len && cache !== null) {
    let i = 0;
    for (; i < len; i++) if (cache[i] !== src[off + i]) break;
    if (i === len) return true;
  }
  if (cache === null || cache.length < len)
    cache = cell.f = new Float32Array(Math.max(4, len));
  for (let i = 0; i < len; i++) cache[i] = src[off + i];
  cell.tag = tag;
  cell.len = len;
  invalidateSiblings(cell);
  return false;
}
function cachedArrayI(
  loc: WebGLUniformLocation,
  tag: number,
  src: Int32Array | Uint32Array,
  off: number,
  len: number,
): boolean {
  const cell = cellOf(loc);
  if (len > MAX_CACHED) {
    cell.tag = 0;
    invalidateSiblings(cell);
    return false;
  }
  let cache = cell.i;
  if (cell.tag === tag && cell.len === len && cache !== null) {
    let i = 0;
    for (; i < len; i++) if (cache[i] !== (src[off + i] | 0)) break;
    if (i === len) return true;
  }
  if (cache === null || cache.length < len)
    cache = cell.i = new Int32Array(Math.max(4, len));
  for (let i = 0; i < len; i++) cache[i] = src[off + i];
  cell.tag = tag;
  cell.len = len;
  invalidateSiblings(cell);
  return false;
}

function scalarF(
  ctx: Ctx,
  loc: unknown,
  n: number,
  a: number,
  b: number,
  c: number,
  d: number,
  what: string,
): void {
  if (ctx._skip()) return;
  const l = check(ctx, loc, T_FLOAT, n, what);
  if (l === null) return;
  if (cachedF(l, 32 + n, n, a, b, c, d)) return;
  const g = ctx._n;
  if (n === 1) g.uniform1f(l._loc, a);
  else if (n === 2) g.uniform2f(l._loc, a, b);
  else if (n === 3) g.uniform3f(l._loc, a, b, c);
  else g.uniform4f(l._loc, a, b, c, d);
}

function scalarI(
  ctx: Ctx,
  loc: unknown,
  unsigned: boolean,
  n: number,
  a: number,
  b: number,
  c: number,
  d: number,
  what: string,
): void {
  if (ctx._skip()) return;
  const l = check(ctx, loc, unsigned ? T_UINT : T_INT, n, what);
  if (l === null) return;
  if (!unsigned && n === 1) {
    const s = ctx._i32;
    s[0] = a;
    if (!samplerValue(ctx, l, s, 0, 1, what)) return;
  }
  if (cachedI(l, (unsigned ? 96 : 64) + n, n, a, b, c, d)) return;
  const g = ctx._n;
  if (unsigned) {
    if (n === 1) g.uniform1ui(l._loc, a >>> 0);
    else if (n === 2) g.uniform2ui(l._loc, a >>> 0, b >>> 0);
    else if (n === 3) g.uniform3ui(l._loc, a >>> 0, b >>> 0, c >>> 0);
    else g.uniform4ui(l._loc, a >>> 0, b >>> 0, c >>> 0, d >>> 0);
  } else {
    if (n === 1) g.uniform1i(l._loc, a);
    else if (n === 2) g.uniform2i(l._loc, a, b);
    else if (n === 3) g.uniform3i(l._loc, a, b, c);
    else g.uniform4i(l._loc, a, b, c, d);
  }
}

/** Shared tail of uniform*v / uniformMatrix*fv: range, count rules, cache, native call. */
function vector(
  ctx: Ctx,
  loc: unknown,
  family: number,
  comps: number,
  data: unknown,
  srcOffset: number | undefined,
  srcLength: number | undefined,
  transpose: boolean,
  what: string,
): void {
  if (ctx._skip()) return;
  const isF = family === T_FLOAT || family === T_MAT;
  const list = isF
    ? f32List(ctx, data, what)
    : family === T_UINT
      ? u32List(ctx, data, what)
      : i32List(ctx, data, what);
  const converted = list !== data;
  const total = converted ? (data as ArrayLike<unknown>).length : list.length;
  const l = check(ctx, loc, family, comps, what);
  if (l === null && (loc === null || loc === undefined)) {
    // null location: no-op, but WebGL still validates the arguments
  }
  let off = 0;
  let len = total;
  if (srcOffset !== undefined && ctx._v2) {
    const so = srcOffset >>> 0;
    const sl = (srcLength ?? 0) >>> 0;
    if (so > total || (sl !== 0 && so + sl > total))
      return ctx._e(E.INVALID_VALUE, what);
    off = so;
    len = sl === 0 ? total - so : sl;
  }
  if (len === 0 || len % comps !== 0) return ctx._e(E.INVALID_VALUE, what);
  if (l === null) return;
  if (family === T_MAT && transpose && !ctx._v2)
    return ctx._e(E.INVALID_VALUE, what);
  let count = len / comps;
  if (count > 1 && !l._isArray) return ctx._e(E.INVALID_OPERATION, what);
  const remaining = l._remaining;
  if (count > remaining) {
    count = remaining;
    len = count * comps;
  }
  if (
    family === T_INT &&
    comps === 1 &&
    !samplerValue(ctx, l, list as Int32Array, off, count, what)
  )
    return;
  const tag =
    (family === T_MAT ? 192 + (transpose ? 128 : 0) : family * 32) + comps;
  if (
    isF
      ? cachedArrayF(l, tag, list as Float32Array, off, len)
      : cachedArrayI(l, tag, list as Int32Array, off, len)
  )
    return;
  const g = ctx._n;
  const bo = off * 4;
  const bytes = len * 4;
  const loc_ = l._loc;
  if (family === T_FLOAT) {
    const f = list as Float32Array;
    if (comps === 1) g.uniform1fv(loc_, count, f, bo, bytes);
    else if (comps === 2) g.uniform2fv(loc_, count, f, bo, bytes);
    else if (comps === 3) g.uniform3fv(loc_, count, f, bo, bytes);
    else g.uniform4fv(loc_, count, f, bo, bytes);
  } else if (family === T_INT || family === T_BOOL) {
    const v = list as Int32Array;
    if (comps === 1) g.uniform1iv(loc_, count, v, bo, bytes);
    else if (comps === 2) g.uniform2iv(loc_, count, v, bo, bytes);
    else if (comps === 3) g.uniform3iv(loc_, count, v, bo, bytes);
    else g.uniform4iv(loc_, count, v, bo, bytes);
  } else if (family === T_UINT) {
    const v = list as Uint32Array;
    if (comps === 1) g.uniform1uiv(loc_, count, v, bo, bytes);
    else if (comps === 2) g.uniform2uiv(loc_, count, v, bo, bytes);
    else if (comps === 3) g.uniform3uiv(loc_, count, v, bo, bytes);
    else g.uniform4uiv(loc_, count, v, bo, bytes);
  } else {
    matrixCall(
      ctx,
      loc_,
      count,
      transpose,
      list as Float32Array,
      bo,
      bytes,
      comps,
      l._type,
    );
  }
}

function matrixCall(
  ctx: Ctx,
  loc: number,
  count: number,
  t: boolean,
  f: Float32Array,
  bo: number,
  bytes: number,
  comps: number,
  type: number,
): void {
  const g = ctx._n;
  switch (type) {
    case E.FLOAT_MAT2:
      return g.uniformMatrix2fv(loc, count, t, f, bo, bytes);
    case E.FLOAT_MAT3:
      return g.uniformMatrix3fv(loc, count, t, f, bo, bytes);
    case E.FLOAT_MAT4:
      return g.uniformMatrix4fv(loc, count, t, f, bo, bytes);
    case E.FLOAT_MAT2x3:
      return g.uniformMatrix2x3fv(loc, count, t, f, bo, bytes);
    case E.FLOAT_MAT3x2:
      return g.uniformMatrix3x2fv(loc, count, t, f, bo, bytes);
    case E.FLOAT_MAT2x4:
      return g.uniformMatrix2x4fv(loc, count, t, f, bo, bytes);
    case E.FLOAT_MAT4x2:
      return g.uniformMatrix4x2fv(loc, count, t, f, bo, bytes);
    case E.FLOAT_MAT3x4:
      return g.uniformMatrix3x4fv(loc, count, t, f, bo, bytes);
    case E.FLOAT_MAT4x3:
      return g.uniformMatrix4x3fv(loc, count, t, f, bo, bytes);
  }
  void comps;
}

/** Matrix uploads: the method's shape must equal the uniform's type. */
function matrix(
  ctx: Ctx,
  loc: unknown,
  type: number,
  transpose: unknown,
  data: unknown,
  so: number | undefined,
  sl: number | undefined,
  what: string,
): void {
  if (
    loc instanceof WebGLUniformLocation &&
    loc._program._record &&
    loc._program === ctx._program &&
    loc._linkGen === loc._program._linkGen
  ) {
    const u = loc._program._record.uniforms[loc._uniform];
    if (u.type !== type) {
      if (ctx._skip()) return;
      return ctx._e(E.INVALID_OPERATION, what);
    }
  }
  vector(ctx, loc, T_MAT, typeInfo(type)[1], data, so, sl, !!transpose, what);
}

export const uniformMethods = {
  uniform1f(this: Ctx, loc: WebGLUniformLocation | null, x: number): void {
    scalarF(this, loc, 1, +x, 0, 0, 0, 'uniform1f');
  },
  uniform2f(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    x: number,
    y: number,
  ): void {
    scalarF(this, loc, 2, +x, +y, 0, 0, 'uniform2f');
  },
  uniform3f(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    x: number,
    y: number,
    z: number,
  ): void {
    scalarF(this, loc, 3, +x, +y, +z, 0, 'uniform3f');
  },
  uniform4f(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void {
    scalarF(this, loc, 4, +x, +y, +z, +w, 'uniform4f');
  },
  uniform1i(this: Ctx, loc: WebGLUniformLocation | null, x: number): void {
    scalarI(this, loc, false, 1, x | 0, 0, 0, 0, 'uniform1i');
  },
  uniform2i(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    x: number,
    y: number,
  ): void {
    scalarI(this, loc, false, 2, x | 0, y | 0, 0, 0, 'uniform2i');
  },
  uniform3i(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    x: number,
    y: number,
    z: number,
  ): void {
    scalarI(this, loc, false, 3, x | 0, y | 0, z | 0, 0, 'uniform3i');
  },
  uniform4i(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void {
    scalarI(this, loc, false, 4, x | 0, y | 0, z | 0, w | 0, 'uniform4i');
  },
  uniform1ui(this: Ctx, loc: WebGLUniformLocation | null, x: number): void {
    scalarI(this, loc, true, 1, x >>> 0, 0, 0, 0, 'uniform1ui');
  },
  uniform2ui(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    x: number,
    y: number,
  ): void {
    scalarI(this, loc, true, 2, x >>> 0, y >>> 0, 0, 0, 'uniform2ui');
  },
  uniform3ui(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    x: number,
    y: number,
    z: number,
  ): void {
    scalarI(this, loc, true, 3, x >>> 0, y >>> 0, z >>> 0, 0, 'uniform3ui');
  },
  uniform4ui(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void {
    scalarI(
      this,
      loc,
      true,
      4,
      x >>> 0,
      y >>> 0,
      z >>> 0,
      w >>> 0,
      'uniform4ui',
    );
  },
  uniform1fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    vector(this, loc, T_FLOAT, 1, v, srcOffset, srcLength, false, 'uniform1fv');
  },
  uniform2fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    vector(this, loc, T_FLOAT, 2, v, srcOffset, srcLength, false, 'uniform2fv');
  },
  uniform3fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    vector(this, loc, T_FLOAT, 3, v, srcOffset, srcLength, false, 'uniform3fv');
  },
  uniform4fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    vector(this, loc, T_FLOAT, 4, v, srcOffset, srcLength, false, 'uniform4fv');
  },
  uniform1iv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    vector(this, loc, T_INT, 1, v, srcOffset, srcLength, false, 'uniform1iv');
  },
  uniform2iv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    vector(this, loc, T_INT, 2, v, srcOffset, srcLength, false, 'uniform2iv');
  },
  uniform3iv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    vector(this, loc, T_INT, 3, v, srcOffset, srcLength, false, 'uniform3iv');
  },
  uniform4iv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    vector(this, loc, T_INT, 4, v, srcOffset, srcLength, false, 'uniform4iv');
  },
  uniform1uiv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    vector(
      this,
      loc,
      T_UINT,
      1,
      v,
      srcOffset ?? 0,
      srcLength,
      false,
      'uniform1uiv',
    );
  },
  uniform2uiv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    vector(
      this,
      loc,
      T_UINT,
      2,
      v,
      srcOffset ?? 0,
      srcLength,
      false,
      'uniform2uiv',
    );
  },
  uniform3uiv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    vector(
      this,
      loc,
      T_UINT,
      3,
      v,
      srcOffset ?? 0,
      srcLength,
      false,
      'uniform3uiv',
    );
  },
  uniform4uiv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    vector(
      this,
      loc,
      T_UINT,
      4,
      v,
      srcOffset ?? 0,
      srcLength,
      false,
      'uniform4uiv',
    );
  },
  uniformMatrix2fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    transpose: boolean,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    matrix(
      this,
      loc,
      E.FLOAT_MAT2,
      transpose,
      v,
      srcOffset,
      srcLength,
      'uniformMatrix2fv',
    );
  },
  uniformMatrix3fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    transpose: boolean,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    matrix(
      this,
      loc,
      E.FLOAT_MAT3,
      transpose,
      v,
      srcOffset,
      srcLength,
      'uniformMatrix3fv',
    );
  },
  uniformMatrix4fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    transpose: boolean,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    matrix(
      this,
      loc,
      E.FLOAT_MAT4,
      transpose,
      v,
      srcOffset,
      srcLength,
      'uniformMatrix4fv',
    );
  },
  uniformMatrix2x3fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    transpose: boolean,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    matrix(
      this,
      loc,
      E.FLOAT_MAT2x3,
      transpose,
      v,
      srcOffset ?? 0,
      srcLength,
      'uniformMatrix2x3fv',
    );
  },
  uniformMatrix3x2fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    transpose: boolean,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    matrix(
      this,
      loc,
      E.FLOAT_MAT3x2,
      transpose,
      v,
      srcOffset ?? 0,
      srcLength,
      'uniformMatrix3x2fv',
    );
  },
  uniformMatrix2x4fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    transpose: boolean,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    matrix(
      this,
      loc,
      E.FLOAT_MAT2x4,
      transpose,
      v,
      srcOffset ?? 0,
      srcLength,
      'uniformMatrix2x4fv',
    );
  },
  uniformMatrix4x2fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    transpose: boolean,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    matrix(
      this,
      loc,
      E.FLOAT_MAT4x2,
      transpose,
      v,
      srcOffset ?? 0,
      srcLength,
      'uniformMatrix4x2fv',
    );
  },
  uniformMatrix3x4fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    transpose: boolean,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    matrix(
      this,
      loc,
      E.FLOAT_MAT3x4,
      transpose,
      v,
      srcOffset ?? 0,
      srcLength,
      'uniformMatrix3x4fv',
    );
  },
  uniformMatrix4x3fv(
    this: Ctx,
    loc: WebGLUniformLocation | null,
    transpose: boolean,
    v: unknown,
    srcOffset?: number,
    srcLength?: number,
  ): void {
    matrix(
      this,
      loc,
      E.FLOAT_MAT4x3,
      transpose,
      v,
      srcOffset ?? 0,
      srcLength,
      'uniformMatrix4x3fv',
    );
  },
  getUniform(
    this: Ctx,
    program: WebGLProgram,
    location: WebGLUniformLocation,
  ): unknown {
    if (this._skip()) return null;
    if (!this._ok(program, WebGLProgram, false, 'getUniform')) return null;
    if (!(location instanceof WebGLUniformLocation))
      throw new TypeError('getUniform: location is not a WebGLUniformLocation');
    if (
      location._program !== program ||
      location._linkGen !== program._linkGen ||
      !program._record?.linked
    ) {
      this._e(E.INVALID_OPERATION, 'getUniform');
      return null;
    }
    const u = program._record.uniforms[location._uniform];
    const [family, comps] = typeInfo(u.type);
    const n = this._n;
    if (family === T_FLOAT || family === T_MAT) {
      const out = new Float32Array(Math.max(comps, 4));
      void out.buffer;
      n.getUniformfv(program._name, location._loc, out, 0, comps * 4);
      return comps === 1 ? out[0] : out.slice(0, comps);
    }
    if (family === T_UINT) {
      const out = new Uint32Array(4);
      void out.buffer;
      n.getUniformuiv(program._name, location._loc, out, 0, comps * 4);
      return comps === 1 ? out[0] : out.slice(0, comps);
    }
    const out = new Int32Array(4);
    void out.buffer;
    n.getUniformiv(program._name, location._loc, out, 0, comps * 4);
    if (family === T_BOOL)
      return comps === 1
        ? out[0] !== 0
        : Array.from(out.slice(0, comps), (v) => v !== 0);
    return comps === 1 ? out[0] : out.slice(0, comps);
  },
};

void viewRange;
void range;
