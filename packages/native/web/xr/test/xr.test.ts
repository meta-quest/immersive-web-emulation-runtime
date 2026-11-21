/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Behaviour of the shipped XR prelude against fake natives (HL-1 style): spec IDs in each test name.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HAND_F32, HAND_U32, HAND_U8 } from '../src/layout.gen.ts';
import { createHarness, writeController } from './harness.ts';

const XR = 'navigator.xr';

async function startSession(h: ReturnType<typeof createHarness>, init = "{ optionalFeatures: ['layers', 'hand-tracking'] }") {
  h.run(`globalThis.__session = null; ${XR}.requestSession('immersive-vr', ${init}).then((s) => { globalThis.__session = s; }, (e) => { globalThis.__error = e; });`);
  await h.settle();
  const s = h.run('globalThis.__session');
  assert.ok(s, `session: ${h.run('String(globalThis.__error)')}`);
  return s;
}

function makeProjectionLayer(h: ReturnType<typeof createHarness>, textureType = 'texture-array') {
  return h.run(`
    globalThis.__binding = new XRWebGLBinding(globalThis.__session, globalThis.__gl);
    globalThis.__layer = __binding.createProjectionLayer({ textureType: '${textureType}', colorFormat: 0x8058 });
    __session.updateRenderState({ layers: [__layer] });
    __layer;
  `);
}

test('XR-INIT-3 / DBG-STAGE: navigator.xr exists before page scripts; support answers follow the capabilities', async () => {
  const h = createHarness();
  assert.equal(h.run(`typeof ${XR}.requestSession`), 'function');
  assert.equal(h.run(`typeof ${XR}.offerSession`), 'function');
  h.run(`Promise.all(['inline', 'immersive-vr', 'immersive-ar'].map((m) => ${XR}.isSessionSupported(m))).then((r) => { globalThis.__r = r; })`);
  await h.settle();
  assert.deepEqual([...h.run<boolean[]>('__r')], [true, true, false]);

  // immersive-ar needs passthrough and the opt-in (xr.immersiveAr, XR-AR-1 is a later milestone)
  const pt = createHarness({ info: { passthrough: true } });
  pt.run(`${XR}.isSessionSupported('immersive-ar').then((r) => { globalThis.__r = r; })`);
  await pt.settle();
  assert.equal(pt.run('__r'), false);
  pt.run(`${XR}.requestSession('immersive-ar').catch((e) => { globalThis.__e = e.name; })`);
  await pt.settle();
  assert.equal(pt.run('__e'), 'NotSupportedError');
  const ar = createHarness({ info: { passthrough: true, immersiveAr: true } });
  ar.run(`${XR}.isSessionSupported('immersive-ar').then((r) => { globalThis.__r = r; })`);
  await ar.settle();
  assert.equal(ar.run('__r'), true);

  const none = createHarness({ info: { available: false, error: 'no headset' } });
  none.run(`${XR}.isSessionSupported('immersive-vr').then((r) => { globalThis.__r = r; })`);
  await none.settle();
  assert.equal(none.run('__r'), false);
  // offerSession can be replaced by plain assignment and the replacement is what later calls reach (DBG-STAGE)
  h.run(`${XR}.offerSession = function () { globalThis.__held = true; return new Promise(() => {}); }; ${XR}.offerSession('immersive-vr');`);
  assert.equal(h.run('globalThis.__held'), true);
});

test('XR-LIFE-1 / XR-SEC-1: required unsupported features reject, optional ones are dropped, enabledFeatures lists grants', async () => {
  const h = createHarness();
  h.run(`${XR}.requestSession('immersive-vr', { requiredFeatures: ['dom-overlay'] }).catch((e) => { globalThis.__e = e.name; })`);
  await h.settle();
  assert.equal(h.run('__e'), 'NotSupportedError');
  const s = await startSession(h, "{ requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking', 'camera-access', 'layers'] }");
  void s;
  const features = [...h.run<string[]>('__session.enabledFeatures')].sort();
  assert.ok(features.includes('local-floor') && features.includes('hand-tracking') && features.includes('layers'));
  assert.ok(!features.includes('camera-access'));
  assert.deepEqual(h.calls.find((c) => c[0] === 'sessionStarted'), ['sessionStarted', false, true, false, false]);
  // a second request while one is active
  h.run(`${XR}.requestSession('immersive-vr').catch((e) => { globalThis.__e2 = e.name; })`);
  await h.settle();
  assert.equal(h.run('__e2'), 'InvalidStateError');
});

