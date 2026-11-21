/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Fixed-function state with the JS-side state cache (spec GL-PERF-2): a call that would not change GL state
// does not reach the driver. Arguments are validated in JS where an invalid value would otherwise poison the
// cache (enum sets, ranges), so cached values always equal the driver's.

import type { Ctx } from './core.ts';
import { CAP_INDEX } from './core.ts';
import * as E from './gen/enums.gen.ts';

export const PS_PACK_ALIGNMENT = 0;
export const PS_UNPACK_ALIGNMENT = 1;
export const PS_UNPACK_ROW_LENGTH = 2;
export const PS_UNPACK_IMAGE_HEIGHT = 3;
export const PS_UNPACK_SKIP_PIXELS = 4;
export const PS_UNPACK_SKIP_ROWS = 5;
export const PS_UNPACK_SKIP_IMAGES = 6;
export const PS_PACK_ROW_LENGTH = 7;
export const PS_PACK_SKIP_PIXELS = 8;
export const PS_PACK_SKIP_ROWS = 9;

const PS_INDEX: Record<number, number> = {
  [E.PACK_ALIGNMENT]: PS_PACK_ALIGNMENT,
  [E.UNPACK_ALIGNMENT]: PS_UNPACK_ALIGNMENT,
  [E.UNPACK_ROW_LENGTH]: PS_UNPACK_ROW_LENGTH,
  [E.UNPACK_IMAGE_HEIGHT]: PS_UNPACK_IMAGE_HEIGHT,
  [E.UNPACK_SKIP_PIXELS]: PS_UNPACK_SKIP_PIXELS,
  [E.UNPACK_SKIP_ROWS]: PS_UNPACK_SKIP_ROWS,
  [E.UNPACK_SKIP_IMAGES]: PS_UNPACK_SKIP_IMAGES,
  [E.PACK_ROW_LENGTH]: PS_PACK_ROW_LENGTH,
  [E.PACK_SKIP_PIXELS]: PS_PACK_SKIP_PIXELS,
  [E.PACK_SKIP_ROWS]: PS_PACK_SKIP_ROWS,
};
const PS_WEBGL1 = new Set([E.PACK_ALIGNMENT, E.UNPACK_ALIGNMENT]);

const BLEND_EQ = new Set([
  E.FUNC_ADD,
  E.FUNC_SUBTRACT,
  E.FUNC_REVERSE_SUBTRACT,
  E.MIN,
  E.MAX,
]);
const BLEND_FACTOR = new Set([
  E.ZERO,
  E.ONE,
  E.SRC_COLOR,
  E.ONE_MINUS_SRC_COLOR,
  E.DST_COLOR,
  E.ONE_MINUS_DST_COLOR,
  E.SRC_ALPHA,
  E.ONE_MINUS_SRC_ALPHA,
  E.DST_ALPHA,
  E.ONE_MINUS_DST_ALPHA,
  E.CONSTANT_COLOR,
  E.ONE_MINUS_CONSTANT_COLOR,
  E.CONSTANT_ALPHA,
  E.ONE_MINUS_CONSTANT_ALPHA,
  E.SRC_ALPHA_SATURATE,
]);
const COMPARE = new Set([
  E.NEVER,
  E.LESS,
  E.EQUAL,
  E.LEQUAL,
  E.GREATER,
  E.NOTEQUAL,
  E.GEQUAL,
  E.ALWAYS,
]);
const STENCIL_OP = new Set([
  E.KEEP,
  E.ZERO,
  E.REPLACE,
  E.INCR,
  E.INCR_WRAP,
  E.DECR,
  E.DECR_WRAP,
  E.INVERT,
]);
const FACE = new Set([E.FRONT, E.BACK, E.FRONT_AND_BACK]);

/** WebGL 1.0 §6.11: front and back stencil ref / value mask / writemask may differ only in bits the stencil
 * buffer does not have; the draw-time check runs only while they differ at all. */
function stencilConsistency(ctx: Ctx): void {
  const f = ctx._stencilFuncF;
  const b = ctx._stencilFuncB;
  ctx._stencilMismatch =
    f[1] !== b[1] || f[2] !== b[2] || ctx._stencilMaskF !== ctx._stencilMaskB;
}

