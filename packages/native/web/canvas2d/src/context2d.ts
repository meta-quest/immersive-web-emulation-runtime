/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CanvasRenderingContext2D / OffscreenCanvasRenderingContext2D (HTML §4.12.5.1), over the native raster core.
 * This layer owns the spec semantics: attribute validation (invalid values are ignored), the state stack, the
 * current default path (device space), argument handling for every overload, and errors. Rasterising,
 * compositing, clipping and text shaping are native.
 *
 * Spec IDs: C2D-4 (state, transforms, compositing, smoothing, filter logging), C2D-5 (pixels, drawImage),
 * C2D-6 (paths, fills, colours, gradients, patterns), C2D-7 (strokes, dashes), C2D-8 (text, TextMetrics),
 * C2D-12 (no per-call allocations: the state block and path buffers are reused), C2D-13 (unimplemented
 * methods throw), IMG-5 (ImageData).
 */

import { parseColor, type RGBA, serializeColor } from './color.ts';
import { domException, warnOnce } from './errors.ts';
import {
  DEFAULT_FONT_SIZE,
  parseFont,
  type ParsedFont,
  serializeFont,
  spacingFor,
  spacingPx,
  type SpacingValue,
} from './font.ts';
import { getFontRuntime } from './fonts.ts';
import { from2DInit, invert, makeDOMMatrix } from './matrix.ts';
import {
  type Canvas2DNatives,
  COMPOSITE_OPS,
  LINE_CAPS,
  LINE_JOINS,
  type NativeClip,
  type NativeFont,
  type NativeGradient,
  type NativePaint,
  type NativePattern,
  type NativeSurface,
  ST_COLOR,
  ST_COMPOSITE,
  ST_CTM,
  ST_DASH_OFFSET,
  ST_DIRECTION,
  ST_FILL_RULE,
  ST_GLOBAL_ALPHA,
  ST_LINE_CAP,
  ST_LINE_JOIN,
  ST_LINE_WIDTH,
  ST_MITER_LIMIT,
  ST_PAINT_KIND,
  ST_PATH_SPACE,
  ST_SHADOW_BLUR,
  ST_SHADOW_COLOR,
  ST_SHADOW_OFFSET_X,
  ST_SHADOW_OFFSET_Y,
  ST_SMOOTHING,
  ST_SMOOTHING_QUALITY,
  ST_TEXT_ALIGN,
  ST_TEXT_BASELINE,
  STATE_SIZE,
  TEXT_ALIGNS,
  TEXT_BASELINES,
  TEXT_METRICS_SIZE,
} from './natives.ts';
import { appendTransformed, parseSvgPath, PathBuilder } from './path.ts';
import { resolveImageSource, type ResolvedImage } from './sources.ts';

const INTERNAL = Symbol('canvas2d.internal');
const ARRAY_ITERATOR = Array.prototype[Symbol.iterator];

// --- ImageData (IMG-5) ------------------------------------------------------------------------------

export class ImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly colorSpace: 'srgb' | 'display-p3' = 'srgb';

  constructor(sw: number | Uint8ClampedArray, sh?: number | object, settingsOrSh?: unknown, settings?: unknown) {
    if (sw instanceof Uint8ClampedArray) {
      const data = sw;
      if (data.length === 0 || data.length % 4 !== 0) {
        throw domException('The input data has zero elements or is not a multiple of 4.', 'InvalidStateError');
      }
      const w = toUnsignedLong(sh, 'ImageData', 'sw');
      if (w === 0) throw domException('The source width is zero or not a number.', 'IndexSizeError');
      const pixels = data.length / 4;
      if (pixels % w !== 0) throw domException('The input data length is not a multiple of (4 * width).', 'IndexSizeError');
      const h = pixels / w;
      if (settingsOrSh !== undefined && typeof settingsOrSh !== 'object') {
        const given = toUnsignedLong(settingsOrSh, 'ImageData', 'sh');
        if (given !== h) throw domException('The input data length is not equal to (4 * width * height).', 'IndexSizeError');
      }
      this.width = w;
      this.height = h;
      this.data = data;
      readColorSpace(this, typeof settingsOrSh === 'object' ? settingsOrSh : settings);
      return;
    }
    if (arguments.length < 2) throw new TypeError("Failed to construct 'ImageData': 2 arguments required.");
    const w = toUnsignedLong(sw, 'ImageData', 'sw');
    const h = toUnsignedLong(sh, 'ImageData', 'sh');
    if (w === 0 || h === 0) throw domException('The source width or height is zero.', 'IndexSizeError');
    if (w * h * 4 > 2 ** 31 - 1) throw new RangeError('Out of memory at ImageData creation.');
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
    readColorSpace(this, settingsOrSh);
  }
}

function readColorSpace(img: ImageData, settings: unknown): void {
  if (settings && typeof settings === 'object' && 'colorSpace' in settings) {
    const cs = String((settings as { colorSpace: unknown }).colorSpace);
    if (cs !== 'srgb' && cs !== 'display-p3') throw new TypeError(`The provided value '${cs}' is not a valid enum value of type PredefinedColorSpace.`);
    (img as { colorSpace: string }).colorSpace = cs;
  }
}

/** WebIDL `unsigned long` (no [EnforceRange]): NaN and infinities convert to 0, others wrap modulo 2^32. */
function toUnsignedLong(v: unknown, _iface: string, _arg: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n) >>> 0;
}

function toLong(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n) | 0;
}

// Fixed-arity finiteness checks (no rest-argument arrays on hot paths, C2D-12).
// Arguments are numbers here (converted with + or Number()); x - x === 0 exactly when x is finite, and unlike
// Number.isFinite it never boxes a double in any JIT tier.
function finite2(a: number, b: number): boolean {
  return a - a === 0 && b - b === 0;
}
function finite4(a: number, b: number, c: number, d: number): boolean {
  return a - a === 0 && b - b === 0 && c - c === 0 && d - d === 0;
}

function requireFinite(method: string, ...v: number[]): void {
  for (const x of v) {
    if (!Number.isFinite(x)) throw new TypeError(`Failed to execute '${method}' on 'CanvasRenderingContext2D': The provided double value is non-finite.`);
  }
}

// --- Gradients, patterns, metrics ------------------------------------------------------------------

export class CanvasGradient {
  /** @internal */
  _native!: NativeGradient;
  /** @internal the shared fillStyle/strokeStyle object for this gradient */
  _style: Style | undefined;
  /** @internal */
  _n!: Canvas2DNatives;
  constructor(token?: unknown) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
  }
  addColorStop(offset: number, color: string): void {
    if (arguments.length < 2) throw new TypeError("Failed to execute 'addColorStop' on 'CanvasGradient': 2 arguments required.");
    const o = Number(offset);
    if (!Number.isFinite(o)) throw new TypeError("Failed to execute 'addColorStop' on 'CanvasGradient': The provided double value is non-finite.");
    if (o < 0 || o > 1) throw domException(`The provided value (${o}) is outside the range (0.0, 1.0).`, 'IndexSizeError');
    const c = parseColor(String(color));
    if (!c) throw domException(`The value provided ('${String(color)}') could not be parsed as a color.`, 'SyntaxError');
    this._n.addColorStop(this._native, o, c.r / 255, c.g / 255, c.b / 255, c.a / 255);
  }
}

