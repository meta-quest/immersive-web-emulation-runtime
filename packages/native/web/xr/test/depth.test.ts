/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Depth sensing (docs/spec/08 XR-DEPTH-2) through the shipped prelude: the capability gate, negotiation, the native
// start call, and the depth record turned into XRWebGLDepthInformation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEPTH_RECORD_COUNT, DEPTH_VERSION, DepthRecordView } from '../src/depth.ts';
import { createHarness } from './harness.ts';

const dumpTool = process.env.IWN_XR_RECORD_DUMP ?? join(import.meta.dirname, '../../../build/host/xr/iwn_xr_record_dump');

const XR = 'navigator.xr';
const INIT = "{ requiredFeatures: ['depth-sensing'], depthSensing: { usagePreference: ['gpu-optimized'], dataFormatPreference: ['float32'] } }";

function depthHarness(info: Record<string, unknown> = {}) {
  const record = new Float64Array(DEPTH_RECORD_COUNT);
  const started: boolean[] = [];
  const h = createHarness({
    info: { passthrough: true, immersiveAr: true, depthSensing: true, depthHandRemoval: true, ...info },
    permissions: { 'com.oculus.permission.USE_SCENE': true },  // XR-PERM-1 asks for it before granting depth
    natives: {
      depthRecordVersion: DEPTH_VERSION,
      depthRecord: () => record.buffer,
      startDepth: (handRemoval: boolean) => started.push(handRemoval),
    },
  });
  return { h, record, started };
}

/** Writes one acquired image as the XR thread's write_depth_record does (depth_record.h). */
function writeDepth(record: Float64Array, texture: number): void {
  record[0] = DEPTH_VERSION;
  record[1] = 1;
  record[2] = texture;
  record[3] = 320;
  record[4] = 320;
  record[5] = 0.1;
  record[6] = Infinity;
  record.set([-0.03, 1.65, 0, 0, 0, 0, 1, -0.9, 0.9, 0.8, -0.8], 7);
  record.set([0.03, 1.65, 0, 0, 0, 0, 1, -0.9, 0.9, 0.8, -0.8], 18);
  record[29] = 0.05;
  record[30] += 1;
}

async function start(h: ReturnType<typeof createHarness>, init = INIT) {
  h.run(`globalThis.__s = null; ${XR}.requestSession('immersive-ar', ${init}).then((s) => { globalThis.__s = s; }, (e) => { globalThis.__e = e.name; });`);
  await h.settle();
}

test('XR-DEPTH-2: depth-sensing is offered only when the runtime has environment depth', async () => {
  const none = createHarness({ info: { passthrough: true, immersiveAr: true } });
  await start(none);
  assert.equal(none.run('globalThis.__e'), 'NotSupportedError');
  // the capability without a readable record (another layout version) offers nothing either
  const other = createHarness({
    info: { passthrough: true, immersiveAr: true, depthSensing: true },
    natives: { depthRecordVersion: DEPTH_VERSION + 1, depthRecord: () => new ArrayBuffer(DEPTH_RECORD_COUNT * 8) },
  });
  await start(other);
  assert.equal(other.run('globalThis.__e'), 'NotSupportedError');
});

test('XR-DEPTH-2: granted as gpu-optimized float32 (or unsigned-short), the native side is started without hand removal', async () => {
  const { h, started } = depthHarness();
  await start(h);
  assert.ok(h.run('globalThis.__s'), String(h.run('globalThis.__e')));
  assert.ok(h.run<string[]>('__s.enabledFeatures').includes('depth-sensing'));
  assert.equal(h.run('__s.depthUsage'), 'gpu-optimized');
  assert.equal(h.run('__s.depthDataFormat'), 'float32');
  // as Quest Browser: real hands occlude virtual content (the system's hand removal stays off)
  assert.deepEqual(started, [false]);
  // a page that only takes cpu-optimized gets no depth-sensing (required: rejected), and no permission dialog either
  const cpu = depthHarness();
  await start(cpu.h, "{ requiredFeatures: ['depth-sensing'], depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: [] } }");
  assert.equal(cpu.h.run('globalThis.__e'), 'NotSupportedError');
  assert.deepEqual(cpu.started, []);
  assert.equal(cpu.h.calls.filter((c) => c[0] === 'requestPermissions').length, 0);
  const optional = depthHarness();
  await start(optional.h, "{ optionalFeatures: ['depth-sensing'], depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: [] } }");
  assert.ok(!optional.h.run<string[]>('__s.enabledFeatures').includes('depth-sensing'));
  assert.equal(optional.h.calls.filter((c) => c[0] === 'requestPermissions').length, 0);
  // Quest Browser's own format, 'unsigned-short', is granted; 'luminance-alpha' (a packed encoding) is not
  const u16 = depthHarness();
  await start(u16.h, "{ requiredFeatures: ['depth-sensing'], depthSensing: { usagePreference: ['gpu-optimized'], dataFormatPreference: ['unsigned-short'] } }");
  assert.equal(u16.h.run('__s.depthDataFormat'), 'unsigned-short');
  const la = depthHarness();
  await start(la.h, "{ requiredFeatures: ['depth-sensing'], depthSensing: { usagePreference: ['gpu-optimized'], dataFormatPreference: ['luminance-alpha'] } }");
  assert.equal(la.h.run('globalThis.__e'), 'NotSupportedError');
});

