/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Scope-sensitive resolution: the page's own postMessage/close, the alpha scope (Web Audio beyond the basic set,
// window.open), crypto.subtle (absent by default), element event handlers, a guarded WebSocket's URL, and the
// inventory's layer order.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateCompat } from '../src/check.ts';
import { discoverLayers, shippedAreaOrder } from '../src/inventory.ts';
import { normaliseKey, scopedKey } from '../src/matrix.ts';
import { parseKey, resolve, rootOf } from '../src/providers.ts';
import { scanDist } from '../src/scan.ts';
import { fromSnapshot, type SurfaceSnapshot } from '../src/surface.ts';
import { fakeSurface, rec, tempDir, trace, writeTree } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const snap = fromSnapshot(JSON.parse(readFileSync(path.join(here, '..', 'data', 'surface-snapshot.json'), 'utf8')) as SurfaceSnapshot);
const r = (k: string) => resolve(parseKey(normaliseKey(k)), snap);

function dist(js: string) {
  return writeTree(tempDir(), { 'index.html': '<!doctype html><script type="module" src="/assets/index.js"></script>', 'assets/index.js': js });
}

test('scope: the page\'s window.postMessage()/close() keep their Window. prefix and are not the worker scope\'s', () => {
  assert.equal(scopedKey('postMessage()', 'main'), 'Window.postMessage()');
  assert.equal(scopedKey('close()', 'main'), 'Window.close()');
  assert.equal(scopedKey('postMessage()', 'worker'), 'postMessage()');
  assert.equal(scopedKey('MessagePort.postMessage()', 'main'), 'MessagePort.postMessage()');
  assert.equal(normaliseKey('Window.postMessage()'), 'Window.postMessage()');
  assert.equal(normaliseKey('Window.innerWidth'), 'innerWidth');
  assert.equal(normaliseKey('DedicatedWorkerGlobalScope.postMessage()'), 'postMessage()');
  const page = r('Window.postMessage()');
  assert.equal(page.status, 'gap');
  assert.deepEqual(page.spec, ['DOM-3']);
  assert.equal(r('Window.close()').status, 'gap');
  assert.equal(r('postMessage()').status, 'provided');
  // through the checker: a main-thread call warns, a worker's own is supported
  const t = trace('main-post', { 'postMessage()': rec() }, [{ 'postMessage()': rec() }]);
  const f = evaluateCompat({ surface: snap, trace: t }).findings;
  assert.equal(f.find((x) => x.key === 'Window.postMessage()')?.severity, 'warn');
  assert.equal(f.find((x) => x.key === 'postMessage()'), undefined);
});

test('scope: Web Audio beyond the basic set and window.open are "later" (the alpha scope), the basic set is provided', () => {
  for (const k of ['new OscillatorNode', 'BaseAudioContext.createOscillator()', 'AudioContext.createBiquadFilter()', 'BaseAudioContext.createConvolver()', 'BaseAudioContext.createAnalyser()', 'new OfflineAudioContext', 'open()']) {
    assert.equal(r(k).status, 'later', k);
  }
  assert.match(r('open()').note ?? '', /out of the alpha scope/);
  for (const k of ['new AudioContext', 'AudioContext.resume()', 'BaseAudioContext.createGain()', 'BaseAudioContext.createPanner()', 'BaseAudioContext.createBufferSource()', 'BaseAudioContext.decodeAudioData()', 'AudioListener.positionX']) {
    assert.notEqual(r(k).status, 'later', k);
  }
  const t = trace('oauth', { 'open()': rec(), 'BaseAudioContext.createOscillator()': rec() });
  const f = evaluateCompat({ surface: snap, trace: t }).findings;
  assert.equal(f.find((x) => x.key === 'open()')?.severity, 'warn');
  assert.equal(f.find((x) => x.key === 'BaseAudioContext.createOscillator()')?.severity, 'warn');
});

test('scope: img.onload (recorded as HTMLElement.onload=) counts an element type\'s handler', () => {
  const s = r('HTMLElement.onload=');
  assert.notEqual(s.status, 'gap');
  // web/dom defines the GlobalEventHandlers on HTMLElement itself; without it the element type's handler counts
  assert.ok(s.layer === 'web/dom' || /HTMLImageElement\.onload/.test(s.note ?? ''), `${s.layer} ${s.note}`);
});