export class CanvasPattern {
  /** @internal */
  _native!: NativePattern;
  /** @internal the shared fillStyle/strokeStyle object for this pattern */
  _style: Style | undefined;
  /** @internal */
  _n!: Canvas2DNatives;
  constructor(token?: unknown) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
  }
  setTransform(transform?: unknown): void {
    const m = from2DInit(transform);
    if (!m) return;
    this._n.setPatternTransform(this._native, m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!);
  }
}

export class TextMetrics {
  readonly width: number;
  readonly actualBoundingBoxLeft: number;
  readonly actualBoundingBoxRight: number;
  readonly fontBoundingBoxAscent: number;
  readonly fontBoundingBoxDescent: number;
  readonly actualBoundingBoxAscent: number;
  readonly actualBoundingBoxDescent: number;
  readonly emHeightAscent: number;
  readonly emHeightDescent: number;
  readonly hangingBaseline: number;
  readonly alphabeticBaseline: number;
  readonly ideographicBaseline: number;
  constructor(token: unknown, v: Float64Array) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this.width = v[0]!;
    this.actualBoundingBoxLeft = v[1]!;
    this.actualBoundingBoxRight = v[2]!;
    this.actualBoundingBoxAscent = v[3]!;
    this.actualBoundingBoxDescent = v[4]!;
    this.fontBoundingBoxAscent = v[5]!;
    this.fontBoundingBoxDescent = v[6]!;
    this.emHeightAscent = v[7]!;
    this.emHeightDescent = v[8]!;
    this.hangingBaseline = v[9]!;
    this.alphabeticBaseline = v[10]!;
    this.ideographicBaseline = v[11]!;
  }
}

// --- Path2D ----------------------------------------------------------------------------------------

export class Path2D {
  /** @internal */
  _p = new PathBuilder();

  constructor(path?: Path2D | string) {
    if (path instanceof Path2D) {
      this._p.appendRaw(path._p.buf, path._p.len);
      this._p.hasSubpath = path._p.hasSubpath;
      this._p.lastX = path._p.lastX;
      this._p.lastY = path._p.lastY;
      this._p.startX = path._p.startX;
      this._p.startY = path._p.startY;
    } else if (path !== undefined) {
      parseSvgPath(String(path), this._p);
    }
  }
  addPath(path: Path2D, transform?: unknown): void {
    if (!(path instanceof Path2D)) throw new TypeError("Failed to execute 'addPath' on 'Path2D': parameter 1 is not of type 'Path2D'.");
    const m = from2DInit(transform);
    if (!m) return;
    const identity = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
    appendTransformed(this._p, path._p, identity ? null : m);
  }
  closePath(): void {
    this._p.closePath();
  }
  moveTo(x: number, y: number): void {
    this._p.moveTo(+x, +y);
  }
  lineTo(x: number, y: number): void {
    this._p.lineTo(+x, +y);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this._p.quadraticCurveTo(+cx, +cy, +x, +y);
  }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void {
    this._p.bezierCurveTo(+a, +b, +c, +d, +x, +y);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    this._p.arcTo(+x1, +y1, +x2, +y2, +r, null);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this._p.rect(+x, +y, +w, +h);
  }
  roundRect(x: number, y: number, w: number, h: number, radii?: unknown): void {
    this._p.roundRect(+x, +y, +w, +h, radii);
  }
  arc(x: number, y: number, r: number, s: number, e: number, ccw = false): void {
    this._p.arc(+x, +y, +r, +s, +e, !!ccw);
  }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, s: number, e: number, ccw = false): void {
    this._p.ellipse(+x, +y, +rx, +ry, +rot, +s, +e, !!ccw);
  }
}

// --- State ------------------------------------------------------------------------------------------

interface Style {
  color: RGBA;
  gradient: CanvasGradient | null;
  pattern: CanvasPattern | null;
}

interface State {
  st: Float64Array;
  fill: Style;
  stroke: Style;
  shadowColor: RGBA;
  dash: number[];
  dashF32: Float32Array | null;
  font: ParsedFont;
  fontString: string;
  letterSpacing: string;
  /** Parsed letterSpacing (px or em); em is resolved against the font when the native font is resolved. */
  letterSpacingV: SpacingValue | null;
  wordSpacing: string;
  wordSpacingV: SpacingValue | null;
  fontKerning: 'auto' | 'normal' | 'none';
  fontStretch: string;
  fontVariantCaps: string;
  textRendering: string;
  direction: 'ltr' | 'rtl' | 'inherit';
  smoothingQuality: 'low' | 'medium' | 'high';
  filter: string;
  clip: NativeClip | null;
  /** The resolved native font for this state's text attributes (null: resolve on next use). */
  nativeFont: NativeFont | null;
  nativeFontVersion: number;
}

const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };
const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };
const BLACK_STYLE: Style = { color: BLACK, gradient: null, pattern: null };
const SMOOTHING_QUALITIES: readonly string[] = ['low', 'medium', 'high'];
const REPETITIONS = new Set(['repeat', 'repeat-x', 'repeat-y', 'no-repeat']);
const VARIANT_CAPS = new Set(['normal', 'small-caps', 'all-small-caps', 'petite-caps', 'all-petite-caps', 'unicase', 'titling-caps']);
const TEXT_RENDERINGS = new Set(['auto', 'optimizeSpeed', 'optimizeLegibility', 'geometricPrecision']);

// Parsed colour and font strings, shared by every context of the realm: assigning the same string again (a label
// redrawn every frame) is a map lookup, not a parse plus allocations (C2D-12). Bounded; cleared when full.
const CACHE_LIMIT = 256;
const colorStyles = new Map<string, Style | null>();
function styleForColor(v: string): Style | null {
  let st = colorStyles.get(v);
  if (st !== undefined) return st;
  const c = parseColor(v);
  st = c ? { color: c, gradient: null, pattern: null } : null;
  if (colorStyles.size >= CACHE_LIMIT) colorStyles.clear();
  colorStyles.set(v, st);
  return st;
}
interface CachedFont {
  parsed: ParsedFont;
  serialized: string;
}
const fontStrings = new Map<string, CachedFont | null>();
function fontForString(v: string): CachedFont | null {
  let f = fontStrings.get(v);
  if (f !== undefined) return f;
  const p = parseFont(v, DEFAULT_FONT_SIZE);
  f = p ? { parsed: p, serialized: serializeFont(p) } : null;
  if (fontStrings.size >= CACHE_LIMIT) fontStrings.clear();
  fontStrings.set(v, f);
  return f;
}
const DEFAULT_FONT = parseFont('10px sans-serif')!;
const FONT_STRETCH: Record<string, number> = {
  'ultra-condensed': 50,
  'extra-condensed': 62.5,
  condensed: 75,
  'semi-condensed': 87.5,
  normal: 100,
  'semi-expanded': 112.5,
  expanded: 125,
  'extra-expanded': 150,
  'ultra-expanded': 200,
};

