/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  installCanvasElementSupport,
  OffscreenCanvas,
  setCanvasNatives,
} from './canvas.ts';
import {
  CanvasGradient,
  CanvasPattern,
  CanvasRenderingContext2D,
  ImageData,
  OffscreenCanvasRenderingContext2D,
  Path2D,
  TextMetrics,
} from './context2d.ts';
import {
  FontFace,
  FontFaceSet,
  FontManager,
  type FontRuntime,
  setFontRuntime,
} from './fonts.ts';
import type { Canvas2DNatives } from './natives.ts';
import { SURFACE_SYMBOL } from './sources.ts';

export interface InstallCanvas2DOptions {
  /** Defaults to globalThis.__iwn.canvas2d. */
  natives?: Canvas2DNatives;
  /** 'missing' (default) keeps globals that already exist; 'all' replaces them. */
  mode?: 'missing' | 'all';
  /** BCP 47 language for shaping (default: navigator.language, else "en"). */
  language?: string;
  /** fetch used by FontFace url() sources (default: globalThis.fetch). */
  fetch?: FontRuntime['fetch'];
}

export interface Canvas2DInstallResult {
  installed: boolean;
  fonts: FontFaceSet | null;
  manager: FontManager | null;
}

function define(
  target: object,
  name: string,
  value: unknown,
  mode: 'missing' | 'all',
): void {
  if (mode === 'missing' && name in target) return;
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/**
 * Installs Canvas 2D on a global (window or worker scope): OffscreenCanvas and the 2D interfaces, Path2D,
 * ImageData, TextMetrics, FontFace/FontFaceSet with `document.fonts` (window) or `self.fonts` (workers), and the
 * canvas behaviour of HTMLCanvasElement when the DOM module already defined that interface.
 */
export function installCanvas2D(
  global: object = globalThis,
  options: InstallCanvas2DOptions = {},
): Canvas2DInstallResult {
  const g = global as Record<string, unknown> & {
    __iwn?: { canvas2d?: Canvas2DNatives };
  };
  const n = options.natives ?? g.__iwn?.canvas2d;
  if (!n) return { installed: false, fonts: null, manager: null };
  const mode = options.mode ?? 'missing';
  const nav = g.navigator as { language?: string } | undefined;
  const manager = new FontManager(n, options.language ?? nav?.language ?? 'en');
  const rt: FontRuntime = { natives: n, manager };
  if (options.fetch) rt.fetch = options.fetch;
  setCanvasNatives(n);
  setFontRuntime(rt);
  const fonts = new FontFaceSet();
  manager.addSet(fonts);

  define(g, 'OffscreenCanvas', OffscreenCanvas, mode);
  define(
    g,
    'OffscreenCanvasRenderingContext2D',
    OffscreenCanvasRenderingContext2D,
    mode,
  );
  define(g, 'CanvasRenderingContext2D', CanvasRenderingContext2D, mode);
  define(g, 'CanvasGradient', CanvasGradient, mode);
  define(g, 'CanvasPattern', CanvasPattern, mode);
  define(g, 'Path2D', Path2D, mode);
  define(g, 'TextMetrics', TextMetrics, mode);
  define(g, 'ImageData', ImageData, mode);
  define(g, 'FontFace', FontFace, mode);
  define(g, 'FontFaceSet', FontFaceSet, mode);

  const doc = g.document as Record<string, unknown> | undefined;
  if (doc && typeof doc === 'object') {
    if (mode === 'all' || !('fonts' in doc)) {
      Object.defineProperty(doc, 'fonts', {
        get: () => fonts,
        configurable: true,
        enumerable: true,
      });
    }
  } else if (mode === 'all' || !('fonts' in g)) {
    Object.defineProperty(g, 'fonts', {
      get: () => fonts,
      configurable: true,
      enumerable: true,
    });
  }

  const HTMLCanvasElement = g.HTMLCanvasElement as
    | { prototype?: object }
    | undefined;
  if (
    HTMLCanvasElement?.prototype &&
    !(SURFACE_SYMBOL in HTMLCanvasElement.prototype)
  ) {
    installCanvasElementSupport(HTMLCanvasElement.prototype);
  }
  return { installed: true, fonts, manager };
}
