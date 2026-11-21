/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowEntryFor, AREAS, controlTrim, headsetTrim, measuredSurface, parseKey, resolve, rootOf, ruleFor } from '../src/providers.ts';
import { fakeSurface } from './helpers.ts';

test('parseKey normalises tracer keys', () => {
  assert.deepEqual(
    { ...parseKey('WebGL2RenderingContext.drawElements()') },
    { key: 'WebGL2RenderingContext.drawElements()', base: 'WebGL2RenderingContext.drawElements', kind: 'method', iface: 'WebGL2RenderingContext', member: 'drawElements', arg: undefined },
  );
  assert.equal(parseKey('HTMLCanvasElement.width=').kind, 'set');
  assert.equal(parseKey('HTMLCanvasElement.width').kind, 'get');
  assert.equal(parseKey('new Image').kind, 'new');
  assert.equal(parseKey('new Image').base, 'Image');
  assert.deepEqual([parseKey('fetch()').base, parseKey('fetch()').kind], ['fetch', 'call']);
  assert.deepEqual([parseKey('innerWidth').base, parseKey('innerWidth').kind], ['innerWidth', 'global']);
  assert.equal(parseKey('Window.setTimeout()').base, 'setTimeout');
  assert.equal(parseKey('WorkerGlobalScope.fetch()').base, 'fetch');
  assert.deepEqual([parseKey('WebGL.getExtension("OVR_multiview2")').base, parseKey('WebGL.getExtension("OVR_multiview2")').kind], ['ext:OVR_multiview2', 'extension']);
  assert.equal(parseKey('HTMLCanvasElement.getContext("webgl2")').base, 'getContext:webgl2');
  assert.equal(parseKey('XR feature hand-tracking (optional)').base, 'feature:hand-tracking');
  assert.equal(parseKey('on:Window.keydown').base, 'on:Window.keydown');
  assert.equal(parseKey('miss:Navigator.gpu').base, 'probe:Navigator.gpu');
  const d = parseKey('Document.createElement("video")');
  assert.deepEqual([d.base, d.kind, d.arg], ['Document.createElement', 'detail', 'video']);
  const f = parseKey('fetch(cross-origin https://cdn.example.net .glb)');
  assert.deepEqual([f.base, f.kind, f.arg], ['fetch', 'detail', 'cross-origin https://cdn.example.net .glb']);
  assert.equal(parseKey('new Worker(module, same-origin)').arg, 'module, same-origin');
});

test('rules: every area the spec covers has an owner', () => {
  assert.equal(ruleFor('XRFrame.getViewerPose')?.area, 'iwer');
  assert.equal(ruleFor('WebGL2RenderingContext.drawElements')?.area, 'webgl');
  assert.equal(ruleFor('CanvasRenderingContext2D.fillText')?.area, 'canvas2d');
  assert.equal(ruleFor('fetch')?.area, 'net');
  assert.equal(ruleFor('AudioContext')?.area, 'audio');
  assert.equal(ruleFor('Worker')?.area, 'workers');
  assert.equal(ruleFor('Document.createElement')?.area, 'dom');
  assert.equal(ruleFor('Navigator.gpu')?.policy, 'absent');
  assert.equal(ruleFor('VideoDecoder')?.policy, 'absent');
  assert.equal(ruleFor('on:Window.keydown')?.policy, 'inert');
  assert.equal(ruleFor('feature:plane-detection')?.policy, 'later');
});

