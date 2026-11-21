/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Regression tests: each case failed before its fix.
// Real driver (host addon over Mesa); skipped when the addon is not built.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realInstall, realNatives, SKIP_REAL } from './real-gl.ts';

const inst = SKIP_REAL ? null : realInstall();
const n = realNatives() as any;
type GL = Record<string, (...a: any[]) => any> & Record<string, number>;
function ctx(w = 4, h = 4, attrs: Record<string, unknown> = {}, kind: 'webgl' | 'webgl2' = 'webgl2'): GL {
  return inst!.createContext({ width: w, height: h }, kind, { antialias: false, ...attrs }) as unknown as GL;
}
const opt = { skip: SKIP_REAL };

function prog(gl: GL, vs: string, fs: string): any {
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
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link failed: ${gl.getProgramInfoLog(p)} ${gl.getShaderInfoLog(v)} ${gl.getShaderInfoLog(f)}`);
  }
  return p;
}
const VS = `#version 300 es
void main() { vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }`;
function px(gl: GL): number[] {
  const a = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);
  return [...a];
}
function errors(gl: GL): number[] {
  const out: number[] = [];
  for (let e = gl.getError(); e; e = gl.getError()) out.push(e);
  return out;
}

test('GL-8 / GL-PERF-2: uniform cache is keyed by program location, not by location object', opt, () => {
  const gl = ctx();
  const p = prog(
    gl,
    VS,
    `#version 300 es
precision highp float; uniform float u; uniform float arr[3]; uniform int sel; out vec4 o;
void main(){ float a = sel == 0 ? u : arr[1]; o = vec4(a, 0.0, 0.0, 1.0); }`,
  );
  gl.useProgram(p);
  const l1 = gl.getUniformLocation(p, 'u');
  const l2 = gl.getUniformLocation(p, 'u');
  gl.uniform1i(gl.getUniformLocation(p, 'sel'), 0);
  gl.uniform1f(l1, 1);
  gl.uniform1f(l2, 0);
  gl.uniform1f(l1, 1);
  assert.equal(gl.getUniform(p, l1), 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.deepEqual(px(gl), [255, 0, 0, 255]);
  // array element location vs. whole-array upload through the base location
  const e1 = gl.getUniformLocation(p, 'arr[1]');
  const base = gl.getUniformLocation(p, 'arr');
  gl.uniform1i(gl.getUniformLocation(p, 'sel'), 1);
  gl.uniform1f(e1, 1);
  gl.uniform1fv(base, new Float32Array([0, 0, 0]));
  gl.uniform1f(e1, 1);
  assert.equal(gl.getUniform(p, e1), 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.deepEqual(px(gl), [255, 0, 0, 255]);
  assert.deepEqual(errors(gl), []);
});

test('GL-23 / GL-13: EXT_polygon_offset_clamp and EXT_clip_control keep the cache coherent and answer getParameter', opt, () => {
  const gl = ctx();
  const pc = gl.getExtension('EXT_polygon_offset_clamp') as any;
  if (pc) {
    assert.equal(gl.getParameter(pc.POLYGON_OFFSET_CLAMP_EXT), 0);
    pc.polygonOffsetClampEXT(2, 3, 0.5);
    assert.equal(gl.getParameter(gl.POLYGON_OFFSET_FACTOR), 2);
    assert.equal(gl.getParameter(gl.POLYGON_OFFSET_UNITS), 3);
    assert.equal(gl.getParameter(pc.POLYGON_OFFSET_CLAMP_EXT), 0.5);
    gl.polygonOffset(0, 0);
    const f = new Float32Array(4);
    n.getFloatv(gl.POLYGON_OFFSET_FACTOR, f, 0, 16);
    assert.equal(f[0], 0, 'polygonOffset(0,0) after the clamp call reached the driver');
  }
  const cc = gl.getExtension('EXT_clip_control') as any;
  if (cc) {
    assert.equal(gl.getParameter(cc.CLIP_ORIGIN_EXT), cc.LOWER_LEFT_EXT);
    assert.equal(gl.getParameter(cc.CLIP_DEPTH_MODE_EXT), cc.NEGATIVE_ONE_TO_ONE_EXT);
    cc.clipControlEXT(cc.UPPER_LEFT_EXT, cc.ZERO_TO_ONE_EXT);
    assert.equal(gl.getParameter(cc.CLIP_ORIGIN_EXT), cc.UPPER_LEFT_EXT);
    assert.equal(gl.getParameter(cc.CLIP_DEPTH_MODE_EXT), cc.ZERO_TO_ONE_EXT);
  }
  assert.deepEqual(errors(gl), []);
});

test('GL-12: generateMipmap invalidates the framebuffer completeness cache', opt, () => {
  const gl = ctx();
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 1);
  assert.equal(gl.checkFramebufferStatus(gl.FRAMEBUFFER), gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT);
  gl.generateMipmap(gl.TEXTURE_2D);
  assert.equal(gl.checkFramebufferStatus(gl.FRAMEBUFFER), gl.FRAMEBUFFER_COMPLETE);
  gl.clear(gl.COLOR_BUFFER_BIT);
  assert.deepEqual(errors(gl), []);
});

test('GL-25: gl_DrawID is 0 for ordinary draws after a multi-draw', opt, () => {
  const gl = ctx();
  const md = gl.getExtension('WEBGL_multi_draw') as any;
  const p = prog(
    gl,
    `#version 300 es
#extension GL_ANGLE_multi_draw : require
flat out int id;
void main(){ id = gl_DrawID; vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }`,
    `#version 300 es
precision highp float; flat in int id; out vec4 o; void main(){ o = vec4(float(id) / 255.0, 0.0, 0.0, 1.0); }`,
  );
  gl.useProgram(p);
  md.multiDrawArraysWEBGL(gl.TRIANGLES, new Int32Array([0, 0, 0]), 0, new Int32Array([3, 3, 3]), 0, 3);
  assert.equal(px(gl)[0], 2);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.equal(px(gl)[0], 0);
});

test('GL-24: a num_views = 1 program draws to ordinary framebuffers', opt, () => {
  const gl = ctx();
  if (!gl.getExtension('OVR_multiview2')) return;
  const p = prog(
    gl,
    `#version 300 es
#extension GL_OVR_multiview2 : require
layout(num_views = 1) in;
void main(){ vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }`,
    `#version 300 es
precision highp float; out vec4 o; void main(){ o = vec4(0.0, 1.0, 0.0, 1.0); }`,
  );
  gl.useProgram(p);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  assert.deepEqual(errors(gl), []);
  assert.deepEqual(px(gl), [0, 255, 0, 255]);
});

test('GL-24: three.js-style `#extension GL_OVR_multiview` compiles once OVR_multiview2 is enabled', opt, () => {
  const gl = ctx();
  const vs = `#version 300 es
#extension GL_OVR_multiview : require
layout(num_views = 2) in;
uniform mat4 m[2];
void main(){ gl_Position = m[gl_ViewID_OVR] * vec4(0.0, 0.0, 0.0, 1.0); }`;
  const fs = `#version 300 es
precision highp float; out vec4 o; void main(){ o = vec4(1.0); }`;
  const compiles = (): boolean => {
    const s = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(s, vs);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) as unknown as boolean;
  };
  assert.equal(compiles(), false, 'not enabled yet: the directive must fail');
  if (!gl.getExtension('OVR_multiview2')) return;
  assert.equal(compiles(), true);
  prog(gl, vs, fs);
  assert.deepEqual(errors(gl), []);
});