/** MIN/MAX are core in WebGL 2, EXT_blend_minmax in WebGL 1. */
function blendEqOk(ctx: Ctx, mode: number): boolean {
  if (!BLEND_EQ.has(mode)) return false;
  return (
    ctx._v2 ||
    (mode !== E.MIN && mode !== E.MAX) ||
    ctx._extensions.has('EXT_blend_minmax')
  );
}

function clamp4(f: Float32Array): void {
  for (let i = 0; i < 4; i++)
    f[i] = f[i] < 0 ? 0 : f[i] > 1 ? 1 : f[i] !== f[i] ? 0 : f[i];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** WebGL 1.0 §6.13: constant color and constant alpha cannot be used together as source and destination. */
function constantConflict(s: number, d: number): boolean {
  const cc = (f: number): boolean =>
    f === E.CONSTANT_COLOR || f === E.ONE_MINUS_CONSTANT_COLOR;
  const ca = (f: number): boolean =>
    f === E.CONSTANT_ALPHA || f === E.ONE_MINUS_CONSTANT_ALPHA;
  return (cc(s) && ca(d)) || (ca(s) && cc(d));
}

export const stateMethods = {
  enable(this: Ctx, cap: number): void {
    if (this._skip()) return;
    cap >>>= 0;
    const i = CAP_INDEX[cap];
    if (i === undefined || (i === 9 && !this._v2))
      return this._capExt(cap, true);
    if (i === 0 && this._idxDiverged & 1) this._idxDiverged &= ~1;
    else if (this._caps[i] === 1) return;
    this._caps[i] = 1;
    this._n.enable(cap);
  },
  disable(this: Ctx, cap: number): void {
    if (this._skip()) return;
    cap >>>= 0;
    const i = CAP_INDEX[cap];
    if (i === undefined || (i === 9 && !this._v2))
      return this._capExt(cap, false);
    if (i === 0 && this._idxDiverged & 1) this._idxDiverged &= ~1;
    else if (this._caps[i] === 0) return;
    this._caps[i] = 0;
    this._n.disable(cap);
  },
  isEnabled(this: Ctx, cap: number): boolean {
    if (this._skip()) return false;
    cap >>>= 0;
    const i = CAP_INDEX[cap];
    if (i === undefined || (i === 9 && !this._v2)) {
      if (this._capAllowed(cap)) return this._n.isEnabled(cap);
      this._e(E.INVALID_ENUM, 'isEnabled');
      return false;
    }
    return this._caps[i] === 1;
  },
  activeTexture(this: Ctx, texture: number): void {
    if (this._skip()) return;
    const unit = (texture >>> 0) - E.TEXTURE0;
    if (unit < 0 || unit >= this._maxUnits)
      return this._e(E.INVALID_ENUM, 'activeTexture');
    if (unit === this._activeUnit) return;
    this._activeUnit = unit;
    this._n.activeTexture(texture >>> 0);
  },
  blendColor(this: Ctx, r: number, g: number, b: number, a: number): void {
    if (this._skip()) return;
    const c = this._blendColor;
    const f = this._f32;
    f[0] = +r;
    f[1] = +g;
    f[2] = +b;
    f[3] = +a;
    if (!this._v2 || this._blendColorClamps === 1) clamp4(f); // WebGL 1 (ES 2.0) clamps the constant colour
    if (c[0] === f[0] && c[1] === f[1] && c[2] === f[2] && c[3] === f[3])
      return;
    c[0] = f[0];
    c[1] = f[1];
    c[2] = f[2];
    c[3] = f[3];
    this._n.blendColor(c[0], c[1], c[2], c[3]);
    if (
      this._blendColorClamps === -1 &&
      (c[0] < 0 ||
        c[0] > 1 ||
        c[1] < 0 ||
        c[1] > 1 ||
        c[2] < 0 ||
        c[2] > 1 ||
        c[3] < 0 ||
        c[3] > 1)
    ) {
      // WebGL 2 stores the colour unclamped unless the platform clamps it (CTS blending.html): ask the driver once,
      // the first time a value out of [0, 1] is set, so getParameter(BLEND_COLOR) answers what the driver uses.
      this._n.getFloatv(E.BLEND_COLOR, f, 0, 16);
      this._blendColorClamps =
        f[0] !== c[0] || f[1] !== c[1] || f[2] !== c[2] || f[3] !== c[3]
          ? 1
          : 0;
      if (this._blendColorClamps === 1) clamp4(c);
    }
  },
  blendEquation(this: Ctx, mode: number): void {
    if (this._skip()) return;
    mode >>>= 0;
    if (!blendEqOk(this, mode)) return this._e(E.INVALID_ENUM, 'blendEquation');
    const q = this._blendEq;
    if (this._idxDiverged & 2) this._idxDiverged &= ~2;
    else if (q[0] === mode && q[1] === mode) return;
    q[0] = mode;
    q[1] = mode;
    this._n.blendEquation(mode);
  },
  blendEquationSeparate(this: Ctx, modeRGB: number, modeAlpha: number): void {
    if (this._skip()) return;
    modeRGB >>>= 0;
    modeAlpha >>>= 0;
    if (!blendEqOk(this, modeRGB) || !blendEqOk(this, modeAlpha))
      return this._e(E.INVALID_ENUM, 'blendEquationSeparate');
    const q = this._blendEq;
    if (this._idxDiverged & 2) this._idxDiverged &= ~2;
    else if (q[0] === modeRGB && q[1] === modeAlpha) return;
    q[0] = modeRGB;
    q[1] = modeAlpha;
    this._n.blendEquationSeparate(modeRGB, modeAlpha);
  },
  blendFunc(this: Ctx, s: number, d: number): void {
    if (this._skip()) return;
    s >>>= 0;
    d >>>= 0;
    if (!BLEND_FACTOR.has(s) || !BLEND_FACTOR.has(d))
      return this._e(E.INVALID_ENUM, 'blendFunc');
    if (d === E.SRC_ALPHA_SATURATE && !this._v2)
      return this._e(E.INVALID_ENUM, 'blendFunc');
    if (constantConflict(s, d))
      return this._e(E.INVALID_OPERATION, 'blendFunc');
    const f = this._blendFunc;
    if (this._idxDiverged & 4) this._idxDiverged &= ~4;
    else if (f[0] === s && f[1] === d && f[2] === s && f[3] === d) return;
    f[0] = s;
    f[1] = d;
    f[2] = s;
    f[3] = d;
    this._n.blendFunc(s, d);
  },
  blendFuncSeparate(
    this: Ctx,
    sRGB: number,
    dRGB: number,
    sA: number,
    dA: number,
  ): void {
    if (this._skip()) return;
    sRGB >>>= 0;
    dRGB >>>= 0;
    sA >>>= 0;
    dA >>>= 0;
    if (
      !BLEND_FACTOR.has(sRGB) ||
      !BLEND_FACTOR.has(dRGB) ||
      !BLEND_FACTOR.has(sA) ||
      !BLEND_FACTOR.has(dA)
    ) {
      return this._e(E.INVALID_ENUM, 'blendFuncSeparate');
    }
    if (
      !this._v2 &&
      (dRGB === E.SRC_ALPHA_SATURATE || dA === E.SRC_ALPHA_SATURATE)
    ) {
      return this._e(E.INVALID_ENUM, 'blendFuncSeparate');
    }
    if (constantConflict(sRGB, dRGB))
      return this._e(E.INVALID_OPERATION, 'blendFuncSeparate');
    const f = this._blendFunc;
    if (this._idxDiverged & 4) this._idxDiverged &= ~4;
    else if (f[0] === sRGB && f[1] === dRGB && f[2] === sA && f[3] === dA)
      return;
    f[0] = sRGB;
    f[1] = dRGB;
    f[2] = sA;
    f[3] = dA;
    this._n.blendFuncSeparate(sRGB, dRGB, sA, dA);
  },
  clearColor(this: Ctx, r: number, g: number, b: number, a: number): void {
    if (this._skip()) return;
    const c = this._clearColor;
    const f = this._f32;
    f[0] = +r;
    f[1] = +g;
    f[2] = +b;
    f[3] = +a;
    if (!this._v2) clamp4(f); // WebGL 1 (ES 2.0) clamps the clear colour
    if (
      Object.is(c[0], f[0]) &&
      Object.is(c[1], f[1]) &&
      Object.is(c[2], f[2]) &&
      Object.is(c[3], f[3])
    )
      return;
    c[0] = f[0];
    c[1] = f[1];
    c[2] = f[2];
    c[3] = f[3];
    this._n.clearColor(c[0], c[1], c[2], c[3]);
  },
  clearDepth(this: Ctx, depth: number): void {
    if (this._skip()) return;
    const d = clamp01(Math.fround(+depth));
    if (d === this._clearDepth) return;
    this._clearDepth = d;
    this._n.clearDepthf(d);
  },
  clearStencil(this: Ctx, s: number): void {
    if (this._skip()) return;
    s |= 0;
    if (s === this._clearStencil) return;
    this._clearStencil = s;
    this._n.clearStencil(s);
  },
  colorMask(this: Ctx, r: boolean, g: boolean, b: boolean, a: boolean): void {
    if (this._skip()) return;
    const m = this._colorMask;
    const R = r ? 1 : 0;
    const G = g ? 1 : 0;
    const B = b ? 1 : 0;
    const A = a ? 1 : 0;
    if (this._idxDiverged & 8) this._idxDiverged &= ~8;
    else if (m[0] === R && m[1] === G && m[2] === B && m[3] === A) return;
    this._bufMaskOn = R | G | B | A ? 0xffff : 0;
    this._bufMaskPartial = (R + G + B + A) % 4 !== 0 ? 0xffff : 0;
    m[0] = R;
    m[1] = G;
    m[2] = B;
    m[3] = A;
    this._n.colorMask(!!R, !!G, !!B, !!A);
  },
  cullFace(this: Ctx, mode: number): void {
    if (this._skip()) return;
    mode >>>= 0;
    if (!FACE.has(mode)) return this._e(E.INVALID_ENUM, 'cullFace');
    if (mode === this._cullFace) return;
    this._cullFace = mode;
    this._n.cullFace(mode);
  },
  depthFunc(this: Ctx, func: number): void {
    if (this._skip()) return;
    func >>>= 0;
    if (!COMPARE.has(func)) return this._e(E.INVALID_ENUM, 'depthFunc');
    if (func === this._depthFunc) return;
    this._depthFunc = func;
    this._n.depthFunc(func);
  },
  depthMask(this: Ctx, flag: boolean): void {
    if (this._skip()) return;
    const f = !!flag;
    if (f === this._depthMask) return;
    this._depthMask = f;
    this._n.depthMask(f);
  },
  depthRange(this: Ctx, zNear: number, zFar: number): void {
    if (this._skip()) return;
    if (+zNear > +zFar) return this._e(E.INVALID_OPERATION, 'depthRange'); // WebGL 1.0 §6.12, before clamping
    const n = clamp01(Math.fround(+zNear));
    const f = clamp01(Math.fround(+zFar));
    const r = this._depthRange;
    if (r[0] === n && r[1] === f) return;
    r[0] = n;
    r[1] = f;
    this._n.depthRangef(n, f);
  },
  frontFace(this: Ctx, mode: number): void {
    if (this._skip()) return;
    mode >>>= 0;
    if (mode !== E.CW && mode !== E.CCW)
      return this._e(E.INVALID_ENUM, 'frontFace');
    if (mode === this._frontFace) return;
    this._frontFace = mode;
    this._n.frontFace(mode);
  },
  hint(this: Ctx, target: number, mode: number): void {
    if (this._skip()) return;
    target >>>= 0;
    mode >>>= 0;
    const okTarget =
      target === E.GENERATE_MIPMAP_HINT ||
      (this._v2 && target === E.FRAGMENT_SHADER_DERIVATIVE_HINT) ||
      (!this._v2 &&
        target === E.FRAGMENT_SHADER_DERIVATIVE_HINT_OES &&
        this._extensions.has('OES_standard_derivatives'));
    if (
      !okTarget ||
      (mode !== E.FASTEST && mode !== E.NICEST && mode !== E.DONT_CARE)
    ) {
      return this._e(E.INVALID_ENUM, 'hint');
    }
    if (this._hints.get(target) === mode) return;
    this._hints.set(target, mode);
    this._n.hint(target, mode);
  },
  lineWidth(this: Ctx, width: number): void {
    if (this._skip()) return;
    const w = Math.fround(+width);
    if (!(w > 0)) return this._e(E.INVALID_VALUE, 'lineWidth');
    if (w === this._lineWidth) return;
    this._lineWidth = w;
    this._n.lineWidth(w);
  },
  pixelStorei(this: Ctx, pname: number, param: number): void {
    if (this._skip()) return;
    pname >>>= 0;
    param |= 0;
    switch (pname) {
      case E.UNPACK_FLIP_Y_WEBGL:
        this._flipY = param !== 0;
        return;
      case E.UNPACK_PREMULTIPLY_ALPHA_WEBGL:
        this._premultiply = param !== 0;
        return;
      case E.UNPACK_COLORSPACE_CONVERSION_WEBGL:
        if (param !== E.BROWSER_DEFAULT_WEBGL && param !== E.NONE)
          return this._e(E.INVALID_ENUM, 'pixelStorei');
        this._colorspaceConversion = param;
        return;
    }
    const i = PS_INDEX[pname];
    if (i === undefined || (!this._v2 && !PS_WEBGL1.has(pname)))
      return this._e(E.INVALID_ENUM, 'pixelStorei');
    if (pname === E.PACK_ALIGNMENT || pname === E.UNPACK_ALIGNMENT) {
      if (param !== 1 && param !== 2 && param !== 4 && param !== 8)
        return this._e(E.INVALID_VALUE, 'pixelStorei');
    } else if (param < 0) {
      return this._e(E.INVALID_VALUE, 'pixelStorei');
    }
    if (this._ps[i] === param) return;
    this._ps[i] = param;
    this._n.pixelStorei(pname, param);
  },
  polygonOffset(this: Ctx, factor: number, units: number): void {
    if (this._skip()) return;
    const p = this._polygonOffset;
    const f = Math.fround(+factor);
    const u = Math.fround(+units);
    // glPolygonOffset is polygonOffsetClampEXT with clamp 0 (EXT_polygon_offset_clamp)
    if (p[0] === f && p[1] === u && this._polygonOffsetClamp === 0) return;
    p[0] = f;
    p[1] = u;
    this._polygonOffsetClamp = 0;
    this._n.polygonOffset(f, u);
  },
  sampleCoverage(this: Ctx, value: number, invert: boolean): void {
    if (this._skip()) return;
    const v = clamp01(Math.fround(+value));
    const inv = !!invert;
    if (v === this._sampleCoverageValue && inv === this._sampleCoverageInvert)
      return;
    this._sampleCoverageValue = v;
    this._sampleCoverageInvert = inv;
    this._n.sampleCoverage(v, inv);
  },
  scissor(
    this: Ctx,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    if (this._skip()) return;
    x |= 0;
    y |= 0;
    width |= 0;
    height |= 0;
    if (width < 0 || height < 0) return this._e(E.INVALID_VALUE, 'scissor');
    const s = this._scissor;
    if (s[0] === x && s[1] === y && s[2] === width && s[3] === height) return;
    s[0] = x;
    s[1] = y;
    s[2] = width;
    s[3] = height;
    this._n.scissor(x, y, width, height);
  },
  viewport(
    this: Ctx,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    if (this._skip()) return;
    x |= 0;
    y |= 0;
    width |= 0;
    height |= 0;
    if (width < 0 || height < 0) return this._e(E.INVALID_VALUE, 'viewport');
    const v = this._viewport;
    if (v[0] === x && v[1] === y && v[2] === width && v[3] === height) return;
    v[0] = x;
    v[1] = y;
    v[2] = width;
    v[3] = height;
    this._n.viewport(x, y, width, height);
  },
  stencilFunc(this: Ctx, func: number, ref: number, mask: number): void {
    if (this._skip()) return;
    func >>>= 0;
    ref |= 0;
    mask |= 0;
    if (!COMPARE.has(func)) return this._e(E.INVALID_ENUM, 'stencilFunc');
    const f = this._stencilFuncF;
    const b = this._stencilFuncB;
    if (
      f[0] === func &&
      f[1] === ref &&
      f[2] === mask &&
      b[0] === func &&
      b[1] === ref &&
      b[2] === mask
    )
      return;
    f[0] = b[0] = func;
    f[1] = b[1] = ref;
    f[2] = b[2] = mask;
    stencilConsistency(this);
    this._n.stencilFunc(func, ref, mask >>> 0);
  },
  stencilFuncSeparate(
    this: Ctx,
    face: number,
    func: number,
    ref: number,
    mask: number,
  ): void {
    if (this._skip()) return;
    face >>>= 0;
    func >>>= 0;
    ref |= 0;
    mask |= 0;
    if (!FACE.has(face) || !COMPARE.has(func))
      return this._e(E.INVALID_ENUM, 'stencilFuncSeparate');
    const front = face !== E.BACK;
    const back = face !== E.FRONT;
    const f = this._stencilFuncF;
    const b = this._stencilFuncB;
    const same = (a: Int32Array): boolean =>
      a[0] === func && a[1] === ref && a[2] === mask;
    if ((!front || same(f)) && (!back || same(b))) return;
    if (front) {
      f[0] = func;
      f[1] = ref;
      f[2] = mask;
    }
    if (back) {
      b[0] = func;
      b[1] = ref;
      b[2] = mask;
    }
    stencilConsistency(this);
    this._n.stencilFuncSeparate(face, func, ref, mask >>> 0);
  },
  stencilMask(this: Ctx, mask: number): void {
    if (this._skip()) return;
    mask |= 0;
    if (this._stencilMaskF === mask && this._stencilMaskB === mask) return;
    this._stencilMaskF = this._stencilMaskB = mask;
    stencilConsistency(this);
    this._n.stencilMask(mask >>> 0);
  },
  stencilMaskSeparate(this: Ctx, face: number, mask: number): void {
    if (this._skip()) return;
    face >>>= 0;
    mask |= 0;
    if (!FACE.has(face)) return this._e(E.INVALID_ENUM, 'stencilMaskSeparate');
    const front = face !== E.BACK;
    const back = face !== E.FRONT;
    if (
      (!front || this._stencilMaskF === mask) &&
      (!back || this._stencilMaskB === mask)
    )
      return;
    if (front) this._stencilMaskF = mask;
    if (back) this._stencilMaskB = mask;
    stencilConsistency(this);
    this._n.stencilMaskSeparate(face, mask >>> 0);
  },
  stencilOp(this: Ctx, fail: number, zfail: number, zpass: number): void {
    if (this._skip()) return;
    fail >>>= 0;
    zfail >>>= 0;
    zpass >>>= 0;
    if (
      !STENCIL_OP.has(fail) ||
      !STENCIL_OP.has(zfail) ||
      !STENCIL_OP.has(zpass)
    ) {
      return this._e(E.INVALID_ENUM, 'stencilOp');
    }
    const f = this._stencilOpF;
    const b = this._stencilOpB;
    if (
      f[0] === fail &&
      f[1] === zfail &&
      f[2] === zpass &&
      b[0] === fail &&
      b[1] === zfail &&
      b[2] === zpass
    )
      return;
    f[0] = b[0] = fail;
    f[1] = b[1] = zfail;
    f[2] = b[2] = zpass;
    this._n.stencilOp(fail, zfail, zpass);
  },
  stencilOpSeparate(
    this: Ctx,
    face: number,
    fail: number,
    zfail: number,
    zpass: number,
  ): void {
    if (this._skip()) return;
    face >>>= 0;
    fail >>>= 0;
    zfail >>>= 0;
    zpass >>>= 0;
    if (
      !FACE.has(face) ||
      !STENCIL_OP.has(fail) ||
      !STENCIL_OP.has(zfail) ||
      !STENCIL_OP.has(zpass)
    ) {
      return this._e(E.INVALID_ENUM, 'stencilOpSeparate');
    }
    const front = face !== E.BACK;
    const back = face !== E.FRONT;
    const same = (a: Uint32Array): boolean =>
      a[0] === fail && a[1] === zfail && a[2] === zpass;
    if ((!front || same(this._stencilOpF)) && (!back || same(this._stencilOpB)))
      return;
    if (front) {
      this._stencilOpF[0] = fail;
      this._stencilOpF[1] = zfail;
      this._stencilOpF[2] = zpass;
    }
    if (back) {
      this._stencilOpB[0] = fail;
      this._stencilOpB[1] = zfail;
      this._stencilOpB[2] = zpass;
    }
    this._n.stencilOpSeparate(face, fail, zfail, zpass);
  },
};

/** Internal helpers mixed into Ctx (extension capabilities pass through uncached). */
export const stateInternals = {
  _capAllowed(this: Ctx, cap: number): boolean {
    if (cap >= E.CLIP_DISTANCE0_WEBGL && cap <= E.CLIP_DISTANCE7_WEBGL)
      return this._extensions.has('WEBGL_clip_cull_distance');
    if (cap === E.POLYGON_OFFSET_LINE_WEBGL)
      return this._extensions.has('WEBGL_polygon_mode');
    return false;
  },
  _capExt(this: Ctx, cap: number, on: boolean): void {
    if (!this._capAllowed(cap))
      return this._e(E.INVALID_ENUM, on ? 'enable' : 'disable');
    if (on) this._n.enable(cap);
    else this._n.disable(cap);
  },
};