test('resolve: measured layers, V8, IWER, gaps and policies', () => {
  const s = fakeSurface();
  const st = (k: string) => resolve(parseKey(k), s).status;
  assert.equal(st('setTimeout()'), 'provided');
  assert.equal(resolve(parseKey('setTimeout()'), s).layer, 'runtime/core');
  assert.equal(st('URL.href'), 'provided');
  assert.equal(st('Navigator.platform'), 'provided'); // instance members of navigator
  assert.equal(st('new Intl.Segmenter'), 'v8');
  assert.equal(st('XRFrame.getViewerPose()'), 'iwer');
  assert.equal(st('XRFrame.detectedPlanes'), 'later');
  assert.equal(st('XRSystem.offerSession("immersive-ar")'), 'config'); // XR-AR-1: needs passthrough declared
  assert.equal(st('XRSystem.offerSession("immersive-vr")'), 'iwer');
  assert.equal(st('WebGL2RenderingContext.drawElements()'), 'provided');
  assert.equal(st('WebGLActiveInfo.name'), 'partial'); // interface present, `this.name =` in the layer: an instance field
  assert.equal(st('WebGLActiveInfo.nope'), 'gap'); // interface present, member nowhere: missing
  assert.match(resolve(parseKey('WebGLActiveInfo.nope'), s).note!, /missing/);
  assert.equal(st('HTMLCanvasElement.getContext()'), 'gap'); // OffscreenCanvas.getContext is not the element
  assert.equal(resolve(parseKey('HTMLCanvasElement.getContext("webgl2")'), s).area, 'dom');
  assert.equal(st('Element.fillText()'), 'gap'); // not an element member anywhere
  assert.equal(st('WebGL.getExtension("OVR_multiview2")'), 'provided');
  assert.equal(st('WebGL.getExtension("EXT_foo")'), 'gap');
  assert.equal(st('WebGL.getExtension("WEBGL_bar") -> null'), 'absent-ok');
  // null in headless Chromium, but the device path needs it: not absent-ok
  assert.equal(st('WebGL.getExtension("OVR_multiview2") -> null'), 'provided');
  assert.match(resolve(parseKey('WebGL.getExtension("OVR_multiview2") -> null'), s).note!, /not traced/);
  assert.equal(st('WebGL.getExtension("KHR_parallel_shader_compile") -> null'), 'gap');
  assert.deepEqual(resolve(parseKey('WebGL.getExtension("KHR_parallel_shader_compile") -> null'), s).spec, ['GL-20']);
  // navigator.getGamepads (IN-9): the navigator instance was measured, so a missing member is a gap, not partial
  assert.equal(st('Navigator.getGamepads()'), 'gap');
  assert.equal(st('Gamepad.buttons'), 'iwer');
  // console: only V8's inert console is a gap for runtime/core (CON-1)
  assert.equal(st('console.log()'), 'gap');
  // stubs read as partial, not provided
  assert.equal(st('CanvasRenderingContext2D.filter='), 'partial');
  assert.equal(resolve(parseKey('CanvasRenderingContext2D.filter='), s).stub, true);
  assert.equal(st('new AudioContext'), 'in-source');
  assert.equal(st('new Worker'), 'gap');
  assert.equal(st('Document.getElementById()'), 'gap');
  assert.equal(st('on:Window.keydown'), 'inert');
  assert.equal(st('VideoFrame'), 'absent-ok'); // a read: feature detection
  assert.equal(st('new VideoDecoder'), 'unsupported'); // a call
  assert.equal(st('Document.createElement("video")'), 'inert'); // DOM-6: an inert stand-in, probes work
  assert.equal(st('HTMLMediaElement.canPlayType()'), 'inert');
  assert.equal(st('HTMLMediaElement.play()'), 'unsupported'); // playback is what is absent
  assert.equal(st('HTMLVideoElement.requestVideoFrameCallback()'), 'unsupported');
  assert.equal(st('XRWebGLBinding.createEquirectLayer()'), 'later');
  assert.match(resolve(parseKey('XRWebGLBinding.createEquirectLayer()'), s).note!, /equirect/);
  // XR-LAYER-1: quad and cylinder layers are IWER host mode's (provided where the measured IWER build has them)
  assert.equal(ruleFor('XRWebGLBinding.createQuadLayer')?.policy, 'provide');
  assert.equal(resolve(parseKey('XRWebGLBinding.createQuadLayer()'), measuredSurface({ generatedAt: '', packageRoot: '', layers: [] }, ['XRWebGLBinding.createQuadLayer'])).status, 'iwer');
  assert.equal(st('miss:Navigator.gpu'), 'absent-ok');
  assert.equal(st('fetch(cross-origin https://cdn.example.net .glb)'), 'config');
  assert.equal(st('decodeAudioData(mp3)'), 'in-source');
  assert.equal(st('decodeAudioData(flac)'), 'gap');
  assert.equal(st('somethingUnknown()'), 'unsupported');
  assert.equal(st('somethingUnknown'), 'absent-ok');
  // a member name shared with an unrelated interface is not evidence
  assert.equal(st('BaseAudioContext.destination'), 'gap'); // not 'partial' via Request.destination
});

