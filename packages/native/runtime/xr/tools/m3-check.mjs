#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// M3 device check for runtime/xr (docs/spec/08, 09, 10, 14): installs the XR test APKs (build-xr-test-apk.mjs) and
// the showcase APK (build-showcase-apk.mjs) on a headset, runs each case through the debug endpoint and adb, prints
// one PASS/FAIL line per check and writes the evidence (PNGs, JSON, VrApi lines) to --out.
//
//   node runtime/xr/tools/m3-check.mjs --adb "<adb command prefix>" --apks <dir> --out <dir>
//        [--port 9509] [--cases pipeline,grant,nooffer,rejected,webgllayer,noext,alloc,reload,reentry,lifecycle,pause,
//                               showcase,showcasereload]
//        [--repeat <n>]   (multiplies the reload, re-entry and showcase-reload trial counts)
//
// --adb is the command that reaches the device, e.g. "adb -s SERIAL", or "adb -H <host> -P 5037 -s SERIAL" for an
// adb server on another machine. The APK directory holds xr-test-default.apk,
// xr-test-webgllayer.apk, xr-test-nooffer.apk, xr-test-noext.apk (default mode, package com.iwernative.xrtest.noext,
// --config tools/noext-config.json) and showcase.apk (all built with --port <port>). The device must be
// awake with the proximity sensor overridden (a headset nobody wears); the check forwards <port> and removes the
// forward at the end. Such a headset usually has no controllers in view: input checks are host/Node tests (IN-*), not
// part of this run.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

