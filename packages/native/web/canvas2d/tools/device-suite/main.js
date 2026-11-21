/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// canvas2d device suite (revision 2): golden cases rendered on the device and sent to logcat as PNG chunks (the host
// compares them with the Chrome goldens), measureText rows, bundled-font and fallback checks, texImage2D from a 2D
// canvas into WebGL, the label micro-benchmark (C2D-12) and the IMG-7 canvas memory check. Lines: "C2D <key> <json>".
import { cases, drawChecker, metricCases, METRIC_KEYS } from './cases.mjs';

const log = (k, v) =>
  console.log(`C2D ${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function goldens() {
  const env = {
    canvas: (w, h) => new OffscreenCanvas(w, h),
    checker: () => {
      const c = new OffscreenCanvas(8, 8);
      drawChecker(c.getContext('2d'));
      return c;
    },
    font: 'IwnTest',
  };
  let i = 0;
  for (const c of cases) {
    const canvas = new OffscreenCanvas(c.w, c.h);
    const ctx = canvas.getContext('2d');
    try {
      c.draw(ctx, env);
    } catch (e) {
      log('case-error', { name: c.name, error: String(e) });
    }
    const host = canvas;
    // PNG through the runtime's own encoder (unpremultiplied RGBA8, lossless).
    const blob = await host.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let k = 0; k < bytes.length; k += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
    const b64 = btoa(bin);
    const CH = 3000;
    const n = Math.ceil(b64.length / CH);
    for (let k = 0; k < n; k++)
      console.log(
        `C2DIMG ${c.name} ${k} ${n} ${b64.slice(k * CH, (k + 1) * CH)}`,
      );
    if (++i % 4 === 0) await sleep(20);
  }
  log('goldens-done', { count: i });
  const m = new OffscreenCanvas(1, 1).getContext('2d');
  const rows = metricCases.map((r) => {
    m.font = r.font;
    m.textBaseline = r.baseline;
    m.textAlign = r.align;
    const t = m.measureText(r.text);
    const o = {};
    for (const k of METRIC_KEYS) o[k] = t[k];
    return o;
  });
  for (let k = 0; k < rows.length; k += 10)
    log('metrics', { from: k, rows: rows.slice(k, k + 10) });
  log('metrics-done', { count: rows.length });
}

async function main() {
  const n = globalThis.__iwn && __iwn.canvas2d;
  log('start', {
    natives: !!n,
    webgl: typeof globalThis.__iwnWebGL,
    glNatives: !!(globalThis.__iwn && __iwn.gl),
  });
  // C2D-9: bundled faces (monospace = Roboto Mono only exists in the APK assets, not in /system/fonts).
  log(
    'defaultFaces',
    n
      .defaultFaces()
      .map(([g, f]) => [g, n.faceInfo(f).family, n.faceInfo(f).weight]),
  );
  log('systemFamilies', n.systemFamilies().length);
  const ctx = new OffscreenCanvas(400, 60).getContext('2d');
  ctx.font = '20px "Some Missing Font", sans-serif';
  const missing = ctx.measureText('Ag Showcase 123').width;
  ctx.font = '20px Roboto';
  log('c2d9-missing-family', {
    missing,
    roboto: ctx.measureText('Ag Showcase 123').width,
  });
  ctx.font = '20px monospace';
  log('monospace', {
    w: ctx.measureText('iiiii').width,
    w2: ctx.measureText('MMMMM').width,
  });
  // C2D-10: TTF from the dist through fetch.
  const faces = [
    new FontFace('IwnTest', 'url(/fonts/Roboto-Regular.ttf)', {
      weight: '400',
    }),
    new FontFace('IwnTest', 'url(/fonts/Roboto-Bold.ttf)', { weight: '700' }),
    new FontFace('IwnRegular', 'url(/fonts/Roboto-Regular.ttf)', {
      weight: '400',
    }),
  ];
  const set = globalThis.document ? document.fonts : globalThis.fonts;
  for (const f of faces) set.add(f);
  try {
    await Promise.all(faces.map((f) => f.load()));
    await set.ready;
    log(
      'fontface',
      faces.map((f) => f.status),
    );
  } catch (e) {
    log('fontface-error', String(e));
  }
  // Bidi / emoji through the system fallback chain (visual order checked on the host build; here: draws, measures).
  const b = new OffscreenCanvas(320, 60).getContext('2d');
  b.font = '28px sans-serif';
  b.fillText('Label: مرحبا 42', 4, 40);
  log('bidi', {
    w: b.measureText('Label: مرحبا 42').width,
    zwj: b.measureText('👨‍👩‍👧').width,
    keycap: b.measureText('1️⃣').width,
    emoji: b.measureText('😀').width,
  });
  // texImage2D from a 2D canvas (C2D-2, GL-17).
  try {
    const src = new OffscreenCanvas(4, 2);
    const s2 = src.getContext('2d');
    s2.fillStyle = '#ff0000';
    s2.fillRect(0, 0, 2, 2);
    s2.fillStyle = 'rgba(0, 0, 255, 0.5)';
    s2.fillRect(2, 0, 2, 1);
    const glc = new OffscreenCanvas(4, 2);
    const gl = glc.getContext('webgl2');
    if (!gl) throw new Error('getContext("webgl2") returned null');
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0,
    );
    const px = new Uint8Array(32);
    gl.readPixels(0, 0, 4, 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
    log('teximage2d', {
      error: gl.getError(),
      status:
        gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE,
      row1: [...px.subarray(16, 32)],
      row0: [...px.subarray(0, 16)],
    });
  } catch (e) {
    log('teximage2d-error', String((e && e.stack) || e));
  }
  await goldens();
  // C2D-12: 512x128 label, 20 characters.
  const bc = new OffscreenCanvas(512, 128).getContext('2d');
  const label = (i) => {
    bc.clearRect(0, 0, 512, 128);
    bc.fillStyle = 'rgba(20,24,40,0.85)';
    bc.beginPath();
    bc.roundRect(4, 4, 504, 120, 60);
    bc.fill();
    bc.lineWidth = 4;
    bc.strokeStyle = '#7cf';
    bc.stroke();
    bc.font = 'bold 48px sans-serif';
    bc.fillStyle = '#fff';
    bc.textAlign = 'center';
    bc.textBaseline = 'middle';
    bc.fillText(
      `Showcase label #${String(i % 1000).padStart(4, '0')}`,
      256,
      64,
    );
  };
  for (let i = 0; i < 50; i++) label(i);
  for (let r = 0; r < 3; r++) {
    const N = 200;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) label(i);
    log('bench512x128', { round: r, msPerLabel: (performance.now() - t0) / N });
    await sleep(100);
  }
  // IMG-7: 500 dropped 1024x1024 canvases (4 MB of pixels each), no explicit cleanup.
  log('img7-baseline', {});
  await sleep(4000);
  log('img7-start', {});
  for (let i = 0; i < 500; i++) {
    const c = new OffscreenCanvas(1024, 1024);
    const x = c.getContext('2d');
    x.fillStyle = '#123';
    x.fillRect(0, 0, 1024, 1024);
    if (i % 10 === 9) {
      await sleep(5);
    }
    if (i % 100 === 99) log('img7-progress', { i: i + 1 });
  }
  log('img7-dropped', {});
  for (let k = 0; k < 6; k++) {
    await sleep(1000);
    new ArrayBuffer(8 * 1024 * 1024);
  }
  log('img7-end', {});
  await sleep(4000);
  log('done', 'ok');
}
main().catch((err) => log('error', String((err && err.stack) || err)));
