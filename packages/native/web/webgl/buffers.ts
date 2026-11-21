/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Buffer objects: WebGL 2.0 §5.1 buffer types (element-array vs other data, fixed by the first bind),
// binding cache, typed-array ranges (GL-7), zero-initialised bufferData(size) (GL-3), getBufferSubData.

import type { Ctx } from './core.ts';
import * as E from './gen/enums.gen.ts';
import {
  BUF_ELEMENT,
  BUF_OTHER,
  BUF_UNDEFINED,
  INTERNAL,
  WebGLBuffer,
} from './objects.ts';
import { isView, materialize, range, viewRange } from './views.ts';

const USAGE1 = new Set([E.STREAM_DRAW, E.STATIC_DRAW, E.DYNAMIC_DRAW]);
const USAGE2 = new Set([
  E.STREAM_DRAW,
  E.STATIC_DRAW,
  E.DYNAMIC_DRAW,
  E.STREAM_READ,
  E.STATIC_READ,
  E.DYNAMIC_READ,
  E.STREAM_COPY,
  E.STATIC_COPY,
  E.DYNAMIC_COPY,
]);

function toInt64(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
}

/** Buffer currently bound to `target` (generic binding), or undefined for an invalid target. */
export function boundBuffer(
  ctx: Ctx,
  target: number,
): WebGLBuffer | null | undefined {
  switch (target) {
    case E.ARRAY_BUFFER:
      return ctx._arrayBuffer;
    case E.ELEMENT_ARRAY_BUFFER:
      return ctx._vao._elementBuffer;
  }
  if (!ctx._v2) return undefined;
  switch (target) {
    case E.COPY_READ_BUFFER:
      return ctx._copyRead;
    case E.COPY_WRITE_BUFFER:
      return ctx._copyWrite;
    case E.PIXEL_PACK_BUFFER:
      return ctx._pixelPack;
    case E.PIXEL_UNPACK_BUFFER:
      return ctx._pixelUnpack;
    case E.TRANSFORM_FEEDBACK_BUFFER:
      return ctx._tfBuffer;
    case E.UNIFORM_BUFFER:
      return ctx._uniformBuffer;
  }
  return undefined;
}

function setBound(ctx: Ctx, target: number, b: WebGLBuffer | null): void {
  switch (target) {
    case E.ARRAY_BUFFER:
      ctx._arrayBuffer = b;
      return;
    case E.ELEMENT_ARRAY_BUFFER:
      ctx._vao._elementBuffer = b;
      return;
    case E.COPY_READ_BUFFER:
      ctx._copyRead = b;
      return;
    case E.COPY_WRITE_BUFFER:
      ctx._copyWrite = b;
      return;
    case E.PIXEL_PACK_BUFFER:
      ctx._pixelPack = b;
      return;
    case E.PIXEL_UNPACK_BUFFER:
      ctx._pixelUnpack = b;
      return;
    case E.TRANSFORM_FEEDBACK_BUFFER:
      ctx._tfBuffer = b;
      return;
    case E.UNIFORM_BUFFER:
      ctx._uniformBuffer = b;
  }
}

/** WebGL 2.0 §5.1: may `b` be bound to `target`? Fixes the buffer's type on first bind. Records the error. */
function checkType(
  ctx: Ctx,
  b: WebGLBuffer,
  target: number,
  what: string,
): boolean {
  const element = target === E.ELEMENT_ARRAY_BUFFER;
  const copy = target === E.COPY_READ_BUFFER || target === E.COPY_WRITE_BUFFER;
  if (b._type === BUF_UNDEFINED) {
    b._type = element ? BUF_ELEMENT : BUF_OTHER;
    return true;
  }
  if (b._type === BUF_ELEMENT && !element && !copy) {
    ctx._e(E.INVALID_OPERATION, what);
    return false;
  }
  if (b._type === BUF_OTHER && element) {
    ctx._e(E.INVALID_OPERATION, what);
    return false;
  }
  return true;
}

