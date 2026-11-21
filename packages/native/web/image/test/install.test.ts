/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Installation, the image registry, the GL/canvas source helper (GL-17) and clone/transfer hooks (WRK-5).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeImageNatives } from '../fake-natives.ts';
import { installImage } from '../install.ts';
import { getImageSource } from '../tex-source.ts';
import { corners, encodePng, makeGlobal, px } from './helpers.ts';

test('window install defines the globals as non-enumerable, writable properties', () => {
  const { g } = makeGlobal();
  for (const name of ['ImageData', 'ImageBitmap', 'createImageBitmap', 'HTMLImageElement', 'Image']) {
    const d = Object.getOwnPropertyDescriptor(g, name)!;
    assert.ok(d, name);
    assert.equal(d.enumerable, false);
    assert.equal(d.writable, true);
  }
  const registry = g[Symbol.for('iwn.image')];
  assert.equal(registry.version, 1);
  assert.equal(typeof registry.createImageElement, 'function');
  const el = registry.createImageElement();
  assert.ok(el instanceof g.HTMLImageElement);
});

test('worker install has no Image / HTMLImageElement (WRK-2)', () => {
  const g: any = Object.create(globalThis);
  g.importScripts = () => {};
  const registry = installImage(g as typeof globalThis, { natives: createFakeImageNatives() });
  assert.equal(Object.getOwnPropertyDescriptor(g, 'Image'), undefined);
  assert.equal(Object.getOwnPropertyDescriptor(g, 'HTMLImageElement'), undefined);
  assert.equal(typeof g.createImageBitmap, 'function');
  assert.equal(registry.createImageElement, undefined);
});

test('installation fails clearly without the native module', () => {
  const g = Object.create(globalThis) as typeof globalThis;
  assert.throws(() => installImage(g), /__iwn\.image is missing/);
});

test('getImageSource: descriptors and GL-17 errors', async () => {
  const { g } = makeGlobal();
  const bitmap = await g.createImageBitmap(new Blob([encodePng(4, 4, corners())]));
  const d = getImageSource(bitmap);
  assert.equal(d.kind, 'handle');
  assert.equal(d.origin, 'bitmap');
  assert.equal(d.width, 4);
  bitmap.close();
  assert.throws(() => getImageSource(bitmap), (e: Error) => e.name === 'InvalidStateError');
  assert.throws(() => getImageSource(new g.Image()), (e: Error) => e.name === 'InvalidStateError');
  assert.throws(() => getImageSource({ videoWidth: 2, videoHeight: 2 }), TypeError);
  assert.throws(() => getImageSource({}), TypeError);
  // XR-CAM-1: a <video> playing a camera stream is a provider of its newest frame (web/dom)
  const frame = { kind: 'pixels', origin: 'video', width: 2, height: 1, premultiplied: false, data: new Uint8Array(8) };
  const playing = { videoWidth: 2, videoHeight: 1, [Symbol.for('iwn.image.source')]: () => frame };
  assert.equal(getImageSource(playing, 'drawImage'), frame);
  const bitmapOfVideo = await g.createImageBitmap(playing);
  assert.equal(bitmapOfVideo.width, 2);
  bitmapOfVideo.close();
  const data = getImageSource(new g.ImageData(2, 1));
  assert.equal(data.kind, 'pixels');
});

test('clone and transfer hooks', async () => {
  const { g, natives } = makeGlobal();
  const registry = g[Symbol.for('iwn.image')];
  const bitmap = await g.createImageBitmap(new Blob([encodePng(4, 4, corners())]));
  const copy = registry.clone.cloneBitmap(bitmap);
  bitmap.close();
  assert.equal(copy.width, 4);
  const moved = registry.clone.transferBitmap(copy);
  assert.equal(copy.width, 0);
  assert.equal(moved.width, 4);
  assert.throws(() => registry.clone.transferBitmap(copy), (e: Error) => e.name === 'DataCloneError');
  const token = registry.clone.exportBitmap(moved);
  assert.equal(moved.width, 0);
  assert.equal(natives.stats().parked, 1);
  const back = registry.clone.importBitmap(token);
  assert.equal(back.width, 4);
  assert.deepEqual(px(natives.readPixels(registry.bitmapHandle(back), false), 4, 0, 0), [255, 0, 0, 128]);
  assert.throws(() => registry.clone.importBitmap(token), (e: Error) => e.name === 'DataCloneError');
  const data = new g.ImageData(new Uint8ClampedArray([1, 2, 3, 4]), 1);
  const dataCopy = registry.clone.cloneImageData(data);
  assert.notEqual(dataCopy.data, data.data);
  assert.deepEqual([...dataCopy.data], [1, 2, 3, 4]);
});

test('polling-mode natives are polled until promises settle', async () => {
  const fake = createFakeImageNatives();
  let polls = 0;
  const queue: (() => void)[] = [];
  const natives = {
    ...fake,
    needsPolling: true,
    decode: (b: ArrayBuffer | ArrayBufferView, o: object) =>
      new Promise((resolve, reject) => queue.push(() => fake.decode(b, o).then(resolve, reject))),
    poll: () => {
      polls++;
      const n = queue.length;
      queue.splice(0).forEach((f) => f());
      return n;
    },
  };
  const g: any = Object.create(globalThis);
  installImage(g as typeof globalThis, { natives: natives as never, worker: true });
  const bitmap = await g.createImageBitmap(new Blob([encodePng(4, 4, corners())]));
  assert.equal(bitmap.width, 4);
  assert.ok(polls >= 1);
});