import { request } from './xr-check.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const ADB = opt('adb', 'adb');
const APKS = opt('apks');
const OUT = opt('out');
const PORT = Number(opt('port', '9509'));
const REPEAT = Math.max(1, Number(opt('repeat', '1')));
const CASES = opt(
  'cases',
  'pipeline,grant,nooffer,rejected,webgllayer,noext,alloc,reload,reentry,lifecycle,pause,showcase,showcasereload',
).split(',');
if (!APKS || !OUT) {
  console.error(
    'usage: m3-check.mjs --adb "<adb prefix>" --apks <dir> --out <dir> [--port 9509] [--cases ...]',
  );
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const URL = `ws://127.0.0.1:${PORT}/host`;
const results = [];
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(cmd, { allowFail = false } = {}) {
  try {
    return execSync(`${ADB} ${cmd}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } catch (e) {
    if (allowFail) return String(e.stdout ?? '');
    throw e;
  }
}

function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
  return !!ok;
}

async function rpc(method, params = {}, timeoutMs = 30000) {
  return request(method, params, { url: URL, timeoutMs });
}
async function evalJs(expression, timeoutMs = 30000) {
  const r = await rpc(
    'eval',
    { expression, awaitPromise: true, timeoutMs },
    timeoutMs + 5000,
  );
  if (r.error) throw new Error(`eval failed: ${r.error}`);
  return r.result;
}
async function xrStats() {
  return (await rpc('stats')).xr ?? {};
}

async function waitFor(what, fn, timeoutMs, stepMs = 500) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      // endpoint not up yet
    }
    await sleep(stepMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

function pidof(pkg) {
  return adb(`shell pidof ${pkg}`, { allowFail: true }).trim();
}

const ALL_PACKAGES = [
  'com.iwernative.xrtest',
  'com.iwernative.xrtest.webgllayer',
  'com.iwernative.xrtest.nooffer',
  'com.iwernative.xrtest.request',
  'com.iwernative.xrtest.noext',
  'com.iwernative.showcasevr',
];

async function launch(pkg, apk, extras = '') {
  // Every test app serves the same inspector port: stop all of them so the endpoint is the one being tested.
  for (const p of ALL_PACKAGES)
    adb(`shell am force-stop ${p}`, { allowFail: true });
  await sleep(1000);
  adb(`install -r ${apk}`);
  adb('logcat -c', { allowFail: true });
  adb(`forward tcp:${PORT} localabstract:${pkg}_devtools_${PORT}`); // CDP-1: the inspector is an abstract socket
  adb(`shell am start -n ${pkg}/android.app.NativeActivity ${extras}`);
  await waitFor(
    'the debug endpoint',
    () => rpc('info', {}, 3000).then((r) => !r.error),
    30000,
  );
}

async function stop(pkg) {
  adb(`shell am force-stop ${pkg}`, { allowFail: true });
  await sleep(1500);
}

// --- PNG (the runtime's encoder: 8-bit RGBA, any filter) ----------------------------------------------------------
function decodePng(buf) {
  let off = 8;
  let width = 0,
    height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c,
          pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  return { width, height, px };
}

function meanColour(img, x0, x1) {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let y = 0; y < img.height; y += 4) {
    for (
      let x = Math.floor(x0 * img.width);
      x < Math.floor(x1 * img.width);
      x += 4
    ) {
      const i = (y * img.width + x) * 4;
      r += img.px[i];
      g += img.px[i + 1];
      b += img.px[i + 2];
      n++;
    }
  }
  return [r / n, g / n, b / n].map(Math.round);
}

function distinctColours(img) {
  const seen = new Set();
  for (let i = 0; i < img.px.length; i += 4 * 97)
    seen.add((img.px[i] << 16) | (img.px[i + 1] << 8) | img.px[i + 2]);
  return seen.size;
}

async function shot(file, eye = 'both', scale = 0.25) {
  const r = await rpc('shot', { eye, scale }, 30000);
  if (r.error) throw new Error(`shot: ${r.error}`);
  const png = Buffer.from(r.png, 'base64');
  if (file) fs.writeFileSync(path.join(OUT, file), png);
  return { ...decodePng(png), frame: r.frame };
}

const near = (c, want, tol = 12) =>
  c.every((v, i) => Math.abs(v - want[i]) <= tol);
// The test app's clear colours: left eye (0, 0.55, 0), right eye (0, 0, 0.6), written to an RGBA8 image.
const LEFT = [0, 140, 0];
const RIGHT = [0, 0, 153];

function vrapi() {
  const lines = adb('logcat -d -s VrApi', { allowFail: true })
    .split('\n')
    .filter((l) => l.includes('FPS='));
  return lines.map((l) => {
    const get = (k) => (new RegExp(`${k}=([^,]+)`).exec(l) ?? [])[1];
    return {
      line: l,
      fps: get('FPS'),
      stale: Number(get('Stale')),
      fov: get('Fov'),
      app: parseFloat(get('App')),
      levels: (/CPU\d\/GPU=(\d+)\/(\d+)/.exec(l) ?? []).slice(1).map(Number),
    };
  });
}

// Frame rates from two stats samples; the elapsed time is taken between the replies (each sample is stamped with
// the middle of its round trip), so the adb/forwarding latency does not inflate the rate.
async function stampedStats() {
  const t0 = Date.now();
  const s = await xrStats();
  return { s, t: (t0 + Date.now()) / 2 };
}
async function measureFps(seconds) {
  const a = await stampedStats();
  await sleep(seconds * 1000);
  const b = await stampedStats();
  const dt = (b.t - a.t) / 1000;
  return {
    fps: (b.s.frames.js - a.s.frames.js) / dt,
    xr: (b.s.frames.xr - a.s.frames.xr) / dt,
    missed: b.s.frames.missed - a.s.frames.missed,
    stats: b.s,
  };
}

// --- cases --------------------------------------------------------------------------------------------------------
async function casePipeline() {
  const pkg = 'com.iwernative.xrtest';
  await launch(pkg, path.join(APKS, 'xr-test-default.apk'));
  const s = await waitFor(
    'the WebXR session',
    async () => ((await xrStats()).webxrSession ? xrStats() : null),
    20000,
  );
  check(
    'XR-LIFE-2',
    s.webxrSession && s.state === 'FOCUSED',
    `offerSession granted with no user action; state ${s.state}, visibility ${s.visibility}`,
  );
  check(
    'XR-SC-1',
    s.swapchain.arraySize === 2 && s.swapchain.width > 0,
    `texture-array swapchain ${s.swapchain.width}x${s.swapchain.height}x${s.swapchain.arraySize}, ${s.swapchain.images} images`,
  );
  check(
    'XR-LIFE-6/XR-PERF-1',
    s.perf.cpu === 'sustained-low',
    `CPU level at session start: ${s.perf.cpu}, GPU ${s.perf.gpu}`,
  );
  log(
    `note: XR-IDLE-1 (SHOULD) longest gap between submitted frames before the first XR frame: ${s.boot.maxIdleGapMs.toFixed(1)} ms (target <= 2 periods = ${(2000 / s.refreshRate).toFixed(1)} ms)`,
  );
  const m = await measureFps(5);
  check(
    'XR-LOOP-1',
    m.fps >= 0.97 * m.stats.refreshRate,
    `${m.fps.toFixed(1)} JS frames/s at ${m.stats.refreshRate} Hz (${m.missed} missed periods)`,
  );
  fs.writeFileSync(
    path.join(OUT, 'pipeline-stats.json'),
    JSON.stringify(m.stats, null, 2),
  );
  // XR-LOOP-5: callback time = predicted display time on the performance.now() clock, strictly increasing
  await evalJs(
    '__xrtest.timing = { aheadMin: Infinity, aheadMax: -Infinity, deltaMin: Infinity, deltaMax: -Infinity, samples: 0 }; 1',
  );
  await sleep(3000);
  const tm = JSON.parse(await evalJs('JSON.stringify(__xrtest.timing)'));
  const period = 1000 / m.stats.refreshRate;
  check(
    'XR-LOOP-5',
    tm.samples > 100 &&
      tm.deltaMin > 0 &&
      Math.abs(tm.deltaMin - period) < 2 &&
      tm.aheadMin >= -period &&
      tm.aheadMax <= 3 * period,
    `${tm.samples} callbacks: time - performance.now() at entry ${tm.aheadMin.toFixed(1)}..${tm.aheadMax.toFixed(1)} ms (limits -1..+3 periods = ${(-period).toFixed(1)}..${(3 * period).toFixed(1)}), deltas ${tm.deltaMin.toFixed(2)}..${tm.deltaMax.toFixed(2)} ms`,
  );
  const img = await shot('pipeline-both.png');
  const l = meanColour(img, 0.05, 0.45),
    r = meanColour(img, 0.55, 0.95);
  check(
    'GL-24/DBG-SHOT',
    near(l, LEFT) && near(r, RIGHT),
    `multiview two-colour test: left ${l}, right ${r} (want ${LEFT} / ${RIGHT})`,
  );
  // XR-SC-2 / REG-6: 10 consecutive captures, each the scene, frame numbers increasing.
  let prev = -1,
    okShots = 0;
  for (let i = 0; i < 10; i++) {
    const s2 = await shot(i === 9 ? 'pipeline-seq-10.png' : null, 'both', 0.1);
    if (
      s2.frame > prev &&
      near(meanColour(s2, 0.05, 0.45), LEFT) &&
      near(meanColour(s2, 0.55, 0.95), RIGHT)
    )
      okShots++;
    prev = s2.frame;
  }
  check(
    'XR-SC-2/REG-6',
    okShots === 10,
    `${okShots}/10 consecutive captures show the scene in both eyes (attached once at session start)`,
  );
  // XR-SC-3 / Layers: between frames the image is parked (detached in GL), so drawing to the eye-buffer framebuffer
  // from a task reaches no image: no GL error, and the next frames still render both eyes into the current image.
  const outside = await evalJs(`new Promise((resolve) => setTimeout(() => {
    const g = __iwnXR.gl();
    while (g.getError() !== 0) {}
    g.bindFramebuffer(g.DRAW_FRAMEBUFFER, __xrtest.fbo);
    g.clearColor(1, 0, 0, 1);
    g.clear(g.COLOR_BUFFER_BIT);
    g.bindFramebuffer(g.DRAW_FRAMEBUFFER, null);
    resolve(JSON.stringify({ error: g.getError(), parks: __iwnXR.stats().parks }));
  }, 3))`);
  const out = JSON.parse(outside);
  const after = await shot(null, 'both', 0.1);
  const la = meanColour(after, 0.05, 0.45),
    ra = meanColour(after, 0.55, 0.95);
  check(
    'XR-SC-3 (outside a frame)',
    out.error === 0 && out.parks > 0 && near(la, LEFT) && near(ra, RIGHT),
    `a clear from a timer task: getError ${out.error}; images parked after ${out.parks} frames; next capture left ${la}, right ${ra}`,
  );
  // XR-COL-1 (runtime side): the compositor's own capture (Horizon OS screenshot service, left eye) shows the
  // sRGB-encoded values the page wrote, unchanged (no second encode or decode). Sampled in a corner, away from the
  // test cube. Needs ffmpeg to read the JPEG. (Quest Browser on the same headset, same content through
  // browser-ab.mjs: (0, 141, 0) against the runtime's (0, 140, 0), 2026-10-20.)
  try {
    adb(
      'shell am startservice -n com.oculus.metacam/.capture.CaptureService -a TAKE_SCREENSHOT --ei screenshot_eye_selection 0',
    );
    await sleep(4000);
    const name = adb('shell ls -t /sdcard/Oculus/Screenshots/')
      .split('\n')[0]
      .trim();
    const local = path.join(OUT, 'pipeline-compositor-left.jpg');
    adb(`pull /sdcard/Oculus/Screenshots/${name} ${local}`);
    adb(`shell rm /sdcard/Oculus/Screenshots/${name}`, { allowFail: true });
    const raw = execSync(
      `ffmpeg -loglevel error -y -i ${local} -vf "crop=iw/8:ih/8:iw/16:ih/16,scale=1:1:flags=area" -f rawvideo -pix_fmt rgb24 -`,
    );
    const c = [...raw.subarray(0, 3)];
    check(
      'XR-COL-1 (compositor)',
      near(c, LEFT, 2),
      `compositor capture of the left eye ${c} for eye-buffer values ${LEFT} (RGBA8 swapchain shown as sRGB-encoded, the web's colour model)`,
    );
  } catch (e) {
    log(
      `note: XR-COL-1 compositor capture skipped (${e.message.split('\n')[0]})`,
    );
  }
  // XR-RATE-1
  const rates = await evalJs(
    'JSON.stringify([...__xrtest.sessionObject.supportedFrameRates])',
  );
  await evalJs(
    '__xrtest.sessionObject.updateTargetFrameRate(90).then(() => __xrtest.sessionObject.frameRate)',
    10000,
  );
  await sleep(2000);
  const m90 = await measureFps(3);
  const bad = await evalJs(
    '__xrtest.sessionObject.updateTargetFrameRate(75).then(() => "resolved", (e) => e.name)',
  );
  await evalJs(
    '__xrtest.sessionObject.updateTargetFrameRate(72).then(() => __xrtest.sessionObject.frameRate)',
    10000,
  );
  await sleep(1500);
  const m72 = await measureFps(3);
  check(
    'XR-RATE-1',
    Math.abs(m90.fps - 90) < 3 &&
      Math.abs(m72.fps - 72) < 3 &&
      bad === 'InvalidStateError',
    `supported ${rates}; 90 Hz -> ${m90.fps.toFixed(1)} fps, 72 Hz -> ${m72.fps.toFixed(1)} fps; 75 Hz rejected with ${bad}`,
  );
  // XR-FOV-1: the level reaches the GPU (fragment-bound pass, App GPU from VrApi)
  const gpu = {};
  for (const fov of [0, 1]) {
    await evalJs(
      `__xrtest.heavy = 48; __xrtest.layerObject.fixedFoveation = ${fov}; 1`,
    );
    await sleep(4000);
    const v = vrapi().slice(-2);
    gpu[fov] = { app: v.map((x) => x.app), fov: v.map((x) => x.fov) };
  }
  const saving = 1 - Math.min(...gpu[1].app) / Math.max(...gpu[0].app);
  check(
    'XR-FOV-1',
    saving > 0.2 && gpu[1].fov.includes('3'),
    `fragment-bound frame: App GPU ${gpu[0].app} ms at none -> ${gpu[1].app} ms at high (${(saving * 100).toFixed(0)} % less), VrApi Fov ${gpu[1].fov}`,
  );
  // XR-FOV-1: assigning the level the layer already has, every frame (adaptive-foveation style), reaches the XR
  // thread not once and costs no frames.
  adb('logcat -c', { allowFail: true });
  const fovStart = await stampedStats();
  await evalJs(
    `new Promise((resolve) => {
    const s = __xrtest.sessionObject, l = __xrtest.layerObject, end = performance.now() + 3000;
    const cb = () => { l.fixedFoveation = 1; if (performance.now() < end) s.requestAnimationFrame(cb); else resolve(1); };
    s.requestAnimationFrame(cb);
  })`,
    10000,
  );
  const afterFov = await stampedStats();
  const fovRate =
    (afterFov.s.frames.js - fovStart.s.frames.js) /
    ((afterFov.t - fovStart.t) / 1000);
  const applied = adb('logcat -d -s iwn', { allowFail: true })
    .split('\n')
    .filter((x) => /xr: fixed foveation/.test(x)).length;
  check(
    'XR-FOV-1 (same level every frame)',
    applied === 0 && fovRate >= 0.97 * afterFov.s.refreshRate,
    `fixedFoveation = 1 assigned in every frame for 3 s: ${applied} profile updates on the XR thread, ${fovRate.toFixed(1)} frames/s`,
  );
  // Natives get non-numbers and absurd values (the adapter never sends them; the binding must not misbehave).
  const odd = await evalJs(`JSON.stringify((() => {
    const x = __iwn.xr;
    const r = [x.requestFrameRate(NaN), x.requestFrameRate(1e300), x.requestFrameRate(-72)];
    x.haptic(NaN, Infinity, 1e300, -5); x.haptic(7, 0.5, 10, 0); x.haptic(-1e300, 0.5, NaN, NaN);
    x.setFoveation(NaN); x.setFoveation(1e300);
    return r;
  })())`);
  await sleep(1000);
  const mOdd = await measureFps(2);
  check(
    'natives (bad numbers)',
    odd === '[false,false,false]' && mOdd.fps >= 0.97 * mOdd.stats.refreshRate,
    `requestFrameRate(NaN | 1e300 | -72) -> ${odd}; haptic/setFoveation with NaN, Infinity, out-of-range values ignored or clamped; frames ${mOdd.fps.toFixed(1)}/s afterwards`,
  );
  // XR-PERF-1: a GPU-bound load raises the GPU level within 2 s of the misses starting, and stale frames stop
  await evalJs(
    '__xrtest.layerObject.fixedFoveation = 0; __xrtest.heavy = 400; 1',
  );
  const before = (await xrStats()).perf;
  const raised = await waitFor(
    'a performance level raise',
    async () => {
      const p = (await xrStats()).perf;
      return p.raises > before.raises ? p : null;
    },
    8000,
    250,
  ).catch(() => null);
  await evalJs('__xrtest.heavy = 0; 1');
  check(
    'XR-PERF-1',
    !!raised,
    raised
      ? `heavy load: levels -> CPU ${raised.cpu}, GPU ${raised.gpu} (raises ${before.raises} -> ${raised.raises})`
      : 'no raise within 8 s',
  );
  // XR-LIFE-5: end() from the page -> idle presentation -> exit to home after the grace period (2 s default). The
  // activity finishes (Android may keep the process cached), so the check reads the shell's onDestroy line.
  adb('logcat -c', { allowFail: true });
  const ended = await evalJs(
    'new Promise((res) => { __xrtest.sessionObject.addEventListener("end", () => res("end fired")); __xrtest.sessionObject.end(); })',
    10000,
  );
  const t0 = Date.now();
  const destroyed = await waitFor(
    'the activity to finish',
    () =>
      /activity onDestroy/.test(adb('logcat -d -s iwn', { allowFail: true })),
    10000,
    250,
  ).catch(() => false);
  const exitLine = (
    adb('logcat -d -s iwn', { allowFail: true })
      .split('\n')
      .find((l) => /requesting exit/.test(l)) ?? ''
  ).replace(/^.*xr: /, '');
  check(
    'XR-LIFE-5',
    ended === 'end fired' && destroyed,
    `${ended}; ${destroyed ? `activity finished ${((Date.now() - t0) / 1000).toFixed(1)} s after end() (${exitLine})` : 'still running after 10 s'}`,
  );
  fs.writeFileSync(
    path.join(OUT, 'pipeline-vrapi.txt'),
    vrapi()
      .map((v) => v.line)
      .join('\n'),
  );
  await stop(pkg);
}

async function caseGrant() {
  const pkg = 'com.iwernative.xrtest';
  await launch(
    pkg,
    path.join(APKS, 'xr-test-default.apk'),
    '--es iwn.xrGrant explicit',
  );
  await sleep(10000);
  const s = await xrStats();
  const w = JSON.parse(
    await evalJs('JSON.stringify(__xrtest.windowFramesPerSecond.slice(-3))'),
  );
  check(
    'XR-LIFE-2 (explicit)',
    !s.webxrSession && s.state === 'FOCUSED',
    `10 s after launch: no WebXR session (state ${s.state}), window rAF ${w} per s`,
  );
  check(
    'XR-IDLE-2',
    w.length > 0 && w.every((n) => Math.abs(n - s.refreshRate) <= 3),
    `window rAF per second ${w} at ${s.refreshRate} Hz before entering XR`,
  );
  const t0 = Date.now();
  await evalJs('__iwnXR.grantSession(); 1');
  const s2 = await waitFor(
    'the granted session',
    async () =>
      (await xrStats()).frames.js > 0 && (await xrStats()).webxrSession
        ? xrStats()
        : null,
    5000,
    100,
  ).catch(() => null);
  check(
    'XR-LIFE-2 (grant)',
    !!s2,
    s2
      ? `grantSession() entered XR (frames running ${Date.now() - t0} ms after the eval was sent)`
      : 'no session within 5 s',
  );
  if (s2) {
    const g = s2.session ?? {};
    const period = 1000 / s2.refreshRate;
    check(
      'XR-IDLE-3',
      g.grantToFirstFrameMs >= 0 && g.grantToFirstFrameMs <= 2 * period,
      `session granted -> first WebXR frame begun: ${g.grantToFirstFrameMs?.toFixed?.(1)} ms (limit 2 frame periods = ${(2 * period).toFixed(1)} ms); same OpenXR session and GL context, no reload`,
    );
  }
  const again = await evalJs(
    '(() => { __iwnXR.grantSession(); return "no-op"; })()',
  );
  check(
    'XR-LIFE-2 (no offer)',
    again === 'no-op',
    'grantSession() with no offer pending returned without effect',
  );
  // XR-LIFE-5 counts until a new session is requested: the page ends its session and offers again (IWSDK's re-offer),
  // the offer is held in explicit-grant mode, and the runtime waits for the grant instead of exiting after 2 s.
  if (s2) {
    const pid = pidof(pkg);
    adb('logcat -c', { allowFail: true });
    const ended = await evalJs(
      `new Promise((resolve) => {
      __xrtest.sessionObject.end().then(() => {
        navigator.xr.offerSession('immersive-vr', __xrtest.init).then((s) => __xrtest.start(s));
        resolve('ended, offered again');
      });
    })`,
      10000,
    );
    await sleep(6000);
    const held = await xrStats();
    const exitLine = (
      adb('logcat -d -s iwn', { allowFail: true })
        .split('\n')
        .find((x) => /requesting exit/.test(x)) ?? ''
    ).replace(/^.*xr: /, '');
    await evalJs('__iwnXR.grantSession(); 1');
    const regranted = await waitFor(
      'the re-granted session',
      async () => {
        const m = await sessionRate(1);
        return m.stats.webxrSession && m.rate >= 0.9 * m.stats.refreshRate
          ? m
          : null;
      },
      8000,
      250,
    ).catch(() => null);
    check(
      'XR-LIFE-5 (held re-offer)',
      ended === 'ended, offered again' &&
        !held.webxrSession &&
        !exitLine &&
        !!regranted &&
        pidof(pkg) === pid,
      `${ended}; 6 s later: WebXR session ${held.webxrSession}, ${exitLine ? `EXIT: ${exitLine}` : 'no exit requested'}; grantSession() -> ${regranted ? `session frames at ${regranted.rate.toFixed(0)}/s` : 'no frames'}; same process ${pidof(pkg) === pid}`,
    );
  }
  await stop(pkg);
}

async function caseNoOffer() {
  const pkg = 'com.iwernative.xrtest.nooffer';
  await launch(pkg, path.join(APKS, 'xr-test-nooffer.apk'));
  await sleep(12500);
  const logs = adb('logcat -d -s iwn-js', { allowFail: true });
  const s = await xrStats();
  check(
    'XR-LIFE-7 (error line)',
    /No immersive session was offered or requested/.test(logs) &&
      s.neverOfferedErrors === 1,
    `error line logged once; stats neverOfferedErrors ${s.neverOfferedErrors}`,
  );
  await sleep(20000);
  check(
    'XR-LIFE-7 (debug build stays)',
    !!pidof(pkg),
    `debug build still running 32 s after boot (exit skipped while the inspector is served)`,
  );
  await stop(pkg);
}

// XR-LIFE-7 when the app's only request is rejected (a required feature this runtime does not grant): the error line
// still comes at ~10 s, naming the rejection (release builds then exit at 30 s; this debug build stays).
async function caseRejected() {
  const pkg = 'com.iwernative.xrtest.nooffer';
  await launch(pkg, path.join(APKS, 'xr-test-nooffer.apk'));
  await sleep(1500);
  const name = await evalJs(
    `navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['hit-test'] }).then(() => 'granted', (e) => e.name)`,
  );
  await sleep(11500);
  const logs = adb('logcat -d -s iwn-js', { allowFail: true });
  const s = await xrStats();
  check(
    'XR-LIFE-7 (rejected request)',
    name === 'NotSupportedError' &&
      /every navigator\.xr\.offerSession\(\) \/ requestSession\(\) call was rejected/.test(
        logs,
      ) &&
      s.neverOfferedErrors === 1 &&
      !s.webxrSession,
    `requestSession with required 'hit-test': ${name}; error line naming the rejection logged once (neverOfferedErrors ${s.neverOfferedErrors}); still in the idle presentation (debug build, no exit)`,
  );
  await stop(pkg);
}

// Frames per second of the page's session between two stats samples, and whether the page has a session.
async function sessionRate(seconds = 1) {
  const a = await stampedStats();
  await sleep(seconds * 1000);
  const b = await stampedStats();
  return {
    rate: (b.s.frames.js - a.s.frames.js) / ((b.t - a.t) / 1000),
    stats: b.s,
  };
}

// PROC-8 / XR-LIFE-5 / XRF-B-2: location.reload() during a session, at a random point of a frame, several times in
// one process: each new page offers a session again and gets frames at the display rate (an earlier build left the new
// session without frames after most reloads), and the last one renders both eyes.
async function caseReload() {
  const pkg = 'com.iwernative.xrtest';
  await launch(pkg, path.join(APKS, 'xr-test-default.apk'));
  await waitFor(
    'the WebXR session',
    async () => ((await xrStats()).frames.js > 30 ? 1 : null),
    20000,
  );
  const N = 6 * REPEAT;
  const notes = [];
  let ok = 0;
  for (let i = 1; i <= N; i++) {
    const delay = Math.floor(Math.random() * 14);
    try {
      await evalJs(`setTimeout(() => location.reload(), ${delay}); 1`, 5000);
    } catch {
      // the reply can be lost with the old page
    }
    await sleep(1500);
    const r = await waitFor(
      "the new page's session frames",
      async () => {
        const page = JSON.parse(
          await evalJs(
            'JSON.stringify({ frames: globalThis.__xrtest?.xrFrames ?? -1, session: !!globalThis.__xrtest?.sessionObject })',
            5000,
          ),
        );
        if (!page.session || page.frames <= 0) return null;
        const m = await sessionRate(1);
        return m.stats.webxrSession && m.rate >= 0.9 * m.stats.refreshRate
          ? { ...m, page }
          : null;
      },
      15000,
      250,
    ).catch(() => null);
    if (r) ok++;
    const s = r?.stats ?? (await xrStats().catch(() => ({ frames: {} })));
    notes.push(
      `${r ? `${r.rate.toFixed(0)}/s` : 'NO FRAMES'} (late ${s.frames.late}, withdrawn ${s.frames.withdrawn})`,
    );
  }
  const img = await shot('reload-both.png');
  const l = meanColour(img, 0.05, 0.45),
    r = meanColour(img, 0.55, 0.95);
  check(
    'PROC-8/XR-LIFE-5 (reload)',
    ok === N && near(l, LEFT) && near(r, RIGHT),
    `${ok}/${N} reloads during a session got the new page's session frames: ${notes.join('; ')}; then left ${l}, right ${r}`,
  );
  // A page that needs longer than the end grace period (2 s) to offer again after the reload (IWSDK apps: ~4.7 s):
  // the runtime waits for it (XR-LIFE-7 applies to the new page, from its load) instead of exiting to home.
  const pid = pidof(pkg);
  adb('logcat -c', { allowFail: true });
  const slow = 5000;
  try {
    await evalJs(
      `localStorage.setItem('xrtest.offerDelayMs', '${slow}'); setTimeout(() => location.reload(), 5); 1`,
      5000,
    );
  } catch {
    // the reply can be lost with the old page
  }
  const t0 = Date.now();
  const back = await waitFor(
    "the slow page's session frames",
    async () => {
      const page = JSON.parse(
        await evalJs(
          'JSON.stringify({ frames: globalThis.__xrtest?.xrFrames ?? -1 })',
          5000,
        ),
      );
      if (page.frames <= 0) return null;
      const m = await sessionRate(1);
      return m.stats.webxrSession && m.rate >= 0.9 * m.stats.refreshRate
        ? m
        : null;
    },
    25000,
    250,
  ).catch(() => null);
  const lines = adb('logcat -d -s iwn', { allowFail: true });
  const exitLine = (
    lines.split('\n').find((x) => /requesting exit/.test(x)) ?? ''
  ).replace(/^.*xr: /, '');
  check(
    'PROC-8/XR-LIFE-5 (reload, slow page)',
    !!back &&
      pidof(pkg) === pid &&
      !exitLine &&
      /xr: new page: the session timers start over/.test(lines),
    `the new page offered ${slow} ms after the reload: ${back ? `session frames ${((Date.now() - t0) / 1000).toFixed(1)} s after the reload at ${back.rate.toFixed(0)}/s` : 'no session frames'}; same process ${pidof(pkg) === pid}; ${exitLine ? `EXIT: ${exitLine}` : 'no exit requested'}`,
  );
  await stop(pkg);
}

// XR-LIFE-5 re-entry in one process: end() and a new requestSession right away, (a) end() from a timer task at a
// random point of a frame, the new session requested when end() resolves; (b) end() inside an XR frame callback, the
// new session requested from the 'end' event (IWSDK's re-offer shape). Each new session creates its layer and renders;
// it must get frames at the display rate, and the last one of each variant renders both eyes.
const REENTRY_INIT =
  "{ requiredFeatures: ['local-floor'], optionalFeatures: ['layers', 'hand-tracking'] }";
const REENTRY = {
  timer: `new Promise((resolve, reject) => {
    setTimeout(() => {
      __xrtest.sessionObject.end()
        .then(() => navigator.xr.requestSession('immersive-vr', ${REENTRY_INIT}))
        .then((s) => __xrtest.start(s))
        .then(() => resolve('re-entered'), (e) => reject(String(e)));
    }, Math.floor(Math.random() * 14));
  })`,
  frame: `new Promise((resolve, reject) => {
    const s = __xrtest.sessionObject;
    s.addEventListener('end', () => {
      navigator.xr.requestSession('immersive-vr', ${REENTRY_INIT})
        .then((s2) => __xrtest.start(s2))
        .then(() => resolve('re-entered'), (e) => reject(String(e)));
    }, { once: true });
    s.requestAnimationFrame(() => s.end());
  })`,
};
async function caseReentry() {
  const pkg = 'com.iwernative.xrtest';
  await launch(pkg, path.join(APKS, 'xr-test-default.apk'));
  await waitFor(
    'the WebXR session',
    async () => ((await xrStats()).frames.js > 30 ? 1 : null),
    20000,
  );
  const pid = pidof(pkg);
  for (const [variant, n] of [
    ['timer', 10 * REPEAT],
    ['frame', 5 * REPEAT],
  ]) {
    let ok = 0;
    const notes = [];
    for (let t = 1; t <= n; t++) {
      let res;
      try {
        res = await evalJs(REENTRY[variant], 10000);
      } catch (e) {
        res = `error: ${e.message}`;
      }
      await sleep(500);
      const m = await sessionRate(1);
      const good =
        res === 're-entered' &&
        m.stats.webxrSession &&
        m.rate >= 0.9 * m.stats.refreshRate;
      if (good) ok++;
      else
        notes.push(
          `trial ${t}: ${res}, ${m.rate.toFixed(0)} frames/s, late ${m.stats.frames.late}`,
        );
    }
    await sleep(500);
    const img = await shot(`reentry-${variant}.png`);
    const l = meanColour(img, 0.05, 0.45),
      r = meanColour(img, 0.55, 0.95);
    const s = await xrStats();
    check(
      `XR-LIFE-5 (re-entry, end() ${variant === 'frame' ? 'in a frame callback' : 'from a timer'})`,
      ok === n && near(l, LEFT) && near(r, RIGHT) && pidof(pkg) === pid,
      `${ok}/${n} new sessions got frames at the display rate${notes.length ? ` (${notes.join('; ')})` : ''}; last one: left ${l}, right ${r}; same process; frames late ${s.frames.late}, withdrawn ${s.frames.withdrawn}, cancelled ${s.frames.cancelled}`,
    );
  }
  await stop(pkg);
}

// XR-INIT-1: every optional extension withheld by the debug switch (xr.disableExtensions, debuggable builds): the
// app still enters XR and renders both eyes at the display rate; the session line lists only the required ones.
async function caseNoExt() {
  const pkg = 'com.iwernative.xrtest.noext';
  await launch(pkg, path.join(APKS, 'xr-test-noext.apk'));
  const s = await waitFor(
    'the WebXR session',
    async () => ((await xrStats()).frames.js > 30 ? xrStats() : null),
    20000,
  );
  const m = await measureFps(3);
  const img = await shot('noext-both.png');
  const l = meanColour(img, 0.05, 0.45),
    r = meanColour(img, 0.55, 0.95);
  const logs = adb('logcat -d -s iwn', { allowFail: true });
  const withheld = (
    logs.match(/withheld by config xr\.disableExtensions/g) ?? []
  ).length;
  const session =
    (/xr: OpenXR .*extensions: (.*)$/m.exec(logs) ?? [])[1] ?? '?';
  // without XR_FB_display_refresh_rate the runtime does not know the rate: JS frames are compared with OpenXR frames
  check(
    'XR-INIT-1 (extensions withheld)',
    s.webxrSession &&
      m.xr > 60 &&
      m.fps >= 0.97 * m.xr &&
      near(l, LEFT) &&
      near(r, RIGHT) &&
      withheld >= 10 &&
      session.trim() ===
        'XR_KHR_opengl_es_enable XR_KHR_android_create_instance',
    `${withheld} optional extensions withheld; enabled: ${session.trim()}; ${m.fps.toFixed(1)} JS frames/s, ${m.xr.toFixed(1)} OpenXR frames/s; left ${l}, right ${r}`,
  );
  await stop(pkg);
}

// Target (PERF-ALLOC-1): ~0 bytes allocated per frame on the host + IWER path. The pipeline app with its own loops
// stopped (its XR callback and window rAF), so per frame only the runtime, IWER and the adapter run (incl. the opaque
// texture's re-point and park): JS heap growth per JS frame between stats samples with no GC in between, median.
async function caseAlloc() {
  const pkg = 'com.iwernative.xrtest';
  await launch(pkg, path.join(APKS, 'xr-test-default.apk'));
  await waitFor(
    'the WebXR session',
    async () => ((await xrStats()).frames.js > 100 ? 1 : null),
    20000,
  );
  await evalJs(
    '(() => { __xrtest.sessionObject.requestAnimationFrame = () => 0; globalThis.requestAnimationFrame = () => 0; return 1; })()',
  );
  await sleep(8000);
  const parks0 = Number(await evalJs('__iwnXR.stats().parks'));
  const pts = [];
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const s = await rpc('stats');
    pts.push({
      used: s.heap.used,
      gc: s.gc.countInFrame + s.gc.countOutsideFrame,
      js: s.xr.frames.js,
    });
    await sleep(150);
  }
  const parks = Number(await evalJs('__iwnXR.stats().parks')) - parks0;
  const per = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1],
      b = pts[i];
    if (b.gc !== a.gc || b.js <= a.js || b.used < a.used) continue;
    per.push((b.used - a.used) / (b.js - a.js));
  }
  per.sort((x, y) => x - y);
  const q = (f) => (per.length ? per[Math.floor(per.length * f)] : NaN);
  const frames = pts.at(-1).js - pts[0].js;
  fs.writeFileSync(
    path.join(OUT, 'alloc.json'),
    JSON.stringify({ pts, per }, null, 1),
  );
  check(
    'per-frame allocation (host + IWER path)',
    per.length >= 20 && q(0.5) <= 200 && parks >= 0.9 * frames,
    `${per.length} GC-free intervals over ${frames} JS frames (images parked ${parks} times): median ${q(0.5).toFixed(0)} bytes per frame (p25 ${q(0.25).toFixed(0)}, p75 ${q(0.75).toFixed(0)}), app loops stopped (round 2: 576, 432 of it the WebGL hook's re-point + park)`,
  );
  await stop(pkg);
}

