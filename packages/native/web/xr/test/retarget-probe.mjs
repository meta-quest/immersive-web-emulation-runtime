/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Child process for retarget-hook.test.ts: drives the WebGL prelude's retargetTexture (web/webgl/host.ts) against a
// fake context with the internal surface it touches, and prints JSON.
//   node --max-semi-space-size=64 retarget-probe.mjs calls   -> { calls }: the GL calls for every attachment kind
//   node --max-semi-space-size=64 retarget-probe.mjs alloc   -> { bytesPerCall, gcs }: heap growth per call, with
//                                                               the number of GCs that ran in the measured window
// IWN_RETARGET_HOST overrides the module path (to compare another version of host.ts).
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';

const hostUrl = process.env.IWN_RETARGET_HOST
  ? new URL(process.env.IWN_RETARGET_HOST, `file://${process.cwd()}/`).href
  : new URL('../../webgl/host.ts', import.meta.url).href;
const { retargetTexture } = await import(hostUrl);

const TEXTURE_2D = 0x0de1;
const TEXTURE_2D_ARRAY = 0x8c1a;
const COLOR0 = 0x8ce0;
const COLOR1 = 0x8ce1;
const DEPTH = 0x8d00;
const att = (object, o = {}) => ({
  object,
  textarget: 0,
  level: 0,
  layer: 0,
  numViews: 0,
  baseViewIndex: 0,
  samples: 0,
  ...o,
});
const fb = (name, entries) => ({ _name: name, _attachments: new Map(entries) });

function context(natives) {
  const units = () => new Array(16).fill(null);
  return {
    _n: natives,
    _skip: () => false,
    _activeUnit: 3,
    _tex2D: units(),
    _texCube: units(),
    _tex3D: units(),
    _tex2DArray: units(),
    _restoreFramebufferBindings: natives.restore,
  };
}

const mode = process.argv[2];
if (mode === 'calls') {
  const calls = [];
  const rec =
    (name) =>
    (...a) => {
      calls.push([name, ...a]);
    };
  const natives = {};
  for (const k of [
    'activeTexture',
    'bindTexture',
    'bindFramebuffer',
    'framebufferTextureMultisampleMultiviewOVR',
    'framebufferTextureLayer',
    'framebufferTextureMultiviewOVR',
    'framebufferTexture2DMultisampleEXT',
    'framebufferTexture2D',
    'restore',
  ])
    natives[k] = rec(k);
  const gl = context(natives);
  const tex = { _name: 41 };
  const other = { _name: 7 };
  gl._tex2D[5] = tex;
  gl._tex2DArray[2] = tex;
  gl._texCube[1] = other;
  const fbs = [
    fb(10, [
      [COLOR0, att(tex, { numViews: 2, samples: 4 })],
      [DEPTH, att(other, { numViews: 2, samples: 4 })],
    ]),
    fb(11, [
      [COLOR0, att(tex, { numViews: 2 })],
      [COLOR1, att(tex, { numViews: 1, baseViewIndex: 1 })],
    ]),
    fb(12, [[COLOR0, att(tex, { textarget: TEXTURE_2D_ARRAY, layer: 1 })]]),
    fb(13, [[COLOR0, att(tex, { textarget: TEXTURE_2D, samples: 4 })]]),
    fb(14, [[COLOR0, att(tex, { textarget: TEXTURE_2D })]]),
    fb(15, [[COLOR0, att(other, { textarget: TEXTURE_2D })]]),
  ];
  const out = {};
  retargetTexture(gl, tex, 42, fbs);
  out.toName = calls.splice(0);
  out.nameAfter = tex._name;
  retargetTexture(gl, tex, 42, fbs); // unchanged name: nothing
  out.unchanged = calls.splice(0);
  retargetTexture(gl, tex, 0, new Set(fbs)); // any iterable (park)
  out.parkFromSet = calls.splice(0);
  retargetTexture(gl, tex, 43, [fbs[5]]); // no framebuffer holds it: units only, no restore
  out.unitsOnly = calls.splice(0);
  console.log(JSON.stringify(out));
} else if (mode === 'alloc') {
  const noop = function () {};
  const natives = {};
  for (const k of [
    'activeTexture',
    'bindTexture',
    'bindFramebuffer',
    'framebufferTextureMultisampleMultiviewOVR',
    'framebufferTextureLayer',
    'framebufferTextureMultiviewOVR',
    'framebufferTexture2DMultisampleEXT',
    'framebufferTexture2D',
    'restore',
  ])
    natives[k] = noop;
  const gl = context(natives);
  const tex = { _name: 41 };
  const depth = { _name: 9 };
  // the projection layer's shape: three's XR target (MSAA multiview colour + depth) and one other target
  const fbs = [
    fb(10, [
      [COLOR0, att(tex, { numViews: 2, samples: 4 })],
      [DEPTH, att(depth, { numViews: 2, samples: 4 })],
    ]),
    fb(11, [
      [COLOR0, att({ _name: 5 }, { textarget: TEXTURE_2D })],
      [DEPTH, att({ _name: 6 }, { textarget: TEXTURE_2D })],
    ]),
  ];
  const N = 100000;
  const loop = (count) => {
    for (let i = 0; i < count; i++) {
      retargetTexture(gl, tex, 42 + (i % 3), fbs); // re-point at this frame's image ...
      retargetTexture(gl, tex, 0, fbs); // ... and park it after the fence
    }
  };
  loop(20000); // warm-up: every tier
  globalThis.gc?.();
  let gcs = 0;
  const obs = new PerformanceObserver((list) => {
    gcs += list.getEntries().length;
  });
  obs.observe({ entryTypes: ['gc'] });
  await new Promise((r) => setTimeout(r, 20));
  gcs = 0;
  const before = v8.getHeapStatistics().used_heap_size;
  loop(N / 2);
  const after = v8.getHeapStatistics().used_heap_size;
  await new Promise((r) => setTimeout(r, 20));
  obs.disconnect();
  console.log(JSON.stringify({ bytesPerCall: (after - before) / N, gcs }));
} else {
  console.error('usage: retarget-probe.mjs calls|alloc');
  process.exit(2);
}
