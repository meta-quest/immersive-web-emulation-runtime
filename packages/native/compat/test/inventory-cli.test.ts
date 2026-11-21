/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { buildTestDist, buildTestTemplate } from '../../packager/test/helpers.ts';
import { runCli, type CliIo } from '../../src/cli/main.ts';
import { declaredFeatures, loadBaseline } from '../src/cli.ts';
import { buildInventory } from '../src/inventory.ts';
import { scanDist } from '../src/scan.ts';
import { fromSnapshot, toSnapshot } from '../src/surface.ts';
import { measuredSurface, parseKey, resolve } from '../src/providers.ts';
import { tempDir, writeTree } from './helpers.ts';

test('inventory: layers measured in order, protocol-checked bundles retried, source fallback', () => {
  const root = writeTree(tempDir(), {
    'runtime/core/js/bootstrap.js': '(function (natives, g) { g.setTimeout = function setTimeout() {}; })',
    'web/glue/dist/glue.js': 'globalThis.URL = class URL { get href() { return ""; } }; globalThis.navigator = { platform: "x" };',
    'web/audio/dist/audio.js': 'if (__iwn.audio.protocolVersion !== 3) throw new Error("iwn.audio protocol mismatch: native " + __iwn.audio.protocolVersion + ", JS 3"); globalThis.AudioContext = class AudioContext { createGain() {} };',
    'web/webgl/dist/webgl.js': 'globalThis.WebGL2RenderingContext = class { drawElements() {} }; const EXTS = ["OVR_multiview2", "EXT_color_buffer_float"];',
    'web/dom/src/index.ts': 'export class HTMLDivElement { appendChild() {} }',
  });
  const inv = buildInventory(root);
  const by = Object.fromEntries(inv.layers.map((l) => [l.layer, l]));
  assert.deepEqual(inv.layers.map((l) => l.layer), ['v8', 'runtime/core', 'web/glue', 'web/audio', 'web/dom', 'web/webgl']);
  assert.ok(by.v8!.globals.includes('Intl'));
  assert.deepEqual(by['runtime/core']!.globals, ['setTimeout']);
  assert.ok(by['web/glue']!.members.includes('URL.href'));
  assert.ok(by['web/glue']!.members.includes('navigator.platform'));
  assert.equal(by['web/audio']!.how, 'eval');
  assert.ok(by['web/audio']!.members.includes('AudioContext.createGain'));
  assert.ok(!by['web/audio']!.members.some((m) => m.endsWith('.hasOwnProperty'))); // the context's Object.prototype ends the walk
  assert.equal(by['web/dom']!.how, 'source');
  assert.ok(by['web/dom']!.tokens!.includes('HTMLDivElement'));
  assert.deepEqual(by['web/webgl']!.tokens, ['EXT_color_buffer_float', 'OVR_multiview2']);
  // snapshot round trip
  const s = measuredSurface(inv, ['XRSession']);
  const back = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(s, 'test'))));
  assert.equal(back.globals.get('AudioContext'), 'web/audio');
  assert.equal(back.extNames.get('OVR_multiview2'), 'web/webgl');
  assert.ok(back.iwer.has('XRSession'));
});

test('inventory: opt-in preludes and natives do not count; constructor stubs are recorded; window aliases are skipped', () => {
  const root = writeTree(tempDir(), {
    'web/glue/dist/glue.js': 'globalThis.frames = globalThis; globalThis.top = globalThis; globalThis.EventTarget = class EventTarget {};',
    // installs WebSocket only over the opt-in transport, like web/net
    'web/net/dist/net.js': 'const n = __iwn.net; globalThis.fetch = function fetch() {}; if (typeof n.wsConnect === "function" && typeof n.wsSend === "function") globalThis.WebSocket = class WebSocket {};',
    'web/storage/dist/storage.js': 'globalThis.localStorage = { getItem() {} };',
    'web/storage/dist/idb.js': 'globalThis.indexedDB = { open() {} }; globalThis.caches = { open() {} };',
    'web/audio/dist/audio.js': 'function unsupportedNode(name) { return class { constructor() { throw new DOMException(name + " is not supported", "NotSupportedError"); } }; } globalThis.GainNode = class GainNode { constructor() {} }; globalThis.WaveShaperNode = unsupportedNode("WaveShaperNode");',
  });
  const inv = buildInventory(root);
  const all = inv.layers.flatMap((l) => l.globals);
  assert.ok(all.includes('fetch') && !all.includes('WebSocket'), 'no WebSocket without the opt-in transport');
  assert.ok(all.includes('localStorage') && !all.includes('indexedDB') && !all.includes('caches'), 'idb.js is an opt-in prelude');
  const audio = inv.layers.find((l) => l.layer === 'web/audio')!;
  assert.deepEqual(audio.stubs, ['WaveShaperNode']);
  assert.ok(!inv.layers.some((l) => l.members.some((m) => /^(frames|top)\./.test(m))), 'window aliases are not walked');
  const s = measuredSurface(inv, []);
  const r = (k: string) => resolve(parseKey(k), s);
  // a stub of an alpha-later API is the alpha gate: "later" (a warning), still marked as a stub
  assert.equal(r('new WaveShaperNode').status, 'later');
  assert.equal(r('new WaveShaperNode').stub, true);
  assert.equal(r('new GainNode').status, 'provided');
  assert.equal(r('new WebSocket').status, 'unsupported');
  assert.equal(r('IDBFactory.open()').status, 'unsupported');
});