test('OES_draw_buffers_indexed keeps the cached colour mask and blend state answerable', opt, () => {
  const gl = ctx();
  const ext = gl.getExtension('OES_draw_buffers_indexed') as any;
  if (!ext) return;
  ext.colorMaskiOES(0, true, false, true, false);
  assert.deepEqual(gl.getParameter(gl.COLOR_WRITEMASK), [true, false, true, false]);
  ext.enableiOES(gl.BLEND, 0);
  assert.equal(gl.getParameter(gl.BLEND), true);
  assert.equal(gl.isEnabled(gl.BLEND), true);
  gl.colorMask(true, true, true, true);
  assert.deepEqual(gl.getParameter(gl.COLOR_WRITEMASK), [true, true, true, true]);
  assert.deepEqual(errors(gl), []);
});

test('GL-9: binding-raised and driver-raised errors come out in the order they happened', opt, () => {
  const gl = ctx();
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 4, 4);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 3, 3, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(64)); // INVALID_VALUE
  gl.bindBuffer(0x1234, null); // INVALID_ENUM
  assert.deepEqual(errors(gl), [gl.INVALID_VALUE, gl.INVALID_ENUM]);
});

test('GL-4: lose/restore destroys the old native context; restored names do not get deleted by stale finalizers', opt, async () => {
  const log: string[] = [];
  const wrapped: any = {};
  for (const k of Object.keys(n)) {
    const f = n[k];
    wrapped[k] = typeof f !== 'function' ? f : (...a: unknown[]) => (log.push(k), f.apply(n, a));
  }
  const { installWebGL } = await import('../install.ts');
  const local = installWebGL({} as Record<string, unknown>, wrapped);
  const canvas = {
    width: 4,
    height: 4,
    dispatchEvent(ev: { type: string; preventDefault?: () => void }) {
      if (ev.type === 'webglcontextlost') ev.preventDefault?.();
      return true;
    },
  };
  const gl = local.createContext(canvas, 'webgl2') as unknown as GL;
  const ext = gl.getExtension('WEBGL_lose_context') as any;
  for (let i = 0; i < 3; i++) {
    gl.createVertexArray();
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 2));
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 2));
    assert.equal(gl.isContextLost(), false);
  }
  const creates = log.filter((k) => k === 'contextCreate').length;
  const destroys = log.filter((k) => k === 'contextDestroy').length;
  assert.equal(creates, 4);
  assert.equal(destroys, 3);
});