test('resolve: WebGPU, context types, the canvas element, embedder hooks, event targets, XR-LIFE-7', () => {
  const s = fakeSurface();
  const r = (k: string) => resolve(parseKey(k), s);
  // three-segment scan keys parse, and WebGPU (DOM-4, absent by design) is unsupported when called
  assert.deepEqual([parseKey('Navigator.gpu.requestAdapter()').iface, parseKey('Navigator.gpu.requestAdapter()').member], ['Navigator.gpu', 'requestAdapter']);
  for (const k of ['Navigator.gpu.requestAdapter()', 'GPU.requestAdapter()', 'HTMLCanvasElement.getContext("webgpu")']) {
    assert.equal(r(k).status, 'unsupported', k);
    assert.deepEqual(r(k).spec, ['DOM-4'], k);
  }
  assert.equal(r('Navigator.gpu').status, 'absent-ok');
  assert.equal(r('HTMLCanvasElement.getContext("bitmaprenderer")').status, 'unsupported');
  // every HTMLCanvasElement row has one owner while no layer defines the element
  assert.equal(r('HTMLCanvasElement.width').area, 'dom');
  assert.equal(r('HTMLCanvasElement.width').status, 'gap');
  assert.equal(r('HTMLCanvasElement.getContext("2d")').area, 'dom');
  assert.equal(r('on:HTMLCanvasElement.pointerdown').status, 'inert'); // never fires, element or not
  // V8 members Node has only through its embedder hook are not V8-provided
  const s2 = fakeSurface();
  s2.v8Members.add('WebAssembly.instantiateStreaming');
  assert.equal(resolve(parseKey('WebAssembly.instantiateStreaming()'), s2).status, 'gap');
  // listeners on the global object and on app EventTarget subclasses
  assert.equal(r('on:Window.message').status, 'provided');
  assert.equal(r('on:EventTarget.ping').status, 'provided');
  // XR-LIFE-7 config signal
  assert.equal(r('no XR entry (xr: false)').status, 'later');
  assert.deepEqual(r('no XR entry (offer: none)').spec, ['XR-LIFE-7', 'XR-IDLE-1']);
});

