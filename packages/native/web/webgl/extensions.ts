/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Extensions (spec GL-23): getSupportedExtensions lists, and getExtension returns one object per context for,
// each extension whose driver capability exists (availability expressions in the generated IDL table).
// Extension objects carry their IDL constants; methods delegate to the context. Enabling an extension
// unlocks its enums (compressed formats, caps, pnames).

import type { Ctx } from './core.ts';
import * as E from './gen/enums.gen.ts';
import {
  EXTENSIONS_WEBGL1,
  EXTENSIONS_WEBGL2,
  IDL,
  type Availability,
} from './gen/idl.gen.ts';
import { directExtensionMethods } from './gen/methods.gen.ts';
import { COMPRESSED_FORMATS } from './formats.ts';
import { multiDrawMethods } from './draws.ts';
import { queryCounter } from './queries.ts';
import { createVaoOES } from './attribs.ts';
import {
  WebGLQuery,
  WebGLShader,
  WebGLTexture,
  WebGLTimerQueryEXT,
  INTERNAL,
  WebGLVertexArrayObjectOES,
} from './objects.ts';
import type { WebGLVertexArrayObject } from './objects.ts';

type ExtThis = { _gl: Ctx };

/** Hand-written extension methods, by IDL interface. */
const EXT_METHODS: Record<string, Record<string, Function>> = {
  WebGLLoseContext: {
    loseContext(this: ExtThis): void {
      const gl = this._gl;
      if (gl._lost) return gl._e(E.INVALID_OPERATION, 'loseContext');
      gl._loseContext(true);
    },
    restoreContext(this: ExtThis): void {
      const gl = this._gl;
      if (!gl._lost) return gl._e(E.INVALID_OPERATION, 'restoreContext');
      gl._restoreContext();
    },
  },
  WebGLDebugShaders: {
    getTranslatedShaderSource(this: ExtThis, shader: WebGLShader): string {
      const gl = this._gl;
      if (gl._skip()) return '';
      if (!gl._ok(shader, WebGLShader, false, 'getTranslatedShaderSource'))
        return '';
      return shader._translated;
    },
  },
  WebGLMultiDraw: multiDrawMethods,
  KHRParallelShaderCompile: {
    maxShaderCompilerThreadsKHR(this: ExtThis, count: number): void {
      const gl = this._gl;
      if (gl._skip()) return;
      gl._n.maxShaderCompilerThreadsKHR(count >>> 0);
    },
  },
  EXTDisjointTimerQueryWebGL2: {
    queryCounterEXT(this: ExtThis, q: WebGLQuery, target: number): void {
      queryCounter(this._gl, q, target);
    },
  },
  OVRMultiview2: {
    framebufferTextureMultiviewOVR(
      this: ExtThis,
      target: number,
      attachment: number,
      texture: WebGLTexture | null,
      level: number,
      baseViewIndex: number,
      numViews: number,
    ): void {
      this._gl._framebufferTextureMultiview(
        target,
        attachment,
        texture,
        level,
        0,
        baseViewIndex,
        numViews,
        'framebufferTextureMultiviewOVR',
      );
    },
  },
  OCULUSMultiview: {
    framebufferTextureMultiviewOVR(
      this: ExtThis,
      target: number,
      attachment: number,
      texture: WebGLTexture | null,
      level: number,
      baseViewIndex: number,
      numViews: number,
    ): void {
      this._gl._framebufferTextureMultiview(
        target,
        attachment,
        texture,
        level,
        0,
        baseViewIndex,
        numViews,
        'framebufferTextureMultiviewOVR',
      );
    },
    framebufferTextureMultisampleMultiviewOVR(
      this: ExtThis,
      target: number,
      attachment: number,
      texture: WebGLTexture | null,
      level: number,
      samples: number,
      baseViewIndex: number,
      numViews: number,
    ): void {
      this._gl._framebufferTextureMultiview(
        target,
        attachment,
        texture,
        level,
        samples,
        baseViewIndex,
        numViews,
        'framebufferTextureMultisampleMultiviewOVR',
      );
    },
  },
  WebGLMultisampledRenderToTexture: {
    renderbufferStorageMultisampleEXT(
      this: ExtThis,
      target: number,
      samples: number,
      internalformat: number,
      width: number,
      height: number,
    ): void {
      this._gl._renderbufferStorageMultisampleEXT(
        target,
        samples,
        internalformat,
        width,
        height,
      );
    },
    framebufferTexture2DMultisampleEXT(
      this: ExtThis,
      target: number,
      attachment: number,
      textarget: number,
      texture: WebGLTexture | null,
      level: number,
      samples: number,
    ): void {
      this._gl._framebufferTexture2DMultisample(
        target,
        attachment,
        textarget,
        texture,
        level,
        samples,
      );
    },
  },
  OESDrawBuffersIndexed: {
    enableiOES(this: ExtThis, target: number, index: number): void {
      const gl = this._gl;
      indexed(
        gl,
        () => gl._n.enableiOES(target >>> 0, index >>> 0),
        IDX_BLEND,
        index,
        () => {
          if (target >>> 0 === E.BLEND) gl._caps[0] = 1;
        },
      );
    },
    disableiOES(this: ExtThis, target: number, index: number): void {
      const gl = this._gl;
      indexed(
        gl,
        () => gl._n.disableiOES(target >>> 0, index >>> 0),
        IDX_BLEND,
        index,
        () => {
          if (target >>> 0 === E.BLEND) gl._caps[0] = 0;
        },
      );
    },
    blendEquationiOES(this: ExtThis, buf: number, mode: number): void {
      const gl = this._gl;
      if (
        !indexOk(gl, buf, 'blendEquationiOES') ||
        !enumsOk(gl, BLEND_EQS, 'blendEquationiOES', mode)
      )
        return;
      indexed(
        gl,
        () => gl._n.blendEquationiOES(buf >>> 0, mode >>> 0),
        IDX_EQ,
        buf,
        () => {
          gl._blendEq[0] = gl._blendEq[1] = mode >>> 0;
        },
      );
    },
    blendEquationSeparateiOES(
      this: ExtThis,
      buf: number,
      modeRGB: number,
      modeAlpha: number,
    ): void {
      const gl = this._gl;
      if (
        !indexOk(gl, buf, 'blendEquationSeparateiOES') ||
        !enumsOk(gl, BLEND_EQS, 'blendEquationSeparateiOES', modeRGB, modeAlpha)
      )
        return;
      indexed(
        gl,
        () =>
          gl._n.blendEquationSeparateiOES(
            buf >>> 0,
            modeRGB >>> 0,
            modeAlpha >>> 0,
          ),
        IDX_EQ,
        buf,
        () => {
          gl._blendEq[0] = modeRGB >>> 0;
          gl._blendEq[1] = modeAlpha >>> 0;
        },
      );
    },
    blendFunciOES(this: ExtThis, buf: number, src: number, dst: number): void {
      const gl = this._gl;
      if (
        !indexOk(gl, buf, 'blendFunciOES') ||
        !enumsOk(gl, BLEND_FACTORS, 'blendFunciOES', src, dst)
      )
        return;
      if (constantConflict(src >>> 0, dst >>> 0))
        return gl._e(E.INVALID_OPERATION, 'blendFunciOES');
      indexed(
        gl,
        () => gl._n.blendFunciOES(buf >>> 0, src >>> 0, dst >>> 0),
        IDX_FUNC,
        buf,
        () => {
          const f = gl._blendFunc;
          f[0] = f[2] = src >>> 0;
          f[1] = f[3] = dst >>> 0;
        },
      );
    },
    blendFuncSeparateiOES(
      this: ExtThis,
      buf: number,
      srcRGB: number,
      dstRGB: number,
      srcA: number,
      dstA: number,
    ): void {
      const gl = this._gl;
      if (
        !indexOk(gl, buf, 'blendFuncSeparateiOES') ||
        !enumsOk(
          gl,
          BLEND_FACTORS,
          'blendFuncSeparateiOES',
          srcRGB,
          dstRGB,
          srcA,
          dstA,
        )
      )
        return;
      if (constantConflict(srcRGB >>> 0, dstRGB >>> 0))
        return gl._e(E.INVALID_OPERATION, 'blendFuncSeparateiOES');
      indexed(
        gl,
        () =>
          gl._n.blendFuncSeparateiOES(
            buf >>> 0,
            srcRGB >>> 0,
            dstRGB >>> 0,
            srcA >>> 0,
            dstA >>> 0,
          ),
        IDX_FUNC,
        buf,
        () => {
          const f = gl._blendFunc;
          f[0] = srcRGB >>> 0;
          f[1] = dstRGB >>> 0;
          f[2] = srcA >>> 0;
          f[3] = dstA >>> 0;
        },
      );
    },
    colorMaskiOES(
      this: ExtThis,
      buf: number,
      r: boolean,
      g: boolean,
      b: boolean,
      a: boolean,
    ): void {
      const gl = this._gl;
      if (!indexOk(gl, buf, 'colorMaskiOES')) return;
      if (!gl._lost) {
        const bit = 1 << (buf >>> 0);
        gl._bufMaskOn =
          r || g || b || a ? gl._bufMaskOn | bit : gl._bufMaskOn & ~bit;
        const on = (r ? 1 : 0) + (g ? 1 : 0) + (b ? 1 : 0) + (a ? 1 : 0);
        gl._bufMaskPartial =
          on % 4 !== 0 ? gl._bufMaskPartial | bit : gl._bufMaskPartial & ~bit;
      }
      indexed(
        gl,
        () => gl._n.colorMaskiOES(buf >>> 0, !!r, !!g, !!b, !!a),
        IDX_MASK,
        buf,
        () => {
          const m = gl._colorMask;
          m[0] = r ? 1 : 0;
          m[1] = g ? 1 : 0;
          m[2] = b ? 1 : 0;
          m[3] = a ? 1 : 0;
        },
      );
    },
  },
  // State-cached like their core neighbours (GL-PERF-2) and answered by getParameter (getters.ts).
  EXTPolygonOffsetClamp: {
    polygonOffsetClampEXT(
      this: ExtThis,
      factor: number,
      units: number,
      clamp: number,
    ): void {
      const gl = this._gl;
      if (gl._skip()) return;
      const p = gl._polygonOffset;
      const f = Math.fround(+factor);
      const u = Math.fround(+units);
      const c = Math.fround(+clamp);
      if (p[0] === f && p[1] === u && Object.is(gl._polygonOffsetClamp, c))
        return;
      p[0] = f;
      p[1] = u;
      gl._polygonOffsetClamp = c;
      gl._n.polygonOffsetClampEXT(f, u, c);
    },
  },
  EXTClipControl: {
    clipControlEXT(this: ExtThis, origin: number, depth: number): void {
      const gl = this._gl;
      if (gl._skip()) return;
      origin >>>= 0;
      depth >>>= 0;
      if (
        (origin !== E.LOWER_LEFT_EXT && origin !== E.UPPER_LEFT_EXT) ||
        (depth !== E.NEGATIVE_ONE_TO_ONE_EXT && depth !== E.ZERO_TO_ONE_EXT)
      ) {
        return gl._e(E.INVALID_ENUM, 'clipControlEXT');
      }
      const c = gl._clipControl;
      if (c[0] === origin && c[1] === depth) return;
      c[0] = origin;
      c[1] = depth;
      gl._n.clipControlEXT(origin, depth);
    },
  },
  WebGLPolygonMode: {
    polygonModeWEBGL(this: ExtThis, face: number, mode: number): void {
      const gl = this._gl;
      if (gl._skip()) return;
      face >>>= 0;
      mode >>>= 0;
      if (
        face !== E.FRONT_AND_BACK ||
        (mode !== E.LINE_WEBGL && mode !== E.FILL_WEBGL)
      )
        return gl._e(E.INVALID_ENUM, 'polygonModeWEBGL');
      if (gl._polygonMode === mode) return;
      gl._polygonMode = mode;
      gl._n.polygonModeNV(face, mode);
    },
  },
  WebGLCompressedTextureASTC: {
    getSupportedProfiles(this: ExtThis): string[] {
      const gl = this._gl;
      return gl._driverExt.has('GL_KHR_texture_compression_astc_hdr')
        ? ['ldr', 'hdr']
        : ['ldr'];
    },
  },
  WebGLProvokingVertex: {
    provokingVertexWEBGL(this: ExtThis, mode: number): void {
      // Only exposed when the driver has GL_ANGLE/EXT_provoking_vertex (absent on Adreno and Mesa ES).
      void mode;
      this._gl._e(E.INVALID_OPERATION, 'provokingVertexWEBGL');
    },
  },
  // ------------------------------------------------------------------------------------------ WebGL 1 surface
  ANGLEInstancedArrays: {
    drawArraysInstancedANGLE(
      this: ExtThis,
      mode: number,
      first: number,
      count: number,
      primcount: number,
    ): void {
      impl(this._gl, 'drawArraysInstanced').call(
        this._gl,
        mode,
        first,
        count,
        primcount,
      );
    },
    drawElementsInstancedANGLE(
      this: ExtThis,
      mode: number,
      count: number,
      type: number,
      offset: number,
      primcount: number,
    ): void {
      impl(this._gl, 'drawElementsInstanced').call(
        this._gl,
        mode,
        count,
        type,
        offset,
        primcount,
      );
    },
    vertexAttribDivisorANGLE(
      this: ExtThis,
      index: number,
      divisor: number,
    ): void {
      impl(this._gl, 'vertexAttribDivisor').call(this._gl, index, divisor);
    },
  },
  OESVertexArrayObject: {
    createVertexArrayOES(this: ExtThis): WebGLVertexArrayObjectOES | null {
      return createVaoOES(this._gl);
    },
    deleteVertexArrayOES(
      this: ExtThis,
      vao: WebGLVertexArrayObject | null,
    ): void {
      impl(this._gl, 'deleteVertexArray').call(this._gl, vao);
    },
    isVertexArrayOES(
      this: ExtThis,
      vao: WebGLVertexArrayObject | null,
    ): boolean {
      return impl(this._gl, 'isVertexArray').call(this._gl, vao) as boolean;
    },
    bindVertexArrayOES(
      this: ExtThis,
      vao: WebGLVertexArrayObject | null,
    ): void {
      impl(this._gl, 'bindVertexArray').call(this._gl, vao);
    },
  },
  WebGLDrawBuffers: {
    drawBuffersWEBGL(this: ExtThis, buffers: number[]): void {
      impl(this._gl, 'drawBuffers').call(this._gl, buffers);
    },
  },
  EXTDisjointTimerQuery: {
    createQueryEXT(this: ExtThis): WebGLTimerQueryEXT | null {
      const gl = this._gl;
      if (gl._skip()) return null;
      const q = new WebGLTimerQueryEXT(INTERNAL, gl, gl._n.genQuery());
      gl._track(q);
      return q;
    },
    deleteQueryEXT(this: ExtThis, q: WebGLQuery | null): void {
      impl(this._gl, 'deleteQuery').call(this._gl, q);
    },
    isQueryEXT(this: ExtThis, q: WebGLQuery | null): boolean {
      return impl(this._gl, 'isQuery').call(this._gl, q) as boolean;
    },
    beginQueryEXT(this: ExtThis, target: number, q: WebGLQuery): void {
      impl(this._gl, 'beginQuery').call(this._gl, target, q);
    },
    endQueryEXT(this: ExtThis, target: number): void {
      impl(this._gl, 'endQuery').call(this._gl, target);
    },
    queryCounterEXT(this: ExtThis, q: WebGLQuery, target: number): void {
      queryCounter(this._gl, q, target);
    },
    getQueryEXT(this: ExtThis, target: number, pname: number): unknown {
      return impl(this._gl, 'getQuery').call(this._gl, target, pname);
    },
    getQueryObjectEXT(this: ExtThis, q: WebGLQuery, pname: number): unknown {
      return impl(this._gl, 'getQueryParameter').call(this._gl, q, pname);
    },
  },
};