test('scope: crypto.subtle is a root of its own; a static use warns, an unguarded one fails the trace', () => {
  for (const k of ['Crypto.subtle', 'SubtleCrypto.digest()', 'Crypto.subtle.digest()']) assert.deepEqual(rootOf(k), { global: 'Crypto.subtle' }, k);
  assert.deepEqual(rootOf('Crypto.getRandomValues()'), { global: 'Crypto' });
  const scan = scanDist(dist("const h = await crypto.subtle.digest('SHA-256', new Uint8Array([1,2,3]));"));
  const st = evaluateCompat({ surface: fakeSurface(), scan });
  assert.equal(st.findings.find((x) => x.key === 'SubtleCrypto.digest()')?.severity, 'warn');
  // the trimmed run threw reading digest of undefined: a control run decides, then it is an error
  const err = ["TypeError: Cannot read properties of undefined (reading 'digest')\n    at http://127.0.0.1:41000/assets/index.js:1:31"];
  const mk = (controls?: Array<{ kept: string; pageErrors: string[] }>) => {
    const t = trace('subtle', { 'XRSystem.offerSession("immersive-vr")': rec() }, [], { removed: ['Crypto.subtle'], pageErrors: err });
    t.main!.removed = ['Crypto.subtle'];
    if (controls) t.controls = controls.map((c) => ({ ...c, reachedXR: true }));
    return evaluateCompat({ surface: fakeSurface(), scan, trace: t });
  };
  assert.deepEqual(mk().controlCandidates, ['Crypto.subtle']);
  const hit = mk([{ kept: 'Crypto.subtle', pageErrors: [] }]).findings.find((x) => x.key === 'crypto.subtle (used without a feature check)');
  assert.equal(hit?.severity, 'error');
  assert.match(hit!.message, /if \(crypto\.subtle\)/);
  // the control run throws the same: not the removal's
  assert.equal(mk([{ kept: 'Crypto.subtle', pageErrors: err }]).findings.find((x) => x.key === 'crypto.subtle (used without a feature check)'), undefined);
});

test('scope: a feature-detected WebSocket does not also get the "feature-detect it" URL warning', () => {
  const scan = scanDist(dist("if (typeof WebSocket !== 'undefined') { const ws = new WebSocket('wss://mp.example-game.net/room'); }"));
  const app = (guarded?: string) => [{ key: 'new WebSocket', origin: 'source' as const, evidence: 'src/main.js:1', ...(guarded ? { guarded } : {}) }];
  const g = evaluateCompat({ surface: fakeSurface(), scan, app: app("src/main.js:1: typeof WebSocket !== 'undefined'") }).findings;
  assert.equal(g.find((x) => x.key === 'new WebSocket')?.severity, 'info');
  const url = g.find((x) => x.key === 'network wss://mp.example-game.net');
  assert.equal(url?.severity, 'info');
  assert.match(url!.message, /feature-detects it/);
  const u = evaluateCompat({ surface: fakeSurface(), scan, app: app() }).findings;
  assert.equal(u.find((x) => x.key === 'network wss://mp.example-game.net')?.severity, 'warn');
});

test('scope: the inventory evaluates layers in the shipped prelude order', () => {
  const root = writeTree(tempDir(), {
    'release/template-assets.json': JSON.stringify({ preludes: ['web/glue/dist/glue.min.js', 'web/glue/dist/glue-subtle.min.js', 'web/dom/dist/dom.min.js', 'web/image/dist/image.min.js', 'web/canvas2d/dist/canvas2d.min.js'] }),
    'web/glue/dist/glue.js': '',
    'web/canvas2d/dist/canvas2d.js': '',
    'web/image/dist/image.js': '',
    'web/dom/dist/dom.js': '',
    'web/audio/dist/audio.js': '',
    'web/zeta/dist/zeta.js': '',
  });
  assert.deepEqual(shippedAreaOrder(root), ['glue', 'dom', 'image', 'canvas2d']);
  assert.deepEqual(discoverLayers(root).map((l) => l.layer), ['web/glue', 'web/dom', 'web/image', 'web/canvas2d', 'web/audio', 'web/zeta']);
  // without the template file: glue first, then alphabetical
  const bare = writeTree(tempDir(), { 'web/image/dist/image.js': '', 'web/glue/dist/glue.js': '', 'web/canvas2d/dist/canvas2d.js': '' });
  assert.deepEqual(discoverLayers(bare).map((l) => l.layer), ['web/glue', 'web/canvas2d', 'web/image']);
});

test('scope: the static catalogue flags Web Audio beyond the basic set, window.open and cross-origin navigation', () => {
  const scan = scanDist(dist([
    'const ctx = new AudioContext(); const o = ctx.createOscillator();',
    'const off = new OfflineAudioContext(1, 4410, 44100); const bq = new BiquadFilterNode(ctx);',
    "window.open('https://accounts.example-idp.com/authorize');",
    "location.href = 'https://accounts.example-idp.com/authorize?client_id=x';",
    "location.assign(withXR(true)); location.href = './?xr=off';",
    'const s = new window.WebSocket(u);',
  ].join('\n')));
  const f = evaluateCompat({ surface: snap, scan }).findings;
  for (const k of ['BaseAudioContext.createOscillator()', 'new OfflineAudioContext', 'new BiquadFilterNode', 'open()', 'location navigation (cross-origin)', 'new WebSocket'])
    assert.equal(f.find((x) => x.key === k)?.severity, 'warn', k);
  assert.match(f.find((x) => x.key === 'location navigation (cross-origin)')!.message, /DOM-5/);
  // a same-document assign or a relative href is not flagged
  assert.equal(scanDist(dist("location.assign(withXR(true)); location.href = './?xr=off';")).hits.length, 0);
});

