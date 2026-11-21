/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Device golden run: reassemble the PNG chunks from logcat, compare with the Chrome goldens (the C2D-11 rule and the
// per-case tolerance from cases.mjs) and with the host (x86_64) rendering of the same case.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
// Usage: IWN_CANVAS2D_ADDON=<canvas2d.node> node web/canvas2d/tools/device-suite/compare.mts <logcat file> [<png dir>]
import { resolve } from 'node:path';
const PKG = resolve(import.meta.dirname, '../../../..');
const { cases, drawChecker, metricCases, METRIC_KEYS } = await import(PKG + '/web/canvas2d/test/golden/cases.mjs');
const { decodePng, comparePixels } = await import(PKG + '/web/canvas2d/test/golden/png.mjs');
const { loadNatives, makeGlobal } = await import(PKG + '/web/canvas2d/test/helpers.ts');
const log = readFileSync(process.argv[2], 'utf8').split('\n');
const chunks = new Map<string, string[]>();
const metricRows: any[] = [];
for (const line of log) {
  const i = line.indexOf('C2DIMG ');
  if (i >= 0) {
    const [, name, k, n, data] = line.slice(i).trim().split(' ');
    if (!chunks.has(name!)) chunks.set(name!, new Array(Number(n)).fill(''));
    chunks.get(name!)![Number(k)] = data ?? '';
  }
  const j = line.indexOf('C2D metrics ');
  if (j >= 0) { const o = JSON.parse(line.slice(j + 12)); o.rows.forEach((r: any, k: number) => (metricRows[o.from + k] = r)); }
}
const g = makeGlobal(loadNatives()!);
const env = { canvas: (w: number, h: number) => new g.OffscreenCanvas(w, h), checker: () => { const c = new g.OffscreenCanvas(8, 8); drawChecker(c.getContext('2d')); return c; }, font: 'IwnTest' };
const outDir = process.argv[3] ?? '/tmp/c2d-device';
mkdirSync(outDir, { recursive: true });
let pass = 0, fail = 0, missing = 0, identical = 0;
const lines: string[] = [];
for (const c of cases as any[]) {
  const parts = chunks.get(c.name);
  if (!parts || parts.some((p) => !p)) { missing++; lines.push(`${c.name}: MISSING`); continue; }
  const png = Buffer.from(parts.join(''), 'base64');
  writeFileSync(`${outDir}/${c.name}.png`, png);
  const dev = decodePng(png);
  const gold = decodePng(readFileSync(`${PKG}/web/canvas2d/test/golden/chrome/${c.name}.png`));
  const r = comparePixels(new Uint8ClampedArray(dev.data), gold.data, c.w, c.h);
  const cv = new g.OffscreenCanvas(c.w, c.h); const ctx = cv.getContext('2d'); c.draw(ctx, env);
  const host = ctx.getImageData(0, 0, c.w, c.h).data;
  let maxd = 0, ndiff = 0;
  for (let i = 0; i < host.length; i++) { const d = Math.abs(host[i]! - dev.data[i]!); if (d) ndiff++; maxd = Math.max(maxd, d); }
  if (ndiff === 0) identical++;
  const tol = c.tolerance ?? 0.02;
  const ok = r.fraction <= tol;
  ok ? pass++ : fail++;
  lines.push(`${c.name.padEnd(36)} vs chrome ${(r.fraction * 100).toFixed(2).padStart(6)} % (limit ${(tol * 100).toFixed(1)}) ${ok ? 'ok ' : 'FAIL'}  vs host: ${ndiff} channel values differ (max ${maxd})`);
}
console.log(lines.join('\n'));
const chrome = JSON.parse(readFileSync(`${PKG}/web/canvas2d/test/golden/chrome/metrics.json`, 'utf8')).metrics;
let wOk = 0;
metricRows.forEach((m, i) => { if (Math.abs(m.width - chrome[i].width) <= 0.05 * chrome[i].width) wOk++; });
const exact = metricRows.filter((m, i) => m.width === chrome[i].width).length;
console.log(`\n${cases.length} cases: ${pass} within tolerance, ${fail} over, ${missing} missing; ${identical} bit-identical to the host rendering`);
console.log(`metrics: ${metricRows.length} rows, widths within 5 %: ${wOk}, exactly equal to Chrome: ${exact}`);
