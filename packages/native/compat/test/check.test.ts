/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselineDrift, evaluateCompat, formatCompatReport, UNSUPPORTED_ADVICE } from '../src/check.ts';
import { buildMatrix, matrixJson, matrixMarkdown } from '../src/matrix.ts';
import { isStubSource } from '../src/inventory.ts';
import { scanDist } from '../src/scan.ts';
import { measuredSurface } from '../src/providers.ts';
import { fakeSurface, rec, tempDir, trace, writeTree } from './helpers.ts';

function dist(files: Record<string, string>) {
  return writeTree(tempDir(), { 'index.html': '<!doctype html><html><head></head><body><script type="module" src="/assets/index.js"></script></body></html>', ...files });
}

test('scan: signals, origins and an injected emulator', () => {
  const d = dist({
    'assets/index.js': [
      'if (typeof VideoFrame !== "undefined") {}',
      'const gl = c.getContext("webgl2");',
      'navigator.mediaDevices.getUserMedia({video:true});',
      'fetch("https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/x.json");',
      'const ns = "http://www.w3.org/2000/svg";',
      'xr.requestSession("immersive-ar", { requiredFeatures: ["plane-detection"] });',
    ].join('\n'),
    'assets/iwer.js': 'const d = new XRDevice(metaQuest3); d.installRuntime();',
    'assets/index.js.map': 'getUserMedia(',
  });
  const s = scanDist(d);
  const keys = s.hits.map((h) => h.key);
  assert.ok(keys.includes('VideoFrame'));
  assert.ok(keys.includes('HTMLCanvasElement.getContext("webgl2")'));
  assert.ok(keys.includes('MediaDevices.getUserMedia()'));
  assert.ok(keys.includes('XRSystem.requestSession("immersive-ar")'));
  assert.ok(keys.includes('XR feature plane-detection (optional)'));
  assert.equal(s.hits.find((h) => h.key === 'MediaDevices.getUserMedia()')?.files.length, 1); // .map ignored
  assert.deepEqual(s.origins.map((o) => o.origin), ['https://cdn.jsdelivr.net']); // w3.org is inert
  assert.equal(s.origins[0]?.likelyRuntime, true);
  assert.equal(s.injectedEmulator.length, 1);
});

test('check: static-only unsupported calls warn, traced ones fail with the unsupported-API advice', () => {
  const d = dist({ 'assets/index.js': 'navigator.mediaDevices.getUserMedia({});\nc.getContext("webgl2");' });
  const scan = scanDist(d);
  const surface = fakeSurface();
  const r1 = evaluateCompat({ scan, surface });
  assert.equal(r1.ok, true);
  assert.equal(r1.findings.find((f) => f.key === 'MediaDevices.getUserMedia()')?.severity, 'warn');
  assert.equal(r1.advice, undefined);
  const strict = evaluateCompat({ scan, surface, strict: true });
  assert.equal(strict.ok, false);

  const t = trace('app', { 'new VideoDecoder': rec(), 'VideoFrame': rec(), 'WebGL2RenderingContext.drawElements()': rec({ calls: 100 }) });
  const r2 = evaluateCompat({ scan, trace: t, surface });
  assert.equal(r2.ok, false);
  assert.equal(r2.findings[0]?.key, 'new VideoDecoder');
  assert.equal(r2.findings[0]?.severity, 'error');
  assert.equal(r2.findings.find((f) => f.key === 'VideoFrame')?.severity, 'info'); // probe only
  assert.ok((r2.supported.provided ?? 0) >= 1);
  assert.equal(r2.advice, UNSUPPORTED_ADVICE);
  const text = formatCompatReport(r2);
  assert.match(text, /\[fail\] new VideoDecoder/);
  assert.match(text, /There is no fallback route/);
  assert.doesNotMatch(text, /Trusted Web Activity|TWA/);
});

test('check: network allowlist and the injected emulator', () => {
  const d = dist({
    'assets/index.js': 'fetch("https://cdn.jsdelivr.net/npm/x/a.glb")',
    'assets/e.js': 'new XRDevice(metaQuest3).installRuntime()',
  });
  const scan = scanDist(d);
  const surface = fakeSurface();
  const blocked = evaluateCompat({ scan, surface });
  assert.ok(blocked.findings.some((f) => f.key === 'network https://cdn.jsdelivr.net' && f.severity === 'warn'));
  assert.equal(blocked.findings.find((f) => f.key === 'injected WebXR emulator')?.severity, 'error');
  assert.equal(blocked.advice, undefined); // the emulator is a build setting, not a reason for the advice
  const allowed = evaluateCompat({ scan, surface, allow: ['https://*.jsdelivr.net'] });
  assert.ok(!allowed.findings.some((f) => f.key.startsWith('network ')));
  const t = trace('app', { 'fetch(cross-origin https://cdn.example.net .glb)': rec() });
  assert.equal(evaluateCompat({ trace: t, surface }).findings[0]?.status, 'config');
  assert.equal(evaluateCompat({ trace: t, surface, allow: ['https://cdn.example.net'] }).findings.length, 0);
});