test('XR-LIFE-1 / XR-SPACE-1: later features are not granted; anchors reject; bounded-floor needs a boundary', async () => {
  const h = createHarness();
  h.run(`${XR}.requestSession('immersive-vr', { requiredFeatures: ['anchors'] }).catch((e) => { globalThis.__e = e.name; })`);
  await h.settle();
  assert.equal(h.run('__e'), 'NotSupportedError');
  for (const f of ['plane-detection', 'mesh-detection', 'hit-test', 'depth-sensing']) {
    h.run(`globalThis.__e = null; ${XR}.requestSession('immersive-vr', { requiredFeatures: ['${f}'] }).catch((e) => { globalThis.__e = e.name; })`);
    await h.settle();
    assert.equal(h.run('__e'), 'NotSupportedError', f);
  }
  h.g.__gl = h.gl;
  await startSession(h, "{ optionalFeatures: ['layers', 'anchors', 'local-floor', 'bounded-floor'] }");
  assert.ok(!h.run<string[]>('__session.enabledFeatures').includes('anchors'));
  assert.ok(h.run<string[]>('__session.enabledFeatures').includes('bounded-floor'));  // the harness has a stage
  makeProjectionLayer(h);
  h.run(`
    __session.requestReferenceSpace('local-floor').then((space) => {
      __session.requestAnimationFrame((t, frame) => {
        frame.createAnchor(new XRRigidTransform(), space).then(() => { globalThis.__anchor = 'created'; }, (e) => { globalThis.__anchor = e.name + ': ' + e.message; });
      });
    });
    __session.restorePersistentAnchor('x').catch((e) => { globalThis.__restore = e.name; });
  `);
  await h.settle();
  h.frame();
  await h.settle();
  assert.match(String(h.run('globalThis.__anchor')), /^NotSupportedError: XRFrame.createAnchor/);
  assert.equal(h.run('globalThis.__restore'), 'NotSupportedError');

  const noStage = createHarness({ info: { hasStage: false } });
  noStage.run(`${XR}.requestSession('immersive-vr', { requiredFeatures: ['bounded-floor'] }).catch((e) => { globalThis.__e = e.name; })`);
  await noStage.settle();
  assert.equal(noStage.run('__e'), 'NotSupportedError');
});

test('XR-LIFE-2: offerSession is granted at once by default; explicit-grant mode holds it until grantSession()', async () => {
  const h = createHarness();
  h.run(`${XR}.offerSession('immersive-vr', {}).then((s) => { globalThis.__offered = s; })`);
  await h.settle();
  assert.ok(h.run('globalThis.__offered'));
  assert.ok(h.calls.some((c) => c[0] === 'offered'));

  const e = createHarness({ info: { explicitGrant: true } });
  e.run(`${XR}.offerSession('immersive-vr', {}).then((s) => { globalThis.__offered = s; })`);
  await e.settle();
  assert.equal(e.run('globalThis.__offered'), undefined);
  e.run('__iwnXR.grantSession()');
  await e.settle();
  assert.ok(e.run('globalThis.__offered'));
  // with no offer pending it is a no-op
  e.run('__iwnXR.grantSession()');
  await e.settle();
});

test('XRF-B-1 / XR-SC-1: the first layer creates the swapchain (texture-array: 2 layers, texture and XRWebGLLayer: 1)', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h);
  const layer = makeProjectionLayer(h);
  assert.deepEqual(h.calls.filter((c) => c[0] === 'beginSwapchain'), [['beginSwapchain', 2, 1, 0x8058, -1, false, false]]);
  assert.equal(h.run('__layer.textureWidth'), 1680);
  assert.equal(h.run('__layer.textureArrayLength'), 2);
  void layer;

  const w = createHarness();
  w.g.__gl = w.gl;
  await startSession(w, '{}');
  w.run('globalThis.__wl = new XRWebGLLayer(__session, __gl); __session.updateRenderState({ baseLayer: __wl })');
  assert.equal(w.calls.filter((c) => c[0] === 'beginSwapchain')[0][1], 1);
  assert.equal(w.run('__wl.framebufferWidth'), 3360);
  // the pending render state becomes active at the next frame
  w.frame();
  assert.equal(w.run('__session.renderState.baseLayer === __wl'), true);
});