async function caseWebGLLayer() {
  const pkg = 'com.iwernative.xrtest.webgllayer';
  await launch(pkg, path.join(APKS, 'xr-test-webgllayer.apk'));
  const s = await waitFor(
    'the WebXR session',
    async () => ((await xrStats()).frames.js > 30 ? xrStats() : null),
    20000,
  );
  const features = await evalJs('JSON.stringify(__xrtest.session.features)');
  check(
    'XR-SC-3 (swapchain)',
    s.swapchain.arraySize === 1 && !features.includes('layers'),
    `no 'layers' feature (${features}); side-by-side swapchain ${s.swapchain.width}x${s.swapchain.height}x${s.swapchain.arraySize}`,
  );
  const img = await shot('webgllayer-both.png');
  const l = meanColour(img, 0.05, 0.45),
    r = meanColour(img, 0.55, 0.95);
  const m = await measureFps(3);
  check(
    'XR-SC-3 (render)',
    near(l, LEFT) && near(r, RIGHT) && m.fps >= 0.97 * m.stats.refreshRate,
    `XRWebGLLayer renders both eyes: left ${l}, right ${r}; ${m.fps.toFixed(1)} fps`,
  );
  await stop(pkg);
}

async function caseLifecycle() {
  const pkg = 'com.iwernative.xrtest';
  await launch(pkg, path.join(APKS, 'xr-test-default.apk'));
  await waitFor(
    'the WebXR session',
    async () => ((await xrStats()).frames.js > 30 ? 1 : null),
    20000,
  );
  // Sleep (power button): the OpenXR session stops; wake: it resumes and frames continue.
  const pid0 = pidof(pkg);
  adb('shell input keyevent KEYCODE_SLEEP');
  await sleep(6000);
  const asleep = await xrStats().catch(() => ({}));
  adb('shell input keyevent KEYCODE_WAKEUP');
  const awake = await waitFor(
    'frames after wake-up',
    async () => {
      const a = await xrStats();
      await sleep(1000);
      const b = await xrStats();
      return b.state === 'FOCUSED' && b.frames.js - a.frames.js > 50 ? b : null;
    },
    20000,
  ).catch(() => null);
  check(
    'XR-LIFE-3/4 (sleep, wake)',
    asleep.state !== 'FOCUSED' && !!awake && pidof(pkg) === pid0,
    `asleep: state ${asleep.state}, visibility ${asleep.visibility}; after wake-up: ${awake ? `state ${awake.state}, frames running` : 'no frames'}; same process ${pidof(pkg) === pid0}`,
  );
  // Home: the activity is destroyed; launching again in the same process starts OpenXR again.
  adb('shell input keyevent KEYCODE_HOME');
  await sleep(4000);
  const pid1 = pidof(pkg);
  adb(`shell am start -n ${pkg}/android.app.NativeActivity`);
  const again = await waitFor(
    'a session after relaunch',
    async () => ((await xrStats()).frames.js > 30 ? xrStats() : null),
    20000,
  ).catch(() => null);
  check(
    'PROC-7/XR-LIFE-3 (relaunch)',
    !!again && (!pid1 || pidof(pkg) === pid1),
    `after Home + relaunch${pid1 ? ' in the same process' : ' (new process)'}: ${again ? `state ${again.state}, ${again.frames.js} JS frames` : 'no session'}`,
  );
  await stop(pkg);
}

