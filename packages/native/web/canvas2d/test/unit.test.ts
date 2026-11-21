/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Spec-semantics tests for the JS layer: CSS colour and font parsing, paths, attribute validation, the state stack,
// canvases and contexts, ImageData, fonts. Pure modules run without natives; context tests use the addon.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parseColor, serializeColor } from '../src/color.ts';
import { parseFont, serializeFont } from '../src/font.ts';
import { matchFace } from '../src/fonts.ts';
import { parseSvgPath, PathBuilder } from '../src/path.ts';
import { VERB_CLOSE, VERB_CUBIC, VERB_LINE, VERB_MOVE } from '../src/natives.ts';
import { FONT_DIR, loadNatives, makeGlobal } from './helpers.ts';

describe('CSS colours (C2D-6)', () => {
  const ok = (s: string, r: number, g: number, b: number, a = 255) => assert.deepEqual(parseColor(s), { r, g, b, a }, s);
  it('parses named, hex, rgb, hsl, hwb', () => {
    ok('red', 255, 0, 0);
    ok('  RebeccaPurple ', 102, 51, 153);
    ok('transparent', 0, 0, 0, 0);
    ok('#abc', 0xaa, 0xbb, 0xcc);
    ok('#abcd', 0xaa, 0xbb, 0xcc, 0xdd);
    ok('#a1b2c3', 0xa1, 0xb2, 0xc3);
    ok('#a1b2c380', 0xa1, 0xb2, 0xc3, 0x80);
    ok('rgb(255, 128, 0)', 255, 128, 0);
    ok('rgba(255,128,0,0.5)', 255, 128, 0, 128);
    ok('rgb(100% 50% 0% / 25%)', 255, 128, 0, 64);
    ok('rgb(300 -5 12.6)', 255, 0, 13);
    ok('hsl(120, 100%, 50%)', 0, 255, 0);
    ok('hsla(240deg 100% 50% / 0.5)', 0, 0, 255, 128);
    ok('hsl(0.5turn 100% 25%)', 0, 128, 128);
    ok('hwb(0 0% 0%)', 255, 0, 0);
  });
  it('rejects invalid values', () => {
    for (const s of ['', 'nope', '#ab', '#abcde', 'rgb(1,2)', 'rgb(1 2, 3)', 'rgb(10%, 20, 30)', 'hsl(1,2,3)', 'lab(50 0)', 'rgb(1 2 3 4)']) {
      assert.equal(parseColor(s), null, s);
    }
  });
  it('serializes like browsers', () => {
    assert.equal(serializeColor({ r: 255, g: 0, b: 16, a: 255 }), '#ff0010');
    assert.equal(serializeColor({ r: 1, g: 2, b: 3, a: 128 }), 'rgba(1, 2, 3, 0.5)');
    assert.equal(serializeColor({ r: 0, g: 0, b: 0, a: 77 }), 'rgba(0, 0, 0, 0.3)');
    assert.equal(serializeColor({ r: 0, g: 0, b: 0, a: 0 }), 'rgba(0, 0, 0, 0)');
  });
  it('CSS Color 4 spaces convert to sRGB and keep their serialization (values from Chrome 145)', () => {
    const cases: [string, string, [number, number, number, number]][] = [
      ['lab(50% 40 59.5)', 'lab(50 40 59.5)', [191, 87, 0, 255]],
      ['oklch(70% 0.1 200)', 'oklch(0.7 0.1 200)', [64, 177, 183, 255]],
      ['lch(70% 50% 120deg)', 'lch(70 75 120)', [125, 188, 27, 255]],
      ['oklab(40% -50% 30%)', 'oklab(0.4 -0.2 0.12)', [0, 99, 0, 255]],
      ['color(display-p3 0.2 0.8 0.3)', 'color(display-p3 0.2 0.8 0.3)', [0, 208, 50, 255]],
      ['color(srgb-linear 0.5 0.2 0.1)', 'color(srgb-linear 0.5 0.2 0.1)', [188, 124, 89, 255]],
      ['color(rec2020 0.3 0.5 0.7)', 'color(rec2020 0.3 0.5 0.7)', [0, 144, 191, 255]],
      ['color(a98-rgb 0.4 0.6 0.2)', 'color(a98-rgb 0.4 0.6 0.2)', [67, 154, 34, 255]],
      ['color(prophoto-rgb 0.5 0.4 0.3)', 'color(prophoto-rgb 0.5 0.4 0.3)', [171, 115, 90, 255]],
      ['color(xyz 0.3 0.4 0.5)', 'color(xyz-d65 0.3 0.4 0.5)', [92, 184, 181, 255]],
      ['color(xyz-d50 0.3 0.4 0.5)', 'color(xyz-d50 0.3 0.4 0.5)', [62, 186, 208, 255]],
      ['color(srgb 0.25 0.5 0.75 / 0.3)', 'color(srgb 0.25 0.5 0.75 / 0.3)', [64, 128, 191, 77]],
    ];
    for (const [input, css, [r, g, b, a]] of cases) {
      const c = parseColor(input)!;
      assert.ok(c, input);
      assert.equal(serializeColor(c), css);
      assert.deepEqual([c.r, c.g, c.b, c.a], [r, g, b, a], input);
    }
    assert.equal(parseColor('lab(50 40)'), null);
    assert.equal(parseColor('color(unknown 1 0 0)'), null);
  });
});

