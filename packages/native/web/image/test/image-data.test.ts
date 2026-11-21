/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// IMG-5: ImageData constructors and validation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IMAGE_SOURCE } from '../source.ts';
import { makeGlobal } from './helpers.ts';

const { g } = makeGlobal();
const ImageData = g.ImageData;
const named = (name: string) => (e: unknown) => (e as Error).name === name;

test('ImageData(w, h) allocates zeroed RGBA', () => {
  const d = new ImageData(3, 2);
  assert.equal(d.width, 3);
  assert.equal(d.height, 2);
  assert.ok(d.data instanceof Uint8ClampedArray);
  assert.equal(d.data.length, 24);
  assert.ok(d.data.every((v: number) => v === 0));
  assert.equal(d.colorSpace, 'srgb');
  assert.equal(d.pixelFormat, 'rgba-unorm8');
  assert.equal(Object.prototype.toString.call(d), '[object ImageData]');
});

test('ImageData(data, w[, h]) wraps the array without copying', () => {
  const data = new Uint8ClampedArray(4 * 6);
  const d = new ImageData(data, 2);
  assert.equal(d.height, 3);
  assert.equal(d.data, data);
  assert.equal(new ImageData(data, 3, 2).height, 2);
  assert.equal(
    new ImageData(data, 2, 3, { colorSpace: 'display-p3' }).colorSpace,
    'display-p3',
  );
});

test('ImageData validation errors follow the spec', () => {
  assert.throws(() => new ImageData(0, 1), named('IndexSizeError'));
  assert.throws(() => new ImageData(1, 0), named('IndexSizeError'));
  assert.throws(
    () => new ImageData(new Uint8ClampedArray(0), 1),
    named('InvalidStateError'),
  );
  assert.throws(
    () => new ImageData(new Uint8ClampedArray(6), 1),
    named('InvalidStateError'),
  );
  assert.throws(
    () => new ImageData(new Uint8ClampedArray(12), 2),
    named('IndexSizeError'),
  );
  assert.throws(
    () => new ImageData(new Uint8ClampedArray(16), 2, 3),
    named('IndexSizeError'),
  );
  assert.throws(
    () => new ImageData(new Uint8ClampedArray(16), 0),
    named('IndexSizeError'),
  );
  assert.throws(() => new ImageData(new Uint8Array(16), 2), TypeError);
  // WebIDL: no [AllowResizable] / [AllowShared] on the constructor.
  const resizable = new ArrayBuffer(16, { maxByteLength: 64 });
  assert.throws(
    () => new ImageData(new Uint8ClampedArray(resizable), 2, 2),
    TypeError,
  );
  assert.throws(
    () => new ImageData(new Uint8ClampedArray(new SharedArrayBuffer(16)), 2, 2),
    TypeError,
  );
  assert.equal(
    new ImageData(new Uint8ClampedArray(new ArrayBuffer(16)), 2, 2).width,
    2,
  );
  assert.throws(() => new ImageData(2), TypeError);
  assert.throws(
    () => new ImageData(1, 1, { colorSpace: 'rec2020' }),
    TypeError,
  );
  assert.throws(() => new ImageData(70000, 70000), RangeError);
});

test('ImageData is an image source with straight alpha', () => {
  const d = new ImageData(2, 2);
  const desc = d[IMAGE_SOURCE]();
  assert.equal(desc.kind, 'pixels');
  assert.equal(desc.origin, 'imagedata');
  assert.equal(desc.premultiplied, false);
  assert.equal(desc.data, d.data);
  structuredClone(d.data.buffer, { transfer: [d.data.buffer] });
  assert.throws(() => d[IMAGE_SOURCE](), named('InvalidStateError'));
});