function newState(): State {
  return {
    st: new Float64Array(STATE_SIZE),
    fill: BLACK_STYLE,
    stroke: BLACK_STYLE,
    shadowColor: TRANSPARENT,
    dash: [],
    dashF32: null,
    font: DEFAULT_FONT,
    fontString: '10px sans-serif',
    letterSpacing: '0px',
    letterSpacingV: null,
    wordSpacing: '0px',
    wordSpacingV: null,
    fontKerning: 'auto',
    fontStretch: 'normal',
    fontVariantCaps: 'normal',
    textRendering: 'auto',
    direction: 'inherit',
    smoothingQuality: 'low',
    filter: 'none',
    clip: null,
    nativeFont: null,
    nativeFontVersion: -1,
  };
}

function resetState(s: State): void {
  const st = s.st;
  st.fill(0);
  st[ST_CTM] = 1;
  st[ST_CTM + 3] = 1;
  st[ST_GLOBAL_ALPHA] = 1;
  st[ST_SMOOTHING] = 1;
  st[ST_LINE_WIDTH] = 1;
  st[ST_MITER_LIMIT] = 10;
  st[ST_TEXT_ALIGN] = 0; // start
  st[ST_TEXT_BASELINE] = 3; // alphabetic
  s.fill = BLACK_STYLE;
  s.stroke = BLACK_STYLE;
  s.shadowColor = TRANSPARENT;
  s.dash = [];
  s.dashF32 = null;
  s.font = DEFAULT_FONT;
  s.fontString = '10px sans-serif';
  s.letterSpacing = '0px';
  s.letterSpacingV = null;
  s.wordSpacing = '0px';
  s.wordSpacingV = null;
  s.fontKerning = 'auto';
  s.fontStretch = 'normal';
  s.fontVariantCaps = 'normal';
  s.textRendering = 'auto';
  s.direction = 'inherit';
  s.smoothingQuality = 'low';
  s.filter = 'none';
  s.clip = null;
  s.nativeFont = null;
}

function copyState(dst: State, src: State): void {
  dst.st.set(src.st);
  dst.fill = src.fill;
  dst.stroke = src.stroke;
  dst.shadowColor = src.shadowColor;
  dst.dash = src.dash;
  dst.dashF32 = src.dashF32;
  dst.font = src.font;
  dst.fontString = src.fontString;
  dst.letterSpacing = src.letterSpacing;
  dst.letterSpacingV = src.letterSpacingV;
  dst.wordSpacing = src.wordSpacing;
  dst.wordSpacingV = src.wordSpacingV;
  dst.fontKerning = src.fontKerning;
  dst.fontStretch = src.fontStretch;
  dst.fontVariantCaps = src.fontVariantCaps;
  dst.textRendering = src.textRendering;
  dst.direction = src.direction;
  dst.smoothingQuality = src.smoothingQuality;
  dst.filter = src.filter;
  dst.clip = src.clip;
  dst.nativeFont = src.nativeFont;
  dst.nativeFontVersion = src.nativeFontVersion;
}

function fillRuleOf(v: unknown, method: string): number {
  if (v === undefined) return 0;
  const s = String(v);
  if (s === 'nonzero') return 0;
  if (s === 'evenodd') return 1;
  throw new TypeError(`Failed to execute '${method}' on 'CanvasRenderingContext2D': The provided value '${s}' is not a valid enum value of type CanvasFillRule.`);
}

export interface ContextAttributes {
  alpha: boolean;
  colorSpace: 'srgb' | 'display-p3';
  /** Reported as requested (Chrome does the same); the bitmap is always 8-bit RGBA here. */
  colorType: 'unorm8' | 'float16';
  desynchronized: boolean;
  toneMapping: { mode: 'standard' | 'extended' };
  willReadFrequently: boolean;
}

function enumAttr<T extends string>(v: unknown, allowed: readonly T[], def: T, what: string, type: string): T {
  if (v === undefined) return def;
  const s = String(v);
  if ((allowed as readonly string[]).includes(s)) return s as T;
  throw new TypeError(`Failed to execute 'getContext': Failed to read the '${what}' property: The provided value '${s}' is not a valid enum value of type ${type}.`);
}

/** What a context needs from the canvas that owns it. */
export interface Canvas2DOwner {
  readonly width: number;
  readonly height: number;
}

// --- The context ------------------------------------------------------------------------------------

export class Canvas2DContextBase {
  /** @internal */ _n: Canvas2DNatives;
  /** @internal */ _surface: NativeSurface;
  /** @internal */ _canvas: Canvas2DOwner;
  #attrs: ContextAttributes;
  #s: State = newState();
  #stack: State[] = [];
  #clipPool: NativeClip[] = [];
  #depth = 0;
  #path = new PathBuilder();
  #scratch = new PathBuilder();
  #inv = new Float64Array(6);
  #tm = new Float64Array(TEXT_METRICS_SIZE);
  #width = 0;
  #height = 0;

