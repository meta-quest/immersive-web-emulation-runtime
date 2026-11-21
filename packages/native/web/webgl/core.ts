/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The context core: native context creation, current-context switching, error recording (GL-9, GL-10),
// context loss (GL-4), object-argument checks (GL-5, GL-6), the cached GL state (GL-PERF-2), the emulated
// default framebuffer, and wrapper lifetime (FinalizationRegistry releases GL names of collected wrappers).
//
// Every public method of the WebGL interfaces lives in a method module (state.ts, buffers.ts, ...) and is
// mixed into the context prototypes by install.ts; methods start with `if (this._skip()) return ...`.

import type { GlNatives } from './gen/natives.gen.ts';
import * as E from './gen/enums.gen.ts';
import {
  INTERNAL,
  WebGLBuffer,
  WebGLFramebuffer,
  WebGLObject,
  WebGLProgram,
  WebGLQuery,
  WebGLRenderbuffer,
  WebGLSampler,
  WebGLShader,
  WebGLTexture,
  WebGLTransformFeedback,
  WebGLVertexArrayObject,
  CLASS_OF_KIND,
  enumKind,
} from './objects.ts';

export interface CanvasLike {
  width: number;
  height: number;
  dispatchEvent?(event: unknown): boolean;
}

export interface ContextAttributes {
  alpha: boolean;
  depth: boolean;
  stencil: boolean;
  antialias: boolean;
  premultipliedAlpha: boolean;
  preserveDrawingBuffer: boolean;
  powerPreference: string;
  failIfMajorPerformanceCaveat: boolean;
  desynchronized: boolean;
  xrCompatible: boolean;
}

export interface ContextOptions {
  /** GL-12: log every call that raised a synthesised error, with the JS stack (rate-limited) */
  debugErrors?: boolean;
  /** GL-13 open question 3: report driver strings for VENDOR/RENDERER instead of the masked ones */
  unmaskedStrings?: boolean;
  /** request a robust-access context (GL-11, decision pending) */
  robustAccess?: boolean;
  /** logger for debug output (default console.warn) */
  log?: (msg: string) => void;
}

export interface ContextInfo {
  version: string;
  renderer: string;
  vendor: string;
  glsl: string;
  extensions: string[];
  robust: boolean;
  contextId: number;
}

/** The context whose native GL context is current on the JS thread. */
let currentCtx: Ctx | null = null;

/**
 * What a context's native side owns, held apart from the Ctx so a finalizer can free it after the Ctx is
 * collected: its EGL context id and the live GL names it created (key = kind * 2^32 + name), including the
 * emulated default framebuffer's. Shared-group objects (buffers, textures, programs, ...) outlive their EGL
 * context in the root share group, so they are deleted explicitly.
 */
interface NativeOwned {
  n: GlNatives;
  id: number;
  live: Set<number>;
}
const NAME_SPAN = 4294967296;

/** WebGL objects have no own enumerable properties in browsers: hide the binding's bookkeeping fields. */
export function hideInternals(o: object): void {
  for (const k of Object.keys(o)) Object.defineProperty(o, k, { enumerable: false });
}

function deleteName(n: GlNatives, kind: number, name: number): void {
  switch (kind) {
    case enumKind.buffer:
      return n.deleteBuffer(name);
    case enumKind.texture:
      return n.deleteTexture(name);
    case enumKind.framebuffer:
      return n.deleteFramebuffer(name);
    case enumKind.renderbuffer:
      return n.deleteRenderbuffer(name);
    case enumKind.program:
      return n.deleteProgram(name);
    case enumKind.shader:
      return n.deleteShader(name);
    case enumKind.vertexArray:
      return n.deleteVertexArray(name);
    case enumKind.query:
      return n.deleteQuery(name);
    case enumKind.sampler:
      return n.deleteSampler(name);
    case enumKind.transformFeedback:
      return n.deleteTransformFeedback(name);
    case enumKind.sync:
      return n.deleteSync(name);
  }
}

/** Delete every live name of a context, then its EGL context (loss, or the Ctx was garbage-collected). */
function freeNative(o: NativeOwned): void {
  ownedAll.delete(o);
  if (!o.id) return;
  const n = o.n;
  if (n.contextMakeCurrent(o.id)) {
    for (const key of o.live) deleteName(n, Math.floor(key / NAME_SPAN), key % NAME_SPAN);
  }
  o.live.clear();
  n.contextDestroy(o.id);
  o.id = 0;
  if (currentCtx !== null && currentCtx._native === o) currentCtx = null;
  else if (currentCtx !== null) currentCtx._makeCurrent();
}

/** Native sides of every context not freed yet (page teardown frees them all: releaseAllContexts). */
const ownedAll = new Set<NativeOwned>();

/**
 * Page teardown (the runtime's `pagehide` before location.reload / exit): finalizers never run for a disposed
 * realm, and the WebGL objects live in the root share group, which outlives the page's EGL contexts. Delete every
 * context's GL names and destroy its EGL context now; the contexts read as lost afterwards.
 */
export function releaseAllContexts(): number {
  let freed = 0;
  for (const ref of liveContexts) {
    const c = ref.deref();
    if (c) c._lost = true;
  }
  for (const o of [...ownedAll]) {
    if (o.id) freed++;
    freeNative(o);
  }
  return freed;
}

const FR_ = (globalThis as { FinalizationRegistry?: typeof FinalizationRegistry }).FinalizationRegistry;
/** Contexts dropped by the page (canvas collected) release their native side. */
const ctxRegistry = FR_ ? new FR_<NativeOwned>((o) => freeNative(o)) : null;
/** Task epoch (GL-15): results become visible to JS only after the epoch advances. */
let epoch = 1;
let epochScheduled = false;

