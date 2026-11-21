/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bindsLocally,
  configSignals,
  guardFor,
  maskStrings,
  projectSignals,
  sourceSignals,
  stripComments,
} from '../src/project.ts';
import { tempDir, writeTree } from './helpers.ts';

test('project: iwsdk.config.json world.xr becomes session-mode and feature keys', () => {
  const root = writeTree(tempDir(), {
    'iwsdk.config.json': JSON.stringify({
      world: {
        xr: {
          mode: 'ar',
          offer: 'always',
          features: {
            handTracking: true,
            hitTest: { required: true },
            anchors: false,
            depthSensing: { required: true, usage: 'gpu-optimized' },
          },
        },
      },
    }),
  });
  const keys = configSignals(root).map((s) => s.key);
  assert.deepEqual(keys, [
    'XRSystem.offerSession("immersive-ar")',
    'XR feature hand-tracking (optional)',
    'XR feature hit-test (required)',
    'XR feature depth-sensing (required)',
  ]);
  writeTree(root, {
    'iwsdk.config.json': JSON.stringify({
      world: { xr: { mode: 'vr', offer: 'none' } },
    }),
  });
  assert.deepEqual(
    configSignals(root).map((s) => s.key),
    ['no XR entry (offer: none)', 'XRSystem.requestSession("immersive-vr")'],
  );
  writeTree(root, {
    'iwsdk.config.json': JSON.stringify({ world: { xr: false } }),
  });
  assert.deepEqual(
    configSignals(root).map((s) => s.key),
    ['no XR entry (xr: false)'],
  );
});

test("project: the app's own source, comments stripped, node_modules and dist ignored", () => {
  const root = writeTree(tempDir(), {
    'src/index.ts':
      "import { XRQuadLayer } from '@iwsdk/core';\n// getUserMedia( in a comment\nentity.addComponent(XRQuadLayer, {});\nconst v = document.createElement('video');\nconst u = 'https://x.y/z';",
    'src/film.test.ts': 'new VideoDecoder({})',
    'node_modules/lib/index.js': 'navigator.mediaDevices.getUserMedia({})',
    'dist/a.js': 'new VideoDecoder({})',
  });
  const keys = sourceSignals(root)
    .map((s) => s.key)
    .sort();
  assert.deepEqual(keys, [
    'Document.createElement("video")',
    'XRWebGLBinding.createQuadLayer()',
  ]);
  assert.match(
    sourceSignals(root).find(
      (s) => s.key === 'XRWebGLBinding.createQuadLayer()',
    )!.evidence,
    /^src\/index\.ts:\d+:/,
  );
  assert.equal(
    stripComments("a; // b\nc /* d */ 'http://e'"),
    "a; \nc   'http://e'",
  );
  assert.equal(projectSignals(root).length, 2);
});

test('project: xr false / offer none (XR-LIFE-7) and the camera feature (XR-SEC-1) from iwsdk.config.json', () => {
  const root = writeTree(tempDir(), {
    'iwsdk.config.json': JSON.stringify({
      world: { xr: false, features: { camera: true } },
    }),
  });
  assert.deepEqual(
    configSignals(root).map((s) => s.key),
    ['MediaDevices.getUserMedia()', 'no XR entry (xr: false)'],
  );
  writeTree(root, {
    'iwsdk.config.json': JSON.stringify({
      world: { xr: { mode: 'vr', offer: 'none' }, features: { camera: false } },
    }),
  });
  assert.deepEqual(
    configSignals(root).map((s) => s.key),
    ['no XR entry (offer: none)', 'XRSystem.requestSession("immersive-vr")'],
  );
});

test('project: comment stripping knows strings, templates and regex literals', () => {
  const src = [
    "const icons = import.meta.glob('./icons/*.svg');",
    'const d = new VideoDecoder({});',
    'const re = /a\\/*b/; const t = `x/*${"*/"}y`;',
    "navigator.clipboard.writeText('x');",
    '/* end */ const z = 1; // tail',
  ].join('\n');
  const out = stripComments(src);
  assert.match(out, /new VideoDecoder/);
  assert.match(out, /navigator\.clipboard/);
  assert.doesNotMatch(out, /end|tail/);
  assert.equal(out.split('\n').length, 5);
  const root = writeTree(tempDir(), { 'src/main.ts': src });
  assert.deepEqual(
    sourceSignals(root)
      .map((s) => s.key)
      .sort(),
    ['Navigator.clipboard', 'new VideoDecoder'],
  );
});

