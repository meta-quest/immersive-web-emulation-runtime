/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Element draws that would read past the end of the element buffer are INVALID_OPERATION and never reach the driver
// (WebGL 2 §5.13.11): the context is not robust, so the driver would otherwise read out of bounds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWebGL } from '../install.ts';
import { createFakeNatives } from './fake-natives.ts';

const g = {} as Record<string, unknown>;
const fake = createFakeNatives();
const inst = installWebGL(g, fake.natives);
type GL = Record<string, Function> & Record<string, number>;
function call(gl: GL, name: string, ...args: unknown[]): unknown {
  return gl[name].apply(gl, args);
}

test('element draws past the end of the element buffer are INVALID_OPERATION', () => {
  const gl = inst.createContext(
    { width: 16, height: 16 },
    'webgl2',
  ) as unknown as GL;
  const eb = call(gl, 'createBuffer');
  call(gl, 'bindBuffer', gl.ELEMENT_ARRAY_BUFFER, eb);
  call(
    gl,
    'bufferData',
    gl.ELEMENT_ARRAY_BUFFER,
    new Uint16Array(6),
    gl.STATIC_DRAW,
  ); // 12 bytes
  call(gl, 'getError');
  fake.reset();
  const cases: Array<[string, ...unknown[]]> = [
    ['drawElements', gl.TRIANGLES, 7, gl.UNSIGNED_SHORT, 0],
    ['drawElements', gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 2],
    ['drawElements', gl.TRIANGLES, 3, gl.UNSIGNED_INT, 4],
    ['drawElementsInstanced', gl.TRIANGLES, 7, gl.UNSIGNED_SHORT, 0, 2],
    ['drawRangeElements', gl.TRIANGLES, 0, 5, 7, gl.UNSIGNED_SHORT, 0],
  ];
  for (const [name, ...a] of cases) {
    call(gl, name, ...a);
    assert.equal(
      call(gl, 'getError'),
      gl.INVALID_OPERATION,
      `${name}(${a.join(', ')})`,
    );
  }
  for (const name of [
    'drawElements',
    'drawElementsInstanced',
    'drawRangeElements',
  ]) {
    assert.equal(fake.calls.get(name) ?? 0, 0, `${name} reached the driver`);
  }
  // In range, including draws that end exactly at the end of the buffer, passes the element check (the draw itself
  // still needs a program, which this test does not set up).
  assert.equal(
    call(gl, '_elementsCheck', 6, gl.UNSIGNED_SHORT, 0, 'drawElements'),
    true,
  );
  assert.equal(
    call(gl, '_elementsCheck', 0, gl.UNSIGNED_SHORT, 12, 'drawElements'),
    true,
  );
  assert.equal(
    call(gl, '_elementsCheck', 3, gl.UNSIGNED_INT, 0, 'drawElements'),
    true,
  );
});