test('matrix: ranks by sample count, merges main and worker, estimates per-frame calls', () => {
  const surface = fakeSurface();
  const traces = [
    trace('proto-a', { 'WebGL2RenderingContext.drawElements()': rec({ calls: 200, xrCalls: 100, app: 64 }), 'new Worker': rec() }, [{ 'WorkerGlobalScope.fetch()': rec() }]),
    trace('proto-b', { 'WebGL2RenderingContext.drawElements()': rec({ calls: 50, xrCalls: 50, app: 50 }), 'fetch()': rec() }),
    trace('proto-c', { 'new VideoDecoder': rec() }, [], { reachedXR: false, enteredVia: 'none', xrFrames: 0 }),
  ];
  const m = buildMatrix(traces, surface);
  assert.equal(m.rows[0]?.key, 'fetch()'); // proto-a (worker, normalised) + proto-b
  assert.equal(m.rows[0]?.uses.length, 2);
  assert.deepEqual([...m.rows[0]!.uses.find((u) => u.sample === 'proto-a')!.where], ['worker']);
  const draw = m.rows.find((r) => r.key === 'WebGL2RenderingContext.drawElements()')!;
  assert.equal(draw.uses.find((u) => u.sample === 'proto-a')?.perFrame, 10);
  assert.equal(m.samples.length, 3);
  const md = matrixMarkdown(m, { title: 'T' });
  assert.match(md, /^# T/);
  assert.match(md, /## Gaps, ranked/);
  assert.match(md, /\| `new VideoDecoder` \| 1 \| proto-c \|/);
  assert.match(md, /\| proto-c \| \*\*no\*\* \|/);
  const j = matrixJson(m) as { rows: Array<{ key: string; status: string }> };
  assert.equal(j.rows.find((r) => r.key === 'new Worker')?.status, 'gap');
});

test('check: dormant library code from the baseline is info when only seen statically', () => {
  const d = dist({ 'assets/index.js': 'navigator.mediaDevices.getUserMedia({});\nfetch("https://unpkg.com/x/y.wasm")' });
  const scan = scanDist(d);
  const surface = fakeSurface();
  const baseline = { keys: new Set(['MediaDevices.getUserMedia()']), origins: new Set(['https://unpkg.com']) };
  const r = evaluateCompat({ scan, surface, baseline });
  // a baseline origin is reported as info, not dropped (and not a warning)
  assert.equal(r.findings.find((f) => f.key === 'network https://unpkg.com')?.severity, 'info');
  assert.equal(evaluateCompat({ scan, surface }).findings.find((f) => f.key === 'MediaDevices.getUserMedia()')?.severity, 'warn');
  assert.equal(r.findings.find((f) => f.key === 'MediaDevices.getUserMedia()')?.severity, 'info');
  // traced use still counts
  const t = trace('app', { 'MediaDevices.getUserMedia()': rec() });
  assert.equal(evaluateCompat({ scan, trace: t, surface, baseline }).findings[0]?.severity, 'error');
});

test('scan: an injected emulator in a minified build (class names gone) is found', () => {
  // what IWSDK's injectOnBuild leaves after minification: method names, device-config names and config keys survive
  const d = dist({
    'assets/index-BxTcAwtg.js':
      'const Qe={metaQuest3:{name:"Meta Quest 3"}};class Xt{installRuntime(e){}}const Rn={userAgentException:/x/,activation:"auto",device:"metaQuest3"};new Xt(Qe.metaQuest3).installRuntime({polyfillLayers:!0});',
  });
  const s = scanDist(d);
  assert.equal(s.injectedEmulator.length, 1);
  assert.match(s.injectedEmulator[0]!, /^assets\/index-BxTcAwtg\.js: /);
  const r = evaluateCompat({ scan: s, surface: fakeSurface() });
  assert.equal(r.ok, false);
  assert.equal(r.findings[0]?.key, 'injected WebXR emulator');
  // the fix it names: the metavr build mode (which ignores injectOnBuild), or turning injectOnBuild off
  assert.match(r.findings[0]!.message, /npm run build:metavr/);
  assert.match(r.findings[0]!.message, /or set dev\.emulator\.injectOnBuild to false/);
  // a clean build that only names the config keys as strings (IWSDK's validators) is not flagged
  const clean = scanDist(dist({ 'assets/index.js': 'const keys=["userAgentException","activation"];x.installRuntime;' }));
  assert.deepEqual(clean.injectedEmulator, []);
});

test('check: the app\'s own config and source are not dormant library code', () => {
  // the bundle mentions AR, video and equirect layers in library code every IWSDK build carries
  const d = dist({ 'assets/index.js': 'x.requestSession("immersive-ar");b.createEquirectLayer({});document.createElement("video");' });
  const scan = scanDist(d);
  const surface = fakeSurface();
  const keys = ['XRSystem.requestSession("immersive-ar")', 'XRWebGLBinding.createEquirectLayer()', 'Document.createElement("video")'];
  const baseline = { keys: new Set(keys), origins: new Set<string>(), counts: new Map(keys.map((k) => [k, 1])) };
  const lib = evaluateCompat({ scan, surface, baseline });
  assert.ok(lib.findings.every((f) => f.severity === 'info'), 'library mentions alone stay quiet');
  const app = [
    { key: 'XRSystem.offerSession("immersive-ar")', origin: 'config' as const, evidence: 'iwsdk.config.json world.xr.mode = "ar"' },
    { key: 'XR feature hit-test (required)', origin: 'config' as const, evidence: 'iwsdk.config.json world.xr.features.hitTest' },
    { key: 'XRWebGLBinding.createEquirectLayer()', origin: 'source' as const, evidence: 'src/index.ts:3: new EquirectLayer' },
    { key: 'Document.createElement("video")', origin: 'source' as const, evidence: 'src/film.ts:9' },
    { key: 'new VideoDecoder', origin: 'source' as const, evidence: 'src/film.ts:12' },
  ];
  const r = evaluateCompat({ scan, app, surface, baseline });
  const sev = (k: string) => r.findings.find((f) => f.key === k)?.severity;
  assert.equal(sev('XRSystem.offerSession("immersive-ar")'), 'warn');
  assert.equal(sev('XR feature hit-test (required)'), 'warn');
  assert.equal(sev('XRWebGLBinding.createEquirectLayer()'), 'warn');
  assert.equal(r.findings.find((f) => f.key === 'XRWebGLBinding.createEquirectLayer()')?.source, 'app');
  assert.equal(sev('Document.createElement("video")'), 'warn');
  assert.equal(sev('new VideoDecoder'), 'warn');
  assert.equal(r.advice, UNSUPPORTED_ADVICE); // AR, required features and media get the advice
  assert.equal(evaluateCompat({ scan, app, surface, baseline, strict: true }).ok, false);
  // more mentions than the baseline builds carried: the app added some, so not dormant
  const more = scanDist(dist({ 'assets/index.js': 'b.createEquirectLayer({});b.createEquirectLayer({});' }));
  assert.equal(evaluateCompat({ scan: more, surface, baseline }).findings.find((f) => f.key === 'XRWebGLBinding.createEquirectLayer()')?.severity, 'warn');
});

test('check: media probes are not failures; playback is', () => {
  const surface = fakeSurface();
  const probe = trace('app', { 'Document.createElement("audio")': rec(), 'HTMLMediaElement.canPlayType()': rec() });
  const r = evaluateCompat({ trace: probe, surface });
  assert.equal(r.ok, true);
  assert.equal(r.advice, undefined);
  const play = trace('app', { 'Document.createElement("video")': rec(), 'HTMLMediaElement.play()': rec() });
  const r2 = evaluateCompat({ trace: play, surface });
  assert.equal(r2.ok, false);
  assert.equal(r2.findings[0]?.key, 'HTMLMediaElement.play()');
});

test('check: stubs and missing members the app calls are visible', () => {
  const surface = fakeSurface();
  const t = trace('app', { 'Navigator.getGamepads()': rec({ calls: 500 }), 'CanvasRenderingContext2D.filter=': rec(), 'WebGLActiveInfo.name': rec() });
  const r = evaluateCompat({ trace: t, surface });
  const f = (k: string) => r.findings.find((x) => x.key === k);
  assert.equal(f('Navigator.getGamepads()')?.severity, 'warn');
  assert.equal(f('Navigator.getGamepads()')?.status, 'gap');
  assert.equal(f('CanvasRenderingContext2D.filter=')?.severity, 'warn');
  assert.equal(f('WebGLActiveInfo.name')?.severity, 'info'); // an instance field: works, only prototype probes miss it
  assert.match(formatCompatReport(r), /not implemented yet in input/);
});

test('check: a run that never reached XR says why and is not grouped as an IWER API', () => {
  const surface = fakeSurface();
  const t = trace('app', {}, [], { reachedXR: false, enteredVia: 'none', blockedRequests: ['https://cdn.jsdelivr.net /npm/@iwsdk'], pageErrors: ['AssetLoadError: Failed to load asset "environment-desk"'] });
  const r = evaluateCompat({ trace: t, surface });
  const f = r.findings.find((x) => x.key === 'no XR session (headless run)')!;
  assert.match(f.message, /native\.network\.allow/);
  assert.match(f.message, /--mirror/);
  const text = formatCompatReport(r);
  assert.match(text, /\[warn\] no XR session \(headless run\)/);
  assert.doesNotMatch(text, /not implemented yet in IWER host mode/);
});

test('check: cross-origin asset URLs on any host warn statically, other URLs are info', () => {
  const d = dist({ 'assets/index.js': 'load("https://assets.example-cdn.io/models/robot.glb");const home="https://blog.someone.net/about";' });
  const r = evaluateCompat({ scan: scanDist(d), surface: fakeSurface() });
  assert.equal(r.findings.find((f) => f.key === 'network https://assets.example-cdn.io')?.severity, 'warn');
  assert.equal(r.findings.find((f) => f.key === 'network https://blog.someone.net')?.severity, 'info');
});

test('matrix: app config/source rows and the headset-only path', () => {
  const surface = fakeSurface();
  const traces = [
    trace('layers', { 'XRSystem.offerSession("immersive-vr")': rec() }),
    trace('desktop', {}, [], { reachedXR: false, enteredVia: 'none', xrFrames: 0 }),
  ];
  const app = {
    layers: [
      { key: 'XRSystem.offerSession("immersive-vr")', origin: 'config' as const, evidence: 'iwsdk.config.json' },
      { key: 'XRWebGLBinding.createEquirectLayer()', origin: 'source' as const, evidence: 'src/index.ts:3' },
    ],
  };
  const m = buildMatrix(traces, surface, { app });
  const row = (k: string) => m.rows.find((r) => r.key === k);
  assert.deepEqual([...row('XRWebGLBinding.createEquirectLayer()')!.uses[0]!.where], ['source']);
  assert.equal(row('XRWebGLBinding.createEquirectLayer()')!.resolution.status, 'later');
  assert.equal(row('XRSystem.offerSession("immersive-vr")')!.uses[0]!.where.has('config'), false); // traced already
  assert.deepEqual(row('XRWebGLBinding.createProjectionLayer()')!.uses.map((u) => u.sample), ['layers']); // not the desktop sample
  assert.match(matrixMarkdown(m), /\| `XRWebGLBinding.createEquirectLayer\(\)` \| 1 \| layers \|/);
});

test('check: WebGPU, the camera feature and desktop-only apps warn from the app\'s own code and print the advice', () => {
  const surface = fakeSurface();
  const d = dist({ 'assets/index.js': 'await navigator.gpu.requestAdapter(); c.getContext("webgpu");' });
  const scan = scanDist(d);
  const app = [
    { key: 'Navigator.gpu.requestAdapter()', origin: 'source' as const, evidence: 'src/main.ts:1' },
    { key: 'HTMLCanvasElement.getContext("webgpu")', origin: 'source' as const, evidence: 'src/main.ts:2' },
  ];
  const r = evaluateCompat({ scan, surface, app });
  for (const k of ['Navigator.gpu.requestAdapter()', 'HTMLCanvasElement.getContext("webgpu")']) {
    const f = r.findings.find((x) => x.key === k)!;
    assert.equal(f.status, 'unsupported', k);
    assert.equal(f.severity, 'warn', k);
    assert.deepEqual(f.spec, ['DOM-4']);
  }
  assert.equal(r.advice, UNSUPPORTED_ADVICE);
  // --strict fails them
  assert.equal(evaluateCompat({ scan, surface, app, strict: true }).ok, false);
  // the camera feature: dormant in the bundle, but the config turns it on
  const cam = scanDist(dist({ 'assets/index.js': 'navigator.mediaDevices.getUserMedia({video:true})' }));
  const baseline = { keys: new Set(['MediaDevices.getUserMedia()']), origins: new Set<string>(), counts: new Map([['MediaDevices.getUserMedia()', 1]]) };
  const rc = evaluateCompat({ scan: cam, surface, baseline, app: [{ key: 'MediaDevices.getUserMedia()', origin: 'config', evidence: 'world.features.camera = true' }] });
  const fc = rc.findings.find((x) => x.key === 'MediaDevices.getUserMedia()')!;
  assert.equal(fc.severity, 'warn');
  assert.ok(fc.spec.includes('XR-SEC-1'));
  assert.equal(rc.advice, UNSUPPORTED_ADVICE);
  // XR-LIFE-7
  const rx = evaluateCompat({ scan: cam, surface, baseline, app: [{ key: 'no XR entry (xr: false)', origin: 'config', evidence: 'world.xr = false' }] });
  const fx = rx.findings.find((x) => x.key === 'no XR entry (xr: false)')!;
  assert.equal(fx.severity, 'warn');
  assert.match(fx.message, /^no immersive session on the headset: .*XR-LIFE-7/);
  assert.equal(rx.advice, UNSUPPORTED_ADVICE);
});

test('check: IWSDK\'s decoder origin warns when dist has KTX2/Draco assets; baseline version drift is reported', () => {
  const surface = fakeSurface();
  const js = 'const Yf=`https://unpkg.com/three@0.177.0`; x.setTranscoderPath(`${Yf}/examples/jsm/libs/basis/`); fetch("https://unpkg.com/three@0.177.0/examples/jsm/libs/draco/gltf/draco_decoder.wasm")';
  const baseline = { keys: new Set<string>(), origins: new Set(['https://unpkg.com']), iwsdk: '1.0.1' };
  const plain = evaluateCompat({ scan: scanDist(dist({ 'assets/index.js': js })), surface, baseline, iwsdkVersion: '1.0.1' });
  assert.equal(plain.findings.find((f) => f.key === 'network https://unpkg.com')?.severity, 'info');
  assert.ok(!plain.findings.some((f) => f.key === 'static baseline version'));
  const withKtx = scanDist(dist({ 'assets/index.js': js, 'textures/a.ktx2': 'KTX', 'models/m.glb': 'glTF....{"extensionsUsed":["KHR_draco_mesh_compression"]}' }));
  assert.deepEqual(withKtx.compressedAssets, { ktx2: ['textures/a.ktx2'], draco: ['models/m.glb'] });
  const r = evaluateCompat({ scan: withKtx, surface, baseline, iwsdkVersion: '1.2.0' });
  const f = r.findings.find((x) => x.key === 'network https://unpkg.com')!;
  assert.equal(f.severity, 'warn');
  assert.match(f.message, /1 KTX2\/Basis asset\(s\) and 1 Draco mesh/);
  assert.equal(evaluateCompat({ scan: withKtx, surface, baseline, allow: ['https://unpkg.com'] }).findings.find((x) => x.key === 'network https://unpkg.com'), undefined);
  // an app on a newer IWSDK than the baseline's: informational (baselineDrift, next test)
  assert.equal(r.findings.find((x) => x.key === 'static baseline version')?.severity, 'info');
  assert.equal(evaluateCompat({ scan: withKtx, surface, baseline, iwsdkVersion: '1.0.3' }).findings.find((x) => x.key === 'static baseline version')?.severity, 'info');
});

test('check: baseline version drift warns only for an older minor or another major, with advice the user can act on', () => {
  const surface = fakeSurface();
  const scan = scanDist(dist({ 'assets/index.js': 'console.log("hello");' }));
  const finding = (iwsdkVersion: string, base = '1.2.0', strict = false) => {
    const r = evaluateCompat({ scan, surface, baseline: { keys: new Set<string>(), origins: new Set<string>(), iwsdk: base }, iwsdkVersion, strict });
    return { r, f: r.findings.find((x) => x.key === 'static baseline version') };
  };
  assert.equal(finding('1.2.0').f, undefined);
  // a newer minor (compared as numbers: 1.10 is newer than 1.2), another patch, a prerelease of the same minor:
  // informational, so --strict passes
  for (const [app, base] of [['1.3.0', '1.2.0'], ['1.10.4', '1.2.0'], ['1.2.5', '1.2.0'], ['1.2.0-rc.1', '1.2.0'], ['1.2.0', '1.2.1']]) {
    const { r, f } = finding(app!, base, true);
    assert.equal(f?.severity, 'info', `${app} vs ${base}`);
    assert.equal(r.warnings, 0, `${app} vs ${base}`);
    assert.equal(r.ok, true, `${app} vs ${base}`);
  }
  // an older minor or another major: a warning, which --strict turns into a failure at the CLI
  for (const app of ['1.1.0', '1.0.1', '0.5.3', '2.0.0']) {
    const { r, f } = finding(app, '1.2.0', true);
    assert.equal(f?.severity, 'warn', app);
    assert.equal(r.warnings, 1, app);
  }
  assert.match(finding('1.1.0').f!.message, /an older minor version: .*Update @iwsdk\/core and @iwsdk\/vite-plugin-dev to 1\.2\.0 or later/);
  assert.match(finding('0.5.3').f!.message, /an older major version: .*to 1\.2\.0 or later/);
  assert.match(finding('2.0.0').f!.message, /a newer major version: .*A later @iwer\/native release can carry a baseline for IWSDK 2/);
  assert.equal(finding('file:../iwsdk').f?.severity, 'info');
  assert.equal(baselineDrift('1.2.0', '1.3.0').severity, 'info');
  // every message says what the user can run; none points at the package's maintainer scripts (not in the package)
  for (const app of ['1.1.0', '0.5.3', '2.0.0', '1.3.0', '1.2.1', 'file:../iwsdk']) {
    const m = finding(app).f!.message;
    assert.match(m, /`npx iwer-native compat --trace`/, app);
    assert.doesNotMatch(m, /compat\/scripts|baseline\.mjs|[Rr]egenerate/, app);
  }
});

test('check: with the headset trim, guarded absent APIs are not failures; unguarded ones are', () => {
  const surface = fakeSurface();
  const d = dist({ 'assets/index.js': 'if(typeof VideoDecoder!=="undefined"){new VideoDecoder({})} if(navigator.gpu){navigator.gpu.requestAdapter()} new SharedWorker("w.js")' });
  const scan = scanDist(d);
  const app = [
    { key: 'new VideoDecoder', origin: 'source' as const, evidence: 'src/main.js:2', guarded: "src/main.js:1: typeof VideoDecoder !== 'undefined'" },
    { key: 'Navigator.gpu.requestAdapter()', origin: 'source' as const, evidence: 'src/main.js:4' },
  ];
  // the trimmed run: the app probed navigator.gpu (miss), never called the removed APIs, and reached XR
  const t = trace('guarded', { 'miss:Navigator.gpu': rec(), 'XRSystem.offerSession("immersive-vr")': rec() }, [], { removed: ['VideoDecoder', 'SharedWorker', 'Navigator.gpu'] });
  t.main!.removed = ['VideoDecoder', 'SharedWorker', 'Navigator.gpu'];
  const r = evaluateCompat({ scan, surface, app, trace: t });
  const sev = (k: string) => r.findings.find((f) => f.key === k)?.severity;
  assert.equal(r.errors, 0);
  assert.equal(sev('new VideoDecoder'), 'info');
  assert.match(r.findings.find((f) => f.key === 'new VideoDecoder')!.message, /feature-detected .* as it did in the headless run/);
  assert.equal(sev('Navigator.gpu.requestAdapter()'), 'info');
  // SharedWorker: a bundle mention without a feature check stays a warning, with what the run showed
  assert.equal(sev('new SharedWorker'), 'warn');
  assert.match(r.findings.find((f) => f.key === 'new SharedWorker')!.message, /did not reach it, but no feature check/);
  assert.equal(r.advice, undefined);
  // an unguarded use threw in the trimmed run: an error with the advice
  const t2 = trace('unguarded', { 'XRSystem.offerSession("immersive-vr")': rec() }, [], { removed: ['VideoDecoder'], pageErrors: ['ReferenceError: VideoDecoder is not defined\n    at http://127.0.0.1/assets/index.js:1:5'] });
  const r2 = evaluateCompat({ scan, surface, trace: t2 });
  const f2 = r2.findings.find((f) => f.key === 'VideoDecoder (used without a feature check)')!;
  assert.equal(f2.severity, 'error');
  assert.equal(r2.findings.find((f) => f.key === 'new VideoDecoder')?.severity, 'warn'); // threw, so not "not hit"
  assert.equal(r2.advice, UNSUPPORTED_ADVICE);
});

test('check: an AudioWorklet app is told AudioWorklet is absent (AUD-6), and an unguarded use that threw is an error', () => {
  const surface = fakeSurface();
  const scan = scanDist(dist({ 'assets/main.js': "await ctx.audioWorklet.addModule('synth.js'); const n = new AudioWorkletNode(ctx, 'synth');" }));
  const r = evaluateCompat({ scan, surface, app: [{ key: 'new AudioWorkletNode', origin: 'source', evidence: 'src/main.js:1' }] });
  const f = r.findings.find((x) => x.key === 'new AudioWorkletNode');
  assert.ok(f, r.findings.map((x) => x.key).join(', '));
  assert.equal(f.status, 'unsupported');
  assert.equal(f.severity, 'warn');
  assert.equal(r.advice, UNSUPPORTED_ADVICE);
  // the trimmed run removed ctx.audioWorklet: the app read addModule of undefined
  const t = trace('aw', { 'XRSystem.offerSession("immersive-vr")': rec() }, [], {
    removed: ['AudioWorklet', 'AudioWorkletNode', 'BaseAudioContext.audioWorklet'],
    pageErrors: ["TypeError: Cannot read properties of undefined (reading 'addModule')\n    at http://127.0.0.1:1/assets/main.js:1:20"],
  });
  t.main!.removed = t.removed!;
  const r2 = evaluateCompat({ scan, surface, trace: t, app: [{ key: 'AudioWorklet.addModule()', origin: 'source', evidence: 'src/main.js:1' }] });
  assert.equal(r2.findings.find((x) => x.key === 'AudioWorklet (used without a feature check)')?.severity, 'error');
  assert.equal(r2.ok, false);
});

test('check: an unguarded read of a removed navigator member is not a feature check, even though the miss probe fired', () => {
  const surface = fakeSurface();
  const scan = scanDist(dist({ 'assets/main.js': 'setTimeout(() => { navigator.gpu.requestAdapter().then(console.log) }, 500); navigator.mediaDevices.getUserMedia({})' }));
  const app = [{ key: 'Navigator.gpu.requestAdapter()', origin: 'source' as const, evidence: 'src/main.js:11' }];
  const removed = ['Navigator.gpu', 'Navigator.mediaDevices'];
  const mk = (pageErrors: string[], site = '/assets/main.js:11:30') => {
    const t = trace('nav', { 'miss:Navigator.gpu': rec({ site }), 'XRSystem.offerSession("immersive-vr")': rec() }, [], { removed, pageErrors });
    t.main!.removed = removed;
    return evaluateCompat({ scan, surface, app, trace: t });
  };
  // Chromium names the next member, not the root
  const r = mk(["TypeError: Cannot read properties of undefined (reading 'requestAdapter')\n    at http://127.0.0.1:46971/assets/main.js:11:34"]);
  const f = r.findings.find((x) => x.key === 'navigator.gpu (used without a feature check)')!;
  assert.equal(f.severity, 'error');
  assert.deepEqual(f.spec, ['DOM-4']);
  assert.doesNotMatch(r.findings.find((x) => x.key === 'Navigator.gpu.requestAdapter()')!.message, /fallback runs/);
  assert.doesNotMatch(r.findings.find((x) => x.key === 'miss:Navigator.gpu')!.message, /only probes it/);
  assert.equal(r.ok, false);
  assert.equal(r.advice, UNSUPPORTED_ADVICE);
  // no member key in the scan/app signals: the error's top frame at the miss site is enough
  const t2 = trace('nav2', { 'miss:Navigator.gpu': rec({ site: '/assets/main.js:1:4000' }) }, [], {
    removed,
    pageErrors: ["TypeError: Cannot read properties of undefined (reading 'zz')\n    at Xa (http://127.0.0.1:1/assets/main.js:1:4004)\n    at http://127.0.0.1:1/assets/main.js:1:9"],
  });
  t2.main!.removed = removed;
  assert.equal(evaluateCompat({ surface, trace: t2 }).findings.find((x) => x.key === 'navigator.gpu (used without a feature check)')?.severity, 'error');
  // a page error elsewhere does not void a real feature check
  const r3 = mk(["TypeError: Cannot read properties of undefined (reading 'foo')\n    at http://127.0.0.1:46971/assets/main.js:40:2"]);
  assert.equal(r3.findings.find((x) => x.key === 'Navigator.gpu.requestAdapter()')?.severity, 'info');
  assert.ok(!r3.findings.some((x) => x.key.endsWith('(used without a feature check)')));
});

test('check: asking whether AR is supported is not needing AR; a run without XR says why', () => {
  const surface = fakeSurface();
  const scan = scanDist(dist({ 'assets/index.js': 'navigator.xr.isSessionSupported("immersive-ar")' }));
  const app = [{ key: 'XRSystem.isSessionSupported("immersive-ar")', origin: 'source' as const, evidence: 'src/index.ts:2' }];
  const t = trace('fp1', { 'XRSystem.isSessionSupported("immersive-ar")': rec(), 'XRSystem.offerSession("immersive-vr")': rec() });
  const r = evaluateCompat({ scan, surface, app, trace: t });
  assert.equal(r.warnings, 0);
  assert.equal(r.advice, undefined);
  // an AR-only app under the headset-like emulation: no session, and the reason is AR
  const ar = trace('ar', { 'XRSystem.offerSession("immersive-ar")': rec() }, [], { reachedXR: false, enteredVia: 'none', emulateAR: false });
  assert.match(evaluateCompat({ scan, surface, trace: ar }).findings.find((f) => f.key === 'no XR session (headless run)')!.message, /asked for an immersive-ar session/);
  // a slow app that never touched navigator.xr: suggest a longer boot timeout, not XR-LIFE-7
  const slow = trace('slow', { 'HTMLCanvasElement.getContext("webgl2")': rec() }, [], { reachedXR: false, enteredVia: 'none', bootTimeoutMs: 25_000 });
  const fs = evaluateCompat({ scan, surface, trace: slow }).findings.find((f) => f.key === 'no XR session (headless run)')!;
  assert.match(fs.message, /25 s boot timeout .*--boot-ms/);
  assert.deepEqual(fs.spec, []);
});

test('inventory: stubs fail unconditionally or admit it in a warning; spec error paths are not stubs', () => {
  assert.equal(isStubSource('createWaveShaper() {\n  throw domError("NotSupportedError", "WaveShaperNode is not supported");\n}'), true);
  assert.equal(isStubSource('set filter(v) { const s = String(v); this.#s.filter = s; if (s !== "none") warnOnce("filter", `ctx.filter is not implemented yet`); }'), true);
  assert.equal(isStubSource('static timeout(ms) { if (arguments.length === 0) throw new TypeError("x"); const set = globalThis.setTimeout; if (typeof set !== "function") { throw domException("needs timers", "NotSupportedError"); } return s; }'), false);
  assert.equal(isStubSource('set buffer(b) { if (b !== null && !(b instanceof AudioBuffer)) throw new TypeError("x"); if (b && b.numberOfChannels > 4) throw domError("NotSupportedError", "channels"); this.#b = b; }'), false);
  assert.equal(isStubSource('stream() { const RS = readableStreamCtor(); if (typeof RS !== "function") { throw domException("needs ReadableStream", "NotSupportedError"); } return new RS({}); }'), false);
});

test('check: a run without XR names the app\'s own no-entry setting, or a busy boot, before blaming the app', () => {
  const surface = fakeSurface();
  const scan = scanDist(dist({ 'assets/index.js': '' }));
  const t = trace('browser', { 'Navigator.xr': rec() }, [], { reachedXR: false, enteredVia: 'none' });
  const f1 = evaluateCompat({ scan, surface, trace: t, app: [{ key: 'no XR entry (xr: false)', origin: 'config', evidence: 'iwsdk.config.json world.xr = false' }] }).findings.find((f) => f.key === 'no XR session (headless run)')!;
  assert.match(f1.message, /as the app's own config says .*world\.xr = false/);
  const busy = trace('busy', { 'Navigator.xr': rec() }, [], { reachedXR: false, enteredVia: 'none', stillLoading: 'last request 0.3 s before the boot timeout' });
  assert.match(evaluateCompat({ scan, surface, trace: busy }).findings.find((f) => f.key === 'no XR session (headless run)')!.message, /most likely still loading .*--boot-ms/);
  const quiet = trace('quiet', { 'Navigator.xr': rec() }, [], { reachedXR: false, enteredVia: 'none' });
  assert.match(evaluateCompat({ scan, surface, trace: quiet }).findings.find((f) => f.key === 'no XR session (headless run)')!.message, /had gone quiet/);
});

test('check: control runs decide whether a page error comes from removing a root (split and far uses, unrelated errors)', () => {
  const surface = fakeSurface();
  const removed = ['Navigator.gpu', 'Navigator.serviceWorker'];
  const mk = (apis: Record<string, ReturnType<typeof rec>>, pageErrors: string[], controls?: Array<{ kept: string; pageErrors: string[] }>) => {
    const t = trace('ctl', { ...apis, 'XRSystem.offerSession("immersive-vr")': rec() }, [], { removed, pageErrors });
    t.main!.removed = removed;
    if (controls) t.controls = controls.map((c) => ({ ...c, reachedXR: true }));
    return evaluateCompat({ surface, trace: t });
  };
  const unguarded = (r: ReturnType<typeof evaluateCompat>, root: string) => r.findings.find((x) => x.key === `${root} (used without a feature check)`);
  // nav-gpu-split: `const gpu = navigator.gpu` on line 1, `gpu.requestAdapter()` on line 13 (no heuristic matches)
  const split = ["TypeError: Cannot read properties of undefined (reading 'requestAdapter')\n    at http://127.0.0.1:41000/assets/main.js:13:7"];
  const miss = { 'miss:Navigator.gpu': rec({ site: '/assets/main.js:1:23' }) };
  const r0 = mk(miss, split);
  assert.deepEqual(r0.controlCandidates, ['Navigator.gpu']);
  assert.equal(unguarded(r0, 'navigator.gpu'), undefined);
  // the control run (navigator.gpu left in place) does not throw: the removal caused it
  const r1 = mk(miss, split, [{ kept: 'Navigator.gpu', pageErrors: [] }]);
  assert.equal(unguarded(r1, 'navigator.gpu')?.severity, 'error');
  assert.equal(r1.ok, false);
  assert.equal(r1.advice, UNSUPPORTED_ADVICE);
  assert.equal(r1.controlCandidates, undefined);
  // gpu-guarded-fallback-bug: `if (navigator.gpu) {...} else { buggy fallback }`, guard found in the app's source; the
  // removal makes the fallback run and throw. Still an error, but blamed on the fallback, not a missing check
  const fb = ["TypeError: Cannot read properties of undefined (reading 'antialias')\n    at http://127.0.0.1:41000/assets/main.js:2:120"];
  const tg = trace('ctl', { ...miss, 'XRSystem.offerSession("immersive-vr")': rec() }, [], { removed, pageErrors: fb });
  tg.main!.removed = removed;
  tg.controls = [{ kept: 'Navigator.gpu', pageErrors: [], reachedXR: true }];
  const rg = evaluateCompat({ surface, trace: tg, app: [{ key: 'Navigator.gpu', origin: 'source', evidence: 'src/main.js:2', guarded: 'src/main.js:2: if (navigator.gpu)' }] });
  assert.equal(unguarded(rg, 'navigator.gpu'), undefined);
  const fbf = rg.findings.find((x) => x.key === 'navigator.gpu (threw with it removed, although the app checks for it)');
  assert.equal(fbf?.severity, 'error');
  // neutral: the guard may sit in one helper and the throwing use elsewhere (gpu-mixed), so both are named
  assert.match(fbf!.message, /checks for it .*it threw .*outside that check or the branch the app takes without it/);
  assert.doesNotMatch(fbf!.message, /without a check/);
  // guard-near-error: a guarded probe and an unrelated error 89 columns to the right on the same line; the control
  // run (other port) throws the same error, so it is not the removal's
  const near = (port: number) => [`TypeError: Cannot read properties of undefined (reading 'zzz')\n    at http://127.0.0.1:${port}/assets/main.js:11:93`];
  const nearMiss = { 'miss:Navigator.gpu': rec({ site: '/assets/main.js:11:4' }) };
  assert.equal(unguarded(mk(nearMiss, near(41000)), 'navigator.gpu')?.severity, 'error'); // heuristic alone: wrong
  const r2 = mk(nearMiss, near(41000), [{ kept: 'Navigator.gpu', pageErrors: near(42000) }]);
  assert.equal(unguarded(r2, 'navigator.gpu'), undefined);
  assert.equal(r2.ok, true);
  // sw-generic: a guarded serviceWorker probe, the static register() signal, and an unrelated plugins.register on undefined
  const sw = (port: number) => [`TypeError: Cannot read properties of undefined (reading 'register')\n    at http://127.0.0.1:${port}/assets/main.js:13:28`];
  const swApis = { 'miss:serviceWorker (in, Navigator chain)': rec({ site: '/assets/main.js:1:20' }), 'ServiceWorkerContainer.register()': rec({ app: 0 }) };
  const t3 = trace('sw', { ...swApis }, [], { removed, pageErrors: sw(41000), controls: [{ kept: 'Navigator.serviceWorker', pageErrors: sw(43000), reachedXR: true }] });
  t3.main!.removed = removed;
  const r3 = evaluateCompat({ surface, trace: t3, app: [{ key: 'ServiceWorkerContainer.register()', origin: 'source', evidence: 'src/main.js:1', guarded: "src/main.js:1: if ('serviceWorker' in navigator)" }] });
  // one control run per root: the `in` probe's bare name is the navigator member, not a separate global
  const t3b = trace('sw', { ...swApis }, [], { removed, pageErrors: sw(41000) });
  t3b.main!.removed = removed;
  assert.deepEqual(evaluateCompat({ surface, trace: t3b }).controlCandidates, ['Navigator.serviceWorker']);
  assert.equal(unguarded(r3, 'navigator.serviceWorker'), undefined);
  assert.equal(r3.ok, true);
  // a hung control run settles nothing: back to the heuristics
  const r4 = mk(nearMiss, near(41000), [{ kept: 'Navigator.gpu', pageErrors: [], hung: 'x' } as { kept: string; pageErrors: string[] }]);
  assert.ok(r4.controlCandidates === undefined || r4.controlCandidates.includes('Navigator.gpu'));
});

test('check: without a control run, an error reading a member the app uses counts even away from the miss site', () => {
  const surface = fakeSurface();
  const removed = ['Navigator.gpu'];
  const t = trace('read', { 'miss:Navigator.gpu': rec({ site: '/assets/main.js:1:23' }), 'XRSystem.offerSession("immersive-vr")': rec() }, [], {
    removed,
    pageErrors: ["TypeError: Cannot read properties of undefined (reading 'requestAdapter')\n    at http://127.0.0.1:1/assets/main.js:40:2"],
  });
  t.main!.removed = removed;
  const r = evaluateCompat({ surface, trace: t, app: [{ key: 'Navigator.gpu.requestAdapter()', origin: 'source', evidence: 'src/main.js:40' }] });
  assert.equal(r.findings.find((x) => x.key === 'navigator.gpu (used without a feature check)')?.severity, 'error');
});

test('check: a stubbed absent API fails when called (a guard does not help); WebSocket is absent in the alpha', () => {
  const s = measuredSurface({ generatedAt: 't', packageRoot: '/x', layers: [
    { layer: 'v8', how: 'eval', globals: ['Object'], members: [] },
    { layer: 'web/audio', how: 'eval', globals: ['AudioContext', 'BaseAudioContext'], members: ['BaseAudioContext.createScriptProcessor'], stubs: ['BaseAudioContext.createScriptProcessor'] },
  ] }, ['XRSystem.offerSession']);
  const t = trace('sp', { 'BaseAudioContext.createScriptProcessor()': rec(), 'XRSystem.offerSession("immersive-vr")': rec() });
  const r = evaluateCompat({ surface: s, trace: t });
  const f = r.findings.find((x) => x.key === 'BaseAudioContext.createScriptProcessor()')!;
  assert.equal(f.severity, 'error');
  assert.equal(r.advice, UNSUPPORTED_ADVICE);
  // static-only and "guarded": still a warning, not downgraded to info
  const scan = scanDist(dist({ 'assets/main.js': 'if (ctx.createScriptProcessor) ctx.createScriptProcessor(1024, 1, 1);' }));
  const r2 = evaluateCompat({ surface: s, scan, app: [{ key: 'BaseAudioContext.createScriptProcessor()', origin: 'source', evidence: 'src/main.js:1', guarded: 'src/main.js:1: if (ctx.createScriptProcessor)' }] });
  const f2 = r2.findings.find((x) => x.key === 'BaseAudioContext.createScriptProcessor()')!;
  assert.equal(f2.severity, 'warn');
  assert.match(f2.message, /stub/);
  // WebSocket is absent in the alpha: an allowlisted wss:// origin does not make it work, so a traced use fails and the
  // check never suggests an allowlist entry as the fix
  const ws = scanDist(dist({ 'assets/main.js': "const ws = new WebSocket('wss://game.example-mp.net/room');" }));
  const t3 = trace('ws', { 'new WebSocket(cross-origin wss://game.example-mp.net)': rec(), 'XRSystem.offerSession("immersive-vr")': rec() }, [], { blockedRequests: [] });
  const ok = evaluateCompat({ surface: fakeSurface(), scan: ws, trace: t3, allow: ['https://game.example-mp.net'] });
  assert.equal(ok.findings.find((x) => x.key === 'new WebSocket(cross-origin wss://game.example-mp.net)')?.severity, 'error');
  assert.equal(ok.ok, false);
  const st = evaluateCompat({ surface: fakeSurface(), scan: ws, allow: ['https://game.example-mp.net'] });
  assert.ok(st.findings.some((x) => x.severity === 'warn' && /WebSocket/.test(x.key) && /not supported in this alpha/.test(x.message)), st.findings.map((x) => `${x.severity} ${x.key}: ${x.message}`).join('\n'));
  const no = evaluateCompat({ surface: fakeSurface(), scan: ws });
  const msgs = no.findings.filter((x) => /game\.example-mp\.net/.test(x.key + x.message)).map((x) => x.message).join('\n');
  assert.match(msgs, /WebSocket is not supported in this alpha/);
  assert.doesNotMatch(msgs, /native\.network\.allow/);
});