test('XRF-B-1: a swapchain the runtime cannot create is an OperationError', async () => {
  const h = createHarness({ swapchain: null });
  h.g.__gl = h.gl;
  await startSession(h);
  assert.throws(() => makeProjectionLayer(h), (e: Error) => e.name === 'OperationError');
});

test('XR-LOOP-1 / XR-SC-2 / GL-PERF-5: a frame runs the session callbacks, then window rAF, then invalidation and the fence', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h, "{ optionalFeatures: ['layers', 'local-floor'] }");
  makeProjectionLayer(h);
  h.run(`
    globalThis.__order = [];
    __session.requestReferenceSpace('local-floor').then((space) => { globalThis.__space = space; });
  `);
  await h.settle();
  h.run(`
    __session.requestAnimationFrame((t, frame) => {
      __order.push('xr');
      const pose = frame.getViewerPose(__space);
      globalThis.__views = pose.views.length;
      globalThis.__sub = __binding.getViewSubImage(__layer, pose.views[0]);
      globalThis.__sub1 = __binding.getViewSubImage(__layer, pose.views[1]);
      // the app attaches the opaque texture to its framebuffer once
      globalThis.__fb = { _attachments: new Map([[0x8ce0, { object: __sub.colorTexture }]]) };
      __gl.bindFramebuffer(0x8d40, __fb);
      globalThis.__t = t;
    });
  `);
  h.frame({ colorTexture: 41, time: 2000 });
  assert.deepEqual([...h.run<string[]>('__order')], ['xr']);
  assert.equal(h.run('__views'), 2);
  assert.equal(h.run('__t'), 2000);  // the predicted display time (XR-LOOP-5, open question 12)
  assert.equal(h.run('__sub.colorTexture === __sub1.colorTexture'), true);  // one opaque texture per session
  assert.equal(h.run('__sub.imageIndex'), 0);
  assert.equal(h.run('__sub1.imageIndex'), 1);
  assert.equal(h.run('__sub.colorTexture._target'), 0x8c1a);
  const window = h.calls.findIndex((c) => c[0] === 'runWindowFrame');
  const fence = h.calls.findIndex((c) => c[0] === 'endFrameGL');
  assert.ok(window >= 0 && fence > window, 'window rAF before the fence');
  assert.ok(h.glCalls.some((c) => c[0] === 'afterAnimationFrame'));
  assert.ok(h.glCalls.some((c) => c[0] === 'frameBoundary'));
  const lastMakeCurrent = h.glCalls.map((c) => c[0]).lastIndexOf('_makeCurrent');
  assert.ok(lastMakeCurrent >= 0, 'the session context is made current before the fence');
  assert.ok(h.glCalls.some((c) => c[0] === 'invalidateDepthStencil' && c[1] === h.run('__fb')));

  // next frame: a new image name; the opaque texture follows it before the callbacks run and the attaching
  // framebuffer is re-pointed; after each frame it points at no image (XR-SC-3, parked)
  h.run('__session.requestAnimationFrame(() => { globalThis.__nameInFrame = __sub.colorTexture._name; })');
  h.frame({ colorTexture: 42 });
  assert.equal(h.run('__nameInFrame'), 42);
  const retargets = h.glCalls.filter((c) => c[0] === 'retargetTexture');
  assert.deepEqual(retargets, [['retargetTexture', 0, 1], ['retargetTexture', 42, 1], ['retargetTexture', 0, 1]]);
  assert.equal(h.run('__sub.colorTexture._name'), 0);
});

