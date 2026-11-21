/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// C2D-11: the golden-image suite. Every case in golden/cases.mjs is rendered by the runtime (JS layer + native
// raster core via the Node-API addon) and compared with the Chrome rendering in golden/chrome/. A case passes when
// at most `tolerance` (default 2 %) of its pixels differ by more than 16/255. C2D-8: measureText widths within
// 5 % of Chrome.
//
// Set IWN_GOLDEN_OUT=<dir> to write every runtime rendering and diff image there.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { cases, drawChecker, METRIC_KEYS, metricCases } from './golden/cases.mjs';
import { comparePixels, decodePng, diffImage, encodePng } from './golden/png.mjs';
import { loadNatives, makeGlobal } from './helpers.ts';

const GOLDEN_DIR = resolve(import.meta.dirname, 'golden/chrome');
const VERTICAL_KEYS = ['fontBoundingBoxAscent', 'fontBoundingBoxDescent', 'emHeightAscent', 'emHeightDescent', 'alphabeticBaseline'];
const natives = loadNatives();
const outDir = process.env.IWN_GOLDEN_OUT;
if (outDir) mkdirSync(outDir, { recursive: true });

describe('canvas2d golden images (C2D-11)', { skip: natives ? false : 'canvas2d addon not built (see README)' }, () => {
  const g = natives ? makeGlobal(natives) : (null as never);
  const env = {
    canvas: (w: number, h: number) => new g.OffscreenCanvas(w, h),
    checker: () => {
      const c = new g.OffscreenCanvas(8, 8);
      drawChecker(c.getContext('2d'));
      return c;
    },
    font: 'IwnTest',
  };
  const summary: string[] = [];
  for (const c of cases as { name: string; w: number; h: number; tolerance?: number; draw(ctx: unknown, env: unknown): void }[]) {
    it(c.name, () => {
      const canvas = new g.OffscreenCanvas(c.w, c.h);
      const ctx = canvas.getContext('2d');
      c.draw(ctx, env);
      const actual = ctx.getImageData(0, 0, c.w, c.h).data as Uint8ClampedArray;
      const golden = decodePng(readFileSync(join(GOLDEN_DIR, `${c.name}.png`)));
      assert.equal(golden.width, c.w);
      assert.equal(golden.height, c.h);
      const r = comparePixels(actual, golden.data, c.w, c.h);
      const tol = c.tolerance ?? 0.02;
      summary.push(`${c.name.padEnd(36)} ${(r.fraction * 100).toFixed(2).padStart(6)} % (max ${r.maxDiff.toFixed(0)})`);
      if (outDir || r.fraction > tol) {
        const dir = outDir ?? join(process.env.TMPDIR ?? '/tmp', 'iwn-canvas2d-golden');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${c.name}.actual.png`), encodePng(new Uint8Array(actual.buffer), c.w, c.h));
        writeFileSync(join(dir, `${c.name}.diff.png`), encodePng(diffImage(actual, golden.data, c.w, c.h), c.w, c.h));
      }
      assert.ok(r.fraction <= tol, `${c.name}: ${(r.fraction * 100).toFixed(2)} % of pixels differ by > 16/255 (limit ${tol * 100} %)`);
    });
  }
  it('summary', () => {
    if (process.env.IWN_GOLDEN_SUMMARY) console.log(summary.join('\n'));
  });
});

describe('measureText vs Chrome (C2D-8)', { skip: natives ? false : 'canvas2d addon not built' }, () => {
  const g = natives ? makeGlobal(natives) : (null as never);
  const chrome = natives ? (JSON.parse(readFileSync(join(GOLDEN_DIR, 'metrics.json'), 'utf8')).metrics as Record<string, number | string>[]) : [];
  it('widths within 5 %, vertical metrics within 1 px', () => {
    const ctx = new g.OffscreenCanvas(1, 1).getContext('2d');
    const worst: Record<string, number> = {};
    const failures: string[] = [];
    let compared = 0;
    metricCases.forEach((m: { font: string; text: string; baseline: string; align: string }, i: number) => {
      ctx.font = m.font;
      ctx.textBaseline = m.baseline;
      ctx.textAlign = m.align;
      const tm = ctx.measureText(m.text);
      const ref = chrome[i]!;
      assert.equal(ref.text, m.text);
      for (const k of METRIC_KEYS as string[]) {
        if (typeof ref[k] !== 'number') continue;
        const d = Math.abs(tm[k] - (ref[k] as number));
        worst[k] = Math.max(worst[k] ?? 0, d);
      }
      const w = ref.width as number;
      if (Math.abs(tm.width - w) > 0.05 * w) failures.push(`${m.font} "${m.text}": width ${tm.width} vs ${w}`);
      // Chrome 145 does not implement emHeightAscent/emHeightDescent (absent from metrics.json): only metrics Chrome
      // reported are compared, and a missing one is never counted as a pass.
      for (const k of VERTICAL_KEYS) {
        const r = ref[k];
        if (typeof r !== 'number') continue;
        compared++;
        if (!(Math.abs(tm[k] - r) <= 1)) failures.push(`${m.font} "${m.text}" ${m.baseline}: ${k} ${tm[k]} vs ${r}`);
      }
    });
    if (process.env.IWN_GOLDEN_SUMMARY) console.log('max |runtime - chrome| per metric (px):', worst);
    assert.deepEqual(failures, []);
    // fontBoundingBoxAscent/Descent and alphabeticBaseline for every row.
    assert.equal(compared, metricCases.length * 3);
  });
});
