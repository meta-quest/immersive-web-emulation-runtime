/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * End to end in headless Chromium: a tiny WebXR app that offers a session,
 * renders with WebGL2, starts module/blob/data workers. Needs a directory whose
 * node_modules has playwright (1.58.2 with its cached Chromium) and iwer:
 *   IWN_COMPAT_PROJECT=<an IWSDK project> npm run test:compat
 * Skipped otherwise.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { evaluateCompat, formatCompatReport } from '../src/check.ts';
import { headsetTrim } from '../src/providers.ts';
import { loadSurface } from '../src/surface.ts';
import { findIwerBuild, loadPlaywright, runTrace } from '../src/trace-run.ts';
import { tempDir, writeTree } from './helpers.ts';

const project = process.env.IWN_COMPAT_PROJECT;

test(
  'headless trace of a small WebXR app',
  { skip: !project ? 'set IWN_COMPAT_PROJECT' : false, timeout: 120_000 },
  async () => {
    const pw = await loadPlaywright(project!);
    const iwer = process.env.IWN_COMPAT_IWER ?? findIwerBuild(project!);
    assert.ok(pw, 'playwright');
    assert.ok(iwer && existsSync(iwer), 'iwer build');
    const dist = writeTree(tempDir(), {
      'index.html':
        '<!doctype html><html><head><title>t</title></head><body><script type="module" src="./main.js"></script></body></html>',
      'main.js': `
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const gl = canvas.getContext('webgl2', { xrCompatible: true });
      const w = new Worker(new URL('./w.js', import.meta.url), { type: 'module' });
      w.postMessage(1);
      const b = new Worker(URL.createObjectURL(new Blob(['postMessage(new TextEncoder().encode("x").length)'], { type: 'text/javascript' })));
      class MyTarget extends EventTarget {}
      new MyTarget().addEventListener('ping', () => {});
      const session = await navigator.xr.offerSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking'] });
      const space = await session.requestReferenceSpace('local-floor');
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
      const frame = (t, f) => {
        const pose = f.getViewerPose(space);
        gl.bindFramebuffer(gl.FRAMEBUFFER, session.renderState.baseLayer.framebuffer);
        gl.clearColor(0.2, 0.3, 0.4, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        if (window.VideoFrame) {}
        session.requestAnimationFrame(frame);
      };
      session.requestAnimationFrame(frame);
    `,
      'w.js':
        "import './side.js';\nself.onmessage = () => postMessage(performance.now());",
      // a statically imported module with no import/export syntax (fetched with the worker destination too)
      'side.js': 'self.sideLoaded = true;',
    });
    const r = await runTrace({
      distDir: dist,
      iwerSource: readFileSync(iwer!, 'utf8'),
      playwright: pw!,
      xrMs: 1500,
      bootTimeoutMs: 20_000,
    });
    assert.equal(r.reachedXR, true);
    assert.equal(r.enteredVia, 'offer');
    assert.ok(r.xrFrames > 0);
    const app = (k: string) => (r.main?.apis[k]?.app ?? 0) > 0;
    assert.ok(app('XRSystem.offerSession("immersive-vr")'));
    assert.ok(app('XR feature hand-tracking (optional)'));
    assert.ok(app('XRSession.requestReferenceSpace("local-floor")'));
    assert.ok(app('XRFrame.getViewerPose()'));
    assert.ok(app('WebGL2RenderingContext.clear()'));
    assert.ok(app('HTMLCanvasElement.getContext("webgl2")'));
    assert.ok(app('new Worker(module, same-origin)'));
    assert.ok(app('new Worker(classic, blob:)'));
    assert.ok(app('VideoFrame'));
    assert.ok(app('on:EventTarget.ping'));
    assert.ok(
      !r.workers.some(
        (w) => (w.apis['WorkerGlobalScope.importScripts()']?.app ?? 0) > 0,
      ),
    );
    // IWER's own calls are not the app's
    assert.equal(r.main?.apis['XRSystem.requestSession()']?.app ?? 0, 0);
    assert.equal(r.workers.length, 2);
    assert.ok(
      r.workers.some((w) => (w.apis['Performance.now()']?.app ?? 0) > 0),
    );
    assert.ok(r.workers.some((w) => (w.apis['new TextEncoder']?.app ?? 0) > 0));
    assert.deepEqual(r.pageErrors, []);
  },
);

