/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// IMG-4 / NET-12 / NET-14: HTMLImageElement loading through data:, blob: and fetch URLs; events, decode(), states.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IMAGE_SOURCE } from '../source.ts';
import {
  corners,
  dataURL,
  encodePng,
  makeGlobal,
  nextTask,
  waitFor,
} from './helpers.ts';

const png = encodePng(4, 4, corners());
const png2 = encodePng(2, 3, new Uint8Array(24).fill(200));

function fetchStub(
  routes: Record<string, Uint8Array | number>,
  seen: string[] = [],
) {
  return async (url: string) => {
    seen.push(url);
    const r = routes[url];
    if (r === undefined) throw new TypeError('Failed to fetch');
    if (typeof r === 'number')
      return {
        ok: false,
        status: r,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => r.slice().buffer,
    };
  };
}

test('Image() and HTMLImageElement identity', () => {
  const { g } = makeGlobal();
  const img = new g.Image(10, 20);
  assert.ok(img instanceof g.HTMLImageElement);
  assert.equal(img instanceof EventTarget, true);
  assert.equal(g.Image.prototype, g.HTMLImageElement.prototype);
  assert.throws(() => new g.HTMLImageElement(), TypeError);
  assert.equal(img.width, 10);
  assert.equal(img.height, 20);
  assert.equal(img.getAttribute('width'), '10');
  assert.equal(img.tagName, 'IMG');
  assert.equal(img.complete, true);
  assert.equal(img.naturalWidth, 0);
  assert.equal(
    Object.prototype.toString.call(img),
    '[object HTMLImageElement]',
  );
});

test('data: URL loads asynchronously and fires load once', async () => {
  const { g } = makeGlobal();
  const img = new g.Image();
  const events: string[] = [];
  img.onload = () => events.push('onload');
  img.addEventListener('load', () => events.push('listener'));
  img.src = dataURL(png);
  assert.equal(img.complete, false);
  assert.deepEqual(events, []);
  await waitFor(img, 'load');
  await nextTask();
  assert.deepEqual(events, ['onload', 'listener']);
  assert.equal(img.naturalWidth, 4);
  assert.equal(img.naturalHeight, 4);
  assert.equal(img.width, 4);
  assert.equal(img.complete, true);
  assert.ok(img.currentSrc.startsWith('data:image/png'));
  await img.decode();
});

test('fetch-backed src resolves against the base URL; 404 and network errors fire error', async () => {
  const seen: string[] = [];
  const { g } = makeGlobal({
    fetch: fetchStub(
      {
        'https://app.local/tex/a.png': png,
        'https://app.local/missing.png': 404,
      },
      seen,
    ),
  });
  const ok = new g.Image();
  ok.src = 'tex/a.png';
  assert.equal(ok.src, 'https://app.local/tex/a.png');
  await waitFor(ok, 'load');
  assert.equal(ok.naturalWidth, 4);
  const missing = new g.Image();
  missing.src = '/missing.png';
  await waitFor(missing, 'error');
  assert.equal(missing.complete, true);
  assert.equal(missing.naturalWidth, 0);
  const blocked = new g.Image();
  blocked.src = 'https://not-allowed.example/x.png';
  await waitFor(blocked, 'error');
  assert.deepEqual(seen, [
    'https://app.local/tex/a.png',
    'https://app.local/missing.png',
    'https://not-allowed.example/x.png',
  ]);
  await assert.rejects(
    missing.decode(),
    (e: Error) => e.name === 'EncodingError',
  );
});

test('blob: URLs resolve through the blob URL store; revoked ones fail', async () => {
  const store = new Map<string, Uint8Array>([
    ['blob:https://app.local/1234', png],
  ]);
  const { g } = makeGlobal({
    resolveBlobURL: (url) =>
      store.has(url) ? { bytes: store.get(url)!, type: 'image/png' } : null,
  });
  const img = new g.Image();
  img.src = 'blob:https://app.local/1234';
  await waitFor(img, 'load');
  assert.equal(img.naturalWidth, 4);
  store.clear();
  const revoked = new g.Image();
  revoked.src = 'blob:https://app.local/1234';
  await waitFor(revoked, 'error');
});

test('setting src while a load is pending: only the newest fires', async () => {
  const { g } = makeGlobal();
  const img = new g.Image();
  const events: string[] = [];
  img.addEventListener('load', () =>
    events.push(`load ${img.naturalWidth}x${img.naturalHeight}`),
  );
  img.addEventListener('error', () => events.push('error'));
  img.src = dataURL(png);
  const firstDecode = img.decode();
  img.src = dataURL(png2);
  await assert.rejects(firstDecode, (e: Error) => e.name === 'EncodingError');
  await waitFor(img, 'load');
  for (let i = 0; i < 5; i++) await nextTask();
  assert.deepEqual(events, ['load 2x3']);
});

test('empty src fires error; removing src makes the element complete and empty', async () => {
  const { g } = makeGlobal();
  const img = new g.Image();
  img.src = '';
  await waitFor(img, 'error');
  assert.equal(img.complete, true);
  img.src = dataURL(png);
  await waitFor(img, 'load');
  img.removeAttribute('src');
  assert.equal(img.naturalWidth, 0);
  assert.equal(img.complete, true);
  assert.equal(img.src, '');
});

test('decode() resolves after load and rejects for broken images', async () => {
  const { g } = makeGlobal();
  const img = new g.Image();
  img.src = dataURL(png);
  await img.decode();
  assert.equal(img.naturalWidth, 4);
  const bad = new g.Image();
  bad.src = 'data:image/png;base64,AAAA';
  await assert.rejects(bad.decode(), (e: Error) => e.name === 'EncodingError');
  const none = new g.Image();
  await assert.rejects(none.decode(), (e: Error) => e.name === 'EncodingError');
});

