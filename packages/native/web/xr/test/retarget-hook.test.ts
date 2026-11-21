/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The WebGL prelude's retargetTexture hook (web/webgl/host.ts), which this adapter calls up to twice per XR frame
// (re-point at the frame's image, park after the fence; XR-SC-2/3): the GL calls it makes for every attachment kind,
// and no allocation per call (PERF-ALLOC-1: ~0 per-frame allocation on the host + IWER path). The probe runs
// in a child process with a fixed 64 MB young generation, so a GC in the measured window means the hook allocated.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const probe = join(dirname(fileURLToPath(import.meta.url)), 'retarget-probe.mjs');
const FLAGS = ['--min-semi-space-size=64', '--max-semi-space-size=64', '--expose-gc'];

function run(mode: string): any {
  return JSON.parse(execFileSync(process.execPath, [...FLAGS, probe, mode], { encoding: 'utf8', timeout: 60000 }));
}

const DRAW = 0x8ca9;
const C0 = 0x8ce0;
const C1 = 0x8ce1;

test('XR-SC-2 / REG-6: retargetTexture re-binds the units and re-attaches every attachment kind, restoring bindings once', () => {
  const r = run('calls');
  assert.deepEqual(r.toName, [
    // units in target order (2D, cube, 3D, 2D array), then the active unit back
    ['activeTexture', 0x84c0 + 5], ['bindTexture', 0x0de1, 42],
    ['activeTexture', 0x84c0 + 2], ['bindTexture', 0x8c1a, 42],
    ['activeTexture', 0x84c0 + 3],
    // framebuffers in list order, attachments in insertion order; other textures untouched
    ['bindFramebuffer', DRAW, 10], ['framebufferTextureMultisampleMultiviewOVR', DRAW, C0, 42, 0, 4, 0, 2],
    ['bindFramebuffer', DRAW, 11], ['framebufferTextureMultiviewOVR', DRAW, C0, 42, 0, 0, 2],
    ['bindFramebuffer', DRAW, 11], ['framebufferTextureLayer', DRAW, C1, 42, 0, 1],
    ['bindFramebuffer', DRAW, 12], ['framebufferTextureLayer', DRAW, C0, 42, 0, 1],
    ['bindFramebuffer', DRAW, 13], ['framebufferTexture2DMultisampleEXT', DRAW, C0, 0x0de1, 42, 0, 4],
    ['bindFramebuffer', DRAW, 14], ['framebufferTexture2D', DRAW, C0, 0x0de1, 42, 0],
    ['restore'],
  ]);
  assert.equal(r.nameAfter, 42);
  assert.deepEqual(r.unchanged, []);
  // any iterable works (parking to no image here)
  assert.equal(r.parkFromSet.length, r.toName.length);
  assert.deepEqual(r.parkFromSet[1], ['bindTexture', 0x0de1, 0]);
  assert.deepEqual(r.parkFromSet.at(-2), ['framebufferTexture2D', DRAW, C0, 0x0de1, 0, 0]);
  // no listed framebuffer holds it: units only, no framebuffer binding restored
  assert.deepEqual(r.unitsOnly.map((c: unknown[]) => c[0]), ['activeTexture', 'bindTexture', 'activeTexture', 'bindTexture', 'activeTexture']);
});

test('XR-SC-2/3: retargetTexture allocates nothing per call (re-point + park every frame)', () => {
  let r: { bytesPerCall: number; gcs: number } = { bytesPerCall: NaN, gcs: -1 };
  for (let attempt = 0; attempt < 3; attempt++) {
    r = run('alloc');
    if (r.gcs === 0 && r.bytesPerCall < 4) break;
  }
  assert.equal(r.gcs, 0, `GCs during 100,000 calls: ${r.gcs} (the hook allocates)`);
  assert.ok(r.bytesPerCall < 4, `${r.bytesPerCall.toFixed(2)} bytes per call`);
});
