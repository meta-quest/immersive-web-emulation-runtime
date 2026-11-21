/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Draw calls with WebGL's draw-time validation (spec GL-9) done in JS from cached state, so no draw needs a
// driver round trip: no program / unlinked program, client-side arrays (enabled attribute without a buffer),
// element-array binding and offset alignment, multiview view-count mismatch (OVR_multiview2, GL-24) and
// texture feedback loops (recomputed only when bindings that can create one change). Multi-draw (GL-25) is
// one native call per multi-draw; webgl_DrawID is set natively per sub-draw.

import type { Ctx } from './core.ts';
import * as E from './gen/enums.gen.ts';
import { indexTypeBytes } from './formats.ts';
import { programExtras } from './programs.ts';
import { WebGLTexture } from './objects.ts';
import { textureKind, isFloat32Format, TK_FLOAT, TK_INT, TK_UINT, TK_DEPTH } from './textures.ts';
import { i32List } from './views.ts';
import { attachmentFormat, framebufferVerdict, formatClass, sharedExponentMaskConflict } from './framebuffers.ts';
import { OUT_INT, OUT_UINT, type ProgramRecord } from './reflection.ts';
import type { WebGLFramebuffer } from './objects.ts';
import { valueTypes } from './attribs.ts';

function toInt64(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
}

function textureForTarget(ctx: Ctx, unit: number, target: number): WebGLTexture | null {
  switch (target) {
    case E.TEXTURE_2D:
      return ctx._tex2D[unit] ?? null;
    case E.TEXTURE_CUBE_MAP:
      return ctx._texCube[unit] ?? null;
    case E.TEXTURE_3D:
      return ctx._tex3D[unit] ?? null;
    case E.TEXTURE_2D_ARRAY:
      return ctx._tex2DArray[unit] ?? null;
  }
  return null;
}

