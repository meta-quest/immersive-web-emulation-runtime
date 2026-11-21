/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// IMG-6 / IMG-2: createImageBitmap argument handling, sources and option semantics (over fake natives; the native
// pixel pipeline itself is tested in runtime/image/tests).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IMAGE_SOURCE } from '../source.ts';
import { corners, dataURL, encodePng, makeGlobal, px, waitFor } from './helpers.ts';

const { g, natives } = makeGlobal();
const pngBlob = () => new Blob([encodePng(4, 4, corners())], { type: 'image/png' });
const named = (name: string) => (e: unknown) => (e as Error).name === name;
const pixelsOf = (bitmap: object) => natives.readPixels(g[Symbol.for('iwn.image')].bitmapHandle(bitmap), false);

test('Blob source decodes to an ImageBitmap', async () => {
  const bitmap = await g.createImageBitmap(pngBlob());
  assert.ok(bitmap instanceof g.ImageBitmap);
  assert.equal(bitmap.width, 4);
  assert.equal(bitmap.height, 4);
  assert.deepEqual(px(pixelsOf(bitmap), 4, 0, 0), [255, 0, 0, 128]);
  bitmap.close();
  assert.equal(bitmap.width, 0);
  assert.equal(bitmap.height, 0);
  bitmap.close(); // idempotent
});

