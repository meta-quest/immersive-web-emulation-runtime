/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// getParameter & co. with WebGL return types (spec GL-13): bindings, cached state and WebGL-only values are
// answered in JS; limits are fetched from the driver once and cached (GL-14); only framebuffer-dependent
// values reach the driver. getError merges synthesised and driver errors (GL-9) without a glGetError per
// call (GL-10). Context attributes (GL-2) and loss (GL-4).

import type { Ctx, ContextAttributes } from './core.ts';
import { CAP_INDEX } from './core.ts';
import * as E from './gen/enums.gen.ts';
import { COMPRESSED_FORMATS } from './formats.ts';
import {
  PS_PACK_ALIGNMENT,
  PS_PACK_ROW_LENGTH,
  PS_PACK_SKIP_PIXELS,
  PS_PACK_SKIP_ROWS,
  PS_UNPACK_ALIGNMENT,
  PS_UNPACK_IMAGE_HEIGHT,
  PS_UNPACK_ROW_LENGTH,
  PS_UNPACK_SKIP_IMAGES,
  PS_UNPACK_SKIP_PIXELS,
  PS_UNPACK_SKIP_ROWS,
} from './state.ts';

// Native-backed values: kind 1 = int, 2 = float, 3 = Int32Array(2), 4 = Float32Array(2), 5 = int64, 6 = bool
// `limit` values never change for a context and are cached after the first query.
const LIMITS1: Array<readonly [number, number]> = [
  [E.MAX_TEXTURE_SIZE, 1], [E.MAX_CUBE_MAP_TEXTURE_SIZE, 1], [E.MAX_RENDERBUFFER_SIZE, 1],
  [E.MAX_TEXTURE_IMAGE_UNITS, 1], [E.MAX_VERTEX_TEXTURE_IMAGE_UNITS, 1], [E.MAX_COMBINED_TEXTURE_IMAGE_UNITS, 1],
  [E.MAX_VERTEX_ATTRIBS, 1], [E.MAX_VARYING_VECTORS, 1], [E.MAX_VERTEX_UNIFORM_VECTORS, 1],
  [E.MAX_FRAGMENT_UNIFORM_VECTORS, 1], [E.MAX_VIEWPORT_DIMS, 3], [E.ALIASED_LINE_WIDTH_RANGE, 4],
  [E.ALIASED_POINT_SIZE_RANGE, 4], [E.SUBPIXEL_BITS, 1],
];
const LIMITS2: Array<readonly [number, number]> = [
  [E.MAX_3D_TEXTURE_SIZE, 1], [E.MAX_ARRAY_TEXTURE_LAYERS, 1], [E.MAX_COLOR_ATTACHMENTS, 1], [E.MAX_DRAW_BUFFERS, 1],
  [E.MAX_ELEMENT_INDEX, 5], [E.MAX_ELEMENTS_INDICES, 1], [E.MAX_ELEMENTS_VERTICES, 1],
  [E.MAX_FRAGMENT_INPUT_COMPONENTS, 1], [E.MAX_FRAGMENT_UNIFORM_BLOCKS, 1], [E.MAX_FRAGMENT_UNIFORM_COMPONENTS, 1],
  [E.MAX_PROGRAM_TEXEL_OFFSET, 1], [E.MIN_PROGRAM_TEXEL_OFFSET, 1], [E.MAX_SAMPLES, 1],
  [E.MAX_SERVER_WAIT_TIMEOUT, 5], [E.MAX_TEXTURE_LOD_BIAS, 2], [E.MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS, 1],
  [E.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS, 1], [E.MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS, 1],
  [E.MAX_UNIFORM_BLOCK_SIZE, 5], [E.MAX_UNIFORM_BUFFER_BINDINGS, 1], [E.MAX_VARYING_COMPONENTS, 1],
  [E.MAX_VERTEX_OUTPUT_COMPONENTS, 1], [E.MAX_VERTEX_UNIFORM_BLOCKS, 1], [E.MAX_VERTEX_UNIFORM_COMPONENTS, 1],
  [E.MAX_COMBINED_UNIFORM_BLOCKS, 1], [E.MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS, 5],
  [E.MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS, 5], [E.UNIFORM_BUFFER_OFFSET_ALIGNMENT, 1],
];
const LIMIT1 = new Map(LIMITS1);
const LIMIT2 = new Map(LIMITS2);
/** Values that depend on the bound framebuffer (queried each time). */
const FB_DEPENDENT = new Map<number, number>([
  [E.RED_BITS, 1], [E.GREEN_BITS, 1], [E.BLUE_BITS, 1], [E.ALPHA_BITS, 1], [E.DEPTH_BITS, 1], [E.STENCIL_BITS, 1],
  [E.SAMPLE_BUFFERS, 1], [E.SAMPLES, 1], [E.IMPLEMENTATION_COLOR_READ_FORMAT, 1], [E.IMPLEMENTATION_COLOR_READ_TYPE, 1],
]);