test('resolve: AR support checks, crypto.subtle, the bare canvas global, WebSocket origins; trim and roots', () => {
  const s = fakeSurface();
  const r = (k: string) => resolve(parseKey(k), s);
  assert.equal(r('XRSystem.isSessionSupported("immersive-ar")').status, 'absent-ok');
  assert.equal(r('XRSystem.requestSession("immersive-ar")').status, 'config');
  assert.match(r('XRSystem.requestSession("immersive-ar")').note!, /native\.features\.passthrough/);
  // XR-AR-1: pack turns immersive-ar on for an app that declares passthrough
  const ar = { declared: new Set(['passthrough']) };
  for (const k of ['XRSystem.isSessionSupported("immersive-ar")', 'XRSystem.requestSession("immersive-ar")', 'XRSystem.offerSession("immersive-ar")'])
    assert.equal(resolve(parseKey(k), s, ar).status, 'iwer', k);
  // NET-STORE-4: absent in the alpha (the digest-only prelude has no config key, so it is not offered as a route)
  assert.equal(r('Crypto.subtle').status, 'absent-ok');
  assert.deepEqual(r('Crypto.subtle').spec, ['NET-STORE-4']);
  assert.equal(r('SubtleCrypto.digest()').status, 'unsupported');
  assert.doesNotMatch(r('SubtleCrypto.digest()').note ?? '', /config|prelude/);
  assert.equal(r('SubtleCrypto.encrypt()').status, 'unsupported');
  // every HTMLCanvasElement row, the bare global included, belongs to the DOM stand-ins
  assert.equal(r('HTMLCanvasElement').area, 'dom');
  // alpha scope: WebSocket, IndexedDB and the Cache API are absent (an allowlist entry does not install WebSocket)
  assert.equal(r('new WebSocket(cross-origin wss://game.example.net)').status, 'unsupported');
  assert.equal(r('new WebSocket').status, 'unsupported');
  assert.equal(r('WebSocket').status, 'absent-ok');
  assert.equal(r('IDBFactory.open()').status, 'unsupported');
  assert.equal(r('indexedDB').status, 'absent-ok');
  assert.equal(r('CacheStorage.open()').status, 'unsupported');
  assert.equal(r('caches').status, 'absent-ok');
  // the static scan's keys for `indexedDB.open(` / `caches.open(` are calls rooted at the global
  assert.equal(r('indexedDB.open()').status, 'unsupported');
  assert.equal(r('caches.open()').status, 'unsupported');
  assert.deepEqual(rootOf('indexedDB.open()'), { global: 'indexedDB' });
  assert.equal(r('HTMLCanvasElement.getContext("webgpu") -> null').status, 'absent-ok');
  const t = headsetTrim(s);
  assert.ok(t.keep.includes('Navigator.platform'));
  assert.ok(t.absent.some((src) => new RegExp(src).test('VideoDecoder')));
  assert.ok(t.absent.some((src) => new RegExp(src).test('Navigator.gpu')));
  assert.ok(!t.absent.some((src) => new RegExp(src).test('fetch')));
  for (const n of ['WebSocket', 'indexedDB', 'caches']) assert.ok(t.absent.some((src) => new RegExp(src).test(n)) && !t.keep.includes(n), n);
  assert.deepEqual(rootOf('new VideoDecoder'), { global: 'VideoDecoder' });
  assert.deepEqual(rootOf('MediaDevices.getUserMedia()'), { nav: 'mediaDevices' });
  assert.deepEqual(rootOf('Navigator.gpu.requestAdapter()'), { nav: 'gpu' });
  assert.deepEqual(rootOf('Navigator.clipboard'), { nav: 'clipboard' });
});

test('rules follow the spec text: AudioWorklet absent (AUD-6), BroadcastChannel optional (WRK-6)', () => {
  const s = fakeSurface();
  const r = (k: string) => resolve(parseKey(k), s);
  assert.equal(r('BaseAudioContext.audioWorklet').status, 'absent-ok'); // a read is a probe
  for (const k of ['new AudioWorkletNode', 'AudioWorklet.addModule()', 'BaseAudioContext.createScriptProcessor()']) {
    assert.equal(r(k).status, 'unsupported', k);
    assert.deepEqual(r(k).spec, ['AUD-6'], k);
  }
  assert.equal(ruleFor('BaseAudioContext.createGain')?.policy, 'provide');
  assert.deepEqual(ruleFor('BroadcastChannel')?.spec, ['WRK-6']);
  const t = headsetTrim(s);
  for (const k of ['AudioWorkletNode', 'AudioWorklet', 'BaseAudioContext.audioWorklet', 'BroadcastChannel']) assert.ok(t.absent.some((src) => new RegExp(src).test(k)), k);
  assert.ok(!t.absent.some((src) => new RegExp(src).test('BaseAudioContext.createGain')));
});