export const drawInternals = {
  /** Common draw validation; records the error and returns false when the draw must not reach GL. */
  _drawCheck(this: Ctx, mode: number, what: string): boolean {
    if (mode > E.TRIANGLE_FAN) {
      this._e(E.INVALID_ENUM, what);
      return false;
    }
    const p = this._program;
    if (p === null) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    const rec = p._linkPending ? this._programRecord(p) : p._record;
    if (rec === null || !rec.linked) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    const fb = this._drawFbo;
    if (fb === null) {
      if (!this._dfbReady || this._dfbNeedsClear) this._ensureDefaultFramebuffer();
      this._dfbDrawn = true;
    } else {
      if ((p._numViews || 1) !== (fb._numViews || 1)) {
        // OVR_multiview2: the program's num_views must match the framebuffer's views. Non-multiview programs and
        // non-multiview framebuffers count as one view (as in ANGLE), so num_views = 1 draws anywhere single-view.
        this._e(E.INVALID_OPERATION, what);
        return false;
      }
      if (fb._verdictEpoch !== this._fbEpoch ? framebufferVerdict(this, fb, E.DRAW_FRAMEBUFFER) : fb._verdict) {
        this._e(E.INVALID_FRAMEBUFFER_OPERATION, what);
        return false;
      }
      if (fb._numViews > 1 && ((this._tf._active && !this._tf._paused) || this._activeQueries.has(E.TIME_ELAPSED_EXT))) {
        this._e(E.INVALID_OPERATION, what);
        return false;
      }
    }
    if (fb === null && p._numViews > 1) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    if (this._v2 && rec.outMask !== 0xffff && this._caps[9] !== 1 && !outputsMatch(this, rec, fb)) {
      this._e(E.INVALID_OPERATION, what); // undefined output for an active draw buffer, or output / buffer type
      return false;
    }
    if (this._vao._enabledWithoutBuffer > 0) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    if (this._attribsDirty) {
      this._attribsDirty = false;
      this._attribsOk = attribTypesMatch(this, rec);
    }
    if (!this._attribsOk) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    if (this._feedbackDirty) this._computeFeedback();
    if (this._feedbackLoop) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    if (this._texDirty) computeTextures(this);
    if (this._texInvalid) {
      this._e(E.INVALID_OPERATION, what); // sampler type vs texture format / compare mode (WebGL 2.0 §5.22)
      return false;
    }
    if (fb !== null && fb._rgb9e5 !== 0 && sharedExponentMaskConflict(this, fb)) {
      this._e(E.INVALID_OPERATION, what); // WEBGL_render_shared_exponent colour-mask rule
      return false;
    }
    if (this._caps[0] === 1 && fb !== null && fb._has32F && !floatBlendSupported(this)) {
      this._e(E.INVALID_OPERATION, what); // blending a 32-bit float colour buffer needs EXT_float_blend
      return false;
    }
    if (this._stencilMismatch && stencilConflict(this)) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    if (rec.blocks.length !== 0 && !uniformBlocksBacked(this, rec)) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    if (this._tf._active && !this._tf._paused && (tfConflict(this) || !tfModeOk(this._tf._mode, mode))) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    return true;
  },
  /** Is any texture sampled by the current program also attached to the draw framebuffer at a sampled level? */
  _computeFeedback(this: Ctx): void {
    this._feedbackDirty = false;
    this._feedbackLoop = false;
    const fb = this._drawFbo;
    const p = this._program;
    if (fb === null || fb._texAttachments === 0 || p === null || p._record === null) return;
    const x = programExtras(p);
    for (const [index, target] of x.samplers) {
      const u = p._record.uniforms[index];
      for (let e = 0; e < u.size; e++) {
        const unit = x.samplerUnits.get(index * 4096 + e) ?? 0;
        const t = textureForTarget(this, unit, target);
        // incomplete (never specified) textures sample as black and are not a loop
        if (t === null || t._attachCount === 0 || (t._level0 === null && !t._immutable)) continue;
        for (const a of fb._attachments.values()) {
          if (a.object === t && a.level >= t._baseLevel && a.level <= t._maxLevel) {
            this._feedbackLoop = true;
            return;
          }
        }
      }
    }
  },
  _elementsCheck(this: Ctx, count: number, type: number, offset: number, what: string): boolean {
    const size = indexTypeBytes(type);
    if (size === 0 || (size === 4 && !this._v2 && !this._extensions.has('OES_element_index_uint'))) {
      this._e(E.INVALID_ENUM, what);
      return false;
    }
    if (count < 0 || offset < 0) {
      this._e(E.INVALID_VALUE, what);
      return false;
    }
    if (offset % size !== 0) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    if (this._vao._elementBuffer === null) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    // Indices past the end of the element buffer (WebGL 2 §5.13.11 / WebGL 1 §6.6): the context is not robust, so
    // without this check the driver would read past the buffer.
    if (offset + count * size > this._vao._elementBuffer._size) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    return true;
  },
};

/**
 * WebGL 2.0 §5.? (draw buffers / fragment output types, as ANGLE's WebGL validation): every active draw buffer
 * with an attachment and a colour mask with any channel on needs a fragment output at its location, and that
 * output's base type (float / int / uint) must match the colour buffer's.
 */
function outputsMatch(ctx: Ctx, rec: ProgramRecord, fb: WebGLFramebuffer | null): boolean {
  if (fb === null) {
    if (ctx._dfbDrawBuffer === E.NONE) return true;
    if (!(rec.outMask & 1)) return (ctx._bufMaskOn & 1) === 0;
    const k = rec.outKinds[0];
    return k !== OUT_INT && k !== OUT_UINT;
  }
  const bufs = fb._drawBuffers;
  for (let i = 0; i < bufs.length; i++) {
    const b = bufs[i];
    if (b === E.NONE) continue;
    const a = fb._attachments.get(b);
    if (!a) continue;
    if (!(rec.outMask & (1 << i))) {
      if (ctx._bufMaskOn & (1 << i)) return false;
      continue;
    }
    const k = rec.outKinds[i];
    if (k === 0) continue;
    const c = formatClass(attachmentFormat(a));
    if ((c === 'i') !== (k === OUT_INT) || (c === 'u') !== (k === OUT_UINT)) return false;
  }
  return true;
}