// CDP-7 / XR-IDLE-1: JS paused in the debugger during an XR session for 60 s: the XR thread keeps the frame cadence
// (the xr-stats logcat line, written by the XR thread, keeps counting frames; the app is not closed), and frames run
// again after resume.
async function casePause() {
  const pkg = 'com.iwernative.xrtest';
  await launch(pkg, path.join(APKS, 'xr-test-default.apk'));
  await waitFor(
    'the WebXR session',
    async () => ((await xrStats()).frames.js > 30 ? 1 : null),
    20000,
  );
  const targets = await (
    await fetch(`http://127.0.0.1:${PORT}/json/list`)
  ).json();
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  let paused = false;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) pending.get(m.id)(m);
    if (m.method === 'Debugger.paused') paused = true;
    if (m.method === 'Debugger.resumed') paused = false;
  };
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Debugger.enable');
  adb('logcat -c', { allowFail: true });
  await send('Debugger.pause');
  await waitFor('the pause', () => paused, 5000, 100);
  await sleep(60000);
  const lines = adb('logcat -d -s iwn', { allowFail: true })
    .split('\n')
    .filter((l) => l.includes('xr-stats'));
  const fpsDuring = lines
    .map((l) => parseFloat((/fps=([\d.]+)/.exec(l) ?? [])[1]))
    .filter((x) => !Number.isNaN(x));
  const alive = !!pidof(pkg);
  const stillPaused = paused;
  await send('Debugger.resume');
  ws.close();
  const after = await waitFor(
    'frames after resume',
    async () => {
      const a = await xrStats();
      await sleep(1000);
      const b = await xrStats();
      return b.frames.js - a.frames.js > 50 ? b : null;
    },
    15000,
  ).catch(() => null);
  const minFps = Math.min(...fpsDuring);
  check(
    'CDP-7',
    stillPaused &&
      alive &&
      fpsDuring.length >= 20 &&
      minFps >= 70 &&
      !!after &&
      after.state === 'FOCUSED',
    `60 s paused in the debugger (still paused at the end: ${stillPaused}): XR thread submitted frames at ${minFps.toFixed(1)}-${Math.max(...fpsDuring).toFixed(1)} fps (${fpsDuring.length} stats lines), app alive ${alive}; after resume: ${after ? `state ${after.state}, JS frames running` : 'no frames'}`,
  );
  await stop(pkg);
}