test('project: feature strings in UI text are not features; requiredFeatures lists and IWSDK camera components are', () => {
  const root = writeTree(tempDir(), {
    'src/panel.ts': "label.text = `${n === 1 ? 'anchor' : 'anchors'} left`;",
    'src/xr.ts':
      "navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hit-test'] });",
    'src/booth.ts':
      "import { CameraSource } from '@iwsdk/core';\nentity.addComponent(CameraSource, {});",
  });
  const keys = sourceSignals(root)
    .map((s) => s.key)
    .sort();
  assert.ok(!keys.includes('XR feature anchors (optional)'));
  assert.ok(keys.includes('XR feature hit-test (optional)'));
  assert.ok(keys.includes('MediaDevices.getUserMedia()'));
});

test('project: a plain three.js app with a root main.js and an entry script in another directory is scanned', () => {
  const root = writeTree(tempDir(), {
    'index.html':
      '<html><head><script type="module" src="/main.js"></script><script type="module" src="./app/boot.js"></script></head></html>',
    'main.js':
      'const stream = await navigator.mediaDevices.getUserMedia({ video: true });\nconst quad = binding.createQuadLayer({});',
    'app/boot.js': 'new BroadcastChannel("x");',
    'vite.config.js': 'navigator.mediaDevices.getUserMedia()',
    'package.json': '{"dependencies":{"three":"0.181.0"}}',
  });
  const keys = sourceSignals(root).map((s) => s.key);
  for (const k of [
    'MediaDevices.getUserMedia()',
    'XRWebGLBinding.createQuadLayer()',
    'new BroadcastChannel',
  ])
    assert.ok(keys.includes(k), k);
  assert.match(
    sourceSignals(root).find((s) => s.key === 'MediaDevices.getUserMedia()')!
      .evidence,
    /^main\.js:1:/,
  );
});

test('project: IWSDK XR options in code, media playback, AR support checks and feature-detection guards', () => {
  const root = writeTree(tempDir(), {
    'src/index.ts': `import { World, SessionMode } from '@iwsdk/core';
World.create(el, {
  xr: { sessionMode: SessionMode.ImmersiveAR, offer: 'always', features: { hitTest: { required: true }, anchors: true, eyeTracking: true, layers: false } },
  features: { locomotion: true, camera: { facing: 'back' } },
  render: { camera: { position: [0, 1, 2] } },
});`,
    'src/video.ts':
      "const video = document.createElement('video');\nvideo.src = './tour.mp4';\nawait video.play();",
    'src/ar.ts':
      "navigator.xr?.isSessionSupported('immersive-ar').then((ok) => { b.hidden = !ok; });",
    'src/guard.ts':
      "if (typeof VideoDecoder !== 'undefined') { new VideoDecoder({}); }\nif (navigator.gpu) { await navigator.gpu.requestAdapter(); }\nnew SharedWorker('w.js');",
  });
  const sig = sourceSignals(root);
  const by = (k: string) => sig.find((s) => s.key === k);
  assert.ok(
    by('XRSystem.requestSession("immersive-ar")'),
    'SessionMode.ImmersiveAR in code',
  );
  assert.ok(by('XR feature hit-test (required)'));
  assert.ok(by('XR feature anchors (optional)'));
  assert.ok(by('XR feature eye-tracking (optional)'));
  assert.equal(by('XR feature layers (optional)'), undefined);
  assert.match(by('MediaDevices.getUserMedia()')!.evidence, /camera feature/);
  assert.ok(by('HTMLMediaElement.play()'));
  assert.ok(by('HTMLMediaElement.src='));
  assert.ok(by('XRSystem.isSessionSupported("immersive-ar")'));
  assert.match(by('new VideoDecoder')!.guarded ?? '', /typeof VideoDecoder/);
  assert.match(
    by('Navigator.gpu.requestAdapter()')!.guarded ?? '',
    /navigator\.gpu/,
  );
  assert.equal(by('new SharedWorker')!.guarded, undefined);
  // only the support check: no request signal
  const fp = writeTree(tempDir(), {
    'src/ar.ts':
      "navigator.xr?.isSessionSupported('immersive-ar').then((ok) => { b.hidden = !ok; });",
  });
  assert.deepEqual(
    sourceSignals(fp).map((s) => s.key),
    ['XRSystem.isSessionSupported("immersive-ar")'],
  );
  // xr: false / offer 'none' in code
  const nx = writeTree(tempDir(), {
    'src/index.ts':
      "World.create(el, { xr: false });\nlaunchXR(world, { offer: 'none' });",
  });
  const nk = sourceSignals(nx).map((s) => s.key);
  assert.ok(nk.includes('no XR entry (xr: false)'));
  assert.ok(nk.includes('no XR entry (offer: none)'));
  // eyeTracking in iwsdk.config.json is IWSDK's alias for the eye-tracking descriptor
  const cfg = writeTree(tempDir(), {
    'iwsdk.config.json': JSON.stringify({
      world: { xr: { mode: 'vr', features: { eyeTracking: true } } },
    }),
  });
  assert.ok(
    configSignals(cfg).some(
      (s) => s.key === 'XR feature eye-tracking (optional)',
    ),
  );
});

