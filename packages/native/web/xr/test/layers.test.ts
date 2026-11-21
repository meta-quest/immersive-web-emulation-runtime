/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// XR-LAYER-1: quad and cylinder layers through the shipped prelude against fake natives: their swapchains, the
// texture each layer's sub-images report, and the frame's layer list in the buffer shared with the XR thread
// (src/layers.ts, runtime/xr/include/iwn/xr/layers.h).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COUNT_AT,
  E_A,
  E_B,
  E_C,
  E_FLAGS,
  E_ID,
  E_KIND,
  E_LAYOUT,
  E_POSE,
  ENTRIES_AT,
  FLAG_BLEND_ALPHA,
  FLAG_LISTED,
  FLAG_LOCATED,
  FLAG_REDRAWN,
  FLAG_VIEWER,
  KIND_CYLINDER,
  KIND_PROJECTION,
  KIND_QUAD,
  LAYER_ENTRY_WORDS,
  LAYOUT_MONO,
  LAYOUT_STEREO_ARRAY,
  NAMES_AT,
  NO_LIST,
} from '../src/layers.ts';
import { createHarness } from './harness.ts';

type H = ReturnType<typeof createHarness>;

async function start(h: H, features = "['layers', 'local-floor']") {
  h.g.__gl = h.gl;
  h.run(`globalThis.__session = null; navigator.xr.requestSession('immersive-vr', { optionalFeatures: ${features} })
    .then((s) => { globalThis.__session = s; }, (e) => { globalThis.__error = e; });`);
  await h.settle();
  assert.ok(
    h.run('globalThis.__session'),
    `session: ${h.run('String(globalThis.__error)')}`,
  );
  h.run(`
    globalThis.__binding = new XRWebGLBinding(__session, __gl);
    globalThis.__proj = __binding.createProjectionLayer({ textureType: 'texture-array' });
    __session.requestReferenceSpace('local').then((s) => { globalThis.__local = s; });
    __session.requestReferenceSpace('viewer').then((s) => { globalThis.__viewer = s; });
  `);
  await h.settle();
}

const entry = (h: H, i: number) => {
  const at = ENTRIES_AT + i * LAYER_ENTRY_WORDS;
  const u = h.layerWords.u32;
  const f = h.layerWords.f32;
  return {
    kind: u[at + E_KIND],
    id: u[at + E_ID],
    flags: u[at + E_FLAGS],
    layout: u[at + E_LAYOUT],
    pose: Array.from(f.subarray(at + E_POSE, at + E_POSE + 7)),
    a: f[at + E_A],
    b: f[at + E_B],
    c: f[at + E_C],
  };
};

test('XR-LAYER-1: createQuadLayer / createCylinderLayer make a swapchain per layer; a failed one is an OperationError', async () => {
  const h = createHarness();
  await start(h);
  h.run(`
    globalThis.__quad = __binding.createQuadLayer({ space: __local, viewPixelWidth: 512, viewPixelHeight: 256 });
    globalThis.__cyl = __binding.createCylinderLayer({ space: __local, viewPixelWidth: 300, viewPixelHeight: 100,
      layout: 'stereo', textureType: 'texture-array', isStatic: true });
    globalThis.__arr1 = __binding.createQuadLayer({ space: __local, viewPixelWidth: 64, viewPixelHeight: 32,
      textureType: 'texture-array' });
  `);
  assert.deepEqual(
    h.calls.filter((c) => c[0] === 'beginLayerSwapchain'),
    [
      ['beginLayerSwapchain', 2, 512, 256, 1, 0x8058, false, 1, false],
      ['beginLayerSwapchain', 3, 300, 100, 2, 0x8058, true, 1, true],
      // a mono 'texture-array' layer: an array of one layer, drawn through a TEXTURE_2D_ARRAY
      ['beginLayerSwapchain', 2, 64, 32, 1, 0x8058, false, 1, true],
    ],
  );
  h.run(`__session.updateRenderState({ layers: [__proj, __arr1] });
    __session.requestAnimationFrame((t, f) => { globalThis.__arrSub = __binding.getSubImage(__arr1, f); });`);
  h.frame();
  assert.equal(
    h.run('__arrSub.colorTexture._target'),
    0x8c1a,
    'TEXTURE_2D_ARRAY',
  );
  assert.equal(h.run('__arrSub.imageIndex'), 0);
  assert.equal(
    h.run('__quad instanceof XRQuadLayer && __cyl instanceof XRCylinderLayer'),
    true,
  );
  assert.equal(
    h.run('typeof XRWebGLBinding.prototype.createQuadLayer'),
    'function',
  );
  assert.throws(
    () =>
      h.run(
        '__binding.createQuadLayer({ space: __local, viewPixelWidth: 0.5, viewPixelHeight: 0.5 })',
      ),
    (e: Error) => e.name === 'TypeError',
  );
  // the fake XR thread refuses an image over its limit; IWER turns the null into OperationError
  assert.throws(
    () =>
      h.run(
        '__binding.createQuadLayer({ space: __local, viewPixelWidth: 5000, viewPixelHeight: 64 })',
      ),
    (e: Error) => e.name === 'OperationError',
  );
});

