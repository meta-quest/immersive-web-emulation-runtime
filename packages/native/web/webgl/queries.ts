/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Queries, sync objects, samplers and transform feedback objects. Query and sync results follow WebGL's
// "not available in the same task" rule (spec GL-15): availability may become true only after the epoch
// advances (task end / XR frame boundary). Timer queries (EXT_disjoint_timer_query_webgl2, GL-26).

import type { Ctx } from './core.ts';
import * as E from './gen/enums.gen.ts';
import { INTERNAL, WebGLQuery, WebGLSampler, WebGLSync, WebGLTransformFeedback } from './objects.ts';
import { recordSamplingParam, texParamError } from './textures.ts';

const TIMEOUT_IGNORED = -1;

function queryTargetOk(ctx: Ctx, target: number): boolean {
  switch (target) {
    case E.ANY_SAMPLES_PASSED:
    case E.ANY_SAMPLES_PASSED_CONSERVATIVE:
    case E.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN:
      return true;
    case E.TIME_ELAPSED_EXT:
      return ctx._extensions.has('EXT_disjoint_timer_query_webgl2') || ctx._extensions.has('EXT_disjoint_timer_query');
  }
  return false;
}

/** ANY_SAMPLES_PASSED and ..._CONSERVATIVE share one active slot (GLES 3.0 §4.1.6). */
function slotOf(target: number): number {
  return target === E.ANY_SAMPLES_PASSED_CONSERVATIVE ? E.ANY_SAMPLES_PASSED : target;
}