test('resolve: an absent-by-design API a layer only stubs is not "provided"; the trim stubs it instead of keeping it', () => {
  const inv = {
    generatedAt: 'test',
    packageRoot: '/x',
    layers: [
      { layer: 'v8', how: 'eval' as const, globals: ['Object'], members: [] },
      { layer: 'web/audio', how: 'eval' as const, globals: ['AudioContext', 'BaseAudioContext'], members: ['BaseAudioContext.createScriptProcessor', 'AudioContext.createScriptProcessor', 'BaseAudioContext.createGain'], stubs: ['BaseAudioContext.createScriptProcessor', 'AudioContext.createScriptProcessor'] },
      // a future DOM layer whose media stand-ins stub play() and src (DOM-6)
      { layer: 'web/dom', how: 'eval' as const, globals: ['HTMLMediaElement'], members: ['HTMLMediaElement.play', 'HTMLMediaElement.src', 'HTMLMediaElement.canPlayType'], stubs: ['HTMLMediaElement.play', 'HTMLMediaElement.src'] },
      { layer: 'web/workers', how: 'eval' as const, globals: ['Worker', 'DedicatedWorkerGlobalScope'], members: ['DedicatedWorkerGlobalScope.postMessage', 'WorkerGlobalScope.importScripts'] },
    ],
  };
  const s = measuredSurface(inv, []);
  const r = (k: string) => resolve(parseKey(k), s);
  for (const k of ['BaseAudioContext.createScriptProcessor()', 'AudioContext.createScriptProcessor()', 'HTMLMediaElement.play()', 'HTMLMediaElement.src=']) {
    assert.equal(r(k).status, 'unsupported', k);
    assert.equal(r(k).stub, true, k);
  }
  assert.equal(r('BaseAudioContext.createScriptProcessor').status, 'partial'); // a read sees the stub
  assert.equal(r('BaseAudioContext.createGain()').status, 'provided');
  const t = headsetTrim(s);
  assert.ok(!t.keep.includes('BaseAudioContext.createScriptProcessor'));
  assert.deepEqual(t.stubs, ['BaseAudioContext.createScriptProcessor']);
  assert.ok(t.keep.includes('BaseAudioContext.createGain'));
  // the control trim for a root keeps it (and the instance member that reaches a removed global)
  const c = controlTrim(t, 'AudioWorklet', ['AudioWorklet', 'BaseAudioContext.audioWorklet', 'Navigator.gpu']);
  assert.ok(c.keep.includes('AudioWorklet') && c.keep.includes('BaseAudioContext.audioWorklet') && !c.keep.includes('Navigator.gpu'));
  assert.ok(controlTrim(t, 'Navigator.gpu', []).keep.includes('Navigator.gpu'));
  // worker-scope globals resolve against the worker global scope's prototype members
  assert.equal(r('postMessage()').status, 'provided');
  // the main thread's window.postMessage()/close() are not the worker scope's: no layer installs them on the page
  assert.notEqual(r('Window.postMessage()').status, 'provided');
  assert.notEqual(r('Window.close()').status, 'provided');
  assert.equal(r('importScripts()').status, 'provided');
  assert.equal(AREAS.workers, 'web/workers + runtime/workers');
  // a miss probe of an absent-by-design API resolves by that API's rule
  assert.deepEqual(r('miss:Navigator.gpu').spec, ['DOM-4']);
  assert.equal(r('miss:Navigator.gpu').status, 'absent-ok');
  assert.deepEqual(r('miss:serviceWorker (in, Navigator chain)').spec, ['DOM-4', 'DOM-10', 'NET-STORE-3']);
});

test('WebSocket origins are matched as http(s) origins, as the runtime and the config validator do', () => {
  assert.equal(allowEntryFor('wss://game.example.net'), 'https://game.example.net');
  assert.equal(allowEntryFor('ws://game.example.net:8080'), 'http://game.example.net:8080');
  assert.equal(allowEntryFor('https://cdn.example.net'), 'https://cdn.example.net');
  // WebSocket itself is absent in the alpha: no allowlist advice for it
  assert.match(resolve(parseKey('new WebSocket(cross-origin wss://game.example.net)'), fakeSurface()).note ?? '', /not supported in this alpha/);
});
