/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// XR-PERM-1: AR features are grantable only behind their capability flag, and those that need an Android runtime
// permission ask for it (once) before the session gets them.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHarness, type Harness } from './harness.ts';

const XR = 'navigator.xr';
const USE_SCENE = 'com.oculus.permission.USE_SCENE';
const AR = { passthrough: true, immersiveAr: true };
const SCENE = { planeDetection: true, meshDetection: true, hitTest: true, depthSensing: true };

/** Requests a session; resolves to its enabled features (sorted) or the rejection's name and message. */
async function request(h: Harness, init: string, mode = 'immersive-ar', how = 'requestSession') {
  h.run(`globalThis.__s = undefined; globalThis.__e = undefined;
    ${XR}.${how}('${mode}', ${init}).then((s) => { globalThis.__s = s; }, (e) => { globalThis.__e = e; });`);
  await h.settle();
  const s = h.run<{ enabledFeatures: string[] } | undefined>('globalThis.__s');
  if (s) return { features: [...s.enabledFeatures].sort() };
  return { error: h.run<string>('globalThis.__e && globalThis.__e.name'), message: h.run<string>('globalThis.__e && globalThis.__e.message') };
}

async function end(h: Harness) {
  h.run('globalThis.__s.end()');
  await h.settle();
}

const asks = (h: Harness) => h.calls.filter((c) => c[0] === 'requestPermissions');

test('XR-PERM-1: AR features are grantable only when the native side reports support', async () => {
  const off = createHarness({ info: AR, permissions: { [USE_SCENE]: true } });
  assert.deepEqual(await request(off, "{ requiredFeatures: ['plane-detection'] }"), {
    error: 'NotSupportedError',
    message: 'One or more required features are not supported by the device.',
  });
  const dropped = await request(off, "{ optionalFeatures: ['plane-detection', 'hit-test', 'anchors', 'depth-sensing'] }");
  assert.deepEqual(dropped.features, ['local', 'viewer']);
  assert.equal(asks(off).length, 0, 'no dialog for features the runtime cannot grant');

  const on = createHarness({ info: { ...AR, planeDetection: true, anchors: true }, scene: true, permissions: { [USE_SCENE]: true } });
  const r = await request(on, "{ requiredFeatures: ['plane-detection', 'anchors'], optionalFeatures: ['mesh-detection'] }");
  assert.deepEqual(r.features, ['anchors', 'local', 'plane-detection', 'viewer']);
  assert.deepEqual(asks(on), [['requestPermissions', [USE_SCENE]]]);
  assert.deepEqual(on.calls.find((c) => c[0] === 'sessionStarted'), ['sessionStarted', true, false, true, false]);
});

test('XR-PERM-1: granted -> the session gets the features; the permission is asked for once', async () => {
  const h = createHarness({ info: { ...AR, ...SCENE }, scene: true, permissions: { [USE_SCENE]: true } });
  const r = await request(h, "{ requiredFeatures: ['hit-test'], optionalFeatures: ['plane-detection', 'mesh-detection', 'depth-sensing', 'hand-tracking'] }");
  assert.deepEqual(r.features, ['depth-sensing', 'hand-tracking', 'hit-test', 'local', 'mesh-detection', 'plane-detection', 'viewer']);
  // one permission for four features: one request
  assert.deepEqual(asks(h), [['requestPermissions', [USE_SCENE]]]);
  await end(h);
  assert.ok((await request(h, "{ requiredFeatures: ['plane-detection'] }")).features?.includes('plane-detection'));
  assert.equal(asks(h).length, 1, 'not asked again');
});

test('XR-PERM-1: denied -> required features reject with NotSupportedError, optional ones are dropped', async () => {
  const h = createHarness({ info: { ...AR, ...SCENE }, scene: true, permissions: { [USE_SCENE]: false } });
  const r = await request(h, "{ requiredFeatures: ['local-floor', 'plane-detection'] }");
  assert.equal(r.error, 'NotSupportedError');
  assert.match(r.message ?? '', /'plane-detection' needs com\.oculus\.permission\.USE_SCENE/);
  // XR-LIFE-7: the rejected (only) request is reported, as for any other rejection
  assert.ok(h.calls.some((c) => c[0] === 'offerRejected'));

  const o = await request(h, "{ requiredFeatures: ['local-floor'], optionalFeatures: ['plane-detection', 'hit-test', 'hand-tracking'] }");
  assert.deepEqual(o.features, ['hand-tracking', 'local', 'local-floor', 'viewer']);
  assert.equal(asks(h).length, 1, 'the dialog is not shown again after a denial');
  await end(h);

  // a grant made later (Settings) is picked up without another dialog
  h.permissions!.held[USE_SCENE] = true;
  const later = await request(h, "{ requiredFeatures: ['plane-detection'] }");
  assert.ok(later.features?.includes('plane-detection'), JSON.stringify(later));
  assert.equal(asks(h).length, 1);
});

