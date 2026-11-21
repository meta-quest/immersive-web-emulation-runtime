/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// C2D-12 allocation probe, run by unit.test.ts in a child process:
//   node --expose-gc --min-semi-space-size=64 --max-semi-space-size=64 alloc-probe.ts
// Each operation is warmed up (inline caches, optimised code), then run N times between two heap measurements with
// a young generation large enough that no scavenge can happen in between (checked: the probe reports GCs seen). The
// result is JS-heap bytes per call; the parent asserts the budgets.

import { performance, PerformanceObserver } from 'node:perf_hooks';
import { loadNatives, makeGlobal } from './helpers.ts';

const n = loadNatives();
if (!n) {
  console.log(JSON.stringify({ skipped: 'canvas2d addon not built' }));
  process.exit(0);
}
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with --expose-gc');

const g = makeGlobal(n);
const ctx = new g.OffscreenCanvas(512, 128).getContext('2d');
const src = new g.OffscreenCanvas(32, 32);
src.getContext('2d').fillRect(0, 0, 32, 32);
ctx.font = '48px IwnTest';
// An image-module source (ImageBitmap / HTMLImageElement): its provider returns one reused descriptor, as web/image does.
const providerPixels = new Uint8Array(16 * 16 * 4).fill(255);
const providerDescriptor = { kind: 'pixels', origin: 'bitmap', width: 16, height: 16, premultiplied: true, data: providerPixels };
const provider = { width: 16, height: 16, [Symbol.for('iwn.image.source')]: () => providerDescriptor };

// GC start times; any GC inside a measured window would make that window's number meaningless.
const gcTimes: number[] = [];
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) gcTimes.push(e.startTime);
});
obs.observe({ entryTypes: ['gc'] });
const windows: [string, number, number][] = [];

const ops: Record<string, () => void> = {
  'fillStyle = "#ffffff"': () => {
    ctx.fillStyle = '#ffffff';
  },
  'font = same string': () => {
    ctx.font = 'bold 48px IwnTest';
  },
  'fillRect': () => {
    ctx.fillRect(1, 2, 3, 4);
  },
  'setTransform(6 args)': () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  },
  'rotate + transform + resetTransform': () => {
    ctx.rotate(0.1);
    ctx.transform(1, 0, 0, 1, 2, 3);
    ctx.resetTransform();
  },
  'translate + scale + save/restore': () => {
    ctx.save();
    ctx.translate(1, 2);
    ctx.scale(2, 2);
    ctx.restore();
  },
  'beginPath + arc + fill': () => {
    ctx.beginPath();
    ctx.arc(64, 64, 20, 0, Math.PI * 2);
    ctx.fill();
  },
  'beginPath + roundRect(number) + fill': () => {
    ctx.beginPath();
    ctx.roundRect(8, 8, 200, 60, 12);
    ctx.fill();
  },
  'beginPath + roundRect([a, b]) + stroke': () => {
    ctx.beginPath();
    ctx.roundRect(8, 8, 200, 60, RADII);
    ctx.stroke();
  },
  'quadraticCurveTo + bezierCurveTo + rect': () => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(10, 10, 20, 0);
    ctx.bezierCurveTo(30, 10, 40, 10, 50, 0);
    ctx.rect(0, 0, 10, 10);
  },
  'drawImage(canvas, x, y)': () => {
    ctx.drawImage(src, 4, 4);
  },
  'drawImage(canvas, 9 args)': () => {
    ctx.drawImage(src, 0, 0, 16, 16, 4, 4, 32, 32);
  },
  'fillText (font + fillStyle re-assigned)': () => {
    ctx.font = 'bold 48px IwnTest';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Hello, label 42', 16, 80);
  },
  'label redraw': () => {
    ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = 'rgba(20, 20, 30, 0.85)';
    ctx.beginPath();
    ctx.roundRect(4, 4, 504, 120, 24);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.font = 'bold 48px IwnTest';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Hello, label 42', 256, 64);
  },
  'measureText (TextMetrics result only)': () => {
    ctx.measureText('Hello');
  },
  // Multi-font labels (title + body): every fillText follows a font change.
  'alternate two fonts + fillText': () => {
    ctx.font = (flip = !flip) ? 'bold 48px IwnTest' : '24px IwnTest';
    ctx.fillText('Hello', 16, 80);
  },
  'save; font = bold; fillText; restore; fillText': () => {
    ctx.save();
    ctx.font = 'bold 30px IwnTest';
    ctx.fillText('Title', 16, 40);
    ctx.restore();
    ctx.fillText('body', 16, 100);
  },
  'measureText after a font switch (TextMetrics result only)': () => {
    ctx.font = (flip = !flip) ? 'bold 48px IwnTest' : '24px IwnTest';
    ctx.measureText('Hello');
  },
  // The caller's array is hoisted: a literal at the call site is the caller's allocation, not the context's.
  'setLineDash(same values) + stroke': () => {
    ctx.setLineDash(DASH);
    ctx.strokeRect(10, 10, 100, 50);
  },
  'setLineDash([])': () => {
    ctx.setLineDash(NO_DASH);
  },
  'save + rect + clip + fillRect + restore': () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(10, 10, 200, 60);
    ctx.clip();
    ctx.fillRect(0, 0, 300, 100);
    ctx.restore();
  },
  'nested clips (clip; save; clip; restore)': () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(10, 10, 200, 60);
    ctx.clip();
    ctx.save();
    ctx.beginPath();
    ctx.rect(20, 20, 50, 30);
    ctx.clip();
    ctx.fillRect(0, 0, 300, 100);
    ctx.restore();
    ctx.restore();
  },
  'drawImage(image-source provider, 3 args)': () => {
    ctx.drawImage(provider, 4, 4);
  },
  'letterSpacing / wordSpacing = same strings + fillText': () => {
    ctx.letterSpacing = '1px';
    ctx.wordSpacing = '0.1em';
    ctx.fillText('A b', 10, 60);
  },
};
const RADII = [4, 8];
const DASH = [4, 2];
const NO_DASH: number[] = [];
let flip = false;

const N = 4000;
const results: Record<string, number> = {};
// Steady state: four rounds per operation (the optimising tiers kick in during the first).
for (const [name, fn] of Object.entries(ops)) {
  // Warm-up sized to ~150 ms of calls per round (2,000 to 30,000 calls) so the top JIT tier is reached.
  const t = performance.now();
  for (let i = 0; i < 200; i++) fn();
  const per = (performance.now() - t) / 200;
  const warm = Math.max(2000, Math.min(30000, Math.round(150 / Math.max(per, 1e-4))));
  // The smallest of the last three rounds counts: a real per-call allocation shows in every round, while code the
  // JIT installs during a round (old-space growth unrelated to the call) only shows in one.
  let best = Infinity;
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < warm; i++) fn();
    gc();
    gc();
    const t0 = performance.now();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) fn();
    const after = process.memoryUsage().heapUsed;
    if (round > 0) {
      windows.push([name, t0, performance.now()]);
      best = Math.min(best, (after - before) / N);
    }
  }
  results[name] = best;
}
// Let the observer deliver the GC entries, then flag measurements that a GC interrupted.
await new Promise((r) => setTimeout(r, 50));
obs.disconnect();
const interrupted = windows.filter(([, a, b]) => gcTimes.some((t) => t >= a && t <= b)).map(([name]) => name);
console.log(JSON.stringify({ results, interrupted }));
