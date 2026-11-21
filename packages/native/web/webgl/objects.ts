/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// WebGL object model (spec GL-5): wrapper identity, ownership by one context, deletion flags, and the
// per-object state the binding tracks to synthesise WebGL errors and answer getters without the driver.
// Interfaces are not constructible by script (GL-1): constructors throw unless given the internal token.

import type { Ctx } from './core.ts';
import type { ProgramRecord } from './reflection.ts';

export const INTERNAL: unique symbol = Symbol('iwn.webgl.internal');

export const enumKind = {
  buffer: 1,
  framebuffer: 2,
  program: 3,
  renderbuffer: 4,
  shader: 5,
  texture: 6,
  query: 7,
  sampler: 8,
  sync: 9,
  transformFeedback: 10,
  vertexArray: 11,
  uniformLocation: 12,
} as const;

function guard(token: unknown): void {
  if (token !== INTERNAL) throw new TypeError('Illegal constructor');
}

export class WebGLObject {
  /** owning context */
  _ctx: Ctx;
  /** GL name (0 for default objects) */
  _name: number;
  /** deleteX() was called (the GL object may live on while attached / in use) */
  _deleted = false;
  /** has been bound at least once (isBuffer & co. answer false before that) */
  _bound = false;
  /** kind, for DirectHost._nm */
  readonly _kind: number;
  /** context incarnation that created it (objects from before a context loss are invalid after restore) */
  _gen: number;
  constructor(token: unknown, ctx: Ctx, name: number, kind: number) {
    guard(token);
    this._ctx = ctx;
    this._name = name;
    this._kind = kind;
    this._gen = ctx._gen;
  }
  get [Symbol.toStringTag](): string {
    return this.constructor.name;
  }
}

/** Buffer data type (WebGL 2.0 §5.1): fixed by the first bind. */
export const BUF_UNDEFINED = 0;
export const BUF_ELEMENT = 1;
export const BUF_OTHER = 2;

export class WebGLBuffer extends WebGLObject {
  _type = BUF_UNDEFINED;
  _size = 0;
  _usage = 0x88e4; // STATIC_DRAW
  /** number of binding points (incl. VAO attribs, indexed bindings) referencing it in its context */
  _refs = 0;
  constructor(token: unknown, ctx: Ctx, name: number) {
    super(token, ctx, name, enumKind.buffer);
  }
}

export interface TexLevelInfo {
  internalformat: number;
  width: number;
  height: number;
  depth: number;
  /** set by a whole-image RGBA8 upload from native pixels: the level is RGBA / UNSIGNED_BYTE, whatever its format */
  rgba8?: boolean;
}

export class WebGLTexture extends WebGLObject {
  /** first bound target (0 = never bound) */
  _target = 0;
  _immutable = false;
  _immutableLevels = 0;
  /** level info for level 0 of each face/image (enough for getters + zero-init + multiview checks) */
  _level0: TexLevelInfo | null = null;
  /** every specified level (faces of a cube share sizes) */
  _levels = new Map<number, TexLevelInfo>();
  _baseLevel = 0;
  _maxLevel = 1000;
  /** number of framebuffer attachment points referencing it (feedback-loop checks only when > 0) */
  _attachCount = 0;
  /** host-owned texture (XR swapchain image): GL name may be re-pointed each frame, never deleted by us */
  _external = false;
  /** sampling state the draw-time texture checks need (draws.ts _computeTextures) */
  _minFilter = 0x2702; // NEAREST_MIPMAP_LINEAR
  _magFilter = 0x2601; // LINEAR
  _wrapS = 0x2901; // REPEAT
  _wrapT = 0x2901;
  _compareMode = 0; // NONE
  constructor(token: unknown, ctx: Ctx, name: number) {
    super(token, ctx, name, enumKind.texture);
  }
}

export class WebGLRenderbuffer extends WebGLObject {
  _internalformat = 0x80e1; // RGBA4 default per spec
  _width = 0;
  _height = 0;
  _samples = 0;
  constructor(token: unknown, ctx: Ctx, name: number) {
    super(token, ctx, name, enumKind.renderbuffer);
  }
}

export interface Attachment {
  object: WebGLTexture | WebGLRenderbuffer;
  /** texture target used to attach (TEXTURE_2D, cube face, TEXTURE_2D_ARRAY / TEXTURE_3D for layers), 0 for renderbuffers */
  textarget: number;
  level: number;
  layer: number;
  /** OVR_multiview2 views (0 = not multiview) */
  numViews: number;
  baseViewIndex: number;
  /** multisampled-render-to-texture samples (EXT / OCULUS), 0 = none */
  samples: number;
}

