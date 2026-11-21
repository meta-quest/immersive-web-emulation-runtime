/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// XR-DEPTH-2 host hook: clearSessionFramebuffer clears colour 0 / depth / stencil of a framebuffer whatever the
// app's masks and scissor, and leaves the GL state and the binding's cache as the app had them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWebGL } from '../install.ts';
import { clearSessionFramebuffer } from '../host.ts';
import type { Ctx } from '../core.ts';
import type { WebGLFramebuffer } from '../objects.ts';
import { createFakeNatives } from './fake-natives.ts';

const g = {} as Record<string, unknown>;
const fake = createFakeNatives();
const inst = installWebGL(g, fake.natives);
type GL = Record<string, Function> & Record<string, number>;
const call = (gl: GL, name: string, ...args: unknown[]): unknown => gl[name].apply(gl, args);

function setup(depthStencil: boolean) {
  const gl = inst.createContext({ width: 16, height: 16 }, 'webgl2') as unknown as GL;
  const fb = call(gl, 'createFramebuffer');
  const tex = call(gl, 'createTexture');
  call(gl, 'bindTexture', gl.TEXTURE_2D, tex);
  call(gl, 'texStorage2D', gl.TEXTURE_2D, 1, gl.RGBA8, 16, 16);
  call(gl, 'bindFramebuffer', gl.FRAMEBUFFER, fb);
  call(gl, 'framebufferTexture2D', gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const rb = call(gl, 'createRenderbuffer');
  call(gl, 'bindRenderbuffer', gl.RENDERBUFFER, rb);
  call(gl, 'renderbufferStorage', gl.RENDERBUFFER, depthStencil ? gl.DEPTH24_STENCIL8 : gl.DEPTH_COMPONENT24, 16, 16);
  call(gl, 'framebufferRenderbuffer', gl.FRAMEBUFFER, depthStencil ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  // the app's state: another framebuffer bound, masks off, scissor on
  const other = call(gl, 'createFramebuffer');
  call(gl, 'bindFramebuffer', gl.FRAMEBUFFER, other);
  call(gl, 'colorMask', true, false, true, false);
  call(gl, 'depthMask', false);
  call(gl, 'stencilMaskSeparate', gl.FRONT, 0x0f);
  call(gl, 'stencilMaskSeparate', gl.BACK, 0x30);
  call(gl, 'enable', gl.SCISSOR_TEST);
  call(gl, 'enable', gl.RASTERIZER_DISCARD);
  return { gl, fb: fb as WebGLFramebuffer, other };
}

test('XR-DEPTH-2: clearSessionFramebuffer clears colour, depth and stencil and restores the app state', () => {
  const { gl, fb, other } = setup(true);
  fake.reset();
  fake.logging = true;
  clearSessionFramebuffer(gl as unknown as Ctx, fb);
  fake.logging = false;
  const names = fake.log.map((c) => c[0]);
  assert.ok(names.includes('clearBufferfv'), names.join(' '));
  assert.ok(fake.log.some((c) => c[0] === 'clearBufferfv' && c[1] === gl.COLOR));
  assert.ok(fake.log.some((c) => c[0] === 'clearBufferfi' && c[1] === gl.DEPTH_STENCIL && c[3] === 1 && c[4] === 0));
  // masks and scissor opened for the clear, then put back as the app had them
  const scissor = fake.log.filter((c) => c[1] === gl.SCISSOR_TEST).map((c) => c[0]);
  assert.deepEqual(scissor, ['disable', 'enable']);
  const masks = fake.log.filter((c) => c[0] === 'colorMask');
  assert.deepEqual(masks.at(-1)!.slice(1), [true, false, true, false]);
  assert.deepEqual(fake.log.filter((c) => c[0] === 'depthMask').at(-1)!.slice(1), [false]);
  // the stencil write masks (each face its own) and rasterizer discard: opened for the clear, put back after
  const stencil = fake.log.filter((c) => c[0] === 'stencilMaskSeparate').map((c) => [c[1], (c[2] as number) >>> 0]);
  assert.deepEqual(stencil, [[gl.FRONT_AND_BACK, 0xffffffff], [gl.FRONT, 0x0f], [gl.BACK, 0x30]]);
  const discard = fake.log.filter((c) => c[1] === gl.RASTERIZER_DISCARD).map((c) => c[0]);
  assert.deepEqual(discard, ['disable', 'enable']);
  assert.equal(call(gl, 'isEnabled', gl.RASTERIZER_DISCARD), true);
  assert.equal(call(gl, 'getParameter', gl.STENCIL_WRITEMASK), 0x0f);
  assert.equal(call(gl, 'getParameter', gl.STENCIL_BACK_WRITEMASK), 0x30);
  // the app's framebuffer is bound again, and the cache still answers with the app's state
  const lastBind = fake.log.filter((c) => c[0] === 'bindFramebuffer').at(-1)!;
  assert.equal(lastBind[2], (other as WebGLFramebuffer)._name);
  assert.deepEqual(call(gl, 'getParameter', gl.COLOR_WRITEMASK), [true, false, true, false]);
  assert.equal(call(gl, 'getParameter', gl.DEPTH_WRITEMASK), false);
  assert.equal(call(gl, 'isEnabled', gl.SCISSOR_TEST), true);
});

test('XR-DEPTH-2: depth without stencil is cleared to 1 alone', () => {
  const { gl, fb } = setup(false);
  fake.reset();
  fake.logging = true;
  clearSessionFramebuffer(gl as unknown as Ctx, fb);
  fake.logging = false;
  assert.ok(fake.log.some((c) => c[0] === 'clearBufferfv' && c[1] === gl.DEPTH));
  assert.ok(!fake.log.some((c) => c[0] === 'clearBufferfi' || c[0] === 'clearBufferiv'));
});