/** Sampler uniform kinds: 0 float, 1 int, 2 uint, 3 shadow. */
function samplerKind(type: number): number {
  switch (type) {
    case E.INT_SAMPLER_2D: case E.INT_SAMPLER_3D: case E.INT_SAMPLER_CUBE: case E.INT_SAMPLER_2D_ARRAY:
      return TK_INT;
    case E.UNSIGNED_INT_SAMPLER_2D: case E.UNSIGNED_INT_SAMPLER_3D: case E.UNSIGNED_INT_SAMPLER_CUBE:
    case E.UNSIGNED_INT_SAMPLER_2D_ARRAY:
      return TK_UINT;
    case E.SAMPLER_2D_SHADOW: case E.SAMPLER_CUBE_SHADOW: case E.SAMPLER_2D_ARRAY_SHADOW:
      return TK_DEPTH;
    default:
      return TK_FLOAT;
  }
}

const usesMips = (f: number): boolean => f !== E.NEAREST && f !== E.LINEAR;
const linear = (f: number): boolean => f === E.LINEAR || f === E.LINEAR_MIPMAP_NEAREST || f === E.LINEAR_MIPMAP_LINEAR || f === E.NEAREST_MIPMAP_LINEAR;

/**
 * Draw-time texture rules WebGL adds to GLES, recomputed only when a binding, sampling parameter, level,
 * sampler uniform or program changed (`_texDirty`):
 *  - WebGL 2.0 §5.22 (sampler / texture compatibility): float samplers take float / normalized textures and
 *    depth textures with TEXTURE_COMPARE_MODE NONE; isampler* signed integer, usampler* unsigned integer
 *    textures; shadow samplers depth textures with COMPARE_REF_TO_TEXTURE (the bound sampler object's mode
 *    wins). Otherwise draws record INVALID_OPERATION.
 *  - textures WebGL treats as incomplete although the driver would sample them: 32-bit float with a LINEAR
 *    filter without OES_texture_float_linear; depth textures with compare mode NONE and a LINEAR filter
 *    (WebGL 2); WebGL 1 NPOT textures with mipmap filtering or REPEAT wraps; WebGL 1 half-float textures
 *    with a LINEAR filter without OES_texture_half_float_linear.
 *    They are bound to a never-specified (black) texture for the draw (`_texSubst`).
 */