function nativeValue(ctx: Ctx, pname: number, kind: number): unknown {
  const n = ctx._n;
  switch (kind) {
    case 1:
      return ctx._getInt(pname);
    case 2:
      n.getFloatv(pname, ctx._f32, 0, 4);
      return ctx._f32[0];
    case 3: {
      const out = new Int32Array(2);
      void out.buffer;
      n.getIntegerv(pname, out, 0, 8);
      return out;
    }
    case 4: {
      const out = new Float32Array(2);
      void out.buffer;
      n.getFloatv(pname, out, 0, 8);
      return out;
    }
    case 5:
      n.getInteger64v(pname, ctx._i64, 0, 8);
      return Number(ctx._i64[0]);
    case 6:
      n.getBooleanv(pname, ctx._u8, 0, 1);
      return ctx._u8[0] !== 0;
  }
  return null;
}

function cachedLimit(ctx: Ctx, pname: number, kind: number): unknown {
  const c = ctx._limitCache;
  if (c.has(pname)) {
    const v = c.get(pname);
    // typed arrays are returned as fresh copies (callers may mutate them)
    if (v instanceof Int32Array) return new Int32Array(v);
    if (v instanceof Float32Array) return new Float32Array(v);
    return v;
  }
  const v = nativeValue(ctx, pname, kind);
  c.set(pname, v);
  if (v instanceof Int32Array) return new Int32Array(v);
  if (v instanceof Float32Array) return new Float32Array(v);
  return v;
}

function f32(a: Float32Array): Float32Array {
  return new Float32Array(a);
}
function i32(a: Int32Array): Int32Array {
  return new Int32Array(a);
}

