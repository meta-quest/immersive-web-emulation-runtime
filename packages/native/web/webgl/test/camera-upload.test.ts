/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// GL-17 / XR-CAM-1 with the call recorder: texSubImage2D from native pixels (a camera <video> frame) goes to
// imageUpload, whose GPU copy is a blit that clips without an error, so the binding refuses what does not fit the
// level (INVALID_VALUE) before it gets there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWebGL } from '../install.ts';
import { createFakeNatives } from './fake-natives.ts';

const fake = createFakeNatives();
const uploads: number[][] = [];
(fake.natives as unknown as Record<string, unknown>).imageUpload = (...a: unknown[]): boolean => {
  uploads.push([a[4], a[5], a[7]] as number[]); // xoffset, yoffset, mode
  return true;
};
const inst = installWebGL({} as Record<string, unknown>, fake.natives);
type GL = Record<string, Function> & Record<string, number>;
const call = (gl: GL, name: string, ...args: unknown[]): unknown => gl[name].apply(gl, args);
const IMAGE_SOURCE = Symbol.for('iwn.image.source');
const frame = (width: number, height: number) => ({
  [IMAGE_SOURCE]: () => ({ kind: 'handle', origin: 'video', handle: {}, width, height, premultiplied: false }),
});

test('GL-17 / XR-CAM-1: texSubImage2D of native pixels outside the level is INVALID_VALUE, not a clipped copy', () => {
  for (const kind of ['webgl2', 'webgl'] as const) {
    const gl = inst.createContext({ width: 4, height: 4 }, kind) as unknown as GL;
    const errors = (): number[] => {
      const out: number[] = [];
      for (let e = call(gl, 'getError') as number; e; e = call(gl, 'getError') as number) out.push(e);
      return out;
    };
    call(gl, 'bindTexture', gl.TEXTURE_2D, call(gl, 'createTexture'));
    call(gl, 'texImage2D', gl.TEXTURE_2D, 0, gl.RGBA, 4, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    uploads.length = 0;
    const sub = (x: number, y: number, w: number, h: number): number[] => {
      call(gl, 'texSubImage2D', gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, frame(w, h));
      return errors();
    };
    assert.deepEqual(sub(0, 0, 8, 8), [gl.INVALID_VALUE], `${kind}: larger than the 4x2 level`);
    assert.deepEqual(sub(-1, 0, 2, 2), [gl.INVALID_VALUE], `${kind}: a negative offset`);
    assert.deepEqual(sub(3, 0, 2, 2), [gl.INVALID_VALUE], `${kind}: past the right edge`);
    assert.deepEqual(sub(0, 1, 2, 2), [gl.INVALID_VALUE], `${kind}: past the top`);
    assert.deepEqual(uploads, [], `${kind}: nothing reached imageUpload`);
    assert.deepEqual(sub(2, 0, 2, 2), [], kind);
    assert.deepEqual(sub(0, 0, 4, 2), [], kind);
    assert.deepEqual(uploads, [[2, 0, 1], [0, 0, 1]], `${kind}: what fits is copied in place (mode 1)`);
  }
});