const liveContexts = new Set<WeakRef<Ctx>>();

/**
 * Composite boundary (after window rAF callbacks; the runtime calls it through host.afterAnimationFrame):
 * a canvas drawn during the frame is "presented", so its drawing buffer will be cleared before its next use
 * unless preserveDrawingBuffer is set. Nothing is displayed; only the semantics are kept. As in browsers, a
 * canvas that is not in the document (isConnected === false: created and never appended, or removed) is not
 * composited, so its drawing buffer keeps its contents (conformance textures/webgl_canvas relies on this).
 */
export function compositeAll(): void {
  for (const ref of liveContexts) {
    const c = ref.deref();
    if (!c) {
      liveContexts.delete(ref);
      continue;
    }
    const offDocument = (c._canvas as { isConnected?: boolean }).isConnected === false;
    if (c._dfbDrawn && !c._attrs.preserveDrawingBuffer && !offDocument) c._dfbNeedsClear = true;
    c._dfbDrawn = false;
  }
}

/** The longest-living context over natives `n` that still owns a native context (other than `except`). */
function oldestLiveContext(except: Ctx, n: GlNatives): Ctx | null {
  for (const ref of liveContexts) {
    const c = ref.deref();
    if (!c) {
      liveContexts.delete(ref);
      continue;
    }
    if (c !== except && !c._lost && c._n === n) return c;
  }
  return null;
}

export function advanceEpoch(): void {
  epoch++;
  epochScheduled = false;
}
export function currentEpoch(): number {
  return epoch;
}
function scheduleEpoch(): void {
  if (epochScheduled) return;
  epochScheduled = true;
  const st = (globalThis as { setTimeout?: (f: () => void, t: number) => unknown }).setTimeout;
  if (st) st(advanceEpoch, 0);
}

const MAX_DEBUG_LOGS = 32;
/** Largest drawing buffer side (memory on a headset: the canvas is never displayed). */
const MAX_DRAWING_BUFFER = 4096;
/** Context generation: objects created before a context loss stay invalid after the restore (GL-4). */
let generation = 1;
/** GLES-only enum (not exposed by WebGL): WebGL 2 keeps it enabled. */
const GL_PRIMITIVE_RESTART_FIXED_INDEX = 0x8d69;

export const CAP_INDEX: Record<number, number> = {
  [E.BLEND]: 0,
  [E.CULL_FACE]: 1,
  [E.DEPTH_TEST]: 2,
  [E.DITHER]: 3,
  [E.POLYGON_OFFSET_FILL]: 4,
  [E.SAMPLE_ALPHA_TO_COVERAGE]: 5,
  [E.SAMPLE_COVERAGE]: 6,
  [E.SCISSOR_TEST]: 7,
  [E.STENCIL_TEST]: 8,
  [E.RASTERIZER_DISCARD]: 9,
};

