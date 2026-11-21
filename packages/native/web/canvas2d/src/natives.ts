/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The native half of Canvas 2D as JS sees it: `globalThis.__iwn.canvas2d`, installed by
 * `iwn_register_canvas2d` (runtime/canvas2d/binding/v8_binding.cc) on device, or the Node-API addon
 * (runtime/canvas2d/binding/napi_binding.cc) in headless tests. Both share runtime/canvas2d/binding/api.cc.
 *
 * Handles (`NativeSurface`, ...) are opaque objects; the native side frees them when they are collected and
 * reports their pixel memory to the engine as external memory (IMG-7).
 *
 * Calls take a per-context state block (`Float64Array(STATE_SIZE)`, indices below) instead of many
 * arguments, so a draw call allocates nothing (C2D-12).
 */

export type NativeSurface = { readonly __brand: 'surface' };
export type NativeGradient = { readonly __brand: 'gradient' };
export type NativePattern = { readonly __brand: 'pattern' };
export type NativeClip = { readonly __brand: 'clip' };
export type NativeFace = { readonly __brand: 'face' };
export type NativeFont = { readonly __brand: 'font' };
export type NativePaint = NativeGradient | NativePattern;

export interface NativeFaceInfo {
  family: string;
  style: string;
  weight: number;
  italic: boolean;
  stretch: number;
  color: boolean;
  weightMin: number;
  weightMax: number;
  numFaces: number;
}

export interface NativeSystemFamily {
  name: string;
  fonts: { path: string; weight: number; italic: boolean; index: number }[];
}

export interface Canvas2DNatives {
  createSurface(width: number, height: number): NativeSurface;
  /** Reallocates and clears. False when the size cannot be allocated (the surface is then 0x0). */
  resize(surface: NativeSurface, width: number, height: number): boolean;

  fill(s: NativeSurface, state: Float64Array, cmds: Float32Array, len: number, paint: NativePaint | null, clip: NativeClip | null): void;
  stroke(
    s: NativeSurface,
    state: Float64Array,
    cmds: Float32Array,
    len: number,
    paint: NativePaint | null,
    clip: NativeClip | null,
    dash: Float32Array | null,
  ): void;
  clearRect(s: NativeSurface, state: Float64Array, x: number, y: number, w: number, h: number, clip: NativeClip | null): void;
  /** A new clip (parent intersected with the path). `reuse`: an unreferenced clip handle to write the result into
   * (returned instead of a new handle); natives without reuse support ignore it. */
  clip(s: NativeSurface, state: Float64Array, cmds: Float32Array, len: number, parent: NativeClip | null, reuse?: NativeClip | null): NativeClip;
  isPointInPath(s: NativeSurface, state: Float64Array, cmds: Float32Array, len: number, x: number, y: number): boolean;
  isPointInStroke(
    s: NativeSurface,
    state: Float64Array,
    cmds: Float32Array,
    len: number,
    x: number,
    y: number,
    dash: Float32Array | null,
  ): boolean;

  drawSurface(
    s: NativeSurface,
    state: Float64Array,
    src: NativeSurface,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    clip: NativeClip | null,
  ): void;
  drawPixels(
    s: NativeSurface,
    state: Float64Array,
    data: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    premultiplied: boolean,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    clip: NativeClip | null,
  ): void;
  /** Optional (V8 binding): draw another native module's image handle (see api::SetExternalImageResolver). */
  drawExternal?(
    s: NativeSurface,
    state: Float64Array,
    src: object,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    clip: NativeClip | null,
  ): boolean;

  getImageData(s: NativeSurface, x: number, y: number, w: number, h: number, out: Uint8ClampedArray): void;
  putImageData(
    s: NativeSurface,
    data: Uint8ClampedArray,
    dataWidth: number,
    dataHeight: number,
    dx: number,
    dy: number,
    dirtyX: number,
    dirtyY: number,
    dirtyWidth: number,
    dirtyHeight: number,
  ): void;
  readPixels(s: NativeSurface, out: Uint8Array | Uint8ClampedArray, premultiplied: boolean, flipY: boolean): void;
  encode(s: NativeSurface, mime: string, quality: number): [ArrayBuffer, string] | null;

  createGradient(kind: number, p0: number, p1: number, p2: number, p3: number, p4: number, p5: number): NativeGradient;
  addColorStop(g: NativeGradient, offset: number, r: number, gr: number, b: number, a: number): void;
  createPatternFromSurface(src: NativeSurface, repeatX: boolean, repeatY: boolean): NativePattern;
  createPatternFromPixels(
    data: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    premultiplied: boolean,
    repeatX: boolean,
    repeatY: boolean,
  ): NativePattern;
  createPatternFromExternal?(src: object, repeatX: boolean, repeatY: boolean): NativePattern | null;
  setPatternTransform(p: NativePattern, a: number, b: number, c: number, d: number, e: number, f: number): void;