test('XR-SC-3: between frames the projection image is parked; drawing outside a frame reaches no image', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h, "{ optionalFeatures: ['layers', 'local-floor'] }");
  makeProjectionLayer(h);
  h.run(`__session.requestReferenceSpace('local-floor').then((space) => { globalThis.__space = space; });`);
  await h.settle();
  h.run(`
    __session.requestAnimationFrame((t, frame) => {
      globalThis.__sub = __binding.getViewSubImage(__layer, frame.getViewerPose(__space).views[0]);
      globalThis.__fb = { _attachments: new Map([[0x8ce0, { object: __sub.colorTexture }]]) };
      __gl.bindFramebuffer(0x8d40, __fb);
    });
  `);
  h.frame({ colorTexture: 41 });
  // the park comes after the fence: the image the XR thread is about to release is detached last
  const fence = h.calls.findIndex((c) => c[0] === 'endFrameGL');
  assert.ok(fence >= 0);
  assert.equal(h.retargets.at(-1)?.name, 0);
  assert.equal(h.retargets.at(-1)?.fbs[0], h.run('__fb'));
  assert.equal(h.run('__iwnXR.stats().parks'), 1);
  // a frame without an image (none acquired) leaves it parked
  h.run('__session.requestAnimationFrame(() => { globalThis.__inFrame = __sub.colorTexture._name; })');
  h.frame({ colorTexture: 0 });
  assert.equal(h.run('__inFrame'), 0);
  // the image returns at the next frame that has one, before the callbacks
  h.run('__session.requestAnimationFrame(() => { globalThis.__inFrame = __sub.colorTexture._name; })');
  h.frame({ colorTexture: 43 });
  assert.equal(h.run('__inFrame'), 43);
  assert.equal(h.run('__sub.colorTexture._name'), 0);
});

test('XR-SC-3: an XRWebGLLayer framebuffer loses its image between frames and gets it back, also a repeated one', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h, '{}');
  h.run('globalThis.__wl = new XRWebGLLayer(__session, __gl); __session.updateRenderState({ baseLayer: __wl })');
  const fb = h.run('__wl.framebuffer') as { _attachments: Map<number, { object: { _name: number } }> };
  const colour = () => fb._attachments.get(0x8ce0)?.object;
  h.frame({ colorTexture: 41 });  // IWER attaches the image's wrapper; the frame end parks it
  const w41 = colour();
  assert.ok(w41);
  assert.equal(w41._name, 41);  // the binding's record keeps the wrapper and its name ...
  const park = h.retargets.at(-1)!;
  assert.deepEqual([park.name, park.tex, park.fbs[0]], [0, w41, fb]);  // ... while GL lost the attachment
  // the XR thread hands out the same image again (a frame JS never began keeps its image): IWER attaches nothing,
  // the bridge re-attaches it before the callbacks
  const before = h.retargets.length;
  h.run('__session.requestAnimationFrame(() => {})');
  h.frame({ colorTexture: 41 });
  const back = h.retargets[before];
  assert.deepEqual([back.name, back.tex, back.fbs[0]], [41, w41, fb]);
  assert.equal(h.retargets.at(-1)?.name, 0);  // parked again after that frame
  // a different image: the parked one goes back, then IWER attaches the new wrapper
  h.run('__session.requestAnimationFrame(() => {})');
  h.frame({ colorTexture: 42 });
  assert.equal(colour()?._name, 42);
  assert.notEqual(colour(), w41);
  assert.equal(w41._name, 41);
  // a frame without an image re-attaches nothing (the released image stays parked)
  const parkedCount = h.retargets.length;
  h.run('__session.requestAnimationFrame(() => {})');
  h.frame({ colorTexture: 0 });
  assert.equal(h.retargets.length, parkedCount);
});