test('XR-LAYER-1: without the native layer calls or with a buffer of another layout, quad layers are NotSupportedError', async () => {
  for (const opts of [{ noLayers: true }, { layerBufferVersion: 99 }]) {
    const h = createHarness(opts);
    await start(h);
    assert.throws(
      () =>
        h.run(
          '__binding.createQuadLayer({ space: __local, viewPixelWidth: 64, viewPixelHeight: 64 })',
        ),
      (e: Error) => e.name === 'NotSupportedError',
    );
    if (opts.layerBufferVersion)
      assert.ok(
        h.logs.some((l) =>
          /composition layer buffer of another layout/.test(l),
        ),
      );
  }
});

test('XR-LAYER-1 / XR-SC-4: the frame list reaches the XR thread in renderState.layers order with shapes, poses and redraws', async () => {
  const h = createHarness();
  await start(h);
  h.run(`
    globalThis.__quad = __binding.createQuadLayer({ space: __local, viewPixelWidth: 512, viewPixelHeight: 256,
      width: 0.4, height: 0.2, transform: new XRRigidTransform({ x: 0, y: 0, z: -1 }), clearOnAccess: false });
    globalThis.__cyl = __binding.createCylinderLayer({ space: __viewer, viewPixelWidth: 64, viewPixelHeight: 64,
      radius: 1.5, centralAngle: 1, aspectRatio: 3, layout: 'stereo', textureType: 'texture-array' });
    __quad.blendTextureSourceAlpha = false;
    __session.updateRenderState({ layers: [__proj, __quad, __cyl] });
  `);
  // the list takes effect at the next frame; until a frame runs the buffer holds no list
  assert.equal(h.layerWords.u32[COUNT_AT], NO_LIST);
  h.run(
    '__session.requestAnimationFrame((t, f) => { __binding.getSubImage(__quad, f); })',
  );
  h.frame();
  assert.equal(h.layerWords.u32[COUNT_AT], 3);
  assert.equal(entry(h, 0).kind, KIND_PROJECTION);
  const q = entry(h, 1);
  assert.equal(q.kind, KIND_QUAD);
  assert.equal(q.id, 1);
  assert.equal(q.flags, FLAG_LISTED | FLAG_REDRAWN | FLAG_LOCATED); // blendTextureSourceAlpha turned off
  assert.equal(q.layout, LAYOUT_MONO);
  // the host's LOCAL pose (0.3, 1.5, -0.2) and the quad 1 m ahead of it; full size = twice the half-extents
  assert.deepEqual(
    q.pose.map((v) => Number(v.toFixed(4))),
    [0.3, 1.5, -1.2, 0, 0, 0, 1],
  );
  assert.deepEqual(
    [q.a, q.b].map((v) => Number(v.toFixed(4))),
    [0.8, 0.4],
  );
  const c = entry(h, 2);
  assert.equal(c.kind, KIND_CYLINDER);
  assert.equal(
    c.flags,
    FLAG_LISTED | FLAG_LOCATED | FLAG_BLEND_ALPHA | FLAG_VIEWER,
  ); // blending is the default
  assert.equal(c.layout, LAYOUT_STEREO_ARRAY);
  assert.deepEqual([c.a, c.b, c.c], [1.5, 1, 3]);
  assert.deepEqual(
    h.run(
      'JSON.stringify([__iwnXR.stats().layerSwapchains, __iwnXR.stats().layerEntries])',
    ),
    '[2,3]',
  );

  // a frame without a draw: nothing redrawn
  h.frame();
  assert.equal(entry(h, 1).flags & FLAG_REDRAWN, 0);

  // a frame IWER lists nothing for (hidden: no callbacks, no list) must not leave the last list in the buffer, or
  // the XR thread would release images for redraws of an earlier frame
  h.run(
    '__session.requestAnimationFrame((t, f) => { __binding.getSubImage(__quad, f); })',
  );
  h.frame();
  assert.equal(entry(h, 1).flags & FLAG_REDRAWN, FLAG_REDRAWN);
  h.events([{ type: 'visibilitychange', visible: false, focused: false }]);
  h.frame();
  assert.equal(h.layerWords.u32[COUNT_AT], NO_LIST);
});