test('GL-1: WebGL objects expose no own enumerable fields', opt, () => {
  const gl = ctx();
  const b = gl.createBuffer();
  assert.deepEqual(Object.keys(b), []);
  assert.equal(Object.prototype.toString.call(b), '[object WebGLBuffer]');
});

test('GL-17 / C2D-3: premultiplied canvas pixels upload through one native pass', opt, () => {
  const gl = ctx();
  const IMAGE_SOURCE = Symbol.for('iwn.image.source');
  const data = new Uint8ClampedArray([128, 64, 0, 128, 255, 255, 255, 255]); // premultiplied, 2x1
  const src = { [IMAGE_SOURCE]: () => ({ kind: 'pixels', origin: 'canvas', width: 2, height: 1, premultiplied: true, data }) };
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  const out = new Uint8Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
  assert.deepEqual([...out], [255, 128, 0, 128, 255, 255, 255, 255]);
  assert.deepEqual(errors(gl), []);
});

test('GL-23: WEBGL_draw_buffers answers MAX_COLOR_ATTACHMENTS_WEBGL and DRAW_BUFFERi_WEBGL on WebGL 1', opt, () => {
  const gl = ctx(4, 4, {}, 'webgl');
  const ext = gl.getExtension('WEBGL_draw_buffers') as any;
  if (!ext) return;
  assert.ok((gl.getParameter(ext.MAX_COLOR_ATTACHMENTS_WEBGL) as number) >= 4);
  assert.ok((gl.getParameter(ext.MAX_COLOR_ATTACHMENTS_WEBGL) as number) >= (gl.getParameter(ext.MAX_DRAW_BUFFERS_WEBGL) as number));
  assert.equal(gl.getParameter(ext.DRAW_BUFFER0_WEBGL), gl.BACK);
  assert.equal(gl.getParameter(ext.DRAW_BUFFER1_WEBGL), gl.NONE);
  assert.deepEqual(errors(gl), []);
});

test('GL-4: when the driver refuses another context, the oldest context is lost instead (browser behaviour)', opt, async () => {
  let live = 0;
  const wrapped: any = {};
  for (const k of Object.keys(n)) wrapped[k] = n[k];
  wrapped.contextCreate = (...a: unknown[]) => {
    if (live >= 2) return 0; // a driver cap of 2 live contexts
    const id = n.contextCreate(...a);
    if (id) live++;
    return id;
  };
  wrapped.contextDestroy = (id: number) => {
    live--;
    return n.contextDestroy(id);
  };
  const { installWebGL } = await import('../install.ts');
  const local = installWebGL({} as Record<string, unknown>, wrapped, { log: () => {} });
  const lost: string[] = [];
  const canvas = (name: string) => ({
    width: 4,
    height: 4,
    dispatchEvent(ev: { type: string }) {
      if (ev.type === 'webglcontextlost') lost.push(name);
      return true;
    },
  });
  const a = local.createContext(canvas('a'), 'webgl2') as unknown as GL;
  const b = local.createContext(canvas('b'), 'webgl2') as unknown as GL;
  // On device the earlier suites already hold most of the driver's real contexts (other natives objects).
  if (!a || !b) return;
  const c = local.createContext(canvas('c'), 'webgl2') as unknown as GL;
  assert.ok(a && b && c, 'the third context is created');
  assert.equal(a.isContextLost(), true);
  assert.equal(b.isContextLost(), false);
  assert.equal(c.isContextLost(), false);
  await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(lost, ['a']);
  c.clearColor(0, 1, 0, 1);
  c.clear(c.COLOR_BUFFER_BIT);
  assert.deepEqual(px(c), [0, 255, 0, 255]);
});