export const queryMethods = {
  createQuery(this: Ctx): WebGLQuery | null {
    if (this._skip()) return null;
    const q = new WebGLQuery(INTERNAL, this, this._n.genQuery());
    this._track(q);
    return q;
  },
  isQuery(this: Ctx, q: unknown): boolean {
    if (this._lost || q === null || q === undefined) return false;
    if (!(q instanceof WebGLQuery)) throw new TypeError('isQuery: argument is not a WebGLQuery');
    return q._ctx === this && q._gen === this._gen && !q._deleted && q._target !== 0;
  },
  deleteQuery(this: Ctx, q: unknown): void {
    if (this._skip()) return;
    if (!this._owned(q, WebGLQuery, 'deleteQuery')) return;
    const query = q as WebGLQuery;
    if (query._deleted) return;
    query._deleted = true;
    if (query._active) {
      // Deleting an active query ends it (as browsers do). Adreno keeps the target active after
      // glDeleteQueries, so the next beginQuery on that target would fail in the driver (CTS query.html).
      this._activeQueries.delete(slotOf(query._target));
      query._active = false;
      this._n.endQuery(query._target);
    }
    this._untrack(query);
    this._n.deleteQuery(query._name);
  },
  beginQuery(this: Ctx, target: number, q: WebGLQuery): void {
    if (this._skip()) return;
    target >>>= 0;
    if (!this._ok(q, WebGLQuery, false, 'beginQuery')) return;
    if (!queryTargetOk(this, target)) return this._e(E.INVALID_ENUM, 'beginQuery');
    if (this._activeQueries.has(slotOf(target))) return this._e(E.INVALID_OPERATION, 'beginQuery');
    if (q._active || (q._target !== 0 && q._target !== target)) return this._e(E.INVALID_OPERATION, 'beginQuery');
    q._target = target;
    q._active = true;
    q._bound = true;
    q._availableAfter = Infinity;
    this._activeQueries.set(slotOf(target), q);
    this._n.beginQuery(target, q._name);
  },
  endQuery(this: Ctx, target: number): void {
    if (this._skip()) return;
    target >>>= 0;
    if (!queryTargetOk(this, target)) return this._e(E.INVALID_ENUM, 'endQuery');
    const q = this._activeQueries.get(slotOf(target));
    if (!q || q._target !== target) return this._e(E.INVALID_OPERATION, 'endQuery');
    this._activeQueries.delete(slotOf(target));
    q._active = false;
    q._availableAfter = this._epoch() + 1;
    this._scheduleEpoch();
    this._n.endQuery(target);
  },
  getQuery(this: Ctx, target: number, pname: number): unknown {
    if (this._skip()) return null;
    target >>>= 0;
    pname >>>= 0;
    if (target === E.TIMESTAMP_EXT && (this._extensions.has('EXT_disjoint_timer_query_webgl2') || this._extensions.has('EXT_disjoint_timer_query'))) {
      if (pname === E.CURRENT_QUERY) return null; // timestamps are never "current"
      if (pname === E.QUERY_COUNTER_BITS_EXT) {
        this._n.getQueryiv(target, pname, this._i32, 0, 4);
        return this._i32[0];
      }
    }
    if (!queryTargetOk(this, target)) {
      this._e(E.INVALID_ENUM, 'getQuery');
      return null;
    }
    if (pname === E.CURRENT_QUERY) {
      const q = this._activeQueries.get(slotOf(target));
      return q && q._target === target ? q : null;
    }
    if (pname === E.QUERY_COUNTER_BITS_EXT && target === E.TIME_ELAPSED_EXT) {
      this._n.getQueryiv(target, pname, this._i32, 0, 4);
      return this._i32[0];
    }
    this._e(E.INVALID_ENUM, 'getQuery');
    return null;
  },
  getQueryParameter(this: Ctx, q: WebGLQuery, pname: number): unknown {
    if (this._skip()) return null;
    pname >>>= 0;
    if (!this._ok(q, WebGLQuery, false, 'getQueryParameter')) return null;
    if (q._active || q._target === 0) {
      this._e(E.INVALID_OPERATION, 'getQueryParameter');
      return null;
    }
    const visible = this._epoch() >= q._availableAfter;
    switch (pname) {
      case E.QUERY_RESULT_AVAILABLE: {
        if (!visible) return false;
        this._n.getQueryObjectuiv(q._name, E.QUERY_RESULT_AVAILABLE, this._u32, 0, 4);
        return this._u32[0] !== 0;
      }
      case E.QUERY_RESULT: {
        if (!visible) return 0;
        if (q._target === E.TIME_ELAPSED_EXT || q._target === E.TIMESTAMP_EXT) {
          this._n.getQueryObjectui64vEXT(q._name, E.QUERY_RESULT, this._i64, 0, 8);
          return Number(BigInt.asUintN(64, this._i64[0]));
        }
        this._n.getQueryObjectuiv(q._name, E.QUERY_RESULT, this._u32, 0, 4);
        return this._u32[0]; // GLuint for every query type (QUERY_RESULT_AVAILABLE is the boolean one)
      }
    }
    this._e(E.INVALID_ENUM, 'getQueryParameter');
    return null;
  },

  // ------------------------------------------------------------------------------------------- samplers
  createSampler(this: Ctx): WebGLSampler | null {
    if (this._skip()) return null;
    const s = new WebGLSampler(INTERNAL, this, this._n.genSampler());
    this._track(s);
    return s;
  },
  isSampler(this: Ctx, s: unknown): boolean {
    if (this._lost || s === null || s === undefined) return false;
    if (!(s instanceof WebGLSampler)) throw new TypeError('isSampler: argument is not a WebGLSampler');
    return s._ctx === this && s._gen === this._gen && !s._deleted;
  },
  deleteSampler(this: Ctx, s: unknown): void {
    if (this._skip()) return;
    if (!this._owned(s, WebGLSampler, 'deleteSampler')) return;
    const sampler = s as WebGLSampler;
    if (sampler._deleted) return;
    sampler._deleted = true;
    for (let i = 0; i < this._samplers.length; i++) if (this._samplers[i] === sampler) this._samplers[i] = null;
    this._texDirty = true;
    this._untrack(sampler);
    this._n.deleteSampler(sampler._name);
  },
  bindSampler(this: Ctx, unit: number, s: WebGLSampler | null): void {
    if (this._skip()) return;
    unit >>>= 0;
    if (!this._ok(s, WebGLSampler, true, 'bindSampler')) return;
    if (unit >= this._maxUnits) return this._e(E.INVALID_VALUE, 'bindSampler');
    const sampler = s ?? null;
    if (this._samplers[unit] === sampler) return;
    this._samplers[unit] = sampler;
    this._texDirty = true;
    if (sampler) sampler._bound = true;
    this._n.bindSampler(unit, sampler ? sampler._name : 0);
  },
  samplerParameteri(this: Ctx, s: WebGLSampler, pname: number, param: number): void {
    samplerParameter(this, s, pname >>> 0, param | 0, false);
  },
  samplerParameterf(this: Ctx, s: WebGLSampler, pname: number, param: number): void {
    samplerParameter(this, s, pname >>> 0, +param, true);
  },
  getSamplerParameter(this: Ctx, s: WebGLSampler, pname: number): unknown {
    if (this._skip()) return null;
    pname >>>= 0;
    if (!this._ok(s, WebGLSampler, false, 'getSamplerParameter')) return null;
    switch (pname) {
      case E.TEXTURE_MIN_LOD:
      case E.TEXTURE_MAX_LOD:
        this._n.getSamplerParameterfv(s._name, pname, this._f32, 0, 4);
        return this._f32[0];
      case E.TEXTURE_MAX_ANISOTROPY_EXT:
        if (!this._extensions.has('EXT_texture_filter_anisotropic')) break;
        this._n.getSamplerParameterfv(s._name, pname, this._f32, 0, 4);
        return this._f32[0];
      case E.TEXTURE_COMPARE_FUNC:
      case E.TEXTURE_COMPARE_MODE:
      case E.TEXTURE_MAG_FILTER:
      case E.TEXTURE_MIN_FILTER:
      case E.TEXTURE_WRAP_R:
      case E.TEXTURE_WRAP_S:
      case E.TEXTURE_WRAP_T:
        this._n.getSamplerParameteriv(s._name, pname, this._i32, 0, 4);
        return this._i32[0];
    }
    this._e(E.INVALID_ENUM, 'getSamplerParameter');
    return null;
  },

  // ------------------------------------------------------------------------------------------- sync
  fenceSync(this: Ctx, condition: number, flags: number): WebGLSync | null {
    if (this._skip()) return null;
    condition >>>= 0;
    flags >>>= 0;
    if (condition !== E.SYNC_GPU_COMMANDS_COMPLETE) {
      this._e(E.INVALID_ENUM, 'fenceSync');
      return null;
    }
    if (flags !== 0) {
      this._e(E.INVALID_VALUE, 'fenceSync');
      return null;
    }
    const id = this._n.fenceSync(condition, flags);
    if (!id) return null;
    const s = new WebGLSync(INTERNAL, this, id, this._epoch() + 1);
    this._scheduleEpoch();
    this._track(s);
    return s;
  },
  isSync(this: Ctx, s: unknown): boolean {
    if (this._lost || s === null || s === undefined) return false;
    if (!(s instanceof WebGLSync)) throw new TypeError('isSync: argument is not a WebGLSync');
    return s._ctx === this && s._gen === this._gen && !s._deleted;
  },
  deleteSync(this: Ctx, s: unknown): void {
    if (this._skip()) return;
    if (!this._owned(s, WebGLSync, 'deleteSync')) return;
    const sync = s as WebGLSync;
    if (sync._deleted) return;
    sync._deleted = true;
    this._untrack(sync);
    this._n.deleteSync(sync._name);
  },
  clientWaitSync(this: Ctx, s: WebGLSync, flags: number, timeout: number): number {
    if (this._skip()) return E.WAIT_FAILED;
    flags >>>= 0;
    const t = Number(timeout);
    if (!this._ok(s, WebGLSync, false, 'clientWaitSync')) return E.WAIT_FAILED;
    if (flags !== 0 && flags !== E.SYNC_FLUSH_COMMANDS_BIT) {
      this._e(E.INVALID_VALUE, 'clientWaitSync');
      return E.WAIT_FAILED;
    }
    if (t > 0) {
      // MAX_CLIENT_WAIT_TIMEOUT_WEBGL is 0 (GL-13, GL-15)
      this._e(E.INVALID_OPERATION, 'clientWaitSync');
      return E.WAIT_FAILED;
    }
    if (s._signaled) return E.ALREADY_SIGNALED;
    if (this._epoch() < s._availableAfter) {
      if (flags & E.SYNC_FLUSH_COMMANDS_BIT) this._n.flush();
      return E.TIMEOUT_EXPIRED;
    }
    const r = this._n.clientWaitSync(s._name, flags, 0);
    if (r === E.ALREADY_SIGNALED || r === E.CONDITION_SATISFIED) s._signaled = true;
    return r;
  },
  waitSync(this: Ctx, s: WebGLSync, flags: number, timeout: number): void {
    if (this._skip()) return;
    if (!this._ok(s, WebGLSync, false, 'waitSync')) return;
    if ((flags >>> 0) !== 0 || Number(timeout) !== TIMEOUT_IGNORED) return this._e(E.INVALID_VALUE, 'waitSync');
    this._n.waitSync(s._name, 0, TIMEOUT_IGNORED);
  },
  getSyncParameter(this: Ctx, s: WebGLSync, pname: number): unknown {
    if (this._skip()) return null;
    pname >>>= 0;
    if (!this._ok(s, WebGLSync, false, 'getSyncParameter')) return null;
    switch (pname) {
      case E.OBJECT_TYPE:
        return E.SYNC_FENCE;
      case E.SYNC_CONDITION:
        return E.SYNC_GPU_COMMANDS_COMPLETE;
      case E.SYNC_FLAGS:
        return 0;
      case E.SYNC_STATUS: {
        if (s._signaled) return E.SIGNALED;
        if (this._epoch() < s._availableAfter) return E.UNSIGNALED;
        const v = this._n.getSynciv(s._name, E.SYNC_STATUS);
        if (v === E.SIGNALED) s._signaled = true;
        return v;
      }
    }
    this._e(E.INVALID_ENUM, 'getSyncParameter');
    return null;
  },

  // ------------------------------------------------------------------------------------------- transform feedback
  createTransformFeedback(this: Ctx): WebGLTransformFeedback | null {
    if (this._skip()) return null;
    const t = new WebGLTransformFeedback(INTERNAL, this, this._n.genTransformFeedback(), this._maxTfBuffers);
    this._track(t);
    return t;
  },
  isTransformFeedback(this: Ctx, t: unknown): boolean {
    if (this._lost || t === null || t === undefined) return false;
    if (!(t instanceof WebGLTransformFeedback)) throw new TypeError('isTransformFeedback: argument is not a WebGLTransformFeedback');
    return t._ctx === this && t._gen === this._gen && !t._deleted && t._bound;
  },
  deleteTransformFeedback(this: Ctx, t: unknown): void {
    if (this._skip()) return;
    if (!this._owned(t, WebGLTransformFeedback, 'deleteTransformFeedback')) return;
    const tf = t as WebGLTransformFeedback;
    if (tf._deleted || tf._name === 0) return;
    if (tf._active) return this._e(E.INVALID_OPERATION, 'deleteTransformFeedback');
    tf._deleted = true;
    if (this._tf === tf) this._tf = this._defaultTf;
    this._untrack(tf);
    this._n.deleteTransformFeedback(tf._name);
  },
  bindTransformFeedback(this: Ctx, target: number, t: WebGLTransformFeedback | null): void {
    if (this._skip()) return;
    target >>>= 0;
    if (!this._ok(t, WebGLTransformFeedback, true, 'bindTransformFeedback')) return;
    if (target !== E.TRANSFORM_FEEDBACK) return this._e(E.INVALID_ENUM, 'bindTransformFeedback');
    const tf = t ?? this._defaultTf;
    if (this._tf._active && !this._tf._paused) return this._e(E.INVALID_OPERATION, 'bindTransformFeedback');
    if (this._tf === tf) return;
    this._tf = tf;
    tf._bound = true;
    this._n.bindTransformFeedback(target, tf._name);
  },
  beginTransformFeedback(this: Ctx, primitiveMode: number): void {
    if (this._skip()) return;
    primitiveMode >>>= 0;
    if (primitiveMode !== E.POINTS && primitiveMode !== E.LINES && primitiveMode !== E.TRIANGLES) {
      return this._e(E.INVALID_ENUM, 'beginTransformFeedback');
    }
    const tf = this._tf;
    const p = this._program;
    if (tf._active || !p) return this._e(E.INVALID_OPERATION, 'beginTransformFeedback');
    // The program must capture varyings and every capture slot needs a buffer (GLES 3.0 §2.15.2).
    const rec = this._programRecord(p);
    if (!rec || !rec.linked || rec.varyings.length === 0) return this._e(E.INVALID_OPERATION, 'beginTransformFeedback');
    const slots = rec.tfBufferMode === E.SEPARATE_ATTRIBS ? rec.varyings.length : 1;
    for (let i = 0; i < slots; i++) if (!tf._buffers[i]) return this._e(E.INVALID_OPERATION, 'beginTransformFeedback');
    // one buffer at two binding points (used or not by the program) is an error in WebGL (no overlapping writes)
    const bufs = tf._buffers;
    for (let i = 0; i < bufs.length; i++) for (let j = i + 1; j < bufs.length; j++) {
      if (bufs[i] !== null && bufs[i] === bufs[j]) return this._e(E.INVALID_OPERATION, 'beginTransformFeedback');
    }
    tf._active = true;
    tf._written = 0;
    this._activeTfs.add(tf);
    tf._mode = primitiveMode;
    tf._paused = false;
    tf._program = this._program;
    this._n.beginTransformFeedback(primitiveMode);
  },
  endTransformFeedback(this: Ctx): void {
    if (this._skip()) return;
    const tf = this._tf;
    if (!tf._active) return this._e(E.INVALID_OPERATION, 'endTransformFeedback');
    tf._active = false;
    this._activeTfs.delete(tf);
    tf._paused = false;
    tf._program = null;
    this._n.endTransformFeedback();
  },
  pauseTransformFeedback(this: Ctx): void {
    if (this._skip()) return;
    const tf = this._tf;
    if (!tf._active || tf._paused) return this._e(E.INVALID_OPERATION, 'pauseTransformFeedback');
    tf._paused = true;
    this._n.pauseTransformFeedback();
  },
  resumeTransformFeedback(this: Ctx): void {
    if (this._skip()) return;
    const tf = this._tf;
    if (!tf._active || !tf._paused || tf._program !== this._program) return this._e(E.INVALID_OPERATION, 'resumeTransformFeedback');
    tf._paused = false;
    this._n.resumeTransformFeedback();
  },
};