test('reflected attributes: crossOrigin stored, setAttribute(src) loads', async () => {
  const { g } = makeGlobal();
  const img = new g.Image();
  assert.equal(img.crossOrigin, null);
  img.crossOrigin = 'anonymous';
  assert.equal(img.crossOrigin, 'anonymous');
  img.crossOrigin = 'USE-CREDENTIALS';
  assert.equal(img.crossOrigin, 'use-credentials');
  img.crossOrigin = 'junk';
  assert.equal(img.crossOrigin, 'anonymous');
  assert.equal(img.decoding, 'auto');
  img.decoding = 'async';
  assert.equal(img.decoding, 'async');
  img.alt = 'pic';
  assert.equal(img.getAttribute('alt'), 'pic');
  img.setAttribute('src', dataURL(png));
  await waitFor(img, 'load');
  assert.equal(img.naturalWidth, 4);
});

test('image-source protocol: unloaded and broken images throw InvalidStateError', async () => {
  const { g } = makeGlobal();
  const img = new g.Image();
  assert.throws(
    () => img[IMAGE_SOURCE](),
    (e: Error) => e.name === 'InvalidStateError',
  );
  img.src = dataURL(png);
  await waitFor(img, 'load');
  const d = img[IMAGE_SOURCE]();
  assert.equal(d.kind, 'handle');
  assert.equal(d.origin, 'image');
  assert.equal(d.width, 4);
  assert.equal(d.premultiplied, false);
});

test('a replaced image frees its pixels', async () => {
  const { g, natives } = makeGlobal();
  const img = new g.Image();
  img.src = dataURL(png);
  await waitFor(img, 'load');
  const before = natives.stats().handles;
  img.src = dataURL(png2);
  await waitFor(img, 'load');
  assert.equal(natives.stats().handles, before);
});

test('data: URLs: the setter does no work; base64 is decoded natively off the JS thread (REG-16)', async () => {
  let resolved = 0; // URL resolution happens in the load, after the setter returned
  const { g, natives } = makeGlobal({
    baseURL: () => {
      resolved++;
      return 'https://app.local/';
    },
  });
  const img = new g.Image();
  natives.calls.length = 0;
  img.src = '  ' + dataURL(png).replace('data:', 'DATA:') + '\n';
  assert.equal(natives.calls.length, 0); // nothing parsed or submitted inside the setter
  assert.equal(resolved, 0);
  assert.ok(img.src.startsWith('data:image/png;base64,'));
  await waitFor(img, 'load');
  assert.deepEqual(
    natives.calls.map((c) => c.op),
    ['decodeBase64'],
  );
  assert.equal(img.naturalWidth, 4);
  assert.ok(img.currentSrc.startsWith('data:image/png;base64,'));
  // Invalid base64 fires error; percent-encoded base64 takes the JS path.
  const bad = new g.Image();
  bad.src = 'data:image/png;base64,@@@@';
  await waitFor(bad, 'error');
  natives.calls.length = 0;
  const pct = new g.Image();
  pct.src = dataURL(png).replace(/=/g, '%3D');
  await waitFor(pct, 'load');
  assert.deepEqual(
    natives.calls.map((c) => c.op),
    ['decode'],
  );
});

test('a superseded load cancels its native decode', async () => {
  const { g, natives } = makeGlobal();
  const img = new g.Image();
  const events: string[] = [];
  img.addEventListener('load', () => events.push(`load ${img.naturalWidth}`));
  img.src = dataURL(png);
  for (let i = 0; i < 20 && natives.calls.length === 0; i++)
    await Promise.resolve();
  assert.equal(natives.calls.length, 1); // the first decode is in flight (submitted within the same task)
  img.src = dataURL(png2);
  assert.equal(natives.cancelled, 1);
  await waitFor(img, 'load');
  for (let i = 0; i < 3; i++) await nextTask();
  assert.deepEqual(events, ['load 2']);
  assert.equal(natives.stats().handles, 1);
});

test('while a new src loads, the previous image stays the current request', async () => {
  const { g } = makeGlobal({
    fetch: async (url: string) => {
      await new Promise((r) => setTimeout(r, 5));
      if (url.endsWith('missing.png'))
        return {
          ok: false,
          status: 404,
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => png2.slice().buffer,
      };
    },
  });
  const img = new g.Image();
  img.src = dataURL(png);
  await waitFor(img, 'load');
  const firstSrc = img.currentSrc;
  img.src = 'b.png';
  assert.equal(img.naturalWidth, 4); // HTML: the current request is still the 4x4 image
  assert.equal(img.complete, false);
  assert.equal(img.currentSrc, firstSrc);
  assert.equal(img[IMAGE_SOURCE]().width, 4);
  const bitmap = await g.createImageBitmap(img);
  assert.equal(bitmap.width, 4);
  await waitFor(img, 'load');
  assert.equal(img.naturalWidth, 2);
  assert.equal(img.complete, true);
  assert.equal(img.currentSrc, 'https://app.local/b.png');
  // A failing new src replaces the current image with a broken one.
  img.src = 'missing.png';
  assert.equal(img.naturalWidth, 2);
  await waitFor(img, 'error');
  assert.equal(img.naturalWidth, 0);
  assert.equal(img.complete, true);
  assert.throws(
    () => img[IMAGE_SOURCE](),
    (e: Error) => e.name === 'InvalidStateError',
  );
});
