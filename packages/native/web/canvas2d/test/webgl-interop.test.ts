/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Canvas 2D <-> WebGL (C2D-1, C2D-2, GL-17): texImage2D from a 2D canvas through web/webgl's own source reader,
// WebGL contexts on OffscreenCanvas and on a DOM HTMLCanvasElement, and (with the host GL addon, Mesa) the whole
// upload path three.js's CanvasTexture takes: draw 2D -> texImage2D(canvas) -> read the texture back.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installCanvas2D } from '../src/install.ts';
import { loadNatives, makeGlobal } from './helpers.ts';

// web/webgl is another stream's module (and TypeScript project): loaded at run time, untyped here.
const webgl = (file: string) => import(pathToFileURL(resolve(import.meta.dirname, '../../webgl', file)).href);
const { getSourcePixels } = await webgl('tex-source.ts');
const { realNatives } = await webgl('test/real-gl.ts');
const { installWebGL } = await webgl('install.ts');

const natives = loadNatives();
const skip = natives ? false : 'canvas2d addon not built (see README)';

describe('canvas -> WebGL interop', { skip }, () => {
  const g = natives ? makeGlobal(natives) : (null as never);

  it('web/webgl reads a 2D canvas as RGBA, top row first, with the alpha mode it reports (texImage2D source)', () => {
    const c = new g.OffscreenCanvas(2, 2);
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
    ctx.fillRect(0, 0, 2, 1);
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 1, 2, 1);
    const px = getSourcePixels(c, null, 'texImage2D');
    assert.equal(px.width, 2);
    assert.equal(px.height, 2);
    // web/webgl takes the image-source protocol (premultiplied, INTEROP.md §2) when present, else tex-source (straight).
    assert.deepEqual([...px.data.subarray(0, 4)], px.premultiplied ? [128, 0, 0, 128] : [255, 0, 0, 128]);
    assert.deepEqual([...px.data.subarray(8, 12)], [0, 255, 0, 255]);
    // The tex-source protocol on its own (what web/webgl used before it read image sources): straight alpha.
    const ts = (c as unknown as Record<symbol, () => { data: Uint8Array; premultiplied: boolean }>)[Symbol.for('iwn.texImageSource')]!();
    assert.equal(ts.premultiplied, false);
    assert.deepEqual([...ts.data.subarray(0, 4)], [255, 0, 0, 128]);
    // A canvas without a context uploads transparent black of its size.
    const empty = getSourcePixels(new g.OffscreenCanvas(3, 1), null, 'texImage2D');
    assert.equal(empty.width, 3);
    assert.ok(empty.data.subarray(0, 12).every((v: number) => v === 0));
  });

  it('getContext("webgl2") on OffscreenCanvas uses the WebGL prelude; the 2D tex-source protocol steps aside', () => {
    const calls: unknown[][] = [];
    const glCtx = { kind: 'fake-webgl2' };
    const prev = (globalThis as Record<string, unknown>).__iwnWebGL;
    (globalThis as Record<string, unknown>).__iwnWebGL = {
      createContext(canvas: object, type: string, attrs: unknown) {
        calls.push([canvas, type, attrs]);
        Object.defineProperty(canvas, '__iwnWebGLContext', { value: glCtx, configurable: true });
        return glCtx;
      },
    };
    try {
      const c = new g.OffscreenCanvas(4, 4);
      const attrs = { antialias: false };
      assert.equal(c.getContext('webgl2', attrs), glCtx);
      assert.equal(c.getContext('webgl2'), glCtx);
      assert.equal(c.getContext('2d'), null);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.slice(1), ['webgl2', attrs]);
      assert.equal((c as unknown as Record<symbol, unknown>)[Symbol.for('iwn.texImageSource')], undefined);
      const c1 = new g.OffscreenCanvas(4, 4);
      assert.equal(c1.getContext('webgl'), glCtx);
      assert.equal(calls[1]![1], 'webgl');
    } finally {
      (globalThis as Record<string, unknown>).__iwnWebGL = prev;
    }
  });

  it('a DOM HTMLCanvasElement keeps its own getContext for types canvas2d does not create', () => {
    const domContexts: string[] = [];
    class HTMLCanvasElement {
      getContext(type: string): object | null {
        domContexts.push(type);
        return type === 'webgl2' ? { dom: 'webgl2' } : null;
      }
    }
    const global: Record<string, unknown> = { HTMLCanvasElement, navigator: { language: 'en' } };
    installCanvas2D(global, { natives: natives!, mode: 'all' });
    const el = new HTMLCanvasElement() as unknown as { getContext(t: string): unknown; width: number };
    assert.equal(el.width, 300);
    assert.deepEqual(el.getContext('webgl2'), { dom: 'webgl2' });
    assert.deepEqual(domContexts, ['webgl2']);
    const el2 = new HTMLCanvasElement() as unknown as { getContext(t: string): { fillRect: unknown } };
    assert.equal(typeof el2.getContext('2d').fillRect, 'function');
    assert.deepEqual(domContexts, ['webgl2']);
  });

  const gl = natives ? realNatives() : null;
  it('draw 2D -> texImage2D(canvas) -> texture read back through a framebuffer (host GL addon, Mesa)', { skip: gl ? false : 'host GL addon not built' }, () => {
    const scope: Record<string, unknown> = {};
    const inst = installWebGL(scope, gl!);
    const src = new g.OffscreenCanvas(4, 2);
    const c2 = src.getContext('2d');
    c2.fillStyle = '#ff0000';
    c2.fillRect(0, 0, 2, 2);
    c2.fillStyle = 'rgba(0, 0, 255, 0.5)';
    c2.fillRect(2, 0, 2, 1);
    type GL = Record<string, (...a: any[]) => any> & Record<string, number>;
    const w = inst.createContext({ width: 4, height: 2 }, 'webgl2', {}) as unknown as GL;
    const tex = w.createTexture();
    w.bindTexture(w.TEXTURE_2D, tex);
    // three.js CanvasTexture defaults: flipY true, premultiplyAlpha false.
    w.pixelStorei(w.UNPACK_FLIP_Y_WEBGL, true);
    w.texImage2D(w.TEXTURE_2D, 0, w.RGBA, w.RGBA, w.UNSIGNED_BYTE, src);
    assert.equal(w.getError(), 0);
    const fb = w.createFramebuffer();
    w.bindFramebuffer(w.FRAMEBUFFER, fb);
    w.framebufferTexture2D(w.FRAMEBUFFER, w.COLOR_ATTACHMENT0, w.TEXTURE_2D, tex, 0);
    assert.equal(w.checkFramebufferStatus(w.FRAMEBUFFER), w.FRAMEBUFFER_COMPLETE);
    const px = new Uint8Array(4 * 2 * 4);
    w.readPixels(0, 0, 4, 2, w.RGBA, w.UNSIGNED_BYTE, px);
    // GL row 0 is the bottom row; with FLIP_Y the canvas's top row (the blue pixels) is uploaded last = GL row 1.
    const at = (x: number, y: number) => [...px.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    assert.deepEqual(at(0, 1), [255, 0, 0, 255]);
    assert.deepEqual(at(3, 1), [0, 0, 255, 128]);
    assert.deepEqual(at(3, 0), [0, 0, 0, 0]);
    assert.deepEqual(at(1, 0), [255, 0, 0, 255]);
  });

  it('a WebGL canvas is drawable (drawImage) and uploadable (texImage2D into another context)', { skip: gl ? false : 'host GL addon not built' }, () => {
    const scope: Record<string, unknown> = {};
    const inst = installWebGL(scope, gl!);
    const prev = (globalThis as Record<string, unknown>).__iwnWebGL;
    (globalThis as Record<string, unknown>).__iwnWebGL = { createContext: inst.createContext };
    try {
      type GL = Record<string, (...a: any[]) => any> & Record<string, number>;
      const glCanvas = new g.OffscreenCanvas(4, 2);
      const w = glCanvas.getContext('webgl2', { premultipliedAlpha: false }) as unknown as GL;
      assert.ok(w);
      // Top row green, bottom row blue (GL row 0 is the bottom), via scissored clears.
      w.enable(w.SCISSOR_TEST);
      w.scissor(0, 0, 4, 1);
      w.clearColor(0, 0, 1, 1);
      w.clear(w.COLOR_BUFFER_BIT);
      w.scissor(0, 1, 4, 1);
      w.clearColor(0, 1, 0, 1);
      w.clear(w.COLOR_BUFFER_BIT);
      w.disable(w.SCISSOR_TEST);
      const fb = w.createFramebuffer(); // a bound user framebuffer must survive the readback
      w.bindFramebuffer(w.FRAMEBUFFER, fb);
      const out = new g.OffscreenCanvas(4, 2);
      const c2 = out.getContext('2d');
      c2.drawImage(glCanvas, 0, 0);
      const px = c2.getImageData(0, 0, 4, 2).data;
      assert.deepEqual([...px.subarray(0, 4)], [0, 255, 0, 255]);
      assert.deepEqual([...px.subarray(16, 20)], [0, 0, 255, 255]);
      assert.equal(w.getParameter(w.FRAMEBUFFER_BINDING), fb);
      // texImage2D(glCanvas) into a second context.
      const w2 = inst.createContext({ width: 4, height: 2 }, 'webgl2', {}) as unknown as GL;
      const tex = w2.createTexture();
      w2.bindTexture(w2.TEXTURE_2D, tex);
      w2.texImage2D(w2.TEXTURE_2D, 0, w2.RGBA, w2.RGBA, w2.UNSIGNED_BYTE, glCanvas);
      assert.equal(w2.getError(), 0);
      const fb2 = w2.createFramebuffer();
      w2.bindFramebuffer(w2.FRAMEBUFFER, fb2);
      w2.framebufferTexture2D(w2.FRAMEBUFFER, w2.COLOR_ATTACHMENT0, w2.TEXTURE_2D, tex, 0);
      const t = new Uint8Array(32);
      w2.readPixels(0, 0, 4, 2, w2.RGBA, w2.UNSIGNED_BYTE, t);
      // No FLIP_Y: the canvas's top row (green) is texture row 0.
      assert.deepEqual([...t.subarray(0, 4)], [0, 255, 0, 255]);
      assert.deepEqual([...t.subarray(16, 20)], [0, 0, 255, 255]);
    } finally {
      (globalThis as Record<string, unknown>).__iwnWebGL = prev;
    }
  });
});