describe('CSS font shorthand (C2D-8)', () => {
  it('parses style, variant, weight, stretch, size units and families', () => {
    const f = parseFont('italic small-caps bold condensed 12pt/1.5 "Helvetica Neue", Arial, sans-serif')!;
    assert.equal(f.style, 'italic');
    assert.equal(f.smallCaps, true);
    assert.equal(f.weight, 700);
    assert.equal(f.stretch, 'condensed');
    assert.equal(f.sizePx, 16);
    assert.deepEqual(f.families, ['Helvetica Neue', 'Arial', 'sans-serif']);
    assert.deepEqual(f.generic, [false, false, true]);
    assert.equal(parseFont('2em serif')!.sizePx, 20);
    assert.equal(parseFont('150% serif')!.sizePx, 15);
    assert.equal(parseFont('x-large serif')!.sizePx, 24);
    assert.equal(parseFont('300 10px Open Sans')!.families[0], 'Open Sans');
    assert.equal(parseFont('lighter 10px a')!.weight, 100);
    assert.equal(parseFont('caption')!.families[0], 'sans-serif');
    assert.equal(parseFont('caption')!.sizePx, 16);
  });
  it('rejects invalid values', () => {
    for (const s of ['', '12px', 'bold', '12px,', '12px a,,b', 'bold bold 12px a', '-1px a', '12px inherit', 'foo 12px a', '12px "a" b']) {
      assert.equal(parseFont(s), null, s);
    }
  });
  it('serializes with computed px size and no line-height', () => {
    assert.equal(serializeFont(parseFont('10px sans-serif')!), '10px sans-serif');
    assert.equal(serializeFont(parseFont('bold 12pt/2 "My Font", serif')!), 'bold 16px "My Font", serif');
    assert.equal(serializeFont(parseFont('italic 600 1.5em Arial Black')!), 'italic 600 15px Arial Black');
    // As Chrome: 700 reads back as bold, oblique as italic, weight before small-caps, stretch omitted.
    assert.equal(serializeFont(parseFont('italic small-caps 700 2em "My Font", serif')!), 'italic bold small-caps 20px "My Font", serif');
    assert.equal(serializeFont(parseFont('bolder 12px y')!), 'bold 12px y');
    assert.equal(serializeFont(parseFont('oblique 10px sans-serif')!), 'italic 10px sans-serif');
    assert.equal(serializeFont(parseFont('condensed 10px w')!), '10px w');
    assert.equal(serializeFont(parseFont('caption')!), '16px sans-serif');
  });
});

describe('font matching (CSS Fonts 4 §5.2)', () => {
  const e = (w0: number, w1: number, italic = false) => ({ face: {} as never, family: 'x', weightMin: w0, weightMax: w1, italic, oblique: false, stretch: 100 });
  it('picks weights per the CSS rules', () => {
    const faces = [e(300, 300), e(400, 400), e(700, 700)];
    assert.equal(matchFace(faces, { style: 'normal', weight: 500, stretchPercent: 100 }).weightMin, 400);
    assert.equal(matchFace(faces, { style: 'normal', weight: 600, stretchPercent: 100 }).weightMin, 700);
    assert.equal(matchFace(faces, { style: 'normal', weight: 350, stretchPercent: 100 }).weightMin, 300);
    assert.equal(matchFace([e(100, 900)], { style: 'normal', weight: 650, stretchPercent: 100 }).weightMax, 900);
  });
  it('prefers italic faces for italic', () => {
    const faces = [e(400, 400), e(400, 400, true)];
    assert.equal(matchFace(faces, { style: 'italic', weight: 400, stretchPercent: 100 }).italic, true);
    assert.equal(matchFace(faces, { style: 'normal', weight: 400, stretchPercent: 100 }).italic, false);
  });
});

