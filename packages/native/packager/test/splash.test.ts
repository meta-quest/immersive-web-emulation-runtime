/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { decodePng, encodePng, placeholderIcon, type RgbaImage } from '../src/png.ts';
import {
  buildSplash,
  CARD_HEIGHT,
  CARD_WIDTH,
  renderSplashCard,
  SplashError,
} from '../src/splash.ts';
import {
  drawText,
  measureText,
  missingGlyphs,
  parseTrueType,
  rasterize,
} from '../src/ttf.ts';
import { scratchDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The font every template ships (runtime/canvas2d, C2D-9). */
const ROBOTO_BOLD = readFileSync(
  path.join(here, '../../runtime/canvas2d/fonts/Roboto-Bold.ttf'),
);
const font = parseTrueType(ROBOTO_BOLD);
const scratch = scratchDir('splash');
after(() => rmSync(scratch, { recursive: true, force: true }));

const alphaAt = (img: RgbaImage, x: number, y: number) =>
  img.data[(y * img.width + x) * 4 + 3];

/** Bounding box of pixels with alpha above `min`. */
function inkBox(img: RgbaImage, min = 0) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (alphaAt(img, x, y) > min) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return { x0, y0, x1, y1 };
}

describe('TrueType reader', () => {
  test("reads Roboto Bold's metrics, cmap and outlines", () => {
    assert.equal(font.unitsPerEm, 2048);
    assert.equal(font.capHeight, 1456);
    assert.ok(font.ascender > 0 && font.descender < 0);
    const W = font.glyphId('W'.codePointAt(0)!);
    const i = font.glyphId('i'.codePointAt(0)!);
    assert.ok(W > 0 && i > 0 && W !== i);
    assert.ok(font.advance(W) > font.advance(i));
    assert.equal(font.outline(font.glyphId('O'.codePointAt(0)!)).length, 2); // outer + counter
    // An accented letter is a composite glyph: base + accent.
    const e = font.outline(font.glyphId('é'.codePointAt(0)!));
    assert.ok(e.length >= 2, `é has ${e.length} contours`);
    assert.equal(font.glyphId(0x30b7), 0); // シ: not in Roboto
    assert.deepEqual(missingGlyphs(font, 'IWSDK Showcase'), []);
    assert.deepEqual(missingGlyphs(font, 'Café シ'), ['シ']);
  });

  test('refuses what it cannot read', () => {
    assert.throws(() => parseTrueType(Buffer.from('nope')), /not a font/);
    const otto = Buffer.alloc(64);
    otto.write('OTTO', 0, 'latin1');
    assert.throws(() => parseTrueType(otto), /only TrueType outlines/);
  });
});

