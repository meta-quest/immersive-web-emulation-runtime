/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// GL-PERF-2 / GL-PERF-3 with the call recorder: calls that would not change GL state never reach the
// natives; invalidation (delete of a bound object, relink, VAO switch) keeps the cache truthful; steady-state
// calls allocate nothing per call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWebGL } from '../install.ts';
import { createFakeNatives } from './fake-natives.ts';

const g = {} as Record<string, unknown>;
const fake = createFakeNatives();
const inst = installWebGL(g, fake.natives);
type GL = Record<string, Function> & Record<string, number>;
function ctx(): GL {
  return inst.createContext(
    { width: 16, height: 16 },
    'webgl2',
  ) as unknown as GL;
}
function call(gl: GL, name: string, ...args: unknown[]): unknown {
  return gl[name].apply(gl, args);
}

test('redundant state sets do not reach the driver', () => {
  const gl = ctx();
  const seq: Array<[string, ...unknown[]]> = [
    ['enable', gl.BLEND],
    ['blendFunc', gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA],
    ['depthMask', false],
    ['viewport', 0, 0, 8, 8],
    ['scissor', 1, 1, 4, 4],
    ['clearColor', 0.25, 0.5, 0.75, 1],
    ['cullFace', gl.FRONT],
    ['depthFunc', gl.LEQUAL],
    ['colorMask', true, false, true, true],
    ['activeTexture', gl.TEXTURE3],
    ['stencilFunc', gl.EQUAL, 1, 0xff],
    ['stencilOp', gl.KEEP, gl.KEEP, gl.REPLACE],
    ['stencilMask', 0x0f],
    ['frontFace', gl.CW],
    ['polygonOffset', 1, 2],
    ['blendEquation', gl.FUNC_ADD],
    ['blendColor', 0, 0, 0, 1],
    ['clearDepth', 0.5],
    ['clearStencil', 3],
    ['lineWidth', 1],
    ['pixelStorei', gl.UNPACK_ALIGNMENT, 1],
    ['sampleCoverage', 1, false],
    ['depthRange', 0, 1],
    ['hint', gl.GENERATE_MIPMAP_HINT, gl.NICEST],
  ];
  for (const [name, ...a] of seq) call(gl, name, ...a);
  fake.reset();
  for (let i = 0; i < 3; i++)
    for (const [name, ...a] of seq) call(gl, name, ...a);
  assert.equal(
    fake.total(),
    0,
    `redundant calls reached natives: ${[...fake.calls.keys()].join(', ')}`,
  );
  // a changed value goes through
  call(gl, 'viewport', 0, 0, 9, 9);
  assert.equal(fake.calls.get('viewport'), 1);
  // the cache answers getParameter
  assert.deepEqual(
    [...(call(gl, 'getParameter', gl.VIEWPORT) as Int32Array)],
    [0, 0, 9, 9],
  );
  assert.deepEqual(call(gl, 'getParameter', gl.COLOR_WRITEMASK), [
    true,
    false,
    true,
    true,
  ]);
  assert.equal(call(gl, 'getParameter', gl.ACTIVE_TEXTURE), gl.TEXTURE3);
  assert.equal(call(gl, 'getParameter', gl.STENCIL_WRITEMASK), 0x0f);
  assert.equal(call(gl, 'isEnabled', gl.BLEND), true);
});