export class Ctx {
  // --- identity ---------------------------------------------------------------------------------------------
  _n!: GlNatives;
  _v2!: boolean;
  /** generation of this context incarnation (restores bump it) */
  _gen!: number;
  _id!: number;
  _canvas!: CanvasLike;
  _attrs!: ContextAttributes;
  _opts!: ContextOptions;
  _info!: ContextInfo;
  _driverExt!: Set<string>;
  // --- errors / loss ------------------------------------------------------------------------------------------
  /** pending WebGL errors, oldest first, each code once (GL-9) */
  _errs!: number[];
  _lost!: boolean;
  _lostErrPending!: boolean;
  _restoreAllowed!: boolean;
  _debugLogs!: number;
  // --- limits (queried once) -------------------------------------------------------------------------------
  _maxAttribs!: number;
  _maxUnits!: number;
  _maxDrawBuffers!: number;
  _maxColorAttachments!: number;
  _maxUboBindings!: number;
  _maxTfBuffers!: number;
  _limitCache!: Map<number, unknown>;
  // --- bindings -----------------------------------------------------------------------------------------------
  _arrayBuffer!: WebGLBuffer | null;
  _copyRead!: WebGLBuffer | null;
  _copyWrite!: WebGLBuffer | null;
  _pixelPack!: WebGLBuffer | null;
  _pixelUnpack!: WebGLBuffer | null;
  _uniformBuffer!: WebGLBuffer | null;
  _tfBuffer!: WebGLBuffer | null;
  _uboBindings!: (WebGLBuffer | null)[];
  _uboRanges!: Float64Array;
  _defaultVao!: WebGLVertexArrayObject;
  _vao!: WebGLVertexArrayObject;
  _defaultTf!: WebGLTransformFeedback;
  /** transform feedback objects with a capture in progress (bound or not, paused or not) */
  _activeTfs = new Set<WebGLTransformFeedback>();
  _tf!: WebGLTransformFeedback;
  _program!: WebGLProgram | null;
  _activeUnit!: number;
  _tex2D!: (WebGLTexture | null)[];
  _texCube!: (WebGLTexture | null)[];
  _tex3D!: (WebGLTexture | null)[];
  _tex2DArray!: (WebGLTexture | null)[];
  _samplers!: (WebGLSampler | null)[];
  _drawFbo!: WebGLFramebuffer | null;
  _readFbo!: WebGLFramebuffer | null;
  _renderbuffer!: WebGLRenderbuffer | null;
  _activeQueries!: Map<number, WebGLQuery>;
  // --- cached state (GL-PERF-2) ------------------------------------------------------------------------------
  _caps!: Uint8Array;
  _viewport!: Int32Array;
  _scissor!: Int32Array;
  _clearColor!: Float32Array;
  _clearDepth!: number;
  _clearStencil!: number;
  _colorMask!: Uint8Array;
  /** OES_draw_buffers_indexed: bits (extensions.ts IDX_*) of global state that may differ per draw buffer */
  _idxDiverged = 0;
  /** draw buffers whose colour write mask has any channel on (bit per buffer; colorMask / colorMaskiOES) */
  _bufMaskOn = 0xffff;
  /** bit i: draw buffer i has a colour mask that is neither all on nor all off */
  _bufMaskPartial = 0;
  /** does the driver clamp BLEND_COLOR on store (-1 = not known yet; Adreno does, ES 3.2 allows either) */
  _blendColorClamps = -1;
  _depthMask!: boolean;
  _depthFunc!: number;
  _depthRange!: Float32Array;
  _blendColor!: Float32Array;
  /** [rgb, alpha] */
  _blendEq!: Uint32Array;
  /** [srcRGB, dstRGB, srcAlpha, dstAlpha] */
  _blendFunc!: Uint32Array;
  _cullFace!: number;
  _frontFace!: number;
  _lineWidth!: number;
  _polygonOffset!: Float32Array;
  /** EXT_polygon_offset_clamp clamp (polygonOffset sets it to 0) */
  _polygonOffsetClamp = 0;
  /** EXT_clip_control [origin, depth mode] */
  _clipControl!: Uint32Array;
  /** WEBGL_polygon_mode mode (FRONT_AND_BACK) */
  _polygonMode = 0;
  _sampleCoverageValue!: number;
  _sampleCoverageInvert!: boolean;
  /** [func, ref, mask] front, back */
  _stencilFuncF!: Int32Array;
  _stencilFuncB!: Int32Array;
  _stencilMaskF!: number;
  _stencilMaskB!: number;
  /** [fail, zfail, zpass] front, back */
  _stencilOpF!: Uint32Array;
  _stencilOpB!: Uint32Array;
  _hints!: Map<number, number>;
  /** front/back stencil ref, value mask or writemask differ (draw-time check, WebGL 1.0 §6.11) */
  _stencilMismatch!: boolean;
  /** pixel store: see PS_* indices in state.ts */
  _ps!: Int32Array;
  _flipY!: boolean;
  _premultiply!: boolean;
  _colorspaceConversion!: number;
  _drawingBufferColorSpace!: string;
  _unpackColorSpace!: string;
  // --- default framebuffer emulation ---------------------------------------------------------------------------
  _dfbName!: number;
  _dfbReady!: boolean;
  _dfbColor!: number;
  _dfbDepth!: number;
  _dfbResolve!: number;
  _dfbResolveColor!: number;
  _dfbWidth!: number;
  _dfbHeight!: number;
  _dfbSamples!: number;
  _dfbImplicitResolve!: boolean;
  /** WebGL default framebuffer draw buffer (BACK or NONE) */
  _dfbDrawBuffer!: number;
  /** drawn since the last composite boundary / cleared lazily after it (preserveDrawingBuffer: false) */
  _dfbDrawn!: boolean;
  _dfbNeedsClear!: boolean;
  _dfbReadBuffer!: number;
  // --- draw-time validation ---------------------------------------------------------------------------------
  /** bumped whenever framebuffer completeness may have changed (attachments, attached images, extensions) */
  _fbEpoch!: number;
  /** feedback-loop state must be recomputed before the next draw */
  _feedbackDirty!: boolean;
  /** draw-time texture checks (sampler/format compatibility, WebGL incompleteness) need recomputing */
  _texDirty!: boolean;
  /** the last texture check found an incompatible sampler/texture pair (draws record INVALID_OPERATION) */
  _texInvalid!: boolean;
  /** [unit, target, ...] that WebGL treats as incomplete but the driver would sample: bound to a black texture per draw */
  _texSubst!: number[];
  /** some texture has a format/size the checks care about (integer, depth, 32-bit float, WebGL 1 NPOT) */
  _texRiskSeen!: boolean;
  /** never-specified textures (incomplete: sample black) used as stand-ins, by target */
  _blackTex!: Map<number, number>;
  /** vertex attribute types vs program inputs must be rechecked before the next draw */
  _attribsDirty!: boolean;
  _attribsOk!: boolean;
  _feedbackLoop!: boolean;
  // --- extensions ------------------------------------------------------------------------------------------
  _extensions!: Map<string, object>;
  _enabledCompressed!: Set<number>;
  // --- lifetime ----------------------------------------------------------------------------------------------
  _registry!: FinalizationRegistry<readonly [number, number, number]> | null;
  /** native side owned by this context incarnation (freed on loss or when the Ctx is collected) */
  _native!: NativeOwned;
  // --- scratch typed arrays (no per-call allocation, GL-PERF-3) ------------------------------------------------
  _i32!: Int32Array;
  _u32!: Uint32Array;
  _f32!: Float32Array;
  _u8!: Uint8Array;
  _i64!: BigInt64Array;
  _f32Scratch!: Float32Array;
  _i32Scratch!: Int32Array;
  _u32Scratch!: Uint32Array;
  _hostHooks!: { onDelete?: (o: WebGLObject) => void } | null;