test('scope: AR/depth members IWER defines are "later", not "iwer", until the headset backs them', () => {
  for (const k of ['XRFrame.getDepthInformation()', 'XRSession.initiateRoomCapture()'])
    assert.equal(r(k).status, 'later', k);
  // XR-AR-2, XR-ANCHOR-1, XR-DEPTH-2: planes, meshes, hit test, anchors and gpu-optimized depth are backed by the
  // scene model, spatial anchors and environment depth
  for (const k of ['XRSession.requestHitTestSource()', 'XRFrame.detectedMeshes', 'XRFrame.detectedPlanes', 'XRFrame.createAnchor()', 'XRSession.restorePersistentAnchor()', 'XRWebGLBinding.getDepthInformation()'])
    assert.equal(r(k).status, 'iwer', k);
  assert.equal(r('XRFrame.getViewerPose()').status, 'iwer');
});

test('scope: image formats outside IMG-1 (AVIF, SVG) do not resolve as provided', () => {
  for (const k of ['HTMLImageElement.src=(same-origin .avif)', 'HTMLImageElement.src=(same-origin .svg)', 'createImageBitmap(Blob image/avif)', 'HTMLImageElement.src=(data:image/svg+xml)'])
    assert.equal(r(k).status, 'unsupported', k);
  for (const k of ['HTMLImageElement.src=(same-origin .png)', 'HTMLImageElement.src=(same-origin .webp)', 'createImageBitmap(Blob image/jpeg)'])
    assert.notEqual(r(k).status, 'unsupported', k);
});

test('scope: an absent API the trim did not remove, or reached as window.X, is an unguarded use when its TypeError names it', () => {
  const base = { 'XRSystem.offerSession("immersive-vr")': rec() };
  const share = trace('share', { ...base, 'miss:Navigator.share': rec() }, [], { pageErrors: ['TypeError: navigator.share is not a function\n    at http://127.0.0.1:41000/assets/index.js:9:13'] });
  const fs = evaluateCompat({ surface: snap, trace: share }).findings;
  assert.equal(fs.find((x) => x.key === 'navigator.share (used without a feature check)')?.severity, 'error');
  assert.notEqual(fs.find((x) => x.key === 'miss:Navigator.share')?.message, undefined);
  assert.doesNotMatch(fs.find((x) => x.key === 'miss:Navigator.share')!.message, /fallback path runs/);
  const ws = trace('ws', base, [], { pageErrors: ['TypeError: window.WebSocket is not a constructor\n    at http://127.0.0.1:41000/assets/index.js:9:13'] });
  assert.equal(evaluateCompat({ surface: snap, trace: ws }).findings.find((x) => x.key === 'WebSocket (used without a feature check)')?.severity, 'error');
  // an app's own bug is not a missing API
  const bug = trace('bug', base, [], { pageErrors: ['TypeError: foo is not a function\n    at http://127.0.0.1:41000/assets/index.js:9:13'] });
  assert.ok(!evaluateCompat({ surface: snap, trace: bug }).findings.some((x) => x.key.includes('used without a feature check')));
});

test('scope: a navigation during the trace is reported (DOM-5) and marks a lost trace', () => {
  const t = trace('nav', { 'XRSystem.offerSession("immersive-vr")': rec() }, [], { navigations: [{ url: 'https://accounts.example-idp.com/authorize?x', sameOrigin: false }] });
  const rep = evaluateCompat({ surface: snap, trace: t });
  const f = rep.findings.find((x) => x.key === 'page navigation (headless run)');
  assert.equal(f?.severity, 'warn');
  assert.match(f!.message, /DOM-5/);
  assert.match(f!.message, /cancelled the navigation/);
  const lost = trace('reload', {}, [], { navigations: [{ url: '/', sameOrigin: true }] });
  lost.main = null;
  assert.match(evaluateCompat({ surface: snap, trace: lost }).findings.find((x) => x.key === 'page navigation (headless run)')!.message, /none of the app's API use was recorded/);
});

test('scope: <video> plays a camera stream only in an app that declares the camera; media files never play (DOM-6, XR-CAM-1)', () => {
  const cam = { declared: new Set(['camera']) };
  const rc = (k: string) => resolve(parseKey(normaliseKey(k)), snap, cam);
  for (const k of ['HTMLMediaElement.play()', 'HTMLVideoElement.srcObject=']) {
    assert.equal(r(k).status, 'unsupported', k);
    assert.equal(rc(k).status, 'provided', k);
  }
  assert.equal(rc('HTMLAudioElement.play()').status, 'unsupported');
  assert.notEqual(rc('HTMLMediaElement.src=').status, 'provided'); // a media file URL: still no playback
});