  /** Returns a face, or an error message string. */
  loadFace(bytes: ArrayBuffer | Uint8Array, index: number): NativeFace | string;
  loadFaceFile(path: string, index: number): NativeFace | null;
  faceInfo(face: NativeFace): NativeFaceInfo;
  /** The runtime's bundled faces as [generic family, face] pairs (C2D-9). */
  defaultFaces(): [string, NativeFace][];
  systemFamilies(): NativeSystemFamily[];
  /**
   * `synthetic[i]` per face: bit 0 synthetic bold, bit 1 synthetic italic, bits 8-17 / 18-27 the face's CSS weight
   * range (min / max, 1-1000; 0 = the font's own): variable faces are instantiated at `weight` clamped to it.
   */
  createFont(
    faces: NativeFace[],
    synthetic: number[],
    size: number,
    weight: number,
    italic: boolean,
    smallCaps: boolean,
    kerning: boolean,
    letterSpacing: number,
    wordSpacing: number,
    language: string,
  ): NativeFont;
  /** Writes TEXT_METRICS_SIZE doubles (see TM_* indices). */
  measureText(font: NativeFont, text: string, align: number, baseline: number, direction: number, out: Float64Array): void;
  fillText(
    s: NativeSurface,
    state: Float64Array,
    font: NativeFont,
    text: string,
    x: number,
    y: number,
    maxWidth: number | undefined,
    paint: NativePaint | null,
    clip: NativeClip | null,
  ): void;
  strokeText(
    s: NativeSurface,
    state: Float64Array,
    font: NativeFont,
    text: string,
    x: number,
    y: number,
    maxWidth: number | undefined,
    paint: NativePaint | null,
    clip: NativeClip | null,
    dash: Float32Array | null,
  ): void;

  /** Host/testing only. */
  configureSystemFonts?(fontsXmlPath: string, fontDir: string): void;
  setAssetRoot?(dir: string): void;
}

// State block indices (runtime/canvas2d/binding/api.h StateIndex).
export const ST_CTM = 0; // a b c d e f at 0..5
export const ST_GLOBAL_ALPHA = 6;
export const ST_COMPOSITE = 7;
export const ST_SMOOTHING = 8;
export const ST_SMOOTHING_QUALITY = 9;
export const ST_SHADOW_OFFSET_X = 10;
export const ST_SHADOW_OFFSET_Y = 11;
export const ST_SHADOW_BLUR = 12;
export const ST_SHADOW_COLOR = 13; // r g b a (0..1, unpremultiplied) at 13..16
export const ST_LINE_WIDTH = 17;
export const ST_LINE_CAP = 18;
export const ST_LINE_JOIN = 19;
export const ST_MITER_LIMIT = 20;
export const ST_DASH_OFFSET = 21;
export const ST_COLOR = 22; // r g b a at 22..25
export const ST_PAINT_KIND = 26; // 0 solid, 1 gradient, 2 pattern
export const ST_FILL_RULE = 27;
export const ST_PATH_SPACE = 28; // 0 user, 1 device
export const ST_TEXT_ALIGN = 29;
export const ST_TEXT_BASELINE = 30;
export const ST_DIRECTION = 31;
export const STATE_SIZE = 32;

// measureText output indices.
export const TM_WIDTH = 0;
export const TM_ACTUAL_LEFT = 1;
export const TM_ACTUAL_RIGHT = 2;
export const TM_ACTUAL_ASCENT = 3;
export const TM_ACTUAL_DESCENT = 4;
export const TM_FONT_ASCENT = 5;
export const TM_FONT_DESCENT = 6;
export const TM_EM_ASCENT = 7;
export const TM_EM_DESCENT = 8;
export const TM_HANGING = 9;
export const TM_ALPHABETIC = 10;
export const TM_IDEOGRAPHIC = 11;
export const TEXT_METRICS_SIZE = 12;

/** globalCompositeOperation values in wire-code order (runtime/canvas2d/include/iwn/canvas2d/types.h). */
export const COMPOSITE_OPS = [
  'source-over',
  'source-in',
  'source-out',
  'source-atop',
  'destination-over',
  'destination-in',
  'destination-out',
  'destination-atop',
  'lighter',
  'copy',
  'xor',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const;

export const TEXT_ALIGNS = ['start', 'end', 'left', 'right', 'center'] as const;
export const TEXT_BASELINES = ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'] as const;
export const LINE_CAPS = ['butt', 'round', 'square'] as const;
export const LINE_JOINS = ['miter', 'round', 'bevel'] as const;

// Path command verbs (runtime/canvas2d/include/iwn/canvas2d/types.h PathVerb).
export const VERB_MOVE = 0;
export const VERB_LINE = 1;
export const VERB_QUAD = 2;
export const VERB_CUBIC = 3;
export const VERB_CLOSE = 4;