  /** Constructor is never called directly; see createContext(). */
  constructor(token: unknown) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
  }

  // ------------------------------------------------------------------------------------------- init

  _init(n: GlNatives, v2: boolean, canvas: CanvasLike, attrs: ContextAttributes, opts: ContextOptions): boolean {
    this._gen = generation++;
    this._n = n;
    this._v2 = v2;
    this._canvas = canvas;
    this._attrs = attrs;
    this._opts = opts;
    this._errs = [];
    this._lost = false;
    this._lostErrPending = false;
    this._restoreAllowed = false;
    this._debugLogs = 0;
    this._extensions = new Map();
    this._enabledCompressed = new Set();
    this._limitCache = new Map();
    this._hints = new Map();
    this._hostHooks = null;
    this._i32 = new Int32Array(16);
    this._u32 = new Uint32Array(16);
    this._f32 = new Float32Array(16);
    this._u8 = new Uint8Array(16);
    this._i64 = new BigInt64Array(2);
    this._f32Scratch = new Float32Array(256);
    this._i32Scratch = new Int32Array(256);
    this._u32Scratch = new Uint32Array(256);
    void this._i32.buffer, this._u32.buffer, this._f32.buffer, this._u8.buffer, this._i64.buffer;

    const req = new Int32Array([1, opts.robustAccess ? 1 : 0, 0, 0]);
    this._id = n.contextCreate(req, 0, req.byteLength);
    // Drivers cap live contexts per process (Adreno 740: about 57). Like browsers, lose the oldest live context
    // to make room for a new one instead of failing getContext.
    for (let tries = 0; !this._id && tries < 4; tries++) {
      const victim = oldestLiveContext(this, n);
      if (!victim) break;
      (opts.log ?? console.warn)('WebGL: too many active contexts; the oldest context was lost');
      victim._loseContext(false);
      this._id = n.contextCreate(req, 0, req.byteLength);
    }
    if (!this._id) return false;
    this._native = { n, id: this._id, live: new Set() };
    ownedAll.add(this._native);
    if (ctxRegistry) ctxRegistry.register(this, this._native, this);
    n.contextMakeCurrent(this._id);
    currentCtx = this;
    const info = n.contextInfo(this._id) as ContextInfo;
    this._info = info;
    this._driverExt = new Set(info.extensions);

    this._maxAttribs = this._getInt(E.MAX_VERTEX_ATTRIBS);
    this._maxUnits = this._getInt(E.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
    this._maxDrawBuffers = this._getInt(E.MAX_DRAW_BUFFERS);
    this._maxColorAttachments = this._getInt(E.MAX_COLOR_ATTACHMENTS);
    this._maxUboBindings = this._getInt(E.MAX_UNIFORM_BUFFER_BINDINGS);
    this._maxTfBuffers = this._getInt(E.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS);

    this._arrayBuffer = null;
    this._copyRead = null;
    this._copyWrite = null;
    this._pixelPack = null;
    this._pixelUnpack = null;
    this._uniformBuffer = null;
    this._tfBuffer = null;
    this._uboBindings = new Array(this._maxUboBindings).fill(null);
    this._uboRanges = new Float64Array(this._maxUboBindings * 2);
    this._defaultVao = new WebGLVertexArrayObject(INTERNAL, this, 0, this._maxAttribs);
    this._vao = this._defaultVao;
    this._defaultTf = new WebGLTransformFeedback(INTERNAL, this, 0, this._maxTfBuffers);
    this._tf = this._defaultTf;
    this._activeTfs = new Set();
    this._program = null;
    this._activeUnit = 0;
    this._tex2D = new Array(this._maxUnits).fill(null);
    this._texCube = new Array(this._maxUnits).fill(null);
    this._tex3D = new Array(this._maxUnits).fill(null);
    this._tex2DArray = new Array(this._maxUnits).fill(null);
    this._samplers = new Array(this._maxUnits).fill(null);
    this._drawFbo = null;
    this._readFbo = null;
    this._renderbuffer = null;
    this._activeQueries = new Map();

    this._caps = new Uint8Array(10);
    this._caps[CAP_INDEX[E.DITHER]] = 1;
    const w = this._canvasWidth();
    const h = this._canvasHeight();
    this._viewport = new Int32Array([0, 0, w, h]);
    this._scissor = new Int32Array([0, 0, w, h]);
    this._clearColor = new Float32Array(4);
    this._clearDepth = 1;
    this._clearStencil = 0;
    this._colorMask = new Uint8Array([1, 1, 1, 1]);
    this._idxDiverged = 0;
    this._bufMaskOn = 0xffff;
    this._bufMaskPartial = 0;
    this._blendColorClamps = -1;
    this._depthMask = true;
    this._depthFunc = E.LESS;
    this._depthRange = new Float32Array([0, 1]);
    this._blendColor = new Float32Array(4);
    this._blendEq = new Uint32Array([E.FUNC_ADD, E.FUNC_ADD]);
    this._blendFunc = new Uint32Array([E.ONE, E.ZERO, E.ONE, E.ZERO]);
    this._cullFace = E.BACK;
    this._frontFace = E.CCW;
    this._lineWidth = 1;
    this._polygonOffset = new Float32Array(2);
    this._polygonOffsetClamp = 0;
    this._clipControl = new Uint32Array([E.LOWER_LEFT_EXT, E.NEGATIVE_ONE_TO_ONE_EXT]);
    this._polygonMode = E.FILL_WEBGL;
    this._sampleCoverageValue = 1;
    this._sampleCoverageInvert = false;
    // Adreno's initial SAMPLE_COVERAGE_VALUE is not the GLES default 1.0 (coverage-enabled draws drew nothing until
    // sampleCoverage was called; CTS multisample-with-full-sample-counts): make the driver match the cache.
    n.sampleCoverage(1, false);
    this._stencilFuncF = new Int32Array([E.ALWAYS, 0, -1]);
    this._stencilFuncB = new Int32Array([E.ALWAYS, 0, -1]);
    this._stencilMaskF = -1;
    this._stencilMaskB = -1;
    this._stencilOpF = new Uint32Array([E.KEEP, E.KEEP, E.KEEP]);
    this._stencilOpB = new Uint32Array([E.KEEP, E.KEEP, E.KEEP]);
    this._stencilMismatch = false;
    // PS_*: pack alignment, unpack alignment, unpack row length, unpack image height, unpack skip pixels,
    // unpack skip rows, unpack skip images, pack row length, pack skip pixels, pack skip rows
    this._ps = new Int32Array([4, 4, 0, 0, 0, 0, 0, 0, 0, 0]);
    this._flipY = false;
    this._premultiply = false;
    this._colorspaceConversion = E.BROWSER_DEFAULT_WEBGL;
    this._drawingBufferColorSpace = 'srgb';
    this._unpackColorSpace = 'srgb';

    this._feedbackDirty = true;
    this._texDirty = true;
    this._texInvalid = false;
    this._texSubst = [];
    this._texRiskSeen = false;
    this._blackTex = new Map();
    this._feedbackLoop = false;
    this._fbEpoch = 1;
    this._attribsDirty = true;
    this._attribsOk = true;

    // Emulated default framebuffer (the canvas is never composited; storage allocated on first use).
    this._dfbName = n.genFramebuffer();
    this._liveAdd(enumKind.framebuffer, this._dfbName);
    this._dfbReady = false;
    this._dfbColor = 0;
    this._dfbDepth = 0;
    this._dfbResolve = 0;
    this._dfbResolveColor = 0;
    this._dfbWidth = 0;
    this._dfbHeight = 0;
    this._dfbSamples = 0;
    this._dfbImplicitResolve = false;
    this._dfbDrawBuffer = E.BACK;
    this._dfbReadBuffer = E.BACK;
    this._dfbDrawn = false;
    this._dfbNeedsClear = false;
    liveContexts.add(new WeakRef(this));
    n.bindFramebuffer(E.FRAMEBUFFER, this._dfbName);
    n.viewport(0, 0, w, h);
    n.scissor(0, 0, w, h);
    // WebGL 2: primitive restart with the fixed index is always on (WebGL 2.0 §5.18).
    if (v2) n.enable(GL_PRIMITIVE_RESTART_FIXED_INDEX);

    const FR = (globalThis as { FinalizationRegistry?: typeof FinalizationRegistry }).FinalizationRegistry;
    // Held values carry the incarnation: after a restore, callbacks for the lost incarnation's wrappers are
    // ignored (their names were freed with it and may be reused by the new context).
    this._registry = FR ? new FR<readonly [number, number, number]>((held) => this._release(held[0], held[1], held[2])) : null;
    // Internal state is not part of the WebGL surface: keep it out of property enumeration.
    for (const k of Object.keys(this)) Object.defineProperty(this, k, { enumerable: false });
    return true;
  }

  /**
   * Drawing buffer size: the canvas size, scaled down (aspect kept) to fit MAX_DRAWING_BUFFER on each side,
   * as browsers clamp oversized canvases (drawingBufferWidth/Height report the result).
   */
  _canvasWidth(): number {
    const w = this._canvas.width;
    const h = this._canvas.height;
    const cw = Number.isFinite(w) && w > 0 ? Math.floor(w) : 1;
    const ch = Number.isFinite(h) && h > 0 ? Math.floor(h) : 1;
    const s = Math.min(1, MAX_DRAWING_BUFFER / cw, MAX_DRAWING_BUFFER / ch);
    return Math.max(1, Math.floor(cw * s));
  }
  _canvasHeight(): number {
    const w = this._canvas.width;
    const h = this._canvas.height;
    const cw = Number.isFinite(w) && w > 0 ? Math.floor(w) : 1;
    const ch = Number.isFinite(h) && h > 0 ? Math.floor(h) : 1;
    const s = Math.min(1, MAX_DRAWING_BUFFER / cw, MAX_DRAWING_BUFFER / ch);
    return Math.max(1, Math.floor(ch * s));
  }

  // ------------------------------------------------------------------------------------------- current context

  /** Lost-context check + make this context current. Returns true if the call must do nothing. */
  _skip(): boolean {
    if (this._lost) return true;
    if (currentCtx !== this) this._makeCurrent();
    return false;
  }

  _makeCurrent(): void {
    this._n.contextMakeCurrent(this._id);
    currentCtx = this;
  }

  // ------------------------------------------------------------------------------------------- errors

  /**
   * Record a WebGL error (GL-9). Errors are reported oldest first: before the first binding-raised error is
   * queued, one glGetError collects an earlier driver error (a driver round trip only on error paths, GL-10).
   */
  _e(code: number, what?: string): void {
    const q = this._errs;
    if (q.length === 0 && !this._lost) {
      this._skip();
      const d = this._n.getError();
      if (d !== 0) q.push(d);
    }
    if (!q.includes(code)) q.push(code);
    if (this._opts.debugErrors && this._debugLogs < MAX_DEBUG_LOGS) {
      this._debugLogs++;
      const stack = new Error().stack?.split('\n').slice(2, 7).join('\n') ?? '';
      (this._opts.log ?? console.warn)(`WebGL: ${errorName(code)}${what ? ` in ${what}` : ''}\n${stack}`);
    }
  }

  // ------------------------------------------------------------------------------------------- objects

  /** DirectHost._nm: name of a WebGL object argument, -1 after recording INVALID_OPERATION. */
  _nm(value: unknown, kind: number, nullable: boolean): number {
    if (value === null || value === undefined) {
      if (nullable) return 0;
      throw new TypeError('Argument is not a WebGL object');
    }
    const cls = CLASS_OF_KIND[kind];
    if (!(value instanceof cls)) throw new TypeError(`Argument is not a ${cls.name}`);
    const o = value as WebGLObject;
    if (o._ctx !== this || o._gen !== this._gen || o._deleted) {
      this._e(E.INVALID_OPERATION);
      return -1;
    }
    return o._name;
  }

  /**
   * Validate an object argument: TypeError for a wrong type, INVALID_OPERATION (recorded, returns false) for
   * an object of another context or one already deleted. null passes when nullable.
   */
  _ok(value: unknown, cls: Function, nullable: boolean, what: string): boolean {
    if (value === null || value === undefined) {
      if (nullable) return true;
      throw new TypeError(`${what}: argument is not a ${cls.name}`);
    }
    if (!(value instanceof cls)) throw new TypeError(`${what}: argument is not a ${cls.name}`);
    const o = value as WebGLObject;
    if (o._ctx !== this || o._gen !== this._gen) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    if (o._deleted && !this._inUse(o)) {
      // WebGL: a deleted program / shader argument is INVALID_VALUE; binding / attaching a deleted object is
      // INVALID_OPERATION.
      const programOrShader = o instanceof WebGLProgram || o instanceof WebGLShader;
      this._e(programOrShader ? E.INVALID_VALUE : E.INVALID_OPERATION, what);
      return false;
    }
    return true;
  }

  /** Objects flagged for deletion stay valid while in use: the current program, attached shaders. */
  _inUse(o: WebGLObject): boolean {
    if (o instanceof WebGLProgram) return this._program === o || this._tf._program === o;
    if (o instanceof WebGLShader) return o._attachCount > 0;
    return false;
  }

  /** Same as _ok but deleted objects are fine (delete* / is* semantics). */
  _owned(value: unknown, cls: Function, what: string): boolean {
    if (value === null || value === undefined) return false;
    if (!(value instanceof cls)) throw new TypeError(`${what}: argument is not a ${cls.name}`);
    if ((value as WebGLObject)._ctx !== this || (value as WebGLObject)._gen !== this._gen) {
      this._e(E.INVALID_OPERATION, what);
      return false;
    }
    return true;
  }

  _track(o: WebGLObject): void {
    hideInternals(o);
    if (!o._name) return;
    this._liveAdd(o._kind, o._name);
    if (this._registry) this._registry.register(o, [o._kind, o._name, this._gen] as const, o);
  }
  /** Explicit deleteX(): the name is no longer owned by the wrapper. */
  _untrack(o: WebGLObject): void {
    if (o._gen === this._gen) this._native.live.delete(o._kind * NAME_SPAN + o._name);
    if (this._registry) this._registry.unregister(o);
  }
  _liveAdd(kind: number, name: number): void {
    if (name) this._native.live.add(kind * NAME_SPAN + name);
  }

  /** A wrapper was garbage-collected without deleteX(): release its GL name. */
  _release(kind: number, name: number, gen: number): void {
    if (this._lost || !name || gen !== this._gen) return;
    if (!this._native.live.delete(kind * NAME_SPAN + name)) return;
    if (currentCtx !== this) this._makeCurrent();
    deleteName(this._n, kind, name);
  }

  // ------------------------------------------------------------------------------------------- epochs (GL-15)

  _epoch(): number {
    return epoch;
  }
  _scheduleEpoch(): void {
    scheduleEpoch();
  }

  // ------------------------------------------------------------------------------------------- native queries

  _getInt(pname: number): number {
    const a = this._i32;
    a[0] = 0;
    this._n.getIntegerv(pname, a, 0, 4);
    return a[0];
  }
  _getLimit(pname: number): number {
    let v = this._limitCache.get(pname) as number | undefined;
    if (v === undefined) {
      v = this._getInt(pname);
      // OVR_multiview2: report at most 4 views, as Chrome (ANGLE) does. Mesa and Adreno report 6, and the CTS
      // multiview strip tests (ovr_multiview2_instanced_draw / _draw_buffers) assume 256 / (2 * views) is whole.
      if (pname === E.MAX_VIEWS_OVR && v > 4) v = 4;
      this._limitCache.set(pname, v);
    }
    return v;
  }

  // ------------------------------------------------------------------------------------------- default framebuffer

  /** Allocate (or resize) the emulated default framebuffer's storage. Called before it is drawn or read. */
  _ensureDefaultFramebuffer(): void {
    const w = this._canvasWidth();
    const h = this._canvasHeight();
    if (this._dfbReady && w === this._dfbWidth && h === this._dfbHeight) {
      if (this._dfbNeedsClear) this._implicitClear();
      return;
    }
    this._dfbNeedsClear = false; // fresh storage is cleared below
    const n = this._n;
    const a = this._attrs;
    const msrtt = a.antialias && this._driverExt.has('GL_EXT_multisampled_render_to_texture');
    const samples = a.antialias ? Math.min(4, this._getLimit(E.MAX_SAMPLES)) : 0;
    if (!this._dfbColor) this._liveAdd(enumKind.renderbuffer, (this._dfbColor = n.genRenderbuffer()));
    const colorFormat = a.alpha ? E.RGBA8 : E.RGB8;
    n.bindRenderbuffer(E.RENDERBUFFER, this._dfbColor);
    if (samples && msrtt) n.renderbufferStorageMultisampleEXT(E.RENDERBUFFER, samples, colorFormat, w, h);
    else if (samples) n.renderbufferStorageMultisample(E.RENDERBUFFER, samples, colorFormat, w, h);
    else n.renderbufferStorage(E.RENDERBUFFER, colorFormat, w, h);
    const depthFormat = a.stencil ? E.DEPTH24_STENCIL8 : a.depth ? E.DEPTH_COMPONENT24 : 0;
    if (depthFormat) {
      if (!this._dfbDepth) this._liveAdd(enumKind.renderbuffer, (this._dfbDepth = n.genRenderbuffer()));
      n.bindRenderbuffer(E.RENDERBUFFER, this._dfbDepth);
      if (samples && msrtt) n.renderbufferStorageMultisampleEXT(E.RENDERBUFFER, samples, depthFormat, w, h);
      else if (samples) n.renderbufferStorageMultisample(E.RENDERBUFFER, samples, depthFormat, w, h);
      else n.renderbufferStorage(E.RENDERBUFFER, depthFormat, w, h);
    }
    n.bindRenderbuffer(E.RENDERBUFFER, this._renderbuffer ? this._renderbuffer._name : 0);
    n.bindFramebuffer(E.FRAMEBUFFER, this._dfbName);
    n.framebufferRenderbuffer(E.FRAMEBUFFER, E.COLOR_ATTACHMENT0, E.RENDERBUFFER, this._dfbColor);
    if (depthFormat) {
      const att = a.stencil ? E.DEPTH_STENCIL_ATTACHMENT : E.DEPTH_ATTACHMENT;
      n.framebufferRenderbuffer(E.FRAMEBUFFER, att, E.RENDERBUFFER, this._dfbDepth);
    }
    // zero-initialise (GL-3) and give the canvas its cleared look
    n.clearRenderbuffer(this._dfbColor, colorFormat);
    if (depthFormat) n.clearRenderbuffer(this._dfbDepth, depthFormat);
    if (samples && !msrtt) {
      if (!this._dfbResolve) this._liveAdd(enumKind.framebuffer, (this._dfbResolve = n.genFramebuffer()));
      if (!this._dfbResolveColor) this._liveAdd(enumKind.renderbuffer, (this._dfbResolveColor = n.genRenderbuffer()));
      n.bindRenderbuffer(E.RENDERBUFFER, this._dfbResolveColor);
      n.renderbufferStorage(E.RENDERBUFFER, colorFormat, w, h);
      n.bindRenderbuffer(E.RENDERBUFFER, this._renderbuffer ? this._renderbuffer._name : 0);
      n.bindFramebuffer(E.FRAMEBUFFER, this._dfbResolve);
      n.framebufferRenderbuffer(E.FRAMEBUFFER, E.COLOR_ATTACHMENT0, E.RENDERBUFFER, this._dfbResolveColor);
    }
    this._dfbSamples = samples;
    this._dfbImplicitResolve = msrtt;
    this._dfbWidth = w;
    this._dfbHeight = h;
    this._dfbReady = true;
    this._restoreFramebufferBindings();
  }

  /**
   * The drawing buffer after a composite (preserveDrawingBuffer: false): cleared to its defaults (colour 0,
   * depth 1, stencil 0) before its next use, regardless of scissor, masks and rasterizer discard (WebGL 1.0
   * §2.2). Runs only for contexts that drew to their canvas in the previous frame.
   */
  _implicitClear(): void {
    this._dfbNeedsClear = false;
    const n = this._n;
    const c = this._caps;
    n.bindFramebuffer(E.DRAW_FRAMEBUFFER, this._dfbName);
    if (c[7] === 1) n.disable(E.SCISSOR_TEST);
    if (c[9] === 1) n.disable(E.RASTERIZER_DISCARD);
    // Only draw buffer 0 is cleared: touch only its mask when masks differ per buffer.
    const perBuffer = (this._idxDiverged & 8) !== 0;
    if (perBuffer) n.colorMaskiOES(0, true, true, true, true);
    else n.colorMask(true, true, true, true);
    n.depthMask(true);
    n.stencilMaskSeparate(E.FRONT_AND_BACK, 0xffffffff);
    const z = this._f32;
    z[0] = z[1] = z[2] = z[3] = 0;
    if (this._dfbDrawBuffer !== E.BACK) {
      this._u32[0] = E.COLOR_ATTACHMENT0;
      n.drawBuffers(1, this._u32, 0, 4);
    }
    n.clearBufferfv(E.COLOR, 0, z, 0, 16);
    if (this._attrs.stencil) n.clearBufferfi(E.DEPTH_STENCIL, 0, 1, 0);
    else if (this._attrs.depth) {
      z[0] = 1;
      n.clearBufferfv(E.DEPTH, 0, z, 0, 4);
    }
    if (this._dfbDrawBuffer !== E.BACK) {
      this._u32[0] = E.NONE;
      n.drawBuffers(1, this._u32, 0, 4);
    }
    const m = this._colorMask;
    if (perBuffer) n.colorMaskiOES(0, m[0] === 1, m[1] === 1, m[2] === 1, m[3] === 1);
    else n.colorMask(m[0] === 1, m[1] === 1, m[2] === 1, m[3] === 1);
    n.depthMask(this._depthMask);
    n.stencilMaskSeparate(E.FRONT, this._stencilMaskF >>> 0);
    n.stencilMaskSeparate(E.BACK, this._stencilMaskB >>> 0);
    if (c[7] === 1) n.enable(E.SCISSOR_TEST);
    if (c[9] === 1) n.enable(E.RASTERIZER_DISCARD);
    this._restoreFramebufferBindings();
  }

  _restoreFramebufferBindings(): void {
    const n = this._n;
    const d = this._drawFbo ? this._drawFbo._name : this._dfbName;
    const r = this._readFbo ? this._readFbo._name : this._dfbName;
    if (d === r) n.bindFramebuffer(E.FRAMEBUFFER, d);
    else {
      n.bindFramebuffer(E.DRAW_FRAMEBUFFER, d);
      n.bindFramebuffer(E.READ_FRAMEBUFFER, r);
    }
  }

  /**
   * Before reading from the default framebuffer when it is multisampled without implicit resolve: resolve
   * into the single-sampled copy and bind it as the read framebuffer. Returns true if the caller must call
   * _restoreFramebufferBindings() afterwards.
   */
  _prepareDefaultRead(): boolean {
    if (this._readFbo !== null) return false;
    this._ensureDefaultFramebuffer();
    if (!this._dfbSamples || this._dfbImplicitResolve) return false;
    const n = this._n;
    const w = this._dfbWidth;
    const h = this._dfbHeight;
    n.bindFramebuffer(E.READ_FRAMEBUFFER, this._dfbName);
    n.bindFramebuffer(E.DRAW_FRAMEBUFFER, this._dfbResolve);
    const scissor = this._caps[CAP_INDEX[E.SCISSOR_TEST]];
    if (scissor) n.disable(E.SCISSOR_TEST);
    n.blitFramebuffer(0, 0, w, h, 0, 0, w, h, E.COLOR_BUFFER_BIT, E.NEAREST);
    if (scissor) n.enable(E.SCISSOR_TEST);
    n.bindFramebuffer(E.READ_FRAMEBUFFER, this._dfbResolve);
    n.bindFramebuffer(E.DRAW_FRAMEBUFFER, this._drawFbo ? this._drawFbo._name : this._dfbName);
    return true;
  }

  // ------------------------------------------------------------------------------------------- loss (GL-4)

  _loseContext(simulated: boolean): void {
    if (this._lost) return;
    this._lost = true;
    this._lostErrPending = true;
    this._errs = [];
    this._restoreAllowed = false;
    // Free the lost incarnation's GL objects and EGL context now (a browser drops them on loss too); a restore
    // creates a new context.
    if (ctxRegistry) ctxRegistry.unregister(this);
    freeNative(this._native);
    const fire = (): void => {
      const ev = makeContextEvent('webglcontextlost', true);
      const notCancelled = this._canvas.dispatchEvent ? this._canvas.dispatchEvent(ev) : true;
      // The page cancels the event to say it wants a restore.
      this._restoreAllowed = !notCancelled || (ev as { defaultPrevented?: boolean }).defaultPrevented === true;
    };
    queueTask(fire);
    void simulated;
  }

  _restoreContext(): void {
    if (!this._lost) return;
    queueTask(() => {
      if (!this._restoreAllowed) return;
      const ok = this._init(this._n, this._v2, this._canvas, this._attrs, this._opts);
      if (!ok) return;
      this._canvas.dispatchEvent?.(makeContextEvent('webglcontextrestored', false));
    });
  }

  /** Real device loss check (robust contexts): call at frame boundaries. */
  _checkReset(): void {
    if (this._lost || !this._info.robust) return;
    const status = this._n.contextResetStatus(this._id);
    currentCtx = null; // the native query may make this context current: re-bind on the next call
    if (status !== 0) {
      (this._opts.log ?? console.warn)('WebGL: GPU reset reported by the driver; context lost');
      this._loseContext(false);
    }
  }
}