test('redundant binds and program switches are dropped; deletes invalidate', () => {
  const gl = ctx();
  const t = call(gl, 'createTexture');
  const b = call(gl, 'createBuffer');
  const vao = call(gl, 'createVertexArray');
  const fb = call(gl, 'createFramebuffer');
  call(gl, 'bindTexture', gl.TEXTURE_2D, t);
  call(gl, 'bindBuffer', gl.ARRAY_BUFFER, b);
  call(gl, 'bindVertexArray', vao);
  call(gl, 'bindFramebuffer', gl.FRAMEBUFFER, fb);
  fake.reset();
  call(gl, 'bindTexture', gl.TEXTURE_2D, t);
  call(gl, 'bindBuffer', gl.ARRAY_BUFFER, b);
  call(gl, 'bindVertexArray', vao);
  call(gl, 'bindFramebuffer', gl.FRAMEBUFFER, fb);
  assert.equal(fake.total(), 0);
  // delete of a bound texture unbinds it: binding it again (a new one) must reach the driver
  call(gl, 'deleteTexture', t);
  const t2 = call(gl, 'createTexture');
  fake.reset();
  call(gl, 'bindTexture', gl.TEXTURE_2D, null);
  assert.equal(
    fake.calls.get('bindTexture') ?? 0,
    0,
    'null is already bound after delete',
  );
  call(gl, 'bindTexture', gl.TEXTURE_2D, t2);
  assert.equal(fake.calls.get('bindTexture'), 1);
  // the element-array binding belongs to the VAO
  const eb = call(gl, 'createBuffer');
  call(gl, 'bindBuffer', gl.ELEMENT_ARRAY_BUFFER, eb);
  call(gl, 'bindVertexArray', null);
  assert.equal(call(gl, 'getParameter', gl.ELEMENT_ARRAY_BUFFER_BINDING), null);
  fake.reset();
  call(gl, 'bindVertexArray', vao);
  assert.equal(call(gl, 'getParameter', gl.ELEMENT_ARRAY_BUFFER_BINDING), eb);
  call(gl, 'bindBuffer', gl.ELEMENT_ARRAY_BUFFER, eb);
  assert.equal(fake.calls.get('bindBuffer') ?? 0, 0);
});

function program(gl: GL, fs: string): unknown {
  const vs = call(gl, 'createShader', gl.VERTEX_SHADER);
  call(
    gl,
    'shaderSource',
    vs,
    '#version 300 es\nin vec4 position;\nuniform mat4 mvp;\nvoid main(){ gl_Position = mvp * position; }',
  );
  call(gl, 'compileShader', vs);
  const f = call(gl, 'createShader', gl.FRAGMENT_SHADER);
  call(gl, 'shaderSource', f, fs);
  call(gl, 'compileShader', f);
  const p = call(gl, 'createProgram');
  call(gl, 'attachShader', p, vs);
  call(gl, 'attachShader', p, f);
  call(gl, 'linkProgram', p);
  return p;
}

test('uniform uploads equal to the current value are dropped; relink resets', () => {
  const gl = ctx();
  const p = program(
    gl,
    '#version 300 es\nprecision highp float;\nuniform vec4 color;\nuniform float k[4];\nuniform sampler2D map;\nout vec4 o;\nvoid main(){ o = color * k[1]; }',
  );
  call(gl, 'useProgram', p);
  const color = call(gl, 'getUniformLocation', p, 'color');
  const mvp = call(gl, 'getUniformLocation', p, 'mvp');
  const k1 = call(gl, 'getUniformLocation', p, 'k[1]');
  const map = call(gl, 'getUniformLocation', p, 'map');
  const m = new Float32Array(16).fill(2);
  call(gl, 'uniform4f', color, 1, 2, 3, 4);
  call(gl, 'uniformMatrix4fv', mvp, false, m);
  call(gl, 'uniform1fv', k1, [0.5, 0.25]);
  call(gl, 'uniform1i', map, 2);
  fake.reset();
  for (let i = 0; i < 5; i++) {
    call(gl, 'uniform4f', color, 1, 2, 3, 4);
    call(gl, 'uniformMatrix4fv', mvp, false, m);
    call(gl, 'uniform1fv', k1, [0.5, 0.25]);
    call(gl, 'uniform1i', map, 2);
    call(gl, 'useProgram', p);
  }
  assert.equal(fake.total(), 0, [...fake.calls.keys()].join(','));
  m[5] = 3;
  call(gl, 'uniformMatrix4fv', mvp, false, m);
  call(gl, 'uniform4fv', color, new Float32Array([1, 2, 3, 5]));
  assert.equal(fake.calls.get('uniformMatrix4fv'), 1);
  assert.equal(fake.calls.get('uniform4fv'), 1);
  // relink: old locations are invalid (GL-8), new ones upload again
  call(gl, 'linkProgram', p);
  call(gl, 'uniform4f', color, 1, 2, 3, 4);
  assert.equal(call(gl, 'getError'), gl.INVALID_OPERATION);
  const color2 = call(gl, 'getUniformLocation', p, 'color');
  fake.reset();
  call(gl, 'uniform4f', color2, 1, 2, 3, 4);
  assert.equal(fake.calls.get('uniform4f'), 1);
  // type mismatch is caught in JS (no driver call, INVALID_OPERATION) and does not poison the cache
  fake.reset();
  call(gl, 'uniform1i', color2, 1);
  assert.equal(call(gl, 'getError'), gl.INVALID_OPERATION);
  // (the only native call is the one glGetError that keeps earlier driver errors first, GL-9)
  assert.equal(fake.total() - (fake.calls.get('getError') ?? 0), 0);
  // null location: silent no-op
  call(gl, 'uniform4f', null, 1, 2, 3, 4);
  assert.equal(call(gl, 'getError'), gl.NO_ERROR);
});