function io(cwd: string): CliIo & { out: string; err: string } {
  const o = {
    out: '',
    err: '',
    stdout: (t: string) => {
      o.out += t;
    },
    stderr: (t: string) => {
      o.err += t;
    },
    cwd,
    env: {},
    nodeVersion: '24.10.0',
    exec: async () => ({ code: 1, stdout: '', stderr: '' }),
  };
  return o as CliIo & { out: string; err: string };
}

test('cli: iwer-native compat (static) exit codes and json', async () => {
  const proj = writeTree(tempDir(), {
    'dist/index.html': '<html><head></head><body><script type="module" src="/a.js"></script></body></html>',
    'dist/a.js': 'c.getContext("webgl2"); new VideoDecoder({});',
    'iwsdk.config.json': JSON.stringify({ native: { network: { allow: [] } } }),
  });
  const a = io(proj);
  assert.equal(await runCli(['compat'], a), 0);
  // new VideoDecoder only: canvas.getContext is provided since web/dom defines HTMLCanvasElement (DOM-6/DOM-8)
  assert.match(a.out, /compat: 0 error\(s\), 1 warning\(s\)/);
  assert.match(a.out, /new VideoDecoder/);
  const b = io(proj);
  assert.equal(await runCli(['compat', '--strict'], b), 1);
  const c = io(proj);
  assert.equal(await runCli(['compat', '--json'], c), 0);
  const j = JSON.parse(c.out) as { ok: boolean; findings: Array<{ key: string }> };
  assert.equal(j.ok, true);
  writeTree(proj, { 'dist/e.js': 'new XRDevice(metaQuest3).installRuntime()' });
  const d = io(proj);
  assert.equal(await runCli(['compat'], d), 1);
  assert.match(d.out, /injectOnBuild/);
  const e = io(path.join(proj, 'nope'));
  assert.equal(await runCli(['compat'], e), 2);
  assert.match(e.err, /no index\.html/);
});

test('cli: the dormant-library baseline applies to IWSDK apps only; a plain three.js app gets its warnings', async () => {
  const files = {
    'dist/index.html': '<html><head></head><body><script type="module" src="/assets/a.js"></script></body></html>',
    'dist/assets/a.js': 'const s=await navigator.mediaDevices.getUserMedia({video:true});const q=b.createEquirectLayer({});',
    'index.html': '<html><head><script type="module" src="/main.js"></script></head></html>',
  };
  // Vite's vanilla layout: main.js at the project root, no src/, no IWSDK
  const plain = writeTree(tempDir(), { ...files, 'package.json': '{"dependencies":{"three":"0.181.0"}}', 'main.js': 'const s = await navigator.mediaDevices.getUserMedia({ video: true });\nconst q = binding.createEquirectLayer({});' });
  const a = io(plain);
  assert.equal(await runCli(['compat', '--verbose'], a), 0);
  assert.match(a.out, /\[warn\] MediaDevices\.getUserMedia\(\)/);
  assert.match(a.out, /\[warn\] XRWebGLBinding\.createEquirectLayer\(\)/);
  assert.doesNotMatch(a.out, /library code every IWSDK build carries/);
  // the same bundle without app source: still the app's (no IWSDK), so still warnings
  const bare = writeTree(tempDir(), { ...files, 'package.json': '{"dependencies":{"three":"0.181.0"}}' });
  const b = io(bare);
  await runCli(['compat'], b);
  assert.match(b.out, /\[warn\] MediaDevices\.getUserMedia\(\)/);
  // an IWSDK project with the same bundle and no app use: dormant library code
  const iw = writeTree(tempDir(), { ...files, 'package.json': '{"dependencies":{"@iwsdk/core":"1.1.0"}}' });
  const c = io(iw);
  await runCli(['compat', '--verbose'], c);
  assert.match(c.out, /\[info\] MediaDevices\.getUserMedia\(\).*library code every IWSDK build carries/);
});