export const getterMethods = {
  getError(this: Ctx): number {
    if (this._lost) {
      if (this._lostErrPending) {
        this._lostErrPending = false;
        return E.CONTEXT_LOST_WEBGL;
      }
      return E.NO_ERROR;
    }
    this._skip();
    if (this._errs.length !== 0) return this._errs.shift()!;
    return this._n.getError();
  },
  isContextLost(this: Ctx): boolean {
    return this._lost;
  },
  getContextAttributes(this: Ctx): ContextAttributes | null {
    if (this._lost) return null;
    const a = this._attrs;
    return {
      alpha: a.alpha,
      antialias: a.antialias,
      depth: a.depth,
      desynchronized: a.desynchronized,
      failIfMajorPerformanceCaveat: a.failIfMajorPerformanceCaveat,
      powerPreference: a.powerPreference,
      premultipliedAlpha: a.premultipliedAlpha,
      preserveDrawingBuffer: a.preserveDrawingBuffer,
      stencil: a.stencil,
      xrCompatible: a.xrCompatible,
    };
  },
  makeXRCompatible(this: Ctx): Promise<void> {
    if (this._lost) {
      const D = (globalThis as { DOMException?: new (m: string, n: string) => Error }).DOMException;
      return Promise.reject(D ? new D('context lost', 'InvalidStateError') : new Error('context lost'));
    }
    this._attrs.xrCompatible = true;
    return Promise.resolve();
  },
  getIndexedParameter(this: Ctx, target: number, index: number): unknown {
    if (this._skip()) return null;
    target >>>= 0;
    index >>>= 0;
    switch (target) {
      case E.UNIFORM_BUFFER_BINDING:
      case E.UNIFORM_BUFFER_START:
      case E.UNIFORM_BUFFER_SIZE:
        if (index >= this._maxUboBindings) break;
        if (target === E.UNIFORM_BUFFER_BINDING) return this._uboBindings[index];
        return this._uboRanges[index * 2 + (target === E.UNIFORM_BUFFER_SIZE ? 1 : 0)];
      case E.TRANSFORM_FEEDBACK_BUFFER_BINDING:
        if (index >= this._maxTfBuffers) break;
        return this._tf._buffers[index];
      case E.TRANSFORM_FEEDBACK_BUFFER_START:
      case E.TRANSFORM_FEEDBACK_BUFFER_SIZE:
        if (index >= this._maxTfBuffers) break;
        this._n.getInteger64i_v(target, index, this._i64, 0, 8);
        return Number(this._i64[0]);
      case E.BLEND_EQUATION_RGB:
      case E.BLEND_EQUATION_ALPHA:
      case E.BLEND_SRC_RGB:
      case E.BLEND_SRC_ALPHA:
      case E.BLEND_DST_RGB:
      case E.BLEND_DST_ALPHA:
      case E.COLOR_WRITEMASK:
        // OES_draw_buffers_indexed
        if (!this._extensions.has('OES_draw_buffers_indexed')) break;
        if (index >= this._maxDrawBuffers) {
          this._e(E.INVALID_VALUE, 'getIndexedParameter');
          return null;
        }
        if (target === E.COLOR_WRITEMASK) {
          const b = this._u32;
          b[0] = b[1] = b[2] = b[3] = 0;
          this._n.getBooleani_v(target, index, b, 0, 4);
          const u8 = new Uint8Array(b.buffer, 0, 4);
          return [u8[0] !== 0, u8[1] !== 0, u8[2] !== 0, u8[3] !== 0];
        }
        this._n.getIntegeri_v(target, index, this._i32, 0, 4);
        return this._i32[0];
      default:
        break;
    }
    if (target === E.UNIFORM_BUFFER_BINDING || target === E.UNIFORM_BUFFER_START || target === E.UNIFORM_BUFFER_SIZE ||
        target === E.TRANSFORM_FEEDBACK_BUFFER_BINDING || target === E.TRANSFORM_FEEDBACK_BUFFER_START || target === E.TRANSFORM_FEEDBACK_BUFFER_SIZE) {
      this._e(E.INVALID_VALUE, 'getIndexedParameter');
      return null;
    }
    this._e(E.INVALID_ENUM, 'getIndexedParameter');
    return null;
  },
  getParameter(this: Ctx, pname: number): unknown {
    if (this._skip()) return null;
    pname >>>= 0;
    const v2 = this._v2;
    const ci = CAP_INDEX[pname];
    if (ci !== undefined && (ci !== 9 || v2)) return this._caps[ci] === 1;
    if (this._capAllowed(pname)) return this._n.isEnabled(pname); // extension caps (clip distances, polygon offset line)
    switch (pname) {
      // --- WebGL-only values / strings
      case E.VERSION:
        return v2 ? `WebGL 2.0 (${this._info.version})` : `WebGL 1.0 (${this._info.version})`;
      case E.SHADING_LANGUAGE_VERSION:
        return v2 ? `WebGL GLSL ES 3.00 (${this._info.glsl})` : `WebGL GLSL ES 1.0 (${this._info.glsl})`;
      case E.VENDOR:
        return this._opts.unmaskedStrings ? this._info.vendor : 'WebKit';
      case E.RENDERER:
        return this._opts.unmaskedStrings ? this._info.renderer : 'WebKit WebGL';
      case E.UNMASKED_VENDOR_WEBGL:
        if (!this._extensions.has('WEBGL_debug_renderer_info')) break;
        return this._info.vendor;
      case E.UNMASKED_RENDERER_WEBGL:
        if (!this._extensions.has('WEBGL_debug_renderer_info')) break;
        return this._info.renderer;
      case E.UNPACK_FLIP_Y_WEBGL:
        return this._flipY;
      case E.UNPACK_PREMULTIPLY_ALPHA_WEBGL:
        return this._premultiply;
      case E.UNPACK_COLORSPACE_CONVERSION_WEBGL:
        return this._colorspaceConversion;
      case E.MAX_CLIENT_WAIT_TIMEOUT_WEBGL:
        if (!v2) break;
        return 0;
      case E.COMPRESSED_TEXTURE_FORMATS:
        return new Uint32Array([...this._enabledCompressed].filter((f) => COMPRESSED_FORMATS[f]));
      // --- bindings
      case E.ACTIVE_TEXTURE:
        return E.TEXTURE0 + this._activeUnit;
      case E.ARRAY_BUFFER_BINDING:
        return this._arrayBuffer;
      case E.ELEMENT_ARRAY_BUFFER_BINDING:
        return this._vao._elementBuffer;
      case E.CURRENT_PROGRAM:
        return this._program;
      case E.FRAMEBUFFER_BINDING:
        return this._drawFbo;
      case E.RENDERBUFFER_BINDING:
        return this._renderbuffer;
      case E.TEXTURE_BINDING_2D:
        return this._tex2D[this._activeUnit];
      case E.TEXTURE_BINDING_CUBE_MAP:
        return this._texCube[this._activeUnit];
      case E.VERTEX_ARRAY_BINDING:
        if (!v2 && !this._extensions.has('OES_vertex_array_object')) break;
        return this._vao === this._defaultVao ? null : this._vao;
      // --- state
      case E.BLEND_COLOR:
        return f32(this._blendColor);
      case E.BLEND_EQUATION_RGB:
      case E.BLEND_EQUATION_ALPHA:
      case E.BLEND_SRC_RGB:
      case E.BLEND_DST_RGB:
      case E.BLEND_SRC_ALPHA:
      case E.BLEND_DST_ALPHA: {
        const v =
          pname === E.BLEND_EQUATION_RGB ? this._blendEq[0] : pname === E.BLEND_EQUATION_ALPHA ? this._blendEq[1]
          : pname === E.BLEND_SRC_RGB ? this._blendFunc[0] : pname === E.BLEND_DST_RGB ? this._blendFunc[1]
          : pname === E.BLEND_SRC_ALPHA ? this._blendFunc[2] : this._blendFunc[3];
        // 0xFFFFFFFF: poisoned by an indexed blend call (OES_draw_buffers_indexed): ask the driver
        return v === 0xffffffff ? this._getInt(pname) : v;
      }
      case E.COLOR_CLEAR_VALUE:
        return f32(this._clearColor);
      case E.COLOR_WRITEMASK:
        return [this._colorMask[0] === 1, this._colorMask[1] === 1, this._colorMask[2] === 1, this._colorMask[3] === 1];
      case E.CULL_FACE_MODE:
        return this._cullFace;
      case E.DEPTH_CLEAR_VALUE:
        return this._clearDepth;
      case E.DEPTH_FUNC:
        return this._depthFunc;
      case E.DEPTH_RANGE:
        return f32(this._depthRange);
      case E.DEPTH_WRITEMASK:
        return this._depthMask;
      case E.FRONT_FACE:
        return this._frontFace;
      case E.GENERATE_MIPMAP_HINT:
        return this._hints.get(pname) ?? E.DONT_CARE;
      case E.FRAGMENT_SHADER_DERIVATIVE_HINT:
        if (!v2 && !this._extensions.has('OES_standard_derivatives')) break;
        return this._hints.get(pname) ?? E.DONT_CARE;
      case E.LINE_WIDTH:
        return this._lineWidth;
      case E.POLYGON_OFFSET_FACTOR:
        return this._polygonOffset[0];
      case E.POLYGON_OFFSET_UNITS:
        return this._polygonOffset[1];
      case E.POLYGON_OFFSET_CLAMP_EXT:
        if (!this._extensions.has('EXT_polygon_offset_clamp')) break;
        return this._polygonOffsetClamp;
      case E.CLIP_ORIGIN_EXT:
        if (!this._extensions.has('EXT_clip_control')) break;
        return this._clipControl[0];
      case E.CLIP_DEPTH_MODE_EXT:
        if (!this._extensions.has('EXT_clip_control')) break;
        return this._clipControl[1];
      case E.POLYGON_MODE_WEBGL:
        if (!this._extensions.has('WEBGL_polygon_mode')) break;
        return this._polygonMode;
      case E.SAMPLE_COVERAGE_VALUE:
        return this._sampleCoverageValue;
      case E.SAMPLE_COVERAGE_INVERT:
        return this._sampleCoverageInvert;
      case E.SCISSOR_BOX:
        return i32(this._scissor);
      case E.VIEWPORT:
        return i32(this._viewport);
      case E.STENCIL_FUNC:
        return this._stencilFuncF[0];
      case E.STENCIL_REF:
        return this._stencilFuncF[1];
      case E.STENCIL_VALUE_MASK:
        return this._stencilFuncF[2] >>> 0;
      case E.STENCIL_BACK_FUNC:
        return this._stencilFuncB[0];
      case E.STENCIL_BACK_REF:
        return this._stencilFuncB[1];
      case E.STENCIL_BACK_VALUE_MASK:
        return this._stencilFuncB[2] >>> 0;
      case E.STENCIL_WRITEMASK:
        return this._stencilMaskF >>> 0;
      case E.STENCIL_BACK_WRITEMASK:
        return this._stencilMaskB >>> 0;
      case E.STENCIL_FAIL:
        return this._stencilOpF[0];
      case E.STENCIL_PASS_DEPTH_FAIL:
        return this._stencilOpF[1];
      case E.STENCIL_PASS_DEPTH_PASS:
        return this._stencilOpF[2];
      case E.STENCIL_BACK_FAIL:
        return this._stencilOpB[0];
      case E.STENCIL_BACK_PASS_DEPTH_FAIL:
        return this._stencilOpB[1];
      case E.STENCIL_BACK_PASS_DEPTH_PASS:
        return this._stencilOpB[2];
      case E.STENCIL_CLEAR_VALUE:
        return this._clearStencil;
      case E.PACK_ALIGNMENT:
        return this._ps[PS_PACK_ALIGNMENT];
      case E.UNPACK_ALIGNMENT:
        return this._ps[PS_UNPACK_ALIGNMENT];
      case E.MAX_VIEWS_OVR:
        if (!this._extensions.has('OVR_multiview2') && !this._extensions.has('OCULUS_multiview')) break;
        return this._getLimit(E.MAX_VIEWS_OVR);
      case E.MAX_TEXTURE_MAX_ANISOTROPY_EXT:
        if (!this._extensions.has('EXT_texture_filter_anisotropic')) break;
        return cachedLimit(this, pname, 2);
      case E.GPU_DISJOINT_EXT:
        if (!this._extensions.has('EXT_disjoint_timer_query_webgl2') && !this._extensions.has('EXT_disjoint_timer_query')) break;
        return nativeValue(this, pname, 6);
      case E.TIMESTAMP_EXT:
        if (!this._extensions.has('EXT_disjoint_timer_query_webgl2') && !this._extensions.has('EXT_disjoint_timer_query')) break;
        return nativeValue(this, pname, 5);
      case E.MAX_CLIP_DISTANCES_WEBGL:
      case E.MAX_CULL_DISTANCES_WEBGL:
      case E.MAX_COMBINED_CLIP_AND_CULL_DISTANCES_WEBGL:
        if (!this._extensions.has('WEBGL_clip_cull_distance')) break;
        return cachedLimit(this, pname, 1);
      case E.MAX_DRAW_BUFFERS_WEBGL:
        if (v2 || !this._extensions.has('WEBGL_draw_buffers')) break;
        return this._maxDrawBuffers;
      case E.MAX_COLOR_ATTACHMENTS: // = MAX_COLOR_ATTACHMENTS_WEBGL
        if (v2 || !this._extensions.has('WEBGL_draw_buffers')) break;
        return this._maxColorAttachments;
    }
    // WEBGL_draw_buffers: DRAW_BUFFERi_WEBGL on the WebGL 1 surface (WebGL 2 answers them below)
    if (!v2 && pname >= E.DRAW_BUFFER0 && pname <= E.DRAW_BUFFER15 && this._extensions.has('WEBGL_draw_buffers')) {
      const i = pname - E.DRAW_BUFFER0;
      if (i >= this._maxDrawBuffers) {
        this._e(E.INVALID_ENUM, 'getParameter');
        return null;
      }
      if (this._drawFbo === null) return i === 0 ? this._dfbDrawBuffer : E.NONE;
      return this._drawFbo._drawBuffers[i] ?? E.NONE;
    }
    if (v2) {
      switch (pname) {
        case E.COPY_READ_BUFFER_BINDING:
          return this._copyRead;
        case E.COPY_WRITE_BUFFER_BINDING:
          return this._copyWrite;
        case E.PIXEL_PACK_BUFFER_BINDING:
          return this._pixelPack;
        case E.PIXEL_UNPACK_BUFFER_BINDING:
          return this._pixelUnpack;
        case E.TRANSFORM_FEEDBACK_BUFFER_BINDING:
          return this._tfBuffer;
        case E.UNIFORM_BUFFER_BINDING:
          return this._uniformBuffer;
        case E.READ_FRAMEBUFFER_BINDING:
          return this._readFbo;
        case E.TEXTURE_BINDING_3D:
          return this._tex3D[this._activeUnit];
        case E.TEXTURE_BINDING_2D_ARRAY:
          return this._tex2DArray[this._activeUnit];
        case E.SAMPLER_BINDING:
          return this._samplers[this._activeUnit];
        case E.TRANSFORM_FEEDBACK_BINDING:
          return this._tf === this._defaultTf ? null : this._tf;
        case E.TRANSFORM_FEEDBACK_ACTIVE:
          return this._tf._active;
        case E.TRANSFORM_FEEDBACK_PAUSED:
          return this._tf._paused;
        case E.READ_BUFFER:
          return this._readFbo === null ? this._dfbReadBuffer : this._readFbo._readBuffer;
        case E.PACK_ROW_LENGTH:
          return this._ps[PS_PACK_ROW_LENGTH];
        case E.PACK_SKIP_PIXELS:
          return this._ps[PS_PACK_SKIP_PIXELS];
        case E.PACK_SKIP_ROWS:
          return this._ps[PS_PACK_SKIP_ROWS];
        case E.UNPACK_ROW_LENGTH:
          return this._ps[PS_UNPACK_ROW_LENGTH];
        case E.UNPACK_IMAGE_HEIGHT:
          return this._ps[PS_UNPACK_IMAGE_HEIGHT];
        case E.UNPACK_SKIP_PIXELS:
          return this._ps[PS_UNPACK_SKIP_PIXELS];
        case E.UNPACK_SKIP_ROWS:
          return this._ps[PS_UNPACK_SKIP_ROWS];
        case E.UNPACK_SKIP_IMAGES:
          return this._ps[PS_UNPACK_SKIP_IMAGES];
      }
      if (pname >= E.DRAW_BUFFER0 && pname <= E.DRAW_BUFFER15) {
        const i = pname - E.DRAW_BUFFER0;
        if (i >= this._maxDrawBuffers) {
          this._e(E.INVALID_ENUM, 'getParameter');
          return null;
        }
        if (this._drawFbo === null) return i === 0 ? this._dfbDrawBuffer : E.NONE;
        return this._drawFbo._drawBuffers[i] ?? E.NONE;
      }
      const k2 = LIMIT2.get(pname);
      if (k2 !== undefined) return cachedLimit(this, pname, k2);
    }
    const k1 = LIMIT1.get(pname);
    if (k1 !== undefined) return cachedLimit(this, pname, k1);
    const fk = FB_DEPENDENT.get(pname);
    if (fk !== undefined) {
      if (this._drawFbo === null || this._readFbo === null) this._ensureDefaultFramebuffer();
      return nativeValue(this, pname, fk);
    }
    this._e(E.INVALID_ENUM, 'getParameter');
    return null;
  },
};