function verbs(p: PathBuilder): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.len; ) {
    const v = p.buf[i]!;
    out.push(v);
    i += 1 + (v === VERB_MOVE || v === VERB_LINE ? 2 : v === 2 ? 4 : v === VERB_CUBIC ? 6 : 0);
  }
  return out;
}

describe('paths (C2D-6)', () => {
  it('lineTo without a subpath starts one; closePath starts a new subpath at the start point', () => {
    const p = new PathBuilder();
    p.lineTo(1, 2);
    p.lineTo(3, 4);
    p.closePath();
    assert.deepEqual(verbs(p), [VERB_MOVE, VERB_LINE, VERB_CLOSE, VERB_MOVE]);
    assert.equal(p.lastX, 1);
  });
  it('arcs become cubics; full circles have four segments', () => {
    const p = new PathBuilder();
    p.arc(0, 0, 10, 0, Math.PI * 2);
    assert.deepEqual(verbs(p), [VERB_MOVE, VERB_CUBIC, VERB_CUBIC, VERB_CUBIC, VERB_CUBIC]);
    const end = p.len;
    assert.ok(Math.abs(p.buf[end - 2]! - 10) < 1e-4 && Math.abs(p.buf[end - 1]!) < 1e-4);
    assert.throws(() => p.arc(0, 0, -1, 0, 1), { name: 'IndexSizeError' });
  });
  it('ignores non-finite arguments', () => {
    const p = new PathBuilder();
    p.moveTo(NaN, 0);
    p.lineTo(Infinity, 1);
    assert.equal(p.len, 0);
  });
  it('roundRect accepts all radius forms and validates', () => {
    const p = new PathBuilder();
    p.roundRect(0, 0, 10, 10, 2);
    p.roundRect(0, 0, 10, 10, [1, 2]);
    p.roundRect(0, 0, 10, 10, [1, 2, 3]);
    p.roundRect(0, 0, 10, 10, [1, 2, 3, 4]);
    p.roundRect(0, 0, 10, 10, { x: 2, y: 3 });
    p.roundRect(0, 0, 10, 10, undefined);
    assert.throws(() => p.roundRect(0, 0, 10, 10, [1, 2, 3, 4, 5]), RangeError);
    assert.throws(() => p.roundRect(0, 0, 10, 10, -1), RangeError);
    assert.ok(p.len > 0);
  });
  it('parses SVG path data and keeps the valid prefix on errors', () => {
    const p = new PathBuilder();
    parseSvgPath('M10 10 h 5 v5 H10 z m1-1 l2.5.5 C1,2,3,4,5,6 s1 1 2 2 Q1 1 2 2 t3 3 A5 5 0 0 1 20 20', p);
    assert.equal(verbs(p)[0], VERB_MOVE);
    assert.ok(verbs(p).includes(VERB_CUBIC));
    const q = new PathBuilder();
    parseSvgPath('M0 0 L10 10 L oops 5', q);
    assert.deepEqual(verbs(q), [VERB_MOVE, VERB_LINE]);
    const r = new PathBuilder();
    parseSvgPath('L10 10', r);
    assert.equal(r.len, 0);
  });
});