describe('rasterizer', () => {
  const square = (x0: number, y0: number, x1: number, y1: number) =>
    [
      [x0, y0, x1, y0],
      [x1, y0, x1, y1],
      [x1, y1, x0, y1],
      [x0, y1, x0, y0],
    ] as [number, number, number, number][];
  const area = (m: { data: Uint8Array }) =>
    m.data.reduce((s, v) => s + v, 0) / 255;

  test('pixel-aligned square: full inside, empty outside', () => {
    const m = rasterize(square(5, 5, 15, 15), 20, 20);
    assert.equal(m.data[10 * 20 + 10], 255);
    assert.equal(m.data[5 * 20 + 5], 255);
    assert.equal(m.data[4 * 20 + 10], 0);
    assert.equal(m.data[10 * 20 + 15], 0);
    assert.equal(area(m), 100);
  });

  test('exact area coverage for edges inside pixels and slanted edges', () => {
    const m = rasterize(square(5.5, 5.25, 15.5, 15.75), 20, 20);
    assert.equal(m.data[10 * 20 + 5], 128); // half a pixel covered
    assert.ok(Math.abs(area(m) - 105) < 0.3);
    // A triangle: area 0.5 * 12 * 9 = 54, either winding.
    const tri: [number, number, number, number][] = [
      [2, 2, 14, 2],
      [14, 2, 2, 11],
      [2, 11, 2, 2],
    ];
    assert.ok(Math.abs(area(rasterize(tri, 20, 20)) - 54) < 0.3);
    const rev = tri.map(([a, b, c, d]) => [c, d, a, b]).reverse() as typeof tri;
    assert.ok(Math.abs(area(rasterize(rev, 20, 20)) - 54) < 0.3);
    // Shapes partly outside the mask are clipped, not wrapped.
    assert.ok(Math.abs(area(rasterize(square(-5, -5, 5, 5), 20, 20)) - 25) < 0.01);
  });

  test('text: ink where the advances say, with anti-aliased edges', () => {
    const w = measureText(font, 'IWSDK', 64);
    assert.ok(w > 150 && w < 220, `width ${w}`);
    const m = drawText(font, 'IWSDK', 64, 10, 60, 260, 80);
    let x1 = -1;
    let partial = 0;
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 260; x++) {
        const v = m.data[y * 260 + x];
        if (v > 0) x1 = Math.max(x1, x);
        if (v > 0 && v < 255) partial++;
      }
    assert.ok(x1 > 10 + w - 12 && x1 <= 10 + w + 1, `ink ends at ${x1}`);
    assert.ok(partial > 50, 'anti-aliased edges');
    // Cap height 1456/2048 of 64 px above the baseline at y = 60: the "I" stem spans rows ~15..59.
    const stem = font.outline(font.glyphId('I'.codePointAt(0)!))[0];
    const xs = stem.map((p) => p.x);
    const sx = Math.round(10 + ((Math.min(...xs) + Math.max(...xs)) / 2) * (64 / 2048));
    assert.ok(m.data[20 * 260 + sx] > 200 && m.data[58 * 260 + sx] > 200);
    assert.equal(m.data[62 * 260 + sx], 0);
    assert.equal(m.data[12 * 260 + sx], 0);
  });
});

describe('generated splash card', () => {
  test('icon above the app name, centred, on transparency', () => {
    const card = renderSplashCard({
      appName: 'IWSDK Showcase',
      icon: placeholderIcon(256),
      font,
    });
    const img = card.image;
    assert.equal(img.width, CARD_WIDTH);
    assert.equal(img.height, CARD_HEIGHT);
    assert.equal(card.text, 'IWSDK Showcase');
    assert.equal(card.fontPx, 80);
    assert.deepEqual(card.warnings, []);
    // Corners and margins are clear: the system and the runtime draw it on their own background.
    assert.equal(alphaAt(img, 0, 0), 0);
    assert.equal(alphaAt(img, CARD_WIDTH - 1, CARD_HEIGHT - 1), 0);
    const box = inkBox(img);
    assert.ok(box.x0 >= 48 && box.x1 <= CARD_WIDTH - 48, JSON.stringify(box));
    // Centred horizontally, the block centred vertically.
    assert.ok(Math.abs((box.x0 + box.x1) / 2 - CARD_WIDTH / 2) < 4);
    assert.ok(Math.abs((box.y0 + box.y1) / 2 - CARD_HEIGHT / 2) < 24);
    // The icon (opaque, blue) at the top centre, white text below it.
    const icon = (x: number, y: number) => img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4);
    const blue = icon(CARD_WIDTH / 2 - 60, box.y0 + 40);
    assert.equal(blue[3], 255);
    assert.ok(blue[2] > 150 && blue[0] < 60, `icon pixel ${[...blue]}`);
    let white = 0;
    for (let x = 0; x < CARD_WIDTH; x++) {
      const p = icon(x, box.y1 - 30);
      if (p[3] === 255 && p[0] === 255 && p[1] === 255 && p[2] === 255) white++;
    }
    assert.ok(white > 100, `${white} white text pixels on one row`);
  });

  test('a long name shrinks, then gets an ellipsis, inside the margins', () => {
    const card = renderSplashCard({
      appName: 'IWSDK Showcase: Interaction Lab, Extended Edition with Physics',
      icon: placeholderIcon(256),
      font,
    });
    assert.equal(card.fontPx, 44);
    assert.match(card.text ?? '', /…$/);
    const box = inkBox(card.image);
    assert.ok(box.x0 >= 48 && box.x1 <= CARD_WIDTH - 48, JSON.stringify(box));
  });

  test('names the font cannot draw, or no font: the icon alone, with a warning', () => {
    for (const [appName, f] of [
      ['ショーケース', font],
      ['Showcase', null],
    ] as const) {
      const card = renderSplashCard({ appName, icon: placeholderIcon(256), font: f });
      assert.equal(card.text, null);
      assert.equal(card.warnings.length, 1);
      const box = inkBox(card.image);
      assert.ok(box.x1 - box.x0 + 1 === 256 && box.y1 - box.y0 + 1 === 256, JSON.stringify(box));
    }
    const nameOnly = renderSplashCard({ appName: 'Proto Showcase VR', icon: null, font });
    assert.equal(nameOnly.fontPx, 104);
    assert.equal(nameOnly.icon, false);
  });
});