/** Attributes: canvas, drawingBufferWidth/Height, drawingBufferColorSpace, unpackColorSpace (GL-2). */
export const attributeAccessors: Record<string, PropertyDescriptor> = {
  canvas: {
    get(this: Ctx) {
      return this._canvas;
    },
  },
  drawingBufferWidth: {
    get(this: Ctx) {
      return this._lost ? 0 : this._canvasWidth();
    },
  },
  drawingBufferHeight: {
    get(this: Ctx) {
      return this._lost ? 0 : this._canvasHeight();
    },
  },
  drawingBufferColorSpace: {
    get(this: Ctx) {
      return this._drawingBufferColorSpace;
    },
    set(this: Ctx, v: unknown) {
      const s = String(v);
      if (s !== 'srgb' && s !== 'display-p3') throw new TypeError(`'${s}' is not a valid PredefinedColorSpace`);
      this._drawingBufferColorSpace = s; // accepted and ignored (no colour management), GL-2
    },
  },
  unpackColorSpace: {
    get(this: Ctx) {
      return this._unpackColorSpace;
    },
    set(this: Ctx, v: unknown) {
      const s = String(v);
      if (s !== 'srgb' && s !== 'display-p3') throw new TypeError(`'${s}' is not a valid PredefinedColorSpace`);
      this._unpackColorSpace = s;
    },
  },
};