test('XR-PERM-1: no dialog for requests that fail anyway or need no permission', async () => {
  const h = createHarness({ info: { ...AR, ...SCENE }, scene: true, permissions: { [USE_SCENE]: true } });
  // a required feature the runtime does not support: rejected by IWER, nothing asked
  assert.equal((await request(h, "{ requiredFeatures: ['dom-overlay', 'plane-detection'] }")).error, 'NotSupportedError');
  // an unsupported mode
  const vrOnly = createHarness({ info: { passthrough: true, ...SCENE }, scene: true, permissions: { [USE_SCENE]: true } });
  assert.equal((await request(vrOnly, "{ requiredFeatures: ['plane-detection'] }")).error, 'NotSupportedError');
  assert.equal(asks(vrOnly).length, 0);
  // a VR session without permission features takes the direct path
  const vr = await request(h, "{ optionalFeatures: ['local-floor', 'hand-tracking', 'layers'] }", 'immersive-vr');
  assert.ok(vr.features?.includes('layers'));
  // a second request while a session is active rejects with InvalidStateError before any dialog
  assert.equal((await request(h, "{ requiredFeatures: ['plane-detection'] }")).error, 'InvalidStateError');
  assert.equal(asks(h).length, 0);
});

test('XR-PERM-1: offerSession asks before the grant; a failed native request counts as denied', async () => {
  const h = createHarness({ info: { ...AR, ...SCENE }, scene: true, permissions: { [USE_SCENE]: true } });
  const r = await request(h, "{ optionalFeatures: ['plane-detection'] }", 'immersive-ar', 'offerSession');
  assert.deepEqual(r.features, ['local', 'plane-detection', 'viewer']);
  assert.equal(asks(h).length, 1);

  const failing = createHarness({ info: { ...AR, ...SCENE }, scene: true, permissions: { [USE_SCENE]: true } });
  failing.permissions!.fail = true;
  const f = await request(failing, "{ optionalFeatures: ['plane-detection'] }");
  assert.deepEqual(f.features, ['local', 'viewer']);
  assert.equal(failing.reported.length, 1);
});

test('XR-PERM-1: without the native helper the install-time grant stands (host runs, older templates)', async () => {
  const h = createHarness({ info: { ...AR, ...SCENE }, scene: true, permissions: null });
  const r = await request(h, "{ requiredFeatures: ['plane-detection'] }");
  assert.ok(r.features?.includes('plane-detection'), JSON.stringify(r));
});

test('XR-PERM-1: __iwnXR.requestPermissions for other callers (getUserMedia), one dialog per permission', async () => {
  const CAMERA = ['android.permission.CAMERA', 'horizonos.permission.HEADSET_CAMERA'];
  const h = createHarness({ permissions: { [CAMERA[0]]: true, [CAMERA[1]]: false } });
  h.run(`__iwnXR.requestPermissions(${JSON.stringify(CAMERA)}).then((r) => { globalThis.__r = r; })`);
  await h.settle();
  assert.deepEqual({ ...h.run<Record<string, boolean>>('__r') }, { [CAMERA[0]]: true, [CAMERA[1]]: false });
  assert.deepEqual(asks(h), [['requestPermissions', CAMERA]]);
  // both at once again plus a new one: only the new one is asked for
  h.run(`__iwnXR.requestPermissions([...${JSON.stringify(CAMERA)}, '${USE_SCENE}']).then((r) => { globalThis.__r2 = r; })`);
  await h.settle();
  assert.deepEqual(asks(h), [['requestPermissions', CAMERA], ['requestPermissions', [USE_SCENE]]]);
  assert.equal(h.run(`__r2['${CAMERA[0]}']`), true);
});