test(
  'headless trace: allowlisted origins pass, others are blocked; nested and short-lived workers report',
  { skip: !project ? 'set IWN_COMPAT_PROJECT' : false, timeout: 120_000 },
  async () => {
    const pw = await loadPlaywright(project!);
    const iwer = process.env.IWN_COMPAT_IWER ?? findIwerBuild(project!);
    // two "CDNs" on other ports: one allowlisted, one not
    const cdn = http.createServer((_req, res) =>
      res
        .writeHead(200, {
          'access-control-allow-origin': '*',
          'content-type': 'application/json',
        })
        .end('{"ok":true}'),
    );
    await new Promise<void>((r) => cdn.listen(0, '127.0.0.1', r));
    const other = http.createServer((_req, res) =>
      res.writeHead(200, { 'access-control-allow-origin': '*' }).end('x'),
    );
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const cdnOrigin = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;
    const otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      const dist = writeTree(tempDir(), {
        'index.html':
          '<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>',
        'main.js': `
        const ok = await (await fetch('${cdnOrigin}/npm/x/config.json')).json();
        try { await fetch('${otherOrigin}/y.glb'); } catch {}
        new Worker(new URL('./outer.js', import.meta.url));
        new Worker(new URL('./quick.js', import.meta.url));
        if (ok.ok) await navigator.xr.offerSession('immersive-vr', {});
      `,
        'outer.js':
          'new Worker(URL.createObjectURL(new Blob(["self.inner = new TextDecoder()"], { type: "text/javascript" })));',
        'quick.js':
          '"use strict"; postMessage(new TextEncoder().encode("q").length); self.close();',
      });
      const r = await runTrace({
        distDir: dist,
        iwerSource: readFileSync(iwer!, 'utf8'),
        playwright: pw!,
        xrMs: 800,
        bootTimeoutMs: 15_000,
        allow: [cdnOrigin],
      });
      assert.equal(r.reachedXR, true, JSON.stringify(r.pageErrors));
      assert.ok(r.allowedRequests?.some((x) => x.startsWith(cdnOrigin)));
      assert.ok(r.blockedRequests.some((x) => x.startsWith(otherOrigin)));
      assert.ok(!r.blockedRequests.some((x) => x.startsWith(cdnOrigin)));
      const any = (k: string) =>
        r.workers.some((w) => (w.apis[k]?.app ?? 0) > 0);
      assert.ok(
        any('new TextEncoder'),
        'the worker that closes itself reported',
      );
      assert.ok(any('new TextDecoder'), 'the nested blob worker reported');
    } finally {
      cdn.close();
      other.close();
    }
  },
);

test(
  'headless trace: a main thread that never yields ends the run with hung set',
  { skip: !project ? 'set IWN_COMPAT_PROJECT' : false, timeout: 120_000 },
  async () => {
    const pw = await loadPlaywright(project!);
    const iwer = process.env.IWN_COMPAT_IWER ?? findIwerBuild(project!);
    const dist = writeTree(tempDir(), {
      'index.html':
        '<!doctype html><html><head></head><body><script>setTimeout(() => { for (;;) {} }, 1500);</script></body></html>',
    });
    const t0 = Date.now();
    const r = await runTrace({
      distDir: dist,
      iwerSource: readFileSync(iwer!, 'utf8'),
      playwright: pw!,
      bootTimeoutMs: 20_000,
      evalTimeoutMs: 3_000,
    });
    assert.ok(Date.now() - t0 < 30_000);
    assert.match(r.hung ?? '', /did not answer/);
  },
);