/** The full (WebGL 2) implementation of a context method, independent of which public prototype hides it. */
let implTable: Record<string, Function> = {};
export function setImplTable(t: Record<string, Function>): void {
  implTable = t;
}
function impl(_ctx: Ctx, name: string): Function {
  return implTable[name];
}

const BLEND_EQS = new Set([
  E.FUNC_ADD,
  E.FUNC_SUBTRACT,
  E.FUNC_REVERSE_SUBTRACT,
  E.MIN,
  E.MAX,
]);
const BLEND_FACTORS = new Set([
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
function constantConflict(s: number, d: number): boolean {
  const cc = (f: number): boolean =>
    f === E.CONSTANT_COLOR || f === E.ONE_MINUS_CONSTANT_COLOR;
  const ca = (f: number): boolean =>
    f === E.CONSTANT_ALPHA || f === E.ONE_MINUS_CONSTANT_ALPHA;
  return (cc(s) && ca(d)) || (ca(s) && cc(d));
}

function indexOk(ctx: Ctx, buf: number, what: string): boolean {
  if (ctx._lost) return false;
  if (buf >>> 0 >= ctx._maxDrawBuffers) {
    ctx._e(E.INVALID_VALUE, what);
    return false;
  }
  return true;
}
function enumsOk(
  ctx: Ctx,
  set: Set<number>,
  what: string,
  ...values: number[]
): boolean {
  for (const v of values) {
    if (!set.has(v >>> 0)) {
      ctx._e(E.INVALID_ENUM, what);
      return false;
    }
  }
  return true;
}

/** Ctx._idxDiverged bits: which global state may differ between draw buffers. */
export const IDX_BLEND = 1;
export const IDX_EQ = 2;
export const IDX_FUNC = 4;
export const IDX_MASK = 8;

/**
 * An indexed state change (OES_draw_buffers_indexed). The cached global values keep describing draw buffer 0
 * (what the non-indexed getters report, ES 3.2 §20); an index-0 change updates them. Any indexed change marks
 * the state diverged, so the next non-indexed set always reaches the driver (it rewrites every buffer) and
 * clears the mark (GL-PERF-2 coherency).
 */
function indexed(
  ctx: Ctx,
  call: () => void,
  bit: number,
  index: number,
  setIndex0: () => void,
): void {
  if (ctx._skip()) return;
  call();
  if (index >>> 0 === 0) setIndex0();
  ctx._idxDiverged |= bit;
}

const protoCache = new Map<string, object>();

/** One prototype per extension interface: IDL constants + methods (hand-written or generated). */
function extensionPrototype(iface: string): object {
  let proto = protoCache.get(iface);
  if (proto) return proto;
  proto = Object.create(Object.prototype) as object;
  const shape = IDL[iface];
  if (shape) {
    for (const [name, value] of shape.consts) {
      Object.defineProperty(proto, name, { value, enumerable: true });
    }
  }
  const methods = {
    ...(directExtensionMethods[iface] ?? {}),
    ...(EXT_METHODS[iface] ?? {}),
  };
  for (const [name, fn] of Object.entries(methods)) {
    Object.defineProperty(proto, name, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  Object.defineProperty(proto, Symbol.toStringTag, { value: iface });
  protoCache.set(iface, proto);
  return proto;
}

function available(ctx: Ctx, test: Availability): boolean {
  return test(
    (n: string) => ctx._driverExt.has(n),
    /OpenGL ES 3\.2/.test(ctx._info.version),
  );
}

export const extensionMethods = {
  getSupportedExtensions(this: Ctx): string[] | null {
    if (this._lost) return null;
    const table = this._v2 ? EXTENSIONS_WEBGL2 : EXTENSIONS_WEBGL1;
    return Object.keys(table).filter((name) => available(this, table[name][1]));
  },
  getExtension(this: Ctx, name: string): object | null {
    if (this._lost) return null;
    const table = this._v2 ? EXTENSIONS_WEBGL2 : EXTENSIONS_WEBGL1;
    const wanted = String(name).toLowerCase();
    const key = Object.keys(table).find((k) => k.toLowerCase() === wanted);
    if (!key) return null;
    const existing = this._extensions.get(key);
    if (existing) return existing;
    if (!available(this, table[key][1])) return null;
    const obj = Object.create(extensionPrototype(table[key][0])) as {
      _gl: Ctx;
    };
    Object.defineProperty(obj, '_gl', { value: this });
    this._extensions.set(key, obj);
    this._fbEpoch++; // renderability of some formats depends on extensions
    this._texDirty = true; // and filterability (OES_texture_float_linear)
    onEnable(this, key);
    return obj;
  },
};

function onEnable(ctx: Ctx, name: string): void {
  for (const [fmt, info] of Object.entries(COMPRESSED_FORMATS)) {
    if (info[3] === name) ctx._enabledCompressed.add(Number(fmt));
  }
  if (name === 'KHR_parallel_shader_compile') {
    // nothing to enable natively; COMPLETION_STATUS_KHR becomes a valid pname
  }
}