  constructor(token: unknown, n: Canvas2DNatives, canvas: Canvas2DOwner, attrs: Partial<ContextAttributes> = {}) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this._n = n;
    this._canvas = canvas;
    const tm = attrs.toneMapping as { mode?: unknown } | undefined;
    this.#attrs = {
      alpha: attrs.alpha === undefined ? true : !!attrs.alpha,
      colorSpace: attrs.colorSpace === 'display-p3' ? 'display-p3' : 'srgb',
      colorType: enumAttr(attrs.colorType, ['unorm8', 'float16'] as const, 'unorm8', 'colorType', 'CanvasPixelFormat'),
      desynchronized: !!attrs.desynchronized,
      toneMapping: {
        mode: enumAttr(tm && typeof tm === 'object' ? tm.mode : undefined, ['standard', 'extended'] as const, 'standard', 'mode', 'CanvasToneMappingMode'),
      },
      willReadFrequently: !!attrs.willReadFrequently,
    };
    this.#width = canvas.width;
    this.#height = canvas.height;
    this._surface = n.createSurface(this.#width, this.#height);
    resetState(this.#s);
    this.#path.m = this.#s.st;
    if (!this.#attrs.alpha) this.#clearOpaque();
  }

  // --- internal hooks for the canvas host ---

  /** @internal Canvas width/height changed: reallocate, clear, reset state (HTML "set bitmap dimensions"). */
  _resize(width: number, height: number): void {
    this.#width = width;
    this.#height = height;
    this._n.resize(this._surface, width, height);
    this.#resetAll();
  }

  /** @internal Replace the bitmap with a fresh one (transferToImageBitmap); returns the old surface. */
  _takeSurface(): NativeSurface {
    const old = this._surface;
    this._surface = this._n.createSurface(this.#width, this.#height);
    if (!this.#attrs.alpha) this.#clearOpaque();
    return old;
  }

  #resetAll(): void {
    this.#depth = 0;
    resetState(this.#s);
    this.#path.clear();
    if (!this.#attrs.alpha) this.#clearOpaque();
  }

  #clearOpaque(): void {
    const st = this.#s.st;
    const saved = st.slice(0, STATE_SIZE);
    st.fill(0);
    st[0] = 1;
    st[3] = 1;
    st[ST_GLOBAL_ALPHA] = 1;
    st[ST_COMPOSITE] = 9; // copy
    st[ST_COLOR + 3] = 1;
    this.#scratch.m = null;
    this.#scratch.clear();
    this.#scratch.rect(0, 0, this.#width, this.#height);
    this._n.fill(this._surface, st, this.#scratch.buf, this.#scratch.len, null, null);
    st.set(saved);
  }

  get canvas(): Canvas2DOwner {
    return this._canvas;
  }

  getContextAttributes(): ContextAttributes {
    const a = this.#attrs;
    return { ...a, toneMapping: { mode: a.toneMapping.mode } };
  }

  isContextLost(): boolean {
    return false;
  }

  // --- state ---

  save(): void {
    if (this.#depth === this.#stack.length) this.#stack.push(newState());
    copyState(this.#stack[this.#depth++]!, this.#s);
  }

  restore(): void {
    if (this.#depth === 0) return;
    const cur = this.#s.clip;
    copyState(this.#s, this.#stack[--this.#depth]!);
    // A clip made at the popped depth is unreachable now (see clip()).
    if (cur !== null && cur !== this.#s.clip) this.#releaseClip(cur);
  }

  reset(): void {
    this.#resetAll();
    this._n.resize(this._surface, this.#width, this.#height);
    if (!this.#attrs.alpha) this.#clearOpaque();
  }

  // --- transforms ---

  scale(x: number, y: number): void {
    x = +x;
    y = +y;
    if (!finite2(x, y)) return;
    const st = this.#s.st;
    st[0]! *= x;
    st[1]! *= x;
    st[2]! *= y;
    st[3]! *= y;
  }

  rotate(angle: number): void {
    angle = +angle;
    if (!Number.isFinite(angle)) return;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.#mul(c, s, -s, c, 0, 0);
  }

  translate(x: number, y: number): void {
    x = +x;
    y = +y;
    if (!finite2(x, y)) return;
    const st = this.#s.st;
    st[4] = st[0]! * x + st[2]! * y + st[4]!;
    st[5] = st[1]! * x + st[3]! * y + st[5]!;
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    a = +a;
    b = +b;
    c = +c;
    d = +d;
    e = +e;
    f = +f;
    if (!finite4(a, b, c, d) || !finite2(e, f)) return;
    this.#mul(a, b, c, d, e, f);
  }

  /** CTM = CTM x [a b c d e f] (in place, no temporaries). */
  #mul(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const st = this.#s.st;
    const m0 = st[0]!;
    const m1 = st[1]!;
    const m2 = st[2]!;
    const m3 = st[3]!;
    st[0] = m0 * a + m2 * b;
    st[1] = m1 * a + m3 * b;
    st[2] = m0 * c + m2 * d;
    st[3] = m1 * c + m3 * d;
    st[4] = m0 * e + m2 * f + st[4]!;
    st[5] = m1 * e + m3 * f + st[5]!;
  }

  setTransform(a?: unknown, b?: number, c?: number, d?: number, e?: number, f?: number): void {
    const st = this.#s.st;
    if (arguments.length >= 6) {
      const na = Number(a);
      const nb = Number(b);
      const nc = Number(c);
      const nd = Number(d);
      const ne = Number(e);
      const nf = Number(f);
      if (!finite4(na, nb, nc, nd) || !finite2(ne, nf)) return;
      st[0] = na;
      st[1] = nb;
      st[2] = nc;
      st[3] = nd;
      st[4] = ne;
      st[5] = nf;
      return;
    }
    if (arguments.length > 1) throw new TypeError("Failed to execute 'setTransform': 0, 1 or 6 arguments required.");
    const m = from2DInit(a);
    if (!m) return;
    st.set(m, 0);
  }

  getTransform(): object {
    return makeDOMMatrix(this.#s.st);
  }

  resetTransform(): void {
    const st = this.#s.st;
    st[0] = 1;
    st[1] = 0;
    st[2] = 0;
    st[3] = 1;
    st[4] = 0;
    st[5] = 0;
  }

  // --- compositing ---

  get globalAlpha(): number {
    return this.#s.st[ST_GLOBAL_ALPHA]!;
  }
  set globalAlpha(v: number) {
    v = +v;
    if (!Number.isFinite(v) || v < 0 || v > 1) return;
    this.#s.st[ST_GLOBAL_ALPHA] = v;
  }

  get globalCompositeOperation(): string {
    return COMPOSITE_OPS[this.#s.st[ST_COMPOSITE]!]!;
  }
  set globalCompositeOperation(v: string) {
    const i = (COMPOSITE_OPS as readonly string[]).indexOf(String(v));
    if (i >= 0) this.#s.st[ST_COMPOSITE] = i;
  }

  get imageSmoothingEnabled(): boolean {
    return this.#s.st[ST_SMOOTHING] === 1;
  }
  set imageSmoothingEnabled(v: boolean) {
    this.#s.st[ST_SMOOTHING] = v ? 1 : 0;
  }
  get imageSmoothingQuality(): 'low' | 'medium' | 'high' {
    return this.#s.smoothingQuality;
  }
  set imageSmoothingQuality(v: 'low' | 'medium' | 'high') {
    const i = SMOOTHING_QUALITIES.indexOf(String(v));
    if (i < 0) return;
    this.#s.smoothingQuality = v;
    this.#s.st[ST_SMOOTHING_QUALITY] = i;
  }

  get filter(): string {
    return this.#s.filter;
  }
  set filter(v: string) {
    const s = String(v).trim();
    this.#s.filter = s;
    if (s !== 'none' && s !== '') warnOnce('filter', `ctx.filter = '${s}' is not implemented yet; drawing unfiltered (C2D-4).`);
  }

  // --- styles ---

  #styleValue(s: Style): string | CanvasGradient | CanvasPattern {
    return s.gradient ?? s.pattern ?? serializeColor(s.color);
  }
  #setStyle(target: 'fill' | 'stroke', v: unknown): void {
    // Style objects are immutable and shared (state copies keep references), so repeated assignments of the same
    // colour string, gradient or pattern reuse one object instead of allocating (C2D-12).
    if (v instanceof CanvasGradient) {
      this.#s[target] = v._style ??= { color: BLACK, gradient: v, pattern: null };
      return;
    }
    if (v instanceof CanvasPattern) {
      this.#s[target] = v._style ??= { color: BLACK, gradient: null, pattern: v };
      return;
    }
    const st = styleForColor(typeof v === 'string' ? v : String(v));
    if (st) this.#s[target] = st;
  }
  get fillStyle(): string | CanvasGradient | CanvasPattern {
    return this.#styleValue(this.#s.fill);
  }
  set fillStyle(v: string | CanvasGradient | CanvasPattern) {
    this.#setStyle('fill', v);
  }
  get strokeStyle(): string | CanvasGradient | CanvasPattern {
    return this.#styleValue(this.#s.stroke);
  }
  set strokeStyle(v: string | CanvasGradient | CanvasPattern) {
    this.#setStyle('stroke', v);
  }

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    if (arguments.length < 4) throw new TypeError("Failed to execute 'createLinearGradient': 4 arguments required.");
    requireFinite('createLinearGradient', +x0, +y0, +x1, +y1);
    return this.#gradient(0, +x0, +y0, +x1, +y1, 0, 0);
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient {
    if (arguments.length < 6) throw new TypeError("Failed to execute 'createRadialGradient': 6 arguments required.");
    requireFinite('createRadialGradient', +x0, +y0, +r0, +x1, +y1, +r1);
    if (+r0 < 0 || +r1 < 0) throw domException(`The ${+r0 < 0 ? 'r0' : 'r1'} provided is less than 0.`, 'IndexSizeError');
    return this.#gradient(1, +x0, +y0, +r0, +x1, +y1, +r1);
  }
  createConicGradient(startAngle: number, x: number, y: number): CanvasGradient {
    if (arguments.length < 3) throw new TypeError("Failed to execute 'createConicGradient': 3 arguments required.");
    requireFinite('createConicGradient', +startAngle, +x, +y);
    return this.#gradient(2, +startAngle, +x, +y, 0, 0, 0);
  }
  #gradient(kind: number, a: number, b: number, c: number, d: number, e: number, f: number): CanvasGradient {
    const g = new CanvasGradient(INTERNAL);
    g._n = this._n;
    g._native = this._n.createGradient(kind, a, b, c, d, e, f);
    return g;
  }

  createPattern(image: unknown, repetition: string | null): CanvasPattern | null {
    if (arguments.length < 2) throw new TypeError("Failed to execute 'createPattern': 2 arguments required.");
    const rep = repetition === null || repetition === '' ? 'repeat' : String(repetition);
    if (!REPETITIONS.has(rep)) {
      throw domException(`The provided type ('${rep}') is not one of 'repeat', 'no-repeat', 'repeat-x', or 'repeat-y'.`, 'SyntaxError');
    }
    const src = resolveImageSource(image, this._n, 'createPattern');
    if (!src) return null;
    const rx = rep === 'repeat' || rep === 'repeat-x';
    const ry = rep === 'repeat' || rep === 'repeat-y';
    let native: NativePattern | null = null;
    if (src.surface) native = this._n.createPatternFromSurface(src.surface, rx, ry);
    else if (src.data) native = this._n.createPatternFromPixels(src.data, src.width, src.height, !!src.premultiplied, rx, ry);
    else if (src.external && this._n.createPatternFromExternal) native = this._n.createPatternFromExternal(src.external, rx, ry);
    if (!native) return null;
    const p = new CanvasPattern(INTERNAL);
    p._n = this._n;
    p._native = native;
    return p;
  }

  // --- shadows ---

  get shadowOffsetX(): number {
    return this.#s.st[ST_SHADOW_OFFSET_X]!;
  }
  set shadowOffsetX(v: number) {
    v = +v;
    if (Number.isFinite(v)) this.#s.st[ST_SHADOW_OFFSET_X] = v;
  }
  get shadowOffsetY(): number {
    return this.#s.st[ST_SHADOW_OFFSET_Y]!;
  }
  set shadowOffsetY(v: number) {
    v = +v;
    if (Number.isFinite(v)) this.#s.st[ST_SHADOW_OFFSET_Y] = v;
  }
  get shadowBlur(): number {
    return this.#s.st[ST_SHADOW_BLUR]!;
  }
  set shadowBlur(v: number) {
    v = +v;
    if (Number.isFinite(v) && v >= 0) this.#s.st[ST_SHADOW_BLUR] = v;
  }
  get shadowColor(): string {
    return serializeColor(this.#s.shadowColor);
  }
  set shadowColor(v: string) {
    const style = styleForColor(typeof v === 'string' ? v : String(v));
    if (!style) return;
    const c = style.color;
    this.#s.shadowColor = c;
    const st = this.#s.st;
    st[ST_SHADOW_COLOR] = c.r / 255;
    st[ST_SHADOW_COLOR + 1] = c.g / 255;
    st[ST_SHADOW_COLOR + 2] = c.b / 255;
    st[ST_SHADOW_COLOR + 3] = c.a / 255;
  }

  // --- line styles ---

  get lineWidth(): number {
    return this.#s.st[ST_LINE_WIDTH]!;
  }
  set lineWidth(v: number) {
    v = +v;
    if (Number.isFinite(v) && v > 0) this.#s.st[ST_LINE_WIDTH] = v;
  }
  get lineCap(): string {
    return LINE_CAPS[this.#s.st[ST_LINE_CAP]!]!;
  }
  set lineCap(v: string) {
    const i = (LINE_CAPS as readonly string[]).indexOf(String(v));
    if (i >= 0) this.#s.st[ST_LINE_CAP] = i;
  }
  get lineJoin(): string {
    return LINE_JOINS[this.#s.st[ST_LINE_JOIN]!]!;
  }
  set lineJoin(v: string) {
    const i = (LINE_JOINS as readonly string[]).indexOf(String(v));
    if (i >= 0) this.#s.st[ST_LINE_JOIN] = i;
  }
  get miterLimit(): number {
    return this.#s.st[ST_MITER_LIMIT]!;
  }
  set miterLimit(v: number) {
    v = +v;
    if (Number.isFinite(v) && v > 0) this.#s.st[ST_MITER_LIMIT] = v;
  }
  get lineDashOffset(): number {
    return this.#s.st[ST_DASH_OFFSET]!;
  }
  set lineDashOffset(v: number) {
    v = +v;
    if (Number.isFinite(v)) this.#s.st[ST_DASH_OFFSET] = v;
  }
  setLineDash(segments: Iterable<number>): void {
    if (segments === null || typeof segments !== 'object' || typeof (segments as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
      throw new TypeError("Failed to execute 'setLineDash': The provided value cannot be converted to a sequence.");
    }
    // A plain array with the values already in effect (labels re-apply their dash pattern every frame): nothing to do
    // and nothing to allocate (C2D-12). Only when iterating the array is not observable (intrinsic iterator).
    if (Array.isArray(segments) && segments[Symbol.iterator] === ARRAY_ITERATOR && this.#sameDash(segments)) return;
    const list = Array.from(segments, Number);
    for (const v of list) if (!Number.isFinite(v) || v < 0) return;
    const full = list.length % 2 ? [...list, ...list] : list;
    this.#s.dash = full;
    this.#s.dashF32 = full.length && full.some((v) => v > 0) ? new Float32Array(full) : null;
  }
  #sameDash(seg: readonly unknown[]): boolean {
    const n = seg.length;
    const cur = this.#s.dash;
    if (cur.length !== (n % 2 ? 2 * n : n)) return false;
    for (let i = 0; i < cur.length; i++) {
      const v = seg[i % n];
      if (typeof v !== 'number' || v !== cur[i]) return false;
    }
    return true;
  }
  getLineDash(): number[] {
    return [...this.#s.dash];
  }

  // --- text styles ---

  get font(): string {
    return this.#s.fontString;
  }
  set font(v: string) {
    const f = fontForString(typeof v === 'string' ? v : String(v));
    if (!f) return;
    const s = this.#s;
    const caps = f.parsed.smallCaps ? 'small-caps' : 'normal';
    // Re-assigning the font a label already uses (common per frame) keeps the resolved native font.
    if (s.font === f.parsed && s.fontStretch === f.parsed.stretch && s.fontVariantCaps === caps) return;
    s.font = f.parsed;
    s.fontString = f.serialized;
    s.fontStretch = f.parsed.stretch;
    s.fontVariantCaps = caps;
    s.nativeFont = null;
  }
  get textAlign(): string {
    return TEXT_ALIGNS[this.#s.st[ST_TEXT_ALIGN]!]!;
  }
  set textAlign(v: string) {
    const i = (TEXT_ALIGNS as readonly string[]).indexOf(String(v));
    if (i >= 0) this.#s.st[ST_TEXT_ALIGN] = i;
  }
  get textBaseline(): string {
    return TEXT_BASELINES[this.#s.st[ST_TEXT_BASELINE]!]!;
  }
  set textBaseline(v: string) {
    const i = (TEXT_BASELINES as readonly string[]).indexOf(String(v));
    if (i >= 0) this.#s.st[ST_TEXT_BASELINE] = i;
  }
  get direction(): string {
    return this.#s.direction;
  }
  set direction(v: string) {
    const s = String(v);
    if (s === 'ltr' || s === 'rtl' || s === 'inherit') {
      this.#s.direction = s;
      this.#s.st[ST_DIRECTION] = s === 'rtl' ? 1 : 0;
    }
  }
  get letterSpacing(): string {
    return this.#s.letterSpacing;
  }
  set letterSpacing(v: string) {
    const e = spacingFor(typeof v === 'string' ? v : String(v));
    if (!e) return;
    // Kept parsed (cached, no allocation per assignment); an em value follows later font changes, as in browsers.
    this.#s.letterSpacing = e.normalized;
    if (this.#s.letterSpacingV !== e) this.#s.nativeFont = null;
    this.#s.letterSpacingV = e;
  }
  get wordSpacing(): string {
    return this.#s.wordSpacing;
  }
  set wordSpacing(v: string) {
    const e = spacingFor(typeof v === 'string' ? v : String(v));
    if (!e) return;
    this.#s.wordSpacing = e.normalized;
    if (this.#s.wordSpacingV !== e) this.#s.nativeFont = null;
    this.#s.wordSpacingV = e;
  }
  get fontKerning(): string {
    return this.#s.fontKerning;
  }
  set fontKerning(v: string) {
    const s = String(v);
    if ((s === 'auto' || s === 'normal' || s === 'none') && s !== this.#s.fontKerning) {
      this.#s.fontKerning = s;
      this.#s.nativeFont = null;
    }
  }
  get fontStretch(): string {
    return this.#s.fontStretch;
  }
  set fontStretch(v: string) {
    const s = String(v);
    if (s in FONT_STRETCH && s !== this.#s.fontStretch) {
      this.#s.fontStretch = s;
      this.#s.nativeFont = null;
    }
  }
  get fontVariantCaps(): string {
    return this.#s.fontVariantCaps;
  }
  set fontVariantCaps(v: string) {
    const s = String(v);
    if (VARIANT_CAPS.has(s) && s !== this.#s.fontVariantCaps) {
      this.#s.fontVariantCaps = s;
      this.#s.nativeFont = null;
    }
  }
  get textRendering(): string {
    return this.#s.textRendering;
  }
  set textRendering(v: string) {
    const s = String(v);
    if (TEXT_RENDERINGS.has(s)) this.#s.textRendering = s;
  }

  // --- paths ---

  beginPath(): void {
    this.#path.clear();
  }
  closePath(): void {
    this.#path.closePath();
  }
  moveTo(x: number, y: number): void {
    this.#path.moveTo(+x, +y);
  }
  lineTo(x: number, y: number): void {
    this.#path.lineTo(+x, +y);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.#path.quadraticCurveTo(+cx, +cy, +x, +y);
  }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void {
    this.#path.bezierCurveTo(+a, +b, +c, +d, +x, +y);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    const inv = invert(this.#inv, this.#s.st) ? this.#inv : null;
    if (!inv) return;
    this.#path.arcTo(+x1, +y1, +x2, +y2, +r, inv);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.#path.rect(+x, +y, +w, +h);
  }
  roundRect(x: number, y: number, w: number, h: number, radii?: unknown): void {
    this.#path.roundRect(+x, +y, +w, +h, radii);
  }
  arc(x: number, y: number, r: number, s: number, e: number, ccw = false): void {
    this.#path.arc(+x, +y, +r, +s, +e, !!ccw);
  }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, s: number, e: number, ccw = false): void {
    this.#path.ellipse(+x, +y, +rx, +ry, +rot, +s, +e, !!ccw);
  }

  // --- drawing ---

  /** Writes the style's colour/paint kind into the state block; returns the native paint object. */
  #paint(s: Style): NativePaint | null {
    const st = this.#s.st;
    if (s.gradient) {
      st[ST_PAINT_KIND] = 1;
      return s.gradient._native;
    }
    if (s.pattern) {
      st[ST_PAINT_KIND] = 2;
      return s.pattern._native;
    }
    st[ST_PAINT_KIND] = 0;
    st[ST_COLOR] = s.color.r / 255;
    st[ST_COLOR + 1] = s.color.g / 255;
    st[ST_COLOR + 2] = s.color.b / 255;
    st[ST_COLOR + 3] = s.color.a / 255;
    return null;
  }

  fill(a?: unknown, b?: unknown): void {
    const st = this.#s.st;
    let path = this.#path;
    let ruleArg = a;
    st[ST_PATH_SPACE] = 1;
    if (a instanceof Path2D) {
      path = a._p;
      ruleArg = b;
      st[ST_PATH_SPACE] = 0;
    }
    st[ST_FILL_RULE] = fillRuleOf(ruleArg, 'fill');
    const paint = this.#paint(this.#s.fill);
    this._n.fill(this._surface, st, path.buf, path.len, paint, this.#s.clip);
  }

  stroke(path?: Path2D): void {
    const st = this.#s.st;
    let p = this.#path;
    st[ST_PATH_SPACE] = 1;
    if (path !== undefined) {
      if (!(path instanceof Path2D)) throw new TypeError("Failed to execute 'stroke': parameter 1 is not of type 'Path2D'.");
      p = path._p;
      st[ST_PATH_SPACE] = 0;
    }
    const paint = this.#paint(this.#s.stroke);
    this._n.stroke(this._surface, st, p.buf, p.len, paint, this.#s.clip, this.#s.dashF32);
  }

  clip(a?: unknown, b?: unknown): void {
    const st = this.#s.st;
    let path = this.#path;
    let ruleArg = a;
    st[ST_PATH_SPACE] = 1;
    if (a instanceof Path2D) {
      path = a._p;
      ruleArg = b;
      st[ST_PATH_SPACE] = 0;
    }
    st[ST_FILL_RULE] = fillRuleOf(ruleArg, 'clip');
    // Clip handles are recycled (C2D-12: no new JS object per clip in save/clip/restore loops). Invariant: at depth D
    // the current clip is either the one inherited from the saved state stack[D-1] or one made at depth D, and a clip
    // made at depth D is referenced only by states at depth >= D. So a replaced (or, in restore, a popped) clip that
    // is not the inherited one is unreachable and its handle can take the next clip's mask.
    const prev = this.#s.clip;
    const reuse = this.#clipPool.pop() ?? null;
    const next = this._n.clip(this._surface, st, path.buf, path.len, prev, reuse);
    this.#s.clip = next;
    if (reuse !== null && next !== reuse) this.#releaseClip(reuse);
    if (prev !== null && prev !== this.#inheritedClip()) this.#releaseClip(prev);
  }

  #inheritedClip(): NativeClip | null {
    return this.#depth > 0 ? this.#stack[this.#depth - 1]!.clip : null;
  }

  #releaseClip(c: NativeClip): void {
    if (this.#clipPool.length < 8) this.#clipPool.push(c);
  }

  isPointInPath(a: unknown, b: unknown, c?: unknown, d?: unknown): boolean {
    const st = this.#s.st;
    let path = this.#path;
    let x: number;
    let y: number;
    let rule: unknown;
    st[ST_PATH_SPACE] = 1;
    if (a instanceof Path2D) {
      path = a._p;
      st[ST_PATH_SPACE] = 0;
      x = Number(b);
      y = Number(c);
      rule = d;
    } else {
      x = Number(a);
      y = Number(b);
      rule = c;
    }
    st[ST_FILL_RULE] = fillRuleOf(rule, 'isPointInPath');
    if (!finite2(x, y)) return false;
    return this._n.isPointInPath(this._surface, st, path.buf, path.len, x, y);
  }

  isPointInStroke(a: unknown, b: unknown, c?: unknown): boolean {
    const st = this.#s.st;
    let path = this.#path;
    let x: number;
    let y: number;
    st[ST_PATH_SPACE] = 1;
    if (a instanceof Path2D) {
      path = a._p;
      st[ST_PATH_SPACE] = 0;
      x = Number(b);
      y = Number(c);
    } else {
      x = Number(a);
      y = Number(b);
    }
    if (!finite2(x, y)) return false;
    return this._n.isPointInStroke(this._surface, st, path.buf, path.len, x, y, this.#s.dashF32);
  }

  #rectPath(x: number, y: number, w: number, h: number): PathBuilder {
    const p = this.#scratch;
    p.m = null;
    p.clear();
    p.rawMove(x, y);
    p.rawLine(x + w, y);
    p.rawLine(x + w, y + h);
    p.rawLine(x, y + h);
    p.closePathRaw();
    return p;
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    if (!finite4(+x, +y, +w, +h)) return;
    if (+w === 0 || +h === 0) return;
    const p = this.#rectPath(+x, +y, +w, +h);
    const st = this.#s.st;
    st[ST_PATH_SPACE] = 0;
    st[ST_FILL_RULE] = 0;
    const paint = this.#paint(this.#s.fill);
    this._n.fill(this._surface, st, p.buf, p.len, paint, this.#s.clip);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    if (!finite4(+x, +y, +w, +h)) return;
    if (+w === 0 && +h === 0) return;
    const p = this.#scratch;
    p.m = null;
    p.clear();
    if (+w === 0 || +h === 0) {
      p.rawMove(+x, +y);
      p.rawLine(+x + +w, +y + +h);
    } else {
      this.#rectPath(+x, +y, +w, +h);
    }
    const st = this.#s.st;
    st[ST_PATH_SPACE] = 0;
    const paint = this.#paint(this.#s.stroke);
    this._n.stroke(this._surface, st, p.buf, p.len, paint, this.#s.clip, this.#s.dashF32);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    if (!finite4(+x, +y, +w, +h)) return;
    if (!this.#attrs.alpha) {
      // Opaque canvases clear to opaque black: a bounded source-over fill (an unbounded operator such as 'copy'
      // would also clear every pixel of the clip outside the rect).
      const st = this.#s.st;
      const op = st[ST_COMPOSITE]!;
      const ga = st[ST_GLOBAL_ALPHA]!;
      const blur = st[ST_SHADOW_COLOR + 3]!;
      st[ST_COMPOSITE] = 0; // source-over
      st[ST_GLOBAL_ALPHA] = 1;
      st[ST_SHADOW_COLOR + 3] = 0;
      const p = this.#rectPath(+x, +y, +w, +h);
      st[ST_PATH_SPACE] = 0;
      st[ST_FILL_RULE] = 0;
      st[ST_PAINT_KIND] = 0;
      st[ST_COLOR] = st[ST_COLOR + 1] = st[ST_COLOR + 2] = 0;
      st[ST_COLOR + 3] = 1;
      this._n.fill(this._surface, st, p.buf, p.len, null, this.#s.clip);
      st[ST_COMPOSITE] = op;
      st[ST_GLOBAL_ALPHA] = ga;
      st[ST_SHADOW_COLOR + 3] = blur;
      return;
    }
    this._n.clearRect(this._surface, this.#s.st, +x, +y, +w, +h, this.#s.clip);
  }

  // --- text ---

  /** The native font for the current text state; cached on the state until a text attribute or the font set changes. */
  #font(): NativeFont {
    const rt = getFontRuntime();
    if (!rt) throw new TypeError('Canvas 2D text needs the font runtime (installCanvas2D was not called).');
    const s = this.#s;
    const version = rt.manager.version;
    if (s.nativeFont !== null && s.nativeFontVersion === version) return s.nativeFont;
    const f = rt.manager.resolveFast(
      s.font,
      s.fontKerning !== 'none',
      s.fontVariantCaps === 'small-caps' || s.fontVariantCaps === 'all-small-caps',
      s.letterSpacingV ? spacingPx(s.letterSpacingV, s.font.sizePx) : 0,
      s.wordSpacingV ? spacingPx(s.wordSpacingV, s.font.sizePx) : 0,
      FONT_STRETCH[s.fontStretch] ?? 100,
    );
    s.nativeFont = f;
    s.nativeFontVersion = version;
    return f;
  }

  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    this.#text(false, text, x, y, maxWidth, arguments.length);
  }

  strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    this.#text(true, text, x, y, maxWidth, arguments.length);
  }

  #text(stroke: boolean, text: unknown, x: number, y: number, maxWidth: number | undefined, argc: number): void {
    if (argc < 3) throw new TypeError(`Failed to execute '${stroke ? 'strokeText' : 'fillText'}': 3 arguments required.`);
    x = +x;
    y = +y;
    if (!finite2(x, y)) return;
    let mw: number | undefined;
    if (argc >= 4 && maxWidth !== undefined) {
      mw = +maxWidth;
      if (!Number.isFinite(mw) || mw <= 0) return;
    }
    const font = this.#font();
    const st = this.#s.st;
    if (stroke) {
      const paint = this.#paint(this.#s.stroke);
      this._n.strokeText(this._surface, st, font, typeof text === 'string' ? text : String(text), x, y, mw, paint, this.#s.clip, this.#s.dashF32);
    } else {
      const paint = this.#paint(this.#s.fill);
      this._n.fillText(this._surface, st, font, typeof text === 'string' ? text : String(text), x, y, mw, paint, this.#s.clip);
    }
  }

  measureText(text: string): TextMetrics {
    if (arguments.length < 1) throw new TypeError("Failed to execute 'measureText': 1 argument required.");
    const font = this.#font();
    const st = this.#s.st;
    this._n.measureText(font, String(text), st[ST_TEXT_ALIGN]!, st[ST_TEXT_BASELINE]!, this.#s.direction === 'rtl' ? 1 : 0, this.#tm);
    return new TextMetrics(INTERNAL, this.#tm);
  }

  // --- images ---

  drawImage(image: unknown, a1?: number, a2?: number, a3?: number, a4?: number, a5?: number, a6?: number, a7?: number, a8?: number): void {
    const argc = arguments.length - 1;
    if (argc !== 2 && argc !== 4 && argc < 8) {
      throw new TypeError(`Failed to execute 'drawImage': Valid arities are: [3, 5, 9], but ${argc + 1} arguments provided.`);
    }
    // WebIDL: all numbers are converted before the source is examined.
    const v1 = Number(a1);
    const v2 = Number(a2);
    const v3 = argc >= 4 ? Number(a3) : 0;
    const v4 = argc >= 4 ? Number(a4) : 0;
    const v5 = argc >= 8 ? Number(a5) : 0;
    const v6 = argc >= 8 ? Number(a6) : 0;
    const v7 = argc >= 8 ? Number(a7) : 0;
    const v8 = argc >= 8 ? Number(a8) : 0;
    const src = resolveImageSource(image, this._n, 'drawImage');
    if (!src) return;
    if (!finite4(v1, v2, v3, v4) || !finite4(v5, v6, v7, v8)) return;
    if (argc === 2) {
      if (src.width === 0 || src.height === 0) return;
      this.#drawResolved(src, 0, 0, src.width, src.height, v1, v2, src.width, src.height);
    } else if (argc === 4) {
      if (src.width === 0 || src.height === 0) return;
      this.#drawResolved(src, 0, 0, src.width, src.height, v1, v2, v3, v4);
    } else {
      if (v3 === 0 || v4 === 0) return;
      this.#drawResolved(src, v1, v2, v3, v4, v5, v6, v7, v8);
    }
  }

  #drawResolved(src: ResolvedImage, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void {
    const st = this.#s.st;
    const clip = this.#s.clip;
    if (src.surface) {
      this._n.drawSurface(this._surface, st, src.surface, sx, sy, sw, sh, dx, dy, dw, dh, clip);
    } else if (src.data) {
      this._n.drawPixels(this._surface, st, src.data, src.width, src.height, !!src.premultiplied, sx, sy, sw, sh, dx, dy, dw, dh, clip);
    } else if (src.external && this._n.drawExternal) {
      this._n.drawExternal(this._surface, st, src.external, sx, sy, sw, sh, dx, dy, dw, dh, clip);
    }
  }

  createImageData(a: number | ImageData, b?: number, settings?: unknown): ImageData {
    if (a !== null && typeof a === 'object' && 'width' in a && 'height' in a) {
      return new ImageData((a as ImageData).width, (a as ImageData).height);
    }
    if (arguments.length < 2) throw new TypeError("Failed to execute 'createImageData': 2 arguments required.");
    const w = Math.abs(toLong(a));
    const h = Math.abs(toLong(b));
    if (w === 0 || h === 0) throw domException(`The source ${w === 0 ? 'width' : 'height'} is 0.`, 'IndexSizeError');
    const G = (globalThis as { ImageData?: new (w: number, h: number, s?: unknown) => ImageData }).ImageData;
    return typeof G === 'function' ? new G(w, h, settings) : new ImageData(w, h, settings);
  }

  getImageData(sx: number, sy: number, sw: number, sh: number, settings?: unknown): ImageData {
    if (arguments.length < 4) throw new TypeError("Failed to execute 'getImageData': 4 arguments required.");
    let x = toLong(sx);
    let y = toLong(sy);
    let w = toLong(sw);
    let h = toLong(sh);
    if (w === 0 || h === 0) throw domException(`The source ${w === 0 ? 'width' : 'height'} is 0.`, 'IndexSizeError');
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    // The image module's ImageData when installed (one ImageData class per realm), else ours.
    const G = (globalThis as { ImageData?: new (w: number, h: number, s?: unknown) => ImageData }).ImageData;
    const img = typeof G === 'function' ? new G(w, h, settings) : new ImageData(w, h, settings);
    this._n.getImageData(this._surface, x, y, w, h, img.data);
    return img;
  }

  putImageData(img: ImageData, dx: number, dy: number, dirtyX?: number, dirtyY?: number, dirtyW?: number, dirtyH?: number): void {
    if (arguments.length < 3) throw new TypeError("Failed to execute 'putImageData': 3 arguments required.");
    if (!img || typeof img !== 'object' || !(img.data instanceof Uint8ClampedArray)) {
      throw new TypeError("Failed to execute 'putImageData': parameter 1 is not of type 'ImageData'.");
    }
    if (img.data.buffer.byteLength === 0) throw domException('The ImageData has been detached.', 'InvalidStateError');
    // Overloads: (imagedata, dx, dy) and (imagedata, dx, dy, dirtyX, dirtyY, dirtyWidth, dirtyHeight).
    if (arguments.length > 3 && arguments.length < 7) {
      throw new TypeError(`Failed to execute 'putImageData': Valid arities are: [3, 7], but ${arguments.length} arguments provided.`);
    }
    const full = arguments.length < 7;
    if (!finite2(+dx, +dy)) return;
    const x = full ? 0 : toLong(dirtyX);
    const y = full ? 0 : toLong(dirtyY);
    const w = full ? img.width : toLong(dirtyW);
    const h = full ? img.height : toLong(dirtyH);
    this._n.putImageData(this._surface, img.data, img.width, img.height, toLong(dx), toLong(dy), x, y, w, h);
  }

  // --- focus / misc (no DOM focus in this runtime) ---

  drawFocusIfNeeded(): void {
    // HTML: draws only when the element is focused; elements are never focused here.
  }
  scrollPathIntoView(): void {
    // HTML: scrolls the canvas into view; there is no scrollable viewport here.
  }
}

/** The context class for <canvas> elements. */
export class CanvasRenderingContext2D extends Canvas2DContextBase {}
/** The context class for OffscreenCanvas. */
export class OffscreenCanvasRenderingContext2D extends Canvas2DContextBase {
  commit(): void {
    // Spec: no-op for contexts whose canvas has no placeholder.
  }
}

/** Creates a 2D context for a canvas host (internal: hosts call this from getContext). */
export function createContext2D(
  kind: 'element' | 'offscreen',
  n: Canvas2DNatives,
  canvas: Canvas2DOwner,
  attrs?: Partial<ContextAttributes>,
): Canvas2DContextBase {
  return kind === 'offscreen'
    ? new OffscreenCanvasRenderingContext2D(INTERNAL, n, canvas, attrs)
    : new CanvasRenderingContext2D(INTERNAL, n, canvas, attrs);
}

export { INTERNAL as _INTERNAL };