function samplerParameter(ctx: Ctx, s: WebGLSampler, pname: number, param: number, isFloat: boolean): void {
  const what = isFloat ? 'samplerParameterf' : 'samplerParameteri';
  if (ctx._skip()) return;
  if (!ctx._ok(s, WebGLSampler, false, what)) return;
  const err = texParamError(ctx, pname, param, true);
  if (err) return ctx._e(err, what);
  recordSamplingParam(ctx, s, pname, param);
  if (isFloat) ctx._n.samplerParameterf(s._name, pname, param);
  else ctx._n.samplerParameteri(s._name, pname, param);
}

/** EXT_disjoint_timer_query_webgl2.queryCounterEXT (method of the extension object). */
export function queryCounter(ctx: Ctx, q: WebGLQuery, target: number): void {
  if (ctx._skip()) return;
  if (!ctx._ok(q, WebGLQuery, false, 'queryCounterEXT')) return;
  if ((target >>> 0) !== E.TIMESTAMP_EXT) return ctx._e(E.INVALID_ENUM, 'queryCounterEXT');
  if (q._active || (q._target !== 0 && q._target !== E.TIMESTAMP_EXT)) return ctx._e(E.INVALID_OPERATION, 'queryCounterEXT');
  q._target = E.TIMESTAMP_EXT;
  q._bound = true;
  q._availableAfter = ctx._epoch() + 1;
  ctx._scheduleEpoch();
  ctx._n.queryCounterEXT(q._name, E.TIMESTAMP_EXT);
}