test('options map to one native job (three.js ImageBitmapLoader options)', async () => {
  natives.calls.length = 0;
  await g.createImageBitmap(pngBlob(), {
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  assert.equal(natives.calls.length, 1);
  assert.deepEqual(natives.calls[0], {
    op: 'decode',
    options: { applyExif: true, flipY: true, alpha: 2, quality: 1 },
  });
  natives.calls.length = 0;
  await g.createImageBitmap(pngBlob(), 1, 1, 2, 2, { imageOrientation: 'none', premultiplyAlpha: 'premultiply',
    resizeWidth: 8, resizeHeight: 6, resizeQuality: 'high' });
  assert.deepEqual(natives.calls[0]!.options, {
    applyExif: false, flipY: false, alpha: 1, quality: 3, crop: [1, 1, 2, 2], resizeWidth: 8, resizeHeight: 6,
  });
});

// IMG-6: 'default' premultiplies like Chrome (Chromium's ParseOptions maps kDefault to premultiply_alpha = true).
test('every imageOrientation x premultiplyAlpha combination gives the spec pixels', async () => {
  for (const imageOrientation of ['from-image', 'flipY', 'none']) {
    for (const premultiplyAlpha of ['default', 'premultiply', 'none']) {
      const bitmap = await g.createImageBitmap(pngBlob(), { imageOrientation, premultiplyAlpha });
      const h = g[Symbol.for('iwn.image')].bitmapHandle(bitmap);
      const raw = natives.pixelsOf(h)!;
      const tl = px(raw.data, 4, 0, 0);
      const flipped = imageOrientation === 'flipY';
      const premul = premultiplyAlpha !== 'none';
      assert.deepEqual(tl, flipped ? [0, 0, premul ? 128 : 255, 128] : [premul ? 128 : 255, 0, 0, 128],
        `${imageOrientation} / ${premultiplyAlpha}`);
      assert.equal(raw.premultiplied, premul);
    }
  }
});

test('source rectangle: negative width/height flip the origin; outside is transparent', async () => {
  natives.calls.length = 0;
  const bitmap = await g.createImageBitmap(pngBlob(), 3, 3, -2, -2);
  assert.deepEqual(natives.calls[0]!.options.crop, [1, 1, 2, 2]);
  assert.equal(bitmap.width, 2);
  const outside = await g.createImageBitmap(pngBlob(), -1, -1, 2, 2);
  assert.deepEqual(px(pixelsOf(outside), 2, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(px(pixelsOf(outside), 2, 1, 1), [255, 0, 0, 128]);
});

test('one-sided resize keeps the aspect ratio (ceil)', async () => {
  const img = new g.ImageData(new Uint8ClampedArray(10 * 4 * 4), 10, 4);
  const a = await g.createImageBitmap(img, { resizeWidth: 5 });
  assert.equal(a.width, 5);
  assert.equal(a.height, 2);
  const b = await g.createImageBitmap(img, { resizeHeight: 3 });
  assert.equal(b.width, 8); // ceil(10 * 3 / 4)
  assert.equal(b.height, 3);
  const c = await g.createImageBitmap(pngBlob(), 0, 0, 3, 3, { resizeWidth: 7 });
  assert.equal(c.width, 7);
  assert.equal(c.height, 7);
  const d = await g.createImageBitmap(pngBlob(), { resizeHeight: 2 });
  assert.equal(d.width, 2);
  assert.equal(d.height, 2);
});

test('ImageData, ImageBitmap and HTMLImageElement sources', async () => {
  const data = new g.ImageData(new Uint8ClampedArray(corners()), 4, 4);
  const fromData = await g.createImageBitmap(data, { imageOrientation: 'flipY' });
  assert.deepEqual(px(pixelsOf(fromData), 4, 0, 0), [0, 0, 255, 128]);
  const fromBitmap = await g.createImageBitmap(fromData, { imageOrientation: 'flipY' });
  assert.deepEqual(px(pixelsOf(fromBitmap), 4, 0, 0), [255, 0, 0, 128]);
  const img = new g.Image();
  img.src = dataURL(encodePng(4, 4, corners()));
  await waitFor(img, 'load');
  const fromImage = await g.createImageBitmap(img);
  assert.equal(fromImage.width, 4);
  assert.deepEqual(px(pixelsOf(fromImage), 4, 3, 3), [255, 255, 0, 128]);
});

test('image-source protocol objects (canvases) are accepted', async () => {
  const canvas = {
    [IMAGE_SOURCE]: () => ({
      kind: 'pixels', origin: 'canvas', width: 1, height: 1, premultiplied: true,
      data: new Uint8ClampedArray([100, 0, 0, 128]),
    }),
  };
  const bitmap = await g.createImageBitmap(canvas, { premultiplyAlpha: 'none' });
  assert.deepEqual(px(pixelsOf(bitmap), 1, 0, 0), [199, 0, 0, 128]);
  const empty = { [IMAGE_SOURCE]: () => ({ kind: 'pixels', origin: 'canvas', width: 0, height: 0, premultiplied: true, data: new Uint8ClampedArray(0) }) };
  await assert.rejects(g.createImageBitmap(empty), named('InvalidStateError'));
});

test('pixel descriptors with unsafe sizes are rejected before native code sees them', async () => {
  const provider = (width: number, height: number, data: unknown) => ({
    [IMAGE_SOURCE]: () => ({ kind: 'pixels', origin: 'canvas', width, height, premultiplied: false, data }),
  });
  // 2^31 x 2^31 x 4 wraps to 0 in 64-bit arithmetic: the native overflow case the size check must not let through.
  const wrap = 2 ** 31;
  await assert.rejects(g.createImageBitmap(provider(wrap, wrap, new Uint8Array(0))), named('InvalidStateError'));
  await assert.rejects(g.createImageBitmap(provider(32769, 1, new Uint8Array(32769 * 4))), named('InvalidStateError'));
  await assert.rejects(g.createImageBitmap(provider(1.5, 2, new Uint8Array(12))), named('InvalidStateError'));
  await assert.rejects(g.createImageBitmap(provider(2, 2, new Uint8Array(15))), named('InvalidStateError'));
  await assert.rejects(g.createImageBitmap(provider(2, 2, [1, 2, 3])), named('InvalidStateError'));
  const ok = await g.createImageBitmap(provider(2, 2, new Uint8Array(16).fill(255)));
  assert.equal(ok.width, 2);
});

test('argument errors reject (never throw synchronously)', async () => {
  const blob = pngBlob();
  const p = g.createImageBitmap(blob, 0, 0, 0, 1);
  assert.ok(p instanceof Promise);
  await assert.rejects(p, RangeError);
  await assert.rejects(g.createImageBitmap(blob, 0, 0, 1, 0), RangeError);
  await assert.rejects(g.createImageBitmap(blob, { resizeWidth: 0 }), named('InvalidStateError'));
  await assert.rejects(g.createImageBitmap(blob, { resizeHeight: -1 }), TypeError);
  await assert.rejects(g.createImageBitmap(blob, { imageOrientation: 'upside-down' }), TypeError);
  await assert.rejects(g.createImageBitmap(blob, { premultiplyAlpha: 'yes' }), TypeError);
  await assert.rejects(g.createImageBitmap(blob, { resizeQuality: 'best' }), TypeError);
  await assert.rejects(g.createImageBitmap(blob, 1, 2), TypeError);
  await assert.rejects(g.createImageBitmap(), TypeError);
  await assert.rejects(g.createImageBitmap({}), TypeError);
  await assert.rejects(g.createImageBitmap('x.png'), TypeError);
  await assert.rejects(g.createImageBitmap({ videoWidth: 1 }), TypeError);
});

test('unusable sources reject with InvalidStateError', async () => {
  await assert.rejects(g.createImageBitmap(new Blob([new Uint8Array([1, 2, 3])])), named('InvalidStateError'));
  const truncated = encodePng(4, 4, corners()).subarray(0, 40);
  await assert.rejects(g.createImageBitmap(new Blob([truncated])), named('InvalidStateError'));
  const closed = await g.createImageBitmap(pngBlob());
  closed.close();
  await assert.rejects(g.createImageBitmap(closed), named('InvalidStateError'));
  const pending = new g.Image();
  await assert.rejects(g.createImageBitmap(pending), named('InvalidStateError'));
  const broken = new g.Image();
  broken.src = 'data:image/png;base64,AAAA';
  await waitFor(broken, 'error');
  await assert.rejects(g.createImageBitmap(broken), named('InvalidStateError'));
});

test('native failures on transforms reject with InvalidStateError', async () => {
  const failing = { ...natives, transform: () => Promise.reject(Object.assign(new Error('x'), { code: 'too-large' })) };
  const { g: g2 } = makeGlobal({ natives: failing as never });
  const real = await g2.createImageBitmap(new Blob([encodePng(4, 4, corners())]));
  await assert.rejects(g2.createImageBitmap(real), named('InvalidStateError'));
});

test('ImageBitmap cannot be constructed and reports its brand', () => {
  assert.throws(() => new g.ImageBitmap(), TypeError);
  assert.equal(Object.prototype.toString.call(g.ImageBitmap.prototype), '[object ImageBitmap]');
});

test("premultiplyAlpha 'default' premultiplies for every source kind, like Chrome", async () => {
  const id = new g.ImageData(new Uint8ClampedArray([200, 100, 50, 128]), 1, 1);
  for (const source of [pngBlob(), id]) {
    const bitmap = await g.createImageBitmap(source);
    const raw = natives.pixelsOf(g[Symbol.for('iwn.image')].bitmapHandle(bitmap))!;
    assert.equal(raw.premultiplied, true);
    const straight = await g.createImageBitmap(source, { premultiplyAlpha: 'none' });
    assert.equal(natives.pixelsOf(g[Symbol.for('iwn.image')].bitmapHandle(straight))!.premultiplied, false);
  }
  const fromBitmap = await g.createImageBitmap(await g.createImageBitmap(id, { premultiplyAlpha: 'none' }));
  assert.equal(natives.pixelsOf(g[Symbol.for('iwn.image')].bitmapHandle(fromBitmap))!.premultiplied, true);
  assert.deepEqual([...natives.pixelsOf(g[Symbol.for('iwn.image')].bitmapHandle(fromBitmap))!.data], [100, 50, 25, 128]);
});