test('XR-SC-2 / XR-SC-3: the framebuffer holding the session image stays re-pointed however many others the app binds', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h, "{ optionalFeatures: ['layers', 'local-floor'] }");
  makeProjectionLayer(h);
  h.run(`__session.requestReferenceSpace('local-floor').then((space) => { globalThis.__space = space; });`);
  await h.settle();
  // every frame the app binds its XR target, then 40 other framebuffers (MSAA targets, cube cameras, post passes)
  h.run(`
    globalThis.__others = Array.from({ length: 40 }, () => ({ _attachments: new Map() }));
    const cb = (t, frame) => {
      __session.requestAnimationFrame(cb);
      if (!globalThis.__fb) {
        globalThis.__sub = __binding.getViewSubImage(__layer, frame.getViewerPose(__space).views[0]);
        globalThis.__fb = { _attachments: new Map([[0x8ce0, { object: __sub.colorTexture }]]) };
      }
      __gl.bindFramebuffer(0x8d40, __fb);
      for (const o of __others) __gl.bindFramebuffer(0x8d40, o);
      __gl.bindFramebuffer(0x8d40, null);
    };
    __session.requestAnimationFrame(cb);
  `);
  h.frame({ colorTexture: 41 });
  const fb = h.run('__fb');
  assert.ok(h.retargets.at(-1)!.fbs.includes(fb), 'parked after its first frame');
  for (let i = 0; i < 3; i++) {
    const before = h.retargets.length;
    h.frame({ colorTexture: 42 + i });
    const [repoint, park] = h.retargets.slice(before);
    assert.equal(repoint.name, 42 + i);
    assert.ok(repoint.fbs.includes(fb), `frame ${i + 2}: the XR target follows the image`);
    assert.equal(park.name, 0);
    assert.ok(park.fbs.includes(fb), `frame ${i + 2}: the XR target is parked`);
    assert.ok(repoint.fbs.length <= 32, `the list stays bounded (${repoint.fbs.length})`);
  }
});

test('XR-SC-2: a framebuffer bound before the binding existed is re-pointed when it gets the session image', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h, "{ optionalFeatures: ['layers', 'local-floor'] }");
  h.run('globalThis.__fb = { _attachments: new Map() }; __gl.bindFramebuffer(0x8d40, __fb);');  // still unwatched
  makeProjectionLayer(h);
  h.run(`__session.requestReferenceSpace('local-floor').then((space) => { globalThis.__space = space; });`);
  await h.settle();
  // attached in the first frame while still bound from before: no new bind
  h.run(`
    __session.requestAnimationFrame((t, frame) => {
      const sub = __binding.getViewSubImage(__layer, frame.getViewerPose(__space).views[0]);
      __fb._attachments.set(0x8ce0, { object: sub.colorTexture });
    });
  `);
  h.frame({ colorTexture: 41 });
  assert.ok(h.retargets.at(-1)!.fbs.includes(h.run('__fb')));
});

test('XR-LOOP-3: an exception in an XR callback is reported; later callbacks run and the frame is fenced', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h);
  makeProjectionLayer(h);
  h.run(`
    __session.requestAnimationFrame(() => { throw new Error('boom'); });
    __session.requestAnimationFrame(() => { globalThis.__second = true; });
  `);
  h.frame();
  assert.equal(h.run('globalThis.__second'), true);
  assert.equal(h.reported.length, 1);
  assert.match(String(h.reported[0]), /boom/);
  assert.ok(h.calls.some((c) => c[0] === 'endFrameGL'));
});

test('XR-LIFE-4 / XRF-B-3: visibility, frame rate and reset events reach the session', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h);
  h.run(`
    globalThis.__vis = [];
    __session.addEventListener('visibilitychange', () => __vis.push(__session.visibilityState));
    globalThis.__rates = [];
    __session.addEventListener('frameratechange', () => __rates.push(__session.frameRate));
  `);
  makeProjectionLayer(h);
  h.events([{ type: 'visibilitychange', visible: true, focused: false }]);
  h.events([{ type: 'visibilitychange', visible: true, focused: false }]);  // no change, no event
  h.events([{ type: 'visibilitychange', visible: false, focused: false }]);
  h.events([{ type: 'visibilitychange', visible: true, focused: true }]);
  assert.deepEqual([...h.run<string[]>('__vis')], ['visible-blurred', 'hidden', 'visible']);
  h.events([{ type: 'frameratechange', rate: 90 }]);
  assert.deepEqual([...h.run<number[]>('__rates')], [90]);
});

