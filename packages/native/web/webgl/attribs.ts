/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Vertex arrays and attributes: VAO state mirrored in JS (getVertexAttrib answers, client-array detection
// for draw validation, GL-9), vertexAttribPointer rules (no buffer + non-zero offset, alignment), and the
// binding / enable caches (GL-PERF-2).

import type { Ctx } from './core.ts';
import * as E from './gen/enums.gen.ts';
import {
  INTERNAL,
  WebGLVertexArrayObject,
  WebGLVertexArrayObjectOES,
} from './objects.ts';
import { f32List, i32List, u32List } from './views.ts';

function typeSize(type: number, v2: boolean): number {
  switch (type) {
    case E.BYTE:
    case E.UNSIGNED_BYTE:
      return 1;
    case E.SHORT:
    case E.UNSIGNED_SHORT:
      return 2;
    case E.FLOAT:
      return 4;
  }
  if (!v2) return 0;
  switch (type) {
    case E.INT:
    case E.UNSIGNED_INT:
    case E.INT_2_10_10_10_REV:
    case E.UNSIGNED_INT_2_10_10_10_REV:
      return 4;
    case E.HALF_FLOAT:
      return 2;
  }
  return 0;
}

const P_SIZE = 0;
const P_TYPE = 1;
const P_NORM = 2;
const P_STRIDE = 3;
const P_OFFSET = 4;
const P_INTEGER = 5;
const P_DIVISOR = 6;

function pointer(
  ctx: Ctx,
  index: number,
  size: number,
  type: number,
  normalized: boolean,
  stride: number,
  offset: number,
  integer: boolean,
  what: string,
): void {
  if (ctx._skip()) return;
  if (index >= ctx._maxAttribs) return ctx._e(E.INVALID_VALUE, what);
  if (size < 1 || size > 4 || stride < 0 || stride > 255 || offset < 0)
    return ctx._e(E.INVALID_VALUE, what);
  const ts = typeSize(type, ctx._v2);
  if (
    ts === 0 ||
    (integer &&
      (type === E.FLOAT ||
        type === E.HALF_FLOAT ||
        type === E.INT_2_10_10_10_REV ||
        type === E.UNSIGNED_INT_2_10_10_10_REV))
  ) {
    return ctx._e(E.INVALID_ENUM, what);
  }
  if (
    (type === E.INT_2_10_10_10_REV || type === E.UNSIGNED_INT_2_10_10_10_REV) &&
    size !== 4
  )
    return ctx._e(E.INVALID_OPERATION, what);
  if (offset % ts !== 0 || stride % ts !== 0)
    return ctx._e(E.INVALID_OPERATION, what);
  const buf = ctx._arrayBuffer;
  if (buf === null && offset !== 0) return ctx._e(E.INVALID_OPERATION, what);
  const vao = ctx._vao;
  const p = vao._pointer;
  const o = index * 7;
  const prev = vao._buffers[index];
  if (
    prev === buf &&
    p[o + P_SIZE] === size &&
    p[o + P_TYPE] === type &&
    p[o + P_NORM] === (normalized ? 1 : 0) &&
    p[o + P_STRIDE] === stride &&
    p[o + P_OFFSET] === offset &&
    p[o + P_INTEGER] === (integer ? 1 : 0)
  ) {
    return;
  }
  if (vao._enabled[index]) {
    if (prev === null && buf !== null) vao._enabledWithoutBuffer--;
    else if (prev !== null && buf === null) vao._enabledWithoutBuffer++;
  }
  vao._buffers[index] = buf;
  p[o + P_SIZE] = size;
  p[o + P_TYPE] = type;
  p[o + P_NORM] = normalized ? 1 : 0;
  p[o + P_STRIDE] = stride;
  p[o + P_OFFSET] = offset;
  p[o + P_INTEGER] = integer ? 1 : 0;
  ctx._attribsDirty = true;
  if (integer) ctx._n.vertexAttribIPointer(index, size, type, stride, offset);
  else
    ctx._n.vertexAttribPointer(index, size, type, normalized, stride, offset);
}

function toInt64(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
}

/** CURRENT_VERTEX_ATTRIB type per index: 0 float, 1 int, 2 uint (WebGL 2.0 §5.?: getVertexAttrib returns that type). */
const attribValueType = new WeakMap<Ctx, Uint8Array>();
export function valueTypes(ctx: Ctx): Uint8Array {
  let a = attribValueType.get(ctx);
  if (!a) {
    a = new Uint8Array(ctx._maxAttribs);
    attribValueType.set(ctx, a);
  }
  return a;
}

export const attribMethods = {
  createVertexArray(this: Ctx): WebGLVertexArrayObject | null {
    if (this._skip()) return null;
    const v = new WebGLVertexArrayObject(
      INTERNAL,
      this,
      this._n.genVertexArray(),
      this._maxAttribs,
    );
    this._track(v);
    return v;
  },
  isVertexArray(this: Ctx, vao: unknown): boolean {
    if (this._lost || vao === null || vao === undefined) return false;
    if (!(vao instanceof WebGLVertexArrayObject))
      throw new TypeError(
        'isVertexArray: argument is not a WebGLVertexArrayObject',
      );
    return (
      vao._ctx === this && vao._gen === this._gen && !vao._deleted && vao._bound
    );
  },
  deleteVertexArray(this: Ctx, vao: unknown): void {
    if (this._skip()) return;
    if (!this._owned(vao, WebGLVertexArrayObject, 'deleteVertexArray')) return;
    const v = vao as WebGLVertexArrayObject;
    if (v._deleted || v._name === 0) return;
    v._deleted = true;
    if (this._vao === v) this._vao = this._defaultVao; // GL reverts to the default VAO
    this._untrack(v);
    this._n.deleteVertexArray(v._name);
  },
  bindVertexArray(this: Ctx, vao: WebGLVertexArrayObject | null): void {
    if (this._skip()) return;
    if (!this._ok(vao, WebGLVertexArrayObject, true, 'bindVertexArray')) return;
    const v = vao ?? this._defaultVao;
    if (this._vao === v) return;
    this._vao = v;
    v._bound = true;
    this._attribsDirty = true;
    this._n.bindVertexArray(v._name);
  },
  enableVertexAttribArray(this: Ctx, index: number): void {
    if (this._skip()) return;
    index >>>= 0;
    if (index >= this._maxAttribs)
      return this._e(E.INVALID_VALUE, 'enableVertexAttribArray');
    const vao = this._vao;
    if (vao._enabled[index]) return;
    vao._enabled[index] = 1;
    this._attribsDirty = true;
    if (vao._buffers[index] === null) vao._enabledWithoutBuffer++;
    this._n.enableVertexAttribArray(index);
  },
  disableVertexAttribArray(this: Ctx, index: number): void {
    if (this._skip()) return;
    index >>>= 0;
    if (index >= this._maxAttribs)
      return this._e(E.INVALID_VALUE, 'disableVertexAttribArray');
    const vao = this._vao;
    if (!vao._enabled[index]) return;
    vao._enabled[index] = 0;
    this._attribsDirty = true;
    if (vao._buffers[index] === null) vao._enabledWithoutBuffer--;
    this._n.disableVertexAttribArray(index);
  },
  vertexAttribPointer(
    this: Ctx,
    index: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number,
  ): void {
    pointer(
      this,
      index >>> 0,
      size | 0,
      type >>> 0,
      !!normalized,
      stride | 0,
      toInt64(offset),
      false,
      'vertexAttribPointer',
    );
  },
  vertexAttribIPointer(
    this: Ctx,
    index: number,
    size: number,
    type: number,
    stride: number,
    offset: number,
  ): void {
    pointer(
      this,
      index >>> 0,
      size | 0,
      type >>> 0,
      false,
      stride | 0,
      toInt64(offset),
      true,
      'vertexAttribIPointer',
    );
  },
  vertexAttribDivisor(this: Ctx, index: number, divisor: number): void {
    if (this._skip()) return;
    index >>>= 0;
    divisor >>>= 0;
    if (index >= this._maxAttribs)
      return this._e(E.INVALID_VALUE, 'vertexAttribDivisor');
    const p = this._vao._pointer;
    if (p[index * 7 + P_DIVISOR] === divisor) return;
    p[index * 7 + P_DIVISOR] = divisor;
    this._n.vertexAttribDivisor(index, divisor);
  },
  vertexAttrib1fv(this: Ctx, index: number, v: unknown): void {
    attribV(this, index >>> 0, 1, v, 'vertexAttrib1fv');
  },
  vertexAttrib2fv(this: Ctx, index: number, v: unknown): void {
    attribV(this, index >>> 0, 2, v, 'vertexAttrib2fv');
  },
  vertexAttrib3fv(this: Ctx, index: number, v: unknown): void {
    attribV(this, index >>> 0, 3, v, 'vertexAttrib3fv');
  },
  vertexAttrib4fv(this: Ctx, index: number, v: unknown): void {
    attribV(this, index >>> 0, 4, v, 'vertexAttrib4fv');
  },
  vertexAttrib1f(this: Ctx, index: number, x: number): void {
    attribF(this, index >>> 0, +x, 0, 0, 1, 1, 'vertexAttrib1f');
  },
  vertexAttrib2f(this: Ctx, index: number, x: number, y: number): void {
    attribF(this, index >>> 0, +x, +y, 0, 1, 2, 'vertexAttrib2f');
  },
  vertexAttrib3f(
    this: Ctx,
    index: number,
    x: number,
    y: number,
    z: number,
  ): void {
    attribF(this, index >>> 0, +x, +y, +z, 1, 3, 'vertexAttrib3f');
  },
  vertexAttrib4f(
    this: Ctx,
    index: number,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void {
    if (this._skip()) return;
    index >>>= 0;
    if (index >= this._maxAttribs)
      return this._e(E.INVALID_VALUE, 'vertexAttrib4f');
    valueTypes(this)[index] = 0;
    this._attribsDirty = true;
    this._n.vertexAttrib4f(index, +x, +y, +z, +w);
  },
  vertexAttribI4i(
    this: Ctx,
    index: number,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void {
    if (this._skip()) return;
    index >>>= 0;
    if (index >= this._maxAttribs)
      return this._e(E.INVALID_VALUE, 'vertexAttribI4i');
    valueTypes(this)[index] = 1;
    this._attribsDirty = true;
    this._n.vertexAttribI4i(index, x | 0, y | 0, z | 0, w | 0);
  },
  vertexAttribI4ui(
    this: Ctx,
    index: number,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void {
    if (this._skip()) return;
    index >>>= 0;
    if (index >= this._maxAttribs)
      return this._e(E.INVALID_VALUE, 'vertexAttribI4ui');
    valueTypes(this)[index] = 2;
    this._attribsDirty = true;
    this._n.vertexAttribI4ui(index, x >>> 0, y >>> 0, z >>> 0, w >>> 0);
  },
  vertexAttribI4iv(this: Ctx, index: number, v: unknown): void {
    if (this._skip()) return;
    index >>>= 0;
    const list = i32List(this, v, 'vertexAttribI4iv');
    const len = list === v ? list.length : (v as ArrayLike<unknown>).length;
    if (index >= this._maxAttribs || len < 4)
      return this._e(E.INVALID_VALUE, 'vertexAttribI4iv');
    valueTypes(this)[index] = 1;
    this._attribsDirty = true;
    this._n.vertexAttribI4iv(index, list, 0, 16);
  },
  vertexAttribI4uiv(this: Ctx, index: number, v: unknown): void {
    if (this._skip()) return;
    index >>>= 0;
    const list = u32List(this, v, 'vertexAttribI4uiv');
    const len = list === v ? list.length : (v as ArrayLike<unknown>).length;
    if (index >= this._maxAttribs || len < 4)
      return this._e(E.INVALID_VALUE, 'vertexAttribI4uiv');
    valueTypes(this)[index] = 2;
    this._attribsDirty = true;
    this._n.vertexAttribI4uiv(index, list, 0, 16);
  },
  getVertexAttrib(this: Ctx, index: number, pname: number): unknown {
    if (this._skip()) return null;
    index >>>= 0;
    pname >>>= 0;
    if (index >= this._maxAttribs) {
      this._e(E.INVALID_VALUE, 'getVertexAttrib');
      return null;
    }
    const vao = this._vao;
    const p = vao._pointer;
    const o = index * 7;
    switch (pname) {
      case E.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING:
        return vao._buffers[index];
      case E.VERTEX_ATTRIB_ARRAY_ENABLED:
        return vao._enabled[index] === 1;
      case E.VERTEX_ATTRIB_ARRAY_SIZE:
        return p[o + P_SIZE];
      case E.VERTEX_ATTRIB_ARRAY_STRIDE:
        return p[o + P_STRIDE];
      case E.VERTEX_ATTRIB_ARRAY_TYPE:
        return p[o + P_TYPE];
      case E.VERTEX_ATTRIB_ARRAY_NORMALIZED:
        return p[o + P_NORM] === 1;
      case E.VERTEX_ATTRIB_ARRAY_INTEGER:
        if (!this._v2) break;
        return p[o + P_INTEGER] === 1;
      case E.VERTEX_ATTRIB_ARRAY_DIVISOR:
        if (
          !this._v2 &&
          !this._extensions.has('ANGLE_instanced_arrays') &&
          !this._extensions.has('WEBGL_multi_draw')
        )
          break;
        return p[o + P_DIVISOR];
      case E.CURRENT_VERTEX_ATTRIB: {
        const t = valueTypes(this)[index];
        if (t === 1) {
          const out = new Int32Array(4);
          void out.buffer;
          this._n.getVertexAttribIiv(index, pname, out, 0, 16);
          return out;
        }
        if (t === 2) {
          const out = new Uint32Array(4);
          void out.buffer;
          this._n.getVertexAttribIuiv(index, pname, out, 0, 16);
          return out;
        }
        const out = new Float32Array(4);
        void out.buffer;
        this._n.getVertexAttribfv(index, pname, out, 0, 16);
        return out;
      }
    }
    this._e(E.INVALID_ENUM, 'getVertexAttrib');
    return null;
  },
  getVertexAttribOffset(this: Ctx, index: number, pname: number): number {
    if (this._skip()) return 0;
    index >>>= 0;
    if (index >= this._maxAttribs) {
      this._e(E.INVALID_VALUE, 'getVertexAttribOffset');
      return 0;
    }
    if (pname >>> 0 !== E.VERTEX_ATTRIB_ARRAY_POINTER) {
      this._e(E.INVALID_ENUM, 'getVertexAttribOffset');
      return 0;
    }
    return this._vao._pointer[index * 7 + P_OFFSET];
  },
};

function attribF(
  ctx: Ctx,
  index: number,
  x: number,
  y: number,
  z: number,
  w: number,
  n: number,
  what: string,
): void {
  if (ctx._skip()) return;
  if (index >= ctx._maxAttribs) return ctx._e(E.INVALID_VALUE, what);
  valueTypes(ctx)[index] = 0;
  ctx._attribsDirty = true;
  const g = ctx._n;
  if (n === 1) g.vertexAttrib1f(index, x);
  else if (n === 2) g.vertexAttrib2f(index, x, y);
  else g.vertexAttrib3f(index, x, y, z);
  void w;
}

function attribV(
  ctx: Ctx,
  index: number,
  n: number,
  v: unknown,
  what: string,
): void {
  if (ctx._skip()) return;
  const list = f32List(ctx, v, what);
  const len = list === v ? list.length : (v as ArrayLike<unknown>).length;
  if (index >= ctx._maxAttribs || len < n) return ctx._e(E.INVALID_VALUE, what);
  valueTypes(ctx)[index] = 0;
  ctx._attribsDirty = true;
  const g = ctx._n;
  if (n === 1) g.vertexAttrib1fv(index, list, 0, 4);
  else if (n === 2) g.vertexAttrib2fv(index, list, 0, 8);
  else if (n === 3) g.vertexAttrib3fv(index, list, 0, 12);
  else g.vertexAttrib4fv(index, list, 0, 16);
}

/** OES_vertex_array_object (WebGL 1) objects use their own class. */
export function createVaoOES(ctx: Ctx): WebGLVertexArrayObjectOES | null {
  if (ctx._skip()) return null;
  const v = new WebGLVertexArrayObjectOES(
    INTERNAL,
    ctx,
    ctx._n.genVertexArray(),
    ctx._maxAttribs,
  );
  ctx._track(v);
  return v;
}
