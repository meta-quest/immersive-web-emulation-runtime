/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Typed-array argument rules (spec GL-7): offsets and lengths in elements of the view, the view's own
// byteOffset honoured (natives take the view itself plus an offset from its start, so that is automatic),
// out-of-range = INVALID_VALUE, detached = length 0. Sequence arguments (Float32List & co.) are converted into
// per-context scratch arrays so steady-state calls do not allocate (GL-PERF-3).

import type { Ctx } from './core.ts';
import * as E from './gen/enums.gen.ts';

/** Result slots of viewRange (avoid returning tuples). */
export const range = { off: 0, bytes: 0 };

export function isView(v: unknown): v is ArrayBufferView {
  return ArrayBuffer.isView(v);
}

function viewLength(v: ArrayBufferView): number {
  // DataView has no .length: measured in bytes.
  const len = (v as { length?: number }).length;
  return len === undefined ? v.byteLength : len;
}

/**
 * Element range [srcOffset, srcOffset + length) of `view` as a byte range from the view start, into `range`.
 * length 0 = to the end. Returns false (after recording INVALID_VALUE) when out of range.
 */
export function viewRange(ctx: Ctx, view: ArrayBufferView, srcOffset: number, length: number, what: string): boolean {
  const elems = viewLength(view);
  const bpe = (view as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
  if (srcOffset < 0 || srcOffset > elems) {
    ctx._e(E.INVALID_VALUE, what);
    return false;
  }
  const n = length === 0 ? elems - srcOffset : length;
  if (n < 0 || srcOffset + n > elems) {
    ctx._e(E.INVALID_VALUE, what);
    return false;
  }
  range.off = srcOffset * bpe;
  range.bytes = n * bpe;
  return true;
}

/** Natives write into views in place only when the view owns an ArrayBuffer (see runtime/gl/src/v8_support.h). */
export function materialize(view: ArrayBufferView): void {
  void view.buffer;
}

/**
 * Convert a Float32List argument: a Float32Array is used as is; any other iterable (array, other typed
 * array) is converted element by element into the context's scratch array (WebIDL union conversion).
 * Returns the array to pass, or null after throwing TypeError for a non-iterable.
 */
export function f32List(ctx: Ctx, v: unknown, what: string): Float32Array {
  if (v instanceof Float32Array) return v;
  return toScratch(ctx, v, 'f', what) as Float32Array;
}
export function i32List(ctx: Ctx, v: unknown, what: string): Int32Array {
  if (v instanceof Int32Array) return v;
  return toScratch(ctx, v, 'i', what) as Int32Array;
}
export function u32List(ctx: Ctx, v: unknown, what: string): Uint32Array {
  if (v instanceof Uint32Array) return v;
  return toScratch(ctx, v, 'u', what) as Uint32Array;
}

function toScratch(ctx: Ctx, v: unknown, kind: 'f' | 'i' | 'u', what: string): Float32Array | Int32Array | Uint32Array {
  let src: ArrayLike<unknown>;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    src = v as ArrayLike<unknown>;
  } else if (v !== null && typeof v === 'object' && typeof (v as Iterable<unknown>)[Symbol.iterator] === 'function') {
    src = Array.from(v as Iterable<unknown>);
  } else {
    throw new TypeError(`${what}: argument is not a sequence`);
  }
  const n = src.length;
  let out: Float32Array | Int32Array | Uint32Array;
  if (kind === 'f') {
    if (ctx._f32Scratch.length < n) ctx._f32Scratch = new Float32Array(Math.max(n, ctx._f32Scratch.length * 2));
    out = ctx._f32Scratch;
    for (let i = 0; i < n; i++) out[i] = +(src[i] as number);
  } else if (kind === 'i') {
    if (ctx._i32Scratch.length < n) ctx._i32Scratch = new Int32Array(Math.max(n, ctx._i32Scratch.length * 2));
    out = ctx._i32Scratch;
    for (let i = 0; i < n; i++) out[i] = (src[i] as number) | 0;
  } else {
    if (ctx._u32Scratch.length < n) ctx._u32Scratch = new Uint32Array(Math.max(n, ctx._u32Scratch.length * 2));
    out = ctx._u32Scratch;
    for (let i = 0; i < n; i++) out[i] = (src[i] as number) >>> 0;
  }
  scratchLength = n;
  return out;
}

/** Number of valid elements in the scratch array returned by the last *List conversion. */
export let scratchLength = 0;

/** Element count of a list argument as converted by f32List & co. */
export function listLength(original: unknown, converted: ArrayLike<number>): number {
  return original === converted ? converted.length : scratchLength;
}