test('XR-LAYER-1: a layer texture follows the image the XR thread acquired, is acquired at once in the creating frame, and is parked between frames', async () => {
  const h = createHarness();
  await start(h);
  h.run(`
    globalThis.__quad = __binding.createQuadLayer({ space: __local, viewPixelWidth: 64, viewPixelHeight: 64, clearOnAccess: false });
    __session.updateRenderState({ layers: [__proj, __quad] });
    __session.requestAnimationFrame((t, f) => {
      globalThis.__sub = __binding.getSubImage(__quad, f);
      globalThis.__first = __sub.colorTexture._name;
      // the app attaches the layer texture to a framebuffer of its own once
      globalThis.__lfb = { _attachments: new Map([[0x8ce0, { object: __sub.colorTexture }]]) };
      __gl.bindFramebuffer(0x8d40, __lfb);
    });
  `);
  h.frame();
  assert.deepEqual(
    h.calls.filter((c) => c[0] === 'acquireLayerImage'),
    [['acquireLayerImage', 1]],
  );
  assert.equal(h.run('__first'), 900);
  assert.equal(h.run('__sub.colorTexture._target'), 0x0de1);
  assert.equal(h.run('__sub.colorTexture._name'), 0, 'parked after the frame');

  // the XR thread put the next image in the buffer before the frame: the texture points at it during the frame,
  // and the app's framebuffer is re-pointed with it
  h.layerWords.u32[NAMES_AT + 0] = 777;
  h.run(
    '__session.requestAnimationFrame((t, f) => { globalThis.__inFrame = __binding.getSubImage(__quad, f).colorTexture._name; })',
  );
  h.retargets.length = 0;
  h.frame();
  assert.equal(h.run('__inFrame'), 777);
  assert.equal(
    h.calls.filter((c) => c[0] === 'acquireLayerImage').length,
    1,
    'no second acquire',
  );
  const quadTex = h.run('__sub.colorTexture');
  const mine = h.retargets.filter((r) => r.tex === quadTex);
  assert.deepEqual(
    mine.map((r) => r.name),
    [777, 0],
  );
  assert.ok(
    mine[0].fbs.includes(h.run('__lfb')),
    'the framebuffer holding the layer texture is re-pointed',
  );
});

test('XR-LAYER-1: destroy() releases the swapchain; the end of the session drops every layer texture', async () => {
  const h = createHarness();
  await start(h);
  h.run(`
    globalThis.__quad = __binding.createQuadLayer({ space: __local, viewPixelWidth: 64, viewPixelHeight: 64 });
    globalThis.__quad2 = __binding.createQuadLayer({ space: __local, viewPixelWidth: 64, viewPixelHeight: 64 });
    __session.updateRenderState({ layers: [__proj, __quad, __quad2] });
    __quad.destroy();
  `);
  assert.deepEqual(
    h.calls.filter((c) => c[0] === 'destroyLayerSwapchain'),
    [['destroyLayerSwapchain', 1]],
  );
  h.frame();
  assert.equal(
    h.layerWords.u32[COUNT_AT],
    2,
    'the destroyed layer is not listed',
  );
  assert.equal(entry(h, 1).id, 2);
  assert.equal(h.run('__iwnXR.stats().layerSwapchains'), 1);
  h.run('__session.end()');
  await h.settle();
  assert.equal(h.run('__iwnXR.stats().layerSwapchains'), 0);
  assert.equal(
    h.calls.filter((c) => c[0] === 'destroyLayerSwapchain').length,
    1,
    'the runtime drops the rest itself',
  );
});

test('XR-LAYER-1: an XRWebGLLayer session writes no list; a frame that drew only layers is fenced', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  h.run(`navigator.xr.requestSession('immersive-vr', {}).then((s) => { globalThis.__s = s;
    s.updateRenderState({ baseLayer: new XRWebGLLayer(s, __gl) }); });`);
  await h.settle();
  h.frame();
  assert.equal(h.layerWords.u32[COUNT_AT], NO_LIST);

  const l = createHarness();
  await start(l);
  l.run(`
    globalThis.__quad = __binding.createQuadLayer({ space: __local, viewPixelWidth: 64, viewPixelHeight: 64 });
    __session.updateRenderState({ layers: [__quad] });
  `);
  l.frame({ colorTexture: 0 });
  assert.ok(l.calls.some((c) => c[0] === 'endFrameGL'));
});
