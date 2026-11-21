/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Test setup: the real raster core through the Node-API addon (runtime/canvas2d, target iwn_canvas2d_napi).
// The addon path comes from IWN_CANVAS2D_ADDON, else build/canvas2d-host/canvas2d.node under the package.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCanvas2D } from '../src/install.ts';
import type { Canvas2DNatives } from '../src/natives.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const PKG = resolve(here, '../../..');
export const RUNTIME_DIR = resolve(PKG, 'runtime/canvas2d');
export const FONT_DIR = resolve(RUNTIME_DIR, 'fonts');

export function addonPath(): string | null {
  const candidates = [process.env.IWN_CANVAS2D_ADDON, resolve(PKG, 'build/canvas2d-host/canvas2d.node')];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

let cached: Canvas2DNatives | null = null;
export function loadNatives(): Canvas2DNatives | null {
  if (cached) return cached;
  const p = addonPath();
  if (!p) return null;
  const req = createRequire(import.meta.url);
  const n = req(p) as Canvas2DNatives;
  n.setAssetRoot?.(RUNTIME_DIR);
  n.configureSystemFonts?.('/nonexistent/fonts.xml', '/nonexistent');
  cached = n;
  return n;
}

export interface TestGlobal {
  OffscreenCanvas: new (w: number, h: number) => { getContext(t: string, o?: unknown): any; width: number; height: number };
  FontFace: new (family: string, src: unknown, d?: unknown) => { status: string; loaded: Promise<unknown> };
  fonts: { add(f: unknown): unknown; ready: Promise<unknown>; check(font: string): boolean; size: number };
  Path2D: new (p?: unknown) => any;
  ImageData: new (...a: any[]) => any;
  [k: string]: any;
}

/** A fresh global with Canvas 2D installed, "IwnTest" (Roboto 400 + 700) and "IwnRegular" (Roboto 400) registered. */
export function makeGlobal(n: Canvas2DNatives): TestGlobal {
  const g: Record<string, unknown> = { navigator: { language: 'en' } };
  installCanvas2D(g, { natives: n, mode: 'all' });
  const tg = g as unknown as TestGlobal;
  const reg = new tg.FontFace('IwnTest', readFileSync(resolve(FONT_DIR, 'Roboto-Regular.ttf')), { weight: '400' });
  const bold = new tg.FontFace('IwnTest', readFileSync(resolve(FONT_DIR, 'Roboto-Bold.ttf')), { weight: '700' });
  tg.fonts.add(reg);
  tg.fonts.add(bold);
  // "IwnRegular": the regular face only (synthetic bold/italic cases), as in tools/gen-goldens.mjs.
  tg.fonts.add(new tg.FontFace('IwnRegular', readFileSync(resolve(FONT_DIR, 'Roboto-Regular.ttf')), { weight: '400' }));
  // The shared cases reference Path2D as a global (as in a browser).
  (globalThis as Record<string, unknown>).Path2D = tg.Path2D;
  return tg;
}
