/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// gl-bench (spec GL-PERF-1 check): median JS -> driver cost per call for the entry points the showcase's frame
// profile is made of. Runs in Node over the host addon (Mesa) and on device inside the runtime (device/main.ts).
// "changing" variants defeat the state cache (full path: JS validation + fast-API transition + driver);
// "cached" variants measure what a redundant call costs (JS only); "native" calls the generated native directly.

import type { WebGLInstall } from '../install.ts';
import type { Ctx } from '../core.ts';

export interface BenchResult {
  name: string;
  nsPerCall: number;
  calls: number;
}

type GL = Record<string, (...a: any[]) => any> & Record<string, number>;

const now = (): number => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

function compile(gl: GL, vs: string, fs: string): unknown {
  const v = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(v, vs);
  gl.compileShader(v);
  const f = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(f, fs);
  gl.compileShader(f);
  const p = gl.createProgram();
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`gl-bench link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

export function runGlBench(inst: WebGLInstall, opts: { iterations?: number; repeats?: number } = {}): BenchResult[] {
  const N = opts.iterations ?? 20000;
  const R = opts.repeats ?? 5;
  const gl = inst.createContext({ width: 64, height: 64 }, 'webgl2', { antialias: false }) as unknown as GL;
  const n = (gl as unknown as Ctx)._n;
  const vs = `#version 300 es
#extension GL_ANGLE_multi_draw : require
in vec2 p;
uniform mat4 m;
uniform vec4 v;
uniform float u;
void main() { gl_Position = m * vec4(p * u, float(gl_DrawID) * 1e-6, 1.0) + v * 1e-6; }`;
  const fs = '#version 300 es\nprecision mediump float;\nout vec4 o;\nuniform sampler2D s;\nvoid main(){ o = texture(s, vec2(0.5)); }';
  const p1 = compile(gl, vs, fs);
  const p2 = compile(gl, vs, fs);
  gl.useProgram(p1);
  const locs = (p: unknown) => ({ m: gl.getUniformLocation(p, 'm'), v: gl.getUniformLocation(p, 'v'), u: gl.getUniformLocation(p, 'u') });
  const l1 = locs(p1);
  if (!l1.m || !l1.v || !l1.u) throw new Error('gl-bench: uniform locations missing');
  const nl = { m: (l1.m as unknown as { _loc: number })._loc, v: (l1.v as unknown as { _loc: number })._loc, u: (l1.u as unknown as { _loc: number })._loc };
  const tex = [gl.createTexture(), gl.createTexture()];
  for (const t of tex) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 4, 4);
  }
  const texNames = tex.map((t) => (t as unknown as { _name: number })._name);
  const vbo = gl.createBuffer();
  const ibo = gl.createBuffer();
  const vaos = [gl.createVertexArray(), gl.createVertexArray()];
  for (const vao of vaos) {
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0.01, 0, 0, 0.01]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2]), gl.STATIC_DRAW);
  }
  const sub = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, sub);
  gl.bufferData(gl.ARRAY_BUFFER, 8192, gl.DYNAMIC_DRAW);
  const d64 = new Uint8Array(64);
  const d4k = new Uint8Array(4096);
  const mat = new Float32Array(16);
  const vec = new Float32Array(4);
  gl.uniformMatrix4fv(l1.m, false, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  gl.uniform1f(l1.u, 1);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, 1, 1);
  gl.viewport(0, 0, 64, 64);
  const md = gl.getExtension('WEBGL_multi_draw') as Record<string, (...a: any[]) => void>;
  const firsts = new Int32Array(256);
  const counts = new Int32Array(256).fill(3);
  const offsets = new Int32Array(256);

  let sink = 0;
  const cases: Array<[string, number, (i: number) => void]> = [
    ['baseline: empty closure call (harness overhead)', 1, (i) => {
      sink += i;
    }],
    ['native activeTexture (fast-API transition)', 1, (i) => n.activeTexture(0x84c0 + (i & 1))],
    ['uniform1f changing', 1, (i) => gl.uniform1f(l1.u, i)],
    ['uniform1f cached (redundant)', 1, () => gl.uniform1f(l1.u, 1)],
    ['uniform4fv changing', 1, (i) => {
      vec[0] = i;
      gl.uniform4fv(l1.v, vec);
    }],
    ['uniform4fv cached (redundant)', 1, () => gl.uniform4fv(l1.v, vec)],
    ['native uniform1f (no JS layer)', 1, (i) => n.uniform1f(nl.u, i)],
    ['native uniform4fv (no JS layer)', 1, (i) => {
      vec[0] = i;
      n.uniform4fv(nl.v, 1, vec, 0, 16);
    }],
    ['native uniformMatrix4fv (no JS layer)', 1, (i) => {
      mat[0] = i;
      n.uniformMatrix4fv(nl.m, 1, false, mat, 0, 64);
    }],
    ['native bindTexture alternating (no JS layer)', 1, (i) => n.bindTexture(0x0de1, texNames[i & 1])],
    ['uniformMatrix4fv changing', 1, (i) => {
      mat[0] = i;
      gl.uniformMatrix4fv(l1.m, false, mat);
    }],
    ['bindTexture alternating', 1, (i) => gl.bindTexture(gl.TEXTURE_2D, tex[i & 1])],
    ['bindTexture cached (redundant)', 1, () => gl.bindTexture(gl.TEXTURE_2D, tex[0])],
    ['bindVertexArray alternating', 1, (i) => gl.bindVertexArray(vaos[i & 1])],
    ['useProgram alternating', 1, (i) => gl.useProgram(i & 1 ? p2 : p1)],
    ['enable/disable cached (redundant)', 1, () => gl.enable(gl.SCISSOR_TEST)],
    ['viewport changing', 1, (i) => gl.viewport(0, 0, 64 - (i & 1), 64)],
    ['bufferSubData 64 B', 1, () => gl.bufferSubData(gl.ARRAY_BUFFER, 0, d64)],
    ['bufferSubData 4 KB', 1, () => gl.bufferSubData(gl.ARRAY_BUFFER, 0, d4k)],
    ['drawElements (1 triangle, scissored)', 1, () => gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0)],
    ['multiDrawElements x16 (per sub-draw)', 16, () => md.multiDrawElementsWEBGL(gl.TRIANGLES, counts, 0, gl.UNSIGNED_SHORT, offsets, 0, 16)],
    ['multiDrawElements x64 (per sub-draw)', 64, () => md.multiDrawElementsWEBGL(gl.TRIANGLES, counts, 0, gl.UNSIGNED_SHORT, offsets, 0, 64)],
    ['multiDrawElements x256 (per sub-draw)', 256, () => md.multiDrawElementsWEBGL(gl.TRIANGLES, counts, 0, gl.UNSIGNED_SHORT, offsets, 0, 256)],
    ['multiDrawArrays x64 (per sub-draw)', 64, () => md.multiDrawArraysWEBGL(gl.TRIANGLES, firsts, 0, counts, 0, 64)],
  ];
  const results: BenchResult[] = [];
  gl.bindVertexArray(vaos[0]);
  gl.bindBuffer(gl.ARRAY_BUFFER, sub);
  for (const [name, per, fn] of cases) {
    gl.useProgram(p1);
    gl.bindVertexArray(vaos[0]);
    const iters = name.startsWith('multiDraw') || name.startsWith('drawElements') ? Math.max(200, (N / per) | 0) : N;
    for (let i = 0; i < iters; i++) fn(i); // warm-up (optimizes the call site)
    gl.finish();
    const samples: number[] = [];
    for (let r = 0; r < R; r++) {
      const t0 = now();
      for (let i = 0; i < iters; i++) fn(i);
      const t1 = now();
      samples.push(((t1 - t0) * 1e6) / (iters * per));
      gl.finish();
    }
    samples.sort((a, b) => a - b);
    results.push({ name, nsPerCall: samples[samples.length >> 1], calls: iters * per });
  }
  if (sink === -1) results.push({ name: 'sink', nsPerCall: 0, calls: 0 });
  const err = gl.getError();
  if (err) throw new Error(`gl-bench: GL error 0x${err.toString(16)}`);
  return results;
}

export function formatBench(results: BenchResult[], label: string): string {
  return results.map((r) => `GLBENCH ${label} ${r.nsPerCall.toFixed(1).padStart(8)} ns  ${r.name}`).join('\n');
}