test(
  'headless trace with the headset trim: feature detection takes the headset path; AR is not offered; WebSocket is absent',
  { skip: !project ? 'set IWN_COMPAT_PROJECT' : false, timeout: 120_000 },
  async () => {
    const pw = await loadPlaywright(project!);
    const iwer = process.env.IWN_COMPAT_IWER ?? findIwerBuild(project!);
    const { surface } = await loadSurface();
    const dist = writeTree(tempDir(), {
      'index.html':
        '<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>',
      'main.js': `
      window.seen = [];
      if (typeof VideoDecoder !== 'undefined') { new VideoDecoder({ output() {}, error() {} }); seen.push('webcodecs'); }
      if (navigator.gpu) { await navigator.gpu.requestAdapter(); seen.push('webgpu'); }
      if ('mediaDevices' in navigator) seen.push('media');
      const c = document.createElement('canvas');
      if (c.getContext('webgpu')) seen.push('webgpu-ctx');
      const gl = c.getContext('webgl2', { xrCompatible: true });
      const ar = await navigator.xr.isSessionSupported('immersive-ar');
      if (typeof WebSocket !== 'undefined') { const ws = new WebSocket('wss://game.example-mp.net/room'); ws.onerror = () => {}; seen.push('ws'); }
      window.ua = navigator.userAgent;
      const s = await navigator.xr.offerSession(ar ? 'immersive-ar' : 'immersive-vr', {});
      const sp = await s.requestReferenceSpace('local');
      s.updateRenderState({ baseLayer: new XRWebGLLayer(s, gl) });
      const f = (t, fr) => { fr.getViewerPose(sp); s.requestAnimationFrame(f); }; s.requestAnimationFrame(f);
    `,
    });
    const r = await runTrace({
      distDir: dist,
      iwerSource: readFileSync(iwer!, 'utf8'),
      playwright: pw!,
      xrMs: 800,
      bootTimeoutMs: 20_000,
      trim: headsetTrim(surface),
    });
    assert.equal(r.reachedXR, true, JSON.stringify(r.pageErrors));
    assert.deepEqual(r.pageErrors, []);
    const app = (k: string) => (r.main?.apis[k]?.app ?? 0) > 0;
    assert.ok(
      app('XRSystem.offerSession("immersive-vr")'),
      'the VR path ran (no AR on the headset)',
    );
    assert.ok(!app('XRSystem.offerSession("immersive-ar")'));
    assert.ok(!app('new VideoDecoder'));
    assert.ok(
      !app('Navigator.gpu.requestAdapter()') && !app('GPU.requestAdapter()'),
    );
    assert.ok(
      app('miss:Navigator.gpu'),
      'the probe of navigator.gpu is recorded',
    );
    assert.ok(app('HTMLCanvasElement.getContext("webgpu") -> null'));
    assert.ok(
      r.removed?.includes('VideoDecoder') &&
        r.removed.includes('Navigator.gpu') &&
        r.removed.includes('Navigator.mediaDevices'),
    );
    // WebSocket is out of the alpha (absent by default): the trim removes it, so the guarded app never opens a socket
    assert.ok(r.removed?.includes('WebSocket'), JSON.stringify(r.removed));
    assert.ok(
      !Object.keys(r.main?.apis ?? {}).some(
        (k) => k.startsWith('new WebSocket') && app(k),
      ),
    );
    assert.ok(
      !r.blockedRequests.some((b) => b.startsWith('wss://game.example-mp.net')),
      JSON.stringify(r.blockedRequests),
    );
    for (const k of ['Crypto.getRandomValues()', 'URL.parse()', 'Node.baseURI'])
      assert.ok(!app(k), k);
    // IWER's navigator.userAgent (an own data property installed after the tracer) is still traced
    assert.ok(app('Navigator.userAgent'));
    // the checker: nothing fails, the guarded uses are not warnings
    const report = evaluateCompat({ trace: r, surface });
    assert.equal(report.errors, 0, formatCompatReport(report));
  },
);

test(
  'headless trace: a script that never yields before the load event ends the run with hung set',
  { skip: !project ? 'set IWN_COMPAT_PROJECT' : false, timeout: 120_000 },
  async () => {
    const pw = await loadPlaywright(project!);
    const iwer = process.env.IWN_COMPAT_IWER ?? findIwerBuild(project!);
    const dist = writeTree(tempDir(), {
      'index.html':
        '<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>',
      'main.js': 'for (;;) {}',
    });
    const t0 = Date.now();
    const r = await runTrace({
      distDir: dist,
      iwerSource: readFileSync(iwer!, 'utf8'),
      playwright: pw!,
      bootTimeoutMs: 20_000,
      evalTimeoutMs: 3_000,
    });
    assert.ok(Date.now() - t0 < 30_000);
    assert.match(r.hung ?? '', /did not finish loading/);
  },
);
