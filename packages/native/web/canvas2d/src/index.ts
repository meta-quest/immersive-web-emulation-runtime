/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Canvas 2D (with text) for @iwer/native: see README.md in this directory. */

export { installCanvas2D, type InstallCanvas2DOptions, type Canvas2DInstallResult } from './install.ts';
export {
  CanvasHost,
  Canvas2DImageBitmap,
  OffscreenCanvas,
  hostOf,
  installCanvasElementSupport,
  registerContextFactory,
  setImageBitmapFactory,
  type ContextFactory,
  type ImageBitmapFactory,
} from './canvas.ts';
export {
  CanvasGradient,
  CanvasPattern,
  CanvasRenderingContext2D,
  Canvas2DContextBase,
  ImageData,
  OffscreenCanvasRenderingContext2D,
  Path2D,
  TextMetrics,
} from './context2d.ts';
export { FontFace, FontFaceSet, FontManager, matchFace } from './fonts.ts';
export { parseColor, serializeColor } from './color.ts';
export { parseFont, serializeFont } from './font.ts';
export {
  PIXELS_SYMBOL,
  SURFACE_SYMBOL,
  registerImageSourceResolver,
  type ImageSourceResolver,
  type PixelData,
  type ResolvedImage,
} from './sources.ts';
export type { Canvas2DNatives } from './natives.ts';