test('project: an <audio> made only for canPlayType is not playback; .play()/.src= on other objects are not either', () => {
  const probe = writeTree(tempDir(), {
    'src/main.js':
      "const a = document.createElement('audio');\nconst ogg = a.canPlayType('audio/ogg');\naction.play();\nmixer.clipAction(clip).play();\nimg.src = './icon.png';",
  });
  const keys = sourceSignals(probe).map((s) => s.key);
  assert.ok(!keys.includes('HTMLMediaElement.play()'), keys.join(', '));
  assert.ok(!keys.includes('HTMLMediaElement.src='), keys.join(', '));
  // the element's holder, a media-named field, and new Audio(url).play() are playback
  for (const src of [
    "const el = document.createElement('video'); el.src = 'a.mp4'; el.play();",
    "this.bgm = new Audio(); this.bgm.src = 'm.ogg'; this.bgm.play();",
    "new Audio('click.wav').play();",
    "document.body.innerHTML = '<video id=v></video>'; const introVideo = document.getElementById('v'); introVideo.src = 'i.mp4'; introVideo.play();",
  ]) {
    const k = sourceSignals(writeTree(tempDir(), { 'src/main.js': src })).map(
      (s) => s.key,
    );
    assert.ok(k.includes('HTMLMediaElement.play()'), src);
    assert.ok(k.includes('HTMLMediaElement.src='), src);
  }
});

test('project: xr: false in one branch of a ternary is a mode, not the app', () => {
  const root = writeTree(tempDir(), {
    'src/index.ts':
      'World.create(el, pureBrowser ? { ...projectOptions, xr: false } : projectOptions);',
  });
  assert.deepEqual(
    sourceSignals(root).map((s) => s.key),
    [],
  );
});

test('project: IWSDK options quoted in UI text are not options', () => {
  const root = writeTree(tempDir(), {
    'src/panel.ts':
      "launchXR(world);\nconst t = { text: 'XR is off (xr: false): launchXR would throw.', hint: `offer: 'none' means ${n}` };",
  });
  assert.deepEqual(
    sourceSignals(root).map((s) => s.key),
    [],
  );
  const opt = writeTree(tempDir(), {
    'src/index.ts': "launchXR(world, { offer: 'none' });",
  });
  assert.deepEqual(
    sourceSignals(opt).map((s) => s.key),
    ['no XR entry (offer: none)'],
  );
});

