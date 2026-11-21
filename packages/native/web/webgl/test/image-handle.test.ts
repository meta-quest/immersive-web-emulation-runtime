/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// texImage2D from real runtime/image handles (INTEROP.md §3): runs where the image module is registered next to
// the GL module (the device runtime); skipped on the host (the Node addon has no image module).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realInstall } from './real-gl.ts';

interface ImageNatives {
  needsPolling: boolean;
  fromPixels(rgba: ArrayBufferView, w: number, h: number, premultiplied: boolean, options: object): Promise<object>;
  close(handle: object): void;
  poll(): number;
}
const image = (globalThis as { __iwn?: { image?: ImageNatives } }).__iwn?.image;
const inst = image ? realInstall() : null;
const skip = !image || !inst ? 'runtime/image natives not registered (device only)' : false;

async function settle<T>(p: Promise<T>): Promise<T> {
  if (!image!.needsPolling) return p;
  let done = false;
  void p.finally(() => (done = true));
  for (let i = 0; i < 2000 && !done; i++) {
    image!.poll();
    await new Promise((r) => setTimeout(r, 1));
  }
  return p;
}

test('GL-17 (device): texImage2D from runtime/image handles: padded rows, flags, other formats, closed', { skip }, async () => {
  type GL = Record<string, (...a: any[]) => any> & Record<string, number>;
  const gl = inst!.createContext({ width: 3, height: 2 }, 'webgl2', {}) as unknown as GL;
  // 3x2: rows are 12 bytes, stores pad them to 16 (the UNPACK_ROW_LENGTH path)
  const src = new Uint8Array([
    255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 255,
    10, 20, 30, 255, 40, 50, 60, 255, 200, 100, 50, 0,
  ]);
  const handle = await settle(image!.fromPixels(src, 3, 2, false, {}));
  const IMAGE_SOURCE = Symbol.for('iwn.image.source');
  const asImage = { [IMAGE_SOURCE]: () => ({ kind: 'handle', origin: 'image', width: 3, height: 2, premultiplied: false, handle }) };
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const read = (): number[] => {
    const px = new Uint8Array(24);
    gl.readPixels(0, 0, 3, 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [...px];
  };
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, asImage);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  assert.deepEqual(read(), [...src], 'direct upload from the store');
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, asImage);
  const flipped = read();
  assert.deepEqual(flipped.slice(0, 12), [10, 20, 30, 255, 40, 50, 60, 255, 0, 0, 0, 0], 'flipped + premultiplied');
  assert.deepEqual(flipped.slice(12, 16), [128, 0, 0, 128]);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, asImage);
  const rgb = read();
  assert.deepEqual(rgb.slice(12, 16), [10, 20, 30, 255], 'RGB via imageRead + JS conversion');
  assert.equal(gl.getError(), gl.NO_ERROR);
  image!.close(handle);
  assert.throws(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, asImage), (e: Error) => e.name === 'InvalidStateError');
  assert.equal(gl.getError(), gl.NO_ERROR);
});