export const bufferMethods = {
  createBuffer(this: Ctx): WebGLBuffer | null {
    if (this._skip()) return null;
    const b = new WebGLBuffer(INTERNAL, this, this._n.genBuffer());
    this._track(b);
    return b;
  },
  isBuffer(this: Ctx, buffer: unknown): boolean {
    if (this._lost || buffer === null || buffer === undefined) return false;
    if (!(buffer instanceof WebGLBuffer))
      throw new TypeError('isBuffer: argument is not a WebGLBuffer');
    return (
      buffer._ctx === this &&
      buffer._gen === this._gen &&
      !buffer._deleted &&
      buffer._bound
    );
  },
  deleteBuffer(this: Ctx, buffer: unknown): void {
    if (this._skip()) return;
    if (!this._owned(buffer, WebGLBuffer, 'deleteBuffer')) return;
    const b = buffer as WebGLBuffer;
    if (b._deleted) return;
    b._deleted = true;
    // GLES 3.0 §5.1.2: unbound from every binding of the current context, incl. the bound VAO / TF object.
    if (this._arrayBuffer === b) this._arrayBuffer = null;
    if (this._copyRead === b) this._copyRead = null;
    if (this._copyWrite === b) this._copyWrite = null;
    if (this._pixelPack === b) this._pixelPack = null;
    if (this._pixelUnpack === b) this._pixelUnpack = null;
    if (this._uniformBuffer === b) this._uniformBuffer = null;
    if (this._tfBuffer === b) this._tfBuffer = null;
    const vao = this._vao;
    if (vao._elementBuffer === b) vao._elementBuffer = null;
    for (let i = 0; i < vao._buffers.length; i++) {
      if (vao._buffers[i] === b) {
        vao._buffers[i] = null;
        if (vao._enabled[i]) vao._enabledWithoutBuffer++;
      }
    }
    for (let i = 0; i < this._uboBindings.length; i++)
      if (this._uboBindings[i] === b) this._uboBindings[i] = null;
    const tf = this._tf;
    for (let i = 0; i < tf._buffers.length; i++)
      if (tf._buffers[i] === b) tf._buffers[i] = null;
    this._untrack(b);
    this._n.deleteBuffer(b._name);
  },
  bindBuffer(this: Ctx, target: number, buffer: WebGLBuffer | null): void {
    if (this._skip()) return;
    target >>>= 0;
    if (!this._ok(buffer, WebGLBuffer, true, 'bindBuffer')) return;
    const cur = boundBuffer(this, target);
    if (cur === undefined) return this._e(E.INVALID_ENUM, 'bindBuffer');
    const b = buffer ?? null;
    if (cur === b) return;
    if (b !== null) {
      if (!checkType(this, b, target, 'bindBuffer')) return;
      b._bound = true;
    }
    setBound(this, target, b);
    this._n.bindBuffer(target, b ? b._name : 0);
  },
  bindBufferBase(
    this: Ctx,
    target: number,
    index: number,
    buffer: WebGLBuffer | null,
  ): void {
    if (this._skip()) return;
    target >>>= 0;
    index >>>= 0;
    if (!this._ok(buffer, WebGLBuffer, true, 'bindBufferBase')) return;
    const b = buffer ?? null;
    if (!indexedTarget(this, target, index, 'bindBufferBase')) return;
    if (b !== null) {
      if (!checkType(this, b, target, 'bindBufferBase')) return;
      b._bound = true;
    }
    setIndexed(this, target, index, b, 0, 0);
    setBound(this, target, b);
    this._n.bindBufferBase(target, index, b ? b._name : 0);
  },
  bindBufferRange(
    this: Ctx,
    target: number,
    index: number,
    buffer: WebGLBuffer | null,
    offset: number,
    size: number,
  ): void {
    if (this._skip()) return;
    target >>>= 0;
    index >>>= 0;
    const off = toInt64(offset);
    const sz = toInt64(size);
    if (!this._ok(buffer, WebGLBuffer, true, 'bindBufferRange')) return;
    const b = buffer ?? null;
    if (!indexedTarget(this, target, index, 'bindBufferRange')) return;
    if (b !== null) {
      if (off < 0 || sz <= 0)
        return this._e(E.INVALID_VALUE, 'bindBufferRange');
      if (
        target === E.UNIFORM_BUFFER &&
        off % this._getLimit(E.UNIFORM_BUFFER_OFFSET_ALIGNMENT) !== 0
      ) {
        return this._e(E.INVALID_VALUE, 'bindBufferRange');
      }
      if (
        target === E.TRANSFORM_FEEDBACK_BUFFER &&
        (off % 4 !== 0 || sz % 4 !== 0)
      ) {
        return this._e(E.INVALID_VALUE, 'bindBufferRange');
      }
      if (!checkType(this, b, target, 'bindBufferRange')) return;
      b._bound = true;
    }
    setIndexed(this, target, index, b, off, sz);
    setBound(this, target, b);
    // WebGL allows any positive uniform range size; Adreno rejects some unaligned sizes with INVALID_VALUE (CTS
    // uniform-block-buffer-size: blockSize - 1). Draws are validated against the recorded size above, so the driver
    // only reads a range the binding accepted: round the driver's size up to a whole vec4.
    const driverSize =
      target === E.UNIFORM_BUFFER && b !== null ? Math.ceil(sz / 16) * 16 : sz;
    this._n.bindBufferRange(target, index, b ? b._name : 0, off, driverSize);
  },
  bufferData(
    this: Ctx,
    target: number,
    data: unknown,
    usage: number,
    srcOffset?: number,
    length?: number,
  ): void {
    if (this._skip()) return;
    target >>>= 0;
    usage >>>= 0;
    const b = boundBuffer(this, target);
    if (b === undefined) return this._e(E.INVALID_ENUM, 'bufferData');
    if (!(this._v2 ? USAGE2 : USAGE1).has(usage))
      return this._e(E.INVALID_ENUM, 'bufferData');
    if (b === null) return this._e(E.INVALID_OPERATION, 'bufferData');
    if (data === null || data === undefined)
      return this._e(E.INVALID_VALUE, 'bufferData');
    if (typeof data !== 'object') {
      // WebIDL overload resolution: anything that is not a BufferSource selects the GLsizeiptr overload.
      if (typeof data === 'bigint' || typeof data === 'symbol')
        throw new TypeError('bufferData: size must be a number');
      const size = toInt64(data);
      if (size < 0) return this._e(E.INVALID_VALUE, 'bufferData');
      b._size = size;
      b._usage = usage;
      this._n.bufferDataZero(target, size, usage);
      return;
    }
    let view: ArrayBufferView;
    if (isView(data)) {
      view = data;
      if (srcOffset !== undefined && this._v2) {
        if (
          !viewRange(
            this,
            view,
            (srcOffset as number) >>> 0,
            (length ?? 0) >>> 0,
            'bufferData',
          )
        )
          return;
      } else {
        range.off = 0;
        range.bytes = view.byteLength;
      }
    } else if (data instanceof ArrayBuffer || isSharedArrayBuffer(data)) {
      view = new Uint8Array(data as ArrayBuffer);
      range.off = 0;
      range.bytes = view.byteLength;
    } else {
      // a non-BufferSource object converts through ToNumber (WebIDL long long): usually NaN -> 0
      const size = toInt64(data);
      if (size < 0) return this._e(E.INVALID_VALUE, 'bufferData');
      b._size = size;
      b._usage = usage;
      this._n.bufferDataZero(target, size, usage);
      return;
    }
    if (this._activeTfs.size !== 0 && boundToActiveTf(this, b))
      return this._e(E.INVALID_OPERATION, 'bufferData');
    b._size = range.bytes;
    b._usage = usage;
    this._n.bufferData(
      target,
      range.bytes,
      view,
      range.off,
      range.bytes,
      usage,
    );
  },
  bufferSubData(
    this: Ctx,
    target: number,
    dstByteOffset: number,
    srcData: unknown,
    srcOffset?: number,
    length?: number,
  ): void {
    if (this._skip()) return;
    target >>>= 0;
    const dst = toInt64(dstByteOffset);
    const b = boundBuffer(this, target);
    if (b === undefined) return this._e(E.INVALID_ENUM, 'bufferSubData');
    if (b === null) return this._e(E.INVALID_OPERATION, 'bufferSubData');
    if (srcData === null || srcData === undefined)
      throw new TypeError('bufferSubData: data is not a BufferSource');
    let view: ArrayBufferView;
    if (isView(srcData)) {
      view = srcData;
      if (srcOffset !== undefined && this._v2) {
        if (
          !viewRange(
            this,
            view,
            (srcOffset as number) >>> 0,
            (length ?? 0) >>> 0,
            'bufferSubData',
          )
        )
          return;
      } else {
        range.off = 0;
        range.bytes = view.byteLength;
      }
    } else if (srcData instanceof ArrayBuffer || isSharedArrayBuffer(srcData)) {
      view = new Uint8Array(srcData as ArrayBuffer);
      range.off = 0;
      range.bytes = view.byteLength;
    } else {
      throw new TypeError('bufferSubData: srcData is not a BufferSource');
    }
    if (dst < 0 || dst + range.bytes > b._size)
      return this._e(E.INVALID_VALUE, 'bufferSubData');
    if (range.bytes === 0) return;
    this._n.bufferSubData(
      target,
      dst,
      range.bytes,
      view,
      range.off,
      range.bytes,
    );
  },
  copyBufferSubData(
    this: Ctx,
    readTarget: number,
    writeTarget: number,
    readOffset: number,
    writeOffset: number,
    size: number,
  ): void {
    if (this._skip()) return;
    readTarget >>>= 0;
    writeTarget >>>= 0;
    const ro = toInt64(readOffset);
    const wo = toInt64(writeOffset);
    const sz = toInt64(size);
    const r = boundBuffer(this, readTarget);
    const w = boundBuffer(this, writeTarget);
    if (r === undefined || w === undefined)
      return this._e(E.INVALID_ENUM, 'copyBufferSubData');
    if (r === null || w === null)
      return this._e(E.INVALID_OPERATION, 'copyBufferSubData');
    if (ro < 0 || wo < 0 || sz < 0)
      return this._e(E.INVALID_VALUE, 'copyBufferSubData');
    if (ro + sz > r._size || wo + sz > w._size)
      return this._e(E.INVALID_VALUE, 'copyBufferSubData');
    if (r === w && Math.abs(ro - wo) < sz)
      return this._e(E.INVALID_VALUE, 'copyBufferSubData');
    // §5.1: element-array data cannot be copied into other data and vice versa.
    if (
      (r._type === BUF_ELEMENT) !== (w._type === BUF_ELEMENT) &&
      r._type !== BUF_UNDEFINED &&
      w._type !== BUF_UNDEFINED
    ) {
      return this._e(E.INVALID_OPERATION, 'copyBufferSubData');
    }
    this._n.copyBufferSubData(readTarget, writeTarget, ro, wo, sz);
  },
  getBufferSubData(
    this: Ctx,
    target: number,
    srcByteOffset: number,
    dstData: ArrayBufferView,
    dstOffset = 0,
    length = 0,
  ): void {
    if (this._skip()) return;
    target >>>= 0;
    const src = toInt64(srcByteOffset);
    if (!isView(dstData))
      throw new TypeError(
        'getBufferSubData: dstData is not an ArrayBufferView',
      );
    const b = boundBuffer(this, target);
    if (b === undefined) return this._e(E.INVALID_ENUM, 'getBufferSubData');
    if (b === null) return this._e(E.INVALID_OPERATION, 'getBufferSubData');
    if (target === E.TRANSFORM_FEEDBACK_BUFFER && this._tf._active)
      return this._e(E.INVALID_OPERATION, 'getBufferSubData');
    if (
      !viewRange(
        this,
        dstData,
        toInt64(dstOffset),
        length >>> 0,
        'getBufferSubData',
      )
    )
      return;
    if (src < 0 || src + range.bytes > b._size)
      return this._e(E.INVALID_VALUE, 'getBufferSubData');
    materialize(dstData);
    if (
      !this._n.getBufferSubData(target, src, dstData, range.off, range.bytes)
    ) {
      this._e(E.INVALID_OPERATION, 'getBufferSubData');
    }
  },
  getBufferParameter(this: Ctx, target: number, pname: number): unknown {
    if (this._skip()) return null;
    target >>>= 0;
    pname >>>= 0;
    const b = boundBuffer(this, target);
    if (b === undefined) {
      this._e(E.INVALID_ENUM, 'getBufferParameter');
      return null;
    }
    if (pname !== E.BUFFER_SIZE && pname !== E.BUFFER_USAGE) {
      this._e(E.INVALID_ENUM, 'getBufferParameter');
      return null;
    }
    if (b === null) {
      this._e(E.INVALID_OPERATION, 'getBufferParameter');
      return null;
    }
    return pname === E.BUFFER_SIZE ? b._size : b._usage;
  },
};