test('cli: --boot-ms is validated', async () => {
  const proj = writeTree(tempDir(), { 'dist/index.html': '<html></html>' });
  const a = io(proj);
  assert.equal(await runCli(['compat', '--trace', '--boot-ms', 'soon'], a), 2);
  assert.match(a.err, /--boot-ms wants/);
});

test('cli: help lists the compat command', async () => {
  const a = io(tempDir());
  await runCli(['--help'], a);
  assert.match(a.out, /compat {4}Check the built dist\//);
  assert.match(a.out, /--skip-compat/);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('What to do when the check fails'));
  // User docs: no browser fallback, no review/paste/task numbers, no build-machine paths or internal hosts.
  assert.doesNotMatch(readme, /\bTWA\b|Trusted Web Activity|\b[DPT]\d{8,}\b|\/home\/|\/data\/users\/|\.facebook\.(?:net|com)\b/);
});

// ---- the pack gate ------------------------------------------------------

let templateFile = '';
before(async () => {
  templateFile = (await buildTestTemplate(tempDir('iwn-compat-tpl-'))).file;
});

function packProject(files: Record<string, string> = {}): string {
  const dir = tempDir('iwn-compat-pack-');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'gate-test', version: '1.0.0' }));
  writeFileSync(path.join(dir, 'iwsdk.config.json'), JSON.stringify({ version: 'iwsdk.project.v1', native: { packageId: 'com.a.gate', appName: 'Gate' } }));
  buildTestDist(dir, files);
  return dir;
}

function packIo(cwd: string) {
  const o = io(cwd);
  o.env = { IWER_NATIVE_CONFIG_DIR: path.join(cwd, '.cfg') };
  return o;
}

test('pack gate: an injected emulator fails the gate before packing; --json reports it as JSON', async () => {
  const dir = packProject({ 'assets/e.js': 'const c={userAgentException:/x/,activation:"auto"};new Q(Z.metaQuest3).installRuntime({});' });
  const a = packIo(dir);
  assert.equal(await runCli(['pack', '--template', templateFile], a), 1);
  assert.match(a.err, /injected WebXR emulator/);
  assert.match(a.err, /compat check failed \(pass --skip-compat to pack anyway\)/);
  assert.ok(!existsSync(path.join(dir, 'dist-metavr')));
  const b = packIo(dir);
  assert.equal(await runCli(['pack', '--json', '--template', templateFile], b), 1);
  const j = JSON.parse(b.out) as { ok: boolean; error: string; compat: { findings: Array<{ key: string }> } };
  assert.equal(j.ok, false);
  assert.ok(j.compat.findings.some((f) => f.key === 'injected WebXR emulator'));
});

test('pack gate: --strict fails on warnings; --skip-compat packs anyway', async () => {
  const dir = packProject({ 'assets/v.js': 'if (window.VideoDecoder) new VideoDecoder({});' });
  const a = packIo(dir);
  assert.equal(await runCli(['pack', '--strict', '--template', templateFile], a), 1);
  assert.match(a.err, /new VideoDecoder/);
  const b = packIo(dir);
  assert.equal(await runCli(['pack', '--strict', '--skip-compat', '--template', templateFile], b), 0, b.err);
  assert.ok(existsSync(path.join(dir, 'dist-metavr', 'Gate.apk')));
  // without --strict the warning is printed and the pack goes ahead
  const c = packIo(dir);
  assert.equal(await runCli(['pack', '--template', templateFile], c), 0, c.err);
  assert.match(c.err, /\[warn\] new VideoDecoder/);
});