export class WebGLFramebuffer extends WebGLObject {
  /** attachment enum -> attachment */
  _attachments = new Map<number, Attachment>();
  /**
   * WebGL 1 only: the three separate depth/stencil attachment points (DEPTH, STENCIL, DEPTH_STENCIL; WebGL 1.0
   * §6.6). The driver has two; `_attachments` holds what is attached there (DEPTH_STENCIL wins).
   */
  _v1Points = new Map<number, Attachment>();
  /** OVR_multiview2 views of the attachments (0 = not multiview) */
  _numViews = 0;
  /** number of texture attachments (feedback-loop checks) */
  _texAttachments = 0;
  /** WebGL-only completeness verdict (0 = defer to the driver), recomputed when attachments change */
  _webglStatus = 0;
  /** cached completeness (0 = complete, else the status), valid while _verdictEpoch == ctx._fbEpoch */
  _verdict = 0;
  _verdictEpoch = -1;
  /** has a 32-bit float colour attachment (EXT_float_blend gates blending) */
  _has32F = false;
  /** bit i: COLOR_ATTACHMENTi is RGB9_E5 (WEBGL_render_shared_exponent colour-mask rule) */
  _rgb9e5 = 0;
  /** colour formats whose renderability depends on an extension (checked against enabled extensions) */
  _gatedFormats: number[] = [];
  /** DRAW_BUFFERi state (WebGL 2 drawBuffers) */
  _drawBuffers: number[] = [0x8ce0]; // COLOR_ATTACHMENT0
  _readBuffer = 0x8ce0;
  /** opaque framebuffer owned by the host (XRWebGLLayer): attachments are not app-visible */
  _opaque = false;
  constructor(token: unknown, ctx: Ctx, name: number) {
    super(token, ctx, name, enumKind.framebuffer);
  }
}

export class WebGLShader extends WebGLObject {
  _type: number;
  /** the app's source (getShaderSource returns this) */
  _source = '';
  /** what was handed to the driver at the last compile (WEBGL_debug_shaders) */
  _translated = '';
  /** rewritten source of the last shaderSource, not compiled yet */
  _pendingTranslated = '';
  /** compile requested since the last status fetch */
  _compilePending = false;
  _compiled: boolean | null = null;
  _infoLog = '';
  /** number of programs it is attached to (deferred deletion) */
  _attachCount = 0;
  /** layout(num_views = N) found in the source (vertex shaders, OVR_multiview2) */
  _numViews = 0;
  /** uses gl_DrawID (WEBGL_multi_draw emulation uniform injected) */
  _usesDrawId = false;
  /** source / ESSL 1.00 / upgraded-to-3.00 of the last shaderSource (pending) and of the last compile */
  _pendingEssl100 = false;
  _pendingUpgraded = false;
  _compiledSource = '';
  _essl100 = false;
  _upgraded = false;
  constructor(token: unknown, ctx: Ctx, name: number, type: number) {
    super(token, ctx, name, enumKind.shader);
    this._type = type;
  }
}

export class WebGLProgram extends WebGLObject {
  _vs: WebGLShader | null = null;
  _fs: WebGLShader | null = null;
  /** reflection record of the last link (null until fetched; fetched lazily after link) */
  _record: ProgramRecord | null = null;
  /** link requested, record not fetched yet */
  _linkPending = false;
  /** bumps on every link: uniform locations of older links are invalid (GL-8) */
  _linkGen = 0;
  /** ever linked (getProgramParameter before any link answers false) */
  _linkRequested = false;
  /** values captured at link time from the attached shaders */
  _numViews = 0;
  _usesDrawId = false;
  _validateStatus = false;
  _validateLog = '';
  /** in use (current program) when deleteProgram was called */
  _inUse = false;
  constructor(token: unknown, ctx: Ctx, name: number) {
    super(token, ctx, name, enumKind.program);
  }
}

export class WebGLVertexArrayObject extends WebGLObject {
  _elementBuffer: WebGLBuffer | null = null;
  _buffers: (WebGLBuffer | null)[];
  _enabled: Uint8Array;
  /** per attrib: [size, type, normalized, stride, offset, integer, divisor] */
  _pointer: Float64Array;
  /** enabled attributes whose buffer is null (client arrays: draws are INVALID_OPERATION) */
  _enabledWithoutBuffer = 0;
  constructor(token: unknown, ctx: Ctx, name: number, maxAttribs: number) {
    super(token, ctx, name, enumKind.vertexArray);
    this._buffers = new Array<WebGLBuffer | null>(maxAttribs).fill(null);
    this._enabled = new Uint8Array(maxAttribs);
    this._pointer = new Float64Array(maxAttribs * 7);
    for (let i = 0; i < maxAttribs; i++) {
      this._pointer[i * 7] = 4; // size
      this._pointer[i * 7 + 1] = 0x1406; // FLOAT
    }
  }
}

export class WebGLVertexArrayObjectOES extends WebGLVertexArrayObject {}

export class WebGLQuery extends WebGLObject {
  _target = 0;
  /** epoch after which the result may be reported available (GL-15) */
  _availableAfter = Infinity;
  _active = false;
  constructor(token: unknown, ctx: Ctx, name: number) {
    super(token, ctx, name, enumKind.query);
  }
}

export class WebGLTimerQueryEXT extends WebGLQuery {}

export class WebGLSampler extends WebGLObject {
  /** sampling state that overrides the bound texture's (draws.ts _computeTextures) */
  _minFilter = 0x2702;
  _magFilter = 0x2601;
  _wrapS = 0x2901;
  _wrapT = 0x2901;
  _compareMode = 0;
  constructor(token: unknown, ctx: Ctx, name: number) {
    super(token, ctx, name, enumKind.sampler);
  }
}