/** Internal helpers implemented in the method modules and installed on Ctx.prototype by install.ts. */
export interface Ctx {
  _capAllowed(cap: number): boolean;
  _capExt(cap: number, on: boolean): void;
  _detachFromBound(obj: WebGLObject): void;
  _readSize(): [number, number];
  _readFeedback(tex: WebGLTexture, level: number): boolean;
  _programRecord(p: WebGLProgram): import('./reflection.ts').ProgramRecord | null;
  _drawCheck(mode: number, what: string): boolean;
  _computeFeedback(): void;
  _elementsCheck(count: number, type: number, offset: number, what: string): boolean;
  _framebufferTextureMultiview(
    target: number,
    attachment: number,
    texture: WebGLTexture | null,
    level: number,
    samples: number,
    baseViewIndex: number,
    numViews: number,
    what: string,
  ): void;
  _framebufferTexture2DMultisample(
    target: number,
    attachment: number,
    textarget: number,
    texture: WebGLTexture | null,
    level: number,
    samples: number,
  ): void;
  _renderbufferStorageMultisampleEXT(target: number, samples: number, internalformat: number, width: number, height: number): void;
}

export function errorName(code: number): string {
  switch (code) {
    case E.INVALID_ENUM:
      return 'INVALID_ENUM';
    case E.INVALID_VALUE:
      return 'INVALID_VALUE';
    case E.INVALID_OPERATION:
      return 'INVALID_OPERATION';
    case E.INVALID_FRAMEBUFFER_OPERATION:
      return 'INVALID_FRAMEBUFFER_OPERATION';
    case E.OUT_OF_MEMORY:
      return 'OUT_OF_MEMORY';
    case E.CONTEXT_LOST_WEBGL:
      return 'CONTEXT_LOST_WEBGL';
    default:
      return `0x${code.toString(16)}`;
  }
}

function queueTask(fn: () => void): void {
  const st = (globalThis as { setTimeout?: (f: () => void, t: number) => unknown }).setTimeout;
  if (st) st(fn, 0);
  else Promise.resolve().then(fn);
}

/** WebGLContextEvent (installed on the global by install.ts; falls back to a plain object). */
export function makeContextEvent(type: string, cancelable: boolean): unknown {
  const C = (globalThis as { WebGLContextEvent?: new (t: string, i: object) => unknown }).WebGLContextEvent;
  if (C) {
    try {
      return new C(type, { cancelable, statusMessage: '' });
    } catch {
      /* fall through */
    }
  }
  return { type, cancelable, statusMessage: '', defaultPrevented: false, preventDefault() { (this as { defaultPrevented: boolean }).defaultPrevented = true; } };
}

export { WebGLBuffer, WebGLFramebuffer, WebGLProgram, WebGLRenderbuffer, WebGLShader, WebGLTexture };