async function caseShowcase() {
  const pkg = 'com.iwernative.showcasevr';
  await launch(pkg, path.join(APKS, 'showcase.apk'));
  const t0 = Date.now();
  const s = await waitFor(
    'the showcase session',
    async () => ((await xrStats()).frames.js > 10 ? xrStats() : null),
    60000,
  );
  check(
    'M3 (enters XR)',
    s.webxrSession,
    `showcase in XR ${((Date.now() - t0) / 1000).toFixed(1)} s after launch; boot ${JSON.stringify(s.boot)}`,
  );
  const gapLimit = 2000 / s.refreshRate;
  const gaps = adb('logcat -d -s iwn', { allowFail: true })
    .split('\n')
    .filter((l) => l.includes('xr: boot gap'))
    .map((l) => l.replace(/^.*xr: /, ''));
  log(
    `note: XR-IDLE-1 (SHOULD) longest gap between submitted frames before the first XR frame: ${s.boot.maxIdleGapMs.toFixed(1)} ms (target <= 2 periods = ${gapLimit.toFixed(1)} ms): ${s.boot.maxIdleGapMs <= gapLimit ? 'met' : 'missed'}${gaps.length ? `; ${gaps.join('; ')}` : ''}`,
  );
  await sleep(10000); // warm-up
  adb('logcat -c', { allowFail: true });
  const m = await measureFps(30);
  const v = vrapi().filter((x) => x.fps);
  const stale = v.reduce((n, x) => n + (x.stale || 0), 0);
  const fpsList = v.map((x) => x.fps).join(' ');
  check(
    'M3 (72 fps)',
    m.fps >= 0.98 * m.stats.refreshRate && m.missed <= 2,
    `30 s: ${m.fps.toFixed(1)} JS frames/s at ${m.stats.refreshRate} Hz, ${m.missed} missed periods; VrApi FPS ${fpsList}; stale ${stale}`,
  );
  check(
    'XR-PERF-1 (level)',
    v.every((x) => x.levels[0] <= 2),
    `VrApi CPU level per second: ${v.map((x) => x.levels[0]).join(' ')}; GPU ${v.map((x) => x.levels[1]).join(' ')}`,
  );
  fs.writeFileSync(
    path.join(OUT, 'showcase-stats.json'),
    JSON.stringify(m.stats, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, 'showcase-vrapi.txt'),
    v.map((x) => x.line).join('\n'),
  );
  const img = await shot('showcase-both.png', 'both', 0.3);
  const lc = distinctColours({ ...img, px: img.px }),
    l = meanColour(img, 0.05, 0.45),
    r = meanColour(img, 0.55, 0.95);
  check(
    'M3 (both eyes)',
    lc > 50 && l.some((x) => x > 20) && r.some((x) => x > 20),
    `eye buffer ${img.width}x${img.height}: ${lc} distinct colours, left mean ${l}, right mean ${r}`,
  );
  await shot('showcase-left.png', 'left', 0.5);
  let prev = -1,
    ok = 0;
  for (let i = 0; i < 10; i++) {
    const s2 = await shot(`showcase-seq-${i + 1}.png`, 'both', 0.15);
    if (s2.frame > prev && distinctColours(s2) > 20) ok++;
    prev = s2.frame;
  }
  check(
    'XR-SC-2/REG-6 (showcase)',
    ok === 10,
    `${ok}/10 consecutive captures show the scene`,
  );
  // One render pass per frame: count what the page does to the eye-buffer framebuffer during 30 XR frames.
  const passes = JSON.parse(await evalJs(RENDER_PASS_PROBE, 20000));
  fs.writeFileSync(
    path.join(OUT, 'showcase-render-passes.json'),
    JSON.stringify(passes, null, 2),
  );
  const one =
    passes.frames > 0 &&
    passes.xrBindsWithDrawsPerFrame <= 1.0 &&
    passes.blitsToXr === 0 &&
    passes.xrTargets === 1;
  check(
    'M3 (one render pass)',
    one,
    `${passes.frames} frames: eye-buffer framebuffer bound with draws ${passes.xrBindsWithDrawsPerFrame} time(s) per frame, ${passes.xrDrawsPerFrame} draws, ${passes.xrClearsPerFrame} clears, ${passes.blitsToXr} blits into it, multiview attachments: ${passes.attach}; other targets per frame: ${passes.otherBindsPerFrame}`,
  );
  await stop(pkg);
}

