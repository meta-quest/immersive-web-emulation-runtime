/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The emulator's frame (the main `iwer` entry, no host): a guard that host
// mode work does not slow the browser emulator down. Runs IWER's own
// requestAnimationFrame-driven frame loop under jsdom, with the window's
// requestAnimationFrame captured so frames are pumped by hand, two emulated
// controllers, and a page that reads the viewer pose, the viewports, both
// controllers' poses and gamepads every frame. Prints one JSON line.
//
//   node --expose-gc bench/emulator-bench.mjs [--bundle build/iwer.module.js] [--frames N]

import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { statSync } from 'node:fs';

import { BenchDOMPointReadOnly } from './env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = {
  bundle: resolve(here, '../build/iwer.module.js'),
  frames: 20000,
  warmup: 10000,
  block: 200,
};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === '--bundle') args.bundle = resolve(process.argv[++i]);
  else if (key === '--frames') args.frames = Number(process.argv[++i]);
  else if (key === '--warmup') args.warmup = Number(process.argv[++i]);
  else throw new Error(`unknown option ${key}`);
}

// jsdom comes with jest-environment-jsdom (a devDependency)
const requireFromJest = createRequire(
  createRequire(import.meta.url).resolve('jest-environment-jsdom'),
);
const { JSDOM } = requireFromJest('jsdom');
const dom = new JSDOM('<!doctype html><body></body>', {
  pretendToBeVisual: true,
  url: 'https://localhost/',
});
const win = dom.window;
let pending = null;
Object.assign(globalThis, {
  window: win,
  document: win.document,
  HTMLElement: win.HTMLElement,
  HTMLCanvasElement: win.HTMLCanvasElement,
  Event: win.Event,
  EventTarget: win.EventTarget,
  localStorage: win.localStorage,
  DOMPointReadOnly: BenchDOMPointReadOnly,
  requestAnimationFrame: (cb) => {
    pending = cb;
    return 1;
  },
  cancelAnimationFrame: () => {
    pending = null;
  },
});

const iwer = await import(pathToFileURL(args.bundle).href);
const device = new iwer.XRDevice(iwer.metaQuest3, {
  visibilityMask: null,
  stereoEnabled: true,
});
device.installRuntime({ globalObject: {} });
const session = await navigator.xr.requestSession('immersive-vr', {
  requiredFeatures: ['local-floor'],
});
const canvas = win.document.createElement('canvas');
const gl = {
  canvas,
  drawingBufferWidth: 1832,
  drawingBufferHeight: 1920,
  COLOR_CLEAR_VALUE: 0x0c22,
  DEPTH_CLEAR_VALUE: 0x0b73,
  STENCIL_CLEAR_VALUE: 0x0b91,
  DEPTH_BUFFER_BIT: 0x100,
  COLOR_BUFFER_BIT: 0x4000,
  STENCIL_BUFFER_BIT: 0x400,
  getParameter: (p) =>
    p === 0x0c22 ? new Float32Array(4) : p === 0x0b73 ? 1 : 0,
  clearColor: () => {},
  clearDepth: () => {},
  clearStencil: () => {},
  clear: () => {},
};
const layer = new iwer.XRWebGLLayer(session, gl);
session.updateRenderState({ baseLayer: layer });
const refSpace = await session.requestReferenceSpace('local-floor');

const out = new Float32Array(64);
let sink = 0;
const onXRFrame = (_t, frame) => {
  session.requestAnimationFrame(onXRFrame);
  const pose = frame.getViewerPose(refSpace);
  if (pose) {
    out.set(pose.transform.matrix, 0);
    for (const view of pose.views) {
      const vp = layer.getViewport(view);
      sink += vp.width;
      out.set(view.transform.matrix, 16);
      out.set(view.projectionMatrix, 32);
    }
  }
  for (const source of session.inputSources) {
    const grip = source.gripSpace && frame.getPose(source.gripSpace, refSpace);
    if (grip) out.set(grip.transform.matrix, 48);
    const ray = frame.getPose(source.targetRaySpace, refSpace);
    if (ray) out.set(ray.transform.matrix, 48);
    const gp = source.gamepad;
    if (gp) {
      for (const b of gp.buttons) sink += b.value + (b.pressed ? 1 : 0);
      for (const a of gp.axes) sink += a ?? 0;
    }
  }
};
session.requestAnimationFrame(onXRFrame);

let n = 0;
const step = () => {
  n++;
  const c = device.controllers.right;
  c.position.x = 0.2 + 0.01 * Math.sin(n * 0.01);
  const cb = pending;
  pending = null;
  cb(performance.now());
};

for (let i = 0; i < args.warmup; i++) step();
globalThis.gc?.();
const times = new Float64Array(args.frames);
for (let i = 0; i < args.frames; i++) {
  const t0 = performance.now();
  step();
  times[i] = (performance.now() - t0) * 1e6;
}
times.sort();
const q = (p) =>
  times[Math.min(times.length - 1, Math.floor(p * times.length))];
globalThis.gc?.();
const perFrame = [];
for (let b = 0; b < Math.floor(args.frames / args.block); b++) {
  const before = getHeapStatistics().used_heap_size;
  for (let i = 0; i < args.block; i++) step();
  const after = getHeapStatistics().used_heap_size;
  if (after >= before) perFrame.push((after - before) / args.block);
}
perFrame.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    v8: process.versions.v8,
    node: process.version,
    bundle: args.bundle,
    bundleBytes: statSync(args.bundle).size,
    scenario: 'emulator',
    frames: args.frames,
    ns: { median: q(0.5), p95: q(0.95), p99: q(0.99) },
    allocBytesPerFrame: perFrame.length
      ? {
          median: perFrame[Math.floor(perFrame.length / 2)],
          blocks: perFrame.length,
        }
      : null,
    sink: sink > 0,
  }),
);
