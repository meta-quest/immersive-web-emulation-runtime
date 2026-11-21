/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// C2D-12 micro-benchmark: a 512x128 label (clear, pill, outline, 20-character text) through the JS layer and the
// native core. Host numbers are indicative only; the requirement is < 2 ms on Quest 3.
//   IWN_CANVAS2D_ADDON=.../canvas2d.node node web/canvas2d/tools/bench-label.ts
import { loadNatives, makeGlobal } from '../test/helpers.ts';

const n = loadNatives();
if (!n) throw new Error('canvas2d addon not found (IWN_CANVAS2D_ADDON)');
const g = makeGlobal(n);
const ctx = new g.OffscreenCanvas(512, 128).getContext('2d');
function label(i: number): void {
  ctx.clearRect(0, 0, 512, 128);
  ctx.fillStyle = 'rgba(20, 24, 40, 0.85)';
  ctx.beginPath();
  ctx.roundRect(4, 4, 504, 120, 60);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#7cf';
  ctx.stroke();
  ctx.font = 'bold 48px IwnTest';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Showcase label #${String(i % 1000).padStart(4, '0')}`, 256, 64);
}
for (let i = 0; i < 50; i++) label(i);
const N = 500;
const t0 = performance.now();
for (let i = 0; i < N; i++) label(i);
const ms = (performance.now() - t0) / N;
console.log(`512x128 label, 20 chars: ${ms.toFixed(3)} ms per draw (host)`);
