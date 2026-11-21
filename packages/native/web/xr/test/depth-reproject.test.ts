/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// XR-DEPTH-2 matchDepthView: the reprojection passes (src/depth-reproject.ts) against a recording WebGL 2 stand-in that
// keeps the state they touch: what they draw, and that the page's state is exactly as it was afterwards.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DepthReprojection } from '../src/depth-reproject.ts';

const DEPTH_TEST = 0x0b71;
const STENCIL_TEST = 0x0b90;
const CULL_FACE = 0x0b44;
const SCISSOR_TEST = 0x0c11;
const RASTERIZER_DISCARD = 0x8c89;
const POLYGON_OFFSET_FILL = 0x8037;

function fakeGL2(opts: { failCompile?: boolean } = {}) {
  const calls: unknown[][] = [];
  let next = 1;
  const s = {
    draw: 'page-draw' as unknown,
    read: 'page-read' as unknown,
    program: 'page-program' as unknown,
    vao: 'page-vao' as unknown,
    active: 0x84c0 + 3,
    units: new Map<number, unknown>([[0, 'page-texture']]),
    samplers: new Map<number, unknown>([[0, 'page-sampler']]),
    viewport: [1, 2, 3, 4],
    caps: new Set<number>([STENCIL_TEST, CULL_FACE, SCISSOR_TEST]),
    depthFunc: 0x0203, // LEQUAL
    depthMask: false,
    depthRange: Array.from(new Float32Array([0.2, 0.8])), // GL keeps them as floats
  };
  const unit = () => s.active - 0x84c0;
  const gl: Record<string, unknown> = {
    texStorage3D: (...a: unknown[]) => calls.push(['texStorage3D', ...a]),
    getParameter: (p: number) => {
      switch (p) {
        case 0x8ca6:
          return s.draw;
        case 0x8caa:
          return s.read;
        case 0x8b8d:
          return s.program;
        case 0x85b5:
          return s.vao;
        case 0x84e0:
          return s.active;
        case 0x8c1d:
          return s.units.get(unit()) ?? null;
        case 0x8919:
          return s.samplers.get(unit()) ?? null;
        case 0x0ba2:
          return new Int32Array(s.viewport);
        case 0x0b74:
          return s.depthFunc;
        case 0x0b72:
          return s.depthMask;
        case 0x0b70:
          return new Float32Array(s.depthRange);
        default:
          return null;
      }
    },
    isEnabled: (cap: number) => s.caps.has(cap),
    enable: (cap: number) => s.caps.add(cap),
    disable: (cap: number) => s.caps.delete(cap),
    activeTexture: (u: number) => (s.active = u),
    bindTexture: (_t: number, tex: unknown) => s.units.set(unit(), tex),
    bindSampler: (u: number, smp: unknown) => s.samplers.set(u, smp),
    bindFramebuffer: (target: number, fb: unknown) => {
      if (target === 0x8d40 || target === 0x8ca9) s.draw = fb;
      if (target === 0x8d40 || target === 0x8ca8) s.read = fb;
    },
    bindVertexArray: (v: unknown) => (s.vao = v),
    useProgram: (p: unknown) => (s.program = p),
    viewport: (...v: number[]) => (s.viewport = v),
    depthFunc: (f: number) => (s.depthFunc = f),
    depthMask: (m: boolean) => (s.depthMask = m),
    depthRange: (n: number, f: number) => (s.depthRange = [n, f]),
    framebufferTextureLayer: (...a: unknown[]) =>
      calls.push(['layer', a[2], a[4], s.draw]),
    uniform1i: () => {},
    uniform1f: (_l: unknown, x: number) => calls.push(['uniform1f', x]),
    uniformMatrix4fv: (
      _l: unknown,
      _t: boolean,
      data: Float32Array,
      offset: number,
      length: number,
    ) => calls.push(['matrix', data[offset], offset, length]),
    drawArrays: (...a: unknown[]) =>
      calls.push([
        'draw',
        ...a,
        s.depthFunc,
        s.depthMask,
        s.caps.has(DEPTH_TEST),
        s.caps.has(SCISSOR_TEST),
        [...s.viewport],
      ]),
    drawBuffers: () => {},
    readBuffer: () => {},
    createProgram: () => ({ program: next++ }),
    createShader: () => ({ shader: next++ }),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => !opts.failCompile,
    getShaderInfoLog: () => 'broken',
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    deleteShader: () => {},
    deleteProgram: () => {},
    createFramebuffer: () => ({ framebuffer: next++ }),
    createVertexArray: () => ({ vao: next++ }),
    createTexture: () => ({ texture: next++ }),
    deleteTexture: () => {},
    texParameteri: () => {},
  };
  return { gl, calls, s };
}