/** A buffer bound to the active transform feedback object cannot be respecified (WebGL 2.0 §5.?). */
export function boundToActiveTf(ctx: Ctx, b: WebGLBuffer): boolean {
  for (const tf of ctx._activeTfs) {
    for (let i = 0; i < tf._buffers.length; i++)
      if (tf._buffers[i] === b) return true;
  }
  return false;
}

function isSharedArrayBuffer(v: unknown): boolean {
  const SAB = (globalThis as { SharedArrayBuffer?: Function })
    .SharedArrayBuffer;
  return !!SAB && v instanceof SAB;
}

function indexedTarget(
  ctx: Ctx,
  target: number,
  index: number,
  what: string,
): boolean {
  if (target === E.UNIFORM_BUFFER) {
    if (index >= ctx._maxUboBindings) {
      ctx._e(E.INVALID_VALUE, what);
      return false;
    }
    return true;
  }
  if (target === E.TRANSFORM_FEEDBACK_BUFFER) {
    if (index >= ctx._maxTfBuffers) {
      ctx._e(E.INVALID_VALUE, what);
      return false;
    }
    if (ctx._tf._active) {
      ctx._e(E.INVALID_OPERATION, what);
      return false;
    }
    return true;
  }
  ctx._e(E.INVALID_ENUM, what);
  return false;
}

function setIndexed(
  ctx: Ctx,
  target: number,
  index: number,
  b: WebGLBuffer | null,
  off: number,
  size: number,
): void {
  if (target === E.UNIFORM_BUFFER) {
    ctx._uboBindings[index] = b;
    ctx._uboRanges[index * 2] = off;
    ctx._uboRanges[index * 2 + 1] = size;
  } else {
    ctx._tf._buffers[index] = b;
    ctx._tf._offsets[index] = off;
    ctx._tf._sizes[index] = size;
  }
}