function computeTextures(ctx: Ctx): void {
  ctx._texDirty = false;
  ctx._texInvalid = false;
  ctx._texSubst.length = 0;
  const p = ctx._program;
  const rec = p?._record;
  if (!p || !rec) return;
  const x = programExtras(p);
  if (x.samplers.length === 0) return;
  const floatLinear = ctx._extensions.has('OES_texture_float_linear');
  for (const [index, target] of x.samplers) {
    const u = rec.uniforms[index];
    const sk = samplerKind(u.type);
    if (sk === TK_FLOAT && !ctx._texRiskSeen) continue;
    for (let e = 0; e < u.size; e++) {
      const unit = x.samplerUnits.get(index * 4096 + e) ?? 0;
      const t = textureForTarget(ctx, unit, target);
      if (t === null) continue;
      const base = t._immutable ? Math.min(t._baseLevel, t._immutableLevels - 1) : t._baseLevel;
      const l = t._levels.get(base);
      if (l === undefined) continue; // never specified: incomplete, samples black
      const smp = ctx._samplers[unit];
      const tk = textureKind(l.internalformat);
      const compare = smp ? smp._compareMode : t._compareMode;
      const ok =
        sk === TK_FLOAT ? tk === TK_FLOAT || (tk === TK_DEPTH && compare === E.NONE)
        : sk === TK_DEPTH ? tk === TK_DEPTH && compare === E.COMPARE_REF_TO_TEXTURE
        : tk === sk;
      if (!ok) {
        ctx._texInvalid = true;
        return;
      }
      const minF = smp ? smp._minFilter : t._minFilter;
      const magF = smp ? smp._magFilter : t._magFilter;
      let black = false;
      const filtersLinearly = linear(minF) || magF === E.LINEAR;
      if (!floatLinear && isFloat32Format(l.internalformat) && filtersLinearly) black = true;
      // GLES 3.0 §3.8.13: a depth texture with compare mode NONE and a LINEAR filter is incomplete (some drivers
      // filter it anyway)
      if (ctx._v2 && tk === TK_DEPTH && compare === E.NONE && filtersLinearly) black = true;
      // WebGL 1 half-float textures (OES_texture_half_float) filter linearly only with OES_texture_half_float_linear
      if (!ctx._v2 && filtersLinearly && (l.internalformat === E.RGBA16F || l.internalformat === E.RGB16F) && !ctx._extensions.has('OES_texture_half_float_linear')) black = true;
      if (!ctx._v2 && ((l.width & (l.width - 1)) !== 0 || (l.height & (l.height - 1)) !== 0)) {
        const ws = smp ? smp._wrapS : t._wrapS;
        const wt = smp ? smp._wrapT : t._wrapT;
        if (usesMips(minF) || ws !== E.CLAMP_TO_EDGE || wt !== E.CLAMP_TO_EDGE) black = true;
      }
      if (black) ctx._texSubst.push(unit, target);
    }
  }
}

/** Bind (true) the black stand-ins for `_texSubst`, or restore (false) the app's textures. */
function bindStandIns(ctx: Ctx, on: boolean): void {
  const n = ctx._n;
  const list = ctx._texSubst;
  for (let i = 0; i < list.length; i += 2) {
    const unit = list[i];
    const target = list[i + 1];
    n.activeTexture(E.TEXTURE0 + unit);
    if (on) {
      let name = ctx._blackTex.get(target);
      if (name === undefined) {
        name = n.genTexture();
        ctx._liveAdd(6 /* texture */, name);
        ctx._blackTex.set(target, name);
      }
      n.bindTexture(target, name);
    } else {
      const t = textureForTarget(ctx, unit, target);
      n.bindTexture(target, t ? t._name : 0);
    }
  }
  n.activeTexture(E.TEXTURE0 + ctx._activeUnit);
}

/** Base type of a shader attribute type: 0 float, 1 int, 2 uint. */
function attribBase(type: number): number {
  switch (type) {
    case E.INT: case E.INT_VEC2: case E.INT_VEC3: case E.INT_VEC4:
      return 1;
    case E.UNSIGNED_INT: case E.UNSIGNED_INT_VEC2: case E.UNSIGNED_INT_VEC3: case E.UNSIGNED_INT_VEC4:
      return 2;
    default:
      return 0;
  }
}

/**
 * WebGL 2.0 §5.?: each active attribute's base type must match its source: the pointer (float pointer ->
 * float; vertexAttribIPointer with a signed / unsigned type -> int / uint) when enabled, else the type of the
 * last vertexAttrib* value.
 */
function attribTypesMatch(ctx: Ctx, rec: import('./reflection.ts').ProgramRecord): boolean {
  const vao = ctx._vao;
  const values = valueTypes(ctx);
  for (const a of rec.attribs) {
    if (a.location < 0 || a.location >= vao._enabled.length) continue;
    const want = attribBase(a.type);
    let have: number;
    if (vao._enabled[a.location]) {
      const o = a.location * 7;
      if (vao._pointer[o + 5] === 0) have = 0; // vertexAttribPointer: always float to the shader
      else {
        const t = vao._pointer[o + 1];
        have = t === E.BYTE || t === E.SHORT || t === E.INT ? 1 : 2;
      }
    } else {
      have = values[a.location];
    }
    if (have !== want) return false;
  }
  return true;
}