describe('buildSplash', () => {
  test('your PNG ships byte for byte; a large one is flagged', () => {
    const png = encodePng(placeholderIcon(64));
    const file = path.join(scratch, 'splash.png');
    writeFileSync(file, png);
    const r = buildSplash({
      appName: 'x',
      iconFile: null,
      defaultIcon: null,
      imageFile: file,
      fontBytes: null,
    });
    assert.equal(r.source, 'image');
    assert.deepEqual(r.png, png);
    assert.equal(r.width, 64);
    assert.deepEqual(r.warnings, []);
    const big = path.join(scratch, 'big.png');
    writeFileSync(big, encodePng({ width: 1600, height: 8, data: new Uint8Array(1600 * 8 * 4) }));
    assert.match(
      buildSplash({ appName: 'x', iconFile: null, defaultIcon: null, imageFile: big, fontBytes: null }).warnings[0],
      /1600x8; Meta recommends at most 1500x1500/,
    );
  });

  test('a non-PNG image, or one larger than the runtime decodes, is refused', () => {
    const file = path.join(scratch, 'splash-not.png');
    writeFileSync(file, 'GIF89a');
    assert.throws(
      () => buildSplash({ appName: 'x', iconFile: null, defaultIcon: null, imageFile: file, fontBytes: null }),
      SplashError,
    );
    const huge = path.join(scratch, 'huge.png');
    writeFileSync(huge, encodePng({ width: 4097, height: 2, data: new Uint8Array(4097 * 2 * 4) }));
    assert.throws(
      () => buildSplash({ appName: 'x', iconFile: null, defaultIcon: null, imageFile: huge, fontBytes: null }),
      /4097x2; the runtime takes at most 4096 px per side/,
    );
  });

  test('generated from the configured PNG icon; a WebP icon gives the name only', () => {
    const iconFile = path.join(scratch, 'icon.png');
    const red: RgbaImage = { width: 32, height: 32, data: new Uint8Array(32 * 32 * 4) };
    for (let i = 0; i < red.data.length; i += 4) red.data.set([230, 20, 20, 255], i);
    writeFileSync(iconFile, encodePng(red));
    const r = buildSplash({
      appName: 'Red',
      iconFile,
      defaultIcon: placeholderIcon(256),
      imageFile: null,
      fontBytes: ROBOTO_BOLD,
    });
    assert.equal(r.source, 'generated');
    assert.equal(r.text, 'Red');
    const img = decodePng(r.png);
    const box = inkBox(img);
    const p = (box.y0 + 30) * img.width + CARD_WIDTH / 2;
    assert.deepEqual([...img.data.slice(p * 4, p * 4 + 4)], [230, 20, 20, 255]);
    const webp = path.join(scratch, 'icon.webp');
    writeFileSync(webp, Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), Buffer.alloc(32)]));
    const w = buildSplash({ appName: 'Red', iconFile: webp, defaultIcon: null, imageFile: null, fontBytes: ROBOTO_BOLD });
    assert.equal(w.icon, false);
    assert.equal(w.text, 'Red');
    assert.match(w.warnings.join('\n'), /icon is WebP/);
  });
});