test('XR-RATE-1: updateTargetFrameRate asks the runtime, resolves once the display reports the rate, rejects otherwise', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h);
  makeProjectionLayer(h);
  h.frame({ frameRate: 72 });
  assert.deepEqual([...h.run<Float32Array>('__session.supportedFrameRates')], [72, 90, 120]);
  h.run(`__session.updateTargetFrameRate(90).then(() => { globalThis.__ok = __session.frameRate; })`);
  h.run(`__session.updateTargetFrameRate(75).catch((e) => { globalThis.__bad = e.name; })`);
  await h.settle();
  assert.ok(h.calls.some((c) => c[0] === 'requestFrameRate' && c[1] === 90));
  assert.equal(h.run('globalThis.__bad'), 'InvalidStateError');
  assert.equal(h.run('globalThis.__ok'), undefined);
  h.frame({ frameRate: 90 });
  await h.settle();
  assert.equal(h.run('globalThis.__ok'), 90);
});

test('XR-LIFE-5 / XRF-B-2: end() from a callback finishes the frame first; the runtime hears endSession once', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h);
  makeProjectionLayer(h);
  h.run(`
    globalThis.__ends = 0;
    __session.addEventListener('end', () => __ends++);
    __session.requestAnimationFrame(() => { __session.end().then(() => { globalThis.__ended = true; }); });
  `);
  h.frame();
  assert.equal(h.calls.filter((c) => c[0] === 'endSession').length, 0);  // not inside the frame
  assert.ok(h.calls.some((c) => c[0] === 'endFrameGL'));
  await h.settle(5);
  assert.equal(h.calls.filter((c) => c[0] === 'endSession').length, 1);
  assert.equal(h.run('__ends'), 1);
  assert.equal(h.run('globalThis.__ended'), true);
  // frames after the end still run window rAF (idle path)
  const before = h.calls.filter((c) => c[0] === 'runWindowFrame').length;
  h.frame();
  assert.equal(h.calls.filter((c) => c[0] === 'runWindowFrame').length, before + 1);
});

test('XR-LIFE-5: a system-initiated end fires end once and never calls back into the runtime', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h);
  h.run(`globalThis.__ends = 0; __session.addEventListener('end', () => __ends++);`);
  h.events([{ type: 'end' }]);
  await h.settle();
  assert.equal(h.run('__ends'), 1);
  assert.equal(h.calls.filter((c) => c[0] === 'endSession').length, 0);
  // a new session can start right away (XR-IDLE-3)
  await startSession(h, '{}');
});

test('TMR-5 / XR-IDLE-2: a tick runs window rAF only', () => {
  const h = createHarness();
  h.tick();
  assert.deepEqual(h.calls.filter((c) => c[0] === 'runWindowFrame').length, 1);
  assert.ok(h.glCalls.some((c) => c[0] === 'afterAnimationFrame'));
  assert.ok(!h.calls.some((c) => c[0] === 'endFrameGL'));
});

test('XRF-IN-1 / IN-2 / IN-3: controller state from the record becomes an input source with select events', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h);
  makeProjectionLayer(h);
  h.run(`
    globalThis.__log = [];
    __session.addEventListener('inputsourceschange', (e) => __log.push('change+' + e.added.length + '-' + e.removed.length));
    __session.addEventListener('selectstart', (e) => __log.push('selectstart:' + e.inputSource.handedness));
    __session.addEventListener('select', (e) => __log.push('select:' + e.inputSource.handedness));
    __session.addEventListener('selectend', (e) => __log.push('selectend:' + e.inputSource.handedness));
  `);
  writeController(h.record, 1, { trigger: 0.9, pressed: true, stick: [0.5, -0.25] });
  h.frame();  // appears: no press on the frame the source appears (HOST-INPUT)
  h.frame();  // pressed
  writeController(h.record, 1, { trigger: 0.1, pressed: false });
  h.frame();
  await h.settle();
  assert.deepEqual([...h.run<string[]>('__log')], ['change+1-0', 'selectstart:right', 'select:right', 'selectend:right']);
  const profiles = [...h.run<string[]>('[...__session.inputSources][0].profiles')];
  // IN-2: Quest Browser 156's list for Touch Plus (Meta's virtual controllers on a Quest 3 and a Quest 3S)
  assert.deepEqual(profiles, ['meta-quest-touch-plus', 'oculus-touch-v3', 'oculus-touch-v2', 'oculus-touch', 'generic-trigger-squeeze-thumbstick']);
  assert.equal(h.run('[...__session.inputSources][0].gamepad.mapping'), 'xr-standard');
});