test('GL-21: reflection queries reach native code once per program / shader', () => {
  const gl = ctx();
  const p = program(
    gl,
    '#version 300 es\nprecision highp float;\nuniform vec4 a;\nuniform vec4 b;\nout vec4 o;\nvoid main(){ o = a + b; }',
  );
  fake.reset();
  // what three.js asks after a link
  call(gl, 'getProgramInfoLog', p);
  for (const s of call(gl, 'getAttachedShaders', p) as unknown[]) {
    call(gl, 'getShaderInfoLog', s);
    call(gl, 'getShaderParameter', s, gl.COMPILE_STATUS);
  }
  call(gl, 'getProgramParameter', p, gl.LINK_STATUS);
  const nu = call(gl, 'getProgramParameter', p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < nu; i++) {
    const info = call(gl, 'getActiveUniform', p, i) as { name: string };
    call(gl, 'getUniformLocation', p, info.name);
  }
  const na = call(gl, 'getProgramParameter', p, gl.ACTIVE_ATTRIBUTES) as number;
  for (let i = 0; i < na; i++) {
    const info = call(gl, 'getActiveAttrib', p, i) as { name: string };
    call(gl, 'getAttribLocation', p, info.name);
  }
  assert.equal(fake.calls.get('programInfo'), 1);
  assert.equal(fake.calls.get('shaderInfo'), 2);
  assert.equal(fake.total(), 3, [...fake.calls.entries()].join(' '));
});

test(
  'GL-PERF-3: steady-state calls do not allocate per call',
  {
    skip:
      typeof process === 'undefined' || !process.memoryUsage
        ? 'needs process.memoryUsage (Node)'
        : false,
  },
  () => {
    const gl = ctx();
    const p = program(
      gl,
      '#version 300 es\nprecision highp float;\nuniform vec4 color;\nout vec4 o;\nvoid main(){ o = color; }',
    );
    call(gl, 'useProgram', p);
    const color = call(gl, 'getUniformLocation', p, 'color');
    const mvp = call(gl, 'getUniformLocation', p, 'mvp');
    const m = new Float32Array(16);
    const t = call(gl, 'createTexture');
    const b = call(gl, 'createBuffer');
    const vao = call(gl, 'createVertexArray');
    call(gl, 'bindVertexArray', vao);
    call(gl, 'bindBuffer', gl.ARRAY_BUFFER, b);
    call(gl, 'bufferData', gl.ARRAY_BUFFER, 1024, gl.DYNAMIC_DRAW);
    call(gl, 'enableVertexAttribArray', 0);
    call(gl, 'vertexAttribPointer', 0, 4, gl.FLOAT, false, 0, 0);
    const data = new Float32Array(64);
    const G = gl as unknown as Record<string, (...a: unknown[]) => unknown>;
    const frame = (i: number): void => {
      m[0] = i;
      G.uniformMatrix4fv(mvp, false, m);
      G.uniform4f(color, i, 0, 0, 1);
      G.activeTexture(gl.TEXTURE0 + (i & 1));
      G.bindTexture(gl.TEXTURE_2D, t);
      G.enable(gl.DEPTH_TEST);
      G.viewport(0, 0, 16, 16);
      G.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      G.drawArrays(gl.TRIANGLES, 0, 3);
    };
    for (let i = 0; i < 20000; i++) frame(i); // warm up / optimize
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 20000; i++) frame(i);
    const grown = process.memoryUsage().heapUsed - before;
    // 160k calls: anything allocating per call would grow the heap by megabytes.
    assert.ok(grown < 512 * 1024, `heap grew ${grown} bytes over 160k calls`);
  },
);