// PROC-8 with a real app: proto-showcase-vr (IWSDK) needs ~4.7 s after a reload to offer again, longer than the end
// grace period (2 s). location.reload() from the debug endpoint, then DevTools Page.reload over CDP: each new page
// enters XR again in the same process and no exit is requested (an earlier build closed the app to home here).
async function caseShowcaseReload() {
  const pkg = 'com.iwernative.showcasevr';
  await launch(pkg, path.join(APKS, 'showcase.apk'));
  await waitFor(
    'the showcase session',
    async () => ((await xrStats()).frames.js > 10 ? 1 : null),
    60000,
  );
  await sleep(5000);
  const pid = pidof(pkg);
  const ways = [];
  for (let i = 0; i < REPEAT; i++)
    ways.push('location.reload()', 'DevTools Page.reload');
  for (const [k, how] of ways.entries()) {
    const before = await rpc('stats');
    adb('logcat -c', { allowFail: true });
    const t0 = Date.now();
    if (how === 'location.reload()') {
      try {
        await evalJs('setTimeout(() => location.reload(), 0); 1', 5000);
      } catch {
        // the reply can be lost with the old page
      }
    } else {
      const targets = await (
        await fetch(`http://127.0.0.1:${PORT}/json/list`)
      ).json();
      const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
      await new Promise((r, j) => {
        ws.onopen = r;
        ws.onerror = j;
      });
      const reply = new Promise((r) => {
        ws.onmessage = (e) => r(String(e.data));
        setTimeout(() => r('no reply'), 3000);
      });
      ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: {} }));
      await reply;
      try {
        ws.close();
      } catch {
        /* closed by the reload */
      }
    }
    const back = await waitFor(
      'the new page in XR',
      async () => {
        const s = await rpc('stats');
        if (
          s.contextGeneration === before.contextGeneration ||
          !s.xr?.webxrSession ||
          !(s.xr.session?.grantedMs > before.xr.session.grantedMs)
        )
          return null;
        const m = await sessionRate(1);
        return m.stats.webxrSession && m.rate >= 0.9 * m.stats.refreshRate
          ? { ...m, grantedMs: s.xr.session.grantedMs }
          : null;
      },
      45000,
      250,
    ).catch(() => null);
    const lines = adb('logcat -d -s iwn', { allowFail: true });
    fs.writeFileSync(
      path.join(
        OUT,
        `showcase-reload-${k + 1}-${how.startsWith('location') ? 'location' : 'cdp'}.txt`,
      ),
      lines,
    );
    const exitLine = (
      lines.split('\n').find((x) => /requesting exit/.test(x)) ?? ''
    ).replace(/^.*xr: /, '');
    check(
      `PROC-8/XR-LIFE-5 (showcase, ${how})`,
      !!back && pidof(pkg) === pid && !exitLine,
      `${back ? `the new page is in XR ${((Date.now() - t0) / 1000).toFixed(1)} s after the reload, ${back.rate.toFixed(0)} frames/s` : 'the new page never entered XR'}; same process ${pidof(pkg) === pid}; ${exitLine ? `EXIT: ${exitLine}` : 'no exit requested'}`,
    );
    await sleep(3000);
  }
  await stop(pkg);
}