test('XRF-IN-1 / IN-5: hand mode lists a hand only when the session enabled hand-tracking', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h, "{ optionalFeatures: ['layers', 'hand-tracking'] }");
  makeProjectionLayer(h);
  writeController(h.record, 0, { mode: 2 });
  h.record.u32[HAND_U32.inputFlags[0]] = 1 | 4;  // target ray + palm (no grip for a hand)
  for (let j = 0; j < 25; j++) {
    h.record.f32.set([0.1 + j * 0.01, 1.2, -0.3, 0, 0, 0, 1, 0.01], HAND_F32.joints[0] + j * 8);
    h.record.u8[HAND_U8.jointValid[0] + j] = 1;
  }
  h.frame();
  h.frame();
  assert.equal(h.run('[...__session.inputSources].filter((s) => s.hand).length'), 1);
  assert.equal(h.run('[...__session.inputSources].find((s) => s.hand).handedness'), 'left');

  // the same state without hand-tracking enabled lists nothing for that hand
  const n = createHarness();
  n.g.__gl = n.gl;
  await startSession(n, "{ optionalFeatures: ['layers'] }");
  makeProjectionLayer(n);
  writeController(n.record, 0, { mode: 2 });
  n.frame();
  n.frame();
  assert.equal(n.run('__session.inputSources.length'), 0);
});

test('IN-2: a tracked hand used as a pointer (no hand-tracking) is a hand-profile source without joints, not a controller', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h, "{ optionalFeatures: ['layers'] }");
  makeProjectionLayer(h);
  h.run(`
    globalThis.__log = [];
    __session.addEventListener('selectstart', (e) => __log.push('selectstart:' + e.inputSource.handedness));
  `);
  // hand_pointer: controller mode with the hand's profile (hand_interaction_ext), pinch at 0, menu gesture at 7
  writeController(h.record, 0, { profile: 5, trigger: 1, pressed: true });
  h.record.f32[HAND_F32.buttonValues[0] + 7] = 1;
  h.record.u8[HAND_U8.buttonPressed[0] + 7] = 1;
  h.frame();
  h.frame();
  await h.settle();
  const src = '[...__session.inputSources][0]';
  assert.equal(h.run('__session.inputSources.length'), 1);
  assert.deepEqual([...h.run<string[]>(`${src}.profiles`)], ['oculus-hand', 'generic-hand', 'generic-hand-select', 'generic-trigger']);
  assert.equal(h.run(`${src}.hand`), undefined);
  assert.equal(h.run(`${src}.gamepad.buttons.length`), 10);
  assert.equal(h.run(`${src}.gamepad.buttons[4].pressed`), true);
  assert.deepEqual([...h.run<string[]>('__log')], ['selectstart:left']);
});

test('IN-7: a gamepad pulse reaches the runtime and resolves true after the duration', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h);
  makeProjectionLayer(h);
  writeController(h.record, 1, {});
  h.frame();
  h.frame();
  h.run(`[...__session.inputSources][0].gamepad.hapticActuators[0].pulse(0.7, 30).then((r) => { globalThis.__pulse = r; })`);
  const call = h.calls.find((c) => c[0] === 'haptic');
  assert.deepEqual(call, ['haptic', 1, 0.7, 30, 0]);
  await h.settle(10);
  assert.equal(h.run('globalThis.__pulse'), undefined);
  await h.settle(40);
  assert.equal(h.run('globalThis.__pulse'), true);
});

