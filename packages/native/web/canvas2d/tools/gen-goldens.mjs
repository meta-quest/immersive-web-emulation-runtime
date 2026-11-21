#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Renders the Canvas 2D golden cases (test/golden/cases.mjs) in headless Chrome and writes
// test/golden/chrome/<case>.png plus test/golden/chrome/metrics.json (measureText values). Run when cases change:
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   CHROME=/path/to/chrome-headless-shell \
//   node web/canvas2d/tools/gen-goldens.mjs
//
// Chrome flags: software rendering (--disable-gpu, willReadFrequently canvases) and --font-render-hinting=none, so
// goldens come from Skia's CPU rasterizer with unhinted text, the closest browser reference for our renderer.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePng } from '../test/golden/png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const caseFile = resolve(here, '../test/golden/cases.mjs');
const outDir = resolve(here, '../test/golden/chrome');
const fontDir = resolve(here, '../../../runtime/canvas2d/fonts');

const pw = process.env.PLAYWRIGHT_CORE;
const chromePath = process.env.CHROME;
if (!pw || !chromePath) {
  console.error('Set PLAYWRIGHT_CORE (playwright-core package dir) and CHROME (chrome-headless-shell binary).');
  process.exit(2);
}
const { chromium } = await import(pathToFileURL(join(pw, 'index.mjs')).href);

const caseSource = readFileSync(caseFile, 'utf8');
const regular = readFileSync(join(fontDir, 'Roboto-Regular.ttf')).toString('base64');
const bold = readFileSync(join(fontDir, 'Roboto-Bold.ttf')).toString('base64');

const browser = await chromium.launch({
  executablePath: chromePath,
  args: ['--disable-gpu', '--font-render-hinting=none', '--force-color-profile=srgb', '--disable-lcd-text'],
});
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  const result = await page.evaluate(
    async ({ caseSource, regular, bold }) => {
      const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const mod = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(caseSource)))}`);
      const r = new FontFace('IwnTest', bytes(regular), { weight: '400' });
      const b = new FontFace('IwnTest', bytes(bold), { weight: '700' });
      // A family with only the regular face: bold and italic requests are synthesized.
      const ro = new FontFace('IwnRegular', bytes(regular), { weight: '400' });
      document.fonts.add(r);
      document.fonts.add(b);
      document.fonts.add(ro);
      await Promise.all([r.loaded, b.loaded, ro.loaded]);
      const env = {
        canvas: (w, h) => new OffscreenCanvas(w, h),
        checker: () => {
          const c = new OffscreenCanvas(8, 8);
          mod.drawChecker(c.getContext('2d'));
          return c;
        },
        font: 'IwnTest',
      };
      const toB64 = (u8) => {
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        return btoa(s);
      };
      const images = [];
      for (const c of mod.cases) {
        const canvas = document.createElement('canvas');
        canvas.width = c.w;
        canvas.height = c.h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        let error = null;
        try {
          c.draw(ctx, env);
        } catch (e) {
          error = String(e);
        }
        const d = ctx.getImageData(0, 0, c.w, c.h).data;
        images.push({ name: c.name, w: c.w, h: c.h, data: toB64(new Uint8Array(d.buffer)), error });
      }
      const ctx = document.createElement('canvas').getContext('2d');
      const metrics = mod.metricCases.map((m) => {
        ctx.font = m.font;
        ctx.textBaseline = m.baseline;
        ctx.textAlign = m.align;
        const tm = ctx.measureText(m.text);
        const out = { ...m };
        for (const k of mod.METRIC_KEYS) out[k] = tm[k];
        return out;
      });
      return { images, metrics, ua: navigator.userAgent };
    },
    { caseSource, regular, bold },
  );
  mkdirSync(outDir, { recursive: true });
  for (const img of result.images) {
    if (img.error) console.warn(`${img.name}: Chrome threw ${img.error}`);
    const px = new Uint8Array(Buffer.from(img.data, 'base64'));
    writeFileSync(join(outDir, `${img.name}.png`), encodePng(px, img.w, img.h));
  }
  writeFileSync(join(outDir, 'metrics.json'), JSON.stringify({ chrome: result.ua, metrics: result.metrics }, null, 1) + '\n');
  console.log(`wrote ${result.images.length} goldens and ${result.metrics.length} metric rows to ${outDir} (${result.ua})`);
} finally {
  await browser.close();
}