test('XR-DEPTH-2 matchDepthView: one pass per eye into its own depth array layer, the page state put back exactly', () => {
  const { gl, calls, s } = fakeGL2();
  const before = JSON.stringify({
    ...s,
    units: [...s.units],
    samplers: [...s.samplers],
    caps: [...s.caps].sort(),
  });
  const logs: string[] = [];
  const pass = new DepthReprojection((m) => logs.push(m));
  const matrices = new Float32Array(32);
  matrices[0] = 11;
  matrices[16] = 22;
  const target = pass.draw(
    gl as never,
    { source: true },
    320,
    288,
    2,
    matrices,
  );
  assert.ok(target);
  assert.deepEqual(
    calls.find((c) => c[0] === 'texStorage3D'),
    ['texStorage3D', 0x8c1a, 1, 0x81a5, 320, 288, 2],
  );
  // both eyes, each its matrix and layer, into the pass's own framebuffer with the depth test on and always passing
  assert.deepEqual(
    calls.filter((c) => c[0] === 'matrix'),
    [
      ['matrix', 11, 0, 16],
      ['matrix', 22, 16, 16],
    ],
  );
  assert.deepEqual(
    calls.filter((c) => c[0] === 'uniform1f').map((c) => c[1]),
    [0, 1],
  );
  const layers = calls.filter((c) => c[0] === 'layer');
  assert.deepEqual(
    layers.map((c) => [c[1], c[2]]),
    [
      [target, 0],
      [target, 1],
    ],
  );
  assert.notEqual(layers[0][3], 'page-draw');
  const draws = calls.filter((c) => c[0] === 'draw');
  assert.equal(draws.length, 2);
  for (const d of draws)
    assert.deepEqual(d.slice(1), [
      0x0004,
      0,
      3,
      0x0207,
      true,
      true,
      false,
      [0, 0, 320, 288],
    ]);
  const after = JSON.stringify({
    ...s,
    units: [...s.units],
    samplers: [...s.samplers],
    caps: [...s.caps].sort(),
  });
  assert.equal(
    after,
    before,
    'framebuffers, program, VAO, texture unit and sampler, viewport, caps and depth state',
  );
  assert.deepEqual(logs, []);
  // the next frame reuses the texture; a new size makes another
  assert.equal(
    pass.draw(gl as never, { source: true }, 320, 288, 2, matrices),
    target,
  );
  assert.notEqual(
    pass.draw(gl as never, { source: true }, 256, 256, 2, matrices),
    target,
  );
  // RASTERIZER_DISCARD and polygon offset, when the page had them on, are off during the passes and back after
  s.caps.add(RASTERIZER_DISCARD);
  s.caps.add(POLYGON_OFFSET_FILL);
  pass.draw(gl as never, { source: true }, 256, 256, 1, matrices);
  assert.ok(s.caps.has(RASTERIZER_DISCARD) && s.caps.has(POLYGON_OFFSET_FILL));
});

test('XR-DEPTH-2 matchDepthView: WebGL 1 or a program that does not build gives null (the raw depth views are used)', () => {
  const pass = new DepthReprojection(() => {});
  const { gl } = fakeGL2();
  delete gl.texStorage3D;
  assert.equal(
    pass.draw(gl as never, {}, 320, 320, 2, new Float32Array(32)),
    null,
  );
  const logs: string[] = [];
  const broken = new DepthReprojection((m) => logs.push(m));
  const failing = fakeGL2({ failCompile: true });
  assert.equal(
    broken.draw(failing.gl as never, {}, 320, 320, 2, new Float32Array(32)),
    null,
  );
  assert.equal(
    broken.draw(failing.gl as never, {}, 320, 320, 2, new Float32Array(32)),
    null,
  );
  assert.equal(logs.length, 1, 'built (and logged) once per context');
});