test('pack gate: an app on a newer IWSDK minor than the shipped baseline passes --strict; an older minor warns', async () => {
  const shipped = loadBaseline()?.iwsdk;
  assert.ok(shipped, 'compat/data/static-baseline.json records the IWSDK version it was made from');
  const [major, minor] = shipped.split('.').map(Number) as [number, number];
  const withIwsdk = (version: string) => {
    const dir = packProject();
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'gate-test', version: '1.0.0', dependencies: { '@iwsdk/core': `^${version}` } }));
    writeTree(dir, { 'node_modules/@iwsdk/core/package.json': JSON.stringify({ name: '@iwsdk/core', version }) });
    return dir;
  };
  const newer = withIwsdk(`${major}.${minor + 1}.0`);
  const a = packIo(newer);
  assert.equal(await runCli(['compat', '--strict', '--verbose'], a), 0, a.out);
  assert.match(a.out, /\[info\] static baseline version: .*a newer minor version/);
  const b = packIo(newer);
  assert.equal(await runCli(['pack', '--strict', '--template', templateFile], b), 0, b.err);
  assert.ok(existsSync(path.join(newer, 'dist-metavr', 'Gate.apk')));
  const older = withIwsdk(minor > 0 ? `${major}.${minor - 1}.0` : `${major - 1}.0.0`);
  const c = packIo(older);
  assert.equal(await runCli(['compat', '--strict'], c), 1);
  assert.match(c.out, /\[warn\] static baseline version: .*Update @iwsdk\/core and @iwsdk\/vite-plugin-dev to \d+\.\d+\.\d+ or later/);
  assert.doesNotMatch(c.out, /compat\/scripts|baseline\.mjs/);
  // a warning, not an error: without --strict the check passes
  assert.equal(await runCli(['compat'], packIo(older)), 0);
});

test('pack gate: the app\'s own AR config is checked even though library code mentions AR everywhere', async () => {
  const dir = packProject();
  writeFileSync(path.join(dir, 'iwsdk.config.json'), JSON.stringify({ version: 'iwsdk.project.v1', native: { packageId: 'com.a.gate', appName: 'Gate' }, world: { xr: { mode: 'ar', features: { hitTest: { required: true } } } } }));
  const a = packIo(dir);
  assert.equal(await runCli(['pack', '--template', templateFile], a), 0, a.err);
  // AR mode declares passthrough (pack derives it), so immersive-ar itself is offered (XR-AR-1)
  assert.doesNotMatch(a.err, /\[warn\] XRSystem\.offerSession\("immersive-ar"\)/);
  assert.match(a.err, /\[warn\] XR feature hit-test \(required\)/);
  assert.match(a.err, /There is no fallback route/);
  assert.doesNotMatch(a.err, /Trusted Web Activity|TWA/);
});

test('compat and the pack gate: a dangling link is a message, not a stack trace', async () => {
  const dir = packProject();
  symlinkSync(path.join(dir, 'nowhere.js'), path.join(dir, 'dist', 'dangling.js'));
  const a = io(dir);
  const code = await runCli(['compat'], a);
  assert.equal(code, 0);
  assert.match(a.out, /unreadable file dangling\.js/);
  const b = packIo(dir);
  assert.equal(await runCli(['pack', '--template', templateFile], b), 1);
  assert.doesNotMatch(b.err, /\n\s+at /);
  assert.match(b.err, /dangling\.js/);
});

test('compat: --mirror is validated', async () => {
  const proj = writeTree(tempDir(), { 'dist/index.html': '<html></html>' });
  mkdirSync(path.join(proj, 'm'));
  const a = io(proj);
  assert.equal(await runCli(['compat', '--trace', '--mirror', 'nope'], a), 2);
  assert.match(a.err, /--mirror wants/);
});

test('cli: declaredFeatures resolves the features as pack does (native.features, else derived; AR mode -> passthrough)', () => {
  const dist = { 'dist/index.html': '<html></html>', 'dist/assets/a.js': 'navigator.mediaDevices.getUserMedia({video:true})' };
  const ar = writeTree(tempDir(), { ...dist, 'iwsdk.config.json': JSON.stringify({ world: { xr: { mode: 'ar', features: { hitTest: { required: true } } } } }) });
  const scan = (root: string) => scanDist(path.join(root, 'dist'));
  assert.deepEqual([...declaredFeatures(ar, scan(ar))].sort(), ['camera', 'hitTest', 'passthrough']);
  const explicit = writeTree(tempDir(), { ...dist, 'iwsdk.config.json': JSON.stringify({ world: { xr: { mode: 'ar' } }, native: { packageId: 'com.a.b', features: { handTracking: true, anchors: false } } }) });
  assert.deepEqual([...declaredFeatures(explicit, scan(explicit))], ['handTracking']);
  // what pack resolved wins over the file
  assert.deepEqual([...declaredFeatures(ar, scan(ar), { names: ['passthrough'], derived: false })], ['passthrough']);
});