export class WebGLSync extends WebGLObject {
  _availableAfter: number;
  _signaled = false;
  constructor(token: unknown, ctx: Ctx, name: number, epoch: number) {
    super(token, ctx, name, enumKind.sync);
    this._availableAfter = epoch;
  }
}

export class WebGLTransformFeedback extends WebGLObject {
  _active = false;
  /** primitive mode of the active capture */
  _mode = 0;
  _paused = false;
  _program: WebGLProgram | null = null;
  _buffers: (WebGLBuffer | null)[];
  /** bindBufferRange offset / size per binding (size 0 = whole buffer, bindBufferBase) */
  _offsets: number[];
  _sizes: number[];
  /** vertices captured since beginTransformFeedback (overflow checks, GLES 3.0 §2.15.2) */
  _written = 0;
  constructor(token: unknown, ctx: Ctx, name: number, maxBuffers: number) {
    super(token, ctx, name, enumKind.transformFeedback);
    this._buffers = new Array<WebGLBuffer | null>(maxBuffers).fill(null);
    this._offsets = new Array<number>(maxBuffers).fill(0);
    this._sizes = new Array<number>(maxBuffers).fill(0);
  }
}

/**
 * Last uploaded value of one uniform element (or of an array run starting at it), owned by the program
 * (keyed by uniform index and element, dropped on relink). `siblings` lists every cell of the same array
 * uniform: an upload through one cell invalidates the others, because their cached runs may overlap.
 */
export interface UniformCell {
  tag: number;
  len: number;
  f: Float32Array | null;
  i: Int32Array | null;
  siblings: UniformCell[] | null;
}

export class WebGLUniformLocation {
  _program: WebGLProgram;
  _linkGen: number;
  /** GL location */
  _loc: number;
  /** index into the program record's uniforms */
  _uniform: number;
  /** array element this location starts at */
  _element: number;
  /** uniform family (1 f, 2 i, 3 ui, 4 bool, 5 sampler, 6 matrix) and component count, from the record */
  _family = 0;
  _comps = 0;
  /** GL type of the uniform */
  _type = 0;
  /** elements from this location to the end of the array (1 for non-arrays) */
  _remaining = 1;
  _isArray = false;
  /**
   * Value-cache cell shared by every location object naming the same (program, link, uniform, element)
   * (GL-PERF-2); resolved on first upload.
   */
  _cell: UniformCell | null = null;
  constructor(token: unknown, program: WebGLProgram, loc: number, uniform: number, element: number) {
    guard(token);
    this._program = program;
    this._linkGen = program._linkGen;
    this._loc = loc;
    this._uniform = uniform;
    this._element = element;
    for (const k of Object.keys(this)) Object.defineProperty(this, k, { enumerable: false });
  }
  get [Symbol.toStringTag](): string {
    return 'WebGLUniformLocation';
  }
}

export class WebGLActiveInfo {
  readonly size: number;
  readonly type: number;
  readonly name: string;
  constructor(token: unknown, size: number, type: number, name: string) {
    guard(token);
    this.size = size;
    this.type = type;
    this.name = name;
  }
  get [Symbol.toStringTag](): string {
    return 'WebGLActiveInfo';
  }
}

export class WebGLShaderPrecisionFormat {
  readonly rangeMin: number;
  readonly rangeMax: number;
  readonly precision: number;
  constructor(token: unknown, rangeMin: number, rangeMax: number, precision: number) {
    guard(token);
    this.rangeMin = rangeMin;
    this.rangeMax = rangeMax;
    this.precision = precision;
  }
  get [Symbol.toStringTag](): string {
    return 'WebGLShaderPrecisionFormat';
  }
}

/** Interface objects installed on the global (GL-1). */
export const INTERFACE_CLASSES = {
  WebGLObject,
  WebGLBuffer,
  WebGLFramebuffer,
  WebGLProgram,
  WebGLQuery,
  WebGLRenderbuffer,
  WebGLSampler,
  WebGLShader,
  WebGLSync,
  WebGLTexture,
  WebGLTransformFeedback,
  WebGLUniformLocation,
  WebGLVertexArrayObject,
  WebGLActiveInfo,
  WebGLShaderPrecisionFormat,
} as const;

/** For DirectHost._nm: kind -> class */
export const CLASS_OF_KIND: Record<number, Function> = {
  [enumKind.buffer]: WebGLBuffer,
  [enumKind.framebuffer]: WebGLFramebuffer,
  [enumKind.program]: WebGLProgram,
  [enumKind.renderbuffer]: WebGLRenderbuffer,
  [enumKind.shader]: WebGLShader,
  [enumKind.texture]: WebGLTexture,
  [enumKind.query]: WebGLQuery,
  [enumKind.sampler]: WebGLSampler,
  [enumKind.sync]: WebGLSync,
  [enumKind.transformFeedback]: WebGLTransformFeedback,
  [enumKind.vertexArray]: WebGLVertexArrayObject,
};