/** EXT_float_blend is implicitly enabled when offered by this context (CTS ext-float-blend). */
function floatBlendSupported(ctx: Ctx): boolean {
  return ctx._driverExt.has('GL_EXT_float_blend');
}

/** ANGLE_instanced_arrays (WebGL 1): at least one active attribute must have divisor 0. */
function hasZeroDivisor(ctx: Ctx): boolean {
  const rec = ctx._program?._record;
  if (!rec) return true;
  for (const a of rec.attribs) if (a.location >= 0 && ctx._vao._pointer[a.location * 7 + 6] === 0) return true;
  return rec.attribs.length === 0;
}

/** Stencil bits of the draw framebuffer (0 or 8: the formats WebGL can attach). */
function stencilBits(ctx: Ctx): number {
  const fb = ctx._drawFbo;
  if (fb === null) return ctx._attrs.stencil ? 8 : 0;
  return fb._attachments.has(E.STENCIL_ATTACHMENT) || fb._opaque ? 8 : 0;
}

function stencilConflict(ctx: Ctx): boolean {
  if (ctx._caps[8] !== 1) return false; // only with STENCIL_TEST enabled (CTS webgl-specific-stencil-settings)
  const bits = stencilBits(ctx);
  if (bits === 0) return false;
  const m = (1 << bits) - 1;
  const f = ctx._stencilFuncF;
  const b = ctx._stencilFuncB;
  const clampRef = (r: number): number => (r < 0 ? 0 : r > m ? m : r);
  return clampRef(f[1]) !== clampRef(b[1]) || (f[2] & m) !== (b[2] & m) || (ctx._stencilMaskF & m) !== (ctx._stencilMaskB & m);
}

/** WebGL 2.0 §5.?: every active uniform block needs a bound buffer range at least as large as the block. */
function uniformBlocksBacked(ctx: Ctx, rec: import('./reflection.ts').ProgramRecord): boolean {
  for (const block of rec.blocks) {
    const buf = ctx._uboBindings[block.binding];
    if (!buf) return false;
    const off = ctx._uboRanges[block.binding * 2];
    const size = ctx._uboRanges[block.binding * 2 + 1];
    const avail = size > 0 ? Math.min(size, buf._size - off) : buf._size;
    if (avail < block.dataSize) return false;
  }
  return true;
}

/** GLES 3.0 table 2.9: draw mode allowed for a transform feedback primitive mode. */
function tfModeOk(tfMode: number, mode: number): boolean {
  if (tfMode === E.POINTS) return mode === E.POINTS;
  if (tfMode === E.LINES) return mode === E.LINES || mode === E.LINE_LOOP || mode === E.LINE_STRIP;
  return mode === E.TRIANGLES || mode === E.TRIANGLE_STRIP || mode === E.TRIANGLE_FAN;
}

/** WebGL 2.0 §5.?: transform feedback buffers may not be read by the same draw nor bound twice. */
function tfConflict(ctx: Ctx): boolean {
  const tfb = ctx._tf._buffers;
  const vao = ctx._vao;
  for (let i = 0; i < tfb.length; i++) {
    const b = tfb[i];
    if (!b) continue;
    for (let j = i + 1; j < tfb.length; j++) if (tfb[j] === b) return true;
    if (vao._elementBuffer === b) return true;
    for (let k = 0; k < vao._buffers.length; k++) if (vao._enabled[k] && vao._buffers[k] === b) return true;
    for (let k = 0; k < ctx._uboBindings.length; k++) if (ctx._uboBindings[k] === b) return true;
  }
  return false;
}