test('XR-DEPTH-2: each frame the record becomes one depth information per eye on one re-pointed texture', async () => {
  const { h, record } = depthHarness();
  h.g.__gl = h.gl;
  await start(h);
  h.run(`
    globalThis.__binding = new XRWebGLBinding(__s, __gl);
    __s.updateRenderState({ layers: [__binding.createProjectionLayer({ textureType: 'texture-array' })] });
    __s.requestReferenceSpace('local').then((space) => { globalThis.__space = space; });
  `);
  await h.settle();
  const read = `
    globalThis.__seen = null;
    __s.requestAnimationFrame((t, frame) => {
      const views = frame.getViewerPose(__space).views;
      globalThis.__seen = views.map((v) => __binding.getDepthInformation(v));
    });`;

  // no image yet (the provider has not produced one): null
  h.run(read);
  h.frame();
  assert.deepEqual([...h.run<unknown[]>('__seen')], [null, null]);

  writeDepth(record, 501);
  h.run(read);
  h.frame();
  const first = h.run<Array<Record<string, any>>>('__seen');
  assert.equal(first.length, 2);
  for (const [i, info] of first.entries()) {
    assert.equal(info.textureType, 'texture-array');
    assert.equal(info.imageIndex, i);
    assert.equal(info.width, 320);
    assert.equal(info.depthNear, 0.1);
    assert.equal(info.depthFar, Infinity);
    assert.equal(info.rawValueToMeters, 1);
    assert.equal(info.texture._name, 501);
    assert.equal(info.texture._target, 0x8c1a);  // TEXTURE_2D_ARRAY
  }
  assert.equal(first[0].texture, first[1].texture);

  // the next image: the same texture object, pointed at the new GL name (three.js keeps the first one)
  writeDepth(record, 502);
  h.run(read);
  h.frame();
  const second = h.run<Array<Record<string, any>>>('__seen');
  assert.equal(second[0].texture, first[0].texture);
  assert.equal(second[0].texture._name, 502);
  assert.equal(h.glCalls.filter((c) => c[0] === 'wrapTexture' && c[2] === 0x8c1a).length, 1);

  // tools read the record (DBG: __iwnXR.depth())
  const state = h.run<Record<string, unknown>>('__iwnXR.depth()');
  assert.equal(state.valid, true);
  assert.equal(state.texture, 502);
  assert.equal(state.images, 2);

  // the image went away (tracking lost): null again, the frame goes on
  record[1] = 0;
  h.run(read);
  h.frame();
  assert.deepEqual([...h.run<unknown[]>('__seen')], [null, null]);
  assert.deepEqual(h.reported, []);

  // the session ends: the texture points at no image
  h.run('__s.end()');
  await h.settle();
  assert.equal(second[0].texture._name, 0);
});