test('project: three.js Audio (a local binding) is not an <audio> element; ctx.audioWorklet checks are feature checks', () => {
  for (const src of [
    "import { Audio, AudioListener } from 'three';\nconst sound = new Audio(listener);\nsound.setBuffer(buf);\nsound.play();",
    'class Audio { play() {} }\nconst sound = new Audio(listener);\nsound.play();',
  ]) {
    const k = sourceSignals(writeTree(tempDir(), { 'src/main.js': src })).map(
      (s) => s.key,
    );
    for (const no of [
      'HTMLMediaElement.play()',
      'HTMLMediaElement.src=',
      'new Audio',
    ])
      assert.ok(!k.includes(no), `${no} in ${k.join(', ')} for ${src}`);
  }
  // an aliased import leaves the global Audio in place
  const aliased = sourceSignals(
    writeTree(tempDir(), {
      'src/main.js':
        "import { Audio as ThreeAudio } from 'three';\nconst music = new Audio('m.ogg');\nmusic.play();",
    }),
  ).map((s) => s.key);
  assert.ok(
    aliased.includes('HTMLMediaElement.play()') &&
      aliased.includes('new Audio'),
    aliased.join(', '),
  );
  assert.ok(
    bindsLocally('Audio', "import { Audio } from 'three'") &&
      !bindsLocally('Audio', "import { Audio as A } from 'three'"),
  );
  for (const g of [
    'if (actx.audioWorklet) { x(); }',
    "if ('audioWorklet' in actx) {}",
    'actx.audioWorklet?.addModule(u)',
    "typeof actx.audioWorklet === 'undefined'",
    'this.ctx.audioWorklet !== undefined',
  ])
    assert.ok(guardFor('AudioWorklet.addModule()', g), g);
  assert.equal(
    guardFor(
      'AudioWorklet.addModule()',
      "await actx.audioWorklet.addModule('./s.js')",
    ),
    null,
  );
});

test('project: window.X.member() is a use, not a feature check; crypto.subtle checks are recognised', () => {
  // unguarded member uses through window/self (the canonical MDN form) are not guards
  for (const [k, src] of [
    ['indexedDB.open()', "const req = window.indexedDB.open('db', 1);"],
    ['indexedDB.open()', "const req = self.indexedDB.open('db', 1);"],
    ['caches.open()', "window.caches.open('v1').then((c) => c.add('/'));"],
    ['speechSynthesis', 'window.speechSynthesis.speak(u);'],
    ['caches.open()', "window.caches['open']('v1');"],
    ['new WebSocket', "const s = new window.WebSocket('wss://x.example.net');"],
  ] as Array<[string, string]>)
    assert.equal(guardFor(k, src), null, src);
  // value tests and optional chaining still are
  for (const [k, src] of [
    ['new WebSocket', 'if (window.WebSocket) { new WebSocket(u); }'],
    ['indexedDB.open()', "const req = window.indexedDB?.open('db', 1);"],
    ['indexedDB.open()', "if ('indexedDB' in window) {}"],
  ] as Array<[string, string]>)
    assert.ok(guardFor(k, src), src);
  for (const src of [
    "if (crypto.subtle) { crypto.subtle.digest('SHA-256', b); }",
    "if (window.crypto.subtle) { crypto.subtle.digest('SHA-256', b); }",
    "if ('subtle' in crypto) { crypto.subtle.digest('SHA-256', b); }",
    "const h = await crypto?.subtle?.digest('SHA-256', b);",
    "if (typeof crypto.subtle === 'undefined') return;",
  ])
    assert.ok(guardFor('SubtleCrypto.digest()', src), src);
  assert.equal(
    guardFor(
      'SubtleCrypto.digest()',
      "const h = await crypto.subtle.digest('SHA-256', b);",
    ),
    null,
  );
});

test('project: requiredFeatures in app code are required, optionalFeatures optional', () => {
  const root = writeTree(tempDir(), {
    'src/xr.ts':
      "navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test'], optionalFeatures: ['anchors'] });",
  });
  const keys = sourceSignals(root).map((s) => s.key);
  assert.ok(keys.includes('XR feature hit-test (required)'), keys.join(', '));
  assert.ok(!keys.includes('XR feature hit-test (optional)'), keys.join(', '));
  assert.ok(keys.includes('XR feature anchors (optional)'), keys.join(', '));
});

test('project: maskStrings is linear on unterminated templates and keeps template text with quotes masked', () => {
  const t0 = performance.now();
  maskStrings('`' + '${}'.repeat(5000));
  maskStrings("const s = `it's ${a}` + 'x'; " + '`${x}'.repeat(2000));
  assert.ok(performance.now() - t0 < 2000);
  const src =
    "const t = `don't ${xr ? 1 : 2} offer: 'none'`; launchXR(w, { offer: 'none' });";
  const m = maskStrings(src);
  assert.equal(m.length, src.length);
  assert.ok(m.includes('${xr ? 1 : 2}'));
  assert.ok(!m.slice(0, m.indexOf(';')).includes('offer'), m);
  assert.ok(m.slice(m.indexOf(';')).includes("offer: '    '"), m);
});