/** Bytes one captured varying of `type` takes (GLES 3.0 table 2.10 types). */
function varyingBytes(type: number): number {
  switch (type) {
    case E.FLOAT: case E.INT: case E.UNSIGNED_INT: return 4;
    case E.FLOAT_VEC2: case E.INT_VEC2: case E.UNSIGNED_INT_VEC2: return 8;
    case E.FLOAT_VEC3: case E.INT_VEC3: case E.UNSIGNED_INT_VEC3: return 12;
    case E.FLOAT_VEC4: case E.INT_VEC4: case E.UNSIGNED_INT_VEC4: case E.FLOAT_MAT2: return 16;
    case E.FLOAT_MAT2x3: case E.FLOAT_MAT3x2: return 24;
    case E.FLOAT_MAT2x4: case E.FLOAT_MAT4x2: return 32;
    case E.FLOAT_MAT3: return 36;
    case E.FLOAT_MAT3x4: case E.FLOAT_MAT4x3: return 48;
    case E.FLOAT_MAT4: return 64;
    default: return 16;
  }
}

/** Vertices a draw of `count` vertices in `mode` writes to transform feedback (whole primitives only). */
function capturedVertices(mode: number, count: number): number {
  switch (mode) {
    case E.POINTS: return count;
    case E.LINES: return count - (count % 2);
    case E.LINE_STRIP: return count < 2 ? 0 : (count - 1) * 2;
    case E.LINE_LOOP: return count < 2 ? 0 : count * 2;
    case E.TRIANGLES: return count - (count % 3);
    default: return count < 3 ? 0 : (count - 2) * 3; // strips, fans
  }
}

/**
 * GLES 3.0 §2.15.2: a draw that would write past the end of any transform feedback binding is INVALID_OPERATION.
 * Counts the vertices captured since beginTransformFeedback (records them when the draw goes ahead).
 */
function tfReserve(ctx: Ctx, mode: number, count: number, instances: number): boolean {
  const tf = ctx._tf;
  if (!tf._active || tf._paused) return true;
  const rec = tf._program?._record;
  if (!rec) return true;
  const verts = capturedVertices(mode, count) * instances;
  const total = tf._written + verts;
  const separate = rec.tfBufferMode === E.SEPARATE_ATTRIBS;
  const slots = separate ? rec.varyings.length : 1;
  let stride = 0;
  if (!separate) for (const v of rec.varyings) stride += varyingBytes(v.type) * v.size;
  for (let i = 0; i < slots; i++) {
    const b = tf._buffers[i];
    if (!b) continue;
    const per = separate ? varyingBytes(rec.varyings[i].type) * rec.varyings[i].size : stride;
    const avail = tf._sizes[i] > 0 ? Math.min(tf._sizes[i], b._size - tf._offsets[i]) : b._size;
    if (total * per > avail) {
      ctx._e(E.INVALID_OPERATION, 'draw (transform feedback buffer overflow)');
      return false;
    }
  }
  tf._written = total;
  return true;
}

