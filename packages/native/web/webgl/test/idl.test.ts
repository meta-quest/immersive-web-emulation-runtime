/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// GL-1 / GL-2 / GL-5 checks that need no driver (fake natives): the interfaces generated from the WebGL IDL
// are complete (every operation with its WebIDL length, every constant, every attribute), not constructible,
// instanceof holds, objects keep identity, context attributes report what was provided.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDL } from '../gen/idl.gen.ts';
import { installWebGL } from '../install.ts';
import { createFakeNatives } from './fake-natives.ts';

const g = {} as Record<string, unknown>;
const fake = createFakeNatives();
const inst = installWebGL(g, fake.natives);

for (const name of ['WebGL2RenderingContext', 'WebGLRenderingContext'] as const) {
  test(`${name}: every IDL operation, constant and attribute exists (GL-1)`, () => {
    const ctor = g[name] as { prototype: Record<string, unknown> } & Record<string, unknown>;
    const proto = ctor.prototype;
    const shape = IDL[name];
    const missing: string[] = [];
    for (const [op, length] of shape.ops) {
      const fn = proto[op] as Function | undefined;
      if (typeof fn !== 'function') missing.push(op);
      else assert.equal(fn.length, length, `${name}.${op}.length`);
    }
    assert.deepEqual(missing, []);
    for (const [c, v] of shape.consts) {
      assert.equal(proto[c], v, `${name}.prototype.${c}`);
      assert.equal(ctor[c], v, `${name}.${c}`);
    }
    for (const [attr] of shape.attrs) {
      assert.ok(Object.getOwnPropertyDescriptor(proto, attr)?.get, `${name}.${attr} getter`);
    }
    assert.throws(() => new (ctor as unknown as new () => unknown)(), TypeError);
  });
}

test('WebGL 1 prototype has no WebGL 2 operations', () => {
  const p1 = (g.WebGLRenderingContext as { prototype: object }).prototype;
  assert.equal('texStorage2D' in p1, false);
  assert.equal('bindVertexArray' in p1, false);
  assert.equal('uniform1ui' in p1, false);
});

test('contexts are instances of their interface (GL-1)', () => {
  const c2 = inst.createContext({ width: 8, height: 8 }, 'webgl2')!;
  const c1 = inst.createContext({ width: 8, height: 8 }, 'webgl')!;
  assert.ok(c2 instanceof (g.WebGL2RenderingContext as Function));
  assert.ok(!(c2 instanceof (g.WebGLRenderingContext as Function)));
  assert.ok(c1 instanceof (g.WebGLRenderingContext as Function));
  assert.equal(Object.prototype.toString.call(c2), '[object WebGL2RenderingContext]');
  const gl = c2 as unknown as Record<string, Function> & Record<string, number>;
  assert.equal((gl.getParameter as Function).call(gl, gl.VERSION).startsWith('WebGL 2.0'), true);
  assert.equal((gl.getParameter as Function).call(gl, gl.SHADING_LANGUAGE_VERSION).startsWith('WebGL GLSL ES 3.00'), true);
  const g1 = c1 as unknown as Record<string, Function> & Record<string, number>;
  assert.equal((g1.getParameter as Function).call(g1, g1.VERSION).startsWith('WebGL 1.0'), true);
});

test('WebGL object interfaces are on the global and not constructible (GL-1)', () => {
  for (const n of ['WebGLBuffer', 'WebGLTexture', 'WebGLProgram', 'WebGLShader', 'WebGLFramebuffer', 'WebGLRenderbuffer', 'WebGLUniformLocation', 'WebGLVertexArrayObject', 'WebGLQuery', 'WebGLSampler', 'WebGLSync', 'WebGLTransformFeedback', 'WebGLActiveInfo', 'WebGLShaderPrecisionFormat', 'WebGLContextEvent']) {
    assert.equal(typeof g[n], 'function', n);
    if (n !== 'WebGLContextEvent') assert.throws(() => new (g[n] as new () => unknown)(), TypeError, n);
  }
  const ev = new (g.WebGLContextEvent as new (t: string, i: object) => { type: string; statusMessage: string })('webglcontextlost', { statusMessage: 'x' });
  assert.equal(ev.type, 'webglcontextlost');
  assert.equal(ev.statusMessage, 'x');
});

test('getContextAttributes reports the provided attributes; makeXRCompatible resolves (GL-2)', async () => {
  const gl = inst.createContext({ width: 4, height: 2 }, 'webgl2', { antialias: false, stencil: true, powerPreference: 'high-performance' }) as unknown as Record<string, Function> & Record<string, number>;
  const a = gl.getContextAttributes.call(gl) as Record<string, unknown>;
  assert.equal(a.antialias, false);
  assert.equal(a.stencil, true);
  assert.equal(a.alpha, true);
  assert.equal(a.powerPreference, 'high-performance');
  assert.equal(a.xrCompatible, false);
  await gl.makeXRCompatible.call(gl);
  assert.equal((gl.getContextAttributes.call(gl) as Record<string, unknown>).xrCompatible, true);
  assert.equal(gl.drawingBufferWidth, 4);
  assert.equal(gl.drawingBufferHeight, 2);
  assert.equal((gl as unknown as { drawingBufferColorSpace: string }).drawingBufferColorSpace, 'srgb');
  (gl as unknown as { drawingBufferColorSpace: string }).drawingBufferColorSpace = 'display-p3';
  assert.equal((gl as unknown as { drawingBufferColorSpace: string }).drawingBufferColorSpace, 'display-p3');
});

test('object getters return the app-created objects (GL-5)', () => {
  const gl = inst.createContext({ width: 4, height: 4 }, 'webgl2') as unknown as Record<string, Function> & Record<string, number>;
  const t = gl.createTexture.call(gl);
  assert.notEqual(t, gl.createTexture.call(gl));
  gl.bindTexture.call(gl, gl.TEXTURE_2D, t);
  assert.equal(gl.getParameter.call(gl, gl.TEXTURE_BINDING_2D), t);
  const b = gl.createBuffer.call(gl);
  gl.bindBuffer.call(gl, gl.ARRAY_BUFFER, b);
  assert.equal(gl.getParameter.call(gl, gl.ARRAY_BUFFER_BINDING), b);
  const fb = gl.createFramebuffer.call(gl);
  gl.bindFramebuffer.call(gl, gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D.call(gl, gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  assert.equal(gl.getFramebufferAttachmentParameter.call(gl, gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME), t);
  assert.equal(gl.getParameter.call(gl, gl.FRAMEBUFFER_BINDING), fb);
  gl.deleteTexture.call(gl, t);
  assert.equal(gl.isTexture.call(gl, t), false);
  assert.equal(gl.getParameter.call(gl, gl.TEXTURE_BINDING_2D), null);
  // detached from the bound framebuffer on delete
  assert.equal(gl.getFramebufferAttachmentParameter.call(gl, gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE), gl.NONE);
  // foreign objects: INVALID_OPERATION, no GL call
  const other = inst.createContext({ width: 4, height: 4 }, 'webgl2') as unknown as Record<string, Function> & Record<string, number>;
  const ob = other.createBuffer.call(other);
  fake.reset();
  gl.bindBuffer.call(gl, gl.ARRAY_BUFFER, ob);
  assert.equal(gl.getError.call(gl), gl.INVALID_OPERATION);
  assert.equal(fake.calls.get('bindBuffer') ?? 0, 0);
  // wrong type: TypeError
  assert.throws(() => gl.bindTexture.call(gl, gl.TEXTURE_2D, b), TypeError);
});