test('XR-DEPTH-2: while depth sensing runs, the framebuffer holding the session image is cleared as each frame begins', async () => {
  const { h, record } = depthHarness();
  h.g.__gl = h.gl;
  await start(h);
  h.run(`
    globalThis.__binding = new XRWebGLBinding(__s, __gl);
    globalThis.__layer = __binding.createProjectionLayer({ textureType: 'texture-array' });
    __s.updateRenderState({ layers: [__layer] });
    __s.requestReferenceSpace('local').then((space) => { globalThis.__space = space; });
  `);
  await h.settle();
  writeDepth(record, 501);
  h.run(`
    __s.requestAnimationFrame((t, frame) => {
      const sub = __binding.getViewSubImage(__layer, frame.getViewerPose(__space).views[0]);
      globalThis.__fb = { _attachments: new Map([[0x8ce0, { object: sub.colorTexture }]]) };
      globalThis.__other = { _attachments: new Map() };
      __gl.bindFramebuffer(0x8d40, __other);
      __gl.bindFramebuffer(0x8d40, __fb);
    });
  `);
  h.frame({ colorTexture: 41 });
  assert.equal(h.glCalls.filter((c) => c[0] === 'clearSessionFramebuffer').length, 0);  // not tracked before
  h.frame({ colorTexture: 42 });
  const clears = h.glCalls.filter((c) => c[0] === 'clearSessionFramebuffer');
  assert.equal(clears.length, 1);
  assert.equal(clears[0][1], h.run('__fb'));  // only the one that renders into the image
  // after the re-pointing, before the page's callbacks
  const at = h.glCalls.findIndex((c) => c[0] === 'clearSessionFramebuffer');
  const retarget = h.glCalls.findIndex((c, i) => i > 0 && c[0] === 'retargetTexture' && c[1] === 42);
  assert.ok(retarget >= 0 && retarget < at);
  assert.equal(h.run('__iwnXR.stats().clears'), 1);

  // a session without depth sensing is left to the page (three.js clears itself then)
  const vr = createHarness();
  vr.g.__gl = vr.gl;
  vr.run(`${XR}.requestSession('immersive-vr', { optionalFeatures: ['layers'] }).then((s) => { globalThis.__s = s; })`);
  await vr.settle();
  vr.run(`
    globalThis.__binding = new XRWebGLBinding(__s, __gl);
    globalThis.__layer = __binding.createProjectionLayer({ textureType: 'texture-array' });
    __s.updateRenderState({ layers: [__layer] });
    __s.requestReferenceSpace('local').then((space) => { globalThis.__space = space; });
  `);
  await vr.settle();
  vr.run(`
    __s.requestAnimationFrame((t, frame) => {
      const sub = __binding.getViewSubImage(__layer, frame.getViewerPose(__space).views[0]);
      globalThis.__fb = { _attachments: new Map([[0x8ce0, { object: sub.colorTexture }]]) };
      __gl.bindFramebuffer(0x8d40, __fb);
    });
  `);
  vr.frame({ colorTexture: 41 });
  vr.frame({ colorTexture: 42 });
  assert.equal(vr.glCalls.filter((c) => c[0] === 'clearSessionFramebuffer').length, 0);
});

test('XR-DEPTH-2: a depth-sensing session whose depth never comes (provider refused) is not cleared', async () => {
  const { h, record, started } = depthHarness();
  h.g.__gl = h.gl;
  await start(h);
  assert.deepEqual(started, [false]);
  h.run(`
    globalThis.__binding = new XRWebGLBinding(__s, __gl);
    globalThis.__layer = __binding.createProjectionLayer({ textureType: 'texture-array' });
    __s.updateRenderState({ layers: [__layer] });
    __s.requestReferenceSpace('local').then((space) => { globalThis.__space = space; });
  `);
  await h.settle();
  // the record stays invalid (no USE_SCENE: xrCreateEnvironmentDepthProviderMETA failed)
  h.run(`
    globalThis.__seen = [];
    const loop = (t, frame) => {
      const pose = frame.getViewerPose(__space);
      const sub = __binding.getViewSubImage(__layer, pose.views[0]);
      globalThis.__fb = globalThis.__fb || { _attachments: new Map([[0x8ce0, { object: sub.colorTexture }]]) };
      __gl.bindFramebuffer(0x8d40, __fb);
      __seen.push(__binding.getDepthInformation(pose.views[0]));
      __s.requestAnimationFrame(loop);
    };
    __s.requestAnimationFrame(loop);
  `);
  h.frame({ colorTexture: 41 });
  h.frame({ colorTexture: 42 });
  h.frame({ colorTexture: 41 });
  assert.deepEqual([...h.run<unknown[]>('__seen')], [null, null, null]);
  assert.equal(h.glCalls.filter((c) => c[0] === 'clearSessionFramebuffer').length, 0);
  assert.equal(h.run('__iwnXR.stats().clears'), 0);
  // the first depth handed out turns the clears on, from that frame (before its callbacks) to the end of the session
  writeDepth(record, 501);
  const from = h.glCalls.length;
  h.frame({ colorTexture: 42 });
  const frame = h.glCalls.slice(from);
  const clear = frame.findIndex((c) => c[0] === 'clearSessionFramebuffer');
  assert.equal(frame.filter((c) => c[0] === 'clearSessionFramebuffer').length, 1);
  assert.ok(clear < frame.findIndex((c) => c[0] === 'bindFramebuffer'));  // before the page's callback draws
  record[1] = 0;  // a frame without an image (NOT_AVAILABLE): three.js keeps its depth texture, so still cleared
  h.frame({ colorTexture: 41 });
  assert.equal(h.glCalls.filter((c) => c[0] === 'clearSessionFramebuffer').length, 2);
});