export const drawMethods = {
  drawArrays(this: Ctx, mode: number, first: number, count: number): void {
    if (this._skip()) return;
    mode >>>= 0;
    first |= 0;
    count |= 0;
    if (first < 0 || count < 0) return this._e(E.INVALID_VALUE, 'drawArrays');
    if (!this._drawCheck(mode, 'drawArrays') || !tfReserve(this, mode, count, 1)) return;
    if (count === 0) return;
    const sub = this._texSubst.length !== 0;
    if (sub) bindStandIns(this, true);
    this._n.drawArrays(mode, first, count);
    if (sub) bindStandIns(this, false);
  },
  drawElements(this: Ctx, mode: number, count: number, type: number, offset: number): void {
    if (this._skip()) return;
    mode >>>= 0;
    count |= 0;
    type >>>= 0;
    const off = toInt64(offset);
    if (!this._elementsCheck(count, type, off, 'drawElements')) return;
    if (!this._drawCheck(mode, 'drawElements') || !tfReserve(this, mode, count, 1)) return;
    if (count === 0) return;
    const sub = this._texSubst.length !== 0;
    if (sub) bindStandIns(this, true);
    this._n.drawElements(mode, count, type, off);
    if (sub) bindStandIns(this, false);
  },
  drawArraysInstanced(this: Ctx, mode: number, first: number, count: number, instanceCount: number): void {
    if (this._skip()) return;
    mode >>>= 0;
    first |= 0;
    count |= 0;
    instanceCount |= 0;
    if (first < 0 || count < 0 || instanceCount < 0) return this._e(E.INVALID_VALUE, 'drawArraysInstanced');
    if (!this._drawCheck(mode, 'drawArraysInstanced')) return;
    if (!this._v2 && !hasZeroDivisor(this)) return this._e(E.INVALID_OPERATION, 'drawArraysInstanced');
    if (!tfReserve(this, mode, count, instanceCount)) return;
    if (count === 0 || instanceCount === 0) return;
    const sub = this._texSubst.length !== 0;
    if (sub) bindStandIns(this, true);
    this._n.drawArraysInstanced(mode, first, count, instanceCount);
    if (sub) bindStandIns(this, false);
  },
  drawElementsInstanced(this: Ctx, mode: number, count: number, type: number, offset: number, instanceCount: number): void {
    if (this._skip()) return;
    mode >>>= 0;
    count |= 0;
    type >>>= 0;
    instanceCount |= 0;
    const off = toInt64(offset);
    if (instanceCount < 0) return this._e(E.INVALID_VALUE, 'drawElementsInstanced');
    if (!this._elementsCheck(count, type, off, 'drawElementsInstanced')) return;
    if (!this._drawCheck(mode, 'drawElementsInstanced')) return;
    if (!this._v2 && !hasZeroDivisor(this)) return this._e(E.INVALID_OPERATION, 'drawElementsInstanced');
    if (!tfReserve(this, mode, count, instanceCount)) return;
    if (count === 0 || instanceCount === 0) return;
    const sub = this._texSubst.length !== 0;
    if (sub) bindStandIns(this, true);
    this._n.drawElementsInstanced(mode, count, type, off, instanceCount);
    if (sub) bindStandIns(this, false);
  },
  drawRangeElements(this: Ctx, mode: number, start: number, end: number, count: number, type: number, offset: number): void {
    if (this._skip()) return;
    mode >>>= 0;
    start >>>= 0;
    end >>>= 0;
    count |= 0;
    type >>>= 0;
    const off = toInt64(offset);
    if (end < start) return this._e(E.INVALID_VALUE, 'drawRangeElements');
    if (!this._elementsCheck(count, type, off, 'drawRangeElements')) return;
    if (!this._drawCheck(mode, 'drawRangeElements') || !tfReserve(this, mode, count, 1)) return;
    if (count === 0) return;
    const sub = this._texSubst.length !== 0;
    if (sub) bindStandIns(this, true);
    this._n.drawRangeElements(mode, start, end, count, type, off);
    if (sub) bindStandIns(this, false);
  },
};

/** WEBGL_multi_draw (GL-25): list checks per the extension spec and Chromium, then one native call. */
function listCheck(ctx: Ctx, list: unknown, offset: number, drawcount: number, what: string): Int32Array | null {
  const arr = i32List(ctx, list, what);
  const len = arr === list ? arr.length : (list as ArrayLike<unknown>).length;
  if (offset >= len && drawcount > 0) {
    ctx._e(E.INVALID_OPERATION, what);
    return null;
  }
  if (offset + drawcount > len) {
    ctx._e(E.INVALID_OPERATION, what);
    return null;
  }
  // Each list must be its own array when converted (scratch reuse): copy converted ones.
  return arr === list ? arr : arr.slice(0, len);
}