test('XR-FOV-1: fixedFoveation reaches the runtime; the startup feature string sets the swapchain request', async () => {
  const h = createHarness();
  h.g.__gl = h.gl;
  await startSession(h, "{ optionalFeatures: ['layers', 'medium-fixed-foveation-level'] }");
  makeProjectionLayer(h);
  const req = h.calls.find((c) => c[0] === 'beginSwapchain');
  assert.ok(Math.abs((req![4] as number) - 2 / 3) < 1e-9);
  h.run('__layer.fixedFoveation = 1');
  assert.ok(h.calls.some((c) => c[0] === 'setFoveation' && c[1] === 1));
  assert.equal(h.run('__layer.fixedFoveation'), 1);
});

test('XRF-4: a record laid out differently disables immersive sessions and says why', async () => {
  const h = createHarness({ layoutVersion: 999 });
  h.run(`${XR}.isSessionSupported('immersive-vr').then((r) => { globalThis.__r = r; })`);
  await h.settle();
  assert.equal(h.run('__r'), false);
  assert.ok(h.logs.some((l) => /layout mismatch/.test(l) && /999/.test(l)));
  assert.equal(h.handler(), null);
});

test('XR-LIFE-7: window load tells the runtime the entry was evaluated', () => {
  const h = createHarness();
  (h as unknown as { load(): void }).load();
  assert.ok(h.calls.some((c) => c[0] === 'entryEvaluated'));
});

test('XR-LIFE-7: the runtime hears when every pending request was rejected and no session exists', async () => {
  const h = createHarness();
  const life = (x: ReturnType<typeof createHarness>) =>
    x.calls.filter((c) => c[0] === 'offered' || c[0] === 'offerRejected').map((c) => c[0]);
  h.run(`${XR}.requestSession('immersive-vr', { requiredFeatures: ['hit-test'] }).catch((e) => { globalThis.__e = e.name; })`);
  await h.settle();
  assert.equal(h.run('__e'), 'NotSupportedError');
  assert.deepEqual(life(h), ['offered', 'offerRejected']);
  // immersive-ar without the opt-in, offered this time
  h.run(`${XR}.offerSession('immersive-ar').catch((e) => { globalThis.__e2 = e.name; })`);
  await h.settle();
  assert.equal(h.run('__e2'), 'NotSupportedError');
  assert.deepEqual(life(h), ['offered', 'offerRejected', 'offered', 'offerRejected']);
  // a later request that succeeds is a session (XR-LIFE-5 from then on)
  await startSession(h, '{}');
  assert.ok(h.calls.some((c) => c[0] === 'sessionStarted'));

  // a held offer keeps counting while another request is rejected
  const e = createHarness({ info: { explicitGrant: true } });
  e.run(`${XR}.offerSession('immersive-vr', {}); ${XR}.requestSession('immersive-vr', { requiredFeatures: ['anchors'] }).catch(() => {});`);
  await e.settle();
  assert.deepEqual(life(e), ['offered', 'offered']);
  // and a request refused because a session is active is no reason either
  e.run('__iwnXR.grantSession()');
  await e.settle();
  e.run(`${XR}.requestSession('immersive-vr').catch((x) => { globalThis.__e3 = x.name; })`);
  await e.settle();
  assert.equal(e.run('__e3'), 'InvalidStateError');
  assert.ok(!e.calls.some((c) => c[0] === 'offerRejected'));
});

test('IN-9: navigator.getGamepads() lists no gamepads (XR gamepads come through XRInputSource)', async () => {
  const h = createHarness();
  assert.equal(h.run('Array.isArray(navigator.getGamepads()) && navigator.getGamepads().length'), 0);
  // even with a controller listed in the session
  h.g.__gl = h.gl;
  await startSession(h);
  makeProjectionLayer(h);
  writeController(h.record, 1, {});
  h.frame();
  h.frame();
  assert.equal(h.run('__session.inputSources.length'), 1);
  assert.equal(h.run('navigator.getGamepads().length'), 0);
});

test('DOMPointReadOnly / DOMPoint are provided when missing (XRRigidTransform needs them)', () => {
  const h = createHarness();
  assert.equal(h.run('new XRRigidTransform({ x: 1, y: 2, z: 3 }).position.y'), 2);
  assert.equal(h.run('DOMPoint.fromPoint({ x: 4 }).x'), 4);
  assert.equal(h.run('(() => { const p = new DOMPoint(); p.z = 5; return p.z; })()'), 5);
});