test('XR-DEPTH-2: an XRWebGLLayer session with depth gets the frame image of its layer framebuffer cleared', async () => {
  const { h, record } = depthHarness();
  h.g.__gl = h.gl;
  await start(h);
  h.run('globalThis.__wl = new XRWebGLLayer(__s, __gl); __s.updateRenderState({ baseLayer: __wl })');
  await h.settle();
  const fb = h.run('__wl.framebuffer');
  h.run(`
    globalThis.__binding = new XRWebGLBinding(__s, __gl);
    __s.requestReferenceSpace('local').then((space) => { globalThis.__space = space; });
  `);
  await h.settle();
  h.run(`
    const loop = (t, frame) => {
      __binding.getDepthInformation(frame.getViewerPose(__space).views[0]);
      __gl.bindFramebuffer(0x8d40, __wl.framebuffer);
      __s.requestAnimationFrame(loop);
    };
    __s.requestAnimationFrame(loop);
  `);
  h.frame({ colorTexture: 41 });  // no depth yet: left to the page
  assert.equal(h.glCalls.filter((c) => c[0] === 'clearSessionFramebuffer').length, 0);
  writeDepth(record, 501);
  const from = h.glCalls.length;
  h.frame({ colorTexture: 42 });
  const frame = h.glCalls.slice(from);
  const clears = frame.filter((c) => c[0] === 'clearSessionFramebuffer');
  assert.equal(clears.length, 1);
  assert.equal(clears[0][1], fb);
  // after IWER attached this frame's image to the layer framebuffer, before the callback
  const attach = frame.findIndex((c) => c[0] === 'framebufferTexture2D' && (c[2] as { _name: number })?._name === 42);
  const clear = frame.findIndex((c) => c[0] === 'clearSessionFramebuffer');
  assert.ok(attach >= 0 && attach < clear);
  assert.ok(clear < frame.findIndex((c, i) => i > clear && c[0] === 'bindFramebuffer' && c[2] === fb));
});

test('XR-DEPTH-2: a depth record the native writer made reads back field by field (the two hand-written layouts agree)', { skip: !existsSync(dumpTool) && `build ${dumpTool} (runtime host build, target iwn_xr_record_dump)` }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'iwn-xr-depth-'));
  const file = join(dir, 'depth.bin');
  try {
    execFileSync(dumpTool, ['--depth', file]);
    const bytes = readFileSync(file);
    assert.equal(bytes.length, DEPTH_RECORD_COUNT * 8, 'the record size');
    const view = new DepthRecordView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    const depth = view.read((name) => ({ name }));
    assert.ok(depth, 'valid, with the version this adapter reads');
    assert.deepEqual(depth.texture, { name: 77 });
    assert.deepEqual([depth.width, depth.height, depth.depthNear, depth.depthFar], [320, 288, Math.fround(0.1), Infinity]);
    const views = Array.from(depth.views, (v) => Math.round(v * 1e6) / 1e6);
    assert.deepEqual(views, [
      -0.031, 1.65, 0.02, 0, 0.258819, 0, 0.965926, -0.95, 0.85, 0.8, -0.75,
      0.033, 1.66, -0.01, 0, 0.258819, 0, 0.965926, -0.85, 0.95, 0.81, -0.76,
    ]);
    const state = view.state();
    assert.equal(state.acquireMs, 0.25);
    assert.equal(state.images, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('XR-DEPTH-2: the next session after a depth session starts without frame-start clears until its own depth comes', async () => {
  const { h, record } = depthHarness();
  h.g.__gl = h.gl;
  const session = async () => {
    await start(h);
    h.run(`
      globalThis.__binding = new XRWebGLBinding(__s, __gl);
      globalThis.__layer = __binding.createProjectionLayer({ textureType: 'texture-array' });
      __s.updateRenderState({ layers: [__layer] });
      __s.requestReferenceSpace('local').then((space) => { globalThis.__space = space; });
    `);
    await h.settle();
    h.run(`
      globalThis.__loop = (t, frame) => {
        const pose = frame.getViewerPose(__space);
        const sub = __binding.getViewSubImage(__layer, pose.views[0]);
        globalThis.__fb = { _attachments: new Map([[0x8ce0, { object: sub.colorTexture }]]) };
        __gl.bindFramebuffer(0x8d40, __fb);
        __binding.getDepthInformation(pose.views[0]);
        __s.requestAnimationFrame(__loop);
      };
      __s.requestAnimationFrame(__loop);
    `);
  };
  const clears = () => h.glCalls.filter((c) => c[0] === 'clearSessionFramebuffer').length;
  await session();
  writeDepth(record, 501);
  h.frame({ colorTexture: 41 });
  h.frame({ colorTexture: 42 });
  assert.ok(clears() > 0, 'the first session, with depth, is cleared');
  h.run('__s.end()');
  await h.settle();
  // the second session's provider is refused: nothing to clear for (the page clears its own frames)
  record[1] = 0;
  const before = clears();
  await session();
  h.frame({ colorTexture: 41 });
  h.frame({ colorTexture: 42 });
  h.frame({ colorTexture: 41 });
  assert.equal(clears(), before);
});