export const multiDrawMethods = {
  multiDrawArraysWEBGL(this: { _gl: Ctx }, mode: number, firsts: unknown, firstsOffset: number, counts: unknown, countsOffset: number, drawcount: number): void {
    multiDraw(this._gl, false, mode >>> 0, firsts, firstsOffset >>> 0, counts, countsOffset >>> 0, 0, null, 0, null, 0, drawcount | 0, 'multiDrawArraysWEBGL');
  },
  multiDrawElementsWEBGL(this: { _gl: Ctx }, mode: number, counts: unknown, countsOffset: number, type: number, offsets: unknown, offsetsOffset: number, drawcount: number): void {
    multiDraw(this._gl, true, mode >>> 0, null, 0, counts, countsOffset >>> 0, type >>> 0, offsets, offsetsOffset >>> 0, null, 0, drawcount | 0, 'multiDrawElementsWEBGL');
  },
  multiDrawArraysInstancedWEBGL(this: { _gl: Ctx }, mode: number, firsts: unknown, firstsOffset: number, counts: unknown, countsOffset: number, instanceCounts: unknown, instanceCountsOffset: number, drawcount: number): void {
    multiDraw(this._gl, false, mode >>> 0, firsts, firstsOffset >>> 0, counts, countsOffset >>> 0, 0, null, 0, instanceCounts, instanceCountsOffset >>> 0, drawcount | 0, 'multiDrawArraysInstancedWEBGL');
  },
  multiDrawElementsInstancedWEBGL(this: { _gl: Ctx }, mode: number, counts: unknown, countsOffset: number, type: number, offsets: unknown, offsetsOffset: number, instanceCounts: unknown, instanceCountsOffset: number, drawcount: number): void {
    multiDraw(this._gl, true, mode >>> 0, null, 0, counts, countsOffset >>> 0, type >>> 0, offsets, offsetsOffset >>> 0, instanceCounts, instanceCountsOffset >>> 0, drawcount | 0, 'multiDrawElementsInstancedWEBGL');
  },
};

function multiDraw(
  ctx: Ctx,
  elements: boolean,
  mode: number,
  firsts: unknown,
  firstsOff: number,
  counts: unknown,
  countsOff: number,
  type: number,
  offsets: unknown,
  offsetsOff: number,
  insts: unknown,
  instsOff: number,
  drawcount: number,
  what: string,
): void {
  if (ctx._skip()) return;
  if (drawcount < 0) return ctx._e(E.INVALID_VALUE, what);
  const c = listCheck(ctx, counts, countsOff, drawcount, what);
  if (!c) return;
  const f = elements ? null : listCheck(ctx, firsts, firstsOff, drawcount, what);
  if (!elements && !f) return;
  const o = elements ? listCheck(ctx, offsets, offsetsOff, drawcount, what) : null;
  if (elements && !o) return;
  const i = insts === null ? null : listCheck(ctx, insts, instsOff, drawcount, what);
  if (insts !== null && !i) return;
  if (elements) {
    for (let k = 0; k < drawcount; k++) {
      if (!ctx._elementsCheck(c[countsOff + k], type, o![offsetsOff + k], what)) return;
    }
  } else {
    for (let k = 0; k < drawcount; k++) {
      if (f![firstsOff + k] < 0 || c[countsOff + k] < 0) return ctx._e(E.INVALID_VALUE, what);
    }
  }
  if (i) for (let k = 0; k < drawcount; k++) if (i[instsOff + k] < 0) return ctx._e(E.INVALID_VALUE, what);
  if (!ctx._drawCheck(mode, what)) return;
  if (drawcount === 0) return;
  const p = ctx._program!;
  const drawId = p._usesDrawId && p._record ? p._record.drawIdLocation : -1;
  const n = ctx._n;
  const bytes = drawcount * 4;
  const sub = ctx._texSubst.length !== 0;
  if (sub) bindStandIns(ctx, true);
  if (elements) {
    n.multiDrawElements(mode, c, countsOff * 4, bytes, type, o!, offsetsOff * 4, bytes, i, i ? instsOff * 4 : 0, i ? bytes : 0, drawcount, drawId);
  } else {
    n.multiDrawArrays(mode, f!, firstsOff * 4, bytes, c, countsOff * 4, bytes, i, i ? instsOff * 4 : 0, i ? bytes : 0, drawcount, drawId);
  }
  if (sub) bindStandIns(ctx, false);
  // the multi-draw set webgl_DrawID behind the uniform cache: it is internal, no app-visible cache entry
}