const natives = loadNatives();
describe('2D context semantics', { skip: natives ? false : 'canvas2d addon not built' }, () => {
  const g = natives ? makeGlobal(natives) : (null as never);
  const ctx2d = (w = 20, h = 20) => new g.OffscreenCanvas(w, h).getContext('2d');

  it('loads WOFF and WOFF2 fonts through FontFace (same metrics and ink as the TTF)', () => {
    const draw = (font: string) => {
      const c = new g.OffscreenCanvas(240, 50).getContext('2d');
      c.font = font;
      c.fillText('Ag Showcase 123', 4, 36);
      const d = c.getImageData(0, 0, 240, 50).data as Uint8ClampedArray;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) ink += d[i]!;
      return { ink: ink / 255, width: c.measureText('Ag Showcase 123').width as number };
    };
    const fx = resolve(import.meta.dirname, 'fixtures');
    for (const [family, file] of [['TestWoff1', 'roboto-latin-400-normal.woff'], ['TestWoff2', 'roboto-latin-400-normal.woff2']] as const) {
      const ff = new g.FontFace(family, readFileSync(resolve(fx, file)));
      assert.equal(ff.status, 'loaded', file);
      g.fonts.add(ff);
    }
    const ttf = draw('28px IwnTest');
    for (const family of ['TestWoff1', 'TestWoff2']) {
      const r = draw(`28px ${family}`);
      assert.equal(r.width, ttf.width, family);
      assert.ok(Math.abs(r.ink - ttf.ink) < ttf.ink * 0.01, `${family}: ink ${r.ink} vs ${ttf.ink}`);
    }
  });

  it('kerning: fontKerning "none" turns pair kerning off (C2D-8)', () => {
    const ctx = ctx2d(10, 10);
    ctx.font = '40px IwnTest';
    const kerned = ctx.measureText('AVAWATa').width;
    ctx.fontKerning = 'none';
    const plain = ctx.measureText('AVAWATa').width;
    assert.ok(plain > kerned + 4, `${plain} vs ${kerned}`);
    ctx.fontKerning = 'normal';
    assert.equal(ctx.measureText('AVAWATa').width, kerned);
  });

  it('bidi through the JS layer: digits after Arabic keep their order; RTL text measures the same either way', () => {
    const ctx = ctx2d(10, 10);
    ctx.font = '20px IwnTest';
    const ltr = ctx.measureText('Label: مرحبا 42').width;
    ctx.direction = 'rtl';
    assert.equal(ctx.measureText('Label: مرحبا 42').width, ltr);
  });

  it('argument conversions follow WebIDL like Chrome (ImageData sizes, putImageData arity)', () => {
    assert.throws(() => new g.ImageData(Infinity, 1), { name: 'IndexSizeError' });
    assert.throws(() => new g.ImageData(NaN, 1), { name: 'IndexSizeError' });
    const ctx = ctx2d(4, 4);
    const d = ctx.createImageData(1, 1);
    for (const n of [4, 5, 6]) {
      const args = [d, 0, 0, 0, 0, 1, 1].slice(0, n);
      assert.throws(() => ctx.putImageData(...args), TypeError, `${n} arguments`);
    }
    ctx.putImageData(d, 0, 0);
    ctx.putImageData(d, 0, 0, 0, 0, 1, 1);
    ctx.fillStyle = 'oklch(0.7 0.1 200)';
    assert.equal(ctx.fillStyle, 'oklch(0.7 0.1 200)');
    ctx.font = 'italic small-caps 700 2em "My Font", serif';
    assert.equal(ctx.font, 'italic bold small-caps 20px "My Font", serif');
  });

  it('getContext returns the same context; another type gets null (C2D-1)', () => {
    const c = new g.OffscreenCanvas(10, 10);
    const a = c.getContext('2d');
    assert.equal(c.getContext('2d'), a);
    assert.equal(c.getContext('webgl2'), null);
    assert.equal(a.canvas, c);
    assert.throws(() => new g.OffscreenCanvas(10, 10).getContext('bitmaprenderer'), /not implemented/);
  });

  it('defaults and invalid assignments are ignored (C2D-4)', () => {
    const ctx = ctx2d();
    assert.equal(ctx.fillStyle, '#000000');
    assert.equal(ctx.font, '10px sans-serif');
    assert.equal(ctx.lineWidth, 1);
    assert.equal(ctx.globalCompositeOperation, 'source-over');
    assert.equal(ctx.textBaseline, 'alphabetic');
    ctx.lineWidth = -1;
    ctx.lineWidth = NaN;
    assert.equal(ctx.lineWidth, 1);
    ctx.globalAlpha = 2;
    assert.equal(ctx.globalAlpha, 1);
    ctx.globalCompositeOperation = 'bogus';
    assert.equal(ctx.globalCompositeOperation, 'source-over');
    ctx.fillStyle = 'not a colour';
    assert.equal(ctx.fillStyle, '#000000');
    ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
    assert.equal(ctx.fillStyle, 'rgba(255, 0, 0, 0.5)');
    ctx.font = 'garbage';
    assert.equal(ctx.font, '10px sans-serif');
    ctx.font = 'bold 20px Arial';
    assert.equal(ctx.font, 'bold 20px Arial');
    ctx.setLineDash([1, 2, 3]);
    assert.deepEqual(ctx.getLineDash(), [1, 2, 3, 1, 2, 3]);
    ctx.setLineDash([1, -2]);
    assert.deepEqual(ctx.getLineDash(), [1, 2, 3, 1, 2, 3]);
    ctx.textAlign = 'middle';
    assert.equal(ctx.textAlign, 'start');
  });

  it('save/restore covers styles, transform and clip; reset() clears', () => {
    const ctx = ctx2d();
    ctx.fillStyle = 'red';
    ctx.translate(5, 5);
    ctx.save();
    ctx.fillStyle = 'blue';
    ctx.rotate(1);
    ctx.beginPath();
    ctx.rect(0, 0, 1, 1);
    ctx.clip();
    ctx.restore();
    assert.equal(ctx.fillStyle, '#ff0000');
    const t = ctx.getTransform();
    assert.equal(t.e, 5);
    ctx.fillRect(-5, -5, 20, 20); // clip restored: whole canvas painted
    assert.equal(ctx.getImageData(19, 19, 1, 1).data[3], 255);
    ctx.reset();
    assert.equal(ctx.getImageData(19, 19, 1, 1).data[3], 0);
    assert.equal(ctx.fillStyle, '#000000');
    assert.equal(ctx.getTransform().e, 0);
  });

  it('roundRect at module top level works (REG-1) and fills', () => {
    const ctx = ctx2d();
    ctx.beginPath();
    ctx.roundRect(0, 0, 20, 20, [4]);
    ctx.fill();
    assert.equal(ctx.getImageData(10, 10, 1, 1).data[3], 255);
    assert.ok(ctx.getImageData(0, 0, 1, 1).data[3] < 128);
  });

  it('stroke draws (GAP-1)', () => {
    const ctx = ctx2d();
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 10);
    ctx.lineTo(20, 10);
    ctx.stroke();
    assert.equal(ctx.getImageData(10, 9, 1, 1).data[3], 255);
  });

  it('width/height setters clear and reset the context', () => {
    const c = new g.OffscreenCanvas(10, 10);
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 10, 10);
    c.width = 12;
    assert.equal(ctx.fillStyle, '#000000');
    const d = ctx.getImageData(0, 0, 12, 10).data;
    assert.ok(d.every((v: number) => v === 0));
  });

  it('ImageData validation (IMG-5) and pixel round trip (C2D-5)', () => {
    assert.throws(() => new g.ImageData(0, 1), { name: 'IndexSizeError' });
    assert.throws(() => new g.ImageData(new Uint8ClampedArray(6), 1), { name: 'InvalidStateError' });
    assert.throws(() => new g.ImageData(new Uint8ClampedArray(16), 3), { name: 'IndexSizeError' });
    const id = new g.ImageData(new Uint8ClampedArray(16), 2);
    assert.equal(id.height, 2);
    assert.equal(id.colorSpace, 'srgb');
    const ctx = ctx2d(4, 4);
    assert.throws(() => ctx.getImageData(0, 0, 0, 1), { name: 'IndexSizeError' });
    const img = ctx.createImageData(2, 2);
    img.data.set([10, 20, 30, 255, 40, 50, 60, 255, 0, 0, 0, 0, 1, 2, 3, 255]);
    ctx.putImageData(img, 1, 1);
    assert.deepEqual([...ctx.getImageData(1, 1, 2, 1).data], [10, 20, 30, 255, 40, 50, 60, 255]);
    const neg = ctx.getImageData(3, 3, -2, -2);
    assert.equal(neg.width, 2);
    assert.throws(() => ctx.drawImage(img, 0, 0), TypeError);
  });

  it('gradients and patterns validate arguments', () => {
    const ctx = ctx2d();
    assert.throws(() => ctx.createLinearGradient(0, 0, NaN, 1), TypeError);
    assert.throws(() => ctx.createRadialGradient(0, 0, -1, 0, 0, 1), { name: 'IndexSizeError' });
    const gr = ctx.createLinearGradient(0, 0, 1, 0);
    assert.throws(() => gr.addColorStop(1.5, 'red'), { name: 'IndexSizeError' });
    assert.throws(() => gr.addColorStop(0.5, 'nope'), { name: 'SyntaxError' });
    assert.throws(() => ctx.createPattern(new g.OffscreenCanvas(2, 2), 'diagonal'), { name: 'SyntaxError' });
    assert.ok(ctx.createPattern(new g.OffscreenCanvas(2, 2), null));
    assert.throws(() => ctx.createPattern(new g.OffscreenCanvas(0, 2), 'repeat'), { name: 'InvalidStateError' });
    assert.throws(() => new g.CanvasGradient(), TypeError);
  });

  it('drawImage arity and the pixel protocol', () => {
    const ctx = ctx2d(4, 4);
    const src = {
      [Symbol.for('iwn.pixels')]: () => ({ data: new Uint8Array(4 * 4 * 4).fill(255), width: 4, height: 4 }),
    };
    assert.throws(() => ctx.drawImage(src, 0), TypeError);
    ctx.drawImage(src, 0, 0);
    assert.equal(ctx.getImageData(2, 2, 1, 1).data[3], 255);
    const notReady = { [Symbol.for('iwn.pixels')]: () => null };
    ctx.drawImage(notReady, 0, 0); // draws nothing, no throw
  });

  it('measureText returns TextMetrics consistent with the font size (C2D-8)', () => {
    const ctx = ctx2d();
    ctx.font = '48px IwnTest';
    const m = ctx.measureText('M');
    assert.ok(Math.abs(m.width - 41.91) < 0.05, String(m.width));
    assert.ok(m.actualBoundingBoxAscent > 30);
    assert.equal(m.alphabeticBaseline, 0);
    ctx.font = '20px "Some Missing Font", sans-serif';
    assert.ok(ctx.measureText('Hello').width > 0);
  });

  it('unknown family falls back to the bundled sans-serif (C2D-9)', () => {
    const a = ctx2d();
    a.font = '20px "Some Missing Font"';
    const b = ctx2d();
    b.font = '20px sans-serif';
    assert.equal(a.measureText('Showcase').width, b.measureText('Showcase').width);
    const m = ctx2d();
    m.font = '20px monospace';
    assert.equal(m.measureText('iiii').width, m.measureText('MMMM').width);
  });

  it('FontFace and document.fonts (C2D-10)', async () => {
    const bytes = readFileSync(resolve(FONT_DIR, 'RobotoMono-Regular.ttf'));
    const f = new g.FontFace('My Mono', bytes);
    assert.equal(f.status, 'loaded');
    g.fonts.add(f);
    assert.equal(g.fonts.check('12px "My Mono"'), true);
    await g.fonts.ready;
    const ctx = ctx2d();
    ctx.font = '20px "My Mono"';
    assert.equal(ctx.measureText('iiii').width, ctx.measureText('MMMM').width);
    const bad = new g.FontFace('Bad', new Uint8Array([1, 2, 3]));
    assert.equal(bad.status, 'error');
    await assert.rejects(bad.loaded, { name: 'SyntaxError' });
    const u = new g.FontFace('Url', 'url(missing.ttf)');
    assert.equal(u.status, 'unloaded');
    assert.throws(() => g.fonts.check('nonsense'), { name: 'SyntaxError' });
  });

  it('toDataURL / convertToBlob-free encode paths', () => {
    const c = new g.OffscreenCanvas(3, 2);
    const host = c as unknown as Record<symbol, () => unknown>;
    assert.ok(host[Symbol.for('iwn.pixels')]!());
    const empty = new g.OffscreenCanvas(0, 0);
    assert.equal(empty.getContext('2d').canvas.width, 0);
  });

  it('isPointInPath ignores the transform for the point (C2D-6)', () => {
    const ctx = ctx2d();
    ctx.translate(10, 0);
    ctx.beginPath();
    ctx.rect(0, 0, 5, 5);
    assert.equal(ctx.isPointInPath(12, 2), true);
    assert.equal(ctx.isPointInPath(2, 2), false);
    assert.throws(() => ctx.isPointInPath(1, 1, 'wrong'), TypeError);
  });

  it('isPointInPath / isPointInStroke: points on the path are inside (HTML; values from Chrome 145)', () => {
    const ctx = ctx2d(40, 40);
    ctx.beginPath();
    ctx.rect(0, 0, 10, 10);
    const pts: [number, number][] = [[0, 5], [10, 5], [5, 0], [5, 10], [0, 0], [10, 10], [9.999, 5], [10.001, 5]];
    assert.deepEqual(pts.map(([x, y]) => ctx.isPointInPath(x, y)), [true, true, true, true, true, true, true, false]);
    ctx.beginPath();
    ctx.moveTo(0, 14);
    ctx.lineTo(30, 14);
    ctx.lineWidth = 4;
    const sp: [number, number][] = [[15, 12], [15, 16], [15, 11.999], [0, 14], [30, 14], [-0.001, 14]];
    assert.deepEqual(sp.map(([x, y]) => ctx.isPointInStroke(x, y)), [true, true, false, true, true, false]);
  });

  it('OffscreenCanvas dimensions are [EnforceRange]; element dimensions fall back to the default', () => {
    const c = new g.OffscreenCanvas(10, 10);
    assert.throws(() => (c.width = -1), TypeError);
    assert.throws(() => (c.height = 2 ** 32 + 5), TypeError);
    assert.throws(() => (c.width = NaN), TypeError);
    assert.throws(() => new g.OffscreenCanvas(-1, 1), TypeError);
    assert.equal(c.width, 10);
    c.width = 7.9;
    assert.equal(c.width, 7);
    c.height = -0.5; // truncates to 0: in range
    assert.equal(c.height, 0);
    assert.equal(new g.OffscreenCanvas(-0.5, 2).width, 0);
  });

  it('font sizes clamp to 10000px; letter/word spacing parse and track em (values from Chrome 145)', () => {
    const ctx = ctx2d();
    ctx.font = '1e30px sans-serif';
    assert.equal(ctx.font, '10000px sans-serif');
    ctx.font = '20000px serif';
    assert.equal(ctx.font, '10000px serif');
    ctx.font = '20px serif';
    ctx.letterSpacing = ' 0.5EM ';
    assert.equal(ctx.letterSpacing, '0.5em');
    ctx.letterSpacing = 'bogus';
    assert.equal(ctx.letterSpacing, '0.5em');
    const w0 = (ctx.letterSpacing = '0px', ctx.measureText('abc').width);
    ctx.letterSpacing = '0.5em'; // 10px at 20px
    assert.ok(Math.abs(ctx.measureText('abc').width - (w0 + 30)) < 0.01);
    // em resolves against the font at measure/draw time, not when assigned (Chrome 145: 'AVAV' 69.13 -> 89 px).
    ctx.font = '10px serif';
    ctx.letterSpacing = '0.5em';
    ctx.font = '20px serif';
    const at20 = ctx.measureText('abc').width;
    assert.ok(Math.abs(at20 - (w0 + 30)) < 0.01, `${at20} vs ${w0 + 30}`);
    ctx.letterSpacing = '0.5em'; // the same value again keeps it
    assert.ok(Math.abs(ctx.measureText('abc').width - (w0 + 30)) < 0.01);
    ctx.letterSpacing = '0px';
    const plain20 = ctx.measureText('a b').width;
    ctx.font = '10px serif';
    ctx.wordSpacing = '1em';
    ctx.font = '20px serif';
    assert.ok(Math.abs(ctx.measureText('a b').width - (plain20 + 20)) < 0.01);
  });

  it('clearRect on an opaque canvas blackens only the rect, inside the clip (C2D-5; Chrome 145)', () => {
    const ctx = new g.OffscreenCanvas(40, 20).getContext('2d', { alpha: false });
    ctx.fillStyle = '#f00';
    ctx.fillRect(0, 0, 40, 20);
    ctx.clearRect(10, 5, 5, 5);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    assert.deepEqual(px(12, 7), [0, 0, 0, 255]);
    assert.deepEqual(px(1, 1), [255, 0, 0, 255]);
    assert.deepEqual(px(30, 15), [255, 0, 0, 255]);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 20, 20);
    ctx.clip();
    ctx.globalCompositeOperation = 'copy';
    ctx.globalAlpha = 0.5;
    ctx.clearRect(16, 0, 10, 10); // clipped to x < 20; alpha and the composite operation do not apply
    assert.equal(ctx.globalCompositeOperation, 'copy');
    ctx.restore();
    assert.deepEqual(px(18, 5), [0, 0, 0, 255]);
    assert.deepEqual(px(22, 5), [255, 0, 0, 255]);
    assert.deepEqual(px(5, 15), [255, 0, 0, 255]);
    assert.deepEqual(px(18, 15), [255, 0, 0, 255]);
  });

  it('getContextAttributes reports colorType and toneMapping; invalid enums throw (Chrome 145)', () => {
    const c = new g.OffscreenCanvas(1, 1);
    const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
    assert.deepEqual(ctx.getContextAttributes(), {
      alpha: false, colorSpace: 'srgb', colorType: 'unorm8', desynchronized: false, toneMapping: { mode: 'standard' }, willReadFrequently: true,
    });
    assert.equal(new g.OffscreenCanvas(1, 1).getContext('2d', { colorType: 'float16' }).getContextAttributes().colorType, 'float16');
    assert.throws(() => new g.OffscreenCanvas(1, 1).getContext('2d', { colorType: 'bogus' }), TypeError);
  });

  it('oversize canvases: 20000 px wide is real (Chrome limit 32767); beyond the limits nothing stale is read', () => {
    const TEX = Symbol.for('iwn.texImageSource');
    const red = new g.OffscreenCanvas(1024, 1024);
    const rctx = red.getContext('2d');
    rctx.fillStyle = '#f00';
    rctx.fillRect(0, 0, 1024, 1024);
    (red as any)[TEX](); // the shared readback buffer now holds red
    const wide = new g.OffscreenCanvas(20000, 10);
    const wctx = wide.getContext('2d');
    assert.deepEqual(Array.from((wide as any)[TEX]().data.subarray(0, 4)), [0, 0, 0, 0]);
    wctx.fillRect(19990, 0, 10, 10);
    assert.equal(wctx.getImageData(19995, 5, 1, 1).data[3], 255);
    const over = new g.OffscreenCanvas(40000, 10); // above 32767: no bitmap
    const octx = over.getContext('2d');
    octx.fillRect(0, 0, 10, 10);
    assert.deepEqual(Array.from(octx.getImageData(0, 0, 1, 1).data), [0, 0, 0, 0]);
    assert.deepEqual(Array.from((over as any)[TEX]().data.subarray(0, 4)), [0, 0, 0, 0]);
    const huge = new g.OffscreenCanvas(3e9, 1);
    huge.getContext('2d').fillRect(0, 0, 1, 1);
    const src = (huge as any)[TEX]();
    assert.deepEqual([src.width, src.height, src.data.length], [0, 0, 0]);
  });

  it("font = '0 sans-serif' (unitless zero length) is accepted", () => {
    const ctx = ctx2d();
    ctx.font = '0 sans-serif';
    assert.equal(ctx.font, '0px sans-serif');
    ctx.font = 'bold 0 serif';
    assert.equal(ctx.font, 'bold 0px serif');
    ctx.font = '5 sans-serif'; // unitless non-zero: invalid, ignored
    assert.equal(ctx.font, 'bold 0px serif');
  });

  it('recycled clip handles keep every saved clip intact (C2D-12 clip pool)', () => {
    const ctx = ctx2d(40, 20);
    const alphaAt = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3];
    for (let frame = 0; frame < 3; frame++) {
      ctx.clearRect(0, 0, 40, 20);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, 20, 20); // outer clip: left half
      ctx.clip();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, 10, 20); // inner: left quarter
      ctx.clip();
      ctx.beginPath();
      ctx.rect(0, 0, 40, 10);
      ctx.clip(); // replaces the inner clip at the same depth (its handle goes back to the pool)
      ctx.fillRect(0, 0, 40, 20);
      ctx.restore();
      // Back to the outer clip only: this draw must reach x in [10, 20) but not x >= 20.
      ctx.fillRect(0, 15, 40, 5);
      ctx.restore();
      assert.equal(alphaAt(5, 5), 255);
      assert.equal(alphaAt(5, 12), 0);
      assert.equal(alphaAt(15, 5), 0);
      assert.equal(alphaAt(15, 17), 255);
      assert.equal(alphaAt(25, 17), 0);
      // No clip left after the final restore.
      ctx.fillRect(30, 0, 2, 2);
      assert.equal(alphaAt(30, 0), 255);
    }
  });

  it('setLineDash with unchanged values keeps the pattern (fast path) and odd lists still double', () => {
    const ctx = ctx2d();
    const d = [3, 1, 2];
    ctx.setLineDash(d);
    assert.deepEqual(ctx.getLineDash(), [3, 1, 2, 3, 1, 2]);
    ctx.setLineDash(d);
    assert.deepEqual(ctx.getLineDash(), [3, 1, 2, 3, 1, 2]);
    ctx.setLineDash([3, 1, 2, 3, 1, 2]);
    assert.deepEqual(ctx.getLineDash(), [3, 1, 2, 3, 1, 2]);
    ctx.setLineDash([4, 2]);
    assert.deepEqual(ctx.getLineDash(), [4, 2]);
    ctx.setLineDash([]);
    assert.deepEqual(ctx.getLineDash(), []);
    ctx.setLineDash([1, -1]); // invalid: ignored
    assert.deepEqual(ctx.getLineDash(), []);
  });

  it('steady-state drawing makes no per-call JS allocations (C2D-12)', () => {
    // Measured in a child process with a 64 MB young generation (no scavenge can hide allocations) after the JIT
    // reached its top tier; see alloc-probe.ts. Budgets: 8 B/call (measurement noise) for drawing and state calls,
    // and the TextMetrics object for measureText (the one result the spec requires per call).
    const r = spawnSync(
      process.execPath,
      ['--expose-gc', '--min-semi-space-size=64', '--max-semi-space-size=64', join(import.meta.dirname, 'alloc-probe.ts')],
      { encoding: 'utf8', env: process.env, timeout: 120_000 },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as { results: Record<string, number>; interrupted: string[] };
    assert.deepEqual(out.interrupted, [], 'a GC ran during a measurement window');
    const over: string[] = [];
    for (const [name, bytes] of Object.entries(out.results)) {
      const budget = name.startsWith('measureText') ? 512 : 8;
      if (!(bytes <= budget)) over.push(`${name}: ${bytes.toFixed(1)} B/call (budget ${budget})`);
    }
    assert.deepEqual(over, []);
    assert.ok(Object.keys(out.results).length >= 24);
  });
});
