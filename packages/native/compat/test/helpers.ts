/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Inventory } from '../src/inventory.ts';
import { measuredSurface, type MeasuredSurface } from '../src/providers.ts';
import type { TraceResult } from '../src/trace-run.ts';
import type { ApiRecord, TraceDump } from '../src/tracer.ts';

const made: string[] = [];
function cleanup() {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}
// every temp dir a test made is removed when the test process exits, also when it is interrupted or killed by the
// runner's timeout (SIGTERM); SIGKILL cannot be caught, so the dirs carry a recognisable prefix (iwn-compat-)
process.once('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(sig, () => {
    cleanup();
    process.kill(process.pid, sig);
  });
}

export function tempDir(prefix = 'iwn-compat-'): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(d);
  return d;
}

export function writeTree(root: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

/** A small measured surface: V8 + glue-like + webgl-like layers + IWER members. */
export function fakeSurface(): MeasuredSurface {
  const inv: Inventory = {
    generatedAt: 'test',
    packageRoot: '/x',
    layers: [
      { layer: 'v8', how: 'eval', globals: ['Object', 'Intl', 'WebAssembly', 'console'], members: ['Intl.Segmenter', 'WebAssembly.instantiate', 'console.log'] },
      { layer: 'runtime/core', how: 'eval', globals: ['setTimeout', 'requestAnimationFrame'], members: [] },
      { layer: 'web/glue', how: 'eval', globals: ['URL', 'navigator', 'Navigator', 'EventTarget', 'TextDecoder', 'addEventListener'], members: ['URL.href', 'navigator.platform', 'EventTarget.addEventListener', 'TextDecoder.decode', 'Request.destination'] },
      { layer: 'web/canvas2d', how: 'eval', globals: ['OffscreenCanvas', 'CanvasRenderingContext2D'], members: ['OffscreenCanvas.getContext', 'CanvasRenderingContext2D.fillText', 'CanvasRenderingContext2D.filter'], stubs: ['CanvasRenderingContext2D.filter'] },
      { layer: 'web/webgl', how: 'eval', globals: ['WebGL2RenderingContext', 'WebGLActiveInfo'], members: ['WebGL2RenderingContext.drawElements'], tokens: ['OVR_multiview2'], fields: ['name', 'size'] },
      { layer: 'web/audio', how: 'source', file: 'web/audio/src', globals: [], members: [], tokens: ['AudioContext', 'createGain'] },
    ],
  };
  return measuredSurface(inv, ['XRSession', 'XRSession.requestAnimationFrame', 'XRFrame.getViewerPose', 'XRSystem.offerSession', 'XRSystem.requestSession', 'Navigator.xr', 'Gamepad', 'Gamepad.buttons']);
}

export function rec(over: Partial<ApiRecord> = {}): ApiRecord {
  return { calls: 1, xrCalls: 0, app: 1, tool: 0, none: 0, site: '/assets/index.js:1:1', phase: 'boot', ...over };
}

export function dump(apis: Record<string, ApiRecord>, role: 'main' | 'worker' = 'main'): TraceDump {
  return { role, url: 'http://127.0.0.1/', id: Math.random().toString(36).slice(2), phase: 'xr', xrFrames: 10, apis, skipped: [] };
}

export function trace(sample: string, main: Record<string, ApiRecord>, workers: Array<Record<string, ApiRecord>> = [], over: Partial<TraceResult> = {}): TraceResult & { sample: string } {
  return {
    sample,
    dist: `/x/${sample}/dist`,
    origin: 'http://127.0.0.1:1',
    reachedXR: true,
    enteredVia: 'offer',
    xrFrames: 10,
    bootMs: 1000,
    consoleErrors: [],
    pageErrors: [],
    blockedRequests: [],
    mirroredRequests: [],
    missingAssets: [],
    main: dump(main),
    workers: workers.map((w) => dump(w, 'worker')),
    webgl: { ok: true },
    ...over,
  };
}