test('XR-PERM-1: features of immersive sessions only are dropped (optional) or refused (required) for inline, without a dialog', async () => {
  const h = createHarness({ info: { ...AR, ...SCENE, anchors: true }, scene: true, permissions: { [USE_SCENE]: true } });
  const inline = await request(h, "{ optionalFeatures: ['plane-detection', 'hit-test', 'depth-sensing', 'anchors'] }", 'inline');
  assert.deepEqual(inline.features, ['local', 'viewer']);
  assert.equal(asks(h).length, 0, 'an inline session never asks');
  assert.ok(!h.calls.some((c) => c[0] === 'sessionStarted' && c[3] === true), 'no room query for an inline session');
  await end(h);
  const required = await request(h, "{ requiredFeatures: ['plane-detection'] }", 'inline');
  assert.equal(required.error, 'NotSupportedError');
  assert.match(required.message ?? '', /'plane-detection' is not supported for mode: inline/);
  assert.equal(asks(h).length, 0);
  // Quest Browser offers plane detection in immersive-vr too
  const vr = await request(h, "{ optionalFeatures: ['plane-detection'] }", 'immersive-vr');
  assert.deepEqual(vr.features, ['local', 'plane-detection', 'viewer']);
  assert.deepEqual(asks(h), [['requestPermissions', [USE_SCENE]]]);
});

test('XR-PERM-1: requests reach IWER in call order: one waiting for the dialog is not overtaken by a later one', async () => {
  const h = createHarness({ info: { ...AR, ...SCENE }, scene: true, permissions: { [USE_SCENE]: true } });
  h.permissions!.hold = true;
  h.run(`globalThis.__r = [];
    ${XR}.requestSession('immersive-ar', { requiredFeatures: ['plane-detection'] })
      .then((s) => { __r.push('ar ' + s.enabledFeatures.includes('plane-detection')); }, (e) => { __r.push('ar ' + e.name); });
    ${XR}.requestSession('immersive-vr').then(() => { __r.push('vr session'); }, (e) => { __r.push('vr ' + e.name); });`);
  await h.settle();
  assert.deepEqual([...h.run<string[]>('__r')], [], 'the VR request waits behind the AR one');
  h.permissions!.release();
  await h.settle();
  assert.deepEqual([...h.run<string[]>('__r')].sort(), ['ar true', 'vr InvalidStateError']);
});

test('XR-PERM-1: overlapping requests (a session and getUserMedia in one tick) each get their own answer', async () => {
  const CAMERA = ['android.permission.CAMERA', 'horizonos.permission.HEADSET_CAMERA'];
  const h = createHarness({
    info: { ...AR, ...SCENE },
    scene: true,
    permissions: { [USE_SCENE]: true, [CAMERA[0]]: true, [CAMERA[1]]: false },
  });
  h.permissions!.hold = true;
  h.run(`globalThis.__s = null;
    ${XR}.offerSession('immersive-ar', { optionalFeatures: ['plane-detection'] }).then((s) => { globalThis.__s = s; });
    __iwnXR.requestPermissions(${JSON.stringify(CAMERA)}).then((r) => { globalThis.__cam = r; });`);
  await h.settle();
  // both go to the native broker, which keeps one Android request in flight and asks for the second after it
  assert.deepEqual(asks(h), [['requestPermissions', [USE_SCENE]], ['requestPermissions', CAMERA]]);
  h.permissions!.release();
  await h.settle();
  assert.ok(h.run<boolean>("__s.enabledFeatures.includes('plane-detection')"));
  assert.deepEqual({ ...h.run<Record<string, boolean>>('__cam') }, { [CAMERA[0]]: true, [CAMERA[1]]: false });
});

test('XR-PERM-1: a permission the manifest does not declare is never asked for; the error names the manifest', async () => {
  const h = createHarness({
    info: { ...AR, ...SCENE },
    scene: true,
    permissions: { [USE_SCENE]: true },
    declared: ['com.oculus.permission.USE_ANCHOR_API'],
  });
  const r = await request(h, "{ requiredFeatures: ['plane-detection'] }");
  assert.equal(r.error, 'NotSupportedError');
  assert.match(r.message ?? '', /USE_SCENE, which the app's manifest does not declare/);
  const o = await request(h, "{ optionalFeatures: ['plane-detection', 'hit-test'] }");
  assert.deepEqual(o.features, ['local', 'viewer']);
  assert.equal(asks(h).length, 0, 'no dialog activity for an undeclared permission');
  // declared: asked as before
  const ok = createHarness({ info: { ...AR, ...SCENE }, scene: true, permissions: { [USE_SCENE]: true }, declared: [USE_SCENE] });
  assert.deepEqual((await request(ok, "{ optionalFeatures: ['plane-detection'] }")).features, ['local', 'plane-detection', 'viewer']);
  assert.equal(asks(ok).length, 1);
});