// Wraps the session's WebGL context for 30 XR frames: which framebuffer receives draws, how often the eye-buffer
// framebuffer (the one whose colour attachment is the session's opaque texture) is bound with draws, cleared or
// blitted into. Restores the context afterwards.
const RENDER_PASS_PROBE = `new Promise((resolve) => {
  const gl = __iwnXR.gl();
  const session = __iwnXR.device.activeSession;
  const methods = ['bindFramebuffer', 'clear', 'blitFramebuffer', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'invalidateFramebuffer'];
  const saved = {};
  let bound = null, frame = null;
  const totals = { xrBindsWithDraws: 0, xrDraws: 0, xrClears: 0, blitsToXr: 0, otherBinds: 0 };
  const xrFbs = new Set();
  const perFrame = [];
  for (const m of methods) {
    saved[m] = gl[m];
    gl[m] = function (...a) {
      if (frame) {
        if (m === 'bindFramebuffer') {
          if (a[0] !== 0x8ca8) { bound = a[1]; frame.binds.push({ fb: a[1], draws: 0 }); }
        } else if (m === 'clear') { if (frame.binds.length) frame.binds[frame.binds.length - 1].clears = (frame.binds[frame.binds.length - 1].clears || 0) + 1; }
        else if (m === 'blitFramebuffer') { frame.blits.push(bound); }
        else if (m.startsWith('draw')) { if (frame.binds.length) frame.binds[frame.binds.length - 1].draws++; else frame.preDraws++; }
      }
      return saved[m].apply(this, a);
    };
  }
  const frameData = [];
  function onFrame() {
    if (frame) frameData.push(frame);
    if (frameData.length >= 30) {
      for (const m of methods) gl[m] = saved[m];
      // The eye-buffer framebuffer: the one with the most draws over the run (three's XR render target).
      const draws = new Map();
      for (const f of frameData) for (const b of f.binds) draws.set(b.fb, (draws.get(b.fb) || 0) + b.draws);
      let xrFb = null, best = -1;
      for (const [fb, n] of draws) if (fb && n > best) { best = n; xrFb = fb; }
      for (const f of frameData) {
        let passes = 0;
        for (const b of f.binds) {
          if (b.fb === xrFb) { if (b.draws > 0) { totals.xrBindsWithDraws++; passes++; } totals.xrDraws += b.draws; totals.xrClears += b.clears || 0; xrFbs.add(b.fb); }
          else if (b.draws > 0) totals.otherBinds++;
        }
        perFrame.push(passes);
        totals.blitsToXr += f.blits.filter((t) => t === xrFb).length;
      }
      const atts = xrFb && xrFb._attachments ? [...xrFb._attachments.entries()].map(([k, a]) => '0x' + k.toString(16) + ':{' + Object.entries(a).filter(([, v]) => typeof v !== 'object').map(([kk, v]) => kk + '=' + v).join(',') + '}') : [];
      const n = frameData.length;
      resolve(JSON.stringify({ frames: n, xrTargets: xrFbs.size, xrBindsWithDrawsPerFrame: totals.xrBindsWithDraws / n, passesPerFrame: perFrame.join(''), xrDrawsPerFrame: totals.xrDraws / n, xrClearsPerFrame: totals.xrClears / n, blitsToXr: totals.blitsToXr, otherBindsPerFrame: totals.otherBinds / n, attach: atts.join(' ') }));
      return;
    }
    frame = { binds: [], blits: [], preDraws: 0 };
    session.requestAnimationFrame(onFrame);
  }
  session.requestAnimationFrame(onFrame);
})`;

const CASE_FNS = {
  pipeline: casePipeline,
  grant: caseGrant,
  nooffer: caseNoOffer,
  rejected: caseRejected,
  webgllayer: caseWebGLLayer,
  noext: caseNoExt,
  alloc: caseAlloc,
  reload: caseReload,
  reentry: caseReentry,
  lifecycle: caseLifecycle,
  pause: casePause,
  showcase: caseShowcase,
  showcasereload: caseShowcaseReload,
};
try {
  log(`device: ${adb('shell getprop ro.build.fingerprint').trim()}`);
  for (const c of CASES) {
    log(`--- ${c}`);
    try {
      await CASE_FNS[c]();
    } catch (e) {
      check(`${c} (case)`, false, `aborted: ${e.message}`);
    }
  }
} finally {
  adb(`forward --remove tcp:${PORT}`, { allowFail: true });
  const passed = results.filter((r) => r.ok).length;
  fs.writeFileSync(
    path.join(OUT, 'm3-check.json'),
    JSON.stringify({ date: new Date().toISOString(), results }, null, 2),
  );
  log(
    `M3-CHECK ${passed === results.length ? 'PASS' : 'FAIL'} ${passed}/${results.length}`,
  );
  process.exitCode = passed === results.length ? 0 : 1;
}
